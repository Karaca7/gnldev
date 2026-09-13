// `Idempotency-Key` on the two agent entry points — and the axis it changed.
//
// WHAT THIS FILE USED TO SAY. FAZ-1 wired the header to `body.runId`, because a runId was the only
// identity this host had and it was documented as "the idempotency key". Four tests pinned that: the
// header named a run, the body outranked it, absence was a 400, and the same header replayed.
//
// WHAT CHANGED (package #5 of docs/RUNID-WORKKEY-HEYET-KARARI.md, §7-§8). The header is a `workKey`
// alias now — the caller's name for the WORK — and no longer a runId alias. The IETF draft this
// header comes from describes a key that names the operation a client is trying to perform; a client
// retries by sending the same key because it is the same job. That is a workKey's definition, word
// for word, and it is not a runId's: a runId is an address the engine issued, which nobody's gateway
// has ever seen.
//
// So three of the four tests below MOVED rather than survived. The header still names something, and
// the same header still replays — but what it names is now a job, and the run it opens has a derived
// `run1_` id. Two consequences are pinned here on purpose, because they are what a reader will hit:
//
//   NOTHING IS WRITTEN UNDER THE HEADER'S TEXT any more. A deployment that read journal keys by the
//   key it sent will not find them; it reads `X-Gnl-Run-Id` instead.
//
//   A HEADER WITH NOBODY NAMED IS NOW REFUSED (§6). `'resource'` scope with no resourceId is not a
//   wider scope, it is an unanswered question — and the refusal is loud, which is the cheap direction
//   to be wrong in. The expensive direction delivers one caller's job to another caller's door.
//
// The precedence is unchanged and was never the thing in question: whatever the BODY said wins, the
// header only speaks when the body said nothing. A gateway stamps this header; the body is the
// application's own decision.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, derivedRunId } from '@gnldev/durable';
import { createRestApi } from '../src/index.js';
import { call } from './call.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const mkStream = (arr: any[]) => new ReadableStream({ start(c) { for (const p of arr) c.enqueue(p); c.close(); } });

function mkModel(): any {
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'ok' }],
      finishReason: 'stop',
      usage,
      warnings: [],
    }),
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
  call(api, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe.each([
  ['/agents/a/run', async (res: Response) => { await res.json(); }],
  ['/agents/a/stream', async (res: Response) => { await res.text(); }],
])('POST %s — Idempotency-Key', (path, drain) => {
  const who = { resourceId: 'u-ayse' };

  it('with no body identity, the header names the WORK — and the engine derives the id', async () => {
    const { journal, api } = mkApi();
    const key = `hdr-${path.includes('stream') ? 's' : 'r'}`;
    const res = await post(api, path, { ...who, prompt: 'hi' }, { 'Idempotency-Key': key });
    expect(res.status).toBe(200);
    const id = derivedRunId('agent:a', 'resource', who.resourceId, key);
    expect(res.headers.get('X-Gnl-Run-Id')).toBe(id);
    await drain(res);
    expect(await journal.get<{ workKey?: string }>(`${id}:input`)).toMatchObject({ workKey: key });
    // The MOVE, stated as an assertion: the header's literal text is not a run id.
    expect(await journal.get(`${key}:input`)).toBeUndefined();
  });

  it('body.runId wins over the header — an intermediary cannot redefine the run', async () => {
    const { journal, api } = mkApi();
    const res = await post(api, path, { runId: 'body-wins', prompt: 'hi' }, { 'Idempotency-Key': 'header-loses' });
    expect(res.status).toBe(200);
    await drain(res);
    expect(await journal.get('body-wins:input')).toBeDefined();
    // WHAT THIS LINE USED TO BE, and why it was worth nothing: `expect(journal.get('header-loses:input'))
    // .toBeUndefined()`. Since §8 the header is a workKey ALIAS — it is never used as a raw id by any
    // path, winning or losing — so `header-loses:input` is a key nothing in the codebase can write.
    // The assertion held for a reason unrelated to precedence, and would have gone on holding if the
    // header had won outright.
    //
    // The honest question is "did this request start exactly ONE run, and was it the body's?" — that
    // is what precedence means here, and it fails if the header ever mints a second run under any
    // spelling, derived or raw.
    const inputs = (await journal.listKeys('')).filter((k) => k.endsWith(':input'));
    expect(inputs).toEqual(['body-wins:input']);
  });

  it('body.workKey wins over the header too — same rule, the other half of the pair', async () => {
    const { journal, api } = mkApi();
    const res = await post(api, path, { ...who, workKey: 'body-key', prompt: 'hi' }, { 'Idempotency-Key': 'header-key' });
    expect(res.status).toBe(200);
    await drain(res);
    expect(await journal.get(`${derivedRunId('agent:a', 'resource', who.resourceId, 'body-key')}:input`)).toBeDefined();
    expect(await journal.get(`${derivedRunId('agent:a', 'resource', who.resourceId, 'header-key')}:input`)).toBeUndefined();
  });

  it('a header with nobody named is refused, and the refusal says what is missing', async () => {
    // The visible cost of the axis change, pinned rather than discovered: an open deployment that
    // stamped this header and named no subject used to get a run, and now gets a sentence.
    const { api } = mkApi();
    const res = await post(api, path, { prompt: 'hi' }, { 'Idempotency-Key': 'no-subject' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/resourceId/);
  });

  it('neither present → a 400 that now names both halves', async () => {
    const { api } = mkApi();
    const res = await post(api, path, { prompt: 'hi' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('runId or workKey required (see docs: one names an id, the other names the work)');
  });

  it('the same header retried replays instead of running twice — the promise it was accepted for', async () => {
    const { journal, api } = mkApi();
    const key = `replay-${path.includes('stream') ? 's' : 'r'}`;
    await drain(await post(api, path, { ...who, prompt: 'hi' }, { 'Idempotency-Key': key }));
    const id = derivedRunId('agent:a', 'resource', who.resourceId, key);
    const frozen = await journal.get(`${id}:input`);
    const second = await post(api, path, { ...who, prompt: 'hi' }, { 'Idempotency-Key': key });
    expect(second.headers.get('X-Gnl-Idempotency-Status')).toBe('replay');
    await drain(second);
    // Same frozen input record — the second call did not open a second run.
    expect(await journal.get(`${id}:input`)).toEqual(frozen);
  });
});
