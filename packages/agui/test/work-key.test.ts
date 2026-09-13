// The AG-UI route takes a `workKey` (package #5 of docs/RUNID-WORKKEY-HEYET-KARARI.md §7).
//
// Two things arrive together here, and they follow DIFFERENT rules on purpose:
//
//   `body.workKey` — a name the caller DECLARED. Always a workKey, and fail-closed: a `'resource'`
//   scope with nobody named is refused (§6), because the address is what tells the engine whose job
//   this is. The field is new, so nothing is being taken away from anyone.
//
//   `Idempotency-Key` — a name that arrives IMPLICITLY, usually stamped by a gateway. It becomes a
//   workKey when the route can name a subject, and otherwise stays the raw runId it has been since
//   FAZ-1. That is the same two-regime rule @gnldev/chat-adapter uses, and this route has always
//   deferred to that one (see its own note): both ship with no auth, so both have deployments that
//   can name nobody, and turning their 200 into a 400 is not a fix.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, derivedRunId } from '@gnldev/durable';
import { createAguiRoute } from '../src/index.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const mkStream = (arr: any[]) => new ReadableStream({ start(c) { for (const p of arr) c.enqueue(p); c.close(); } });

function textMock(): any {
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
    doGenerate: async () => { throw new Error('no gen'); },
    doStream: async () => ({
      stream: mkStream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: '1' },
        { type: 'text-delta', id: '1', delta: 'ok' },
        { type: 'text-end', id: '1' },
        { type: 'finish', finishReason: 'stop', usage },
      ]),
    }),
  };
}

function mkRoute(opts: Parameters<typeof createAguiRoute>[1] = {}) {
  const journal = new InMemoryJournal();
  const handler = createAguiRoute({ journal, agents: { pay: { model: textMock() } } }, opts);
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    handler(new Request('http://x/agents/pay/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }));
  return { journal, post };
}

describe('agui route — workKey', () => {
  it('names the work; the engine mints the id and freezes the declaration', async () => {
    const { journal, post } = mkRoute({ identity: () => ({ resourceId: 'u-ayse' }) });
    const res = await post({ workKey: 'invoice-4471', prompt: 'hi' });
    expect(res.status).toBe(200);
    await res.text();
    const id = derivedRunId('agent:pay', 'resource', 'u-ayse', 'invoice-4471');
    expect(await journal.get<{ workKey?: string }>(`${id}:input`)).toMatchObject({ workKey: 'invoice-4471' });
  });

  it('runId AND workKey together is refused', async () => {
    const { post } = mkRoute({ identity: () => ({ resourceId: 'u-ayse' }) });
    const res = await post({ runId: 'raw-1', workKey: 'invoice-4471', prompt: 'hi' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/BOTH a runId and a workKey/);
  });

  it('a declared workKey with nobody named is refused, and says what is missing', async () => {
    const { post } = mkRoute();
    const res = await post({ workKey: 'invoice-4471', prompt: 'hi' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/resourceId/);
  });

  it('neither identity → 400, as it always has been', async () => {
    const { post } = mkRoute();
    const res = await post({ prompt: 'hi' });
    expect(res.status).toBe(400);
  });

  it('the header names the work when there is a subject…', async () => {
    const { journal, post } = mkRoute({ identity: () => ({ resourceId: 'u-ayse' }) });
    const res = await post({ prompt: 'hi' }, { 'Idempotency-Key': 'gateway-key' });
    expect(res.status).toBe(200);
    await res.text();
    expect(await journal.get(`${derivedRunId('agent:pay', 'resource', 'u-ayse', 'gateway-key')}:input`)).toBeDefined();
    expect(await journal.get('gateway-key:input')).toBeUndefined();
  });

  it('…and stays a raw id when there is not (the FAZ-1 regression pin)', async () => {
    const { journal, post } = mkRoute();
    const res = await post({ prompt: 'hi' }, { 'Idempotency-Key': 'gateway-key' });
    expect(res.status).toBe(200);
    await res.text();
    expect(await journal.get('gateway-key:input')).toBeDefined();
  });

  it('a raw body.runId is untouched by any of this', async () => {
    const { journal, post } = mkRoute({ identity: () => ({ resourceId: 'u-ayse' }) });
    const res = await post({ runId: 'raw-1', prompt: 'hi' }, { 'Idempotency-Key': 'ignored' });
    expect(res.status).toBe(200);
    await res.text();
    expect(await journal.get('raw-1:input')).toBeDefined();
  });
});

// THE SEAL'S orgId REACHES THE DERIVATION — the sibling route's pin, and the same reason.
//
// See @gnldev/chat-adapter's work-key.test.ts for the full note. Short version: an `'org'` workScope
// with no `orgId` falls back to the deployment sentinel (§10.2), so the same org's same named work
// gets one id through @gnldev/server's REST route and a DIFFERENT one through here. It does not
// fail; it duplicates — and the surface the request happened to arrive through is the only thing
// that decided which. Both adapters take the org off the same `identity` hook now, so all three
// surfaces answer "which run is this work?" with one id.
describe('agui route — the org in the seal reaches the derivation (REST parity)', () => {
  function mkOrgRoute(opts: Parameters<typeof createAguiRoute>[1] = {}) {
    const journal = new InMemoryJournal();
    const handler = createAguiRoute(
      { journal, agents: { mutabakat: { model: textMock(), workScope: 'org' } } } as never,
      opts,
    );
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      handler(new Request('http://x/agents/mutabakat/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }));
    return { journal, post };
  }

  it('an org-scoped agent derives the SAME id REST would derive', async () => {
    const { journal, post } = mkOrgRoute({ identity: () => ({ resourceId: 'u-ayse', orgId: 'org-akme' }) });
    const res = await post({ workKey: 'gece-mutabakati', prompt: 'hi' });
    expect(res.status).toBe(200);
    await res.text();
    const rest = derivedRunId('agent:mutabakat', 'org', 'org-akme', 'gece-mutabakati');
    expect(await journal.get<{ workScope?: unknown }>(`${rest}:input`))
      .toMatchObject({ workKey: 'gece-mutabakati', workScope: { kind: 'org', value: 'org-akme' } });
  });

  it('an org WITHOUT a subject still derives — installation-wide work names nobody', async () => {
    // The `'resource'` scope's fail-closed rule does not apply here: an org address IS an address.
    // This is the nightly-reconciliation case, and refusing it would be refusing the reason `'org'`
    // exists.
    const { journal, post } = mkOrgRoute({ identity: () => ({ orgId: 'org-akme' }) });
    const res = await post({ workKey: 'gece-mutabakati', prompt: 'hi' });
    expect(res.status).toBe(200);
    await res.text();
    const id = derivedRunId('agent:mutabakat', 'org', 'org-akme', 'gece-mutabakati');
    expect(await journal.get(`${id}:input`)).toBeDefined();
  });

  it('a RESOURCE-scoped agent ignores the org — the scope decides the address, not the request', async () => {
    const { journal, post } = mkRoute({ identity: () => ({ resourceId: 'u-ayse', orgId: 'org-akme' }) });
    await (await post({ workKey: 'invoice-4471', prompt: 'hi' })).text();
    expect(await journal.get(`${derivedRunId('agent:pay', 'resource', 'u-ayse', 'invoice-4471')}:input`)).toBeDefined();
  });
});
