// Endpoints backed by a host object with no organization boundary, seen from an org-bound identity.
//
// `roleAuth({ admin: { token, orgId } })` binds an organization to an identity with no `org` option at
// all — documented as first-class — and it is the configuration these refusals fire under. Four
// separable claims are pinned here, each of which has already been wrong once:
//
//   1. the refusal is MACHINE-READABLE (`code: 'org_scope_refused'`), because the UI treats an
//      unlabelled 403 as a bad token and signs the user out;
//   2. `GET /capabilities` answers for the CALLING IDENTITY — a capability the caller cannot use is
//      not a capability. The strong form of that is asserted directly: for every surface the endpoint
//      advertises, the endpoint behind it must not answer a scope refusal;
//   3. the workflow store is reachable only through the per-request accessor, so the three routes that
//      RUN a managed workflow are gated like the routes that read it — the hole that returned another
//      tenant's prompt template verbatim from a dry run;
//   4. `orgScoped: true` is honoured, and an unscoped operator is refused nothing (backward
//      compatibility for every single-tenant deployment, which is all of them today).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { roleAuth } from '@gnldev/auth';
import { createStudioApi, type WorkflowDef } from '../src/server.js';
import { compileManagedWorkflow } from '../src/managed-workflow.js';
import { call } from './call.js';

const SECRET_PROMPT = 'ACME-CONFIDENTIAL-TEMPLATE {{input}}';

/** Host objects with their own stores behind them. `orgScoped` is opt-in, exactly as a host sets it. */
function hosts(orgScoped = false) {
  const flag = orgScoped ? { orgScoped: true } : {};
  const defs = new Map<string, WorkflowDef>([
    ['m1', { name: 'm1', description: 'managed', steps: [{ id: 's1', agentName: 'writer', prompt: SECRET_PROMPT }] }],
  ]);
  return {
    queue: { ...flag, listJobs: () => [{ id: 'j1', type: 't', status: 'failed', attempts: 1 }], retry: () => 'j2' },
    cache: { ...flag, stats: () => ({ hits: 1, misses: 1, hitRate: 0.5, size: 2 }), invalidate: () => 1 },
    vectors: { ...flag, search: () => [{ id: 'v1', text: 'ACME-CONFIDENTIAL-CHUNK', score: 1 }] },
    workflowStore: {
      ...flag,
      list: () => [...defs.values()],
      get: (n: string) => defs.get(n),
      set: (d: WorkflowDef) => { defs.set(d.name, d); },
      delete: (n: string) => { defs.delete(n); },
    },
  };
}

/** A host memory object — the one conversation-store shape that cannot be given a boundary. */
const hostMemory = () => ({
  listThreads: () => [{ id: 't1' }],
  getMessages: () => [{ role: 'user', content: 'ACME-CONFIDENTIAL-MESSAGE' }],
});

/**
 * Both callers are ADMINS — the org-bound one differs only by `orgId`. Using a viewer for the
 * unscoped side would have made every write 403 for an unrelated reason and quietly turned the
 * backward-compatibility half of this file into a tautology.
 */
function makeApp(opts: { orgScoped?: boolean; orgBound?: boolean; org?: boolean } = {}) {
  const h = hosts(opts.orgScoped);
  return createStudioApi({
    reader: new InMemoryJournal(),
    auth: roleAuth({ admin: { token: 'tok', ...(opts.orgBound === false ? {} : { orgId: 'acme' }) } }) as never,
    ...(opts.org ? { org: {} } : {}),
    gnl: {
      listAgents: () => [{ name: 'writer' }],
      run: async () => ({ text: 'REAL' }),
      stream: async () => ({ textStream: (async function* () { yield 'REAL'; })() }),
      listWorkflows: () => [],
    },
    compileWorkflow: compileManagedWorkflow,
    memory: hostMemory(),
    ...h,
  } as never);
}

const AUTH = { authorization: 'Bearer tok' };
/** The same admin token, once bound to an organization and once not. */
const orgApp = (o: { orgScoped?: boolean } = {}) => makeApp({ ...o, orgBound: true });
const operatorApp = (o: { orgScoped?: boolean } = {}) => makeApp({ ...o, orgBound: false });
const ORG = AUTH;
const OPERATOR = AUTH;

