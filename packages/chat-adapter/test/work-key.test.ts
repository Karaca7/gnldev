// The chat route's per-turn key grows up (package #5 of docs/RUNID-WORKKEY-HEYET-KARARI.md §7).
//
// THE PROMOTION. `${body.id}:${lastMessage.id}` has always been the route's answer to "which run is
// this turn?", and it has always been a RAW runId — a client-controlled string used verbatim as the
// journal's key prefix. That is the exact shape §2 lists as bug class 2: `conv` and `conv:msg1` can
// both exist, and a purge of the first eats the second. The string itself was never the problem; the
// job it was doing was. It is a `workKey` now — the caller's NAME for this turn's work — and the
// engine mints the id.
//
// THE CONCESSION, AND WHY IT IS NOT A HOLE. Deriving an id from a name requires an ADDRESS (§6): a
// `'resource'` scope with nobody named is refused. This route ships with no auth, and its quickstart
// is a `useChat` demo with no session store — so a route that refused every anonymous chat would be
// a route whose first five minutes are a 400. When there is no subject, the derived string stays a
// raw runId, exactly as before. Two regimes, and which one you are in is decided by one thing:
// whether the deployment can say WHO the request is for.
//
// What is pinned here:
//   with a subject   → `run1_` id, the declaration frozen into the record, retry replays
//   with no subject  → byte-for-byte today's raw id (the regression pin — this is a quickstart, and
//                      it must not become an error message)
//   either way       → the same message ids produce the same key, which is the retry contract
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, derivedRunId } from '@gnldev/durable';
import { createChatRoute } from '../src/index.js';

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

function mkRoute(opts: Parameters<typeof createChatRoute>[1] = {}) {
  const journal = new InMemoryJournal();
  const app = createChatRoute({ journal, agents: { pay: { model: textMock() } } }, opts);
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    app.request('/agents/pay/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  return { journal, post };
}

const turn = (convo: string, msg: string) => ({
  id: convo,
  messages: [{ id: msg, role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
});

describe('chat route — a named subject promotes the turn key to a workKey', () => {
  it('the derived string names the work; the engine names the run', async () => {
    const { journal, post } = mkRoute({ identity: () => ({ resourceId: 'u-ayse' }) });
    const res = await post(turn('c1', 'm1'));
    expect(res.status).toBe(200);
    const id = derivedRunId('agent:pay', 'resource', 'u-ayse', 'c1:m1');
    expect(res.headers.get('X-Gnl-Run-Id')).toBe(id);
    await res.text();
    expect(await journal.get<{ workKey?: string }>(`${id}:input`)).toMatchObject({ workKey: 'c1:m1' });
    // The client-controlled string is no longer a key prefix — bug class 2 closed at the source.
    expect(await journal.get('c1:m1:input')).toBeUndefined();
  });

  it('the same turn retried replays; a new turn is new work', async () => {
    const { post } = mkRoute({ identity: () => ({ resourceId: 'u-ayse' }) });
    await (await post(turn('c1', 'm1'))).text();
    const retry = await post(turn('c1', 'm1'));
    expect(retry.headers.get('X-Gnl-Idempotency-Status')).toBe('replay');
    await retry.text();
    const next = await post(turn('c1', 'm2'));
    expect(next.headers.get('X-Gnl-Idempotency-Status')).toBe('new');
    expect(next.headers.get('X-Gnl-Run-Id')).not.toBe(retry.headers.get('X-Gnl-Run-Id'));
    await next.text();
  });

  it('the same conversation id from two people is two jobs', async () => {
    let who = 'u-ayse';
    const { post } = mkRoute({ identity: () => ({ resourceId: who }) });
    const a = await post(turn('c1', 'm1'));
    await a.text();
    who = 'u-veli';
    const b = await post(turn('c1', 'm1'));
    await b.text();
    expect(a.headers.get('X-Gnl-Run-Id')).not.toBe(b.headers.get('X-Gnl-Run-Id'));
  });

  it('an explicit body.runId is still raw — the two regimes do not touch', async () => {
    const { journal, post } = mkRoute({ identity: () => ({ resourceId: 'u-ayse' }) });
    const res = await post({ ...turn('c1', 'm1'), runId: 'mine-1' });
    expect(res.headers.get('X-Gnl-Run-Id')).toBe('mine-1');
    await res.text();
    expect(await journal.get('mine-1:input')).toBeDefined();
  });

  it('resolveRunId is still a runId resolver — it names an id, not a job', async () => {
    const { journal, post } = mkRoute({
      identity: () => ({ resourceId: 'u-ayse' }),
      resolveRunId: () => 'host-chosen',
    });
    const res = await post(turn('c1', 'm1'));
    expect(res.headers.get('X-Gnl-Run-Id')).toBe('host-chosen');
    await res.text();
    expect(await journal.get('host-chosen:input')).toBeDefined();
  });

  it('an Idempotency-Key header names the work when there is somebody to name it for', async () => {
    const { journal, post } = mkRoute({ identity: () => ({ resourceId: 'u-ayse' }) });
    const res = await post(turn('c1', 'm1'), { 'Idempotency-Key': 'gateway-key' });
    const id = derivedRunId('agent:pay', 'resource', 'u-ayse', 'gateway-key');
    expect(res.headers.get('X-Gnl-Run-Id')).toBe(id);
    await res.text();
    expect(await journal.get<{ workKey?: string }>(`${id}:input`)).toMatchObject({ workKey: 'gateway-key' });
  });
});

describe('chat route — with nobody named, the derivation stays exactly what it was', () => {
  it('anonymous chat keeps the raw `${body.id}:${lastMessage.id}` id', async () => {
    // THE REGRESSION PIN. This is the quickstart: no auth, no session store, no resolver. It must
    // keep working, and it must keep working with the SAME id, because a deployment that reads
    // journal keys by that string is not wrong today.
    const { journal, post } = mkRoute();
    const res = await post(turn('c1', 'm1'));
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Gnl-Run-Id')).toBe('c1:m1');
    await res.text();
    expect(await journal.get('c1:m1:input')).toBeDefined();
  });

  it('anonymous retry of the same turn still replays — the contract holds in both regimes', async () => {
    const { post } = mkRoute();
    await (await post(turn('c1', 'm1'))).text();
    const retry = await post(turn('c1', 'm1'));
    expect(retry.headers.get('X-Gnl-Run-Id')).toBe('c1:m1');
    expect(retry.headers.get('X-Gnl-Idempotency-Status')).toBe('replay');
    await retry.text();
  });

  it('an anonymous Idempotency-Key stays a raw id too — a gateway must not turn a 200 into a 400', async () => {
    const { journal, post } = mkRoute();
    const res = await post(turn('c1', 'm1'), { 'Idempotency-Key': 'gateway-key' });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Gnl-Run-Id')).toBe('gateway-key');
    await res.text();
    expect(await journal.get('gateway-key:input')).toBeDefined();
  });
});

describe('chat route — a conflict body reflects the caller\'s own workKey', () => {
  it('detail carries the workKey the request declared; the sentence does not', async () => {
    // Same turn key, different content: `run1_` enforces strictInput unconditionally (§5).
    const { post } = mkRoute({ identity: () => ({ resourceId: 'u-ayse' }) });
    await (await post(turn('c1', 'm1'))).text();
    const changed = {
      id: 'c1',
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'SOMETHING ELSE' }] }],
    };
    const res = await post(changed);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string; detail: Record<string, unknown> };
    expect(body.code).toBe('run_input_mismatch');
    expect(body.detail.workKey).toBe('c1:m1');
    expect(body.error).not.toContain('c1:m1');
  });
});

