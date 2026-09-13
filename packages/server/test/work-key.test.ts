// Package #5 of `docs/RUNID-WORKKEY-HEYET-KARARI.md`: the HTTP surface learns to take a NAME instead
// of an id.
//
// What this pins, in the order the decision argues it:
//
//   THE BODY TAKES A `workKey`. `POST /agents/:name/run` and `/stream` accept the caller's name for
//   the unit of work; the engine mints `run1_<digest>` from it and the response says which id that
//   was. `body.runId` is untouched and still raw — the two are separate regimes, not a migration.
//
//   THE HEADER CHANGED MEANING (§8, and the reason this file replaces half of
//   `idempotency-key.test.ts`). `Idempotency-Key` was wired in FAZ-1 as an alias for `body.runId`.
//   That was the wrong axis: IETF's key names the WORK a request is trying to do, which is exactly
//   what a `workKey` is and exactly what a raw runId is not. It is a `workKey` alias now, so the
//   header produces a derived id — and, in a `'resource'` scope with nobody named, it is refused
//   rather than quietly run for nobody (§6's fail-closed rule, arriving on the wire).
//
//   ONE IDENTITY PER CALL. runId AND workKey together is a question with no honest answer, so it is
//   a 400 before anything is written — the engine's own refusal, rendered by the route.
//
//   THE ERROR BODY REFLECTS THE CALLER'S OWN KEY (§8 rules 1-3). A conflict's `detail` carries the
//   `workKey` the REQUEST sent (never one read back out of storage — that is §10.3's tombstone rule),
//   and the `error` sentence never does: the sentence is the most casually logged field there is.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, derivedRunId } from '@gnldev/durable';
import { createRestApi } from '../src/index.js';
import { call } from './call.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const mkStream = (arr: any[]) => new ReadableStream({ start(c) { for (const p of arr) c.enqueue(p); c.close(); } });

