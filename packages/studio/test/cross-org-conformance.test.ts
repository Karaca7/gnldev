// CROSS-ORG CONFORMANCE — every route in the inventory, not the routes someone was looking at.
//
// This is what the route inventory was built for. Four rounds running, the same defect shape has
// shipped: `requireScopedMemory` reached 6 of 9 routes, `wfStoreRefusal` 2 of 3, the fork route was a
// third sibling, `/openapi.json` published exactly what `agentGate` withholds. Every one was a rule
// applied to a subset. So the suite reads `handler.routeTable` and refuses to let a route go unexamined.
//
// THE TABLE IS THE POINT. Every route carries an explicit, named verdict. A route in the inventory
// with no entry FAILS — an unclassified route is the actual failure mode, and passing it silently
// would reproduce the bug this exists to prevent. A stale entry (in the table, gone from the router)
// fails too.
//
// THE UNIVERSAL PROBE, applied to all 87 regardless of verdict:
//   Acme's data is seeded into the journal and acme's identifiers are substituted into every path
//   parameter, so globex asks for ACME's run by its real id. Then, driving as globex:
//     1. no response may contain acme's marker  — the read direction;
//     2. no acme journal key may change         — the write direction, which catches the
//        `POST /runs/org:globex:victim/cancel` class that a read-only probe cannot see.
//   A verdict never exempts a route from these. `global` and `self` routes serve no org data, so they
//   satisfy them trivially — and if one ever does not, that is exactly the discovery worth making.
//
// WHAT THE PROBE CANNOT DO, stated plainly: it detects LEAKS, not over-refusal. A route that answers
// 403 to everyone passes it. The `org-scoped` verdict therefore also runs an OWNERSHIP CONTROL where
// seeded data makes one possible — acme must SEE what globex must not — and the routes with no control
// are listed by name in the report rather than counted as proven.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createStudioApi } from '../src/server.js';

const MARKER = 'ACME-CONFIDENTIAL-PAYLOAD';

type Verdict = 'org-scoped' | 'global' | 'self' | 'platform-admin' | 'middleware' | 'undecided';

/**
 * The verdict for every route the router reports. `why` is not decoration: a verdict without a reason
 * is the "we did not check" this file exists to make impossible.
 */
