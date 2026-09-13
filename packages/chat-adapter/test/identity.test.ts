// ONE hook for "who is this, and which conversation" — and what happens in production without it.
//
// Before `identity`, a host that wanted to bind a subject wrote `resolveResourceId` here and a
// SECOND, differently-shaped `resolveResourceId` on @gnldev/agui, plus a `resolveThreadId` on each. Four
// functions for one question, and the sibling adapter's thread resolver spent a release feeding the
// SSE envelope and nothing else — so a host could wire it, see the right value come back, and still
// have every run reading the thread the CLIENT named.
//
// The existing hooks are not replaced. They win, field by field: a deployment that already answers
// this question must not have its answer quietly taken over by a newer convenience.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createChatRoute } from '../src/chat-route.js';

/** Captures what actually reached the run — the route's contract, without descending into the engine. */
function spyGnl() {
  // `workKey` is here because it is how the two REGIMES are told apart from outside: the route hands
  // the door a NAME (promoted) or an ID (raw), never both, and which one it chose is the whole
  // question the regime tests below ask.
  const seen: { runId?: string; workKey?: string; threadId?: string; resourceId?: string }[] = [];
  return {
    seen,
    gnl: {
      agent: () => ({}),
      stream: async (_name: string, opts: any) => {
        seen.push({ runId: opts.runId, workKey: opts.workKey, threadId: opts.threadId, resourceId: opts.resourceId });
        return { toUIMessageStream: () => new ReadableStream({ start: (c) => c.close() }), text: Promise.resolve('') };
      },
    } as any,
  };
}

