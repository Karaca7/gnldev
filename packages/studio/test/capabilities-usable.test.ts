// "A capability the caller cannot use is not a capability" — the rule this file's own production
// comment states, checked against every capability that gates a route.
//
// `/capabilities` is what the UI builds itself from: ~35 booleans, several auto-detected from
// `typeof rw.listKeys === 'function'`, and nothing asserted that a capability reported TRUE is actually
// usable by the caller it was reported to. That gap is how `queue`/`cache`/`knowledge` came to advertise
// surfaces that answered 403, and it is checked here as a property rather than per capability:
//
//   for every capability reported `true` to a caller, the route it gates must not answer
//   501 (not enabled) or 403 (not for you) to that same caller.
//
// Driven through the HTTP surface with two real identities on one deployment, so the answer comes from
// the routes themselves rather than from re-reading the conditions that produced the booleans.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createStudioApi } from '../src/server.js';

const authProvider = {
  authenticate: (req: Request) => {
    const t = req.headers.get('authorization')?.replace('Bearer ', '');
    if (t === 'acme') return { roles: ['admin'], id: 'u-acme', orgId: 'acme' };
    if (t === 'ops') return { roles: ['admin'], id: 'u-ops' }; // unscoped operator
    return null;
  },
  authorize: () => ({ allow: true }),
  capabilities: () => ({ sso: false, rbac: false, audit: false, multiOrganization: false, users: false }),
};

/** Each capability that gates a route, and the route it gates. */
const GATED: Record<string, [method: string, path: string]> = {
  resume: ['POST', '/runs/r1/resume'],
  compensate: ['POST', '/runs/r1/compensate'],
  chat: ['POST', '/chat'],
  fork: ['POST', '/runs/r1/fork'],
  playground: ['POST', '/agents/a/run'],
  stream: ['POST', '/agents/a/stream'],
  tools: ['GET', '/tools'],
  toolExec: ['POST', '/tools/t/execute'],
  memory: ['GET', '/threads'],
  workflows: ['GET', '/workflows'],
  workflowExec: ['POST', '/workflows/w/run'],
  workflowManage: ['GET', '/workflows/w/def'],
  scorers: ['GET', '/scorers'],
  datasets: ['GET', '/datasets'],
  mcp: ['GET', '/mcp-servers'],
  a2a: ['GET', '/a2a-network'],
  queue: ['GET', '/jobs'],
  queueManage: ['POST', '/jobs/j1/retry'],
  cache: ['GET', '/cache/stats'],
  cacheManage: ['POST', '/cache/invalidate'],
  scheduler: ['GET', '/scheduler/triggers'],
  knowledge: ['POST', '/knowledge/search'],
  approvals: ['GET', '/approvals'],
  audit: ['GET', '/audit'],
  agentRegistry: ['GET', '/agents/registry'],
  processors: ['GET', '/runs/r1/processors'],
  organizations: ['GET', '/organizations'],
};

/** Everything wired, so a capability being false is never merely "the fixture forgot it". */
async function fullyConfigured() {
  const j = new InMemoryJournal();
  await j.put('org:acme:r1:model:0', { content: [{ type: 'text', text: 'x' }], finishReason: 'stop' });
  await j.put('r1:model:0', { content: [{ type: 'text', text: 'x' }], finishReason: 'stop' });
  return createStudioApi({
    reader: j, auth: authProvider, org: {},
    resume: async () => ({}), compensate: async () => ({ ok: true }), chat: { send: async () => ({ text: 'x' }) },
    scorers: { list: () => [], score: async () => ({}) },
    datasets: { list: () => [], run: async () => ({ ok: true }) },
    mcp: [{ name: 'm' }], a2a: true,
    queue: { listJobs: () => [], retry: () => 'j' },
    cache: { stats: () => ({ hits: 0, misses: 0, hitRate: 0, size: 0 }), invalidate: () => 1 },
    vectors: { search: () => [] },
    workflowStore: { list: () => [], get: () => undefined, set: () => {}, delete: () => {} },
    memory: { listThreads: () => [], getMessages: () => [] },
    gnl: {
      listAgents: () => [{ name: 'a' }], run: async () => ({ text: 'x' }),
      stream: async () => ({ textStream: (async function* () { yield 'x'; })() }),
      listTools: () => [{ name: 't' }], runTool: async () => ({ ok: true }), listWorkflows: () => [],
    },
  } as never) as unknown as (r: Request) => Promise<Response>;
}

const caps = async (api: (r: Request) => Promise<Response>, token: string) =>
  await (await api(new Request('http://x/capabilities', { headers: { authorization: `Bearer ${token}` } }))).json() as Record<string, unknown>;

async function driveCap(api: (r: Request) => Promise<Response>, token: string, cap: string) {
  const [method, path] = GATED[cap]!;
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const init: RequestInit = { method, headers };
  if (method !== 'GET') {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify({ query: 'x', message: 'h', key: 'k', input: {}, name: 'w', runId: 'r1', prompt: 'p' });
  }
  const res = await Promise.race([
    api(new Request(`http://x${path}`, init)),
    new Promise<Response>((r) => setTimeout(() => r(new Response('<<timeout>>', { status: 599 })), 3000)),
  ]);
  return { status: res.status, body: (await res.text()).slice(0, 90) };
}

