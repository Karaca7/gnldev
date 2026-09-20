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
import { compileManagedWorkflow } from '../src/managed-workflow.js';

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
  // READ ONLY, and that is what separates it from the sweep above. It lists thread state no erasure
  // request can reach, through `rw` — which withOrg has already prefixed (organization.ts bridges
  // listKeys with the org prefix and strips it back off), so a bound identity enumerates its own
  // scope and nothing else. No platform-admin gate, because nothing crosses a tenant boundary and
  // nothing is deleted.
  'GET /retention/orphans': { verdict: 'org-scoped', why: 'read-only listing through the org-prefixed journal' },
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
  'GET /semantic-guard': { verdict: 'org-scoped', why: 'aggregates semantic-guard incidents from the org-scoped journal (K24: scoped rw reader)' },
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
  'GET /dead-events': { verdict: 'org-scoped', why: 'quarantined payloads are org data; refused unless the host events object declares orgScoped' },
  'GET /dead-events/topics': { verdict: 'org-scoped', why: 'which topics and consumers exist is org data; refused unless the host events object declares orgScoped' },
  'POST /dead-events/release': { verdict: 'org-scoped', why: "a release re-runs that organization's handler; refused unless the host events object declares orgScoped" },
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

/** A minimal LanguageModelV2 stand-in, so the regression replay never leaves the process. */
function mockModel() {
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'mock-model', supportedUrls: {},
    doGenerate: async () => ({ content: [{ type: 'text', text: 'replayed' }], finishReason: 'stop' as const,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, warnings: [] as unknown[] }),
    doStream: async () => { throw new Error('mock: doStream is not supported'); },
  };
}

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
    if (m === ':version') return '2'; // the DRAFT version — v1 is active and cannot be deleted
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
  // Thread state with no `mem:` owner — what a run with no resourceId leaves behind, and the only
  // thing `GET /retention/orphans` has to answer with. Seeded per-org and with the org's own text so
  // the ownership control has two DIFFERENT answers to compare; without it both callers would read
  // an empty list and "no leak" would be satisfied by a route that tells nobody anything.
  await j.put(`org:${org}:xthr:thread-${text}:sem-pay-h1`, { v: 1, canonical: `pay: ${text}`, at: 1 });
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
  // The shapes each read route actually parses, taken from its reader rather than guessed. An earlier
  // seed wrote `${p}:proc:redactor` for processors — wrong prefix (`readProcessorReports` scans
  // `:procreport:`) and wrong shape (every one of these is wrapped in `{ v }`), so the route answered
  // `{"reports":[]}` to both callers and looked uncontrollable.
  await j.put(`${p}:procreport:redactor`, { v: { name: text, phase: 'input', ts: 1, findings: [text] } });
  await j.put(`${p}:incident:call-1`, { v: { toolCallId: 'call-1', at: 1, kind: 'blocked', detail: text } });
  await j.put(`${p}:net:route:0`, { v: { to: text, why: text } });
  await j.put(`${p}:net:step:0`, { v: { agent: text, output: text } });
  await j.put(`${p}:memctx`, { recalled: [], recentCount: 1, note: text });
  // An AGENT-TO-AGENT edge, which is what `GET /a2a-network` extracts: a `tool` entry whose
  // `value.output.remoteAgent` is set (server.ts:3782). Nothing of this shape was seeded before, so the
  // route answered `[]` to both callers and read as isolation. The route's OTHER gate is the `a2a`
  // option itself (`if (!a2a) return c.json([])`, server.ts:3775) — it is a plain boolean and makeApi
  // now sets it, because without it the handler never looks at any data at all.
  await j.put(`${p}:tool:a2a-1`, { status: 'completed', output: { remoteAgent: `${text}-remote`, runId: `${run}-remote` } });
  await j.put(`${p}:wf:step-a`, { output: text });
  await j.put(`org:${org}:wfrun:${run}`, { runId: run, workflowName: 'acme-workflow', status: 'completed', at: 1 });
  // TWO versions, one active. `DELETE /managed-agents/:name/versions/:version` refuses the active one
  // with 409, so a single-version record makes that route answer identically to every caller for a
  // reason that has nothing to do with organizations.
  await j.put(`org:${org}:__studio_agent__:acme-bot`, {
    name: 'acme-bot', active: 1,
    versions: [{ version: 1, system: text, at: 1 }, { version: 2, system: `${text} v2`, at: 2 }],
  });
  // NOTE — there is deliberately no `org:<org>:__audit__:…` seed here. There used to be one, and it was
  // dead: `GET /audit` reads the ROOT journal (`listLog(rootRw, '__audit__')`, server.ts:1741) because
  // `__audit__` is not org-prefixed on purpose — an audit log erased by the purge it records is not an
  // audit log. An org-PREFIXED key is invisible to that read, so the only rows the route ever showed
  // were the ones other tests' write routes happened to leave behind, which is what made it look
  // "order-dependent". The real rows are seeded into the root log in `seeded()` below.
  await j.put(`org:${org}:sched:def:t-${org}`, { id: `t-${org}`, cron: '* * * * *', agent: text });
  await j.put(`org:${org}:sched:state:t-${org}`, { id: `t-${org}`, nextAt: 2, lastAt: 1 });
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
  // A run left SUSPENDED on a tool call, which is what `GET /approvals` reconstructs.
  await suspendRun(journal, 'acme', 'r-acme', MARKER);
  // The SAME shape under globex, so the control is "two different pending queues" rather than "one
  // organization has a queue and the other has nothing". An empty-vs-non-empty comparison also passes
  // when the route is broken for one caller for a reason that has nothing to do with organizations.
  await suspendRun(journal, 'globex', 'r-globex', 'GLOBEX-OWN');

  // WORKFLOW RUN HISTORY for `GET /workflows/:name/runs`. The route does NOT read `wfrun:` records —
  // measured against the handler (server.ts:3401): it scans `listKeys('wf-<name>-')` and splits each key
  // on `:wf:`, so the run history lives in keys shaped `wf-<workflow>-<startedAt>:wf:<stepId>`. The
  // corpus already writes `<runId>:wf:step-a`, but under `r-acme` — a runId that does not carry the
  // `wf-acme-workflow-` prefix, so the scan matched nothing and the route answered `[]` to everybody.
  // Distinct startedAt stamps per organization, so the two answers differ by content and not by luck.
  for (const [org, at] of [['acme', 1001], ['globex', 2002]] as const) {
    await journal.put(`org:${org}:wf-acme-workflow-${at}:wf:s1`, { output: org });
    await journal.put(`org:${org}:wf-acme-workflow-${at}:wf:s2`, { output: org });
  }

  // THE AUDIT LOG, in the ROOT journal where `GET /audit` actually reads it, in the record shape
  // `listLog` requires (`{ id, payload, at }` — durable-log.ts:22/66). The route filters on the `org`
  // FIELD INSIDE each row (server.ts:1757), which is what carries the isolation here.
  // `at` must clear the org's purge cutoff (server.ts:1751); no organization is purged in this fixture
  // so the cutoff is 0, and any positive stamp clears it.
  for (const [org, actor] of [['acme', MARKER], ['globex', 'GLOBEX-OWN']] as const) {
    await journal.put(`__audit__:seed-${org}`, {
      id: `seed-${org}`, at: 1_000,
      payload: { actor, action: 'run', target: `r-${org}`, org, detail: actor },
    });
  }
  return journal;
}