const VERDICTS: Record<string, { verdict: Verdict; why: string }> = {
  // ── not a route: Hono records `app.use()` in the same table. Classified rather than filtered,
  //    because `method === 'ALL'` is also what a genuine `app.all()` route looks like. ────────────
  'ALL /*': { verdict: 'middleware', why: 'the org/auth middleware; Hono records app.use() as a route entry' },

  // ── self-describing: answers about the CALLER or the deployment, never about org data ───────────
  'GET /capabilities': { verdict: 'self', why: 'what this caller may use; deliberately public, pre-login' },
  'GET /me': { verdict: 'self', why: "the caller's own identity and scope" },

  // ── global: code-defined or host-registered, carries no per-organization data ───────────────────
  'GET /permissions/catalog': { verdict: 'global', why: 'a code-defined catalog owned by the framework' },
  'GET /scorers': { verdict: 'global', why: 'host-registered scorer list, not journal data' },
  'GET /datasets': { verdict: 'global', why: 'host-registered dataset list, not journal data' },
  'GET /tools': { verdict: 'global', why: 'the code-defined tool surface' },
  'GET /mcp-servers': { verdict: 'global', why: 'host MCP configuration' },
  'GET /model-providers': { verdict: 'global', why: "the router's provider prefixes" },
  'GET /policy': { verdict: 'global', why: 'the single global tool policy; writing it is platform-admin' },
  'GET /pricing': { verdict: 'global', why: 'the shared price table; writing it is platform-admin' },

  // ── platform-admin: an organization-bound caller must be refused outright ───────────────────────
  'GET /organizations': { verdict: 'org-scoped', why: 'an org-bound identity sees ONLY itself; the full list is operator-only' },
  'POST /organizations': { verdict: 'platform-admin', why: 'organization management' },
  'DELETE /organizations/:id': { verdict: 'platform-admin', why: 'organization management' },
  'PUT /organizations/:id/budget': { verdict: 'platform-admin', why: 'a tenant must not set its own ceiling' },
  'POST /retention/sweep': { verdict: 'platform-admin', why: 'destructive, deployment-wide' },
  'PUT /policy': { verdict: 'platform-admin', why: 'one policy governs every organization' },
  'PUT /pricing': { verdict: 'platform-admin', why: 'one price table governs every organization' },
  'DELETE /runs/:id': { verdict: 'platform-admin', why: 'irreversible purge' },
  'GET /agents/registry': { verdict: 'platform-admin', why: '"may this agent serve at all" is platform-level' },
  'POST /agents/registry/:name/approve': { verdict: 'platform-admin', why: 'platform-level agent governance' },
  'POST /agents/registry/:name/block': { verdict: 'platform-admin', why: 'platform-level agent governance' },

  // ── org-scoped: reads or writes data that belongs to one organization ──────────────────────────
  'GET /runs': { verdict: 'org-scoped', why: 'the run list is org data', },
  'GET /runs/:id': { verdict: 'org-scoped', why: 'a run belongs to one organization' },
  'GET /runs/:id/state': { verdict: 'org-scoped', why: 'reconstructed from a run' },
  'GET /runs/:id/trace': { verdict: 'org-scoped', why: 'reconstructed from a run' },
  'GET /runs/:id/diff': { verdict: 'org-scoped', why: 'reconstructed from a run' },
  'GET /runs/:id/cost': { verdict: 'org-scoped', why: 'derived from a run' },
  'GET /runs/:id/scores': { verdict: 'org-scoped', why: 'derived from a run' },
  'GET /runs/:id/processors': { verdict: 'org-scoped', why: 'derived from a run' },
  'GET /runs/:id/incidents': { verdict: 'org-scoped', why: 'derived from a run' },
  'GET /runs/:id/network': { verdict: 'org-scoped', why: 'derived from a run' },
  'GET /runs/:id/memory-context': { verdict: 'org-scoped', why: 'derived from a run' },
  'GET /runs/:id/regression/:otherId': { verdict: 'org-scoped', why: 'compares two runs; both are org data' },
  'POST /runs/:id/regression': { verdict: 'org-scoped', why: 'operates on a run' },
  'POST /runs/:id/fork': { verdict: 'org-scoped', why: 'copies a run' },
  'POST /runs/:id/resume': { verdict: 'org-scoped', why: 'continues a run' },
  'POST /runs/:id/cancel': { verdict: 'org-scoped', why: 'terminally stops a run' },
  'POST /runs/:id/compensate': { verdict: 'org-scoped', why: 'unwinds a run' },
  'POST /runs/:id/score': { verdict: 'org-scoped', why: 'writes onto a run' },
  'POST /runs/:id/otel-export': { verdict: 'org-scoped', why: 'exports a run' },
  'GET /metrics': { verdict: 'org-scoped', why: 'aggregates the org-scoped journal' },
  'GET /metrics/runs': { verdict: 'org-scoped', why: 'aggregates the org-scoped journal' },
  'GET /audit': { verdict: 'org-scoped', why: 'the audit log is per organization' },
  'GET /approvals': { verdict: 'org-scoped', why: 'pending approvals belong to an org\'s runs' },
  'GET /events': { verdict: 'org-scoped', why: 'a live feed of the org-scoped journal' },
  'POST /auth/sse-ticket': { verdict: 'org-scoped', why: 'mints a ticket carrying the caller\'s org' },
  'GET /a2a-network': { verdict: 'org-scoped', why: 'extracted from org-scoped run data' },
  'GET /scheduler/triggers': { verdict: 'org-scoped', why: 'read from the org-scoped journal' },
  'GET /threads': { verdict: 'org-scoped', why: 'conversation data' },
  'GET /threads/:id/messages': { verdict: 'org-scoped', why: 'conversation data' },
  'GET /threads/:id/working-memory': { verdict: 'org-scoped', why: 'conversation data' },
  'PATCH /threads/:id': { verdict: 'org-scoped', why: 'conversation data' },
  'DELETE /threads/:id': { verdict: 'org-scoped', why: 'conversation data' },
  'DELETE /threads/:id/messages': { verdict: 'org-scoped', why: 'conversation data' },
  'GET /agents': { verdict: 'org-scoped', why: 'filtered by agentVisibleToOrg' },
  'POST /agents/:name/run': { verdict: 'org-scoped', why: 'runs under the caller\'s org, gated by agentGate' },
  'POST /agents/:name/stream': { verdict: 'org-scoped', why: 'runs under the caller\'s org, gated by agentGate' },
  'POST /chat': { verdict: 'org-scoped', why: 'runs an agent for the caller' },
  'GET /managed-agents': { verdict: 'org-scoped', why: 'managed agent versions are per organization' },
  'POST /managed-agents': { verdict: 'org-scoped', why: 'managed agent versions are per organization' },
  'DELETE /managed-agents/:name': { verdict: 'org-scoped', why: 'managed agent versions are per organization' },
  'POST /managed-agents/:name/promote': { verdict: 'org-scoped', why: 'promotion is per organization' },
  'DELETE /managed-agents/:name/versions/:version': { verdict: 'org-scoped', why: 'managed agent versions are per organization' },
  'GET /users': { verdict: 'org-scoped', why: 'an org admin manages its own users' },
  'POST /users': { verdict: 'org-scoped', why: 'an org admin manages its own users' },
  'PATCH /users/:id': { verdict: 'org-scoped', why: 'an org admin manages its own users' },
  'DELETE /users/:id': { verdict: 'org-scoped', why: 'an org admin manages its own users' },
  'POST /users/:id/revoke': { verdict: 'org-scoped', why: 'an org admin manages its own users' },
  'GET /jobs': { verdict: 'org-scoped', why: 'refused unless the host queue declares orgScoped' },
  'POST /jobs/:id/retry': { verdict: 'org-scoped', why: 'refused unless the host queue declares orgScoped' },
  'GET /cache/stats': { verdict: 'org-scoped', why: 'refused unless the host cache declares orgScoped' },
  'POST /cache/invalidate': { verdict: 'org-scoped', why: 'refused unless the host cache declares orgScoped' },
  'POST /knowledge/search': { verdict: 'org-scoped', why: 'refused unless the host vector store declares orgScoped' },
  'POST /tools/:name/execute': { verdict: 'org-scoped', why: 'executes under the caller\'s scope' },
  'POST /datasets/:id/run': { verdict: 'org-scoped', why: 'writes run data for the caller\'s org' },
  'GET /workflows': { verdict: 'org-scoped', why: 'managed definitions are filtered by wfStoreFor' },
  'GET /workflows/:name/def': { verdict: 'org-scoped', why: 'a managed definition carries prompt templates' },
  'POST /workflows': { verdict: 'org-scoped', why: 'writes a managed definition' },
  'PUT /workflows/:name': { verdict: 'org-scoped', why: 'writes a managed definition' },
  'DELETE /workflows/:name': { verdict: 'org-scoped', why: 'deletes a managed definition' },
  'POST /workflows/:name/run': { verdict: 'org-scoped', why: 'executes a managed definition' },
  'POST /workflows/:name/run-stream': { verdict: 'org-scoped', why: 'executes a managed definition' },
  'POST /workflows/:name/runs/:id/fork': { verdict: 'org-scoped', why: 'copies workflow run data' },
  'GET /workflows/:name/runs': { verdict: 'org-scoped', why: 'workflow run history is org data' },
  'GET /workflows/runs': { verdict: 'org-scoped', why: 'workflow run registry is org data' },
  'GET /workflows/run/:runId': { verdict: 'org-scoped', why: 'a workflow run is org data' },
  'POST /workflows/runs/:id/cancel': { verdict: 'org-scoped', why: 'terminally stops a workflow run' },
};

/** Two org-bound admins and one platform admin. Same roles, so only the org binding differs. */
const authProvider = {
  authenticate: (req: Request) => {
    const t = req.headers.get('authorization')?.replace('Bearer ', '');
    if (t === 'acme') return { roles: ['admin'], id: 'u-acme', orgId: 'acme' };
    if (t === 'globex') return { roles: ['admin'], id: 'u-globex', orgId: 'globex' };
    if (t === 'root') return { roles: ['admin', 'platform-admin'], id: 'u-root' };
    return null;
  },
  authorize: () => ({ allow: true }),
  capabilities: () => ({ sso: false, rbac: false, audit: false, multiOrganization: false, users: false }),
};

const AS = { acme: { authorization: 'Bearer acme' }, globex: { authorization: 'Bearer globex' } };

/**
 * Acme's identifiers, substituted into every parameter — globex asks for acme's things by name.
 *
 * Family-aware, because `:id` does not mean the same thing everywhere: it is a RUN under `/runs/*`, a
 * THREAD under `/threads/*`, a USER under `/users/*` and a JOB under `/jobs/*`. A single mapping sent
 * `/threads/r-acme/messages`, which is nobody's thread — so the route answered `[]` to both callers and
 * read as isolation. That is the vacuous-control trap in its purest form: the probe was asking for
 * something that does not exist.
 */
