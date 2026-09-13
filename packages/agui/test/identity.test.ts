// The AG-UI route's half of two contracts it shares with @gnldev/chat-adapter: one `identity` hook with the
// SAME signature, and `Idempotency-Key` as an alias for the runId it has always demanded.
//
// IDENTITY. This route is where "two hooks per adapter" cost the most: `resolveThreadId` was called,
// its answer went into the SSE envelope, and the run still read and wrote the thread the client
// named (see the Turkish note on the stream call in route.ts). A host wired the hook, watched the
// right value come back in the response, and had changed nothing. One hook, one signature, both
// adapters — so the function is written once and cannot be half-wired.
//
// IDEMPOTENCY-KEY. This route used to answer 400 "runId is required" while ignoring the header the
// industry uses to say exactly that: a caller behind a gateway that stamps it got a refusal telling
// them to send what they had just sent. The header is an ALIAS, never an override — `body.runId` is
// an application decision, the header is often a proxy's, and header-first would let an intermediary
// silently redefine which run a request is.
//
// What the header is an alias FOR changed in package #5 (docs/RUNID-WORKKEY-HEYET-KARARI.md): it
// names the WORK now, so with a resolvable subject it becomes a `workKey` and the engine derives the
// id. That half lives in work-key.test.ts. The three tests here pin the identity-LESS path, which is
// deliberately unchanged: no subject, no address to derive against, so the header stays a raw runId.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createAguiRoute } from '../src/route.js';
import { call } from './call.js';

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

