// Approval webhook: ONE POST per pending tool approval (the __alert__ first-write-wins marker).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createStudioApi } from '../src/server.js';
import { call } from './call.js';

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

    const r1 = await (await call(app, '/approvals')).json();
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
    await call(app, '/approvals');
    expect(hook).toHaveBeenCalledTimes(1);
    expect(await journal.get('__alert__:approval:sus-1:call-1')).toBeDefined();
  });

  it('a webhook error does not break the inbox flow (best-effort)', async () => {
    const journal = new InMemoryJournal();
    await seedSuspended(journal, 'sus-2');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    const app = createStudioApi({ reader: journal, alerts: { webhook: 'http://hook.test/gnl' } });
    const res = await call(app, '/approvals');
    expect(res.status).toBe(200);
    expect((await res.json()).items).toHaveLength(1);
  });

  it('no POST is fired at all if the webhook is not defined', async () => {
    const journal = new InMemoryJournal();
    await seedSuspended(journal, 'sus-3');
    const hook = vi.fn();
    vi.stubGlobal('fetch', hook);
    const app = createStudioApi({ reader: journal });
    await call(app, '/approvals');
    expect(hook).not.toHaveBeenCalled();
  });

  // A receiver that never answers, which the test above cannot express.
  //
  // 'a webhook error does not break the inbox flow' stubs a fetch that THROWS, and a throw is the easy
  // case — it settles. The case that actually happens to a webhook host is the socket that accepts the
  // connection and then goes quiet: a wedged process, a load balancer with no backend, a receiver
  // mid-restart. `fetch` has no default timeout, so that POST never settles, and because it is awaited
  // inside the handler the whole endpoint never settles either.
  //
  // Measured before the bound: with the socket below, `GET /approvals` was still open after 20 seconds
  // with no reason to ever close. The panel polls that endpoint every 5s, so an operator whose webhook
  // host is down loses the approval inbox — the alert path taking down the thing it exists to serve.
  //
  // This uses a REAL socket rather than a stub on purpose. Nothing about a hang is expressible as a
  // mocked fetch: a stub that never resolves would hang the test run itself, which is the same failure
  // in a different place and would prove only that a promise can be left pending.
  it('a webhook that never answers cannot hold the endpoint open', async () => {
    const net = await import('node:net');
    const black = net.createServer((s) => { s.on('data', () => { /* accept, never reply */ }); });
    await new Promise<void>((r) => black.listen(0, '127.0.0.1', () => r()));
    const port = (black.address() as { port: number }).port;

    try {
      const journal = new InMemoryJournal();
      await seedSuspended(journal, 'sus-4');
      const app = createStudioApi({
        reader: journal,
        alerts: { webhook: `http://127.0.0.1:${port}/hook`, timeoutMs: 150 },
      });

      const started = Date.now();
      const res = await Promise.race([
        call(app, '/approvals'),
        new Promise<'HUNG'>((r) => setTimeout(() => r('HUNG'), 5_000)),
      ]);
      expect(res, 'the unanswered webhook held GET /approvals open').not.toBe('HUNG');
      expect((res as Response).status).toBe(200);
      // The inbox is still correct, not merely fast: abandoning the alert must not drop the items.
      expect((await (res as Response).json()).items).toHaveLength(1);
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      await new Promise<void>((r) => black.close(() => r()));
    }
  });
});