/** Capabilities reported true whose route answers "not enabled" or "not for you". */
async function unusableTruths(api: (r: Request) => Promise<Response>, token: string) {
  const c = await caps(api, token);
  const out: string[] = [];
  for (const cap of Object.keys(GATED)) {
    if (c[cap] !== true) continue;
    const { status, body } = await driveCap(api, token, cap);
    if (status === 501 || status === 403) out.push(`${cap} -> ${GATED[cap]![0]} ${GATED[cap]![1]} ${status} ${body}`);
  }
  return out;
}

describe('every capability reported true is usable by the caller it was reported to', () => {
  it('the fixture reports most of them true, or this suite checks nothing', async () => {
    const api = await fullyConfigured();
    const c = await caps(api, 'ops');
    const on = Object.keys(GATED).filter((k) => c[k] === true);

    expect(on.length, 'almost nothing is enabled — the fixture is not exercising the property')
      .toBeGreaterThan(20);
  }, 30_000);

  it('for an unscoped operator', async () => {
    const api = await fullyConfigured();
    expect(await unusableTruths(api, 'ops'),
      'a capability was advertised to the operator and its route refused or disabled it').toEqual([]);
  }, 60_000);

  /**
   * FINDING — `agentRegistry` is reported `true` to an organization-bound caller, and all three routes
   * it gates are platform-admin only.
   *
   *   GET /agents/registry -> 403 "an org-bound identity cannot view the agent registry"
   *
   * `scopeRefused` does not cover it: this is not an unscopeable host object, it is platform-admin
   * gating, so the capability itself is simply untrue for this caller.
   *
   * NOT A LIVE UI DEFECT, and worth saying so plainly: `Agents.tsx:409` computes
   * `canSeeRegistry = … && !!caps.data?.agentRegistry && !me.data?.orgId && …` — the view is hidden
   * from org-bound identities by a SECOND, hand-written condition at the call site. So nobody sees a
   * 403 today.
   *
   * That compensation is the reason to report it. It is the same shape being removed everywhere else
   * in this file: a value that is wrong, plus a hand-written correction next to each consumer. There
   * is one other consumer already — `useAgentRegistry` takes an `enabled` argument that was added by
   * hand after being burned — and the next one has to remember the clause or get a 403 screen.
   */
  it('for an organization-bound caller', async () => {
    const api = await fullyConfigured();
    expect(await unusableTruths(api, 'acme'),
      'a capability was advertised to an organization-bound caller and its route refused it. `false` '
      + 'means "you cannot use this"; anything the caller cannot use must not be reported true, or every '
      + 'consumer needs its own hand-written correction.')
      .toEqual([]);
  }, 60_000);
});

/** Is this response empty in substance — nothing for a UI to show? */
function isEmptyPayload(body: string): boolean {
  let v: unknown;
  try { v = JSON.parse(body); } catch { return body.trim() === ''; }
  const empty = (x: unknown): boolean => {
    if (x == null || x === 0 || x === false || x === '') return true;
    if (Array.isArray(x)) return x.length === 0;
    if (typeof x === 'object') return Object.values(x as Record<string, unknown>).every(empty);
    return false;
  };
  return empty(v);
}

describe('and the converse: a capability reported false hides nothing', () => {
  /**
   * A `false` capability whose route still answers 200 is NOT a defect here — measured, eleven of them
   * do, and every one returns an honest empty payload (`[]`, `{"items":[]}`, zeroed cache stats). These
   * routes degrade to empty rather than erroring when their feature is absent, and the capability gates
   * a VIEW: an empty 200 is exactly what that view would render. An earlier version of this test bounded
   * the COUNT of such routes, which measured nothing and would have failed on any harmless addition.
   *
   * The property worth asserting is the one that would actually hurt: a capability reported false whose
   * route returns real CONTENT. That is a working surface the UI hides — the mirror image of the
   * finding above, and the reason to check both directions at all.
   */
  it('a route behind a false capability returns nothing to show, not hidden content', async () => {
    const bare = createStudioApi({ reader: new InMemoryJournal(), auth: authProvider, org: {} } as never) as unknown as
      (r: Request) => Promise<Response>;
    const c = await caps(bare, 'ops');

    const hiding: string[] = [];
    let checked = 0;
    for (const cap of Object.keys(GATED)) {
      if (c[cap] !== false) continue;
      const { status, body } = await driveCap(bare, 'ops', cap);
      if (status !== 200) continue;
      checked++;
      if (!isEmptyPayload(body)) hiding.push(`${cap} -> ${GATED[cap]![0]} ${GATED[cap]![1]} ${body}`);
    }

    expect(checked, 'no false capability served a 200 — the property is not being exercised').toBeGreaterThan(5);
    expect(hiding,
      'a capability is reported false while its route returns real content — the UI hides a surface '
      + 'that works, which is the same untruthfulness as advertising one that does not')
      .toEqual([]);
  }, 60_000);
});