const MSG = [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }];
const post = (app: any, body: unknown, headers: Record<string, string> = {}) =>
  app.request('/agents/a/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

afterEach(() => vi.restoreAllMocks());

describe('chat route: the single `identity` hook', () => {
  it('feeds BOTH fields from one call', async () => {
    const { gnl, seen } = spyGnl();
    const app = createChatRoute({ gnl }, { identity: () => ({ resourceId: 'ayse', threadId: 'thr-ayse' }) });
    await post(app, { id: 'conv', runId: 'r1', messages: MSG });
    expect(seen[0]).toMatchObject({ resourceId: 'ayse', threadId: 'thr-ayse' });
  });

  it('is called ONCE per request — two calls can disagree', async () => {
    // The same reason the route already resolves `subject` once: a resolver that reads the request
    // is a function of the request, and nothing promises it is a pure one.
    let calls = 0;
    const { gnl } = spyGnl();
    const app = createChatRoute({ gnl }, { identity: () => { calls++; return { resourceId: `u${calls}`, threadId: `t${calls}` }; } });
    await post(app, { id: 'conv', runId: 'r1', messages: MSG });
    expect(calls).toBe(1);
  });

  it('receives the web Request, not the Hono context — an Express bridge has one and not the other', async () => {
    const { gnl } = spyGnl();
    let seenReq: unknown;
    const app = createChatRoute({ gnl }, { identity: (req) => { seenReq = req; return { resourceId: req.headers.get('x-user') ?? undefined }; } });
    await post(app, { id: 'conv', runId: 'r1', messages: MSG }, { 'x-user': 'from-header' });
    expect(seenReq).toBeInstanceOf(Request);
  });

  it('the existing resolvers WIN, field by field', async () => {
    const { gnl, seen } = spyGnl();
    const app = createChatRoute(
      { gnl },
      {
        identity: () => ({ resourceId: 'from-identity', threadId: 'from-identity' }),
        resolveResourceId: () => 'from-resolver',
      },
    );
    await post(app, { id: 'conv', runId: 'r1', messages: MSG });
    // resourceId comes from the dedicated resolver; threadId, which it does not answer, falls to identity.
    expect(seen[0]).toMatchObject({ resourceId: 'from-resolver', threadId: 'from-identity' });
  });

  it('identity outranks the BODY — it is server-derived and the body is not', async () => {
    const { gnl, seen } = spyGnl();
    const app = createChatRoute({ gnl }, { identity: () => ({ threadId: 'server-thread' }) });
    await post(app, { id: 'conv', runId: 'r1', threadId: 'client-thread', messages: MSG });
    expect(seen[0]!.threadId).toBe('server-thread');
  });

  it('an identity that answers nothing changes nothing', async () => {
    const { gnl, seen } = spyGnl();
    const app = createChatRoute({ gnl }, { identity: () => undefined });
    await post(app, { id: 'conv', runId: 'r1', messages: MSG });
    expect(seen[0]!.resourceId).toBeUndefined();
    expect(seen[0]!.threadId).toBe('conv'); // the documented default: the conversation id
  });
});

// WHERE THE TWO REGIMES DIVIDE — the line §7 draws, asked from the outside.
//
// The route promotes the turn's name to a `workKey` when it can name a subject, and leaves it a raw
// runId when it cannot. Everything above tests the hook; this tests the DECISION the hook feeds, and
// the two edges of it that are easy to get wrong because both of them look like "no subject" from a
// distance and neither one raises anything.
describe('chat route: the regime boundary', () => {
  it('`identity: () => undefined` keeps the turn key RAW — the quickstart is not a 400', async () => {
    // The concession package #5 made on purpose: deriving needs an address, this route ships with no
    // auth, and a `useChat` demo names nobody. So the derived string stays what it has been since
    // FAZ-1 — a raw id — and the first five minutes keep working.
    const { gnl, seen } = spyGnl();
    const app = createChatRoute({ gnl }, { identity: () => undefined });
    await post(app, { id: 'conv', messages: MSG });
    expect(seen[0]!.runId, 'ham rejim: turun adı id olarak geçer').toBe('conv:m1');
    expect(seen[0]!.workKey, 'terfi YOK — adres yok').toBeUndefined();
  });

  it('a NAMED subject promotes the same turn key — the only thing that moved is the address', async () => {
    const { gnl, seen } = spyGnl();
    const app = createChatRoute({ gnl }, { identity: () => ({ resourceId: 'u-ayse' }) });
    await post(app, { id: 'conv', messages: MSG });
    expect(seen[0]!.workKey).toBe('conv:m1');
    expect(seen[0]!.runId, 'kapıya AD verilir, id değil — ikisi birden asla').toBeUndefined();
  });

  it('`resourceId: \'\'` is NOT a subject — it falls to the raw regime and asserts no owner', async () => {
    // Deliberately pinned rather than normalized. An empty string is falsy, so it takes the same
    // branch as "no answer" at both of the places that read it: the promotion decision (`if
    // (subject)`) and the two spreads that only pass `resourceId` when it is truthy. The result is
    // the conservative one and it is worth stating out loud — an empty subject is NOT frozen onto
    // the run as its owner, which is the outcome that would actually hurt: `''` is a value two
    // unrelated callers can both produce, so an ownership gate comparing `'' === ''` would hand
    // every anonymous caller the same key.
    //
    // Normalizing `''` to `undefined` at the top would read tidier and change no behaviour; the
    // reason not to is that it would put the safety in a normalization step instead of in the
    // truthiness checks that are actually load-bearing, and those are what the next reader has to
    // trust.
    const { gnl, seen } = spyGnl();
    const app = createChatRoute({ gnl }, { identity: () => ({ resourceId: '' }) });
    await post(app, { id: 'conv', messages: MSG });
    expect(seen[0]!.runId).toBe('conv:m1');
    expect(seen[0]!.workKey).toBeUndefined();
    expect(seen[0]!.resourceId, 'boş özne SAHİP olarak dondurulmaz').toBeUndefined();
  });

  it('an explicit `resolveResourceId` returning \'\' behaves identically — one rule, both hooks', async () => {
    const { gnl, seen } = spyGnl();
    const app = createChatRoute({ gnl }, { resolveResourceId: () => '', identity: () => ({ resourceId: 'u-ayse' }) });
    // The dedicated hook WINS field by field — but `??` only falls through on nullish, and `''` is
    // not nullish, so the empty answer is the route's answer. That is the documented precedence
    // working, not leaking: a host that wired the specific hook gets the specific hook.
    await post(app, { id: 'conv', messages: MSG });
    expect(seen[0]!.runId).toBe('conv:m1');
    expect(seen[0]!.resourceId).toBeUndefined();
  });
});

describe('chat route: production without any way to name a caller', () => {
  const withEnv = (value: string | undefined, fn: () => void) => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = value;
    try { fn(); } finally { process.env.NODE_ENV = prev; }
  };

  it('warns once, says what it costs and how to fix it — and does NOT throw', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { gnl } = spyGnl();
    withEnv('production', () => { expect(() => createChatRoute({ gnl })).not.toThrow(); });
    const msg = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes('chat-route'));
    expect(msg).toBeDefined();
    expect(msg).toContain('ownerless');
    expect(msg).toContain('fail-open');
    expect(msg).toContain('identity');
  });

  it('stays silent when EITHER hook is present', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { gnl } = spyGnl();
    withEnv('production', () => {
      createChatRoute({ gnl }, { identity: () => ({ resourceId: 'u' }) });
      createChatRoute({ gnl }, { resolveResourceId: () => 'u' });
    });
    expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('ownerless'))).toEqual([]);
  });

  it('stays silent outside production — development is where you have not wired auth yet', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { gnl } = spyGnl();
    withEnv('development', () => { createChatRoute({ gnl }); });
    expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('ownerless'))).toEqual([]);
  });
});
