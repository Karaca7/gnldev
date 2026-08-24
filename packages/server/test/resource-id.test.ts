// `resourceId` — WHOSE run/thread this is — end to end over the REST surface.
//
// The gap this closes was measured, not assumed. `ThreadRecord.resourceId` is a REQUIRED field and the
// memory layer keys working memory by it (`res:<id>`), so CONVERSATIONS already had a subject while
// runs did not — and the server never let one through in the first place: it derived `resourceId` from
// `principal.id`, which a bearer token leaves undefined. Two consequences, both measured before this
// existed:
//
//   • with a bearer token, ZERO thread records were written (the memory layer only indexes a thread
//     when a resourceId is present), so `listThreads` had nothing to return for anyone;
//   • under basic auth every end user collapsed onto ONE owner — the application's own username — so
//     one shared working-memory bucket served all of them, and user B read user A's stored note.
//
// The deployment shape that makes this necessary: ONE application credential (the `client` class)
// serving many end users. There is no per-caller identity to derive a subject from, so the request
// carries it, and the credential is trusted to speak for its own users — the same trust that already
// lets it run agents at all.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { roleAuth } from '@gnldev/auth';
import { createRestApi } from '../src/index.js';

const mkModel = () => ({
  specificationVersion: 'v4' as const, provider: 'm', modelId: 'm', supportedUrls: {},
  doGenerate: async () => ({
    content: [{ type: 'text' as const, text: 'ok' }],
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
    warnings: [],
  }),
});

/**
 * A conversation store that RECORDS the subject it was handed, rather than the real @gnldev/memory.
 *
 * The boundary is deliberate: this file tests what @gnldev/server is responsible for — resolving the
 * subject and passing it down — and @gnldev/memory has its own tests for what it does with one. Using
 * the real AgentMemory here would also make the server package depend on the memory package for a
 * test, and would let a memory-side change fail a server-side suite for reasons the server does not own.
 *
 * `memoryFactory`, not `memory`: an org-scoped instance drops a shared `memory` OBJECT on purpose (one
 * store cannot carry an organization boundary), so passing an object would silently leave the
 * deployment with NO conversation store — and every assertion below would then pass vacuously against
 * a store that was never consulted. `seen` being non-empty is what rules that out.
 */
function recordingMemory() {
  const seen: Array<{ threadId: string; resourceId?: string }> = [];
  const owners = new Map<string, string>();
  const store = {
    loadContext: async (threadId: string, o?: { resourceId?: string }) => {
      seen.push({ threadId, resourceId: o?.resourceId });
      if (o?.resourceId) owners.set(threadId, o.resourceId);
      return { messages: [] as unknown[] };
    },
    append: async () => {},
    getMessages: async (threadId: string) => [{ role: 'user', content: `msg of ${threadId}` }],
    // The two OPTIONAL Memory capabilities the thread routes read. Present here because serving them
    // is those routes' whole point; their ABSENCE is covered separately (`noMemoryApi` below).
    getThreadResource: async (threadId: string) => owners.get(threadId),
    // Takes an OBJECT, and REFUSES a bare string rather than ignoring it. AgentMemory reads
    // `opts.resourceId`, so a caller passing the id directly silently asked for every thread — measured
    // in @gnldev/studio, which had spelled its own `listThreads(resourceId?: string)` type and called it
    // that way. A stub that tolerated both shapes would have let this file pass on the broken caller.
    listThreads: async (opts: { resourceId: string }) => {
      if (typeof opts !== 'object' || opts === null) throw new TypeError('listThreads takes { resourceId }, not a bare id');
      return [...owners].filter(([, r]) => r === opts.resourceId).map(([id, r]) => ({ id, resourceId: r }));
    },
    listAllThreads: async () => [...owners].map(([id, r]) => ({ id, resourceId: r })),
  };
  return { seen, factory: () => store };
}

/** The same host with NO conversation store at all — what a `memory: false` deployment serves. */
function noMemoryApi() {
  const app = createRestApi(
    { storage: new InMemoryStorage(), memory: false, agents: { a: { model: mkModel() as never } } } as never,
    { auth: roleAuth({ admin: { token: 'A', orgId: 'acme' } }) },
  );
  // The OPERATOR: what this asserts is how a store-less deployment answers, and a client would be
  // refused for naming no subject before the store's absence ever mattered.
  return (p: string) => app(new Request('http://x' + p, { headers: { authorization: 'Bearer A' } }));
}

