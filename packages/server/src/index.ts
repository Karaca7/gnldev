// @gnldev/server — serves the createGnl registry over HTTP (auto-REST + OpenAPI). Every endpoint
// descends into runDurable → exactly-once/durability inherited for free. (The durable counterpart of the common auto-REST pattern.)
import { Hono, type Context } from 'hono';
import { toFetchHandler, type FetchHandler } from './handler.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createGnl, agentVisibleToOrg, withOrg, withOrgStorage, scopeConfigToOrg, withSubjectJournal, withSubjectMemory, threadOwnerOf, type ThreadOwnership, ORG_RECORD_PRE, checkBudget, getOrgUsage, budgetsEnforceable, toJournal, asReaderJournal, appendLog, cancelAgentRun, RunLimitExceededError, ToolLoopDetectedError, RunThreadMismatchError, blockedErrorCode, upstreamFailure, sealRequestContext, fingerprintAgent, recordAgent, approveAgent, blockAgent, isAgentServable, listAgentRegistry, callerConflictCode, publicConflictDetail, describeProtections, formatProtections, teachingError, resolveWorkIdentity, runOwnerOf, decideRunAccess, userIdOf, type Caller, type RunDecision, type RunOwner, type RawJournal, type RequestContext } from '@gnldev/durable';
import type { CreateGnlConfig, Journal, JournalReader, BudgetLimit, UsageCostCache, RunLimits, ResolvedWorkIdentity, WorkScopeKind } from '@gnldev/durable';
import { makeGate, normalizeAuth, bindsIdentity, principalOf, isPlatformAdmin, callerKind, subjectIdProblem, actorIdOf, engineCallerOf, type AuthProvider, type ReadWriteAuth, type Principal, type PrincipalKind } from '@gnldev/auth';
// P0.4 @gnldev/workflow is zero-dependency (see its package.json) — depending on it
// from @gnldev/server is a clean one-way edge (server→workflow), NOT circular: @gnldev/durable's registry.ts
// deliberately stays workflow-agnostic (WorkflowLike is a structural type, no import) to avoid a
// durable→workflow edge; server has no such constraint and needs the real functions at runtime.
import { listWorkflowRuns, getWorkflowRunStatus, cancelWorkflowRun } from '@gnldev/workflow';
import type { WorkflowRunStatus } from '@gnldev/workflow';
import { buildOpenApi } from './openapi.js';
import { EDGE_ERROR_CODES } from './edge-errors.js';
import { pipeAgentStream } from './sse.js';

/** (audit: A2A unsigned) — signature window: a request with a timestamp this old/future is rejected (replay resistance). */
const A2A_TIMESTAMP_WINDOW_MS = 300_000; // ±300s

/**
 * Verifies the `x-gnl-signature`/`x-gnl-timestamp` header pair produced by @gnldev/a2a's
 * `createA2ATool({ secret })`: signature = HMAC-SHA256(secret, timestamp + '.' + rawBody) hex, compared
 * with `timingSafeEqual` (closed to timing attacks). A second layer INDEPENDENT of the existing auth gate
 * (makeGate/opts.auth) — one asks identity/permission, the other verifies message integrity/origin; both
 * are opt-in and don't affect each other.
 * Invalid/missing → Response (401); valid → undefined.
 */
function verifyA2ASignature(c: Context, rawBody: string, secret: string): Response | undefined {
  const signature = c.req.header('x-gnl-signature');
  const timestamp = c.req.header('x-gnl-timestamp');
  if (!signature || !timestamp) {
    return c.json({ error: 'A2A signature headers missing (x-gnl-signature/x-gnl-timestamp)', code: EDGE_ERROR_CODES.a2aSignatureMissing }, 401);
  }
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > A2A_TIMESTAMP_WINDOW_MS) {
    return c.json({ error: 'A2A timestamp outside window (±300s) — suspected replay', code: EDGE_ERROR_CODES.a2aTimestampInvalid }, 401);
  }
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
  const provided = Buffer.from(signature, 'hex');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return c.json({ error: 'A2A signature invalid', code: EDGE_ERROR_CODES.a2aSignatureInvalid }, 401);
  }
  return undefined;
}

/**
 * `Idempotency-Key` names the WORK — it is a `workKey` alias, and no longer a `runId` one.
 *
 * IT CHANGED AXIS, DELIBERATELY (package #5 of docs/RUNID-WORKKEY-HEYET-KARARI.md §8). FAZ-1 wired
 * this header to `body.runId`, which was the closest thing that existed at the time and the wrong
 * half of the pair: the IETF draft's key names the OPERATION a client is trying to perform, and a
 * client that retries sends the same key because it is the same job. That is a `workKey`'s
 * definition, word for word. A raw runId is an address the engine issued; nobody's gateway knows one.
 *
 * The consequence is visible and meant to be: the header now produces a derived `run1_` id, and in a
 * `'resource'` scope with nobody named it is REFUSED (§6) rather than run for nobody. That is louder
 * than what it replaced, and the loud direction is the cheap one — the quiet direction delivers one
 * caller's work to another caller's door.
 *
 * The precedence below is @gnldev/chat-adapter's, adopted rather than re-argued: whatever the BODY
 * said wins, the header only speaks when the body said nothing. A gateway, a proxy or a client
 * library commonly stamps this header on its own, while the body is a decision the calling
 * APPLICATION made — so header-first would let an intermediary silently change what a request means.
 *
 * Mutates the freshly parsed body rather than threading a new variable through ~60 lines of gates.
 * The object is per-request and local (parseJsonBody), and the A2A signature — computed over the RAW
 * bytes — has already been verified by the time this runs, so nothing downstream is deciding anything
 * on the strength of the body being untouched.
 */
function adoptIdempotencyKey(c: Context, body: { runId?: string; workKey?: string }): void {
  if (body.runId || body.workKey) return;
  const header = c.req.header('Idempotency-Key');
  if (header) body.workKey = header;
}

/**
 * The id this call will run under, worked out BEFORE the door is called.
 *
 * Three things here need the id and none of them can wait for the run to start: the ownership gate
 * reads `<runId>:input`, the cancel registry is keyed by it, and `X-Gnl-Run-Id` has to name the run
 * that answered. So the route resolves the identity itself — with @gnldev/durable's OWN gate
 * function, not a local copy of it (see resolveWorkIdentity's note) — and then hands the door the
 * `workKey`, never the id it just computed. The door resolves the same tuple and gets the same
 * answer; passing the id instead would silently drop the declaration, and the declaration is the
 * only readable answer to "which run was the invoice job?".
 *
 * The scope comes from the AGENT (`gnl.agent(name).workScope`), never from the request body: which
 * address a name is unique within is a property of the work, and the dangerous half of that enum
 * ('org' — see AgentConfig.workScope) must not be reachable from a request. The workflow door is the
 * documented exception and states its own reason.
 */
function identityOrError(
  resolve: () => ResolvedWorkIdentity,
): ResolvedWorkIdentity | { error: string } {
  try {
    return resolve();
  } catch (e) {
    // The gate's refusals are teaching sentences (both-identities, missing address) — 400 with the
    // engine's own words, because re-wording them here is how two surfaces end up explaining the
    // same rule differently.
    return { error: String((e as { message?: string })?.message ?? e) };
  }
}

/** Both halves absent — the one refusal the gate would phrase as an engine call, said as a route. */
const NO_IDENTITY = 'runId or workKey required (see docs: one names an id, the other names the work)';

/**
 * Is there WORK under this run already? — the one question behind two answers: the
 * `X-Gnl-Idempotency-Status` header (`replay` vs `new`) and the budget gate's exemption (a
 * continuation of existing work is not new spend).
 *
 * Asked of the run's owner, read the one way (`runOwnerOf`), and NOT of "does `<runId>:input`
 * exist". Every run birth writes its owner record first (ADR-0002), so a run that was born and failed
 * before it froze its input has a record and nothing else — and the engine runs its retry as a FIRST
 * run (`frozenInput` is undefined, `__gnlPriorRun` is false). Reading the bare record here made the
 * generate door answer `replay` where the stream door answered `new` for the same state, and let the
 * retry of an empty birth past the budget gate as a "resume" (measured,
 * test/prior-work-is-not-an-owner-record.test.ts).
 *
 *   - a record holding a frozen input (prompt/messages): prior work — the engine's own test;
 *   - a workflow record: prior work once a step left a trace (`<runId>:wf:*`), or its registry row
 *     exists (`wfrun:<runId>`: suspended, completed, canceled);
 *   - rows present with no record (legacy, or a record lost): prior work — something ran;
 *   - an owner record alone, a missing run, an unreadable one: no.
 *
 * The RAW journal: this is a decision, and a subject view hides rows.
 */
async function priorWork(journal: RawJournal, runId: string, known?: RunOwner): Promise<boolean> {
  const o = known ?? (await runOwnerOf(journal, runId));
  if (o.state !== 'owned') return false;
  if (!o.recorded) return true;
  const rec = o.record ?? {};
  if (rec.prompt !== undefined || rec.messages !== undefined) return true;
  if (o.kind !== 'workflow') return false;
  try {
    if ((await journal.get(`wfrun:${runId}`)) !== undefined) return true;
    if (typeof journal.listKeys === 'function') return (await journal.listKeys(`${runId}:wf:`, { limit: 1 })).length > 0;
    return (await journal.get(`${runId}:wf:_suspend`)) !== undefined;
  } catch {
    return false; // a reader that cannot answer is not evidence of prior work: the gate stays on
  }
}

/**
 * The header pair every run/stream response carries (§8's header contract).
 *
 * `X-Gnl-Run-Id` is a CORRELATION handle — the opaque id of the run this call landed on, for logs,
 * traces and Studio. It is NOT the retry key: to retry, send the same `workKey` again. That
 * distinction is the whole point of the split, and it only becomes visible once the id is derived —
 * a caller who names work has no other way to learn which run answered.
 *
 * `X-Gnl-Work-Key` is deliberately NOT echoed: headers are a log surface in practice (proxies, CDNs,
 * HAR files), and free text does not go there by default.
 */
function stampRunHeaders(res: Response, runId: string, prior?: boolean): Response {
  res.headers.set('X-Gnl-Run-Id', runId);
  if (prior !== undefined) res.headers.set('X-Gnl-Idempotency-Status', prior ? 'replay' : 'new');
  return res;
}