function concrete(path: string): string {
  const family = (m: string): string => {
    if (m === ':version') return '1';
    if (m === ':otherId') return 'r-acme-2';
    if (m === ':runId') return 'r-acme';
    if (path.startsWith('/threads')) return 't-acme';
    if (path.startsWith('/users')) return 'u-acme';
    if (path.startsWith('/jobs')) return 'j1';
    if (path.startsWith('/datasets')) return 'd-acme';
    if (path.startsWith('/managed-agents')) return 'acme-bot';
    if (path.startsWith('/organizations')) return 'acme';
    if (path.startsWith('/tools')) return 'acme-tool';
    if (m === ':name') return 'acme-workflow';
    return 'r-acme';
  };
  return path.replace(/:([A-Za-z_]\w*)/g, (m) => family(m));
}

/**
 * A per-organization corpus, in the key shapes the read surface actually reads.
 *
 * Written for BOTH organizations with different contents, so an ownership control can ask "does acme's
 * answer differ from globex's" rather than "is it non-empty" — the second passes when a route is broken
 * for everyone.
 */
async function seedOrg(j: InMemoryJournal, org: string, run: string, text: string, cost: number) {
  const p = `org:${org}:${run}`;
  const usage = { inputTokens: { total: 5 }, outputTokens: { total: 7 } };
  await j.put(`${p}:input`, { prompt: text, at: 1, agent: text });
  await j.put(`${p}:model:0`, { content: [{ type: 'text', text }], finishReason: 'stop', usage, modelId: 'm', at: 2 });
  await j.put(`${p}:outcome`, { status: 'completed', at: 3 });
  await j.put(`org:${org}:__metrics__run:${run}`, { runId: run, agentName: text, status: 'completed', costUsd: cost, totalTokens: 9, startTs: 1, durationMs: 5 });
  // MATERIALIZED counters, per organization. `GET /metrics` has a fast path guarded by
  // `summary.all`, and without these the summary is `undefined`, the whole block is skipped, and the
  // endpoint answers from its legacy scan. Measured: this suite drove `/metrics` as an org-scoped
  // caller and still could not see the `countRunsByStatus` 500, because it never reached the branch
  // the defect lived in. A route with a fast path and a fallback is only half-tested by a fixture that
  // reaches one of them.
  await j.incrBy!(`org:${org}:__metrics__:all`, { runs: 1, tokens: cost * 100, costUsdMicros: cost });
  await j.put(`${p}:proc:eval:quality`, { v: cost });
  await j.put(`${p}:memctx`, { recalled: [], recentCount: 1, note: text });
  await j.put(`${p}:wf:step-a`, { output: text });
  await j.put(`org:${org}:wfrun:${run}`, { runId: run, workflowName: 'acme-workflow', status: 'completed', at: 1 });
  await j.put(`org:${org}:__studio_agent__:acme-bot`, { name: 'acme-bot', versions: [{ version: 1, system: text, at: 1 }], active: 1 });
  await j.put(`org:${org}:__audit__:a1`, { at: 1, actor: text, action: 'run', target: run });
  // The conversation store below is a factory over the org-scoped journal, so its keys are org-prefixed.
  await j.put(`org:${org}:threads`, [{ id: `t-${org}`, title: text }]);
  await j.put(`org:${org}:thread:t-${org}`, [{ role: 'user', content: text }]);
  await j.put(`org:${org}:wm:t-${org}`, text);
}

async function seeded() {
  const journal = new InMemoryJournal();
  await seedOrg(journal, 'acme', 'r-acme', MARKER, 3);
  // A SECOND acme run, so aggregate endpoints differ by more than coincidence: with one run each, the
  // counts matched and `acme.body !== globex.body` passed for the wrong reason. It is also the second
  // run `GET /runs/:id/regression/:otherId` needs.
  await seedOrg(journal, 'acme', 'r-acme-2', MARKER, 2);
  await seedOrg(journal, 'globex', 'r-globex', 'GLOBEX-OWN', 1);
  // A run left SUSPENDED on a tool call, which is what `GET /approvals` reconstructs. Its outcome is
  // removed on purpose — a completed run is not pending anything.
  await journal.put('org:acme:r-acme:tool:call-1', {
    status: 'suspended', toolName: MARKER, output: { __gnl_suspend: { toolCallId: 'call-1', reason: MARKER } },
  });
  await journal.put('org:acme:r-acme:outcome', undefined);
  return journal;
}

/**
 * Host objects, in two configurations.
 *
 * WITHOUT `orgScoped: true` (the default, and the shipped safe state) every endpoint that reaches one
 * of them is refused for an organization-bound caller, so nothing can leak through them.
 *
 * WITH it, the host is CLAIMING it honours the organization it is handed. Three call sites hand one
 * over — `vectors.search(q, topK, {orgId})`, `cache.invalidate(key, {orgId})`, `queue.retry(id, {orgId})`
 * — and these fixtures honour it, so a leak there would be the server's fault and the probe would say so.
 *
 * The rest are handed NOTHING: `queue.listJobs()` and `cache.stats()` take no argument, and the whole
 * `StudioWorkflowStore` interface (`list`/`get`/`set`/`delete`) has no context parameter at all. A host
 * that opts in cannot filter on those routes however much it wants to. That is not a fixture
 * limitation — it is the shape of the interface, and it is asserted as a finding further down.
 */
/** Every host call, with the organization studio told it about. The control for WRITE routes. */
const hostCalls: Array<{ what: string; orgId?: string }> = [];

function hostObjects(optIn: boolean) {
  const flag = optIn ? { orgScoped: true } : {};
  const rec = <T>(what: string, ctx: { orgId?: string } | undefined, v: T): T => {
    hostCalls.push({ what, orgId: ctx?.orgId });
    return v;
  };
  const mine = (orgId: string | undefined) => (orgId === 'acme' ? MARKER : 'GLOBEX-OWN');
  const defs = new Map([['acme-workflow', {
    name: 'acme-workflow', description: MARKER, steps: [{ id: 's1', agentName: 'w', prompt: MARKER }],
  }]]);
  return {
    queue: {
      ...flag,
      listJobs: (ctx?: { orgId?: string }) => [{ id: 'j1', type: mine(ctx?.orgId), status: 'done', attempts: 1 }],
      retry: (_id: string, ctx?: { orgId?: string }) => rec('queue.retry', ctx, mine(ctx?.orgId)),
    },
    cache: {
      ...flag,
      stats: (ctx?: { orgId?: string }) => ({ hits: ctx?.orgId === 'acme' ? 1 : 0, misses: 0, hitRate: 1, size: 1 }),
      invalidate: (_k: unknown, ctx?: { orgId?: string }) => rec('cache.invalidate', ctx, ctx?.orgId === 'acme' ? 1 : 0),
    },
    vectors: {
      ...flag,
      search: (_q: string, _k: number, ctx?: { orgId?: string }) => [{ id: 'v1', text: mine(ctx?.orgId), score: 1 }],
    },
    workflowStore: {
      ...flag,
      list: (ctx?: { orgId?: string }) => (ctx?.orgId === 'acme' ? [...defs.values()] : []),
      get: (n: string, ctx?: { orgId?: string }) => (ctx?.orgId === 'acme' ? defs.get(n) : undefined),
      set: (_d: unknown, ctx?: { orgId?: string }) => rec('workflowStore.set', ctx, undefined),
      delete: (_n: string, ctx?: { orgId?: string }) => rec('workflowStore.delete', ctx, undefined),
    },
    /**
     * A host that OPTS IN and then ignores the argument. Studio cannot detect this and does not try —
     * `orgScoped` is a claim, not a verifiable fact — so it is kept as a separate fixture rather than
     * folded into the one above, and the block below asserts the difference explicitly.
     */
    __dishonest: {
      queue: { ...flag, listJobs: () => [{ id: 'j1', type: MARKER, status: 'done', attempts: 1 }] },
      workflowStore: { ...flag, list: () => [...defs.values()], get: (n: string) => defs.get(n), set: () => {}, delete: () => {} },
    },
  } as Record<string, unknown>;
}

