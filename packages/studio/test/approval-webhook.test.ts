// Approval webhook: ONE POST per pending tool approval (the __alert__ first-write-wins marker).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryJournal } from '@gnl/durable';
import { createStudioApi } from '../src/server.js';

afterEach(() => vi.unstubAllGlobals());

/** Seeds a suspended run (same pattern as governance.test). */
async function seedSuspended(journal: InMemoryJournal, runId = 'sus-1') {
  await journal.put(`${runId}:model:0`, {
    content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'chargeCard', input: '{"amount":99}' }],
    finishReason: 'tool-calls',
  });
  await journal.put(`${runId}:tool:call-1`, {
    status: 'suspended',
    output: { __gnl_suspend: { toolCallId: 'call-1', toolName: 'chargeCard', args: { amount: 99 }, reason: 'high amount' } },
  });
}

describe('approval webhook notification', () => {
  it('the webhook is POSTed the first time a pending approval is seen; NOT repeated on later listings', async () => {
    const journal = new InMemoryJournal();
    await seedSuspended(journal);
    const hook = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', hook);
    const app = createStudioApi({ reader: journal, alerts: { webhook: 'http://hook.test/gnl' } });

    const r1 = await (await app.request('/approvals')).json();
    expect(r1.items).toHaveLength(1);
    expect(hook).toHaveBeenCalledTimes(1);
    const [url, init] = hook.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('http://hook.test/gnl');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      type: 'approval-pending', runId: 'sus-1', toolCallId: 'call-1', toolName: 'chargeCard',
      args: { amount: 99 }, reason: 'high amount',
    });

    // Second listing: the marker is in the journal → the webhook is NOT fired again (one-time only).
    await app.request('/approvals');
    expect(hook).toHaveBeenCalledTimes(1);
    expect(await journal.get('__alert__:approval:sus-1:call-1')).toBeDefined();
  });

  it('a webhook error does not break the inbox flow (best-effort)', async () => {
    const journal = new InMemoryJournal();
    await seedSuspended(journal, 'sus-2');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    const app = createStudioApi({ reader: journal, alerts: { webhook: 'http://hook.test/gnl' } });
    const res = await app.request('/approvals');
    expect(res.status).toBe(200);
    expect((await res.json()).items).toHaveLength(1);
  });

  it('no POST is fired at all if the webhook is not defined', async () => {
    const journal = new InMemoryJournal();
    await seedSuspended(journal, 'sus-3');
    const hook = vi.fn();
    vi.stubGlobal('fetch', hook);
    const app = createStudioApi({ reader: journal });
    await app.request('/approvals');
    expect(hook).not.toHaveBeenCalled();
  });
});