/** Runs the route for real and reads the input the ENGINE froze — where ownership is later read from. */
async function drive(body: unknown, opts: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const journal = new InMemoryJournal();
  const app = createAguiRoute({ journal, agents: { a: { model: textMock() } } } as never, opts as never);
  const res = await call(app, '/agents/a/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text(); // drain the stream → the run finishes
  return { res, text, journal };
}

afterEach(() => vi.restoreAllMocks());

describe('agui: the single `identity` hook', () => {
  it('feeds BOTH fields, and the thread it names is the one the RUN uses', async () => {
    const { journal } = await drive(
      { runId: 'ag-1', prompt: 'x' },
      { identity: () => ({ resourceId: 'ayse', threadId: 'thr-ayse' }) },
    );
    const input = await journal.get<{ resourceId?: string; threadId?: string }>('ag-1:input');
    expect(input?.resourceId).toBe('ayse');
    // The regression this route already paid for once: a threadId that only reaches the envelope.
    expect(input?.threadId).toBe('thr-ayse');
  });

  it('the existing resolvers WIN, field by field', async () => {
    const { journal } = await drive(
      { runId: 'ag-2', prompt: 'x' },
      { identity: () => ({ resourceId: 'from-identity', threadId: 'from-identity' }), resolveThreadId: () => 'from-resolver' },
    );
    const input = await journal.get<{ resourceId?: string; threadId?: string }>('ag-2:input');
    expect(input?.threadId).toBe('from-resolver');
    expect(input?.resourceId).toBe('from-identity');
  });

  it('identity outranks the BODY — server-derived beats caller-asserted', async () => {
    const { journal } = await drive(
      { runId: 'ag-3', prompt: 'x', threadId: 'client-thread' },
      { identity: () => ({ threadId: 'server-thread' }) },
    );
    expect((await journal.get<{ threadId?: string }>('ag-3:input'))?.threadId).toBe('server-thread');
  });

  it('receives the web Request — a host bridging from Express has one and no Hono context', async () => {
    let seenReq: unknown;
    await drive(
      { runId: 'ag-4', prompt: 'x' },
      { identity: (req: Request) => { seenReq = req; return { resourceId: req.headers.get('x-user') ?? undefined }; } },
      { 'x-user': 'header-user' },
    );
    expect(seenReq).toBeInstanceOf(Request);
  });
});

// The header's OTHER half — what it means when a subject IS resolvable — moved to work-key.test.ts
// with the rest of package #5. These three keep the identity-less path pinned, which is the half
// that must not change.
describe('agui: Idempotency-Key with nobody named stays an alias for body.runId', () => {
  it('a request with no body.runId but the header runs under the header value', async () => {
    const { res, journal } = await drive({ prompt: 'x' }, {}, { 'Idempotency-Key': 'hdr-run-1' });
    expect(res.status).toBe(200);
    expect(await journal.get('hdr-run-1:input')).toBeDefined();
  });

  it('body.runId WINS — a gateway header must not redefine the application\'s run', async () => {
    const { journal } = await drive({ runId: 'body-run', prompt: 'x' }, {}, { 'Idempotency-Key': 'hdr-run-2' });
    expect(await journal.get('body-run:input')).toBeDefined();
    expect(await journal.get('hdr-run-2:input')).toBeUndefined();
  });

  it('neither present → still a 400; the sentence now names both halves of the pair', async () => {
    const { res, text } = await drive({ prompt: 'x' });
    expect(res.status).toBe(400);
    expect(text).toContain('runId or workKey is required');
  });
});

// WHERE THE TWO REGIMES DIVIDE — the sibling adapter's boundary tests, on this route's own shapes.
//
// Same §7 rule, one difference that matters: this route takes an explicit `body.workKey`, and THAT
// half is fail-closed. The header is the forgiving one. So "no subject" has two different answers
// here depending on which name arrived, and both are pinned below.
describe('agui: the regime boundary', () => {
  it('`identity: () => undefined` keeps the HEADER raw — the anonymous deployment still runs', async () => {
    const { res, journal } = await drive({ prompt: 'x' }, { identity: () => undefined }, { 'Idempotency-Key': 'hdr-raw' });
    expect(res.status).toBe(200);
    expect(await journal.get('hdr-raw:input'), 'ham rejim: başlık id olarak geçer').toBeDefined();
  });

  it('…but a DECLARED body.workKey with nobody named is refused — the two names have different rules', async () => {
    // Not an inconsistency. The header is old and often a proxy's, so turning its 200 into a 400
    // would break deployments that never asked for any of this; `body.workKey` is new, so nobody can
    // lose anything by it being strict. §6's fail-closed rule applies where it costs nothing.
    const { res, text } = await drive({ workKey: 'invoice-1', prompt: 'x' }, { identity: () => undefined });
    expect(res.status).toBe(400);
    expect(text).toContain('resourceId');
  });

  it('`resourceId: \'\'` is NOT a subject — raw regime, and no owner is frozen', async () => {
    // Pinned rather than normalized, for the reason written out in chat-adapter's identity.test.ts:
    // `''` is falsy, so it takes the "no answer" branch at the promotion decision and at the spreads
    // that pass `resourceId` onward. The outcome that matters is the last assertion — an empty
    // subject must never be written as the run's OWNER, because `''` is a value any two unrelated
    // callers produce, and an ownership gate comparing `'' === ''` would let each of them re-drive
    // the other's run.
    const { res, journal } = await drive(
      { prompt: 'x' },
      { identity: () => ({ resourceId: '' }) },
      { 'Idempotency-Key': 'hdr-empty' },
    );
    expect(res.status).toBe(200);
    const input = await journal.get<{ resourceId?: string }>('hdr-empty:input');
    expect(input, 'ham id ile doğdu — türetme yok').toBeDefined();
    expect(input?.resourceId, 'boş özne SAHİP olarak dondurulmaz').toBeUndefined();
  });

  it('an empty `resolveResourceId` answer behaves identically — one rule, both hooks', async () => {
    const { res, journal } = await drive(
      { prompt: 'x' },
      { resolveResourceId: () => '', identity: () => ({ resourceId: 'u-ayse' }) },
      { 'Idempotency-Key': 'hdr-empty-2' },
    );
    // `??` falls through on nullish only, and `''` is not nullish — the dedicated hook's answer
    // stands, which is the documented field-by-field precedence doing its job.
    expect(res.status).toBe(200);
    expect(await journal.get('hdr-empty-2:input')).toBeDefined();
  });
});

describe('agui: production without any way to name a caller', () => {
  const withEnv = (value: string | undefined, fn: () => void) => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = value;
    try { fn(); } finally { process.env.NODE_ENV = prev; }
  };
  const mk = (opts: Record<string, unknown> = {}) =>
    createAguiRoute({ journal: new InMemoryJournal(), agents: { a: { model: textMock() } } } as never, opts as never);

  it('warns once and does NOT throw', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    withEnv('production', () => { expect(() => mk()).not.toThrow(); });
    const msg = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes('agui-route'));
    expect(msg).toBeDefined();
    expect(msg).toContain('ownerless');
    expect(msg).toContain('fail-open');
  });

  it('stays silent with either hook, and outside production', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    withEnv('production', () => {
      mk({ identity: () => ({ resourceId: 'u' }) });
      mk({ resolveResourceId: () => 'u' });
    });
    withEnv('development', () => { mk(); });
    expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('ownerless'))).toEqual([]);
  });
});