/**
 * Every optional surface is wired.
 *
 * An unwired surface answers 501 to BOTH callers, which is indistinguishable from isolation and puts
 * the route in the uncontrolled pile for a reason that has nothing to do with organizations. Fourteen
 * routes were sitting there purely because the fixture had not enabled the feature.
 */
async function makeApi(optIn = false) {
  const journal = await seeded();
  const mem = (j: { get: (k: string) => Promise<unknown>; put: (k: string, v: unknown) => Promise<void> }) => ({
    listThreads: async () => ((await j.get('threads')) as unknown[]) ?? [],
    getMessages: async (id: string) => ((await j.get(`thread:${id}`)) as unknown[]) ?? [],
    getWorkingMemory: async (id: string) => (await j.get(`wm:${id}`)) as string | undefined,
    updateThread: async (id: string, patch: unknown) => { await j.put(`thread-meta:${id}`, patch); },
    deleteThread: async (id: string) => { await j.put(`thread:${id}`, []); },
    truncateMessages: async (id: string) => { await j.put(`thread:${id}`, []); return 1; },
    appendMessages: async () => {},
  });
  const api = createStudioApi({
    reader: journal,
    auth: authProvider,
    org: {},
    resume: async () => ({}),
    compensate: async () => ({ ok: true }),
    otelExport: async (runId: string) => ({ ok: true, target: runId }),
    chat: { send: async () => ({ text: 'chat-ok' }) },
    scorers: { list: () => [{ name: 'quality' }], score: async () => ({ quality: 1 }) },
    // Scoped by the org the store is asked about, the way a real user store is.
    /**
     * Returns EVERY user when called without an organization — which is how the routes call it. All
     * four `/users` handlers do `opts.users.list()` unscoped and filter in the handler against the
     * caller's own `orgId`. An earlier fixture returned `[]` for the unscoped call, so `target` was
     * never found, the `target.orgId !== own` guard never fired, and a stranger's delete came back 200:
     * the fixture defeated the very check the route exists for.
     */
    users: {
      list: async (orgId?: string) => [
        { id: 'u-acme', email: MARKER, roles: ['admin'], orgId: 'acme' },
        { id: 'u-globex', email: 'GLOBEX-OWN', roles: ['admin'], orgId: 'globex' },
      ].filter((u) => orgId === undefined || u.orgId === orgId),
      create: async (u: Record<string, unknown>) => ({ ...u, id: 'u-new' }),
      update: async (id: string, patch: Record<string, unknown>) => ({ id, ...patch, roles: ['admin'] }),
      remove: async () => {},
      revoke: async () => {},
    },
    datasets: { list: () => [{ id: 'd-acme', size: 1 }], run: async () => ({ ok: true, results: [] }) },
    // A FACTORY, not an object: it is handed the org-scoped reader, so threads isolate. A `memory`
    // object is refused unless it declares `orgScoped: true` — see the block at the end of this file.
    memoryFactory: mem,
    gnl: {
      // Agents carry `orgs`, because `GET /agents` filters with `agentVisibleToOrg`. A fixture whose
      // agents are all global makes that filter invisible: both callers see the same list, and the
      // route looks uncontrollable when it is simply never exercised.
      listAgents: () => [{ name: 'acme-only-agent', orgs: ['acme'] }, { name: 'shared-agent' }],
      run: async () => ({ text: 'ok' }),
      stream: async () => ({ textStream: (async function* () { yield 'ok'; })() }),
      listTools: () => [{ name: 'acme-tool' }],
      runTool: async () => ({ ok: true }),
      listWorkflows: () => [],
    },
    ...(({ __dishonest: _d, ...rest }) => rest)(hostObjects(optIn) as never),
  } as never) as unknown as ((r: Request) => Promise<Response>) & { routeTable: readonly { method: string; path: string }[] };
  return { api, journal };
}

/** Reads a response body, giving up on an open stream rather than hanging. */
async function bodyOf(res: Response, ms = 1200): Promise<string> {
  try {
    return await Promise.race([
      res.text(),
      new Promise<string>((resolve) => setTimeout(() => resolve('<<stream did not end>>'), ms)),
    ]);
  } catch { return '<<body unreadable>>'; }
}

async function drive(api: (r: Request) => Promise<Response>, route: { method: string; path: string }, who: Record<string, string>) {
  const init: RequestInit = { method: route.method, headers: { ...who } };
  if (!['GET', 'HEAD'].includes(route.method)) {
    init.headers = { ...who, 'content-type': 'application/json' };
    // A generic body plus the fields specific routes VALIDATE before doing anything. Without them the
    // route answers 400 to both callers, which is indistinguishable from isolation and quietly parks
    // the route in the uncontrolled pile for a reason that has nothing to do with organizations.
    init.body = JSON.stringify({
      runId: 'r-acme', name: 'acme-workflow', input: {}, query: 'x', prompt: 'x', steps: [],
      message: 'hello', model: 'openai/gpt-4o-mini', afterIndex: 0, upto: 1, version: 1, id: 'x',
      // `PATCH /users/:id` refuses a body with nothing to change ("nothing to update"), which reads as
      // a refusal of the CALLER rather than of the request.
      roles: ['viewer'],
    });
  }
  const res = await Promise.race([
    api(new Request(`http://x${concrete(route.path)}`, init)),
    new Promise<Response>((resolve) => setTimeout(() => resolve(new Response('<<no response>>', { status: 599 })), 4000)),
  ]);
  return { status: res.status, body: await bodyOf(res) };
}