/** An org-bound APPLICATION credential — one token serving many end users, the shape this exists for. */
function api() {
  const mem = recordingMemory();
  const app = createRestApi(
    {
      storage: new InMemoryStorage(),
      memoryFactory: mem.factory as never,
      agents: { a: { model: mkModel() as never } },
    } as never,
    // BOTH classes, because the rules under test are asymmetric BY DESIGN: a `client` acts for one end
    // user and must name it; an operator works across the organization and names nobody. A fixture with
    // only one of them can assert half the contract and read as if it asserted all of it.
    { auth: roleAuth({ client: { token: 'C', orgId: 'acme' }, admin: { token: 'A', orgId: 'acme' } }) },
  );
  const call = (tok: string) => (m: string, p: string, body?: unknown) => app(new Request('http://x' + p, {
    method: m,
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }));
  const asClient = call('C');
  const asOperator = call('A');
  return {
    run: (who: string, extra: Record<string, unknown> = {}) =>
      asClient('POST', '/agents/a/run', { runId: `r-${who}`, prompt: 'merhaba', threadId: `t-${who}`, resourceId: `u-${who}`, ...extra }),
    /** A run with NO owner — only an operator can start one, since a client must always name a subject. */
    runUnowned: (id: string) => asOperator('POST', '/agents/a/run', { runId: id, prompt: 'merhaba', threadId: `t-${id}` }),
    get: (p: string) => asClient('GET', p),
    post: (p: string, body?: unknown) => asClient('POST', p, body),
    /** The operator view: permitted to leave the subject unstated. */
    getOp: (p: string) => asOperator('GET', p),
    postOp: (p: string, body?: unknown) => asOperator('POST', p, body),
    seen: mem.seen,
  };
}

describe('resourceId: whose run/thread this is', () => {
  it('a request-supplied resourceId reaches the memory layer — and separates two end users', async () => {
    const { run, seen } = api();
    expect((await run('ayse')).status).toBe(200);
    expect((await run('mehmet')).status).toBe(200);

    // The distinguishing assertion: the store was consulted twice AND with DIFFERENT subjects. The
    // behaviour this replaced satisfied a count check and failed this one — every end user arrived as
    // the same owner (the application's own username), so they shared one working-memory bucket.
    expect(seen.map((s) => [s.threadId, s.resourceId])).toEqual([
      ['t-ayse', 'u-ayse'],
      ['t-mehmet', 'u-mehmet'],
    ]);
  });

  it('the run itself records its owner, and /runs filters by it', async () => {
    const { run, get, getOp } = api();
    await run('ayse');
    await run('mehmet');

    const all = await (await getOp('/runs')).json();
    expect(all.map((r: { runId: string; resourceId?: string }) => [r.runId, r.resourceId]).sort())
      .toEqual([['r-ayse', 'u-ayse'], ['r-mehmet', 'u-mehmet']]);

    const mine = await (await get('/runs?resourceId=u-ayse')).json();
    expect(mine.items.map((r: { runId: string }) => r.runId)).toEqual(['r-ayse']);
  });

  it('?resourceId= on a single run is a CHECK: a mismatch is refused', async () => {
    const { run, get, getOp } = api();
    await run('ayse');
    expect((await getOp('/runs/r-ayse')).status).toBe(200);                      // operator: may state nothing
    expect((await get('/runs/r-ayse')).status).toBe(400);                        // client: must name a subject
    expect((await get('/runs/r-ayse?resourceId=u-ayse')).status).toBe(200);      // stated, and correct
    expect((await get('/runs/r-ayse?resourceId=u-mehmet')).status).toBe(403);    // stated, and wrong
  });

  it('the refusal names neither the real owner nor whether the run exists', async () => {
    const { run, get } = api();
    await run('ayse');
    const body = await (await get('/runs/r-ayse?resourceId=u-mehmet')).json();
    expect(JSON.stringify(body)).not.toContain('u-ayse');
  });

  it('a run with NO owner is readable under any expectation — absence is not a denial', async () => {
    // Runs predating this field, and single-operator deployments that never set one, have no subject
    // to compare against. Refusing them would break existing callers to protect data with no owner.
    const { runUnowned, get } = api();
    await runUnowned('r-anon');
    expect((await get('/runs/r-anon?resourceId=whoever')).status).toBe(200);
  });

  it('an INVALID resourceId is a 400, never a silent drop', async () => {
    // A caller that sent one believes its data is scoped. Dropping it quietly hands back exactly the
    // one-shared-bucket behaviour this feature exists to end, while the caller thinks it asked for
    // separation — the failure is invisible precisely where it matters.
    const { run } = api();
    for (const [value, why] of [[123, 'not a string'], ['', 'empty'], ['x'.repeat(201), 'too long'], ['a\u0000b', 'control character']] as const) {
      const res = await run('bad', { resourceId: value });
      expect(res.status, `expected 400 for a resourceId that is ${why}`).toBe(400);
    }
  });

  it('a per-caller identity WINS over the body — a bound user cannot name someone else', async () => {
    // The other deployment shape: basic auth (or @gnldev/auth-ee) binds an identity per caller, so
    // `principal.id` IS the subject. Letting a body field override it would let any authenticated user
    // read any other user's memory by naming them.
    const mem = recordingMemory();
    const app = createRestApi(
      {
        storage: new InMemoryStorage(),
        memoryFactory: mem.factory as never,
        agents: { a: { model: mkModel() as never } },
      } as never,
      { auth: roleAuth({ client: { user: 'ayse', pass: 'p', orgId: 'acme' } }) },
    );
    const res = await app(new Request('http://x/agents/a/run', {
      method: 'POST',
      headers: { authorization: 'Basic ' + Buffer.from('ayse:p').toString('base64'), 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'r1', prompt: 'x', threadId: 't1', resourceId: 'u-mehmet' }),
    }));
    expect(res.status).toBe(200);
    expect(mem.seen[0]!.resourceId).toBe('ayse'); // the bound identity, NOT the body's claim
  });
});