/** Same as the old `c.req.json()` `.catch(() => ({}))` behavior: malformed/empty body → `{}`. */
function parseJsonBody(raw: string): any {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/**
 * D4-FGA (EE-2): structural mirror of @gnldev/auth-ee's `FgaResource`/`FgaAction` — @gnldev/server does NOT
 * depend on the paid @gnldev/auth-ee package, so these are typed here rather than imported (see
 * `RestApiOptions.resourceAuth` below).
 */
export interface ResourceAuthResource {
  type: 'agent' | 'workflow' | 'tool' | 'run';
  id: string;
}
/**
 * The verbs @gnldev/server ACTUALLY dispatches, and the ones it does not.
 *
 * DISPATCHED: `'run'` (agent run/stream/resume, workflow run) and `'cancel'` (run/workflow cancel).
 *
 * NOT DISPATCHED: `'read'`. It is kept in the union because the union is open (`string & {}`) and a
 * host may dispatch its own verbs — but nothing in this package ever calls the gate with it, so a
 * host that writes an `action === 'read'` branch gets a rule that never runs. That was measured as a
 * real hazard rather than a cosmetic one: a signature that names a verb reads as a promise that the
 * verb is checked, and the read paths are exactly where subject binding was missing. Read
 * authorisation is decided by the caller's KIND (@gnldev/auth `callerKind`), not here.
 *
 * `'resume'` IS dispatched — but as `'run'`: resuming executes the agent and carries `approvals`,
 * so denying `run` while allowing `resume` would be the wrong way round (see the resume endpoint's
 * own note). The member stays for hosts that want to distinguish them in their own dispatch.
 */
export type ResourceAuthAction = 'run' | 'read' | 'cancel' | 'resume' | (string & {});

/** Per-request multi-organization (opt-in): resolve organization from the request → journal is scoped to that organization. */
export interface OrgOptions {
  /** Resolve the organization from the request. If not given, the `x-gnl-org` header is read. */
  /**
   * Takes a web `Request`, not a Hono `Context` — kept in step with @gnldev/studio, and for the same
   * reason: a host binding this handler from Express or Fastify has a Request and no Context.
   */
  resolve?: (req: Request) => string | undefined | Promise<string | undefined>;
  /** true → a request without an organization gets 400. false (default) → a request without an organization runs in the shared scope. */
  required?: boolean;
  /**
   * HARDENING (opt-in): reject any request whose resolved organization is NOT explicitly REGISTERED
   * (an `__org__:<id>` record written by studio's `POST /organizations`; a DELETED org is a `null`
   * tombstone → also rejected → its ghost tokens stop working). Default false = the legacy IMPLICIT-org
   * behavior (an org springs into existence on first activity, no registration needed) — byte-for-byte
   * unchanged. Turn ON for strict provisioning: only orgs you deliberately created may run. NOTE: requires
   * a registration PATH in the deployment (studio's org management, or a direct `__org__:<id>` write);
   * with it on and no such path, every org-scoped request is rejected. */
  requireRegistration?: boolean;
  /**
   * Ceiling on how many per-organization registries are held in memory at once (default 512).
   *
   * The cache is keyed by the RESOLVED organization id, and with `requireRegistration` off — the
   * default — that id is whatever `resolve` returned, i.e. the `x-gnl-org` header. Every distinct
   * value built a full `createGnl` registry and kept it forever, so a loop over random header values
   * grew the process until it died. Nothing in the request has to be valid for that: an unregistered
   * org is served, and serving it is what allocates.
   *
   * Least-recently-used entries are evicted past the cap. Eviction is state-preserving, and the parts
   * that could have made it otherwise were measured rather than assumed: an instance is a CACHE over
   * the org-scoped journal (memory comes from `memoryFactory(scoped)`, the frozen model spec lives in
   * the journal), `createGnl` opens no connections and starts no timers, the rebuild re-derives
   * `withOrg(base, id)` without double-scoping the key prefix, and cancellation is unaffected because
   * `inflight` hangs off the API closure keyed `org:<id>:<runId>` — not off the instance — so the key
   * survives a rebuild.
   *
   * The one exception is a `memoryFactory` that IGNORES its argument and returns a process-local store.
   * That is a split rather than a loss: an in-flight run holds the evicted instance by reference, so
   * for a window one organization has two live stores and half a conversation lands in the one nothing
   * will read again. A factory that uses the journal it is handed — which is why it is handed one —
   * has no such window.
   *
   * Raise it if you legitimately serve more than 512 organizations from one process and want them all
   * warm. A non-integer or a value below 1 is REJECTED at construction, `Infinity` included: the growth
   * this bounds is reachable by anyone who can send a header, so opting out of the bound is not a
   * setting, and a negative one used to spin the eviction loop forever.
   */
  maxInstances?: number;
}

export interface RestApiOptions {
  /** OpenAPI title. */
  title?: string;
  /**
   * Optional auth (opt-in). If not given, all endpoints are OPEN (existing behavior). Accepts an
   * AuthProvider (@gnldev/auth or the paid @gnldev/auth-ee) or a backward-compatible {read,write} predicate pair.
   * GET → read, POST → write.
   */
  auth?: AuthProvider | ReadWriteAuth;
  /**
   * DELIBERATE permission for a provider-less API in production. Auth remains opt-in; but in
   * NODE_ENV=production, calling createRestApi without `auth` throws a setup ERROR — silent fail-open is
   * disabled (audit #2). Set this flag to true if open access is genuinely intended. Outside production:
   * only a single console.warn on the first request.
   */
  allowOpenAccess?: boolean;
  /**
   * Opt-in multi-organization support: each request descends into that organization's journal (withOrg)
   * → runs, memory, and exactly-once guarantees are isolated per organization. The resolved organization
   * is injected into requestContext as `org` (visible to dynamic agents). The registry is lazily built
   * and cached per organization.
   */
  org?: OrgOptions;
  /**
   * Budget/quota FALLBACK limits (ENFORCED on the write path): an organization's effective limit is
   * journal's `__budget__:<id>`/`__budget__:default` (managed from Studio) > `perOrg[id]` > `default`.
   * A new run/stream/workflow request from an organization that is over budget gets 402 (resume remains
   * free — suspended work can finish). Even without this option, budgets written to the journal are
   * enforced (no limit → cost-free early exit).
   */
  budgets?: { default?: BudgetLimit; perOrg?: Record<string, BudgetLimit> };
  /**
   * SERVER-SIDE UPPER BOUND (opt-in) for per-run cost cap + loop detection. The `limits` in the
   * request body (client request) CANNOT EXCEED this cap — the effective limit for each field is computed
   * as `min(server, client)` (see `clampLimits`); if the client doesn't specify a field, the server cap
   * applies, and if neither server nor client specifies it, that field is never enforced. If neither is
   * given (default), behavior is preserved EXACTLY AS IS (unlimited).
   */
  limits?: RunLimits;
  /**
   * (audit: A2A unsigned) — opt-in A2A request verification: if given, the `x-gnl-signature`/
   * `x-gnl-timestamp` header pair produced by `@gnldev/a2a`'s `createA2ATool({ secret })` becomes REQUIRED on
   * `/agents/:name/run` POSTs (see verifyA2ASignature) — missing/wrong signature or a timestamp outside
   * ±300s → 401. If not given, behavior is preserved EXACTLY AS IS (unsigned requests are accepted as
   * before). Works TOGETHER WITH the existing auth gate (opts.auth) — the two are independent layers,
   * both must pass.
   */
  a2aSecret?: string;
  /**
   * D4-FGA (EE-2) opt-in hook: fine-grained (resource-scoped) authorization, consulted AFTER the existing
   * coarse gate (opts.auth) already allowed the request — on agents run/stream, workflows run, and the
   * two cancel endpoints (`/runs/:id/cancel`, `/workflows/runs/:id/cancel`). A denial → 403
   * `{error, code: 'resource_denied'}`, distinct from the coarse gate's 403 (which carries no `code`).
   * Structurally typed (`ResourceAuthResource`/`ResourceAuthAction` above) — @gnldev/server does NOT import
   * @gnldev/auth-ee; an EE user wires this to `createEnterpriseAuth(...).checkResource` (see @gnldev/auth-ee's
   * `createFga`/`EnterpriseAuthProvider.checkResource`), e.g.:
   *   resourceAuth: (p, r, a) => enterpriseAuth.checkResource!(p, r, a).then((res) => res.allowed)
   * If NOT given, behavior is preserved EXACTLY AS IS (no resource-level gate — existing coarse auth only).
   */
  resourceAuth?: (principal: Principal | null, resource: ResourceAuthResource, action: ResourceAuthAction) => Promise<boolean> | boolean;
  /**
   * Agent approval registry (opt-in governance gate, default false — BACKWARD COMPAT: existing
   * deployments are byte-for-byte unchanged). When true, run/resume/stream ALSO require the target
   * agent to be `approved` in the journal-backed registry (@gnldev/durable's `isAgentServable`) — a
   * pending/changed/blocked agent gets 403 `{error, code: 'agent_not_approved'}`. Every `config.agents`
   * entry is recorded (idempotent, fingerprinted) once at construction so a platform-admin can review
   * it via `GET /agents/registry` and approve/block it (see the `/agents/registry*` endpoints below) —
   * those endpoints are ALWAYS available (regardless of this flag) so approval can be set up ahead of
   * turning the gate on.
   */
  requireAgentApproval?: boolean;
  /**
   * The startup protection matrix (default ON). Set false when something ELSE is already printing
   * one for this config.
   *
   * That is not hypothetical: `gnl dev` mounts this host and prints its own matrix, and its version
   * knows one thing this one cannot — that the dev server DERIVES a memory store the project's
   * `src/app.ts` will not have. Two blocks describing the same config, one of them less informed, is
   * how a reader learns to skip both. This flag exists so there is exactly one.
   *
   * It is an opt-OUT rather than an opt-in on purpose: the matrix is most needed by the deployment
   * that has not thought about any of these rows.
   */
  protectionsBanner?: boolean;
  /**
   * Other wire formats for the SAME agent stream door — `chatSurface()` from @gnldev/chat-adapter
   * (useChat) and `aguiSurface()` from @gnldev/agui (AG-UI/CopilotKit).
   *
   * A surface translates bytes and nothing else. Who the caller is, which organization it is in,
   * whose run this is, and every gate a run crosses (auth, org scope, agent visibility, approval,
   * resource auth, thread and run ownership, budget, cancel registry) are decided HERE, by the same
   * code `/agents/:name/stream` runs. A surface mounted standalone had none of those and a second
   * identity resolver to re-derive what `auth` already knew; mounted here it has no identity input at
   * all, so there is nothing to forget to wire.
   */
  surfaces?: StreamSurface[];
  /**
   * Cross-origin access for browsers calling this API directly — the point of `roleAuth({ endUsers })`.
   * OFF by default: no CORS headers, a cross-origin preflight is not answered (same as before). Name
   * the origins that may call; `'*'` is accepted because credentials here are bearer tokens, not
   * cookies (no `Allow-Credentials` is ever sent). The allowed request headers and the exposed
   * response headers are this API's own (`X-Gnl-Run-Id`, `Idempotency-Key`, `Last-Event-ID`, ...).
   */
  cors?: { origins: string[] | '*'; maxAge?: number };
}

/** What a surface's decoder hands the stream door: the REST `/stream` body shape, plus a turn key. */
export interface StreamSurfaceInput {
  prompt?: string;
  messages?: unknown;
  threadId?: string;
  approvals?: Record<string, boolean>;
  context?: Record<string, unknown>;
  limits?: RunLimits;
  /** An explicit id — addressing already decided by the caller. */
  runId?: string;
  /** A declared name for the work (always a workKey). */
  workKey?: string;
  /**
   * The wire format's own name for this turn (useChat: `${id}:${lastMessage.id}`). Becomes a workKey
   * when the door resolves a subject, a raw runId otherwise — the regime the standalone routes had.
   */
  turnKey?: string;
  /**
   * The subject the BODY names. Read only for callers allowed to name one (application / operator);
   * a subject token's own id always wins — the same `resolveResourceId` rule REST applies.
   */
  resourceId?: unknown;
  lastEventId?: string | number;
}

/** A wire format mounted on createRestApi's stream door. See `RestApiOptions.surfaces`. */
export interface StreamSurface {
  /** POST path under this API; must contain `:name` (the agent). E.g. `/agents/:name/chat`. */
  path: string;
  /** Wire format in. Throwing answers 400. Must not decide identity — it is never asked. */
  decode(body: any, req: Request): StreamSurfaceInput | Promise<StreamSurfaceInput>;
  /** Wire format out, for a started run. Error responses before the run are the door's own (typed JSON). */
  encode(result: any, meta: { runId: string; threadId?: string; c: Context }): Response;
}

/**
 * Merge the server cap with the client request — the STRICTER one (smaller number) wins, the
 * client can NEVER loosen the server cap. If neither side gives a field, that field ends up absent (never
 * enforced) — the existing unlimited behavior is preserved.
 */
/** Longest accepted `resourceId`. Generous for a user id / customer key, short of an accidental blob. */
const MAX_RESOURCE_ID = 200;

/**
 * The caller of a deployment with no principal model — no auth provider, or one that binds no
 * identity (the `{read,write}` pair): whoever got past it is staff, because nothing else exists. Named
 * as a principal so it goes through the same mapping (`engineCallerOf`) as every other caller.
 */
const SINGLE_OPERATOR: Principal = Object.freeze({ kind: 'operator', roles: [] as string[] });

/**
 * The one sentence a client credential gets when it names nobody — written once, sent from both the
 * read gate and the write gate.
 *
 * Two copies of this string used to sit twenty lines apart, and the sentence they held ("resourceId is
 * required for a client credential: name the end user this request acts for") was accurate and taught
 * nothing. Consider who reads it: somebody who swapped an operator token for an application token,
 * watched every request start answering 400, and has no reason to suspect the two credentials are
 * governed by DIFFERENT rules. That asymmetry is the whole answer, and the sentence did not contain it.
 *
 * NOTE carries the measured cost rather than a caution, because the cost is what makes this a refusal
 * instead of a default. It is recorded verbatim in resolveResourceId's own header: with one
 * application credential and no subject, the memory layer either wrote no thread record at all (bearer
 * → `principal.id` undefined → `listThreads` empty for everyone) or wrote ONE owner shared by every
 * end user — and in that state user B read user A's stored note.
 *
 * HELP names the REST exception on purpose. On the adapters, a body-supplied subject is the hole the
 * context seal exists to close; here it is the ONLY channel a client credential has, because a bearer
 * token carries no per-caller identity to derive one from. Someone who has read the adapter rule and
 * meets this error needs to be told why the same field is right in one place and forbidden in the
 * other, or the two rules read as a contradiction.
 */
const CLIENT_SUBJECT_REQUIRED = teachingError({
  error: 'resourceId is required: this request used an application credential and named no end user.',
  note:
    'an application credential acts on behalf of YOUR users — that is what separates it from an\n' +
    'operator credential, which works across the whole organization and names nobody. With no\n' +
    'subject there is nothing to scope threads, recall and ownership to: measured, every end user\n' +
    'shared one memory bucket and read each other\'s stored notes, or got no thread records at all.',
  help:
    'Send the id your own app already has for the logged-in user: `?resourceId=<user>` on reads,\n' +
    '`{ "resourceId": "<user>" }` in the body on writes.\n' +
    'Yes — the body, on THIS surface only. The chat/AG-UI adapters must never take a subject from\n' +
    'the body (a caller would be naming whoever they like); a bearer token has no per-caller\n' +
    'identity to derive one from, so naming it IS the credential\'s job here.',
});

/**
 * WHOSE run this is — the subject the memory layer scopes on (`ThreadRecord.resourceId`, and working
 * memory's `res:<id>` key).
 *
 * Two deployment shapes need two different answers, and the precedence falls out of which one is in
 * use rather than being a policy choice:
 *
 *   • The deployment binds an identity PER CALLER (basic auth, or @gnldev/auth-ee's per-user tokens).
 *     Then `principal.id` IS the subject, and a body field must never override it — otherwise a user
 *     names someone else and reads their memory.
 *   • The deployment holds ONE application credential (the `client` class: a customer's backend
 *     serving many end users). Then there is no per-caller identity — `principal.id` is undefined for
 *     a bearer token — so the subject can only come from the request. The credential is trusted to
 *     speak for its own users, which is the same trust that already lets it run agents at all.
 *
 * Measured before this existed: with a bearer token the server derived `resourceId` from `principal.id`
 * (undefined), the memory layer creates a thread record only when a resourceId is present, and so a
 * customer's backend produced ZERO thread records — `listThreads` had nothing to return for anyone.
 * Under basic auth it produced one shared owner (the application's own username), which put every end
 * user in ONE working-memory bucket: measured, user B read user A's stored note.
 *
 * An INVALID value is a 400, not a silent drop. A caller that sent a resourceId believes its data is
 * scoped; dropping it quietly would hand back exactly the shared-bucket behaviour above while the
 * caller thought it had asked for separation.
 */
function resolveResourceId(
  kind: PrincipalKind | 'unnamed',
  principalId: string | undefined,
  raw: unknown,
): { resourceId?: string } | { error: string } {
  // A USER speaks for itself: its own name wins over anything the body says. Keyed on the kind, not on
  // whether a name is present — a named member of staff filing work for Ayşe files it under Ayşe.
  if (kind === 'subject' && principalId) return { resourceId: principalId };
  // An APPLICATION credential acts FOR an end user — that is what distinguishes it from an operator
  // credential, and it is the only reason it is trusted to assert a subject at all. So it must name
  // one. Silence used to mean "unchecked", which put an application's own users in the position the
  // shared bucket did: nothing separated them, and nothing said so.
  //
  // Deliberately keyed on the CLASS, not on the route. An operator (superAdmin/admin/viewer) works
  // across an organization's data by design and names nobody; the same rule applied to it would be
  // wrong, which is exactly the mistake the first version made by treating "absent" the same way for
  // everyone.
  if (raw === undefined || raw === null) {
    return kind === 'application'
      ? { error: CLIENT_SUBJECT_REQUIRED }
      : {};
  }
  if (typeof raw !== 'string') return { error: 'resourceId must be a string' };
  if (raw.length === 0) return { error: 'resourceId must not be empty' };
  // ONE rule for "can this string be a user's id" — @gnldev/auth `subjectIdProblem`, the same one
  // `engineCallerOf` applies when it maps this name to the engine's caller. Two rules drifted here: this
  // one let C1 control characters and U+2028 through, and the mapping then read the same name as
  // nobody (`unknown`), so the run was born to no one while the caller believed it was scoped.
  // It becomes part of a storage key (`res:<id>`) and is echoed back in listings; everything printable
  // is left alone, because a customer's own user ids are not ours to shape. Staff ids are compared in
  // the same space, kind-qualified (`operator:ops`), so nobody may file work under those prefixes.
  const problem = subjectIdProblem(raw);
  if (problem === 'length') return { error: `resourceId must be at most ${MAX_RESOURCE_ID} characters` };
  if (problem === 'control characters') return { error: 'resourceId must not contain control characters' };
  if (problem === 'reserved prefix') return { error: 'resourceId must not start with a reserved prefix (operator:, application:, role:, token:)' };
  return { resourceId: raw };
}

function clampLimits(server?: RunLimits, client?: RunLimits): RunLimits | undefined {
  if (!server && !client) return undefined;
  const stricter = (s?: number, c?: number): number | undefined =>
    s == null ? c : c == null ? s : Math.min(s, c);
  const out: RunLimits = {};
  const maxCostUsd = stricter(server?.maxCostUsd, client?.maxCostUsd);
  const maxTokens = stricter(server?.maxTokens, client?.maxTokens);
  const maxToolCalls = stricter(server?.maxToolCalls, client?.maxToolCalls);
  const maxRepeats = stricter(server?.loopDetection?.maxRepeats, client?.loopDetection?.maxRepeats);
  if (maxCostUsd != null) out.maxCostUsd = maxCostUsd;
  if (maxTokens != null) out.maxTokens = maxTokens;
  if (maxToolCalls != null) out.maxToolCalls = maxToolCalls;
  if (maxRepeats != null) out.loopDetection = { maxRepeats };
  return Object.keys(out).length ? out : undefined;
}

/** Leak-free metadata from agent records (the model object is hidden → only string id / 'custom'). */
export interface AgentMeta {
  name: string;
  model: string;
  system?: string;
  hasTools: boolean;
  maxSteps: number;
  /** Orgs this org-scoped agent belongs to (UI label); undefined for global agents. */
  orgs?: string[];
}

/** Agent metadata FILTERED by the caller's org (an invisible org-scoped agent doesn't appear in the list). */
function listAgentMeta(config: CreateGnlConfig, callerOrgId?: string): AgentMeta[] {
  const sharedTools = config.tools ? Object.keys(config.tools).length : 0;
  return Object.entries(config.agents ?? {})
    .filter(([, a]) => agentVisibleToOrg(a, callerOrgId))
    .map(([name, a]) => ({
      name,
      model: typeof a.model === 'string' ? a.model : 'custom', // dynamic/chain/object → 'custom'
      system: typeof a.system === 'string' ? a.system : undefined, // dynamic system is never leaked
      hasTools: sharedTools + (a.tools && typeof a.tools === 'object' ? Object.keys(a.tools).length : 0) > 0,
      maxSteps: a.maxSteps ?? 12,
      ...(a.orgs?.length ? { orgs: a.orgs } : {}),
    }));
}

/**
 * Produces a Hono router from a createGnl configuration:
 * POST /agents/:name/run       {runId, prompt|messages, threadId?, approvals?}
 * POST /agents/:name/resume    {runId, approvals?}   (input is read from the journal)
 * POST /agents/:name/stream    SSE
 * GET  /agents                 agent metadata
 * POST /workflows/:name/run    {runId?, input, resume?}  (suspend/resume/cancel safe)
 * GET  /workflows              workflow metadata (name + steps)
 * GET  /workflows/runs         P0.4: wfrun: registry query (?status=suspended|completed|canceled)
 * POST /workflows/runs/:id/cancel  P0.4: durable cross-process workflow cancel
 * GET  /runs/:id               journal timeline
 * GET  /runs                   run summaries
 * GET  /usage                  scope's token/cost usage + effective budget limit
 * GET  /openapi.json           generated schema (agent + workflow)
 */
/**
 * Decision #1: run-limit errors return 422 (Unprocessable Content) with a machine-readable body — the
 * request is valid but couldn't be processed under the given `limits` instruction. NOT 429 (SDKs
 * auto-retry 429, whereas the error is deterministic; Retry-After can't be computed), NOT 402 (402 is
 * specific to ORGANIZATION budget — remediation differs: raise budget ≠ raise limits + resume with the
 * SAME runId). If it doesn't match, returns undefined → the caller falls through to the generic 400 path.
 */
function limitErrorResponse(c: Context, e: unknown): Response | undefined {
  if (e instanceof RunLimitExceededError || (e as any)?.name === 'RunLimitExceededError') {
    const err = e as RunLimitExceededError;
    return c.json({ error: err.message, code: EDGE_ERROR_CODES.runLimitExceeded, detail: err.detail, resumable: true }, 422);
  }
  if (e instanceof ToolLoopDetectedError || (e as any)?.name === 'ToolLoopDetectedError') {
    const err = e as ToolLoopDetectedError;
    return c.json({ error: err.message, code: EDGE_ERROR_CODES.toolLoopDetected, detail: err.detail, resumable: true }, 422);
  }
  return undefined;
}

/**
 * K1: makes SideEffectRetryBlockedError/RunBusyError/RetryLimitExceededError thrown by runDurable
 * (see errorFromBlocked, run.ts) consistent with the `BLOCKED_CODES` mapping on the SSE path (sse.ts).
 * The code comes from @gnldev/durable#blockedErrorCode (the ONE source of truth, based on err.name); the
 * HTTP status/`resumable` choice is IDENTICAL to the `onError` in examples/app/src/server.ts:
 * side_effect_retry_blocked/run_busy → 409 + resumable:true (resolved via approval/retry);
 * retry_limit_exceeded → 422, NO resumable (a permanent 'failed' is left in the journal, the same runId
 * won't resume). If it doesn't match, returns undefined → the caller falls through to the generic 400
 * path.
 */
/**
 * The caller re-used a `runId` that belongs to a different conversation.
 *
 * 409 and NOT the generic 400: the request is well-formed and collides with something that already
 * exists, which is what Conflict means; 400 would tell the caller to fix the request when what needs
 * fixing is the id. `resumable` is ABSENT rather than false — the three blocked errors below carry
 * `resumable: true` because the same runId succeeds once the block clears, and this one never will for
 * this thread, so advertising it as retryable would put a client in a loop.
 *
 * Kept out of `blockedErrorCode`'s map for that same reason: those are runs blocked pending a
 * resolution, this is a caller mistake with no resolution path. Without this branch it fell through to
 * the generic 400, which serialises `message` ALONE — measured on both routes: no `code`, and the
 * `detail` naming the two threads was built and then dropped, leaving a consumer to parse the sentence.
 * That is the practice the typed error was added to end.
 */
function threadMismatchResponse(c: Context, e: unknown, workKey?: string): Response | undefined {
  if (!(e instanceof RunThreadMismatchError) && (e as { name?: string })?.name !== 'RunThreadMismatchError') return undefined;
  const err = e as RunThreadMismatchError;
  // Redacted: see `publicConflictDetail` (durable/errors.ts) for what is withheld and why.
  return c.json({ error: err.message, code: 'run_thread_mismatch', detail: withWorkKey(publicConflictDetail(err.detail), workKey) }, 409);
}

/**
 * The caller's own name for the work, put back into the refusal (§8, rules 1-3).
 *
 * FROM THE REQUEST, never from storage. The distinction is the tombstone rule (§10.3): a swept run
 * keeps only a HASH of its workKey, on purpose, so a refusal that read the name back out of the
 * journal would be resurrecting something a deletion was supposed to have removed. Reflecting what
 * the caller just sent gives up nothing — they already know it — and keeps "deleted stays deleted"
 * true while the error still speaks.
 *
 * `detail` and not `error`: the sentence is the single most casually logged field in any HTTP
 * client, and a workKey is a business name ("the invoice being issued", "device 7742"). Rule 1 keeps
 * it out of the prose; rule 2 puts it where a program looks.
 *
 * A non-object `detail` is replaced rather than merged — there is nothing to merge into, and losing
 * a bare string here has no consumer: every typed error in the family carries an object.
 */
function withWorkKey(detail: unknown, workKey?: string): unknown {
  if (workKey === undefined) return detail;
  return detail && typeof detail === 'object' ? { ...(detail as Record<string, unknown>), workKey } : { workKey };
}

/**
 * FAZ-4 caller-conflict family — same 409-without-resumable contract as threadMismatchResponse
 * above (the id/content/actor is what needs fixing, not the request shape; none clears on retry).
 */
function callerConflictResponse(c: Context, e: unknown, workKey?: string): Response | undefined {
  // K9: the code map is durable's CALLER_CONFLICT_CODES export — one source, three consumers
  // (server, chat-adapter, agui); a literal copy per consumer is exactly the drift that left one
  // route unmapped. threadMismatchResponse still answers first in every chain, so its entry here is
  // unreachable duplication, kept for consumers that skip the dedicated renderer.
  const code = callerConflictCode(e);
  if (!code) return undefined;
  const err = e as { message?: string; detail?: unknown };
  // Redacted: see `publicConflictDetail` (durable/errors.ts) for what is withheld and why.
  return c.json({ error: err.message, code, detail: withWorkKey(publicConflictDetail(err.detail), workKey) }, 409);
}

function blockedErrorResponse(c: Context, e: unknown): Response | undefined {
  const code = blockedErrorCode(e);
  if (!code) return undefined;
  const err = e as { message?: string; detail?: unknown } | null | undefined;
  const body = { error: err?.message ?? String(e), code, detail: err?.detail };
  const res = code === 'retry_limit_exceeded' ? c.json(body, 422) : c.json({ ...body, resumable: true }, 409);
  // The docs promise Retry-After on run_busy ("the same request is correct; it is only early") —
  // same fixed delay chat-route stamps; the lock heartbeat makes any small number honest.
  if (code === 'run_busy') res.headers.set('Retry-After', '5');
  return res;
}

/**
 * A failure that came from the model provider, answered as one.
 *
 * Without this the provider's failure fell through to the generic 400 — measured, a free endpoint
 * answering 429 reached the caller as `400 "Failed after 3 attempts. Last error: Too Many Requests"`,
 * which tells a retrying client to stop retrying at the exact moment it should wait. The status
 * choices and their reasoning live in @gnldev/durable#upstreamFailure; this only renders them, plus
 * `Retry-After` when the upstream named a delay.
 */
function upstreamErrorResponse(c: Context, e: unknown): Response | undefined {
  const up = upstreamFailure(e);
  if (!up) return undefined;
  const err = e as { message?: string } | null | undefined;
  const body = {
    error: err?.message ?? String(e),
    code: up.code,
    ...(up.upstreamStatus !== undefined ? { upstreamStatus: up.upstreamStatus } : {}),
    ...(up.retryAfter !== undefined ? { retryAfter: up.retryAfter } : {}),
  };
  const res = c.json(body, up.status);
  if (up.retryAfter !== undefined) res.headers.set('Retry-After', String(up.retryAfter));
  return res;
}

function restApiApp(config: CreateGnlConfig, opts: RestApiOptions = {}): Hono {
  // storage.runs (RunJournal) returns paginated listRuns → toJournal bridges it to the old array contract
  // (routes /runs, /usage, withOrg, and the budget gate all see the same shape).
  // `storage` is bridged by toJournal; `journal` is whatever the host passed — and the README's own
  // quickstart passes `new SqliteStorage(...).runs`, a RunJournal whose listRuns returns a Page. Every
  // reader-side consumer here (GET /runs, /usage, withOrg, the budget gate) expects the array contract,
  // so GET /runs?limit= died on `all.filter is not a function` and the bare GET /runs returned a page
  // Object where its documented contract promises an array. asReaderJournal presents one shape for both.
  const baseJournal = (config.storage ? toJournal(config.storage.runs) : asReaderJournal(config.journal as object)) as Journal & JournalReader;
  // A conversation store handed over as an OBJECT has no organization boundary, and this host had no
  // guard for it. Refused at setup rather than at the first leak.
  //
  // `orgInstance` below builds a per-organization registry with `{ ...config, journal: scoped }` — but
  // the spread carried `config.memory` through untouched, and `createGnl` resolves memory as
  // `config.memory ?? memoryFactory(...)` (registry.ts), so the object won and the factory was never
  // called. Every organization therefore shared ONE `Memory`: threads, messages, working memory and
  // observations are keyed by a caller-chosen `threadId` alone, so naming another organization's thread was
  // enough to read it. Studio refuses exactly this shape and says so at boot; this host served it.
  //
  // `memory: false` stays valid — that is the host saying "no conversation store", which needs no
  // boundary. A factory is fine: it is called per organization with that organization's journal.
  if (opts.org && config.memory) { // `false` is falsy here — an explicit "no store" needs no boundary
    throw new Error(
      'createRestApi: `memory` was passed as an object while `org` is configured. That object owns its ' +
      'own store and cannot be given an organization boundary, so every organization would share one ' +
      'set of threads. Pass `memoryFactory` instead — it is called per organization with that ' +
      "organization's journal — or set `memory: false`.",
    );
  }
  const defaultInstance = { gnl: createGnl(config), journal: baseJournal, orgId: undefined as string | undefined };
  const names = Object.keys(config.agents ?? {});
  const workflowNames = Object.keys(config.workflows ?? {});
  const app = new Hono();

  /**
   * Agent approval registry: every `config.agents` entry is recorded into `baseJournal` ONCE at
   * construction (idempotent — recordAgent handles first-sight/drift/unchanged). `createRestApi` itself
   * stays SYNCHRONOUS (returns the Hono app directly, existing callers `const api = createRestApi(...)`
   * would break if this returned a Promise) — so boot recording is fire-and-forget from here, but the
   * promise is CACHED and every request path that depends on registry state (the approval gate below,
   * `GET /agents/registry`, approve/block) `await`s it first, so no request can race ahead of boot.
   * A failure (e.g. a non-writable journal) is warned, not thrown — the registry becomes best-effort
   * stale rather than breaking the server (mirrors the budget/warn patterns elsewhere in this file).
   */
  const agentRegistryBoot: Promise<void> = (async () => {
    for (const [agentName, cfg] of Object.entries(config.agents ?? {})) {
      await recordAgent(baseJournal, agentName, fingerprintAgent(agentName, cfg));
    }
  })().catch((e) => {
    console.warn('@gnldev/server: agent registry boot recording failed (approval state may be stale):', e);
  });
  // Opt-in auth gate: endpoints are open without a provider; in production this is only possible with
  // allowOpenAccess: true (otherwise makeGate throws at setup), outside production a single warning is issued on the first request.
  const authProvider = normalizeAuth(opts.auth);
  const { allow, allowP, deny } = makeGate(authProvider, { allowOpenAccess: opts.allowOpenAccess });

  // WHAT IS ACTUALLY PROTECTING THIS HOST, printed once at construction.
  //
  // The rows come from @gnldev/durable's describeProtections and are NOT re-derived here — deliberately. A
  // banner maintained next to the config rather than derived from it is how `gnl dev` came to print
  // "(auth: protected)" for a project whose only credential was one this framework had published.
  // One derivation, every surface.
  //
  // The identity row is the half durable cannot see, so this file fills it in — and it says only what
  // it can prove. WITHOUT a provider there is no principal at all, so the subject can only come from
  // the request body: provable, and stated. WITH one, this host sees a provider and not its
  // credentials, and whether a principal carries a name is a property of those: `roleAuth` fills
  // `principal.id` only from `cred.user`, so the bearer-token shape `gnl add auth` generates carries
  // none, `resolveResourceId` never reaches the principal, and runs are born ownerless. This line used
  // to print `✓ bound via the authenticated principal` for that deployment — the claim measured false,
  // on the shape the scaffold itself writes. `gnl doctor` and `gnl dev` read the config's credentials
  // and can answer it; this surface cannot, so it says `unknown` and names where the answer lives.
  if (opts.protectionsBanner !== false) console.log(
    formatProtections(
      describeProtections(config, {
        surface: 'createRestApi',
        identity: authProvider
          ? {
              bound: 'unknown',
              via: 'the authenticated principal, IF its credential carries a name',
              from: 'explicit',
              note: 'an end user\'s own token binds them; staff and an application name the user in the request (an application with `?resourceId=`); `gnl doctor` reads the credentials and can tell you which classes are configured',
            }
          : {
              bound: false,
              from: 'default',
              note: 'no auth in front: the subject comes from `body.resourceId`, so ownership gates are only as good as the caller',
            },
      }),
      { title: `gnl ${opts.title ?? 'api'} — protections` },
    ).join('\n'),
  );

  // F1 — read the raw body and, when an a2aSecret is configured, verify the A2A HMAC signature over it
  // BEFORE parsing. Applied to EVERY agent-invoking endpoint (run/resume/stream + workflow run), not
  // just /run — otherwise the same agents were invocable UNSIGNED via /stream or /resume, bypassing the
  // replay/integrity gate by changing the endpoint. Returns the parsed body, or a deny Response.
  async function readSignedBody(c: Context): Promise<{ body: any } | { denied: Response }> {
    const rawBody = await c.req.text();
    if (opts.a2aSecret) {
      const sigDenied = verifyA2ASignature(c, rawBody, opts.a2aSecret);
      if (sigDenied) return { denied: sigDenied };
    }
    return { body: parseJsonBody(rawBody) };
  }
  // STRICT multi-org model = PAID gate: on ONLY when the auth provider (paid @gnldev/auth-ee, valid
  // license) reports the `multiOrganization` capability. When on, an unbound identity is NO LONGER a
  // super-admin by default — it must carry the EXPLICIT platform-admin grant (scope: 'platform'),
  // otherwise it is fail-closed. When OFF (free/host-org/no-auth) behavior is preserved EXACTLY: an
  // org-less identity is the legacy operator (sees the shared/root scope).
  const strictMultiOrg = authProvider?.capabilities?.().multiOrganization === true;
  /**
   * Whether this deployment has organizations at all — and therefore whether the fail-closed rules
   * below apply.
   *
   * It used to be `strictMultiOrg` alone, deliberately: the fail-closed net was described as a
   * paid-only behaviour change. Measured consequence, on the free tier with `org` configured: an
   * authenticated admin carrying NO org binding read BOTH organizations' runs (200), while the same
   * request under a provider declaring `multiOrganization: true` was refused (403). Declaring the
   * PAID capability was what made the deployment safe — so the sentence "the tier that does not pay
   * is the less isolated one" was literally true. Isolation must not depend on a paid feature flag.
   *
   * `capabilities()` cannot carry this either way: it is an object the CALLER supplies (auth/types.ts),
   * so it states an intent, never proves one. What does prove it is that the host configured `org` —
   * a deployment that routes by organization is one where an identity belonging to none is not the
   * accidental operator.
   *
   * Single-operator deployments are untouched: with no `org` option and no capability, this is false
   * and every path below behaves exactly as before.
   *
   * The `authProvider` term carries the no-auth case, and belongs HERE rather than at each call site.
   * An ABSENT provider is the deliberate no-auth mode: there is no identity to isolate ON, so every
   * caller is the operator. `scope()` below spelled that out inline, but the studio twin did not, and
   * the omission locked a no-auth `org: {}` deployment out of its own `/organizations` surface. One
   * derived expression is the fix that cannot be forgotten at the next call site. `strictMultiOrg`
   * already implies a provider (it reads one), so this only affects the `opts.org` branch.
   */
  const orgIsolationActive = !!authProvider && (strictMultiOrg || !!opts.org);
  // HARDENING: one-time warn when a multi-org deployment serves an org-less request in the shared scope (see scope()).
  let warnedSharedOrgFallback = false;
  // Org registration record prefix: ORG_RECORD_PRE, imported from @gnldev/durable. It was a local
  // literal here and another in @gnldev/studio, and `adoptIntoOrg` needs the same one — three copies
  // of a key that decides whether an organization resolves is three chances to change two of them.


  // Multi-organization: lazy registry per organization (same agent config, journal scoped to the
  // organization). Since the registry is per-org, model-fallback freezing and memory are also isolated
  // per organization.
  type Instance = typeof defaultInstance;
  const orgs = new Map<string, Instance>();
  // See OrgOptions.maxInstances. A `Map` iterates in insertion order, so re-inserting on every hit
  // makes the first key the least recently used one.
  //
  // REJECTED at construction rather than clamped. This started as `Math.max(1, …)`, and the clamp was
  // doing far more than reading like a tidy default: with a negative cap, `orgs.size > -5` is
  // permanently true while `orgs.delete(undefined)` never shrinks the map, so the eviction loop spins
  // forever and the request never returns. A silent clamp also hides the milder version of the same
  // typo — `maxInstances: 0` would quietly rebuild every organization's registry on every request. A
  // value that can only be a mistake should say so at boot, where it costs one line to see.
  const maxOrgInstances = opts.org?.maxInstances ?? 512;
  if (!Number.isInteger(maxOrgInstances) || maxOrgInstances < 1) {
    throw new Error(
      `createRestApi: \`org.maxInstances\` must be a positive integer (got ${String(opts.org?.maxInstances)}). ` +
        'It is the ceiling on how many per-organization registries are cached in memory; omit it for the default of 512.',
    );
  }
  let warnedOrgEviction = false;
  function orgInstance(id: string): Instance {
    let inst = orgs.get(id);
    if (inst) orgs.delete(id); // re-inserted below, moving it to the most-recently-used end
    if (!inst) {
      // `memory` is dropped explicitly, not left to the spread. The guard at construction already
      // refuses an object here, so this only removes a value that cannot exist — but stating it means
      // the next field added to `CreateGnlConfig` cannot silently ride the spread into every
      // organization the way this one did. `memoryFactory` receives the scoped source, so each
      // organization gets its own store over its own keys.
      const { memory: _sharedMemory, ...perOrg } = config;
      // Storage: all six ports via `withOrgStorage` (a `Storage` has six, and an earlier version kept
      // one — every organization's threads, corpus, queue, cache and metadata then shared keys);
      // journal-only: `withOrg`. Built in @gnldev/durable (`scopeConfigToOrg`) so the chat and AG-UI
      // routes and @gnldev/mcp scope an organization's work the same way.
      const scopedOrg = scopeConfigToOrg(perOrg, id);
      inst = { gnl: createGnl(scopedOrg.config), journal: scopedOrg.journal, orgId: id };
    }
    orgs.set(id, inst);
    while (orgs.size > maxOrgInstances) {
      const lru = orgs.keys().next().value as string;
      orgs.delete(lru);
      // Once, not per eviction: a deployment genuinely serving more orgs than the cap would otherwise
      // print a line per request, and the operator only needs to learn the ceiling exists.
      if (!warnedOrgEviction) {
        warnedOrgEviction = true;
        console.warn(
          `@gnldev/server: more than ${maxOrgInstances} organizations are active in this process — evicting the least recently used registry (starting with '${lru}'). ` +
            'Evicted organizations are rebuilt on their next request and read the same journal keys. Raise `org.maxInstances` if this is your real organization count rather than header noise.',
        );
      }
    }
    return inst;
  }
  /**
   * Resolve the request scope. An organization bound to identity (Principal.orgId, verified during
   * allow()) OVERRIDES the header and enforces isolation even if the org option is NOT SET UP (the
   * Cred.orgId promise: "organization isolation is enforced by identity"). If the bound identity requests
   * a different organization, 403.
   */
  /**
   * Refuses when the caller STATED whose run it expects (`?resourceId=`) and the run says otherwise.
   *
   * The owner is read from the run's own frozen `:input` entry — the same place `threadId` and `agent`
   * live — so there is no second source to keep in sync and no extra table to migrate. Reading it
   * costs one point-read on a key the journal already holds.
   *
   * Silent on: no expectation stated, no owner recorded, or a journal that cannot answer. See the
   * route JSDoc for why neither absence is treated as a denial.
   */
  /**
   * WHAT this caller is: operator, application, subject, or unnamed. Every ownership decision below
   * asks this and nothing else — see @gnldev/auth `callerKind`, and `Principal.kind` for why it is
   * stamped where the principal is minted instead of inferred here from whether it carries a name.
   *
   * No provider, or one with no principal model (`bindsIdentity: false`, the {read,write} pair), is
   * the deliberate single-operator mode: whoever got past it is staff, because nothing else exists.
   */
  const principalFor = (c: Context): Principal | null =>
    !authProvider || !bindsIdentity(authProvider) ? SINGLE_OPERATOR : principalOf(c.req.raw);
  const kindOf = (c: Context): PrincipalKind | 'unnamed' => callerKind(principalFor(c));
  /** Whether THIS caller is an application credential — one that speaks for a user it names. */
  const isClient = (c: Context): boolean => kindOf(c) === 'application';

  /**
   * Refuses a client-credential request that names no end user.
   *
   * The single choke point for the rule, and a conformance test walks `routeTable` to prove every
   * route touching end-user data reaches it — the alternative is a rule that holds on the routes
   * someone remembered, which is how the first version of this shipped with the write paths open.
   *
   * Operators are untouched: `superAdmin`/`admin`/`viewer` work across an organization by design and
   * name nobody. That asymmetry IS the rule — it is about which credential is asking, not which route.
   */
  function clientSubjectDenied(c: Context, supplied?: unknown): Response | undefined {
    if (!isClient(c)) return undefined;
    const named = typeof supplied === 'string' ? supplied : c.req.query('resourceId');
    if (named) return undefined;
    // The SAME constant the read gate returns — not a second copy of the sentence. Two copies is
    // where this started, and a test now asserts the two paths answer byte for byte.
    return c.json({ error: CLIENT_SUBJECT_REQUIRED }, 400);
  }

  /**
   * Refuses when a request names a thread that belongs to a different end user.
   *
   * The READ side had this from the start; the WRITE side did not, and the gap was not theoretical.
   * Measured before this existed, with one `client` credential serving two end users: Mallory posted
   * `{ threadId: 'thread-alice', resourceId: 'mallory' }` to `POST /agents/:name/run` and the prompt
   * handed to the model was Alice's history verbatim — `[{user:'my PIN is 4417'}, {assistant:'ok'},
   * {user:'what did I say before?'}]`. The identical claim on `GET /threads/:id/messages` answered 403.
   * Worse than disclosure: the turn is APPENDED to that thread, so the next reader of Alice's own
   * conversation sees a stranger's message inside it.
   *
   * Why it was missed, written down because the shape recurs: the ownership rule was applied to the
   * routes that were open on the screen. Runs got it at the read path, then at cancel and resume; the
   * SUBJECT of a thread never got it anywhere but the read. The conformance walk that exists to stop
   * exactly this drove every route with a subject-less client and proved a subject is REQUIRED — it
   * never once paired a valid subject with a thread belonging to someone else, so 3645 tests passed
   * over the hole. A helper rather than a fourth copy: the copies are how the first three sites
   * drifted apart.
   *
   * SILENT when the store cannot answer (`getThreadResource` is optional on `Memory`) or when the
   * thread has no recorded owner — a first turn creates the thread, so refusing an unknown owner would
   * refuse every new conversation. Same permissiveness as the read route, same wording on refusal:
   * it reveals neither the real owner nor whether the thread exists.
   */
  async function threadOwnershipDenied(
    c: Context,
    s: Instance,
    threadId: unknown,
    subject: string | undefined,
  ): Promise<Response | undefined> {
    if (typeof threadId !== 'string' || !threadId || !subject) return undefined;
    const raw = rawOf(s);
    // The thread's owner RECORD, asked the way every door asks it (@gnldev/durable `threadOwnerOf`):
    // derived from whichever runs were left, the owner moved — a sweep of her runs made her thread
    // "new" for the next caller, and one foreign run locked her out of it.
    let o: ThreadOwnership;
    try {
      o = await threadOwnerOf(raw.journal, raw.gnl.memory, threadId);
    } catch {
      return undefined; // a store that cannot answer is not evidence of a mismatch
    }
    if (o.owner === subject) return undefined;
    // Typed like the engine's own refusal: the code a consumer branches on, and what the CALLER sent
    // (its own name, the thread it named) — never the owner's.
    const refusal = () => c.json({
      error: 'access denied: this thread belongs to a different resourceId',
      code: 'thread_owner_mismatch',
      detail: { threadId, requested: subject },
    }, 403);
    if (o.owner) return refusal();
    // NO OWNER. A thread that does not exist yet is this caller's to start — the first turn creates
    // it. One that EXISTS with no owner is staff's work (or pre-dates ownership), and only staff may
    // write into it: measured, an end user appended to a staff member's thread and read its history.
    if (!o.exists || kindOf(c) === 'operator') return undefined;
    return refusal();
  }

  /**
   * The subject a caller is BOUND to: its own name, when it is a user. `undefined` for staff and for
   * an application, which name the subject in the request instead. An unnamed caller never gets here:
   * `scope` refuses it first.
   */
  function boundSubjectOf(c: Context): string | undefined {
    return kindOf(c) === 'subject' ? principalOf(c.req.raw)?.id : undefined;
  }

  /**
   * THE caller of this request, as the engine's `Caller` — through the one mapping every door uses,
   * @gnldev/auth `engineCallerOf` (ADR-0002). No route builds a caller by hand.
   *
   * `named` is the user the request names: the body's `resourceId` on a write, `?resourceId=` on a
   * read (the body wins when a route has one — it is what the run is filed under).
   *
   *   subject      → that user; a name in the request is ignored (a user speaks only for itself)
   *   application  → the user it names; `unknown` when it names nobody or an id no user can have
   *   operator     → staff. When it NAMES a user it speaks FOR that user on this request, which is
   *                  what the `application` kind means, and it is mapped as one: work it starts is
   *                  filed under that user, a list it asks for is that user's, and a run it asks about
   *                  is held to that user (`runDecision` keeps the one staff exception)
   *   unnamed      → unknown (`scope` refuses it before any route gets here)
   *
   * Single-operator mode (no provider, or one with no principal model) is `SINGLE_OPERATOR`.
   */
  function callerOf(c: Context, named?: unknown): Caller {
    const p = principalFor(c);
    const name = typeof named === 'string' && named !== '' ? named : undefined;
    return engineCallerOf(name !== undefined && callerKind(p) === 'operator' ? { ...p!, kind: 'application' } : p, name);
  }
  /** The user a read names: its own for a subject, `?resourceId=` for anyone else. */
  const namedOnRead = (c: Context): string | undefined => c.req.query('resourceId') || undefined;

  /**
   * THE run gate: one decision (@gnldev/durable `runOwnerOf` + `decideRunAccess`), asked of the RAW
   * instance for every run kind, with the caller `callerOf` maps. Each route maps `allow | deny |
   * missing` to its own answer (a foreign run reads as missing to a non-staff caller where the route's
   * target must exist); there is no flag. An unreadable owner is `deny` — `runOwnerOf` says so.
   *
   * ONE staff exception: staff naming a user is held to that user's runs, but still reaches a run that
   * is nobody's (staff's own, or an unknown caller's) — naming a user narrows what staff may touch, it
   * does not take away staff's own work.
   */
  async function runAccess(c: Context, s: Instance, runId: string, named?: unknown): Promise<{ decision: RunDecision; owner: RunOwner }> {
    const owner = await runOwnerOf(rawOf(s).journal as RawJournal, runId);
    const decision = decideRunAccess(owner, callerOf(c, named ?? namedOnRead(c)));
    if (decision === 'deny' && kindOf(c) === 'operator' && owner.state === 'owned' && owner.owner.kind !== 'user') return { decision: 'allow', owner };
    return { decision, owner };
  }
  const runDecision = async (c: Context, s: Instance, runId: string, named?: unknown): Promise<RunDecision> =>
    (await runAccess(c, s, runId, named)).decision;

  /**
   * The engine's input for a caller: the request context sealed with that caller (a user's id, or the
   * staff flag) and the organization. The seal is what the engine reads identity from, and what a
   * dynamic `system`/`model`/`tools` function sees — written from a `Caller`, never field by field.
   * An `unknown` caller seals neither, and the engine reads it as `unknown`.
   */
  const sealFor = (ctx: RequestContext, caller: Caller, orgId: string | undefined): RequestContext =>
    sealRequestContext(ctx, { orgId, resourceId: userIdOf(caller), staff: caller.kind === 'staff' });
  /** The address a declared `workKey` is unique within, for a caller: its user, when it has one. */
  const workAddressOf = (caller: Caller): { resourceId?: string } => {
    const id = userIdOf(caller);
    return id === undefined ? {} : { resourceId: id };
  };
  const foreignRun = (c: Context) => c.json({ error: 'access denied: this run belongs to a different resourceId' }, 403);

  /**
   * The question the ENGINE would have asked, asked here because on `/resume` the engine cannot.
   *
   * Everywhere else a re-drive of somebody else's raw runId meets `RunActorMismatchError`: the run's
   * `actor` is stamped at birth from the sealed identity, and the second caller arrives with their
   * own. Measured on `POST /agents/:name/run` with a run belonging to 'u-ayse' — a caller whose
   * credential carries the name 'mallory' gets 409 `run_actor_mismatch`, whether they declare nothing
   * or declare the victim's name to satisfy `ownershipDenied`. That lock is unconditional.
   *
   * `/resume` was the hole, and for a structural reason rather than a missing line. A resume is
   * self-contained: it reads the subject back out of the FROZEN `:input` and seals THAT (see the
   * route), which is right — the second half of a conversation must not change owner. But the actor
   * stamp is printed from the same seal, so the engine ends up comparing the run's owner with the
   * run's own owner and can never disagree. Measured: the same 'mallory', the same runId, 409 on
   * `/run` and 200 + the victim's text on `/resume` — with `approvals` in the body, which is the
   * exact sentence the route's own comment forbids.
   *
   * So the comparison is made against the caller's OWN name and nothing they said: a claim in the
   * query or the body is the attacker's to write, and naming the victim is how the edge gate gets
   * satisfied.
   *
   * SAME EXEMPTIONS AS THE ENGINE, on purpose, so the parity claim stays true in both directions: a
   * credential with no name of its own (the operator bearer, whose `id` is absent by design, and the
   * `client` application credential, which speaks for a user rather than as one) stamps no actor and
   * so is asked nothing; a run with no stamp — everything born before the stamp existed — is not
   * refused either, because `/run` does not refuse it. This gate never refuses what `/run` serves.
   *
   * ONE EXEMPTION THE ENGINE DOES NOT HAVE: platform-admin. The engine's actor lock would 409 an
   * admin re-driving someone's run on `/run`; this gate waves the same admin through on `/resume`,
   * deliberately — Studio's approve flow IS an operator resuming a stranger's run, and refusing it
   * here would break the inbox. So the parity claim is one-directional for admins: never stricter
   * than the engine, knowingly looser on this one credential.
   */
  async function actorParityDenied(c: Context, s: Instance, runId: unknown, asMissing?: () => Response): Promise<Response | undefined> {
    if (typeof runId !== 'string' || !runId) return undefined;
    // Only a USER is held to its own runs; staff resume strangers' runs by design (Studio's approve flow).
    const own = boundSubjectOf(c);
    if (!own) return undefined;
    let stamped: string | undefined;
    try {
      // The raw instance, as `ownershipDenied` reads it: the caller's view hides a stranger's input,
      // and a gate that saw "no stamp" there would wave the stranger's run through.
      stamped = (await rawOf(s).journal.get<{ actor?: string }>(`${runId}:input`))?.actor;
    } catch {
      return undefined; // a reader that cannot serve the entry is not evidence of a mismatch
    }
    if (!stamped || stamped === own) return undefined;
    if (asMissing) return asMissing(); // only a user reaches here — see ownershipDenied's `asMissing`
    // Word for word what `ownershipDenied` answers on this same route: the refusal names neither the
    // real owner nor whether the run exists, and one route should not have two vocabularies for one
    // refusal. The engine's 409 carries both names and stays where it is — it is reached by callers
    // who are re-driving their OWN work, not by the caller this gate is for.
    return c.json({ error: 'access denied: this run belongs to a different resourceId' }, 403);
  }

  /** The instance a view was built over. Gates ask it whether a record EXISTS, which a view hides. */
  const rawInstances = new WeakMap<object, Instance>();
  const rawOf = (s: Instance): Instance => rawInstances.get(s) ?? s;

  /** Whose data this caller reads: its own name if it is a user; the user it names if it is an application. */
  function viewSubjectOf(c: Context): string | undefined {
    const kind = kindOf(c);
    if (kind === 'subject') return boundSubjectOf(c);
    if (kind === 'application') return c.req.query('resourceId') || undefined;
    return undefined;
  }

  /**
   * The ONE place a caller who speaks for a user is narrowed to that user. Every route takes its
   * journal and memory from here, so a route that forgets a gate still holds a reader that cannot
   * produce another user's run or thread — see @gnldev/durable `withSubjectJournal`/`withSubjectMemory`
   * for the ownerless (fail-closed) and root rules. Staff get the organization's instance unchanged.
   * The per-route gates stay: they refuse WRITES, which no reader can.
   */
  async function scope(c: Context): Promise<Instance | { error: string; status: 400 | 403 }> {
    const s = await scopeOrg(c);
    if ('error' in s) return s;
    const subject = viewSubjectOf(c);
    if (!subject) return s;
    const root = s.orgId === undefined;
    const memory = s.gnl.memory
      ? withSubjectMemory(s.gnl.memory, subject, { root, journal: s.journal })
      : undefined;
    const gnl = new Proxy(s.gnl, { get: (t, k) => (k === 'memory' ? memory : Reflect.get(t, k, t)) });
    const view = { ...s, journal: withSubjectJournal(s.journal, subject, { root }), gnl } as Instance;
    rawInstances.set(view, s);
    return view;
  }

  async function scopeOrg(c: Context): Promise<Instance | { error: string; status: 400 | 403 }> {
    // A caller that names nobody and is not staff can be held to nothing, so it reaches nothing. This
    // is the case the old `!p?.id ⇒ operator` inference turned into staff: a subject whose provider
    // gave it no name (a numeric JWT `sub`, a missing claim) read every user's data.
    if (kindOf(c) === 'unnamed') {
      return { error: 'access denied: this caller is not staff and names no user, so there is nothing it may reach', status: 403 };
    }
    const principal = principalOf(c.req.raw);
    const bound = principal?.orgId;
    // B2 — organization isolation must NOT depend on the paid license capability: when the host configured
    // per-request orgs (opts.org) with an auth provider that produces NO principal (e.g. legacy
    // {read,write} auth whose authenticate()=null), the raw `x-gnl-org` header would drive the scope
    // with ZERO identity binding — cross-organization read/write. There is no identity to isolate on, so this
    // combination is unsafe regardless of the license → fail closed. (An ABSENT auth provider is the
    // deliberate single-operator/no-auth mode and is unaffected.)
    if (orgIsolationActive && authProvider && !principal) {
      return { error: 'access denied: organization isolation is configured but this auth provider binds no identity to an organization (fail-closed)', status: 403 };
    }
    // STRICT (EE multi-org) FAIL-CLOSED: an authenticated identity with NO org binding AND NO explicit
    // platform-admin grant gets 403 — it is NOT the accidental super-admin. Kept license-gated on
    // purpose: the FREE tier's contract is that an unbound admin is the legacy cross-org OPERATOR
    // (see auth-org.test 'operator scenario'); a host wanting strict isolation binds every token's
    // Cred.orgId or runs the paid strict-multi-org model.
    if (orgIsolationActive && principal && !bound && !isPlatformAdmin(principal)) {
      return { error: 'access denied: no organization scope and no platform-admin grant (fail-closed)', status: 403 };
    }
    // If neither the org option nor an identity-bound organization exists → shared default (existing behavior).
    if (!opts.org && !bound) return defaultInstance;
    const resolve = opts.org?.resolve ?? ((req: Request) => req.headers.get('x-gnl-org') ?? undefined);
    const requested = await resolve(c.req.raw);
    if (bound && requested && requested !== bound) {
      return { error: `organization mismatch: identity is bound to organization '${bound}'`, status: 403 };
    }
    const id = bound ?? requested;
    if (!id) {
      if (opts.org?.required) return { error: 'organization required (x-gnl-org header)', status: 400 };
      // HARDENING (silent cross-organization mixing): multi-org IS configured (`opts.org` set — we passed the
      // single-org early-return above) yet this request carries NO org and NO org-bound identity, so
      // it lands in the SHARED (unprefixed) scope alongside every other org-less request. That is a
      // potential data-mixing footgun a misconfigured client (missing x-gnl-org header) hits SILENTLY.
      // Behavior is unchanged (still served in shared scope — an operator who set `required:false`
      // opted into this), but it is no longer silent: warn ONCE so the operator discovers they likely
      // want `org.required = true` for strict organization isolation.
      if (!warnedSharedOrgFallback) {
        warnedSharedOrgFallback = true;
        console.warn('@gnldev/server: multi-org is configured but a request resolved NO organization → served in the SHARED scope (its data mixes with other org-less requests). Set `org.required = true` to reject such requests instead (fail-closed). This warning fires once.');
      }
      return defaultInstance;
    }
    // HARDENING (opt-in): the resolved org must be EXPLICITLY REGISTERED. Without this, an org-bound
    // identity (or an x-gnl-org header) runs under `org:<id>:` whether or not that org was ever created
    // a deleted org's still-valid tokens keep working, and a typo'd header silently forks a new
    // namespace. The `__org__:<id>` record (studio POST /organizations) is the registration; a `null`
    // value is a deletion tombstone → also rejected. Root-level read (records live on baseJournal, not
    // org-prefixed). Default off → legacy implicit-org behavior unchanged.
    if (opts.org?.requireRegistration) {
      const reg = await baseJournal.get(ORG_RECORD_PRE + id);
      if (reg == null) return { error: `organization '${id}' is not registered`, status: 403 };
    }
    try {
      return orgInstance(id);
    } catch (e: any) {
      return { error: String(e?.message ?? e), status: 400 };
    }
  }

  /**
   * D4-FGA (EE-2): consults `opts.resourceAuth` (if configured) AFTER the caller's existing coarse gate
   * (allow/allowP) — a distinct, ADDITIVE narrowing layer, never a replacement for it. No-op (undefined)
   * when `resourceAuth` is unset → existing behavior is preserved exactly.
   */
  async function resourceGate(
    c: Context,
    principal: Principal | null,
    resource: ResourceAuthResource,
    action: ResourceAuthAction,
  ): Promise<Response | undefined> {
    if (!opts.resourceAuth) return undefined;
    const allowed = await opts.resourceAuth(principal, resource, action);
    return allowed ? undefined : c.json({ error: `resource access denied: ${resource.type}:${resource.id}`, code: EDGE_ERROR_CODES.resourceDenied }, 403);
  }

  /**
   * Org-scoped agent gate (run/resume/stream). An unknown agent AND an org-invisible agent return the
   * EXACT SAME 404 → a non-owning org cannot even learn the agent EXISTS (no existence leak). Runs
   * AFTER the write gate, BEFORE execute. Global agents (no `orgs`) and operators (orgId undefined /
   * auth off) always pass → full backward-compat.
   */
  function agentGate(c: Context, name: string, orgId: string | undefined): Response | undefined {
    const cfg = config.agents?.[name];
    if (!cfg || !agentVisibleToOrg(cfg, orgId)) return c.json({ error: `agent '${name}' not registered` }, 404);
    return undefined;
  }

  /**
   * WHICH ADDRESS a `workKey` is unique within, for this agent — read from the AGENT's declaration
   * and never from the request.
   *
   * Read off `config` rather than the per-org registry because they are the same declaration: an
   * org-scoped instance is built from this very config, so there is nothing per-instance to consult.
   * `agentGate` has already answered "is there such an agent" by the time this is called.
   *
   * The default matters more than it looks: `'resource'` is the noisy-and-cheap mistake (the work
   * runs twice), `'org'` is the quiet-and-dangerous one (two tenants share one run). §6 chooses which
   * way to be wrong.
   */
  function agentWorkScope(name: string): WorkScopeKind {
    return config.agents?.[name]?.workScope ?? 'resource';
  }

  /**
   * Agent approval gate (opt-in via `opts.requireAgentApproval`) — a SEPARATE async check called RIGHT
   * AFTER `agentGate` in run/resume/stream (visibility 404 stays first: an org that can't even see the
   * agent gets 404, not a 403 about its approval status). No-op when the flag is off → byte-for-byte
   * existing behavior. Awaits `agentRegistryBoot` first so a request can never race ahead of the
   * construction-time registry recording (see its JSDoc above).
   */
  async function agentApprovalGate(c: Context, name: string): Promise<Response | undefined> {
    if (!opts.requireAgentApproval) return undefined;
    await agentRegistryBoot;
    if (await isAgentServable(baseJournal, name)) return undefined;
    return c.json({ error: 'agent not approved to serve', code: EDGE_ERROR_CODES.agentNotApproved }, 403);
  }

  /**
   * PLATFORM-ADMIN gate for the agent registry endpoints below — mirrors @gnldev/studio's
   * `requirePlatformAdmin` (packages/studio/src/server.ts). Approval is a PLATFORM decision (should this
   * code-agent serve AT ALL), never per-org, so an org-bound identity is always denied; in the strict
   * multi-org model an unbound identity additionally needs the EXPLICIT platform-admin grant.
   */
  function requirePlatformAdmin(c: Context, orgBoundMsg: string): Response | undefined {
    // A role is not the grant: a user holding `platform-admin` is still a user.
    if (kindOf(c) !== 'operator') return c.json({ error: 'staff only: this is an operator surface' }, 403);
    const p = principalOf(c.req.raw);
    if (p?.orgId) return c.json({ error: orgBoundMsg }, 403);
    if (orgIsolationActive && !isPlatformAdmin(p)) {
      return c.json({ error: 'platform-admin required (fail-closed: no org scope and no platform-admin grant)' }, 403);
    }
    return undefined;
  }

  // Budget/quota WRITE PATH gate. Budgets are PER-ORG:
  // org ON + a request without an organization (root) → the root scope is NOT an organization, it
  //    spans the total across all organizations; the per-org `default` limit does not apply to it
  //    (otherwise it would produce a false 402).
  // org OFF → a single global scope can use the `default` limit (a legitimate global cap).
  // Effective limit: journal `__budget__:*` (managed from Studio) > opts.budgets fallback. Completed run
  // costs are memoized in costCache → a full deep journal read isn't repeated on every write.
  const usageCostCache: UsageCostCache = new Map();
  const budgetsConfigured = !!(opts.budgets?.default || opts.budgets?.perOrg);
  if (budgetsConfigured && !budgetsEnforceable(baseJournal)) {
    console.warn('@gnldev/server: budgets configured but journal does not support listRuns → quota CANNOT be enforced (fail-open).');
  }
  const effectiveFallback = (orgId?: string): BudgetLimit | undefined =>
    (orgId ? opts.budgets?.perOrg?.[orgId] : undefined) ?? opts.budgets?.default;
  async function budgetGate(c: Context, s: Instance): Promise<Response | undefined> {
    // If not an organization (org on + root scope), per-org budget doesn't apply.
    if (!s.orgId && opts.org) return undefined;
    const check = await checkBudget(baseJournal, s.orgId, effectiveFallback(s.orgId), usageCostCache);
    return check.exceeded
      ? c.json({ error: 'budget/quota exceeded — new run rejected', code: EDGE_ERROR_CODES.budgetExceeded, usage: check.usage, limit: check.limit }, 402)
      : undefined;
  }

  /**
   * "Resume intent" (H2/1.3): work that ALREADY exists under the runId (a pending tool approval, a
   * suspended workflow, the exactly-once repeat of a completed run) is a continuation, not new work —
   * budgetGate is SKIPPED, or suspended work in an over-budget organization could never finish. A
   * runId with no work under it is new work and the gate is ENFORCED. "Work" is `priorWork`'s answer,
   * the same one the replay header gives: an owner record alone is not work.
   */
  const isResumeIntent = (s: Instance, runId: string): Promise<boolean> => priorWork(rawOf(s).journal as RawJournal, runId);

  /**
   * P0.3 in-process registry of the AbortControllers backing CURRENTLY IN-FLIGHT
   * `/run` and `/stream` generations, keyed by an ORG-SCOPED key (NOT the raw runId — two different
   * organizations may legitimately use the SAME client-supplied runId for unrelated work; a flat
   * `runId → controllers` map would let org A's cancel abort org B's generation, a cross-organization
   * correctness/security bug). `POST /runs/:id/cancel` below aborts every controller registered under
   * an id. Deliberately per-INSTANCE (a plain Map, not journal-backed) — see the cancel handler's JSDoc
   * for the honest multi-worker limitation.
   */
  const inflight = new Map<string, Set<AbortController>>();
  const inflightKey = (s: Instance, runId: string): string => (s.orgId ? `org:${s.orgId}:${runId}` : runId);
  function registerInflight(key: string, ctrl: AbortController): void {
    let set = inflight.get(key);
    if (!set) { set = new Set(); inflight.set(key, set); }
    set.add(ctrl);
  }
  function unregisterInflight(key: string, ctrl: AbortController): void {
    const set = inflight.get(key);
    if (!set) return;
    set.delete(ctrl);
    if (set.size === 0) inflight.delete(key);
  }

  /**
   * Actor attribution — the SAME derivation `audit()` below uses, extracted so the agent-registry
   * approve/block endpoints can pass it as `approveAgent`/`blockAgent`'s `by` argument without
   * duplicating the logic. Priority: an authenticated principal.id > the `x-gnl-actor` header (the
   * PERSON behind a shared token) > `role:<role>` > 'anon'.
   */
  function actorOf(c: Context): string {
    const p = principalOf(c.req.raw);
    // `actorIdOf`, not the raw id: staff are `operator:<id>`, so an end user whose token says `sub: 'ops'`
    // and the operator `ops` are two actors in the trail, not one.
    return actorIdOf(p) ?? c.req.header('x-gnl-actor') ?? (p?.roles[0] ? `role:${p.roles[0]}` : 'anon');
  }

  /**
   * P0.3: minimal governance log for this package's own mutating endpoints — mirrors @gnldev/studio's
   * `audit()` helper (packages/studio/src/server.ts) but scoped down: @gnldev/server has no broader
   * governance surface (org/user CRUD, agent versioning, …) to log — `run.cancel`/`workflow.cancel` plus
   * the agent-registry `agent.approve`/`agent.block` actions. Writes to the SAME `__audit__` journal
   * namespace studio uses (via the shared `appendLog` primitive) so a consumer reading either surface's
   * journal sees one merged trail. Best-effort: a journal write failure never breaks the request that
   * triggered it.
   */
  async function audit(c: Context, orgId: string | undefined, action: 'run.cancel' | 'workflow.cancel' | 'agent.approve' | 'agent.block', target: string, detail?: unknown): Promise<void> {
    try {
      const actor = actorOf(c);
      const p = principalOf(c.req.raw);
      const org = p?.orgId ?? orgId;
      /**
       * `actingAs` — an UNBOUND identity operating inside an organization, which `org` cannot express.
       *
       * `org` answers "which organization was this about" and fills from the actor's own binding or
       * from the scope the request resolved. Both give the same value for a platform-admin working
       * inside someone else's organization, so the record cannot distinguish "acme's admin cancelled
       * acme's run" from "the operator cancelled acme's run" — and the second is the event a customer
       * would ask about.
       *
       * Set only when the actor has NO organization of their own and the request resolved into one.
       * A bound identity never has it: acting inside your own organization is not acting as anyone.
       *
       * It lives here rather than in @gnldev/studio because this is the only surface where it can
       * happen. Studio refuses an explicit org header on every non-GET (its v1 read-only rule), so on
       * a write its ALS only ever holds the caller's own binding — I put the field there first and
       * measured that it could never fill.
       *
       * `reason` is whatever the caller sent in `x-gnl-reason`. Optional on purpose: required would
       * break every existing operator script the day it shipped, and a trail nobody can write to is
       * worse than one with blanks.
       */
      const actingAs = !p?.orgId && orgId ? orgId : undefined;
      const reason = c.req.header('x-gnl-reason')?.slice(0, 300);
      // ALWAYS the ROOT journal (baseJournal), NEVER an org-scoped view — the `__audit__` contract
      // (see @gnldev/studio server.ts's /audit reader) is a SINGLE root-level trail with the organization
      // carried as a PAYLOAD FIELD for filtering. An org-prefixed write (`org:<id>:__audit__:…`) would
      // be invisible to studio's audit view (it deliberately reads the root journal for exactly this reason).
      await appendLog(baseJournal, '__audit__', {
        actor, action, target,
        ...(org ? { org } : {}),
        ...(actingAs ? { actingAs } : {}),
        ...(reason ? { reason } : {}),
        ...(detail !== undefined ? { detail } : {}),
      });
    } catch { /* audit is best-effort — swallow */ }
  }

  app.post('/agents/:name/run', async (c) => {
    // Running an agent is the `agents:run` permission (member + admin; viewer denied). In the free tier
    // this reduces to 'write' → identical to the previous allow(c,'write') (admin only) → no regression.
    if (!(await allowP(c.req.raw, 'agents:run'))) return deny(c.req.raw, 'write');
    const name = c.req.param('name');
    // Signature verification operates on the raw body bytes (the SAME string HMAC'd on the client side).
    const parsed = await readSignedBody(c);
    if ('denied' in parsed) return parsed.denied;
    const body = parsed.body as any;
    adoptIdempotencyKey(c, body);
    if (!body.runId && !body.workKey) return c.json({ error: NO_IDENTITY }, 400);
    const s = await scope(c);
    if ('error' in s) return c.json({ error: s.error }, s.status);
    const gated = agentGate(c, name, s.orgId);
    if (gated) return gated;
    const approvalDenied = await agentApprovalGate(c, name);
    if (approvalDenied) return approvalDenied;
    // P1.7: computed once here (was previously re-derived below) — also needed by the D4-FGA resourceGate
    // check right below, which runs AFTER the coarse allowP('agents:run') gate above.
    const principal = principalOf(c.req.raw);
    const resourceDenied = await resourceGate(c, principal, { type: 'agent', id: name }, 'run');
    if (resourceDenied) return resourceDenied;
    // WHOSE run this is — see resolveResourceId (it refuses a name no user can have) and callerOf (the
    // one mapping). A user's own identity wins; otherwise the request names the user.
    const subject = resolveResourceId(kindOf(c), principal?.id, body.resourceId);
    if ('error' in subject) return c.json({ error: subject.error }, 400);
    const caller = callerOf(c, subject.resourceId);
    // WHICH RUN — see identityOrError. From here on `runId` is the run's id (raw or derived) and
    // `declared` is the caller's name for the work: the door is handed the NAME, the gates below use
    // the ID, and a refusal reflects the name back.
    const identity = identityOrError(() => resolveWorkIdentity(`agent:${name}`, {
      ...(body.runId !== undefined ? { runId: body.runId } : {}),
      ...(body.workKey !== undefined ? { workKey: body.workKey } : {}),
      scopeKind: agentWorkScope(name),
      ...workAddressOf(caller),
      ...((s.orgId ?? principal?.orgId) ? { orgId: s.orgId ?? principal?.orgId } : {}),
      anonymous: 'refuse',
      surface: `POST /agents/${name}/run`,
    }));
    if ('error' in identity) return c.json({ error: identity.error }, 400);
    const runId = identity.runId!;
    const declared = identity.work?.workKey;
    { const denied = await threadOwnershipDenied(c, s, body.threadId, subject.resourceId); if (denied) return denied; }
    // KOŞUM SAHİPLİĞİ — `/resume`'un kapattığı deliğin aynısı buraya da geliyordu. Bu rotanın kendi
    // yorumu "aynı runId + approvals = resume niyeti" diyor (aşağıdaki bütçe kapısı da öyle
    // davranıyor), ama sahiplik yalnız THREAD üzerinden sorulup KOŞUM üzerinden hiç sorulmuyordu:
    // threadId gönderilmeyen bir istekte tek kapı da sessiz kalıyordu. Sömürü, sahipsiz doğan
    // koşumlara dayanıyordu — bu turda o üretim de kapandı (persistInput benimsenen sahibi yazıyor),
    // ama iki düzeltme birbirinin yerine geçmez: biri sahipsizliği azaltır, bu onu SORAR.
    // Türetilmiş id'de kapı yine sorar: `'org'` kapsamında iki özne TEK digest paylaşır, yani
    // sahipliği hash'in kendisi garanti etmez.
    if ((await runDecision(c, s, runId, subject.resourceId)) === 'deny') return foreignRun(c);
    // CONSISTENT with 1.3: continuing a suspended run from this endpoint with the SAME runId + approvals
    // (like stream does) is also resume intent → if there's a trace in the journal the budget gate is
    // skipped; new runIds are still ENFORCED (no regression).
    if (!(await isResumeIntent(s, runId))) {
      const over = await budgetGate(c, s);
      if (over) return over;
    }
    // §8's replay signal, read BEFORE the run — see priorWork.
    const prior = await priorWork(rawOf(s).journal as RawJournal, runId);
    // P0.3: register an org-scoped AbortController so POST /runs/:id/cancel can stop THIS generation.
    // Composed with the client's own disconnect signal (P0.2) via AbortSignal.any — whichever fires
    // first wins; either way the journal keeps whatever prefix already completed (resumable, same as P0.2).
    const ctrl = new AbortController();
    const key = inflightKey(s, runId);
    registerInflight(key, ctrl);
    try {
      // P1.7 seal the AUTHENTICATED identity into context — a body-supplied
      // `context.__gnl_orgId`/`__gnl_resourceId`/`__gnl_threadId` (spoof attempt) is stripped and
      // replaced by (or removed in favor of) the server-derived value. See sealRequestContext.
      const r = await s.gnl.run(name, {
        // The NAME when the caller declared one (so the door writes it into the run's record), the
        // raw id otherwise. Never both — the gate above already refused that.
        ...(declared !== undefined ? { workKey: declared } : { runId }),
        prompt: body.prompt,
        messages: body.messages,
        threadId: body.threadId,
        approvals: body.approvals,
        context: sealFor(
          // Not merged here, because sealRequestContext writes `org` itself from the server-derived
          // value. This is a simplification, NOT a fix: measured over 21 body shapes × 4 server states
          // — including a prototype-polluted body, a getter for `org`, a null-prototype object and an
          // empty-string orgId — the merge and the seal never disagree, because the seal's first act is
          // an unconditional delete that dominates anything written here. The security property lives
          // entirely in sealRequestContext; the earlier version of this comment claimed otherwise.
          body.context ?? {},
          caller,
          s.orgId ?? principal?.orgId,
        ),
        limits: clampLimits(opts.limits, body.limits),
        // P0.2 a client disconnect stops generation instead of billing tokens to
        // completion — an abort mid-run does NOT break resumable behavior, the journal keeps whatever
        // prefix already completed and a later call with the SAME runId resumes/replays as before.
        // P0.3: OR an explicit cancel via POST /runs/:id/cancel (ctrl.signal) — same non-destructive semantics.
        abortSignal: AbortSignal.any([c.req.raw.signal, ctrl.signal]),
      });
      // `finishReason` is here because without it an empty answer is unreadable. A run whose model
      // returned nothing answers 200 with `text: ""` — identical, on the wire, to a model that
      // legitimately chose to say nothing. Measured in the field: a provider returned an empty
      // response with `finishReason: 'unknown'`, the run was journaled as completed, and the caller
      // had no way to tell the two apart. The framework already knows which happened; it just was
      // not saying. Additive field, so existing clients are unaffected.
      // `replayedToolCalls` rides along for the same reason as finishReason: the engine knows this
      // answer came from the journal instead of executing (replay-disclosure envelope), and a UI that
      // wants to badge it should not have to infer it from prose. Additive; absent on fresh work.
      return stampRunHeaders(
        c.json({ ok: true, runId, text: r.text, interrupts: r.interrupts, finishReason: r.finishReason, ...((r as { replayedToolCalls?: unknown[] }).replayedToolCalls?.length ? { replayedToolCalls: (r as { replayedToolCalls?: unknown[] }).replayedToolCalls } : {}) }),
        runId,
        prior,
      );
    } catch (e: any) {
      // The correlation handle rides on refusals too: a caller who named work and got a 409 has no
      // other way to learn which run it collided with.
      return stampRunHeaders(
        limitErrorResponse(c, e) ?? threadMismatchResponse(c, e, declared) ?? callerConflictResponse(c, e, declared) ?? blockedErrorResponse(c, e) ?? upstreamErrorResponse(c, e) ?? c.json({ error: String(e?.message ?? e) }, 400),
        runId,
      );
    } finally {
      unregisterInflight(key, ctrl);
    }
  });

  app.post('/agents/:name/resume', async (c) => {
    if (!(await allowP(c.req.raw, 'agents:run'))) return deny(c.req.raw, 'write');
    const name = c.req.param('name');
    const parsed = await readSignedBody(c); // F1: A2A signature enforced here too
    if ('denied' in parsed) return parsed.denied;
    const body = parsed.body as any;
    if (!body.runId) return c.json({ error: 'runId required' }, 400);
    const s = await scope(c);
    if ('error' in s) return c.json({ error: s.error }, s.status);
    const gated = agentGate(c, name, s.orgId);
    if (gated) return gated;
    const approvalDenied = await agentApprovalGate(c, name);
    if (approvalDenied) return approvalDenied;
    // Resume needs the same resource gate the other five endpoints have, and it needs it MORE than
    // they do: the body carries `approvals`, so a caller who is denied /run could otherwise resume a
    // run someone else started and approve the exact tool call the human gate had stopped. Denying
    // the cheap path while leaving the dangerous one open is the wrong way round.
    const resourceDenied = await resourceGate(c, principalOf(c.req.raw), { type: 'agent', id: name }, 'run');
    if (resourceDenied) return resourceDenied;
    // …and the FREE-tier half of the same concern. `resourceGate` is the paid FGA surface; a deployment
    // without it had nothing here at all, so one end user could resume another's run — and `approvals`
    // is exactly the field that decides a tool call a human gate had stopped. The caller states whose
    // run it believes this to be (`?resourceId=`, or `resourceId` in the body it is already sending)
    // and is refused when the run says otherwise. Unstated stays permitted: see ownershipDenied.
    { const denied = clientSubjectDenied(c, body.resourceId); if (denied) return denied; }
    // A resume needs a run. One that does not exist is a 404 — and so, for a caller who is not staff, is
    // one that is someone else's (`asMissing`), so the two cannot be told apart.
    const missingRun = () => c.json({ error: `run '${String(body.runId)}' not found` }, 404);
    const access = await runAccess(c, s, String(body.runId), body.resourceId);
    if (access.decision === 'missing') return missingRun();
    if (access.decision === 'deny') return kindOf(c) === 'operator' ? foreignRun(c) : missingRun();
    const owner = access.owner;
    if (owner.state !== 'owned') return missingRun(); // `allow` is only ever given for a run that exists
    // …and the half of the same rule that no declaration can satisfy. The gate above asks about the
    // subject the CALLER STATED; this one asks the question the engine asks on every other route and
    // cannot ask on this one, because the identity this route seals is the run's own. See
    // actorParityDenied — measured, `/run` answered 409 and `/resume` answered 200 to the same caller.
    { const denied = await actorParityDenied(c, s, body.runId, missingRun); if (denied) return denied; }
    // CONSISTENT with H2/1.3: only a REAL resume (there's a trace in the journal) skips the budget
    // gate — otherwise this endpoint would be an unlimited backdoor (bypassing the quota with a
    // traceless/made-up runId). Without a trace (typo/abuse) it's ENFORCED normally; input also comes
    // back empty and the request fails harmlessly.
    if (!(await priorWork(rawOf(s).journal as RawJournal, body.runId, owner))) {
      const over = await budgetGate(c, s);
      if (over) return over;
    }
    // The frozen input, from the owner read the gate already made → no need to re-supply the prompt
    // (self-contained resume), and no second reading of the same record.
    const input: any = owner.record ?? {};
    try {
      const r = await s.gnl.run(name, {
        runId: body.runId,
        approvals: body.approvals,
        // Sealed like run and stream. This path built the context by hand and therefore carried
        // neither `__gnl_resourceId` nor `__gnl_threadId`, so a dynamic `system`/`model`/`tools`
        // function saw an identity on a fresh run and none on the resume of that same run — the two
        // halves of one conversation disagreeing about who the caller is.
        // Sealed with the run's RECORDED owner (`runOwnerOf`), for the same reason the prompt and
        // threadId below come from the frozen input: a resume is self-contained, and the second half
        // of a conversation must not change owner. It is also who the engine runs an existing run as
        // (`actingCaller`), so the seal and the engine agree — staff resuming Ayşe's run runs it as
        // Ayşe. Read through the one reading, so an unstamped record names nobody here either.
        context: sealFor({}, owner.owner, s.orgId ?? principalOf(c.req.raw)?.orgId),
        limits: clampLimits(opts.limits, body.limits),
        ...(input.messages ? { messages: input.messages } : { prompt: input.prompt }),
        // The threadId comes from `:input` for the same reason the prompt does: a resume is
        // self-contained and the client does not re-send it. Without it the registry's memory has no
        // thread to append to — runDurable's append is conditioned on `memory && threadId` — so the
        // assistant's reply to an approved call never entered the conversation. Measured: the user
        // asks for a charge, a human approves it, the charge goes through, and the thread still holds
        // only the user's message. The next turn's model sees no charge and no answer.
        ...(input.threadId ? { threadId: input.threadId } : {}),
      });
      // `finishReason` is here because without it an empty answer is unreadable. A run whose model
      // returned nothing answers 200 with `text: ""` — identical, on the wire, to a model that
      // legitimately chose to say nothing. Measured in the field: a provider returned an empty
      // response with `finishReason: 'unknown'`, the run was journaled as completed, and the caller
      // had no way to tell the two apart. The framework already knows which happened; it just was
      // not saying. Additive field, so existing clients are unaffected.
      // `replayedToolCalls` rides along for the same reason as finishReason: the engine knows this
      // answer came from the journal instead of executing (replay-disclosure envelope), and a UI that
      // wants to badge it should not have to infer it from prose. Additive; absent on fresh work.
      return c.json({ ok: true, runId: body.runId, text: r.text, interrupts: r.interrupts, finishReason: r.finishReason, ...((r as { replayedToolCalls?: unknown[] }).replayedToolCalls?.length ? { replayedToolCalls: (r as { replayedToolCalls?: unknown[] }).replayedToolCalls } : {}) });
    } catch (e: any) {
      return limitErrorResponse(c, e) ?? threadMismatchResponse(c, e) ?? callerConflictResponse(c, e) ?? blockedErrorResponse(c, e) ?? upstreamErrorResponse(c, e) ?? c.json({ error: String(e?.message ?? e) }, 400);
    }
  });

  /**
   * ── Liveness and readiness ──────────────────────────────────────────────────────────────────
   *
   * Deliberately UNAUTHENTICATED. Every orchestrator that would use these — Docker, Fly, Cloud Run,
   * Kubernetes, a load balancer — probes before it has, or ever will have, a credential. A health
   * check behind auth is a health check nothing can call.
   *
   * That makes what they SAY the design question. They report reachability and nothing else: no agent
   * names, no org information, no counts, no configuration. In particular `/ready` never returns the
   * underlying error text — a Postgres connection failure routinely carries the host, database and
   * user in its message, and this endpoint is world-readable. The operator gets the reason from the
   * logs; the probe gets a status code.
   *
   * TWO ROUTES, because they answer two different questions and conflating them causes the wrong
   * action:
   *   /health  — is this process alive? No I/O at all. A failing DEPENDENCY must not make an
   *              Orchestrator kill and restart a perfectly healthy process; restarting it does not
   *              Reconnect anyone's database.
   *   /ready   — can it serve? Touches the journal, so a process whose storage is unreachable is
   *              Pulled OUT of the load balancer while staying alive to recover.
   * Point liveness probes at the first and readiness/traffic probes at the second.
   */
  app.get('/health', (c) => c.json({ status: 'ok', uptimeSec: Math.floor(process.uptime()) }));

  /**
   * `/ready` is unauthenticated, so anyone who can reach the port decides how often it touches the
   * database. The read itself is cheap (5000 sequential in-memory gets ≈ 66ms), so this is not about
   * CPU — it is about what a BURST costs against a real database: each request is a real query, and
   * when storage HANGS each one parks an uncancelled promise, and its connection, for the whole 2s
   * budget. Two bounds, both closed over THIS app instance:
   *   - one probe in flight at a time — concurrent requests await the same promise, so a burst parks
   *     One connection rather than one per request;
   *   - a settled answer is reused for 1s. Readiness probes fire on second-scale periods (Kubernetes'
   *     PeriodSeconds defaults to 10, Fly and Cloud Run sit in the same range), so a 1s window changes
   *     No orchestrator's view of this process while collapsing any burst to ≤1 query per second.
   * Deliberately NOT module-level state: `createRestApi` can be called more than once in a process
   * (tests do, and so does anyone mounting two APIs over different storage), and two apps sharing one
   * cache would answer for each other's journal.
   * The 2s budget and the response contract are unchanged by any of this.
   */
  const readyBudgetMs = 2_000;
  const readyCacheMs = 1_000;
  // The warning is one line per FAILED probe, and a failing probe is exactly the moment an unauthenticated
  // caller can repeat cheaply — an outage plus a probe loop (or a hostile client) turns the operator's log
  // into noise that hides the first, useful line. 30s is the shortest interval that still keeps the failure
  // visible in a log tail while surviving an hour of outage in ~120 lines. The first failure after a quiet
  // period always warns again, so a recurrence is never silent.
  const readyWarnEveryMs = 30_000;
  let readyCache: { at: number; ok: boolean } | undefined;
  let readyInFlight: Promise<boolean> | undefined;
  let readyWarnedAt = 0;

  /** Resolves the readiness answer, from cache, from a probe already running, or from a new one. */
  const probeReady = (): Promise<boolean> => {
    // Date.now rather than a timer so the window is readable — and testable — without a clock of its own.
    if (readyCache && Date.now() - readyCache.at < readyCacheMs) return Promise.resolve(readyCache.ok);
    if (readyInFlight) return readyInFlight;
    const probe = (async () => {
      // A read is enough to prove the connection is usable, and cannot disturb any run's state. The
      // key is deliberately one that never exists.
      await baseJournal.get('__gnl_readiness_probe__');
      return true;
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Bounded on purpose: an unreachable database usually HANGS rather than refusing, and a probe that
    // hangs is read as a timeout by some orchestrators and as success by others. Answer either way.
    const timeout = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), readyBudgetMs); });
    // Assigned synchronously — anything that arrives before the race settles must find this promise.
    readyInFlight = Promise.race([probe.catch(() => false), timeout]).then((ok) => {
      if (timer) clearTimeout(timer);
      readyCache = { at: Date.now(), ok };
      readyInFlight = undefined;
      return ok;
    });
    return readyInFlight;
  };

  app.get('/ready', async (c) => {
    const ok = await probeReady();
    if (!ok) {
      // The reason stays in the logs; the response says only that storage is not reachable.
      const now = Date.now();
      if (now - readyWarnedAt >= readyWarnEveryMs) {
        readyWarnedAt = now;
        console.warn('@gnldev/server: readiness probe failed — the journal did not answer within ' + readyBudgetMs + 'ms (repeats suppressed for ' + readyWarnEveryMs / 1000 + 's)');
      }
      return c.json({ status: 'unavailable', storage: 'unreachable' }, 503);
    }
    return c.json({ status: 'ready' });
  });

  // Metadata list of registered agents (for the client/playground agent selector).
  // Org-scoped: an org-bound caller only sees GLOBAL agents + agents whose `orgs` include their org.
  app.get('/agents', async (c) => {
    if (!(await allowP(c.req.raw, 'catalog:read'))) return deny(c.req.raw, 'read');
    const s = await scope(c);
    if ('error' in s) return c.json({ error: s.error }, s.status);
    return c.json(listAgentMeta(config, s.orgId));
  });

  // ── Agent approval registry (governance surface — see RestApiOptions.requireAgentApproval) ──────
  // Platform-level: "should this code-agent serve AT ALL" is never a per-org decision, so every endpoint
  // here is platform-admin gated (requirePlatformAdmin) REGARDLESS of whether requireAgentApproval is
  // turned on — an operator can review/approve agents ahead of flipping the enforcement flag.
  app.get('/agents/registry', async (c) => {
    if (!(await allowP(c.req.raw, 'catalog:read'))) return deny(c.req.raw, 'read');
    { const denied = requirePlatformAdmin(c, 'an org-bound identity cannot view the agent registry (operator required)'); if (denied) return denied; }
    await agentRegistryBoot;
    try {
      return c.json(await listAgentRegistry(baseJournal));
    } catch (e: any) {
      return c.json({ error: String(e?.message ?? e) }, 501);
    }
  });

  app.post('/agents/registry/:name/approve', async (c) => {
    if (!(await allowP(c.req.raw, 'agents:approve'))) return deny(c.req.raw, 'write');
    { const denied = requirePlatformAdmin(c, 'an org-bound identity cannot approve an agent (operator required)'); if (denied) return denied; }
    await agentRegistryBoot;
    const name = decodeURIComponent(c.req.param('name'));
    const body = (await c.req.json().catch(() => ({}))) as { note?: string };
    const rec = await approveAgent(baseJournal, name, actorOf(c), body.note);
    await audit(c, undefined, 'agent.approve', name, body.note !== undefined ? { note: body.note } : undefined);
    return c.json({ ok: true, record: rec });
  });

  app.post('/agents/registry/:name/block', async (c) => {
    if (!(await allowP(c.req.raw, 'agents:block'))) return deny(c.req.raw, 'write');
    { const denied = requirePlatformAdmin(c, 'an org-bound identity cannot block an agent (operator required)'); if (denied) return denied; }
    await agentRegistryBoot;
    const name = decodeURIComponent(c.req.param('name'));
    const body = (await c.req.json().catch(() => ({}))) as { note?: string };
    const rec = await blockAgent(baseJournal, name, actorOf(c), body.note);
    await audit(c, undefined, 'agent.block', name, body.note !== undefined ? { note: body.note } : undefined);
    return c.json({ ok: true, record: rec });
  });

  // Streaming run: text-delta/tool-call/... SSE events, finally interrupt + done (same durability).
  app.post('/agents/:name/stream', async (c) => {
    if (!(await allowP(c.req.raw, 'agents:run'))) return deny(c.req.raw, 'write');
    const name = c.req.param('name');
    const parsed = await readSignedBody(c); // F1: A2A signature enforced here too
    if ('denied' in parsed) return parsed.denied;
    return streamDoor(c, name, parsed.body as any, ({ result, runId }) => {
      // Disconnect-recovery — if there's a Last-Event-ID header (sent automatically by
      // EventSource) or body.lastEventId, events the client has already seen are not rewritten (see the note in sse.ts).
      const lastEventIdRaw = c.req.header('Last-Event-ID') ?? (parsed.body as any)?.lastEventId;
      const lastEventId = lastEventIdRaw != null && lastEventIdRaw !== '' ? Number(lastEventIdRaw) : undefined;
      return pipeAgentStream(c, runId, result, Number.isFinite(lastEventId as number) ? { lastEventId } : undefined);
    });
  });

  // THE OTHER WIRE FORMATS, on the same door. Registered here, after `/stream`, so a surface cannot
  // shadow a REST route — and refused at construction if it tries to take one of REST's own paths.
  for (const surface of opts.surfaces ?? []) {
    if (!surface.path.includes(':name')) throw new Error(`createRestApi: surface path '${surface.path}' must contain ':name' (the agent)`);
    if (['/agents/:name/run', '/agents/:name/resume', '/agents/:name/stream'].includes(surface.path)) {
      throw new Error(`createRestApi: surface path '${surface.path}' is a REST route; mount the surface on its own path (e.g. '/agents/:name/chat')`);
    }
    app.post(surface.path, async (c) => {
      if (!(await allowP(c.req.raw, 'agents:run'))) return deny(c.req.raw, 'write');
      const name = c.req.param('name') as string;
      const parsed = await readSignedBody(c);
      if ('denied' in parsed) return parsed.denied;
      let input: StreamSurfaceInput;
      try {
        input = await surface.decode(parsed.body ?? {}, c.req.raw);
      } catch (e: any) {
        return c.json({ error: String(e?.message ?? e) }, 400);
      }
      return streamDoor(c, name, { ...input }, ({ result, runId, threadId }) => surface.encode(result, { runId, threadId, c }));
    });
  }

  /**
   * The agent stream door: every gate between "a caller asked for a stream" and "the stream exists",
   * written once. `/agents/:name/stream` and every `surfaces` entry go through it; they differ only
   * in how the body was decoded and how the result is encoded.
   */
  async function streamDoor(
    c: Context,
    name: string,
    body: any,
    encode: (m: { result: any; runId: string; threadId?: string }) => Response,
  ): Promise<Response> {
    adoptIdempotencyKey(c, body);
    if (!body.runId && !body.workKey && !body.turnKey) return c.json({ error: NO_IDENTITY }, 400);
    const s = await scope(c);
    if ('error' in s) return c.json({ error: s.error }, s.status);
    const gated = agentGate(c, name, s.orgId);
    if (gated) return gated;
    const approvalDenied = await agentApprovalGate(c, name);
    if (approvalDenied) return approvalDenied;
    // P1.7: computed once here (was previously re-derived below) — also needed by the D4-FGA resourceGate
    // check right below, which runs AFTER the coarse allowP('agents:run') gate above.
    const principal = principalOf(c.req.raw);
    const resourceDenied = await resourceGate(c, principal, { type: 'agent', id: name }, 'run');
    if (resourceDenied) return resourceDenied;
    // WHOSE run this is — see the same lines in /agents/:name/run.
    const subject = resolveResourceId(kindOf(c), principal?.id, body.resourceId);
    if ('error' in subject) return c.json({ error: subject.error }, 400);
    const caller = callerOf(c, subject.resourceId);
    // A surface's turn key: a NAME when there is a subject to address it under, the raw id it has
    // always been otherwise (the standalone chat/agui regime, kept so an operator's playground turn
    // without a subject still runs).
    if (!body.runId && !body.workKey && body.turnKey) {
      if (subject.resourceId) body.workKey = body.turnKey;
      else body.runId = body.turnKey;
    }
    // WHICH RUN — the same resolution `/agents/:name/run` makes, and deliberately not a variation of
    // it: a rule that held on one of these two doors is a rule missing from the other.
    const identity = identityOrError(() => resolveWorkIdentity(`agent:${name}`, {
      ...(body.runId !== undefined ? { runId: body.runId } : {}),
      ...(body.workKey !== undefined ? { workKey: body.workKey } : {}),
      scopeKind: agentWorkScope(name),
      ...workAddressOf(caller),
      ...((s.orgId ?? principal?.orgId) ? { orgId: s.orgId ?? principal?.orgId } : {}),
      anonymous: 'refuse',
      surface: `POST ${c.req.routePath.replace(':name', name)}`,
    }));
    if ('error' in identity) return c.json({ error: identity.error }, 400);
    const runId = identity.runId!;
    const declared = identity.work?.workKey;
    { const denied = await threadOwnershipDenied(c, s, body.threadId, subject.resourceId); if (denied) return denied; }
    // KOŞUM SAHİPLİĞİ — `/resume`'un kapattığı deliğin aynısı buraya da geliyordu. Bu rotanın kendi
    // yorumu "aynı runId + approvals = resume niyeti" diyor (aşağıdaki bütçe kapısı da öyle
    // davranıyor), ama sahiplik yalnız THREAD üzerinden sorulup KOŞUM üzerinden hiç sorulmuyordu:
    // threadId gönderilmeyen bir istekte tek kapı da sessiz kalıyordu. Sömürü, sahipsiz doğan
    // koşumlara dayanıyordu — bu turda o üretim de kapandı (persistInput benimsenen sahibi yazıyor),
    // ama iki düzeltme birbirinin yerine geçmez: biri sahipsizliği azaltır, bu onu SORAR.
    if ((await runDecision(c, s, runId, subject.resourceId)) === 'deny') return foreignRun(c);
    // 1.3: resume intent via approvals+runId (a pending tool approval) → the budget gate is skipped
    // CONSISTENTLY with /agents/:name/resume (otherwise a pending interrupt in an over-budget
    // organization would never finish).
    if (!(await isResumeIntent(s, runId))) {
      const over = await budgetGate(c, s);
      if (over) return over;
    }
    // P0.3: same registry as /agents/:name/run — composed with the client's disconnect signal (P0.2).
    const ctrl = new AbortController();
    const key = inflightKey(s, runId);
    registerInflight(key, ctrl);
    let result: any;
    try {
      // P1.7: same identity-sealing as /agents/:name/run above — see sealRequestContext.
      result = await s.gnl.stream(name, {
        // The name when one was declared, the raw id otherwise — see the same line in /run.
        ...(declared !== undefined ? { workKey: declared } : { runId }),
        prompt: body.prompt,
        messages: body.messages,
        threadId: body.threadId,
        approvals: body.approvals,
        context: sealFor(
          // Not merged here, because sealRequestContext writes `org` itself from the server-derived
          // value. This is a simplification, NOT a fix: measured over 21 body shapes × 4 server states
          // — including a prototype-polluted body, a getter for `org`, a null-prototype object and an
          // empty-string orgId — the merge and the seal never disagree, because the seal's first act is
          // an unconditional delete that dominates anything written here. The security property lives
          // entirely in sealRequestContext; the earlier version of this comment claimed otherwise.
          body.context ?? {},
          caller,
          s.orgId ?? principal?.orgId,
        ),
        limits: clampLimits(opts.limits, body.limits),
        // P0.2 same as /agents/:name/run above — stop generation (and its token
        // billing) on client disconnect. Deliberately compatible with W3 resumable SSE just below: an
        // abort only stops THIS response's fullStream early: the journal still has whatever prefix
        // completed before the abort, so a resumed/replayed call with the SAME runId (with or without
        // Last-Event-ID) sees the same journal state it would have without the abort.
        // P0.3: OR an explicit cancel via POST /runs/:id/cancel (ctrl.signal) — same non-destructive semantics.
        abortSignal: AbortSignal.any([c.req.raw.signal, ctrl.signal]),
      });
    } catch (e: any) {
      unregisterInflight(key, ctrl);
      return stampRunHeaders(
        limitErrorResponse(c, e) ?? threadMismatchResponse(c, e, declared) ?? callerConflictResponse(c, e, declared) ?? blockedErrorResponse(c, e) ?? upstreamErrorResponse(c, e) ?? c.json({ error: String(e?.message ?? e) }, 400),
        runId,
      );
    }
    // P0.3 cleanup: `s.gnl.stream(...)` above only resolves the STREAM RESULT object — the actual
    // fullStream consumption (and hence "this generation is done") happens INSIDE pipeAgentStream's
    // streamSSE callback below, which Hono drives independently of this handler's return (it doesn't
    // block on the SSE body finishing). Reaching INTO the streaming path to unregister exactly when the
    // response body closes would mean contorting sse.ts's generic event loop for one caller's
    // bookkeeping — not worth it. Instead: `result.finishReason` (a Vercel AI SDK StreamTextResult
    // promise — see sse.ts's own `await Promise.resolve(result.finishReason)`) settles exactly when
    // fullStream is fully drained (success OR error), which is a genuinely reachable, non-contorting
    // completion hook — use it. Swallowed on rejection (a stream error already produces its own `error`
    // SSE event in pipeAgentStream); this is ONLY registry bookkeeping.
    void Promise.resolve(result.finishReason).catch(() => {}).finally(() => unregisterInflight(key, ctrl));
    // `__gnlPriorRun` is streamDurable's own answer to the replay question (run.ts), so the streamed
    // path uses it rather than the pre-read: same question, asked by the code that already knows.
    return stampRunHeaders(
      encode({ result, runId, ...(body.threadId !== undefined ? { threadId: body.threadId } : {}) }),
      runId,
      (result as { __gnlPriorRun?: boolean })?.__gnlPriorRun === true,
    );
  }

  // Metadata list of registered workflows (name + steps + kind).
  app.get('/workflows', async (c) => ((await allowP(c.req.raw, 'catalog:read')) ? c.json(defaultInstance.gnl.listWorkflows()) : deny(c.req.raw, 'read')));

  // Run the workflow durably: {runId?, input}. If runId is given, it can be resumed with the same runId.
  app.post('/workflows/:name/run', async (c) => {
    if (!(await allowP(c.req.raw, 'workflow:run'))) return deny(c.req.raw, 'write');
    const name = c.req.param('name');
    if (!workflowNames.includes(name)) return c.json({ error: `workflow '${name}' not registered` }, 404);
    const parsed = await readSignedBody(c); // F1: A2A signature enforced here too
    if ('denied' in parsed) return parsed.denied;
    const body = parsed.body as any;
    const s = await scope(c);
    if ('error' in s) return c.json({ error: s.error }, s.status);
    // D4-FGA: runs AFTER the coarse allow(c,'write') gate above.
    const principal = principalOf(c.req.raw);
    const resourceDenied = await resourceGate(c, principal, { type: 'workflow', id: name }, 'run');
    if (resourceDenied) return resourceDenied;
    // KİMLİK KAPILARI. Bu rota ajan rotalarındaki üç kapının HİÇBİRİNE uğramıyordu, ve eksiklik
    // görünmüyordu çünkü iş akışı koşumları sahipsiz doğuyordu: sorulacak bir sahip yoktu. Sahip
    // kaydı geldi (registry.ts runWorkflowInner) — kapılar da gelmeli, yoksa yazılan sahibi kimse
    // sormuyor demektir.
    //
    // (a) A USER'S OWN NAME OVERRIDES THE BODY — otherwise Mallory writes the victim's name into the
    // body and the owner record becomes a tool for impersonation instead of a protection. Staff and
    // applications name the subject in the body; staff may name none, because an org-level workflow
    // ("nightly reconciliation") has no subject and this route's documented exemption keeps it so.
    const caller = callerOf(c, body.resourceId);
    const subject = userIdOf(caller);
    // WHICH RUN. The workflow door takes its scope PER CALL — unlike the agent doors, where it is the
    // agent's declaration — and this route passes the body's through, because a workflow has no
    // config site to declare it on and `workScope: 'org'` is the whole point of the jobs that arrive
    // here: a nightly reconciliation belongs to the installation, not to whoever's cron fired it.
    // The value is VALIDATED rather than coerced: an unrecognised string silently becoming
    // `'resource'` would be the quiet half of §6's asymmetry, and a typo is not a scope decision.
    if (body.workScope !== undefined && body.workScope !== 'resource' && body.workScope !== 'org') {
      return c.json({ error: "workScope must be 'resource' or 'org'" }, 400);
    }
    const identity = identityOrError(() => resolveWorkIdentity(`wf:${name}`, {
      ...(body.runId !== undefined ? { runId: String(body.runId) } : {}),
      ...(body.workKey !== undefined ? { workKey: body.workKey } : {}),
      scopeKind: (body.workScope as WorkScopeKind | undefined) ?? 'resource',
      ...workAddressOf(caller),
      ...((s.orgId ?? principal?.orgId) ? { orgId: s.orgId ?? principal?.orgId } : {}),
      // This door keeps its loud anonymous fallback — `runWorkflow` generates a name and says so.
      anonymous: 'allow',
      surface: `POST /workflows/${name}/run`,
    }));
    if ('error' in identity) return c.json({ error: identity.error }, 400);
    const runId = identity.runId;
    const declared = identity.work?.workKey;
    // (b) AYNI runId'yle YENİDEN GİRİŞ. Aşağıdaki H2 notu bu rotanın iş akışı için TEK resume
    // mekanizması olduğunu söylüyor: aynı runId = devam. Yani runId'yi bilen biri kurbanın koşumunu
    // sürdürüp dönen `steps[].output` içinde adım çıktılarını okuyabiliyordu — `/agents/:name/resume`
    // için kapatılan deliğin kelimesi kelimesine aynısı, komşu uçta. runId beyan edilmemişse
    // sorulacak bir koşum da yok (üretilen ad yepyeni).
    if (runId) {
      if ((await runDecision(c, s, runId, subject)) === 'deny') return foreignRun(c);
    }
    // The thread, as on the agent doors. This route took the body's `threadId` as given, so an end user
    // attached a workflow run to another user's thread — locking her out of it, and (the run being
    // his) taking her messages with his account when it was deleted.
    { const denied = await threadOwnershipDenied(c, s, body.threadId, subject); if (denied) return denied; }
    // H2: this endpoint with the same runId is the ONLY resume mechanism for a workflow. If runId is
    // given AND there's already a trace in the journal (suspended/paused) this is a resume → the budget
    // gate is skipped (new work is still ENFORCED).
    if (!(runId && (await isResumeIntent(s, runId)))) {
      const over = await budgetGate(c, s);
      if (over) return over;
    }
    // P0.4: register an org-scoped AbortController in the SAME `inflight` map used by agent runs, but
    // under a `wf:` sub-namespace — a client-supplied workflow runId and an agent runId could collide,
    // so keying them into the SAME bucket would let `/runs/:id/cancel` (agent-only) abort a workflow run
    // by accident. Only `POST /workflows/runs/:id/cancel` below targets this namespace; only registered
    // when body.runId is known (an auto-generated runId has no addressable key for a future cancel).
    const ctrl = new AbortController();
    const wfKey = runId ? 'wf:' + inflightKey(s, runId) : undefined;
    if (wfKey) registerInflight(wfKey, ctrl);
    try {
      const wfOpts = {
        // The name when the caller declared one, the raw id otherwise, nothing when neither — the
        // door's own anonymous fallback then mints (and announces) a name.
        ...(declared !== undefined
          ? { workKey: declared, ...(body.workScope ? { workScope: body.workScope as WorkScopeKind } : {}) }
          : runId ? { runId } : {}),
        // KİMLİK. İş akışı koşumları yapısal olarak sahipsiz doğuyordu ve bunun görünür sonucu şuydu:
        // `POST /workflows/runs/:id/cancel` sahiplik kapısını çağırıyor ama kapı sahibi hiç bulamıyor,
        // yani kontrol her zaman sessizce geçiyordu. Muafiyet ("org düzeyi iş, öznesi yok") ajan
        // İÇİNDEN doğan iş akışları için yanlış: o, belli bir kullanıcının koşumundan çıkıyor.
        // Beyan edilmezse hiçbir şey yazılmaz — muafiyet korunur, uydurulmuş sahip olmaz.
        // The CALLER, as the one mapping gave it — not a resourceId string re-read into one.
        caller,
        ...(body.threadId ? { threadId: String(body.threadId) } : {}),
        // (c) MÜHÜR — ajan rotalarındaki desenin aynısı (`sealRequestContext`). Gövdenin kendi
        // `context`'i BİLEREK alınmıyor: bu rota bugün onu hiç okumuyor, dolayısıyla mühürlenecek bir
        // sızma yüzeyi de yok; `body.context`'i buraya bağlamak, kapatmak için var olan yüzeyi ÖNCE
        // açmak olurdu. Mühürlenen tek şey sunucunun kendi türettiği kimlik — /agents/:name/resume
        // ile birebir aynı biçim. Motorun içindeki `serverIdentityOf` mühürlü değeri gövdeden gelene
        // tercih ediyor, yani thread sahiplik kapısı ve sahip kaydı aynı çifti görüyor.
        context: sealFor({}, caller, s.orgId ?? principal?.orgId),
        // P0.4 typed resume: `{ [waitId]: payload }` — journaled before any step runs (see waitForResume).
        ...(body.resume ? { resume: body.resume } : {}),
        // Composed with the client's disconnect signal — same non-destructive semantics as P0.2/P0.3 for
        // agent runs: an abort just stops new steps, the journal keeps whatever prefix already completed.
        signal: AbortSignal.any([c.req.raw.signal, ctrl.signal]),
      };
      const result = await s.gnl.runWorkflow(name, body.input, wfOpts);
      // The result already carries the id (the door generates one when nobody named anything), so
      // the header echoes THAT rather than the route's guess — the two agree, and only one of them
      // is authoritative.
      const res = c.json({ ok: true, ...result });
      const effective = (result as { runId?: string }).runId ?? runId;
      return effective ? stampRunHeaders(res, effective) : res;
    } catch (e: any) {
      const res = limitErrorResponse(c, e) ?? threadMismatchResponse(c, e, declared) ?? callerConflictResponse(c, e, declared) ?? blockedErrorResponse(c, e) ?? upstreamErrorResponse(c, e) ?? c.json({ error: String(e?.message ?? e) }, 400);
      return runId ? stampRunHeaders(res, runId) : res;
    } finally {
      if (wfKey) unregisterInflight(wfKey, ctrl);
    }
  });

  /**
   * P0.4 the suspended/completed/canceled workflow-run REGISTRY query — every run
   * in ONE `wfrun:` prefix scan (see @gnldev/workflow's listWorkflowRuns). Org-scoped via `scope(c)`/
   * `s.journal`: `wfrun:<runId>` keys are NOT runId-prefixed but `withOrg` still prefixes them
   * unconditionally (prefixes EVERY key), so organization isolation holds automatically — see the
   * `statusKey` JSDoc in workflow.ts. `listKeys` is an optional Journal capability; without it
   * `listWorkflowRuns` throws a clear error — surfaced as 501 (capability-missing, same pattern as
   * studio's own listKeys-gated routes) rather than a silent empty list.
   */
  app.get('/workflows/runs', async (c) => {
    if (!(await allowP(c.req.raw, 'runs:read'))) return deny(c.req.raw, 'read');
    const s = await scope(c);
    if ('error' in s) return c.json({ error: s.error }, s.status);
    const statusRaw = c.req.query('status');
    let status: WorkflowRunStatus['status'] | undefined;
    if (statusRaw != null) {
      if (statusRaw !== 'suspended' && statusRaw !== 'completed' && statusRaw !== 'canceled') {
        return c.json({ error: `invalid status '${statusRaw}' (expected 'suspended', 'completed', or 'canceled')` }, 400);
      }
      status = statusRaw;
    }
    // WHOSE workflow runs — `/runs` next door does exactly this, and the two lists were reachable
    // with the SAME credential: the gate went onto the agent-run inventory and this one was left
    // showing every subject's row to anyone who could read. The exemption this route used to claim
    // ("org-level bookkeeping, not per-end-user") stopped being true the moment a workflow run
    // started carrying an owner.
    const resourceId = boundSubjectOf(c) ?? c.req.query('resourceId');
    // Before anything is read, for the reason the cancel route states: the requirement is about the
    // CREDENTIAL, not the target, so an application that has not said who it acts for must not learn
    // what exists.
    { const denied = clientSubjectDenied(c, resourceId); if (denied) return denied; }
    try {
      const runs = await listWorkflowRuns(s.journal, status ? { status } : {});
      if (!resourceId) return c.json(runs); // operatör: org boyunca çalışır, kimseyi adlandırmaz
      // WHOSE ROW: the gates' own answer, row by row — `runOwnerOf` (the one reading: the `_v` rule,
      // a record lost while rows remain) and `decideRunAccess` (the one rule), for the caller the list
      // is for. The `wfrun:` record carries no subject; the owner lives in `<runId>:input`.
      // This route used to read `resourceId` off that record by hand (M5): an unstamped record naming
      // Ayşe — staff's to every gate — was listed as hers, and a mutation letting ownerless rows in
      // failed no test. A row the gates would refuse this user is not in this user's list: ownerless,
      // unknown, lost-record and unreadable rows are all `deny` here, with no exception for staff —
      // staff asking for Ayşe's list asks for Ayşe's rows.
      const raw = rawOf(s).journal as RawJournal;
      const listFor = callerOf(c, resourceId);
      const mine: WorkflowRunStatus[] = [];
      for (const r of runs) {
        if (decideRunAccess(await runOwnerOf(raw, r.runId), listFor) === 'allow') mine.push(r);
      }
      return c.json(mine);
    } catch (e: any) {
      return c.json({ error: String(e?.message ?? e) }, 501);
    }
  });

  /**
   * P0.4: durably cancels a workflow run — reaches it on OTHER workers at its next step boundary (the
   * `_canceled` flag is checked before EVERY step by runResumable), terminal (a canceled run refuses to
   * resume forever). Visibility: EITHER the `wfrun:` registry record exists OR the `_suspend` marker does
   * (a run mid-flight whose advisory registry write failed still leaves this trace) — neither existing
   * means the run doesn't exist IN THIS SCOPE (cross-org 404, same no-existence-leak pattern as
   * agentGate/`/runs/:id/cancel`). ALSO aborts any in-flight controller registered for this workflow run
   * (the `wf:`-namespaced bucket registered by POST /workflows/:name/run above) — best-effort, same
   * multi-worker honesty caveat as `/runs/:id/cancel`.
   */
  app.post('/workflows/runs/:id/cancel', async (c) => {
    if (!(await allowP(c.req.raw, 'run:cancel'))) return deny(c.req.raw, 'write');
    const runId = decodeURIComponent(c.req.param('id'));
    const s = await scope(c);
    if ('error' in s) return c.json({ error: s.error }, s.status);
    // BEFORE the visibility 404: the requirement is about the CREDENTIAL, not about the target, so a
    // client that names nobody must not get as far as learning whether a run exists. Ordered the other
    // way it answered 404-vs-403 to a caller who had not identified who it was acting for, which is a
    // (small) existence oracle handed out for free.
    { const denied = clientSubjectDenied(c); if (denied) return denied; }
    // Existence from the raw instance, as on `/runs/:id/cancel`: a stranger's run is the ownership 403
    // below, like every write — the view would turn it into a 404.
    const raw = rawOf(s).journal;
    const status = await getWorkflowRunStatus(raw, runId);
    const visible = status !== undefined || (await raw.get(`${runId}:wf:_suspend`)) !== undefined;
    const missingWf = () => c.json({ error: `workflow run '${runId}' not found` }, 404);
    if (!visible) return missingWf();
    // Same expectation-check as the agent-run cancel next door — a workflow run carries an owner for
    // the same reason and stopping one is the same act.
    {
      const d = await runDecision(c, s, runId);
      if (d === 'deny') return kindOf(c) === 'operator' ? foreignRun(c) : missingWf();
    }
    // D4-FGA: runs AFTER the coarse allow(c,'write') gate above.
    const resourceDenied = await resourceGate(c, principalOf(c.req.raw), { type: 'workflow', id: runId }, 'cancel');
    if (resourceDenied) return resourceDenied;
    // A WRITE decided on the truth: the raw journal, never the caller's view (whose reads hide rows).
    const cancelled = await cancelWorkflowRun(raw, runId, {});
    const wfKey = 'wf:' + inflightKey(s, runId);
    const set = inflight.get(wfKey);
    if (set) for (const ctrl of set) ctrl.abort();
    await audit(c, s.orgId, 'workflow.cancel', runId, { cancelled });
    return c.json(cancelled
      ? { ok: true, cancelled: true }
      : { ok: true, cancelled: false, note: 'run already completed' });
  });

  /**
   * P0.3 GET /runs — paginated + filtered when any query param is given;
   * EXACTLY the legacy array response with NO params (backward compat — existing clients/tests that
   * assert on `runs[0].runId` etc. see byte-identical behavior).
   *   ?limit=      clamped to [1, 1000] (default 50 — same default every adapter's own listRuns uses)
   *   ?cursor=     opaque — pass back a page's `nextCursor` verbatim
   *   ?status=     'completed' | 'suspended' | 'failed' | 'running' | 'canceled' — else 400
   *   ?agent=      exact match against RunSummary.agent
   */
  app.get('/runs', async (c) => {
    if (!(await allowP(c.req.raw, 'runs:read'))) return deny(c.req.raw, 'read');
    const s = await scope(c);
    if ('error' in s) return c.json({ error: s.error }, s.status);
    const limitRaw = c.req.query('limit');
    const cursor = c.req.query('cursor');
    const statusRaw = c.req.query('status');
    const agent = c.req.query('agent');
    // WHOSE runs. An application credential serving many end users lists one user's runs with this;
    // it is the read half of the `resourceId` the run was started with (see resolveResourceId).
    // STRICT: bağlı kimlik kendi listesine iner ve beyanı EZER. Bu satır olmadan /threads'ten
    // silinen envanter buradan aynen okunuyordu — üstelik `threadId` + `resourceId` alanlarıyla,
    // yani kapanan deliğin HEDEF LİSTESİNİ geri veriyordu. Aynı sınıf, komşu uç: kapıyı üç yere
    // koyup dördüncüsünü atlamak, kapıyı hiç koymamakla aynı kapıdan geçilmesini engellemiyor.
    // The REQUEST's own word for the subject, kept apart from the RESOLVED one below: the legacy
    // shortcut keys on this, so the response SHAPE stays a fact about the request. Keyed on the
    // resolved subject it made the same parameterless URL answer an array to an operator and
    // `{items:[…]}` to a bound end user — and @gnldev/client's `listRuns()` casts to an array, so
    // turning on the switch that closes a leak broke the typed client for the caller it protects.
    const declaredResource = c.req.query('resourceId');
    const resourceId = boundSubjectOf(c) ?? declaredResource;
    // Checked BEFORE the no-params shortcut below, which is the branch that would otherwise hand a
    // client the whole organization's run list — the exact read this rule exists to scope.
    { const denied = clientSubjectDenied(c, resourceId); if (denied) return denied; }
    if (limitRaw == null && cursor == null && statusRaw == null && agent == null && declaredResource == null) {
      // Shape unchanged; the BOUND subject is still applied, because a stable shape that stopped
      // filtering would hand this caller the whole organization — see the line above.
      const rows = await s.journal.listRuns();
      return c.json(resourceId ? rows.filter((r) => r.resourceId === resourceId) : rows);
    }
    // A list rather than a chain of !==: this validation has lagged the vocabulary at every widening
    // ('failed', then 'running', now 'canceled'), and a chain invites the next one. The message is
    // built from the same list, so it can never advertise a smaller vocabulary than it accepts.
    const RUN_STATUSES = ['completed', 'suspended', 'failed', 'running', 'canceled'] as const;
    let status: (typeof RUN_STATUSES)[number] | undefined;
    if (statusRaw != null) {
      if (!(RUN_STATUSES as readonly string[]).includes(statusRaw)) {
        return c.json({ error: `invalid status '${statusRaw}' (expected one of ${RUN_STATUSES.join(', ')})` }, 400);
      }
      status = statusRaw as (typeof RUN_STATUSES)[number];
    }
    const limit = limitRaw != null ? Math.max(1, Math.min(1000, Math.trunc(Number(limitRaw)) || 50)) : undefined;
    const q = {
      ...(limit != null ? { limit } : {}),
      ...(cursor ? { cursor } : {}),
      ...(status ? { status } : {}),
      ...(agent ? { agent } : {}),
      ...(resourceId ? { resourceId } : {}),
    };
    const paged = (s.journal as Partial<JournalReader>).listRunsPaged;
    if (typeof paged === 'function') {
      return c.json(await paged.call(s.journal, q));
    }
    // P0.3 fallback: the scoped journal doesn't offer the paged capability (e.g. a bare custom
    // JournalReader) — apply the SAME filter+limit semantics over the legacy array instead of failing
    // the request. Honest cost: this materializes EVERY run before filtering/slicing (the array method
    // already does that internally); acceptable since it only triggers when the paged capability is
    // genuinely absent. `source` is intentionally NOT stamped on the response — the shape stays
    // identical to the paged branch above ({items, nextCursor}) so callers don't need to branch on it.
    const all = await s.journal.listRuns();
    const filtered = all.filter((r) => (status ? r.status === status : true) && (agent ? r.agent === agent : true)
      && (resourceId ? r.resourceId === resourceId : true));
    const start = cursor ? Number(cursor) || 0 : 0;
    const lim = limit ?? 50;
    const items = filtered.slice(start, start + lim);
    const next = start + lim;
    return c.json({ items, nextCursor: next < filtered.length ? String(next) : undefined });
  });

  /**
   * P0.3 cancel in-flight generation for a run on THIS server instance.
   * HONESTY (multi-worker): `inflight` is a plain in-process Map — this endpoint can only abort
   * controllers registered on the SAME process that received THIS request. Behind a load balancer with
   * multiple workers, a run's `/stream` may be in-flight on a DIFFERENT worker than the one that
   * receives the cancel → `cancelled: 0` even though the run is genuinely still running elsewhere.
   * Closing that gap needs a journal-level cancel FLAG that every worker polls during generation
   * (deliberately deferred — see P0.4/P2). The run itself is UNAFFECTED by this
   * limitation: it stays resumable either way (the journal prefix is intact — cancel never deletes
   * anything, it only stops NEW tokens/tool-calls from being produced on this instance).
   */
  app.post('/runs/:id/cancel', async (c) => {
    if (!(await allowP(c.req.raw, 'run:cancel'))) return deny(c.req.raw, 'write');
    const runId = decodeURIComponent(c.req.param('id'));
    const s = await scope(c);
    if ('error' in s) return c.json({ error: s.error }, s.status);
    // Org-scope visibility: a run from another organization is invisible through THIS scope's prefixed
    // journal (withOrg strips/prefixes every key) — `:input` is written by every run() /stream() call
    // (persistInput, run.ts) so its absence means either the run never existed or it belongs to a
    // different organization; both cases return the SAME 404 (no existence leak, same pattern as agentGate).
    // BEFORE the visibility 404: the requirement is about the CREDENTIAL, not about the target, so a
    // client that names nobody must not get as far as learning whether a run exists. Ordered the other
    // way it answered 404-vs-403 to a caller who had not identified who it was acting for, which is a
    // (small) existence oracle handed out for free.
    { const denied = clientSubjectDenied(c); if (denied) return denied; }
    // Existence is asked of the raw instance: the caller's view hides a stranger's run, and this route
    // answers a stranger's run with the ownership 403 below, like every write, not with a 404.
    const missingRun = () => c.json({ error: `run '${runId}' not found` }, 404);
    // Stopping someone else's work is a write, and an application credential serves many end users
    // under one token — so the SAME `?resourceId=` expectation the read path honours is honoured here.
    {
      const d = await runDecision(c, s, runId);
      if (d === 'missing') return missingRun();
      if (d === 'deny') return kindOf(c) === 'operator' ? foreignRun(c) : missingRun();
    }
    // D4-FGA: runs AFTER the coarse allow(c,'write') gate above.
    const resourceDenied = await resourceGate(c, principalOf(c.req.raw), { type: 'run', id: runId }, 'cancel');
    if (resourceDenied) return resourceDenied;
    const key = inflightKey(s, runId);
    const set = inflight.get(key);
    const cancelled = set ? set.size : 0;
    if (set) for (const ctrl of set) ctrl.abort();
    // P2-cancel (wave 2, opt-in `?durable=true`): ALSO write the journal cancel flag — reaches runs
    // in-flight on OTHER workers (they stop at their next fresh model step) and makes the run refuse
    // every future resume (terminal, like a compensated run; recovery = forkRun). WITHOUT the flag the
    // default behavior is byte-identical to P0.3: in-process abort only, run stays resumable.
    const durable = c.req.query('durable') === 'true';
    if (durable) await cancelAgentRun(s.journal, runId, { reason: 'api-cancel' });
    await audit(c, s.orgId, 'run.cancel', runId, { cancelled, durable });
    return c.json(cancelled > 0
      ? { ok: true, cancelled, durable }
      : { ok: true, cancelled: 0, durable, note: durable ? 'no in-flight generation on this instance — durable flag written, other workers stop at their next step' : 'no in-flight generation on this instance' });
  });
  // Token-based usage report: total usage of the request scope (organization/shared) + effective limit.
  app.get('/usage', async (c) => {
    if (!(await allowP(c.req.raw, 'money:read'))) return deny(c.req.raw, 'read');
    // Spend is metered PER ORGANIZATION — there is no end-user dimension for a client credential to
    // name, so the rule that every client request names a subject cannot be satisfied here. That is
    // the answer, not an exception to work around: an application serving end users has no business
    // reading its customer's billing, and this route was the one place the client class could.
    // The same holds for an end user, which reads its own work and not its organization's bill.
    if (isClient(c)) return c.json({ error: 'usage is organization-level: not available to a client credential' }, 403);
    if (kindOf(c) !== 'operator') return c.json({ error: 'usage is organization-level: staff only' }, 403);
    const s = await scope(c);
    if ('error' in s) return c.json({ error: s.error }, s.status);
    // In root scope (org on), the per-org limit doesn't apply → only usage is reported, limit is null.
    const rootUnderOrg = !s.orgId && !!opts.org;
    const check = rootUnderOrg
      ? { exceeded: false, usage: await getOrgUsage(baseJournal, s.orgId, usageCostCache), limit: undefined }
      : await checkBudget(baseJournal, s.orgId, effectiveFallback(s.orgId), usageCostCache);
    const usage = check.limit ? check.usage : await getOrgUsage(baseJournal, s.orgId, usageCostCache);
    return c.json({ org: s.orgId ?? null, usage, limit: check.limit ?? null, exceeded: check.exceeded });
  });
  /**
   * `?resourceId=` here is a CHECK, not a filter: "I believe this run belongs to X — confirm it."
   *
   * It exists because the deployment shape this server is built for cannot answer that question on its
   * own. An application credential (the `client` class) serves many end users under ONE token, so the
   * caller's own identity says nothing about whose run this is; without an ownership check the
   * customer's backend has to keep a private runId→user table and trust itself to consult it on every
   * request. Passing the expectation and being refused is the cheaper, harder-to-forget shape.
   *
   * DELIBERATELY not fail-open on an absent expectation, and deliberately not fail-CLOSED on an absent
   * owner either: a run started before this field existed (or by a single-operator deployment that
   * never sets one) has no owner to compare against, and refusing those would break every existing
   * caller to protect data that has no subject. The rule is only: when BOTH sides are known and they
   * disagree, refuse. What that rules out is the mistake worth ruling out — a caller that DID state an
   * expectation being handed someone else's run anyway.
   */
  /**
   * Conversations, READ ONLY.
   *
   * The data was already here — every run with a `threadId` writes one — but only @gnldev/studio had
   * routes to it, so the API a customer's backend actually talks to could create a user's threads and
   * never list them. Serving a per-user conversation list meant either giving that backend a Studio
   * credential or keeping a parallel copy of the mapping.
   *
   * The write half (rename, delete, purge messages) deliberately stays in Studio: it is operator
   * surgery on stored history, not something an application does while serving a request.
   *
   * `?resourceId=` here is a FILTER, matching Studio's route of the same name — the underlying
   * `listThreads` has taken this argument since threads existed. Without it an org-scoped caller gets
   * its organization's threads, which is the same breadth `GET /runs` already answers with.
   */
  app.get('/threads', async (c) => {
    if (!(await allowP(c.req.raw, 'threads:read'))) return deny(c.req.raw, 'read');
    const s = await scope(c);
    if ('error' in s) return c.json({ error: s.error }, s.status);
    const memory = s.gnl.memory;
    // An empty list, not a 404/501: "this deployment keeps no conversations" and "this user has none"
    // are the same answer to the caller, and the route existing is what lets a client stop branching.
    { const denied = clientSubjectDenied(c); if (denied) return denied; }
    // STRICT: bağlı kimlik KENDİ listesini görür. Bu satır olmadan parametresiz istek
    // `listAllThreads()`e düşüyor ve tek çağrıda TÜM öznelerin envanterini veriyor — ölçüldü.
    const resourceId = boundSubjectOf(c) ?? (c.req.query('resourceId') || undefined);
    // Two METHODS, not one with an optional argument — see Memory.listThreads. Passing a bare string
    // to the one-resource method is what silently unfiltered @gnldev/studio's own thread list.
    if (resourceId) {
      if (!memory?.listThreads) return c.json([]);
      return c.json(await memory.listThreads({ resourceId }));
    }
    if (!memory?.listAllThreads) return c.json([]);
    return c.json(await memory.listAllThreads());
  });
  /**
   * A thread's messages. `?resourceId=` is a CHECK here rather than a filter — the same shape
   * `GET /runs/:id` uses, and for the same reason: the caller names the thread, so the only useful
   * question left is whether it belongs to who the caller thinks it does.
   *
   * Enforced against the THREAD's own record rather than a run's, because a thread outlives the run
   * that created it and is the thing being asked for. Silent when the store cannot answer who owns a
   * thread — a Memory implementation is free to omit `getThreadResource`, and a missing capability is
   * not evidence of a mismatch.
   */
  app.get('/threads/:id/messages', async (c) => {
    if (!(await allowP(c.req.raw, 'threads:read'))) return deny(c.req.raw, 'read');
    const s = await scope(c);
    if ('error' in s) return c.json({ error: s.error }, s.status);
    const memory = s.gnl.memory;
    if (!memory?.getMessages) return c.json([]);
    { const denied = clientSubjectDenied(c); if (denied) return denied; }
    const threadId = decodeURIComponent(c.req.param('id'));
    // STRICT: beklenti çağıranın BEYANI değil KİMLİĞİ. Beyan tek başına bir kontrol değildir —
    // saldırgan kurbanın adını yazınca eşleşme sağlanıyordu, yani kapı kendi anahtarını dağıtıyordu.
    const expected = boundSubjectOf(c) ?? c.req.query('resourceId');
    if (expected) {
      const o = await threadOwnerOf(rawOf(s).journal, rawOf(s).gnl.memory, threadId);
      // Names neither the real owner nor whether the thread exists — a caller guessing ids would
      // otherwise learn both from the refusal (same wording as the run-ownership check).
      if (o.owner && o.owner !== expected) return c.json({ error: 'thread not found' }, 404);
    }
    // A caller who speaks for a user reads only that user's thread. Asked of OWNERSHIP, not of the
    // messages: a user's own empty thread is still theirs ([]), and a thread that is not theirs — or
    // has no owner, or a store that cannot say — is the same 404 as one that does not exist.
    const subject = viewSubjectOf(c);
    if (subject) {
      const raw = rawOf(s);
      const rawMemory = raw.gnl.memory!;
      let owner: string | undefined;
      try {
        owner = (await threadOwnerOf(raw.journal, rawMemory, threadId)).owner;
      } catch {
        owner = undefined;
      }
      if (owner !== subject) return c.json({ error: 'thread not found' }, 404);
    }
    return c.json(await memory.getMessages(threadId));
  });
  app.get('/runs/:id', async (c) => {
    if (!(await allowP(c.req.raw, 'runs:read'))) return deny(c.req.raw, 'read');
    const s = await scope(c);
    if ('error' in s) return c.json({ error: s.error }, s.status);
    const runId = decodeURIComponent(c.req.param('id'));
    { const d = clientSubjectDenied(c); if (d) return d; }
    // A run this caller may not read and a run that does not exist answer the SAME 404: a refusal
    // that differs from "not found" tells an id-guesser which ids are real.
    const notFound = () => c.json({ error: 'run not found' }, 404);
    // A caller who speaks for a user holds the subject view (see `scope`): its reader returns nothing
    // for a run that is not that user's, so the view alone decides. The gate stays for staff who
    // state an expectation (`?resourceId=`), which no view expresses.
    if (!viewSubjectOf(c) && (await runDecision(c, s, runId)) === 'deny') return notFound();
    const entries = await s.journal.readRun(runId);
    return entries.length ? c.json(entries) : notFound();
  });
  /**
   * Agent names FILTERED by the caller's org, exactly as `/agents` and `agentGate` filter them.
   *
   * `names` is every agent in the config, computed once at construction. Serving that verbatim handed
   * a caller from org B a complete list of org A's agent names, which is the one fact `agentGate` is
   * written to withhold — it answers the same 404 for "no such agent" and "not yours" precisely so a
   * non-owning org cannot learn an agent EXISTS. The schema route published the list next door.
   *
   * Built per request rather than once, because the answer depends on who is asking. Workflows have no
   * org dimension anywhere in the config, so `workflowNames` stays whole.
   */
  app.get('/openapi.json', async (c) => {
    if (!(await allowP(c.req.raw, 'catalog:read'))) return deny(c.req.raw, 'read');
    const s = await scope(c);
    if ('error' in s) return c.json({ error: s.error }, s.status);
    const visible = names.filter((n) => agentVisibleToOrg(config.agents?.[n] ?? {}, s.orgId));
    return c.json(buildOpenApi(visible, workflowNames, opts.title));
  });

  return app;
}