const snapshot = async (j: InMemoryJournal) => {
  const keys = (await j.listKeys('')).filter((k) => k.startsWith('org:acme:'));
  const out: Record<string, string> = {};
  for (const k of keys.sort()) out[k] = JSON.stringify(await j.get(k));
  return out;
};

describe('the conformance table covers the router exactly', () => {
  it('every route the handler serves has a verdict', async () => {
    const { api } = await makeApi();
    const inventory = api.routeTable.map((r) => `${r.method} ${r.path}`);
    const unclassified = inventory.filter((r) => !(r in VERDICTS));

    expect(inventory.length, 'the inventory is empty — the suite would pass vacuously').toBeGreaterThan(50);
    expect(unclassified,
      'a route has no cross-org verdict. That is the defect this suite exists to catch: an unexamined '
      + 'route is exactly how every previous isolation gap shipped. Add it to VERDICTS with a reason.')
      .toEqual([]);
  });

  it('and no verdict names a route that no longer exists', async () => {
    const { api } = await makeApi();
    const inventory = new Set(api.routeTable.map((r) => `${r.method} ${r.path}`));
    expect(Object.keys(VERDICTS).filter((k) => !inventory.has(k)), 'a stale verdict outlived its route').toEqual([]);
  });

  it('and nothing is left as "we did not check"', () => {
    const undecided = Object.entries(VERDICTS).filter(([, v]) => v.verdict === 'undecided').map(([k, v]) => `${k}: ${v.why}`);
    expect(undecided, 'a route needs a product decision before it can be claimed conformant').toEqual([]);
  });

  it('and every verdict carries a reason', () => {
    expect(Object.entries(VERDICTS).filter(([, v]) => !v.why || v.why.length < 10).map(([k]) => k)).toEqual([]);
  });
});

describe("one organization's request cannot reach another's data", () => {
  // The read direction, over every route in the inventory at once. Reported as a list so a failure
  // names every offending route rather than stopping at the first.
  it('no route returns acme data to globex', async () => {
    const { api } = await makeApi();
    const leaks: string[] = [];
    for (const r of api.routeTable) {
      const { status, body } = await drive(api, r, AS.globex);
      if (body.includes(MARKER)) leaks.push(`${r.method} ${r.path} -> ${status} leaked`);
    }
    expect(leaks, 'a route served one organization the contents of another').toEqual([]);
  }, 120_000);

  // The write direction. A read-only probe cannot see `POST /runs/org:globex:victim/cancel`.
  it('no globex request modifies an acme journal key', async () => {
    const { api, journal } = await makeApi();
    const before = await snapshot(journal);

    for (const r of api.routeTable) await drive(api, r, AS.globex);

    const after = await snapshot(journal);
    const changed = Object.keys(before).filter((k) => before[k] !== after[k]);
    const removed = Object.keys(before).filter((k) => !(k in after));
    expect([...changed, ...removed], 'a request from one organization altered another\'s stored data').toEqual([]);
  }, 120_000);
});

describe('platform-admin routes refuse an organization-bound caller', () => {
  const platform = Object.entries(VERDICTS).filter(([, v]) => v.verdict === 'platform-admin').map(([k]) => k);

  it('there are some, or this block is vacuous', () => {
    expect(platform.length).toBeGreaterThan(5);
  });

  it.each(platform)('%s', async (key) => {
    const { api } = await makeApi();
    const [method, ...rest] = key.split(' ');
    const route = { method: method!, path: rest.join(' ') };
    const { status } = await drive(api, route, AS.globex);

    expect(status, 'an organization-bound caller reached a platform-level surface').toBe(403);
  }, 30_000);
});