describe('resourceId: the WRITE paths honour the same expectation', () => {
  // The read check landed first and the write paths were left without one — measured: cancelling AND
  // resuming another end user's run both answered 200 while naming the wrong owner. `resume` is where
  // it matters most: its body carries `approvals`, the field that decides a tool call a human gate had
  // stopped, so the path left open was the one where being wrong costs the most.

  it('cancelling a run you named the wrong owner for is refused', async () => {
    const { run, post } = api();
    await run('ayse');
    expect((await post('/runs/r-ayse/cancel?resourceId=u-ayse')).status).toBe(200);
    expect((await post('/runs/r-ayse/cancel?resourceId=u-mehmet')).status).toBe(403);
  });

  it('resuming another end user run is refused — stated in the query OR in the body', async () => {
    const { run, post, postOp } = api();
    await run('ayse');
    expect((await post('/agents/a/resume?resourceId=u-mehmet', { runId: 'r-ayse' })).status).toBe(403);
    // Also from the body, which is where a JSON caller naturally puts it. An implementation reading
    // only the query passes the line above and fails this one.
    expect((await post('/agents/a/resume', { runId: 'r-ayse', resourceId: 'u-mehmet' })).status).toBe(403);
    expect((await post('/agents/a/resume', { runId: 'r-ayse', resourceId: 'u-ayse' })).status).toBe(200);
    // Unstated is the OPERATOR's privilege; a client naming nobody is refused before anything else.
    expect((await postOp('/agents/a/resume', { runId: 'r-ayse' })).status).toBe(200);
    expect((await post('/agents/a/resume', { runId: 'r-ayse' })).status).toBe(400);
  });

  it('a resume never re-owns the run: the FROZEN owner is what reaches memory', async () => {
    // The other half of the same property. Even a resume that states nothing must load the ORIGINAL
    // subject's context — deriving it from the resuming caller would let the second half of one
    // conversation belong to someone else.
    const { run, postOp, seen } = api();
    await run('ayse');
    seen.length = 0;
    await postOp('/agents/a/resume', { runId: 'r-ayse' });
    expect(seen.map((x) => x.resourceId)).toEqual(['u-ayse']);
  });
});

describe('thread reads on the REST surface', () => {
  // The data was always written; only @gnldev/studio had routes to it, so the API a customer's backend
  // talks to could create a user's threads and never list them back.

  it('GET /threads lists them, and ?resourceId= narrows to one end user', async () => {
    const { run, get, getOp } = api();
    await run('ayse');
    await run('mehmet');
    expect(await (await getOp('/threads')).json()).toHaveLength(2);   // operator: the whole org
    expect(await (await get('/threads?resourceId=u-ayse')).json()).toEqual([{ id: 't-ayse', resourceId: 'u-ayse' }]);
    expect((await get('/threads')).status).toBe(400);                 // client: must name a subject
  });

  it('GET /threads/:id/messages CHECKS the owner rather than filtering', async () => {
    const { run, get, getOp } = api();
    await run('ayse');
    expect((await getOp('/threads/t-ayse/messages')).status).toBe(200);                   // operator, unstated
    expect((await get('/threads/t-ayse/messages?resourceId=u-ayse')).status).toBe(200);   // correct
    expect((await get('/threads/t-ayse/messages?resourceId=u-mehmet')).status).toBe(403); // wrong
  });

  it('a deployment with no conversation store answers empty, not an error', async () => {
    // "This deployment keeps no conversations" and "this user has none" are the same answer to the
    // caller; a 404/501 would make every client branch on a distinction it cannot act on.
    const get = noMemoryApi();
    expect((await get('/threads')).status).toBe(200);
    expect(await (await get('/threads')).json()).toEqual([]);
    expect(await (await get('/threads/t-x/messages')).json()).toEqual([]);
  });
});