const get = (app: any, path: string, headers: Record<string, string>) => call(app, path, { headers });
const post = (app: any, path: string, body: unknown, headers: Record<string, string>) =>
  call(app, path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

/** The endpoints that READ or WRITE the managed store, plus the other three host objects. */
const READ_REFUSING: Array<[what: string, label: string, send: (app: any, h: Record<string, string>) => Promise<Response>]> = [
  ['queue', 'GET /jobs', (a, h) => get(a, '/jobs', h)],
  ['queue', 'POST /jobs/j1/retry', (a, h) => post(a, '/jobs/j1/retry', {}, h)],
  ['cache', 'GET /cache/stats', (a, h) => get(a, '/cache/stats', h)],
  ['cache', 'POST /cache/invalidate', (a, h) => post(a, '/cache/invalidate', {}, h)],
  ['vectors', 'POST /knowledge/search', (a, h) => post(a, '/knowledge/search', { query: 'x' }, h)],
  ['workflowStore', 'GET /workflows/m1/def', (a, h) => get(a, '/workflows/m1/def', h)],
  ['workflowStore', 'PUT /workflows/m1', (a, h) => call(a, '/workflows/m1', { method: 'PUT', headers: { 'content-type': 'application/json', ...h }, body: '{}' })],
  ['workflowStore', 'DELETE /workflows/m1', (a, h) => call(a, '/workflows/m1', { method: 'DELETE', headers: h })],
];

/**
 * The routes that RUN a managed workflow, or that need its step order.
 *
 * These used to answer 404. `wfStoreFor` returns `undefined` both when there is no store and when
 * this caller may not reach one, and the run routes read the second as the first. Nothing leaked, but
 * the answer was the opposite of the truth in the way that matters to whoever has to fix it: "this
 * deployment's workflow store has no organization boundary" is a fact about the CONFIGURATION that an
 * operator must act on, while "no such workflow" is a fact about the request that invites the caller
 * to try a different name. It was also not something the server was in a position to claim — it could
 * not look in the store, so it could not know whether the workflow is in there.
 *
 * They now answer the same coded 403 as the read routes, which is why they are part of the same list
 * below rather than a group of their own. The separate block further down pins the specific
 * regression: falling back to 404 again.
 */
const RUN_ROUTES: Array<[label: string, send: (app: any, h: Record<string, string>) => Promise<Response>]> = [
  ['POST /workflows/m1/run', (a, h) => post(a, '/workflows/m1/run', { input: 'x' }, h)],
  ['POST /workflows/m1/run (dryRun)', (a, h) => post(a, '/workflows/m1/run', { input: 'x', dryRun: true, runId: 'dry-1' }, h)],
  ['POST /workflows/m1/run-stream', (a, h) => post(a, '/workflows/m1/run-stream', { input: 'x', runId: 'ws-1' }, h)],
  ['POST /workflows/m1/runs/r1/fork', (a, h) => post(a, '/workflows/m1/runs/r1/fork', { upto: 1 }, h)],
];

/** Every endpoint whose answer depends on a host object with no organization boundary. */
const REFUSING: Array<[what: string, label: string, send: (app: any, h: Record<string, string>) => Promise<Response>]> = [
  ...READ_REFUSING,
  ...RUN_ROUTES.map(([label, send]) => ['workflowStore', label, send] as [string, string, typeof send]),
];

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

describe('an organization-bound identity on an unscopeable host object', () => {
  it.each(REFUSING)('%s — %s is refused with a machine-readable code', async (_what, _label, send) => {
    const res = await send(orgApp(), ORG);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code, 'an unlabelled 403 is read by the UI as a bad token, and the caller is signed out')
      .toBe('org_scope_refused');
    expect(String(body.error), 'the refusal does not say what to do instead').toMatch(/orgScoped|omit `workflowStore`/);
  });

  // The leak this was written for: the refusal reached list/def/CRUD and missed the routes that RUN
  // the workflow, so `GET /def` answered 403 and `POST /run` answered 200 with the other tenant's
  // prompt template in the dry-run output. It must still leak nothing — the status is now pinned
  // above, so this half stays about the BODY.
  it.each(RUN_ROUTES)('%s leaks no part of the definition it refused to read', async (_label, send) => {
    const res = await send(orgApp(), ORG);
    const text = await res.text();
    expect(text, 'the workflow definition came back in the run output').not.toContain('ACME-CONFIDENTIAL-TEMPLATE');
    expect(text, 'the run reached the real engine').not.toContain('REAL');
    expect(text, 'the refusal named a step of a workflow this caller may not see').not.toContain('s1');
  });

  // The specific regression, named: these routes fall through to their own "workflow not found", and
  // the refusal is a guard placed immediately before it. Removing that guard restores a 404 — which is
  // both a different answer from the read routes for the same cause, and a claim the server cannot
  // support, since it could not look in the store. `not.toBe(200)` does not see this; only the exact
  // status does.
  it.each(RUN_ROUTES)('%s answers the refusal, not "workflow not found"', async (_label, send) => {
    const res = await send(orgApp(), ORG);
    expect(res.status, 'a configuration fault was reported as a missing workflow').toBe(403);
    expect(res.status).not.toBe(404);
    const body = await res.json();
    expect(body.code).toBe('org_scope_refused');
    expect(String(body.error), 'the operator is not told what to change')
      .toMatch(/omit `workflowStore`/);
    expect(String(body.error), 'the refusal does not say why it refused').toMatch(/organization/i);
  });

  // A workflow that genuinely is not in the store must still be a 404, or the new refusal has simply
  // swallowed the honest answer for every caller.
  it('still answers 404 for a workflow that really is absent', async () => {
    const res = await post(operatorApp(), '/workflows/does-not-exist/run', { input: 'x' }, OPERATOR);
    expect(res.status, 'every unknown workflow name now reports a scope problem').toBe(404);
  });

  // And a deployment with no managed store at all is not a scope problem either.
  it('answers 404, not a refusal, when there is no workflow store to refuse', async () => {
    const app = createStudioApi({
      reader: new InMemoryJournal(),
      auth: roleAuth({ admin: { token: 'tok', orgId: 'acme' } }) as never,
      gnl: { listAgents: () => [], run: async () => ({ text: 'x' }), runWorkflow: async () => ({ runId: 'r', steps: [] }), listWorkflows: () => [] },
    } as never);

    const res = await post(app, '/workflows/m1/run', { input: 'x' }, ORG);
    expect(res.status, 'a deployment with no managed store reports a boundary problem it cannot have').toBe(404);
  });

  // The operator signal, which is the reason the code path exists at all.
  it('warns the operator when a workflow RUN is turned away', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await post(orgApp(), '/workflows/m1/run', { input: 'x' }, ORG);
    expect(warn.mock.calls.flat().filter((m) => String(m).includes('`workflowStore`')),
      'a run was silently turned away with nothing said').toHaveLength(1);
  });

  // Refusing the whole listing would take the code-defined workflows away over an unrelated option,
  // so the route stays 200 — but it must not carry the managed definitions.
  it('gets a workflow listing with the managed definitions removed, not a 403', async () => {
    const res = await get(orgApp(), '/workflows', ORG);
    expect(res.status).toBe(200);
    const list = await res.json();
    expect(list.find((w: any) => w.name === 'm1'), 'a managed workflow from an unscopeable store was listed').toBeUndefined();
  });

  // The conversation store has its own, older refusal; it must carry the same code.
  it('is refused on the conversation store with the same code', async () => {
    const res = await get(orgApp(), '/threads', ORG);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('org_scope_refused');
  });
});