describe('the ownership control — acme must SEE what globex must not', () => {
  // Without this, "no leak" is satisfied by a route that answers nothing to anyone. The control is
  // generic rather than per-route: acme's answer must SUCCEED and must DIFFER from globex's for the
  // same request. Two identical answers mean either both are refused (over-refusal) or both leak.
  // Measured, not assumed: every org-scoped route was driven as both callers and this is the set where
  // acme SUCCEEDS and its answer DIFFERS from globex's. Routes were removed from earlier drafts when
  // they answered both callers identically (`GET /runs/:id/cost`, `GET /a2a-network`, `GET /approvals`
  // at the time) — a control that cannot tell the two apart is a control in name only.
  const CONTROLLED: string[] = [
    'GET /agents', 'GET /users', 'DELETE /users/:id', 'PATCH /users/:id', 'POST /users/:id/revoke',
    'POST /auth/sse-ticket', 'POST /cache/invalidate', 'GET /cache/stats',
    'GET /jobs', 'POST /jobs/:id/retry', 'POST /knowledge/search', 'GET /managed-agents',
    'GET /metrics', 'GET /metrics/runs', 'GET /organizations',
    'GET /runs', 'GET /runs/:id', 'POST /runs/:id/cancel', 'POST /runs/:id/compensate',
    'GET /runs/:id/cost', 'GET /runs/:id/diff', 'POST /runs/:id/fork', 'GET /runs/:id/memory-context',
    'POST /runs/:id/otel-export', 'GET /runs/:id/regression/:otherId', 'POST /runs/:id/resume',
    'POST /runs/:id/score', 'GET /runs/:id/scores', 'GET /runs/:id/state', 'GET /runs/:id/trace',
    'GET /threads', 'GET /threads/:id/working-memory',
    'GET /workflows', 'GET /workflows/:name/def', 'POST /workflows/:name/runs/:id/fork',
    'GET /workflows/run/:runId', 'GET /workflows/runs', 'POST /workflows/runs/:id/cancel',
  ];

  /** Controlled by the recorded host call instead of the body — see the write-route block below. */
  const WRITE_CONTROLLED = ['POST /workflows', 'PUT /workflows/:name', 'DELETE /workflows/:name'];

  /**
   * Controlled by the EFFECT the request had, for routes that answer a constant.
   *
   * `PATCH`/`DELETE /threads/:id` and `DELETE /threads/:id/messages` all answer `{ok:true}` to
   * everybody, so no comparison of bodies can ever separate the owner from a stranger. Their seams
   * (`updateThread`, `deleteThread`, `truncateMessages`) receive only a threadId — no organization —
   * because isolation comes from the ALS-scoped journal the conversation store is built over.
   *
   * So the observable is WHERE THE WRITE LANDED. The owner's mutation must reach the owner's key, and
   * a stranger issuing the identical request must not.
   */
  const EFFECT_CONTROLLED = ['PATCH /threads/:id', 'DELETE /threads/:id', 'DELETE /threads/:id/messages'];

  // The OPT-IN fixture: routes backed by a host object are refused entirely without it, and a 403 to
  // both callers is not an ownership control. This is the configuration in which they serve at all.
  it.each(CONTROLLED)('%s answers its owner, and differently from a stranger', async (key) => {
    const { api } = await makeApi(true);
    const [method, ...rest] = key.split(' ');
    const route = { method: method!, path: rest.join(' ') };
    const owner = await drive(api, route, AS.acme);
    const stranger = await drive(api, route, AS.globex);

    expect(owner.status, `${key} refused the organization that owns the data`).toBeLessThan(400);
    expect(owner.body, `${key} answers its owner and a stranger identically — the leak probe passes for the wrong reason`)
      .not.toBe(stranger.body);
  }, 30_000);

  // The honest accounting, printed rather than hidden: which org-scoped routes are leak-checked but
  // have no ownership control in this fixture. They are NOT claimed proven.
  /**
   * The honest accounting. Every org-scoped route is leak-checked and write-checked by the universal
   * probe; this names the ones with no OWNERSHIP control and why, so the gap is a list rather than a
   * number. Grouped by what it would take to close each — the first group needs fixture data, the
   * second needs a host seam that carries the organization, the third needs production support.
   */
  const UNCONTROLLED_REASONS: Record<string, string> = {
    // Nothing of that shape is seeded, so both callers get an empty answer.
    'GET /a2a-network': 'needs journaled agent-to-agent edges',
    // Dropped from CONTROLLED after it passed only in a batch: the audit log is WRITTEN by the write
    // routes, so driving the whole inventory first left rows behind and made it look controlled. Run
    // alone it is empty for both callers. An order-dependent control is worse than none.
    'GET /audit': 'empty for both callers unless earlier requests happened to write audit rows',
    'GET /approvals': 'needs a run left suspended in a state listRuns reports as pending',
    'GET /runs/:id/incidents': 'needs incident records in readIncidents\' shape',
    'GET /runs/:id/network': 'needs sub-agent call records',
    'GET /runs/:id/processors': 'needs processor reports in the shape the route reads',
    'GET /scheduler/triggers': 'needs @gnldev/scheduler trigger keys',
    'GET /threads/:id/messages': 'the factory-backed store returns [] for the seeded thread id',
    'GET /workflows/:name/runs': 'needs wfrun records keyed by workflow name',
    'GET /users': 'needs a user store whose list() is called with the caller\'s organization',
    // The host is a stub that answers identically; the org is carried in the CALL, not the response.
    'POST /users': 'creates a user rather than acting on an existing one, so there is no existing target '
      + 'whose organization the route can compare against the calling identity',
    'POST /agents/:name/run': 'stub runner returns the same body; needs a recorded seam like the write routes',
    'POST /agents/:name/stream': 'streamed body, and the stub runner answers identically',
    'POST /chat': 'stub chat answers identically',
    'POST /tools/:name/execute': 'stub tool runner answers identically',
    'POST /datasets/:id/run': 'stub dataset runner answers identically',
    'POST /managed-agents': 'requires a code-defined agent to version against',
    'DELETE /managed-agents/:name': 'answers {ok:true} to both',
    'POST /managed-agents/:name/promote': 'needs a stored version to promote',
    'DELETE /managed-agents/:name/versions/:version': 'needs a stored version to delete',
    'POST /runs/:id/regression': 'reaches a real provider and fails on a missing API key for both',
    // Needs production support to be controllable at all.
    'GET /events': 'SSE — the body never ends, so there is no answer to compare',
    'POST /workflows/:name/run': 'needs compileWorkflow wired; answers 501 to both without it',
    'POST /workflows/:name/run-stream': 'needs compileWorkflow wired; answers 501 to both without it',
  };

  /**
   * The recorded-EFFECT control, for the routes whose answer is a constant.
   *
   * Each case drives the SAME request as both callers against the SAME thread id, and reads the
   * underlying journal to see where the write landed. Both halves are asserted: the owner's mutation
   * must reach the owner's key (or the control is vacuous), and the stranger's identical request must
   * leave it untouched (or it is a cross-organization write).
   */
  describe('routes that answer a constant are controlled by where the write landed', () => {
    const KEY = { acme: 'org:acme:thread:t-acme', globex: 'org:globex:thread:t-acme' };

    /** Seeds one message under BOTH organizations' copies of the same thread id. */
    async function seedBothThreads(journal: InMemoryJournal) {
      await journal.put(KEY.acme, [{ role: 'user', content: MARKER }]);
      await journal.put(KEY.globex, [{ role: 'user', content: 'GLOBEX-OWN' }]);
    }

    it.each([
      ['DELETE /threads/:id', 'DELETE', '/threads/:id'],
      ['DELETE /threads/:id/messages', 'DELETE', '/threads/:id/messages'],
    ])('%s empties the caller\'s own thread and no one else\'s', async (_label, method, path) => {
      const { api, journal } = await makeApi(true);
      await seedBothThreads(journal);

      // The stranger first: its identical request must not touch acme's copy.
      await drive(api, { method, path }, AS.globex);
      expect(await journal.get(KEY.acme),
        "a stranger's delete reached another organization's thread").toEqual([{ role: 'user', content: MARKER }]);

      // Then the owner: the same request must actually do something.
      await drive(api, { method, path }, AS.acme);
      expect(await journal.get(KEY.acme),
        'the owner\'s delete did nothing — the isolation above is blanket refusal, not ownership').toEqual([]);
    }, 30_000);

    it('PATCH /threads/:id writes metadata under the caller\'s own organization', async () => {
      const { api, journal } = await makeApi(true);
      await seedBothThreads(journal);

      await drive(api, { method: 'PATCH', path: '/threads/:id' }, AS.acme);
      await drive(api, { method: 'PATCH', path: '/threads/:id' }, AS.globex);

      expect(await journal.get('org:acme:thread-meta:t-acme'),
        'the owner\'s patch did not land under its own organization').toBeTruthy();
      expect(await journal.get('org:globex:thread-meta:t-acme'),
        'the stranger\'s patch landed somewhere other than its own organization').toBeTruthy();
      // The two are separate rows: neither caller can see or overwrite the other's.
      expect(await journal.get('org:acme:thread-meta:t-acme'))
        .not.toBe(await journal.get('org:globex:thread-meta:t-acme'));
    }, 30_000);
  });

  /**
   * The `/users` routes carry their own organization check: each reads the whole store and compares
   * `target.orgId` against the caller's own, answering 403 when they differ. So the owner and a
   * stranger get genuinely different ANSWERS, and the control is the answer — no seam needed.
   */
  describe('user management is confined to the caller\'s own organization', () => {
    it.each([
      ['DELETE /users/:id', 'DELETE', '/users/:id'],
      ['PATCH /users/:id', 'PATCH', '/users/:id'],
      ['POST /users/:id/revoke', 'POST', '/users/:id/revoke'],
    ])('%s: the owner may act on its own member, a stranger may not', async (_label, method, path) => {
      const { api } = await makeApi(true);

      const owner = await drive(api, { method, path }, AS.acme);      // u-acme belongs to acme
      const stranger = await drive(api, { method, path }, AS.globex);

      expect(owner.status, "the owning organization could not act on its own member").toBeLessThan(400);
      expect(stranger.status, "another organization acted on a member that is not theirs").toBe(403);
      expect(stranger.body, 'the refusal does not say whose member it is').toMatch(/own org/);
    }, 30_000);

    it('GET /users lists only the caller\'s own members', async () => {
      const { api } = await makeApi(true);
      const acme = await drive(api, { method: 'GET', path: '/users' }, AS.acme);
      const globex = await drive(api, { method: 'GET', path: '/users' }, AS.globex);

      expect(acme.body, 'the owner cannot see its own member').toContain('u-acme');
      expect(acme.body, "another organization's member appeared in the list").not.toContain('u-globex');
      expect(globex.body).toContain('u-globex');
      expect(globex.body).not.toContain('u-acme');
    }, 30_000);
  });

  // `GET /agents` filters through `agentVisibleToOrg` — the same rule `agentGate` uses to answer an
  // identical 404 for "no such agent" and "not yours". An agent NAME is therefore a fact this route
  // must not disclose to a non-owning organization.
  it('GET /agents shows each organization only the agents it may run', async () => {
    const { api } = await makeApi(true);
    const acme = await drive(api, { method: 'GET', path: '/agents' }, AS.acme);
    const globex = await drive(api, { method: 'GET', path: '/agents' }, AS.globex);

    expect(acme.body, 'the owning organization lost its own agent').toContain('acme-only-agent');
    expect(globex.body, 'an agent name was disclosed to an organization that cannot run it')
      .not.toContain('acme-only-agent');
    expect(globex.body, 'the global agent disappeared for a non-owning caller').toContain('shared-agent');
  }, 30_000);

  it('names every org-scoped route that is leak-checked but not ownership-controlled', () => {
    const orgScoped = Object.entries(VERDICTS).filter(([, v]) => v.verdict === 'org-scoped').map(([k]) => k);
    const controlled = new Set([...CONTROLLED, ...WRITE_CONTROLLED, ...EFFECT_CONTROLLED]);
    const uncontrolled = orgScoped.filter((k) => !controlled.has(k));

    // eslint-disable-next-line no-console
    console.log(`[cross-org] ${controlled.size}/${orgScoped.length} org-scoped routes are ownership-controlled `
      + `(${CONTROLLED.length} by answer, ${WRITE_CONTROLLED.length} by recorded host call, `
      + `${EFFECT_CONTROLLED.length} by recorded effect).\n`
      + `[cross-org] NOT ownership-controlled (${uncontrolled.length}):\n`
      + uncontrolled.map((k) => `  ${k} — ${UNCONTROLLED_REASONS[k] ?? 'UNEXPLAINED'}`).join('\n'));

    // Every gap must carry a reason. An unexplained one is the same failure as an unclassified route.
    expect(uncontrolled.filter((k) => !UNCONTROLLED_REASONS[k]),
      'an org-scoped route is uncontrolled with no reason recorded — say why, or control it').toEqual([]);
    expect(controlled.size, 'ownership coverage went backwards').toBeGreaterThanOrEqual(44);
  });
});