describe('the thread-listing call SHAPE', () => {
  it('a filtered list asks for ONE resource, not for everything', async () => {
    // The regression this pins: `listThreads` is called with `{ resourceId }` and the unfiltered view
    // is a DIFFERENT method. Collapsed into one method taking an optional string, the filter reached
    // AgentMemory as `undefined` and the route answered with every user's threads while looking
    // filtered. The stub throws on the wrong shape, so a caller that regresses fails here loudly.
    const { run, get, getOp } = api();
    await run('ayse');
    await run('mehmet');
    const filtered = await (await get('/threads?resourceId=u-ayse')).json();
    expect(filtered).toEqual([{ id: 't-ayse', resourceId: 'u-ayse' }]);
    expect(await (await getOp('/threads')).json()).toHaveLength(2); // the operator's unfiltered view
  });
});

describe('a thread belongs to ONE end user, on the write paths too', () => {
  // The read route refused a foreign thread from the day it was written; the write paths did not, and
  // the gap was measured rather than imagined: Mallory posted `{ threadId: 't-ayse', resourceId:
  // 'u-mallory' }` to /agents/:name/run and the prompt handed to the model was Ayşe's history verbatim.
  // Worse than disclosure — the turn is appended to that thread, so the next reader of Ayşe's own
  // conversation finds a stranger's message inside it.
  //
  // 3645 tests passed over it. The conformance walk that exists to stop exactly this drove every route
  // with a subject-LESS client and proved a subject is required; it never once paired a VALID subject
  // with a thread belonging to someone else. That missing axis is what these tests are.

  it('naming another end user\'s thread is refused on /run', async () => {
    const { run, post } = api();
    await run('ayse');                                    // creates t-ayse, owned by u-ayse
    const res = await post('/agents/a/run', { runId: 'r-x', prompt: 'what did I say?', threadId: 't-ayse', resourceId: 'u-mallory' });
    expect(res.status).toBe(403);
  });

  it('and the refusal keeps the stranger out of the conversation, not just out of the answer', async () => {
    // The distinguishing assertion. A route that answered 403 AFTER loading the thread would satisfy
    // the status check above and still have leaked Ayşe's history into the model — and appended
    // Mallory's turn on the way through. `seen` is what the memory layer was actually asked for.
    const { run, post, seen } = api();
    await run('ayse');
    seen.length = 0;
    await post('/agents/a/run', { runId: 'r-x', prompt: 'what did I say?', threadId: 't-ayse', resourceId: 'u-mallory' });
    expect(seen, 'the store was consulted for a thread the caller does not own').toEqual([]);
  });

  it('the owner reaches their own thread, and a NEW thread is not refused', async () => {
    // The other half: a check that refused everything would pass every assertion above. A first turn
    // creates the thread, so an unknown owner must be allowed — otherwise no conversation can start.
    const { run, post } = api();
    await run('ayse');
    expect((await post('/agents/a/run', { runId: 'r-2', prompt: 'again', threadId: 't-ayse', resourceId: 'u-ayse' })).status).toBe(200);
    expect((await post('/agents/a/run', { runId: 'r-3', prompt: 'hello', threadId: 't-brand-new', resourceId: 'u-mallory' })).status).toBe(200);
  });

  it('an OPERATOR may name any thread — it works across the organization by design', async () => {
    const { run, postOp } = api();
    await run('ayse');
    expect((await postOp('/agents/a/run', { runId: 'r-op', prompt: 'inspecting', threadId: 't-ayse' })).status).toBe(200);
  });

  it('/stream enforces it too — the sibling route is where this kind of gap survives', async () => {
    const { run, post } = api();
    await run('ayse');
    expect((await post('/agents/a/stream', { runId: 'r-s', prompt: 'x', threadId: 't-ayse', resourceId: 'u-mallory' })).status).toBe(403);
  });

  it('the refusal names neither the owner nor whether the thread exists', async () => {
    const { run, post } = api();
    await run('ayse');
    const body = await (await post('/agents/a/run', { runId: 'r-x', prompt: 'x', threadId: 't-ayse', resourceId: 'u-mallory' })).json();
    expect(JSON.stringify(body)).not.toContain('u-ayse');
  });
});