// THE SEAL'S orgId REACHES THE DERIVATION — REST parity (§7, package #5's last row).
//
// `AgentConfig.workScope: 'org'` says the name is unique within an ORGANIZATION, not within a
// person: a nightly reconciliation, a shared inbox, an installation-wide job. @gnldev/server's REST
// route has always passed the org through (`resolveWorkIdentity(..., { orgId })`), and this route
// passed only `resourceId`.
//
// The measured consequence is not a 400 — it is worse than that, because it succeeds. With no
// `orgId`, an `'org'` scope falls back to the deployment sentinel (§10.2), so the chat surface and
// the REST surface derive TWO DIFFERENT ids for the same org's same named work. One job, named once,
// with two runs and two charges — and the surface each request happened to arrive through is the
// only thing that decided which. The parity is the promise; this is where it is pinned.
describe('chat route — the org in the seal reaches the derivation (REST parity)', () => {
  function mkOrgRoute(opts: Parameters<typeof createChatRoute>[1] = {}) {
    const journal = new InMemoryJournal();
    const app = createChatRoute(
      { journal, agents: { mutabakat: { model: textMock(), workScope: 'org' } } } as never,
      opts,
    );
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      app.request('/agents/mutabakat/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    return { journal, post };
  }

  it('an org-scoped agent derives the SAME id REST would derive', async () => {
    const { journal, post } = mkOrgRoute({ identity: () => ({ resourceId: 'u-ayse', orgId: 'org-akme' }) });
    const res = await post(turn('c1', 'm1'));
    expect(res.status).toBe(200);
    // What @gnldev/server computes for the same tuple — the org address, not the sentinel.
    const rest = derivedRunId('agent:mutabakat', 'org', 'org-akme', 'c1:m1');
    expect(res.headers.get('X-Gnl-Run-Id')).toBe(rest);
    await res.text();
    expect(await journal.get<{ workScope?: unknown }>(`${rest}:input`))
      .toMatchObject({ workKey: 'c1:m1', workScope: { kind: 'org', value: 'org-akme' } });
  });

  it('two people in ONE org, same turn key → one run; a second org is a second run', async () => {
    let org = 'org-akme';
    let who = 'u-ayse';
    const { post } = mkOrgRoute({ identity: () => ({ resourceId: who, orgId: org }) });
    const a = await post(turn('c1', 'm1'));
    await a.text();
    who = 'u-veli';
    const b = await post(turn('c1', 'm1'));
    await b.text();
    expect(b.headers.get('X-Gnl-Run-Id'), 'org kapsamı özneye değil kuruma bağlar').toBe(a.headers.get('X-Gnl-Run-Id'));
    org = 'org-baska';
    const c = await post(turn('c1', 'm1'));
    await c.text();
    expect(c.headers.get('X-Gnl-Run-Id')).not.toBe(a.headers.get('X-Gnl-Run-Id'));
  });

  it('a RESOURCE-scoped agent ignores the org — the scope decides the address, not the request', async () => {
    const { post } = mkRoute({ identity: () => ({ resourceId: 'u-ayse', orgId: 'org-akme' }) });
    const res = await post(turn('c1', 'm1'));
    expect(res.headers.get('X-Gnl-Run-Id')).toBe(derivedRunId('agent:pay', 'resource', 'u-ayse', 'c1:m1'));
    await res.text();
  });
});