/**
 * `orgScoped: true` is now a promise the host CAN keep — it used to be unkeepable on eleven routes.
 *
 * The refusal for an unscopeable host object was always correct and the default always safe. But its
 * documented escape hatch — set `orgScoped: true`, "an explicit claim, in the host's own code, that it
 * honours the organization it is handed" — was hollow on most of the surface it unlocked. Only THREE
 * call sites handed one over (`vectors.search`, `cache.invalidate`, `queue.retry`); `queue.listJobs()`
 * and `cache.stats()` took no argument, and `StudioWorkflowStore` had no context parameter anywhere.
 * A host doing exactly what the message said served every tenant, because it was never told who asked.
 *
 * All six now take a `ctx`, and `wfStoreFor` binds it at the single accessor so no call site can drop
 * it. This block was the pinned set; it now asserts the closure, and — because the argument stays
 * ADVISORY by design — keeps the residual visible: a host that opts in and ignores the argument still
 * leaks, and nothing here can tell.
 */
describe('an opting-in host is told which organization is asking', () => {
  /** Refused outright while the host has not opted in — the shipped default, and it is safe. */
  const REFUSED_WITHOUT_OPTIN = ['GET /jobs', 'GET /cache/stats', 'GET /workflows/:name/def'];

  /** The routes whose host method received no organization at all before the interfaces were threaded. */
  const WAS_UNKEEPABLE = ['GET /jobs', 'GET /workflows', 'GET /workflows/:name/def'];

  it('with no opt-in, they are refused', async () => {
    const { api } = await makeApi(false);
    for (const key of REFUSED_WITHOUT_OPTIN) {
      const [method, ...rest] = key.split(' ');
      const { status } = await drive(api, { method: method!, path: rest.join(' ') }, AS.globex);
      expect(status, `${key} served an org-bound caller without the host opting in`).toBe(403);
    }
  }, 30_000);

  // `GET /workflows` is the exception, and correctly so: refusing the whole listing would take the
  // CODE-defined workflows away over an unrelated option, so it answers 200 with the managed
  // definitions filtered out. That filtering is what the opt-in disables.
  it('except GET /workflows, which answers 200 with the managed definitions removed', async () => {
    const { api } = await makeApi(false);
    const { status, body } = await drive(api, { method: 'GET', path: '/workflows' }, AS.globex);

    expect(status).toBe(200);
    expect(body, 'a managed definition survived for a caller the store cannot scope').not.toContain(MARKER);
  }, 30_000);

  it('with the opt-in, an honouring host isolates them — this is the finding closed', async () => {
    const { api } = await makeApi(true);
    const leaking: string[] = [];
    for (const key of WAS_UNKEEPABLE) {
      const [method, ...rest] = key.split(' ');
      const { body } = await drive(api, { method: method!, path: rest.join(' ') }, AS.globex);
      if (body.includes(MARKER)) leaking.push(key);
    }

    expect(leaking, 'a route still served acme\'s data to globex despite the host honouring the orgId').toEqual([]);
  }, 30_000);

  /**
   * The control that makes the test above mean anything, and it has to cover EVERY threaded interface.
   *
   * With only the `no leak` direction, dropping the context entirely passes: an honouring host handed
   * no `orgId` matches nobody and returns nothing, which reads as isolation. Measured — removing the
   * `wfStoreFor` binding left all 34 tests green until this case existed. `GET /jobs` alone was not
   * enough either: it exercises `queue.listJobs`, and the workflow store is a different interface.
   */
  it.each([
    ['GET /jobs', '/jobs'],                                     // queue.listJobs(ctx)
    ['GET /workflows', '/workflows'],                           // StudioWorkflowStore.list(ctx)
    ['GET /workflows/:name/def', '/workflows/acme-workflow/def'], // StudioWorkflowStore.get(name, ctx)
  ])('and acme still gets its own data on %s — the isolation is not blanket refusal', async (_label, path) => {
    const { api } = await makeApi(true);
    const { body } = await drive(api, { method: 'GET', path }, AS.acme);

    expect(body, 'the owning organization was served nothing — the leak control above is vacuous').toContain(MARKER);
  }, 30_000);

  it('but a host that opts in and IGNORES the argument still leaks, and studio cannot tell', async () => {
    const journal = await seeded();
    const dishonest = (hostObjects(true) as { __dishonest: Record<string, unknown> }).__dishonest;
    const api = createStudioApi({
      reader: journal, auth: authProvider, org: {}, gnl: { listAgents: () => [], run: async () => ({}), listWorkflows: () => [] },
      ...dishonest,
    } as never) as unknown as (r: Request) => Promise<Response>;

    const { body } = await drive(api, { method: 'GET', path: '/jobs' }, AS.globex);
    expect(body, 'the claim became verifiable — say so and tighten the refusal').toContain(MARKER);
  }, 30_000);

  it('while the three call sites that always passed an orgId still isolate correctly', async () => {
    const { api } = await makeApi(true);
    const { body } = await drive(api, { method: 'POST', path: '/knowledge/search' }, AS.globex);

    expect(body, 'vectors.search is handed the orgId, so an honouring host must not leak').not.toContain(MARKER);
    expect(body, 'the honouring host returned nothing at all — the control is vacuous').toContain('GLOBEX-OWN');
  }, 30_000);
});