describe('an unscoped operator', () => {
  // Backward compatibility. Nothing about these refusals may reach a deployment that has no
  // organizations — which is every deployment that has not opted in.
  it.each(REFUSING)('%s — %s is served (%#)', async (_what, _label, send) => {
    const res = await send(operatorApp(), OPERATOR);
    expect(res.status, 'a single-tenant operator was refused a surface that has nothing to isolate from')
      .not.toBe(403);
  });
});

describe('a host object that declares `orgScoped: true`', () => {
  it.each(REFUSING)('%s — %s is served to the org-bound identity (%#)', async (_what, _label, send) => {
    const res = await send(orgApp({ orgScoped: true }), ORG);
    expect(res.status, 'the host said it honours the organization it is handed and was refused anyway')
      .not.toBe(403);
  });
});

describe('GET /capabilities', () => {
  const caps = async (app: any, headers: Record<string, string>) => (await get(app, '/capabilities', headers)).json();

  // The endpoint the UI builds itself from. It kept advertising every surface that had just started
  // refusing, so the nav offered pages that 403 and the pollers behind them 403ed on a timer.
  it('reports the surfaces behind unscopeable objects as false to an org-bound identity', async () => {
    const c = await caps(orgApp(), ORG);
    for (const k of ['knowledge', 'queue', 'queueManage', 'cache', 'cacheManage', 'workflowManage', 'memory']) {
      expect(c[k], `capabilities.${k} is advertised to a caller every one of whose requests is refused`).toBe(false);
    }
  });

  it('reports them as true to an unscoped operator', async () => {
    const c = await caps(operatorApp(), OPERATOR);
    for (const k of ['knowledge', 'queue', 'queueManage', 'cache', 'cacheManage', 'workflowManage', 'memory']) {
      expect(c[k], `capabilities.${k} went false for a caller who is refused nothing`).toBe(true);
    }
  });

  it('reports them as true to an org-bound identity when the host declares `orgScoped: true`', async () => {
    const c = await caps(orgApp({ orgScoped: true }), ORG);
    for (const k of ['knowledge', 'queue', 'cache', 'workflowManage']) expect(c[k]).toBe(true);
  });

  // The strong form, and the one a per-key list cannot fake: whatever the endpoint advertises, the
  // surface behind it must actually answer. This stays true if a fifth host object is added and its
  // capability line is forgotten.
  it('advertises nothing that the endpoint behind it refuses', async () => {
    const app = orgApp();
    const c = await caps(app, ORG);
    const capOf: Record<string, string> = { queue: 'queue', cache: 'cache', vectors: 'knowledge', workflowStore: 'workflowManage' };

    for (const [what, label, send] of REFUSING) {
      const res = await send(app, ORG);
      if (res.status === 403 && (await res.clone().json()).code === 'org_scope_refused') {
        expect(c[capOf[what]!], `${label} refuses this caller while capabilities.${capOf[what]} says it is available`).toBe(false);
      }
    }
  });

  // Capabilities is public and exempt from the read gate — it must still answer per-identity, not
  // fall back to the deployment's view because no principal was resolved on the exempt path.
  it('is not an unauthenticated leak of the deployment\'s view', async () => {
    const c = await caps(orgApp(), ORG);
    expect(c.memory).toBe(false);
  });
});