export type { FetchHandler, RouteInfo } from './handler.js';
export { buildOpenApi } from './openapi.js';
// The edge's own codes, exported for the same reason durable exports its two maps: a check can
// enumerate them, and `@gnldev/agui` prints two of them from the same constant. See edge-errors.ts.
export { EDGE_ERROR_CODES, type EdgeErrorCode } from './edge-errors.js';
export { pipeAgentStream, interruptsFromSteps, sseResponse } from './sse.js';

/**
 * The REST API as a fetch handler.
 *
 * Hono host:      app.mount('/api', createRestApi(config))
 * Anything else:  bridge it (see @gnldev/studio/node for the same job on the Studio side)
 * Standalone:     serve({ fetch: createRestApi(config).fetch })
 *
 * The `run?: never; agent?: never` is a guard, not decoration. Every field of `CreateGnlConfig` is
 * optional, so ANY object satisfies it — including the REGISTRY that `createGnl(config)` returns,
 * which is the one thing callers reach for by mistake (`createRestApi(gnl)` instead of
 * `createRestApi(config)`). It typechecked, started, and then answered every request from an empty
 * config: no agents, no journal, and nothing anywhere saying so. `run` and `agent` exist on the
 * registry and on no config, so naming them `never` rejects exactly that object and costs a real
 * config nothing. Documented because it was shipped wrong in the guide first, and because a
 * signature that looks decorative is the kind that gets "simplified" away.
 */