/**
 * `memory` now has the SAME `orgScoped: true` opt-out as its four siblings.
 *
 * This block recorded the opposite as a finding: the conversation store's scoping was
 * `memoryIsOrgScoped = !memory` — the mere PRESENCE of a `memory` object, regardless of what it
 * claimed — so a host that had genuinely made its memory organization-aware had no way to say so and
 * its org-bound callers were refused every thread route permanently. `memoryFactory` was the only way
 * out, which is a different object model rather than a claim about the object you already have.
 * Inverted rather than deleted: the finding was written down, and then it was fixed.
 */
describe('the conversation store honours the orgScoped claim', () => {
  const THREAD_ROUTES = ['GET /threads', 'GET /threads/:id/messages', 'GET /threads/:id/working-memory'];

  it('a memory object that declares orgScoped: true is served, not refused', async () => {
    const journal = await seeded();
    const api = createStudioApi({
      reader: journal, auth: authProvider, org: {},
      memory: { orgScoped: true, listThreads: () => [{ id: 't', title: 'GLOBEX-OWN' }], getMessages: () => [] },
    } as never) as unknown as (r: Request) => Promise<Response>;

    for (const key of THREAD_ROUTES) {
      const [method, ...rest] = key.split(' ');
      const { status } = await drive(api, { method: method!, path: rest.join(' ') }, AS.acme);
      expect(status, `${key} still refuses a memory that claims to be org-scoped`).not.toBe(403);
    }
  }, 30_000);

  it('and one that makes no claim is still refused — the default has not moved', async () => {
    const journal = await seeded();
    const api = createStudioApi({
      reader: journal, auth: authProvider, org: {},
      memory: { listThreads: () => [{ id: 't', title: MARKER }], getMessages: () => [] },
    } as never) as unknown as (r: Request) => Promise<Response>;

    for (const key of THREAD_ROUTES) {
      const [method, ...rest] = key.split(' ');
      const { status } = await drive(api, { method: method!, path: rest.join(' ') }, AS.acme);
      expect(status, `${key} served an unscopeable conversation store to an org-bound caller`).toBe(403);
    }
  }, 30_000);

  it('whereas the four sibling objects honour exactly that claim', async () => {
    const { api } = await makeApi(true);
    for (const key of ['GET /jobs', 'GET /cache/stats']) {
      const [method, ...rest] = key.split(' ');
      const { status } = await drive(api, { method: method!, path: rest.join(' ') }, AS.acme);
      expect(status, `${key} ignored orgScoped on its host object`).toBeLessThan(400);
    }
  }, 30_000);
});

/**
 * WRITE ROUTES — controlled by the organization the host was TOLD about, not by the response body.
 *
 * A write that answers `{"ok":true}` to everyone cannot be controlled by comparing bodies: identical
 * answers look the same whether the write was correctly scoped or not scoped at all. The observable
 * that actually carries the isolation is the `ctx.orgId` studio hands the host — so the fixture records
 * every call, and the control asserts each caller's write arrived under its OWN organization.
 *
 * This is the shape the read-side control cannot reach, and it is the one that catches a dropped
 * binding: with `wfStoreFor` returning the raw store, `ctx` is `undefined` and both callers' writes
 * arrive anonymous — which a body-diff assertion reads as success.
 */
describe('a write reaches the host under the calling organization', () => {
  it.each([
    ['DELETE /workflows/:name', 'DELETE', '/workflows/:name', 'workflowStore.delete'],
    ['POST /workflows', 'POST', '/workflows', 'workflowStore.set'],
    ['PUT /workflows/:name', 'PUT', '/workflows/:name', 'workflowStore.set'],
    ['POST /jobs/:id/retry', 'POST', '/jobs/:id/retry', 'queue.retry'],
    ['POST /cache/invalidate', 'POST', '/cache/invalidate', 'cache.invalidate'],
  ])('%s tells the host which organization asked', async (_label, method, path, what) => {
    const { api } = await makeApi(true);
    const route = { method, path };

    const start = hostCalls.length;
    await drive(api, route, AS.acme);
    const acmeCalls = hostCalls.slice(start).filter((c) => c.what === what);

    const mid = hostCalls.length;
    await drive(api, route, AS.globex);
    const globexCalls = hostCalls.slice(mid).filter((c) => c.what === what);

    expect(acmeCalls.length, `${what} was never called — the route did not reach the host seam`).toBeGreaterThan(0);
    expect([...new Set(acmeCalls.map((c) => c.orgId))], `acme's write did not reach ${what} under acme`).toEqual(['acme']);
    expect([...new Set(globexCalls.map((c) => c.orgId))],
      `globex's write reached ${what} as another organization, or anonymously`).toEqual(['globex']);
  }, 30_000);
});