describe('an agent run that names a thread', () => {
  let n = 0;
  const runBody = (threadId?: unknown) => ({ runId: `pg-${n++}`, prompt: 'hi', ...(threadId !== undefined ? { threadId } : {}) });

  it('is refused when the conversation store cannot be scoped', async () => {
    const res = await post(orgApp(), '/agents/writer/run', runBody('t1'), ORG);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('org_scope_refused');
  });

  it('is refused on the stream endpoint too', async () => {
    const res = await post(orgApp(), '/agents/writer/stream', runBody('t1'), ORG);
    expect(res.status).toBe(403);
  });

  // A run that names no thread touches no conversation store. Refusing it made the whole Playground
  // unusable for an org-bound admin rather than just its thread list.
  it('is NOT refused when no thread is named', async () => {
    const res = await post(orgApp(), '/agents/writer/run', runBody(), ORG);
    expect(res.status, 'an agent run that reaches no store was refused').not.toBe(403);
  });

  // An empty string names no thread — `runDurable` gates every memory read and write on a truthy
  // threadId, so a falsy id is inert.
  it('is NOT refused for an empty thread id', async () => {
    const res = await post(orgApp(), '/agents/writer/run', runBody(''), ORG);
    expect(res.status, 'an inert threadId was treated as reaching the store').not.toBe(403);
  });

  it('is NOT refused for an explicit null thread id', async () => {
    const res = await post(orgApp(), '/agents/writer/run', runBody(null), ORG);
    expect(res.status).not.toBe(403);
  });
});

describe('the operator warning', () => {
  it('is printed when a caller is actually refused, once per object', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = orgApp();

    await get(app, '/cache/stats', ORG);
    await get(app, '/cache/stats', ORG);
    await get(app, '/cache/stats', ORG);
    const cacheWarnings = warn.mock.calls.flat().filter((m) => String(m).includes('`cache`'));
    expect(cacheWarnings, 'the operator is warned on every refusal — a 5s poller fills the log').toHaveLength(1);

    await get(app, '/jobs', ORG);
    expect(warn.mock.calls.flat().filter((m) => String(m).includes('`queue`')),
      'the second object never got its own warning').toHaveLength(1);
  });

  it('is not printed at all when nothing is refused', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = operatorApp();

    await get(app, '/cache/stats', OPERATOR);
    await get(app, '/jobs', OPERATOR);

    expect(warn.mock.calls.flat().filter((m) => String(m).includes('refused an organization-scoped identity')),
      'a single-tenant operator was warned about refusals that did not happen').toEqual([]);
  });
});

describe('the boot warning', () => {
  // It was gated on the multi-org LICENSE flag, which means "the paid product is licensed", not
  // "identities may carry an org". An EE licensee running single-tenant got warnings claiming
  // endpoints "are refused" while nothing was refused.
  it('is not printed for a licensed multi-org provider that has not configured `org`', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createStudioApi({
      reader: new InMemoryJournal(),
      auth: {
        authenticate: () => ({ roles: ['admin'] }),
        authorize: () => ({ allow: true }),
        capabilities: () => ({ sso: true, rbac: true, audit: true, multiOrganization: true, users: true }),
      },
      ...hosts(),
    } as never);

    expect(warn.mock.calls.flat().filter((m) => String(m).includes('are refused')),
      'a single-tenant deployment was told its endpoints are refused').toEqual([]);
  });

  it('is printed when the host turns on per-organization scoping', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createStudioApi({ reader: new InMemoryJournal(), org: {}, ...hosts() } as never);

    const printed = warn.mock.calls.flat().map(String).join('\n');
    for (const what of ['queue', 'cache', 'vectors', 'workflowStore']) {
      expect(printed, `nothing was said at boot about \`${what}\``).toContain(what);
    }
  });

  it('is not printed for objects that declare `orgScoped: true`', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createStudioApi({ reader: new InMemoryJournal(), org: {}, ...hosts(true) } as never);

    expect(warn.mock.calls.flat().filter((m) => String(m).includes('are refused')),
      'a host that claims the boundary was warned anyway').toEqual([]);
  });
});