function mkModel(): any {
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
    doGenerate: async () => ({ content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage, warnings: [] }),
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

function mkApi() {
  const journal = new InMemoryJournal();
  return { journal, api: createRestApi({ journal, agents: { a: { model: mkModel() } } }) };
}

const post = (api: any, path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(api, path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe.each([
  ['/agents/a/run', async (res: Response) => { await res.json(); }],
  ['/agents/a/stream', async (res: Response) => { await res.text(); }],
])('POST %s — workKey', (path, drain) => {
  it('names the work; the engine answers with the id it derived', async () => {
    const { journal, api } = mkApi();
    const res = await post(api, path, { workKey: 'invoice-4471', resourceId: 'u-ayse', prompt: 'hi' });
    expect(res.status).toBe(200);
    const expected = derivedRunId('agent:a', 'resource', 'u-ayse', 'invoice-4471');
    expect(res.headers.get('X-Gnl-Run-Id')).toBe(expected);
    expect(expected.startsWith('run1_')).toBe(true);
    await drain(res);
    // The declaration is FROZEN into the run's own record — that is what makes it queryable later.
    expect(await journal.get<{ workKey?: string }>(`${expected}:input`)).toMatchObject({ workKey: 'invoice-4471' });
  });

  it('the same workKey is the same work — the second call replays instead of paying twice', async () => {
    const { journal, api } = mkApi();
    const body = { workKey: 'invoice-4471', resourceId: 'u-ayse', prompt: 'hi' };
    const first = await post(api, path, body);
    expect(first.headers.get('X-Gnl-Idempotency-Status')).toBe('new');
    await drain(first);
    const id = derivedRunId('agent:a', 'resource', 'u-ayse', 'invoice-4471');
    const frozen = await journal.get(`${id}:input`);
    const second = await post(api, path, body);
    expect(second.status).toBe(200);
    expect(second.headers.get('X-Gnl-Run-Id')).toBe(id);
    expect(second.headers.get('X-Gnl-Idempotency-Status')).toBe('replay');
    await drain(second);
    expect(await journal.get(`${id}:input`)).toEqual(frozen);
  });

  it('the same name from two people is two jobs — the address is part of the name', async () => {
    const { api } = mkApi();
    const a = await post(api, path, { workKey: 'nightly', resourceId: 'u-ayse', prompt: 'hi' });
    await drain(a);
    const b = await post(api, path, { workKey: 'nightly', resourceId: 'u-veli', prompt: 'hi' });
    await drain(b);
    expect(a.headers.get('X-Gnl-Run-Id')).not.toBe(b.headers.get('X-Gnl-Run-Id'));
  });

  it('runId AND workKey together is refused before anything is written', async () => {
    const { journal, api } = mkApi();
    const res = await post(api, path, { runId: 'raw-1', workKey: 'invoice-4471', resourceId: 'u-ayse', prompt: 'hi' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/BOTH a runId and a workKey/);
    expect(await journal.get('raw-1:input')).toBeUndefined();
  });

  it("a 'resource' workKey with nobody named is refused, and says what to send", async () => {
    // §6 fail-closed: the address the name is unique within is missing, so the engine cannot tell
    // whose job this is. Losing the address delivers the work to another customer's door.
    const { api } = mkApi();
    const res = await post(api, path, { workKey: 'invoice-4471', prompt: 'hi' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/resourceId/);
  });

  it('neither identity → the 400 now names both halves', async () => {
    const { api } = mkApi();
    const res = await post(api, path, { prompt: 'hi' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('runId or workKey required (see docs: one names an id, the other names the work)');
  });

  it('a raw body.runId still echoes itself — the two regimes do not touch', async () => {
    const { journal, api } = mkApi();
    const res = await post(api, path, { runId: 'raw-1', prompt: 'hi' });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Gnl-Run-Id')).toBe('raw-1');
    await drain(res);
    expect(await journal.get('raw-1:input')).toBeDefined();
  });
});

// The `Idempotency-Key` header is the same declaration arriving by another route, and it has its own
// file: `idempotency-key.test.ts`, which also records what the header USED to mean.

describe('conflict bodies carry the caller\'s own workKey', () => {
  it('detail reflects the REQUEST\'s workKey; the error sentence never does', async () => {
    // Same workKey, different content: inside `run1_` strictInput is not optional (§5), so the
    // second call is refused rather than silently answered with the first one's work.
    const { api } = mkApi();
    await (await post(api, '/agents/a/run', { workKey: 'invoice-4471', resourceId: 'u-ayse', prompt: 'first' })).json();
    const res = await post(api, '/agents/a/run', { workKey: 'invoice-4471', resourceId: 'u-ayse', prompt: 'SECOND' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string; detail: Record<string, unknown> };
    expect(body.code).toBe('run_input_mismatch');
    expect(body.detail.workKey).toBe('invoice-4471');
    // Rule 1: the sentence is the field everything logs. The name stays out of it.
    expect(body.error).not.toContain('invoice-4471');
  });

  // THESE TWO WERE ONE TEST, AND IT ASSERTED NOTHING.
  //
  // It posted a raw runId twice and then wrote `if (res.status === 409) { ...expect... }`. A
  // conditional whose body holds the only assertion passes for free the moment the condition is
  // false — and here it was ALWAYS false on the path that mattered, so the file's last claim about
  // raw ids was decoration. Split into the two things it was trying to say, both unconditional:
  // what a raw re-POST DOES (replay), and what a raw refusal does NOT carry (a workKey).
  it('a raw runId with no strictInput REPLAYS — the second call is answered, not refused', async () => {
    const { api } = mkApi();
    const first = await post(api, '/agents/a/run', { runId: 'raw-replay', resourceId: 'u-ayse', prompt: 'first' });
    expect(first.status).toBe(200);
    expect(first.headers.get('X-Gnl-Idempotency-Status')).toBe('new');
    await first.json();
    // Same id, same subject, DIFFERENT content — and outside `run1_` the fingerprint is opt-in, so
    // this is the raw regime's whole promise: the id is the caller's own key and the journal answers
    // from what it already has. (§5's unconditional check is derived-ids only; that is the asymmetry.)
    const res = await post(api, '/agents/a/run', { runId: 'raw-replay', resourceId: 'u-ayse', prompt: 'SECOND' });
    expect(res.status, 'ham id + strictInput yok → 409 değil, replay').toBe(200);
    expect(res.headers.get('X-Gnl-Idempotency-Status')).toBe('replay');
    await res.json();
  });

  it('a raw-runId refusal carries no workKey — the caller declared none', async () => {
    // A REAL 409, and it has to be an in-ENGINE one. Changing the subject instead answers 403: the
    // route's own run-ownership gate sits in front of the engine's actor lock and refuses first, so
    // that setup would test the edge and never reach a conflict body at all.
    //
    // Thread mismatch is the gate a raw id still answers to with the subject held constant: one
    // runId is one conversation, frozen first-wins at `:input`. That gives a genuine
    // `callerConflictCode` body with a populated `detail` — which is the only place the absence
    // below means anything. Asserting "no workKey" on an empty detail would prove nothing.
    const { api } = mkApi();
    await (await post(api, '/agents/a/run', { runId: 'raw-thread', resourceId: 'u-ayse', threadId: 't-1', prompt: 'first' })).json();
    const res = await post(api, '/agents/a/run', { runId: 'raw-thread', resourceId: 'u-ayse', threadId: 't-2', prompt: 'first' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code?: string; detail?: Record<string, unknown> };
    expect(body.code).toBe('run_thread_mismatch');
    expect(body.detail, 'detail dolu olmalı — boş bir nesnede "yok" iddiası hiçbir şey kanıtlamaz').toBeTruthy();
    expect(Object.keys(body.detail ?? {}).length).toBeGreaterThan(0);
    expect(body.detail?.workKey).toBeUndefined();
  });
});

describe('POST /workflows/:name/run — workKey', () => {
  // Minimal structural WorkflowLike, same shape as workflows.test.ts's.
  const wf = {
    build: () => [{ id: 's1' }],
    run: async (input: any, ctx: { runId: string; journal: any }) => {
      await ctx.journal.put(`${ctx.runId}:wf:s1`, { echo: input });
      return { done: true };
    },
  };
  function mkWfApi() {
    const journal = new InMemoryJournal();
    return { journal, api: createRestApi({ journal, agents: { a: { model: mkModel() } }, workflows: { w: wf as any } }) };
  }

  it('names the work and the engine derives the id', async () => {
    const { journal, api } = mkWfApi();
    const res = await post(api, '/workflows/w/run', { workKey: 'nightly-recon', resourceId: 'u-ayse', input: {} });
    expect(res.status).toBe(200);
    const id = derivedRunId('wf:w', 'resource', 'u-ayse', 'nightly-recon');
    expect(res.headers.get('X-Gnl-Run-Id')).toBe(id);
    expect(await journal.get<{ workKey?: string }>(`${id}:input`)).toMatchObject({ workKey: 'nightly-recon' });
  });

  it("workScope 'org' runs the installation's job under the deployment sentinel", async () => {
    // §10.2: an org-less installation is not a mistake — the value is visible in the record.
    const { journal, api } = mkWfApi();
    const res = await post(api, '/workflows/w/run', { workKey: 'nightly-recon', workScope: 'org', input: {} });
    expect(res.status).toBe(200);
    const id = derivedRunId('wf:w', 'org', '~deployment', 'nightly-recon');
    expect(res.headers.get('X-Gnl-Run-Id')).toBe(id);
    expect(await journal.get<{ workScope?: unknown }>(`${id}:input`)).toMatchObject({
      workScope: { kind: 'org', value: '~deployment' },
    });
  });

  it('an unknown workScope is refused rather than quietly defaulted', async () => {
    const { api } = mkWfApi();
    const res = await post(api, '/workflows/w/run', { workKey: 'x', workScope: 'planet', input: {} });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/workScope/);
  });
});
