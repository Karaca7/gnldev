// ONE hook for "who is this" — `identify`, the same function every door takes — and what happens in
// production without it.
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
import type { Principal } from '@gnldev/auth';
import { createChatRoute } from '../src/chat-route.js';

const subject = (id: string, orgId?: string): Principal => ({ kind: 'subject', id, roles: [], ...(orgId ? { orgId } : {}) });

/** Captures what actually reached the run — the route's contract, without descending into the engine. */
function spyGnl() {
  // `workKey` is here because it is how the two REGIMES are told apart from outside: the route hands
  // the door a NAME (promoted) or an ID (raw), never both, and which one it chose is the whole
  // question the regime tests below ask.
  const seen: { runId?: string; workKey?: string; threadId?: string; resourceId?: string; caller?: unknown }[] = [];
  return {
    seen,
    gnl: {
      agent: () => ({}),
      stream: async (_name: string, opts: any) => {
        seen.push({ runId: opts.runId, workKey: opts.workKey, threadId: opts.threadId, resourceId: opts.context?.__gnl_resourceId, caller: opts.caller });
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

describe('chat route: the single `identify` hook', () => {
  it('hands the engine the caller the principal maps to — and seals the same one', async () => {
    const { gnl, seen } = spyGnl();
    const app = createChatRoute({ gnl }, { identify: () => subject('ayse') });
    await post(app, { id: 'conv', runId: 'r1', messages: MSG });
    expect(seen[0]).toMatchObject({ resourceId: 'ayse', caller: { kind: 'user', id: 'ayse' } });
  });

  it('is called ONCE per request — two calls can disagree', async () => {
    // The same reason the route already resolves `subject` once: a resolver that reads the request
    // is a function of the request, and nothing promises it is a pure one.
    let calls = 0;
    const { gnl } = spyGnl();
    const app = createChatRoute({ gnl }, { identify: () => { calls++; return subject(`u${calls}`); } });
    await post(app, { id: 'conv', runId: 'r1', messages: MSG });
    expect(calls).toBe(1);
  });

  it('receives the web Request, not the Hono context — an Express bridge has one and not the other', async () => {
    const { gnl } = spyGnl();
    let seenReq: unknown;
    const app = createChatRoute({ gnl }, { identify: (req) => { seenReq = req; return subject(req.headers.get('x-user') ?? 'nobody'); } });
    await post(app, { id: 'conv', runId: 'r1', messages: MSG }, { 'x-user': 'from-header' });
    expect(seenReq).toBeInstanceOf(Request);
  });

  it('`resolveThreadId` picks the thread; the subject comes from `identify` alone', async () => {
    const { gnl, seen } = spyGnl();
    const app = createChatRoute(
      { gnl },
      {
        identify: () => subject('from-identify'),
        resolveThreadId: () => 'from-resolver',
      },
    );
    await post(app, { id: 'conv', runId: 'r1', messages: MSG });
    expect(seen[0]).toMatchObject({ resourceId: 'from-identify', threadId: 'from-resolver' });
  });

  it('the removed `resolveResourceId` is refused at construction, not silently ignored', () => {
    const { gnl } = spyGnl();
    expect(() => createChatRoute({ gnl }, { resolveResourceId: () => 'u' } as never)).toThrow(/resolveResourceId.*removed.*identify/s);
  });

  it('the replaced `identity` is refused at construction — it could not say "staff"', () => {
    const { gnl } = spyGnl();
    expect(() => createChatRoute({ gnl }, { identity: () => ({ resourceId: 'u' }) } as never)).toThrow(/`identity` was replaced by `identify`/);
  });

  it('a user naming someone in the body names nobody — the body is read for an application only', async () => {
    const { gnl, seen } = spyGnl();
    const app = createChatRoute({ gnl }, { identify: () => subject('mallory') });
    await post(app, { id: 'conv', runId: 'r1', resourceId: 'ayse', messages: MSG });
    expect(seen[0]).toMatchObject({ resourceId: 'mallory', caller: { kind: 'user', id: 'mallory' } });
  });

  it('an application is the user it names; naming nobody is a 400 and nothing runs', async () => {
    const { gnl, seen } = spyGnl();
    const app = createChatRoute({ gnl }, { identify: () => ({ kind: 'application', id: 'backend', roles: [], orgId: 'acme' }) });
    const refused = await post(app, { id: 'conv', runId: 'r1', messages: MSG });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: expect.stringMatching(/resourceId is required/) });
    expect(seen).toHaveLength(0);
    // A prebuilt `{ gnl }` refuses an org-bound caller, so this one is org-free.
    const app2 = createChatRoute({ gnl }, { identify: () => ({ kind: 'application', id: 'backend', roles: [] }) });
    await post(app2, { id: 'conv', runId: 'r1', resourceId: 'ayse', messages: MSG });
    expect(seen[0]).toMatchObject({ resourceId: 'ayse', caller: { kind: 'user', id: 'ayse' } });
  });

  it('an operator is staff: sealed as staff, named nobody', async () => {
    const { gnl, seen } = spyGnl();
    const app = createChatRoute({ gnl }, { identify: () => ({ kind: 'operator', id: 'ops', roles: ['admin'] }) });
    await post(app, { id: 'conv', runId: 'r1', resourceId: 'ayse', messages: MSG });
    expect(seen[0]).toMatchObject({ caller: { kind: 'staff' } });
    expect(seen[0]!.resourceId).toBeUndefined();
  });

  it('an identify that answers nothing is unknown — closed, not staff', async () => {
    const { gnl, seen } = spyGnl();
    const app = createChatRoute({ gnl }, { identify: () => undefined });
    await post(app, { id: 'conv', runId: 'r1', messages: MSG });
    expect(seen[0]!.resourceId).toBeUndefined();
    expect(seen[0]!.caller).toEqual({ kind: 'unknown' });
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
  it('`identify: () => undefined` keeps the turn key RAW — the quickstart is not a 400', async () => {
    // The concession package #5 made on purpose: deriving needs an address, this route ships with no
    // auth, and a `useChat` demo names nobody. So the derived string stays what it has been since
    // FAZ-1 — a raw id — and the first five minutes keep working.
    const { gnl, seen } = spyGnl();
    const app = createChatRoute({ gnl }, { identify: () => undefined });
    await post(app, { id: 'conv', messages: MSG });
    expect(seen[0]!.runId, 'ham rejim: turun adı id olarak geçer').toBe('conv:m1');
    expect(seen[0]!.workKey, 'terfi YOK — adres yok').toBeUndefined();
  });

  it('a NAMED subject promotes the same turn key — the only thing that moved is the address', async () => {
    const { gnl, seen } = spyGnl();
    const app = createChatRoute({ gnl }, { identify: () => subject('u-ayse') });
    await post(app, { id: 'conv', messages: MSG });
    expect(seen[0]!.workKey).toBe('conv:m1');
    expect(seen[0]!.runId, 'kapıya AD verilir, id değil — ikisi birden asla').toBeUndefined();
  });

  it('a subject with `id: \'\'` is NOT a user — it falls to the raw regime and asserts no owner', async () => {
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
    const app = createChatRoute({ gnl }, { identify: () => subject('') });
    await post(app, { id: 'conv', messages: MSG });
    expect(seen[0]!.runId).toBe('conv:m1');
    expect(seen[0]!.workKey).toBeUndefined();
    expect(seen[0]!.resourceId, 'boş özne SAHİP olarak dondurulmaz').toBeUndefined();
  });

});

describe('chat route: production without any way to name a caller', () => {
  const withEnv = (value: string | undefined, fn: () => void) => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = value;
    try { fn(); } finally { process.env.NODE_ENV = prev; }
  };

  it('refuses to start, and says what to do instead', () => {
    // It used to warn and serve: with no identity every caller ran the model and left an ownerless
    // run, which (since ownerless records are staff's) no user could even see afterwards.
    const { gnl } = spyGnl();
    withEnv('production', () => {
      expect(() => createChatRoute({ gnl })).toThrow(/no `identify` in production.*surfaces: \[chatSurface\(\)\]/s);
    });
  });

  it('an explicit `identify: () => undefined` is the way to say "no per-user identity here"', () => {
    const { gnl } = spyGnl();
    withEnv('production', () => { expect(() => createChatRoute({ gnl }, { identify: () => undefined })).not.toThrow(); });
  });

  it('stays silent when `identify` is present', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { gnl } = spyGnl();
    withEnv('production', () => {
      createChatRoute({ gnl }, { identify: () => subject('u') });
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