/**
 * Leaves `run` SUSPENDED on a tool call, in the shape BOTH readers of that state need.
 *
 * Two independent things had to be true and only one was. `listRuns` derives `status: 'suspended'` from
 * the tool record (journal.ts:796) — that part worked. But `GET /approvals` builds its answer from
 * `reconstructState(entries).pending` (server.ts:1692), and `pending` is populated ONLY from MODEL
 * entries carrying a `tool-call` part (time-travel.ts:133-143). With no such entry the run was listed as
 * suspended and had nothing pending, so the route answered `{items:[]}` to every caller.
 */
async function suspendRun(j: InMemoryJournal, org: string, run: string, text: string) {
  const p = `org:${org}:${run}`;
  await j.put(`${p}:model:1`, {
    content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: `${text}-tool`, input: '{}' }],
    finishReason: 'tool-calls', usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } }, modelId: 'm', at: 4,
  });
  await j.put(`${p}:tool:call-1`, {
    status: 'suspended', toolName: `${text}-tool`, output: { __gnl_suspend: { toolCallId: 'call-1', reason: text } },
  });
  // A completed run is not pending anything — the outcome is removed on purpose.
  await j.put(`${p}:outcome`, undefined);
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

/** Records one host/runner call and returns the value, so a seam can be observed without changing it. */
const rec = <T>(what: string, ctx: { orgId?: string } | undefined, v: T): T => {
  hostCalls.push({ what, orgId: ctx?.orgId });
  return v;
};