export function createRestApi(
  config: CreateGnlConfig & { run?: never; agent?: never },
  opts: RestApiOptions = {},
): FetchHandler {
  const handler = toFetchHandler(restApiApp(config, opts));
  return opts.cors ? withCors(handler, opts.cors) : handler;
}

/**
 * CORS around the whole handler, OUTSIDE routing: a preflight is answered before any gate (it carries
 * no credential by specification — gating it is a 401 the browser reports as a CORS failure), and the
 * route inventory stays a list of routes. Bearer credentials only, so no `Allow-Credentials`, ever.
 */
function withCors(h: FetchHandler, cfg: NonNullable<RestApiOptions['cors']>): FetchHandler {
  const allowedOrigin = (origin: string | null): string | undefined =>
    !origin ? undefined : cfg.origins === '*' ? '*' : cfg.origins.includes(origin) ? origin : undefined;
  const call = async (req: Request, ...rest: unknown[]): Promise<Response> => {
    const allowed = allowedOrigin(req.headers.get('origin'));
    if (req.method === 'OPTIONS' && req.headers.has('access-control-request-method')) {
      const headers = new Headers({ Vary: 'Origin' });
      if (allowed) {
        headers.set('Access-Control-Allow-Origin', allowed);
        headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE');
        headers.set('Access-Control-Allow-Headers', 'authorization, content-type, idempotency-key, last-event-id, x-gnl-org');
        headers.set('Access-Control-Max-Age', String(cfg.maxAge ?? 600));
      }
      return new Response(null, { status: 204, headers });
    }
    const res = await (h as (r: Request, ...a: unknown[]) => Promise<Response>)(req, ...rest);
    if (!allowed) return res;
    // A new Response rather than mutating: a response's headers may be immutable (one produced by fetch).
    const headers = new Headers(res.headers);
    headers.set('Access-Control-Allow-Origin', allowed);
    headers.set('Access-Control-Expose-Headers', 'X-Gnl-Run-Id, X-Gnl-Idempotency-Status, Retry-After');
    headers.append('Vary', 'Origin');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
  return Object.assign(call, { fetch: call, routeTable: (h as { routeTable?: unknown }).routeTable }) as unknown as FetchHandler;
}