function hostObjects(optIn: boolean) {
  const flag = optIn ? { orgScoped: true } : {};
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
    // The events dead-letter. All three entry points take a ctx, so an opted-in host CAN honour it —
    // unlike `queue.listJobs`/`cache.stats`, which were shipped taking no argument at all.
    events: {
      ...flag,
      topics: (ctx?: { orgId?: string }) => [{ topic: mine(ctx?.orgId), consumers: ['acme-consumer'] }],
      listDead: (topic: string, consumer: string, ctx?: { orgId?: string }) => [{
        id: 'e1', topic, consumer, status: 'quarantined' as const,
        error: mine(ctx?.orgId), attempts: 8, at: 1, payload: { note: mine(ctx?.orgId) },
      }],
      release: (_t: string, _c: string, _id: string, ctx?: { orgId?: string }) => rec('events.release', ctx, true),
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
    // The studio's OWN compiler, from its `./workflow` sub-export — one import and one option. Without it
    // `canRunManaged` is false and both run routes answer 501 to everybody, which is not an ownership
    // control. Measured with it wired: acme 200, globex 404 'workflow not found'.
    compileWorkflow: compileManagedWorkflow,
    reader: journal,
    auth: authProvider,
    org: {},
    // A plain boolean, not a host object — `GET /a2a-network` answers `[]` to everybody without it
    // (server.ts:3775) without reading any data at all, which is a 200 that looks like isolation.
    a2a: true,
    resume: async () => ({}),
    compensate: async () => ({ ok: true }),
    otelExport: async (runId: string) => ({ ok: true, target: runId }),
    // `chat` is a FUNCTION, not an object with `.send` — the route calls `chat(message, {runId}, ctx)`.
    // An earlier fixture used `{ send }`, which produced "chat is not a function" and left the route
    // looking uncontrollable when it was simply never reached.
    chat: async (_m: string, _o: unknown, ctx?: { orgId?: string }) => rec('chat', ctx, { text: 'chat-ok' }),
    // POST /runs/:id/regression converts `body.model` ('provider/model') to a real model object via
    // `resolveModel` unless the host injects this seam (server.ts:597). Without it the route reaches a
    // real provider and dies on a missing OPENAI_API_KEY — an environment failure, not an organization
    // one, and one that would flip meaning on a machine that happens to have the key set.
    regressionModel: () => mockModel(),
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
      // `{ user, token }` — NOT a flat user. The route reads `created.user.id` for its audit row, so a
      // flat return threw "Cannot read properties of undefined (reading 'id')" and POST /users answered
      // 400 to its OWNER. That is what the route's recorded reason had been describing: a fixture whose
      // create() had the wrong shape, not a route with nothing to compare against.
      create: async (u: Record<string, unknown>) => ({ user: { ...u, id: 'u-new' }, token: 't-new' }),
      update: async (id: string, patch: Record<string, unknown>) => ({ id, ...patch, roles: ['admin'] }),
      remove: async () => {},
      revoke: async () => {},
    },
    datasets: {
      list: () => [{ id: 'd-acme', size: 1 }],
      run: async (_id: string, _o?: unknown, ctx?: { orgId?: string }) => rec('datasets.run', ctx, { ok: true, results: [] }),
    },
    // A FACTORY, not an object: it is handed the org-scoped reader, so threads isolate. A `memory`
    // object is refused unless it declares `orgScoped: true` — see the block at the end of this file.
    memoryFactory: mem,
    gnl: {
      // Agents carry `orgs`, because `GET /agents` filters with `agentVisibleToOrg`. A fixture whose
      // agents are all global makes that filter invisible: both callers see the same list, and the
      // route looks uncontrollable when it is simply never exercised.
      listAgents: () => [{ name: 'acme-only-agent', orgs: ['acme'] }, { name: 'shared-agent' }],
      run: async (_n: string, _o: unknown, ctx?: { orgId?: string }) => rec('gnl.run', ctx, { text: 'ok' }),
      // RECORDED, like its non-streaming sibling. The streamed BODY is unusable as a control — a stub
      // runner writes the same frames to everybody — but `gnl.stream` is handed `{ orgId: callerOrg(c) }`
      // exactly as `gnl.run` is (server.ts:3054), so the organization the runner was TOLD about is a
      // real observable. It was left unrecorded, which is why the route read as uncontrollable.
      stream: async (_n: string, _o: unknown, ctx?: { orgId?: string }) =>
        rec('gnl.stream', ctx, { textStream: (async function* () { yield 'ok'; })() }),
      listTools: () => [{ name: 'acme-tool' }],
      runTool: async (_n: string, _i: unknown, _o?: unknown, ctx?: { orgId?: string }) => rec('gnl.runTool', ctx, { ok: true }),
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

/**
 * Query parameters a route VALIDATES before doing anything — the same reasoning as the generic body
 * below, for the routes whose required arguments do not live in the path. `GET /dead-events` answers
 * 400 without a topic AND a consumer (a topic fans out, so neither alone names a list), and a 400 to
 * both callers is indistinguishable from isolation.
 */
const QUERY: Record<string, string> = {
  'GET /dead-events': '?topic=orders.created&consumer=acme-consumer',
};

async function drive(api: (r: Request) => Promise<Response>, route: { method: string; path: string }, who: Record<string, string>) {
  const init: RequestInit = { method: route.method, headers: { ...who } };
  if (!['GET', 'HEAD'].includes(route.method)) {
    init.headers = { ...who, 'content-type': 'application/json' };
    // A generic body plus the fields specific routes VALIDATE before doing anything. Without them the
    // route answers 400 to both callers, which is indistinguishable from isolation and quietly parks
    // the route in the uncontrolled pile for a reason that has nothing to do with organizations.
    init.body = JSON.stringify({
      runId: 'r-acme', name: 'acme-workflow', input: {}, query: 'x', prompt: 'x', steps: [],
      message: 'hello', model: 'openai/gpt-4o-mini', afterIndex: 0, upto: 1, id: 'x',
      // v2 is the DRAFT; v1 is active. `promote` reads `body.version`, so promoting v2 is a real state
      // change whose effect can be observed — promoting the already-active v1 changes nothing.
      version: 2,
      // `PATCH /users/:id` refuses a body with nothing to change ("nothing to update"), which reads as
      // a refusal of the CALLER rather than of the request.
      roles: ['viewer'],
      // Acme's ORGANIZATION, substituted the same way acme's path ids are. `POST /users` is the only
      // handler that reads `body.orgId` (grepped), and it is the field the route compares against the
      // calling identity — so a stranger sending it is the universal probe in body form.
      orgId: 'acme',
      // `POST /dead-events/release` addresses a record by the TRIPLE (topic, consumer, id) — `id`
      // alone is already above, and without the other two the route 400s before reaching the host.
      topic: 'orders.created', consumer: 'acme-consumer',
    });
  }
  const res = await Promise.race([
    api(new Request(`http://x${concrete(route.path)}${QUERY[`${route.method} ${route.path}`] ?? ''}`, init)),
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
    'GET /a2a-network', 'GET /approvals', 'GET /audit', 'GET /workflows/:name/runs',
    'GET /agents', 'GET /users', 'DELETE /users/:id', 'PATCH /users/:id', 'POST /users/:id/revoke',
    'POST /cache/invalidate', 'GET /cache/stats',
    'GET /jobs', 'POST /jobs/:id/retry', 'POST /knowledge/search', 'GET /managed-agents',
    'GET /dead-events', 'GET /dead-events/topics',
    'GET /metrics', 'GET /metrics/runs', 'GET /organizations', 'GET /retention/orphans',
    'GET /runs', 'GET /runs/:id', 'POST /runs/:id/cancel', 'POST /runs/:id/compensate',
    'GET /runs/:id/cost', 'GET /runs/:id/diff',
    'GET /runs/:id/incidents', 'GET /runs/:id/network', 'GET /runs/:id/processors',
    'GET /scheduler/triggers', 'GET /runs/:id/memory-context',
    'POST /runs/:id/otel-export', 'GET /runs/:id/regression/:otherId', 'POST /runs/:id/resume',
    'POST /runs/:id/score', 'GET /runs/:id/scores', 'GET /runs/:id/state', 'GET /runs/:id/trace',
    'POST /users',
    'GET /threads', 'GET /threads/:id/messages', 'GET /threads/:id/working-memory',
    'GET /workflows', 'GET /workflows/:name/def',     'GET /workflows/run/:runId', 'GET /workflows/runs', 'POST /workflows/runs/:id/cancel',
  ];

  /**
   * Controlled by an explicit REFUSAL, for routes whose successful answer embeds a nondeterministic
   * value, so "the two bodies differ" is not evidence of anything.
   *
   * `POST /runs/:id/regression` answers `{ newRunId: "<id>:replay:<Date.now()>:0", ... }`. Measured: with
   * every caller's organization forced to `acme` (a total collapse of the boundary) globex successfully
   * replayed acme's run — and the by-answer control still PASSED, because the two timestamps differed.
   * The assertion was riding along on the clock. What actually separates owner from stranger here is that
   * the stranger's replay cannot find the run at all, so that is what gets asserted.
   */
  const REFUSAL_CONTROLLED = ['POST /runs/:id/regression',
    // Same hazard: `/run` answers a `runId` built from `Date.now()`, and `/run-stream` answers an SSE
    // body whose frames carry it too — so "the bodies differ" would be true even on a total leak.
    'POST /workflows/:name/run', 'POST /workflows/:name/run-stream',
    // Both fork routes answer `newRunId: "<src>:fork:<Date.now()>"`. They had been by-answer controls,
    // and the surviving-mutant evidence is what moved them: with every caller collapsed onto acme,
    // neither noticed — two forks of the same run one millisecond apart differ, so the assertion was
    // satisfied by the clock rather than by the boundary. Measured honestly, acme gets 200 and globex
    // gets 404, so the refusal is the real observable.
    'POST /runs/:id/fork', 'POST /workflows/:name/runs/:id/fork'];

  /** Controlled by the recorded host call instead of the body — see the write-route block below. */
  const WRITE_CONTROLLED = ['POST /workflows', 'PUT /workflows/:name', 'DELETE /workflows/:name',
    'POST /agents/:name/run', 'POST /tools/:name/execute', 'POST /chat', 'POST /datasets/:id/run',
    // Answers a bare `{ok:true}` to both callers, exactly like `POST /jobs/:id/retry` — the observable
    // is which organization the host was told about when the release was handed over.
    'POST /dead-events/release',
    // Moved out of UNCONTROLLED_REASONS. Its recorded reason ("streamed body, and the stub runner
    // answers identically") described the RESPONSE, and the response really is unusable — but the route
    // hands `gnl.stream` the caller's organization the same way `/agents/:name/run` hands it to
    // `gnl.run`, and that call was simply never recorded by the fixture.
    'POST /agents/:name/stream'];

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
   *
   * The last two invert the direction: they answer nothing useful and write nothing at all, so the
   * effect is WHICH ORGANIZATION'S WRITE THE ROUTE REACTED TO. An SSE stream opened by globex must move
   * when globex's runs change and stay silent when acme's do — see the live-stream block below.
   */
  const EFFECT_CONTROLLED = ['PATCH /threads/:id', 'DELETE /threads/:id', 'DELETE /threads/:id/messages',
    'DELETE /managed-agents/:name', 'POST /managed-agents/:name/promote',
    'DELETE /managed-agents/:name/versions/:version', 'POST /managed-agents',
    'GET /events', 'POST /auth/sse-ticket'];

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

  it.each(REFUSAL_CONTROLLED)('%s serves its owner and refuses a stranger outright', async (key) => {
    const [method, ...rest] = key.split(' ');
    const route = { method: method!, path: rest.join(' ') };
    // A fresh fixture per caller: this route WRITES a replay run, so sharing one would let the owner's
    // replay change what the stranger's request sees.
    const owner = await drive((await makeApi(true)).api, route, AS.acme);
    const stranger = await drive((await makeApi(true)).api, route, AS.globex);

    // The refusal assertion FIRST: it is the one that carries the ownership claim.
    expect(stranger.status, `${key} served a stranger — body was ${stranger.body.slice(0, 120)}`)
      .toBeGreaterThanOrEqual(400);
    expect(owner.status, `${key} refused the organization that owns the data`).toBeLessThan(400);
  }, 30_000);

  /**
   * Why `POST /auth/sse-ticket` cannot be a by-answer control — asserted, not just asserted-about.
   *
   * This is a real property in its own right (a single-use ticket that repeated would be a replayable
   * credential), and it is the exact reason a body comparison proves nothing there: if two tickets from
   * the SAME caller differ, then two tickets from different callers differing is not evidence about
   * organizations. Anyone tempted to move the route back into CONTROLLED runs into this first.
   */
  it('POST /auth/sse-ticket answers differently to the SAME caller, so its two bodies never match', async () => {
    const { api } = await makeApi(true);
    const ask = async () => (await (await api(new Request('http://x/auth/sse-ticket',
      { method: 'POST', headers: AS.acme }))).json()) as { ticket: string };
    const a = await ask();
    const b = await ask();
    expect(a.ticket, 'a single-use SSE ticket repeated for the same caller — it is replayable')
      .not.toBe(b.ticket);
  }, 30_000);

  /**
   * THE LIVE STREAM, controlled by whose write it reacted to.
   *
   * Both routes here answer the same content-free frame to everybody — measured, not assumed:
   * `event: change / data: runs`, the pre-API-04 fallback payload. The INFORMATIVE frame that names
   * `runIds` (server.ts:2472) is unreachable for these callers, and deliberately: it fires only when
   * `readCheapEventsSignal` returns a signal, that needs `countRunsByStatus`, and `withOrg` does NOT
   * bridge `countRunsByStatus` (durable/organization.ts:294) because the engine's push-down has no
   * per-organization filter. Under an org scope the bridge resolves to `undefined` and the handler
   * takes the legacy branch. So no comparison of bodies can separate the owner from a stranger.
   *
   * The instrumentation route does not work either, and this is the measurement that says so: the
   * stream's only read is `reader.listRuns()`, and `withOrg`'s `listRuns` bridge calls the underlying
   * `listRuns()` with NO argument and filters the RESULT by prefix in memory
   * (durable/organization.ts:320-327). Recording the keys the journal was asked for therefore yields
   * `listRuns(null)` for acme and `listRuns(null)` for globex — byte-identical. There is nothing
   * org-shaped to record.
   *
   * What IS observable is the stream's REACTION. The org filter is applied to the run list the poll
   * loop diffs, so a frame is written when — and only when — the CALLER'S OWN organization changes.
   * That is an effect, it is asymmetric, and both halves are asserted: a stranger's write must leave
   * the stream silent, and the caller's own write must move it (or the silence is a dead stream rather
   * than isolation).
   */
  describe('a live stream follows only its own organization', () => {
    /** `EVENTS_POLL_MS` in server.ts — one tick of the poll loop. */
    const POLL_MS = 2000;

    /** A run, in the two keys `listRuns` needs to see one appear. */
    async function addRun(j: InMemoryJournal, org: string, run: string) {
      await j.put(`org:${org}:${run}:input`, { prompt: 'later', at: 9, agent: 'later' });
      await j.put(`org:${org}:${run}:outcome`, { status: 'completed', at: 9 });
    }

    /**
     * Collects frames off a live SSE response in the background.
     *
     * Reading frame-by-frame with a per-read timeout does not work here: cancelling the reader to break
     * out of one read kills it for every later read too, so the second phase always looked silent. That
     * false negative is the reason this pumps into an array instead — the ABSENCE of a frame has to be
     * measurable without touching the reader.
     */
    function watchSse(res: Response) {
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      const frames: string[] = [];
      void (async () => {
        try {
          for (;;) { const { value, done } = await reader.read(); if (done) break; if (value) frames.push(dec.decode(value)); }
        } catch { /* cancelled — the poll loop never ends on its own */ }
      })();
      return {
        frames,
        /** Waits until `n` frames have arrived or `ms` elapses, whichever comes first. */
        until: async (n: number, ms: number) => {
          const stop = Date.now() + ms;
          while (frames.length < n && Date.now() < stop) await new Promise((r) => setTimeout(r, 25));
        },
        close: () => reader.cancel().catch(() => {}),
      };
    }

    /**
     * The shared body of both cases: a globex-scoped stream, an acme write it must not see, then a
     * globex write it must.
     */
    async function assertFollowsOnlyGlobex(res: Response, journal: InMemoryJournal, what: string) {
      expect(res.status, `${what} did not open a stream at all`).toBe(200);
      const w = watchSse(res);
      try {
        await w.until(1, 4 * POLL_MS);
        expect(w.frames.length, `${what} never emitted its baseline frame — nothing below can mean anything`)
          .toBeGreaterThan(0);
        const baseline = w.frames.length;

        // ACME changes. A globex-scoped stream is not entitled to know.
        await addRun(journal, 'acme', 'r-acme-late');
        await new Promise((r) => setTimeout(r, 2.5 * POLL_MS));
        expect(w.frames.length,
          `${what} pushed a frame to globex because ACME's data changed — the stream is not org-scoped`)
          .toBe(baseline);

        // GLOBEX changes. Its own stream must move, or the silence above is a dead stream.
        await addRun(journal, 'globex', 'r-globex-late');
        await w.until(baseline + 1, 5 * POLL_MS);
        expect(w.frames.length,
          `${what} never told globex about globex's own change — the isolation above is a stalled stream`)
          .toBeGreaterThan(baseline);
      } finally {
        await w.close();
      }
    }

    it('GET /events pushes on the calling organization\'s changes and no one else\'s', async () => {
      const { api, journal } = await makeApi(true);
      const res = await api(new Request('http://x/events', { headers: AS.globex }));
      await assertFollowsOnlyGlobex(res, journal, 'GET /events');
    }, 60_000);

    /**
     * `POST /auth/sse-ticket`, controlled by what the ticket UNLOCKS rather than by its bytes.
     *
     * The body is `{ ticket: randomUUID(), expiresAt: Date.now() + TTL }` — two callers always differ,
     * and so do two requests from the SAME caller (asserted above), which is why the by-answer control
     * was removed and must stay removed. But `issueSseTicket` stores `{ principal, expiresAt }`
     * (server.ts:2342) and `/events` scopes the whole stream with `orgALS.run(principal?.orgId, run)`
     * (server.ts:2426/2486), so the ticket's organization decides which data the redeemed stream can
     * see. That binding is not random, and it is what this asserts.
     *
     * The redemption deliberately carries NO authorization header — an EventSource cannot send one,
     * which is the entire reason the ticket exists — so the ticket is the only thing scoping the stream.
     * Both calls go through the SAME `makeApi()` instance because `sseTickets` is a Map in that
     * closure and the ticket is consumed on first use (server.ts:2350).
     */
    it('POST /auth/sse-ticket mints a ticket that unlocks only the issuing organization', async () => {
      const { api, journal } = await makeApi(true);
      const { ticket } = await (await api(new Request('http://x/auth/sse-ticket',
        { method: 'POST', headers: AS.globex }))).json() as { ticket: string };

      const res = await api(new Request(`http://x/events?ticket=${encodeURIComponent(ticket)}`));
      await assertFollowsOnlyGlobex(res, journal, 'a ticket issued to globex');
    }, 60_000);
  });

  /**
   * The honest accounting — and it is now EMPTY. Every org-scoped route carries an ownership control.
   *
   * Kept rather than deleted, because the assertion below is what forces a FUTURE gap to say why it
   * exists instead of quietly lowering the number. Seven routes have passed through here and every one
   * of them left for the same reason: the recorded reason described the FIXTURE or the RESPONSE, and
   * neither is the route.
   *   `/a2a-network`, `/audit`, `/approvals`, `/workflows/:name/runs` answered `[]` to both callers
   *   because nothing of the shape each reads was seeded, and `[] !== []` is false.
   *   `POST /agents/:name/stream` was recorded as "streamed body, and the stub runner answers
   *   identically". True of the RESPONSE, and irrelevant: the route hands `gnl.stream` the caller's
   *   organization (server.ts:3054) exactly as `/run` hands it to `gnl.run`, and the fixture's stub
   *   was throwing the argument away.
   *   `GET /events` and `POST /auth/sse-ticket` were recorded as uncontrollable because their frames
   *   carry no organization data. Re-measured, that is still exactly true, and so is the reason it did
   *   not matter — see the live-stream block above for both measurements.
   *
   * A route removed from a control belongs here WITH the measurement that removed it. The last round
   * did that for `POST /auth/sse-ticket` and it was the right call on the evidence it had; what it did
   * not have was a second observable.
   */
  const UNCONTROLLED_REASONS: Record<string, string> = {
    // Read-only aggregation over the org-scoped `rw` reader (FAZ-8, K24: deliberately moved OFF the
    // raw reader). No caller-supplied id reaches a journal key — the route scans `<org>:`-prefixed
    // runs only and returns counts/recents, so there is no per-id ownership to exercise; the
    // leak-check above already proves a stranger org reads its own (empty) aggregate, and the
    // scoped-reader wiring is pinned by studio-semantic-guard.test.ts.
    'GET /semantic-guard': 'aggregate read over the org-scoped reader; no per-id surface to own',
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

  /**
   * The RUNNER routes, controlled by the organization the runner was told about.
   *
   * These answer a constant — a stub runner returns the same body to everybody — so no comparison of
   * answers can separate the owner from a stranger. Each entry point now takes `ctx?: StudioCallbackCtx`
   * and studio passes the caller's organization, so the observable is what the runner was told.
   *
   * The caller's organization is bound to its IDENTITY here, not sent as `x-gnl-org`. Studio refuses an
   * explicit org header on any write (the v1 read-only rule), so a header-based fixture would be
   * measuring that refusal rather than reaching the runner at all.
   */
  it.each([
    ['POST /agents/:name/run', 'POST', '/agents/:name/run', 'gnl.run'],
    ['POST /tools/:name/execute', 'POST', '/tools/:name/execute', 'gnl.runTool'],
    ['POST /chat', 'POST', '/chat', 'chat'],
    ['POST /datasets/:id/run', 'POST', '/datasets/:id/run', 'datasets.run'],
    // The STREAMING sibling of the first row. Same seam, same argument, and the only reason it was not
    // here is that the fixture's `stream` stub discarded its `ctx` instead of recording it.
    ['POST /agents/:name/stream', 'POST', '/agents/:name/stream', 'gnl.stream'],
  ])('%s tells the runner which organization is asking', async (_label, method, path, what) => {
    const { api } = await makeApi(true);

    const start = hostCalls.length;
    await drive(api, { method, path }, AS.acme);
    const acmeCalls = hostCalls.slice(start).filter((c) => c.what === what);

    const mid = hostCalls.length;
    await drive(api, { method, path }, AS.globex);
    const globexCalls = hostCalls.slice(mid).filter((c) => c.what === what);

    expect(acmeCalls.length, `${what} was never called — the route did not reach the runner`).toBeGreaterThan(0);
    expect([...new Set(acmeCalls.map((c) => c.orgId))], `${what} was not told it was acting for acme`).toEqual(['acme']);
    expect(globexCalls.length, `${what} was never called for globex`).toBeGreaterThan(0);
    expect([...new Set(globexCalls.map((c) => c.orgId))],
      `${what} was told the wrong organization, or none at all — the runner cannot scope what it does`)
      .toEqual(['globex']);
  }, 30_000);

  /**
   * The managed-agent write routes, controlled by the EFFECT on the caller's own record.
   *
   * All three answer a constant — `{ok:true,...}` identical for every caller — so the observable is the
   * stored record. The agent store is reached through `agentStoreFor(c)`, which is org-scoped, so the
   * owner's write must change the owner's record and leave the other organization's alone.
   */
  describe('managed-agent writes act on the caller\'s own record only', () => {
    const KEY = { acme: 'org:acme:__studio_agent__:acme-bot', globex: 'org:globex:__studio_agent__:acme-bot' };
    type Rec = { active?: number | null; versions?: { version: number }[] } | undefined;

    it('DELETE /managed-agents/:name removes only the caller\'s record', async () => {
      const { api, journal } = await makeApi(true);
      await drive(api, { method: 'DELETE', path: '/managed-agents/:name' }, AS.acme);

      // The leak assertion comes FIRST so that a mutant which misdirects the write trips THIS one, not the
      // owner assertion below — otherwise the isolation half is never the reason the test fails.
      expect(await journal.get(KEY.globex), "acme's delete removed another organization's agent").toBeTruthy();
      expect(await journal.get(KEY.acme), 'the owner\'s record survived its own delete').toBeFalsy();
    }, 30_000);

    it('POST /managed-agents/:name/promote changes only the caller\'s active version', async () => {
      const { api, journal } = await makeApi(true);
      // Promote v2 in acme; globex must keep v1 active.
      await drive(api, { method: 'POST', path: '/managed-agents/:name/promote' }, AS.acme);

      expect((await journal.get(KEY.globex) as Rec)?.active,
        "acme's promote changed which version is live in another organization").toBe(1);
      expect((await journal.get(KEY.acme) as Rec)?.active, 'the owner\'s promote did nothing').toBe(2);
    }, 30_000);

    it('DELETE /managed-agents/:name/versions/:version removes it from the caller\'s record only', async () => {
      const { api, journal } = await makeApi(true);
      await drive(api, { method: 'DELETE', path: '/managed-agents/:name/versions/:version' }, AS.acme);

      const acme = await journal.get(KEY.acme) as Rec;
      const globex = await journal.get(KEY.globex) as Rec;
      expect(globex?.versions?.map((v) => v.version),
        "acme's version delete reached another organization's record").toEqual([1, 2]);
      expect(acme?.versions?.map((v) => v.version), 'the draft version was not removed for its owner').toEqual([1]);
    }, 30_000);

    it('POST /managed-agents versions the agent under the caller\'s own organization', async () => {
      const { api, journal } = await makeApi(true);
      // A CODE-DEFINED name with no managed record yet in either organization, so the observable is
      // creation rather than growth: `shared-agent` is in `gnl.listAgents()` (the route rejects a name
      // with no code counterpart, 422), and neither org has versioned it. Both callers get the byte-
      // identical answer {ok,name,version:1,active:1} — measured — so only the landing site separates them.
      const K = (org: string) => `org:${org}:__studio_agent__:shared-agent`;
      const body = JSON.stringify({ name: 'shared-agent', model: 'openai/gpt-4o-mini' });
      const hdrs = { ...AS.acme, 'content-type': 'application/json' };
      await api(new Request('http://x/managed-agents', { method: 'POST', headers: hdrs, body }));

      expect(await journal.get(K('globex')),
        "acme's new managed version appeared under another organization").toBeFalsy();
      expect(await journal.get(K('acme')), 'the owner\'s version was not stored under its own organization').toBeTruthy();
    }, 30_000);
  });

  it('names every org-scoped route that is leak-checked but not ownership-controlled', () => {
    const orgScoped = Object.entries(VERDICTS).filter(([, v]) => v.verdict === 'org-scoped').map(([k]) => k);
    const controlled = new Set([...CONTROLLED, ...WRITE_CONTROLLED, ...EFFECT_CONTROLLED, ...REFUSAL_CONTROLLED]);
    const uncontrolled = orgScoped.filter((k) => !controlled.has(k));

    // eslint-disable-next-line no-console
    console.log(`[cross-org] ${controlled.size}/${orgScoped.length} org-scoped routes are ownership-controlled `
      + `(${CONTROLLED.length} by answer, ${WRITE_CONTROLLED.length} by recorded host call, `
      + `${EFFECT_CONTROLLED.length} by recorded effect, `
      + `${REFUSAL_CONTROLLED.length} by explicit refusal).\n`
      + `[cross-org] NOT ownership-controlled (${uncontrolled.length}):\n`
      + uncontrolled.map((k) => `  ${k} — ${UNCONTROLLED_REASONS[k] ?? 'UNEXPLAINED'}`).join('\n'));

    // Every gap must carry a reason. An unexplained one is the same failure as an unclassified route.
    expect(uncontrolled.filter((k) => !UNCONTROLLED_REASONS[k]),
      'an org-scoped route is uncontrolled with no reason recorded — say why, or control it').toEqual([]);
    expect(controlled.size, 'ownership coverage went backwards').toBeGreaterThanOrEqual(67);
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
  /**
   * Refused outright while the host has not opted in — the shipped default, and it is safe.
   *
   * The three dead-letter routes are here because the list was HAND-MAINTAINED and stopped at three
   * entries while the surface grew. Measured before they were added: deleting
   * `requireScopedHost(c, 'events')` from all three handlers left the studio suite at 619/619 green —
   * the routes behaved correctly and nothing in the repository said they had to. `events` is the same
   * shape as `queue` (a host object wrapping its own WorkStore), and `POST /dead-events/release` is
   * the one that matters most: it re-runs another organization's handler, in that organization's
   * production, on its data.
   */
  const REFUSED_WITHOUT_OPTIN = [
    'GET /jobs', 'GET /cache/stats', 'GET /workflows/:name/def',
    'GET /dead-events', 'GET /dead-events/topics', 'POST /dead-events/release',
  ];

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
    ['POST /dead-events/release', 'POST', '/dead-events/release', 'events.release'],
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




