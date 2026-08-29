// @gnldev/server — serves the createGnl registry over HTTP (auto-REST + OpenAPI). Every endpoint
// Descends into runDurable → exactly-once/durability inherited for free. (The durable counterpart of the common auto-REST pattern.)
import { Hono, type Context } from 'hono';
import { toFetchHandler, type FetchHandler } from './handler.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createGnl, agentVisibleToOrg, withOrg, withOrgStorage, ORG_RECORD_PRE, checkBudget, getOrgUsage, budgetsEnforceable, toJournal, asReaderJournal, appendLog, cancelAgentRun, RunLimitExceededError, ToolLoopDetectedError, blockedErrorCode, upstreamFailure, sealRequestContext, fingerprintAgent, recordAgent, approveAgent, blockAgent, isAgentServable, listAgentRegistry } from '@gnldev/durable';
import type { CreateGnlConfig, Journal, JournalReader, BudgetLimit, UsageCostCache, RunLimits } from '@gnldev/durable';
import { makeGate, normalizeAuth, principalOf, isPlatformAdmin, CLIENT_ROLE, type AuthProvider, type ReadWriteAuth, type Principal } from '@gnldev/auth';
// P0.4 @gnldev/workflow is zero-dependency (see its package.json) — depending on it
// From @gnldev/server is a clean one-way edge (server→workflow), NOT circular: @gnldev/durable's registry.ts
// Deliberately stays workflow-agnostic (WorkflowLike is a structural type, no import) to avoid a
// Durable→workflow edge; server has no such constraint and needs the real functions at runtime.
import { listWorkflowRuns, getWorkflowRunStatus, cancelWorkflowRun } from '@gnldev/workflow';
import type { WorkflowRunStatus } from '@gnldev/workflow';
import { buildOpenApi } from './openapi.js';
import { pipeAgentStream } from './sse.js';

/** (audit: A2A unsigned) — signature window: a request with a timestamp this old/future is rejected (replay resistance). */
const A2A_TIMESTAMP_WINDOW_MS = 300_000; // ±300s

/**
 * Verifies the `x-gnl-signature`/`x-gnl-timestamp` header pair produced by @gnldev/a2a's
 * `createA2ATool({ secret })`: signature = HMAC-SHA256(secret, timestamp + '.' + rawBody) hex, compared
 * With `timingSafeEqual` (closed to timing attacks). A second layer INDEPENDENT of the existing auth gate
 * (makeGate/opts.auth) — one asks identity/permission, the other verifies message integrity/origin; both
 * Are opt-in and don't affect each other.
 * Invalid/missing → Response (401); valid → undefined.
 */
function verifyA2ASignature(c: Context, rawBody: string, secret: string): Response | undefined {
  const signature = c.req.header('x-gnl-signature');
  const timestamp = c.req.header('x-gnl-timestamp');
  if (!signature || !timestamp) {
    return c.json({ error: 'A2A signature headers missing (x-gnl-signature/x-gnl-timestamp)', code: 'a2a_signature_missing' }, 401);
  }
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > A2A_TIMESTAMP_WINDOW_MS) {
    return c.json({ error: 'A2A timestamp outside window (±300s) — suspected replay', code: 'a2a_timestamp_invalid' }, 401);
  }
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
  const provided = Buffer.from(signature, 'hex');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return c.json({ error: 'A2A signature invalid', code: 'a2a_signature_invalid' }, 401);
  }
  return undefined;
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
 * Depend on the paid @gnldev/auth-ee package, so these are typed here rather than imported (see
 * `RestApiOptions.resourceAuth` below).
 */
export interface ResourceAuthResource {
  type: 'agent' | 'workflow' | 'tool' | 'run';
  id: string;
}
export type ResourceAuthAction = 'run' | 'read' | 'cancel' | 'resume' | (string & {});

/** Per-request multi-organization (opt-in): resolve organization from the request → journal is scoped to that organization. */
export interface OrgOptions {
  /** Resolve the organization from the request. If not given, the `x-gnl-org` header is read. */
  /**
   * Takes a web `Request`, not a Hono `Context` — kept in step with @gnldev/studio, and for the same
   * Reason: a host binding this handler from Express or Fastify has a Request and no Context.
   */
  resolve?: (req: Request) => string | undefined | Promise<string | undefined>;
  /** true → a request without an organization gets 400. false (default) → a request without an organization runs in the shared scope. */
  required?: boolean;
  /**
   * HARDENING (opt-in): reject any request whose resolved organization is NOT explicitly REGISTERED
   * (an `__org__:<id>` record written by studio's `POST /organizations`; a DELETED org is a `null`
   * Tombstone → also rejected → its ghost tokens stop working). Default false = the legacy IMPLICIT-org
   * Behavior (an org springs into existence on first activity, no registration needed) — byte-for-byte
   * Unchanged. Turn ON for strict provisioning: only orgs you deliberately created may run. NOTE: requires
   * A registration PATH in the deployment (studio's org management, or a direct `__org__:<id>` write);
   * With it on and no such path, every org-scoped request is rejected. */
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
   * Disabled (audit #2). Set this flag to true if open access is genuinely intended. Outside production:
   * Only a single console.warn on the first request.
   */
  allowOpenAccess?: boolean;
  /**
   * Opt-in multi-organization support: each request descends into that organization's journal (withOrg)
   * → runs, memory, and exactly-once guarantees are isolated per organization. The resolved organization
   * Is injected into requestContext as `org` (visible to dynamic agents). The registry is lazily built
   * And cached per organization.
   */
  org?: OrgOptions;
  /**
   * Budget/quota FALLBACK limits (ENFORCED on the write path): an organization's effective limit is
   * Journal's `__budget__:<id>`/`__budget__:default` (managed from Studio) > `perOrg[id]` > `default`.
   * A new run/stream/workflow request from an organization that is over budget gets 402 (resume remains
   * Free — suspended work can finish). Even without this option, budgets written to the journal are
   * Enforced (no limit → cost-free early exit).
   */
  budgets?: { default?: BudgetLimit; perOrg?: Record<string, BudgetLimit> };
  /**
   * SERVER-SIDE UPPER BOUND (opt-in) for per-run cost cap + loop detection. The `limits` in the
   * Request body (client request) CANNOT EXCEED this cap — the effective limit for each field is computed
   * As `min(server, client)` (see `clampLimits`); if the client doesn't specify a field, the server cap
   * Applies, and if neither server nor client specifies it, that field is never enforced. If neither is
   * Given (default), behavior is preserved EXACTLY AS IS (unlimited).
   */
  limits?: RunLimits;
  /**
   * (audit: A2A unsigned) — opt-in A2A request verification: if given, the `x-gnl-signature`/
   * `x-gnl-timestamp` header pair produced by `@gnldev/a2a`'s `createA2ATool({ secret })` becomes REQUIRED on
   * `/agents/:name/run` POSTs (see verifyA2ASignature) — missing/wrong signature or a timestamp outside
   * ±300s → 401. If not given, behavior is preserved EXACTLY AS IS (unsigned requests are accepted as
   * Before). Works TOGETHER WITH the existing auth gate (opts.auth) — the two are independent layers,
   * Both must pass.
   */
  a2aSecret?: string;
  /**
   * D4-FGA (EE-2) opt-in hook: fine-grained (resource-scoped) authorization, consulted AFTER the existing
   * Coarse gate (opts.auth) already allowed the request — on agents run/stream, workflows run, and the
   * Two cancel endpoints (`/runs/:id/cancel`, `/workflows/runs/:id/cancel`). A denial → 403
   * `{error, code: 'resource_denied'}`, distinct from the coarse gate's 403 (which carries no `code`).
   * Structurally typed (`ResourceAuthResource`/`ResourceAuthAction` above) — @gnldev/server does NOT import
   * @gnldev/auth-ee; an EE user wires this to `createEnterpriseAuth(...).checkResource` (see @gnldev/auth-ee's
   * `createFga`/`EnterpriseAuthProvider.checkResource`), e.g.:
   *   ResourceAuth: (p, r, a) => enterpriseAuth.checkResource!(p, r, a).then((res) => res.allowed)
   * If NOT given, behavior is preserved EXACTLY AS IS (no resource-level gate — existing coarse auth only).
   */
  resourceAuth?: (principal: Principal | null, resource: ResourceAuthResource, action: ResourceAuthAction) => Promise<boolean> | boolean;
  /**
   * Agent approval registry (opt-in governance gate, default false — BACKWARD COMPAT: existing
   * Deployments are byte-for-byte unchanged). When true, run/resume/stream ALSO require the target
   * Agent to be `approved` in the journal-backed registry (@gnldev/durable's `isAgentServable`) — a
   * Pending/changed/blocked agent gets 403 `{error, code: 'agent_not_approved'}`. Every `config.agents`
   * Entry is recorded (idempotent, fingerprinted) once at construction so a platform-admin can review
   * It via `GET /agents/registry` and approve/block it (see the `/agents/registry*` endpoints below) —
   * Those endpoints are ALWAYS available (regardless of this flag) so approval can be set up ahead of
   * Turning the gate on.
   */
  requireAgentApproval?: boolean;
}

/**
 * Merge the server cap with the client request — the STRICTER one (smaller number) wins, the
 * Client can NEVER loosen the server cap. If neither side gives a field, that field ends up absent (never
 * Enforced) — the existing unlimited behavior is preserved.
 */
/** Longest accepted `resourceId`. Generous for a user id / customer key, short of an accidental blob. */
const MAX_RESOURCE_ID = 200;

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
  principalId: string | undefined,
  raw: unknown,
  isClient = false,
): { resourceId?: string } | { error: string } {
  if (principalId) return { resourceId: principalId };
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
    return isClient
      ? { error: 'resourceId is required for a client credential: name the end user this request acts for' }
      : {};
  }
  if (typeof raw !== 'string') return { error: 'resourceId must be a string' };
  if (raw.length === 0) return { error: 'resourceId must not be empty' };
  if (raw.length > MAX_RESOURCE_ID) return { error: `resourceId must be at most ${MAX_RESOURCE_ID} characters` };
  // It becomes part of a storage key (`res:<id>`), and it is echoed back in listings. Control
  // characters serve no purpose in an identifier and are the part of the input space that surprises
  // key parsers and log readers; everything printable is left alone, because a customer's own user ids
  // are not ours to shape.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return { error: 'resourceId must not contain control characters' };
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
 * Request is valid but couldn't be processed under the given `limits` instruction. NOT 429 (SDKs
 * Auto-retry 429, whereas the error is deterministic; Retry-After can't be computed), NOT 402 (402 is
 * Specific to ORGANIZATION budget — remediation differs: raise budget ≠ raise limits + resume with the
 * SAME runId). If it doesn't match, returns undefined → the caller falls through to the generic 400 path.
 */
function limitErrorResponse(c: Context, e: unknown): Response | undefined {
  if (e instanceof RunLimitExceededError || (e as any)?.name === 'RunLimitExceededError') {
    const err = e as RunLimitExceededError;
    return c.json({ error: err.message, code: 'run_limit_exceeded', detail: err.detail, resumable: true }, 422);
  }
  if (e instanceof ToolLoopDetectedError || (e as any)?.name === 'ToolLoopDetectedError') {
    const err = e as ToolLoopDetectedError;
    return c.json({ error: err.message, code: 'tool_loop_detected', detail: err.detail, resumable: true }, 422);
  }
  return undefined;
}

/**
 * K1: makes SideEffectRetryBlockedError/RunBusyError/RetryLimitExceededError thrown by runDurable
 * (see errorFromBlocked, run.ts) consistent with the `BLOCKED_CODES` mapping on the SSE path (sse.ts).
 * The code comes from @gnldev/durable#blockedErrorCode (the ONE source of truth, based on err.name); the
 * HTTP status/`resumable` choice is IDENTICAL to the `onError` in examples/app/src/server.ts:
 * Side_effect_retry_blocked/run_busy → 409 + resumable:true (resolved via approval/retry);
 * Retry_limit_exceeded → 422, NO resumable (a permanent 'failed' is left in the journal, the same runId
 * Won't resume). If it doesn't match, returns undefined → the caller falls through to the generic 400
 * Path.
 */
function blockedErrorResponse(c: Context, e: unknown): Response | undefined {
  const code = blockedErrorCode(e);
  if (!code) return undefined;
  const err = e as { message?: string; detail?: unknown } | null | undefined;
  const body = { error: err?.message ?? String(e), code, detail: err?.detail };
  return code === 'retry_limit_exceeded' ? c.json(body, 422) : c.json({ ...body, resumable: true }, 409);
}

/**
 * A failure that came from the model provider, answered as one.
 *
 * Without this the provider's failure fell through to the generic 400 — measured, a free endpoint
 * Answering 429 reached the caller as `400 "Failed after 3 attempts. Last error: Too Many Requests"`,
 * Which tells a retrying client to stop retrying at the exact moment it should wait. The status
 * Choices and their reasoning live in @gnldev/durable#upstreamFailure; this only renders them, plus
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
  // Storage.runs (RunJournal) returns paginated listRuns → toJournal bridges it to the old array contract
  // (routes /runs, /usage, withOrg, and the budget gate all see the same shape).
  // `storage` is bridged by toJournal; `journal` is whatever the host passed — and the README's own
  // Quickstart passes `new SqliteStorage(...).runs`, a RunJournal whose listRuns returns a Page. Every
  // Reader-side consumer here (GET /runs, /usage, withOrg, the budget gate) expects the array contract,
  // So GET /runs?limit= died on `all.filter is not a function` and the bare GET /runs returned a page
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
   * Construction (idempotent — recordAgent handles first-sight/drift/unchanged). `createRestApi` itself
   * Stays SYNCHRONOUS (returns the Hono app directly, existing callers `const api = createRestApi(...)`
   * Would break if this returned a Promise) — so boot recording is fire-and-forget from here, but the
   * Promise is CACHED and every request path that depends on registry state (the approval gate below,
   * `GET /agents/registry`, approve/block) `await`s it first, so no request can race ahead of boot.
   * A failure (e.g. a non-writable journal) is warned, not thrown — the registry becomes best-effort
   * Stale rather than breaking the server (mirrors the budget/warn patterns elsewhere in this file).
   */
  const agentRegistryBoot: Promise<void> = (async () => {
    for (const [agentName, cfg] of Object.entries(config.agents ?? {})) {
      await recordAgent(baseJournal, agentName, fingerprintAgent(agentName, cfg));
    }
  })().catch((e) => {
    console.warn('@gnldev/server: agent registry boot recording failed (approval state may be stale):', e);
  });
  // Opt-in auth gate: endpoints are open without a provider; in production this is only possible with
  // AllowOpenAccess: true (otherwise makeGate throws at setup), outside production a single warning is issued on the first request.
  const authProvider = normalizeAuth(opts.auth);
  const { allow, allowP, deny } = makeGate(authProvider, { allowOpenAccess: opts.allowOpenAccess });

  // F1 — read the raw body and, when an a2aSecret is configured, verify the A2A HMAC signature over it
  // BEFORE parsing. Applied to EVERY agent-invoking endpoint (run/resume/stream + workflow run), not
  // Just /run — otherwise the same agents were invocable UNSIGNED via /stream or /resume, bypassing the
  // Replay/integrity gate by changing the endpoint. Returns the parsed body, or a deny Response.
  async function readSignedBody(c: Context): Promise<{ body: any } | { denied: Response }> {
    const rawBody = await c.req.text();
    if (opts.a2aSecret) {
      const sigDenied = verifyA2ASignature(c, rawBody, opts.a2aSecret);
      if (sigDenied) return { denied: sigDenied };
    }
    return { body: parseJsonBody(rawBody) };
  }
  // STRICT multi-org model = PAID gate: on ONLY when the auth provider (paid @gnldev/auth-ee, valid
  // License) reports the `multiOrganization` capability. When on, an unbound identity is NO LONGER a
  // Super-admin by default — it must carry the EXPLICIT platform-admin grant (scope: 'platform'),
  // Otherwise it is fail-closed. When OFF (free/host-org/no-auth) behavior is preserved EXACTLY: an
  // Org-less identity is the legacy operator (sees the shared/root scope).
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
  // Organization). Since the registry is per-org, model-fallback freezing and memory are also isolated
  // Per organization.
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
      if (config.storage) {
        // A `Storage` has SIX ports and this used to keep exactly one of them. The line was
        // `storage: undefined, journal: withOrg(baseJournal, id)`: the run journal was scoped and
        // `memory`, `vectors`, `work`, `cache` and `meta` were thrown away, so an organization's
        // registry fell back to whatever `createGnl` derived from the journal alone — and every
        // organization's threads, corpus, queue, cache and metadata lived in one shared set of keys.
        // The leaks found one at a time through studio (knowledge search, the jobs list, cache
        // invalidate) were this, seen through different routes.
        //
        // `withOrgStorage` scopes all six. No `journal` is passed alongside it on purpose: `createGnl`
        // resolves `config.storage ? config.storage.runs : config.journal`, so the storage's own
        // already-scoped `runs` is the journal — passing a separately-scoped one would be a second
        // wrapper around the same data and the two would disagree about which is authoritative.
        const scopedStorage = withOrgStorage(config.storage, id);
        const scoped = toJournal(scopedStorage.runs) as Journal & JournalReader;
        inst = { gnl: createGnl({ ...perOrg, storage: scopedStorage, journal: undefined }), journal: scoped, orgId: id };
      } else {
        // Journal-only deployment: there is no `Storage` to scope, so this stays exactly as it was.
        // The other five ports do not exist here — `createGnl` derives what it needs from the journal —
        // so there is nothing this path is missing.
        const scoped = withOrg(baseJournal, id) as Journal & JournalReader;
        inst = { gnl: createGnl({ ...perOrg, storage: undefined, journal: scoped }), journal: scoped, orgId: id };
      }
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
   * Allow()) OVERRIDES the header and enforces isolation even if the org option is NOT SET UP (the
   * Cred.orgId promise: "organization isolation is enforced by identity"). If the bound identity requests
   * A different organization, 403.
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
  /** Whether THIS caller is an application credential (see @gnldev/auth CLIENT_ROLE). */
  const isClient = (c: Context): boolean => principalOf(c.req.raw)?.roles?.includes(CLIENT_ROLE) === true;

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
    return c.json({
      error: 'resourceId is required for a client credential: name the end user this request acts for',
    }, 400);
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
    const getOwner = s.gnl.memory?.getThreadResource;
    if (!getOwner) return undefined;
    let owner: string | undefined;
    try {
      owner = await getOwner.call(s.gnl.memory, threadId);
    } catch {
      return undefined; // a store that cannot answer is not evidence of a mismatch
    }
    if (!owner || owner === subject) return undefined;
    return c.json({ error: 'access denied: this thread belongs to a different resourceId' }, 403);
  }

  async function ownershipDenied(c: Context, s: Instance, runId: string, fromBody?: unknown): Promise<Response | undefined> {
    // The query string is the uniform source, so a GET and a POST state the expectation the same way.
    // `fromBody` exists for the POST paths whose caller naturally puts it in the JSON it is already
    // sending; the query still wins, so one route cannot be checked against two different claims.
    const expected = c.req.query('resourceId') ?? (typeof fromBody === 'string' ? fromBody : undefined);
    if (!expected) return undefined;
    let owner: string | undefined;
    try {
      owner = (await s.journal.get<{ resourceId?: string }>(`${runId}:input`))?.resourceId;
    } catch {
      return undefined; // a reader that cannot serve the entry is not evidence of a mismatch
    }
    if (!owner || owner === expected) return undefined;
    // The message names neither the real owner nor whether the run exists — a caller guessing ids
    // would otherwise learn both from the refusal.
    return c.json({ error: 'access denied: this run belongs to a different resourceId' }, 403);
  }

  async function scope(c: Context): Promise<Instance | { error: string; status: 400 | 403 }> {
    const principal = principalOf(c.req.raw);
    const bound = principal?.orgId;
    // B2 — organization isolation must NOT depend on the paid license capability: when the host configured
    // Per-request orgs (opts.org) with an auth provider that produces NO principal (e.g. legacy
    // {read,write} auth whose authenticate()=null), the raw `x-gnl-org` header would drive the scope
    // With ZERO identity binding — cross-organization read/write. There is no identity to isolate on, so this
    // Combination is unsafe regardless of the license → fail closed. (An ABSENT auth provider is the
    // Deliberate single-operator/no-auth mode and is unaffected.)
    if (orgIsolationActive && authProvider && !principal) {
      return { error: 'access denied: organization isolation is configured but this auth provider binds no identity to an organization (fail-closed)', status: 403 };
    }
    // STRICT (EE multi-org) FAIL-CLOSED: an authenticated identity with NO org binding AND NO explicit
    // Platform-admin grant gets 403 — it is NOT the accidental super-admin. Kept license-gated on
    // Purpose: the FREE tier's contract is that an unbound admin is the legacy cross-org OPERATOR
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
      // Single-org early-return above) yet this request carries NO org and NO org-bound identity, so
      // It lands in the SHARED (unprefixed) scope alongside every other org-less request. That is a
      // Potential data-mixing footgun a misconfigured client (missing x-gnl-org header) hits SILENTLY.
      // Behavior is unchanged (still served in shared scope — an operator who set `required:false`
      // Opted into this), but it is no longer silent: warn ONCE so the operator discovers they likely
      // Want `org.required = true` for strict organization isolation.
      if (!warnedSharedOrgFallback) {
        warnedSharedOrgFallback = true;
        console.warn('@gnldev/server: multi-org is configured but a request resolved NO organization → served in the SHARED scope (its data mixes with other org-less requests). Set `org.required = true` to reject such requests instead (fail-closed). This warning fires once.');
      }
      return defaultInstance;
    }
    // HARDENING (opt-in): the resolved org must be EXPLICITLY REGISTERED. Without this, an org-bound
    // Identity (or an x-gnl-org header) runs under `org:<id>:` whether or not that org was ever created
    // a deleted org's still-valid tokens keep working, and a typo'd header silently forks a new
    // Namespace. The `__org__:<id>` record (studio POST /organizations) is the registration; a `null`
    // Value is a deletion tombstone → also rejected. Root-level read (records live on baseJournal, not
    // Org-prefixed). Default off → legacy implicit-org behavior unchanged.
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
   * When `resourceAuth` is unset → existing behavior is preserved exactly.
   */
  async function resourceGate(
    c: Context,
    principal: Principal | null,
    resource: ResourceAuthResource,
    action: ResourceAuthAction,
  ): Promise<Response | undefined> {
    if (!opts.resourceAuth) return undefined;
    const allowed = await opts.resourceAuth(principal, resource, action);
    return allowed ? undefined : c.json({ error: `resource access denied: ${resource.type}:${resource.id}`, code: 'resource_denied' }, 403);
  }

  /**
   * Org-scoped agent gate (run/resume/stream). An unknown agent AND an org-invisible agent return the
   * EXACT SAME 404 → a non-owning org cannot even learn the agent EXISTS (no existence leak). Runs
   * AFTER the write gate, BEFORE execute. Global agents (no `orgs`) and operators (orgId undefined /
   * Auth off) always pass → full backward-compat.
   */
  function agentGate(c: Context, name: string, orgId: string | undefined): Response | undefined {
    const cfg = config.agents?.[name];
    if (!cfg || !agentVisibleToOrg(cfg, orgId)) return c.json({ error: `agent '${name}' not registered` }, 404);
    return undefined;
  }

  /**
   * Agent approval gate (opt-in via `opts.requireAgentApproval`) — a SEPARATE async check called RIGHT
   * AFTER `agentGate` in run/resume/stream (visibility 404 stays first: an org that can't even see the
   * Agent gets 404, not a 403 about its approval status). No-op when the flag is off → byte-for-byte
   * Existing behavior. Awaits `agentRegistryBoot` first so a request can never race ahead of the
   * Construction-time registry recording (see its JSDoc above).
   */
  async function agentApprovalGate(c: Context, name: string): Promise<Response | undefined> {
    if (!opts.requireAgentApproval) return undefined;
    await agentRegistryBoot;
    if (await isAgentServable(baseJournal, name)) return undefined;
    return c.json({ error: 'agent not approved to serve', code: 'agent_not_approved' }, 403);
  }

  /**
   * PLATFORM-ADMIN gate for the agent registry endpoints below — mirrors @gnldev/studio's
   * `requirePlatformAdmin` (packages/studio/src/server.ts). Approval is a PLATFORM decision (should this
   * Code-agent serve AT ALL), never per-org, so an org-bound identity is always denied; in the strict
   * Multi-org model an unbound identity additionally needs the EXPLICIT platform-admin grant.
   */
  function requirePlatformAdmin(c: Context, orgBoundMsg: string): Response | undefined {
    const p = principalOf(c.req.raw);
    if (p?.orgId) return c.json({ error: orgBoundMsg }, 403);
    if (orgIsolationActive && !isPlatformAdmin(p)) {
      return c.json({ error: 'platform-admin required (fail-closed: no org scope and no platform-admin grant)' }, 403);
    }
    return undefined;
  }

  // Budget/quota WRITE PATH gate. Budgets are PER-ORG:
  // org ON + a request without an organization (root) → the root scope is NOT an organization, it
  //    Spans the total across all organizations; the per-org `default` limit does not apply to it
  //    (otherwise it would produce a false 402).
  // org OFF → a single global scope can use the `default` limit (a legitimate global cap).
  // Effective limit: journal `__budget__:*` (managed from Studio) > opts.budgets fallback. Completed run
  // Costs are memoized in costCache → a full deep journal read isn't repeated on every write.
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
      ? c.json({ error: 'budget/quota exceeded — new run rejected', code: 'budget_exceeded', usage: check.usage, limit: check.limit }, 402)
      : undefined;
  }

  /**
   * "Resume intent" test (H2/1.3): if state ALREADY exists in the journal for the given runId (a
   * Pending tool approval, a suspended/paused workflow, or the exactly-once repeat of a completed run),
   * This is NOT new work, it's a continuation of existing work — budgetGate is SKIPPED (otherwise
   * Suspended work in an over-budget organization could NEVER be finished, an exactly-once violation).
   * For new-work requests (where the runId has no trace at all in the journal) the gate is ENFORCED
   * Normally — no regression. `listKeys` is an optional Journal capability; without it, intent can't be
   * Detected and it fails closed (the gate behaves normally; only this optimization is missed).
   */
  async function isResumeIntent(journal: Journal, runId: string): Promise<boolean> {
    if (typeof journal.listKeys !== 'function') return false;
    try {
      return (await journal.listKeys(`${runId}:`)).length > 0;
    } catch {
      return false;
    }
  }

  /**
   * P0.3 in-process registry of the AbortControllers backing CURRENTLY IN-FLIGHT
   * `/run` and `/stream` generations, keyed by an ORG-SCOPED key (NOT the raw runId — two different
   * Organizations may legitimately use the SAME client-supplied runId for unrelated work; a flat
   * `runId → controllers` map would let org A's cancel abort org B's generation, a cross-organization
   * Correctness/security bug). `POST /runs/:id/cancel` below aborts every controller registered under
   * An id. Deliberately per-INSTANCE (a plain Map, not journal-backed) — see the cancel handler's JSDoc
   * For the honest multi-worker limitation.
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
   * Approve/block endpoints can pass it as `approveAgent`/`blockAgent`'s `by` argument without
   * Duplicating the logic. Priority: an authenticated principal.id > the `x-gnl-actor` header (the
   * PERSON behind a shared token) > `role:<role>` > 'anon'.
   */
  function actorOf(c: Context): string {
    const p = principalOf(c.req.raw);
    return p?.id ?? c.req.header('x-gnl-actor') ?? (p?.roles[0] ? `role:${p.roles[0]}` : 'anon');
  }

  /**
   * P0.3: minimal governance log for this package's own mutating endpoints — mirrors @gnldev/studio's
   * `audit()` helper (packages/studio/src/server.ts) but scoped down: @gnldev/server has no broader
   * Governance surface (org/user CRUD, agent versioning, …) to log — `run.cancel`/`workflow.cancel` plus
   * The agent-registry `agent.approve`/`agent.block` actions. Writes to the SAME `__audit__` journal
   * Namespace studio uses (via the shared `appendLog` primitive) so a consumer reading either surface's
   * Journal sees one merged trail. Best-effort: a journal write failure never breaks the request that
   * Triggered it.
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
      // Carried as a PAYLOAD FIELD for filtering. An org-prefixed write (`org:<id>:__audit__:…`) would
      // Be invisible to studio's audit view (it deliberately reads the root journal for exactly this reason).
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
    // This reduces to 'write' → identical to the previous allow(c,'write') (admin only) → no regression.
    if (!(await allowP(c.req.raw, 'agents:run'))) return deny(c.req.raw, 'write');
    const name = c.req.param('name');
    // Signature verification operates on the raw body bytes (the SAME string HMAC'd on the client side).
    const parsed = await readSignedBody(c);
    if ('denied' in parsed) return parsed.denied;
    const body = parsed.body as any;
    if (!body.runId) return c.json({ error: 'runId required (idempotency key)' }, 400);
    const s = await scope(c);
    if ('error' in s) return c.json({ error: s.error }, s.status);
    const gated = agentGate(c, name, s.orgId);
    if (gated) return gated;
    const approvalDenied = await agentApprovalGate(c, name);
    if (approvalDenied) return approvalDenied;
    // P1.7: computed once here (was previously re-derived below) — also needed by the D4-FGA resourceGate
    // Check right below, which runs AFTER the coarse allowP('agents:run') gate above.
    const principal = principalOf(c.req.raw);
    const resourceDenied = await resourceGate(c, principal, { type: 'agent', id: name }, 'run');
    if (resourceDenied) return resourceDenied;
    // WHOSE run this is — see resolveResourceId. A per-caller identity wins; otherwise the request says.
    const subject = resolveResourceId(principal?.id, body.resourceId, isClient(c));
    if ('error' in subject) return c.json({ error: subject.error }, 400);
    { const denied = await threadOwnershipDenied(c, s, body.threadId, subject.resourceId); if (denied) return denied; }
    // CONSISTENT with 1.3: continuing a suspended run from this endpoint with the SAME runId + approvals
    // (like stream does) is also resume intent → if there's a trace in the journal the budget gate is
    // Skipped; new runIds are still ENFORCED (no regression).
    if (!(await isResumeIntent(s.journal, body.runId))) {
      const over = await budgetGate(c, s);
      if (over) return over;
    }
    // P0.3: register an org-scoped AbortController so POST /runs/:id/cancel can stop THIS generation.
    // Composed with the client's own disconnect signal (P0.2) via AbortSignal.any — whichever fires
    // First wins; either way the journal keeps whatever prefix already completed (resumable, same as P0.2).
    const ctrl = new AbortController();
    const key = inflightKey(s, body.runId);
    registerInflight(key, ctrl);
    try {
      // P1.7 seal the AUTHENTICATED identity into context — a body-supplied
      // `context.__gnl_orgId`/`__gnl_resourceId`/`__gnl_threadId` (spoof attempt) is stripped and
      // Replaced by (or removed in favor of) the server-derived value. See sealRequestContext.
      const r = await s.gnl.run(name, {
        runId: body.runId,
        prompt: body.prompt,
        messages: body.messages,
        threadId: body.threadId,
        approvals: body.approvals,
        context: sealRequestContext(
          // Not merged here, because sealRequestContext writes `org` itself from the server-derived
          // value. This is a simplification, NOT a fix: measured over 21 body shapes × 4 server states
          // — including a prototype-polluted body, a getter for `org`, a null-prototype object and an
          // empty-string orgId — the merge and the seal never disagree, because the seal's first act is
          // an unconditional delete that dominates anything written here. The security property lives
          // entirely in sealRequestContext; the earlier version of this comment claimed otherwise.
          body.context ?? {},
          { orgId: s.orgId ?? principal?.orgId, resourceId: subject.resourceId },
        ),
        limits: clampLimits(opts.limits, body.limits),
        // P0.2 a client disconnect stops generation instead of billing tokens to
        // Completion — an abort mid-run does NOT break resumable behavior, the journal keeps whatever
        // Prefix already completed and a later call with the SAME runId resumes/replays as before.
        // P0.3: OR an explicit cancel via POST /runs/:id/cancel (ctrl.signal) — same non-destructive semantics.
        abortSignal: AbortSignal.any([c.req.raw.signal, ctrl.signal]),
      });
      // `finishReason` is here because without it an empty answer is unreadable. A run whose model
      // Returned nothing answers 200 with `text: ""` — identical, on the wire, to a model that
      // Legitimately chose to say nothing. Measured in the field: a provider returned an empty
      // Response with `finishReason: 'unknown'`, the run was journaled as completed, and the caller
      // Had no way to tell the two apart. The framework already knows which happened; it just was
      // Not saying. Additive field, so existing clients are unaffected.
      return c.json({ ok: true, runId: body.runId, text: r.text, interrupts: r.interrupts, finishReason: r.finishReason });
    } catch (e: any) {
      return limitErrorResponse(c, e) ?? blockedErrorResponse(c, e) ?? upstreamErrorResponse(c, e) ?? c.json({ error: String(e?.message ?? e) }, 400);
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
    { const denied = await ownershipDenied(c, s, body.runId, body.resourceId); if (denied) return denied; }
    // CONSISTENT with H2/1.3: only a REAL resume (there's a trace in the journal) skips the budget
    // Gate — otherwise this endpoint would be an unlimited backdoor (bypassing the quota with a
    // Traceless/made-up runId). Without a trace (typo/abuse) it's ENFORCED normally; input also comes
    // Back empty and the request fails harmlessly.
    if (!(await isResumeIntent(s.journal, body.runId))) {
      const over = await budgetGate(c, s);
      if (over) return over;
    }
    // Read the input from the journal → no need to re-supply the prompt (self-contained resume).
    const input = (await s.journal.get<any>(`${body.runId}:input`)) ?? {};
    try {
      const r = await s.gnl.run(name, {
        runId: body.runId,
        approvals: body.approvals,
        // Sealed like run and stream. This path built the context by hand and therefore carried
        // neither `__gnl_resourceId` nor `__gnl_threadId`, so a dynamic `system`/`model`/`tools`
        // function saw an identity on a fresh run and none on the resume of that same run — the two
        // halves of one conversation disagreeing about who the caller is.
        context: sealRequestContext({}, {
          orgId: s.orgId ?? principalOf(c.req.raw)?.orgId,
          // From the FROZEN `:input`, for the same reason the prompt and threadId below are: a resume
          // is self-contained and the client does not re-send it. Deriving it from the resuming
          // caller instead would let the second half of a conversation belong to someone else —
          // and on the shared-application-credential shape it resolved to undefined anyway.
          resourceId: input.resourceId ?? principalOf(c.req.raw)?.id,
        }),
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
      // Returned nothing answers 200 with `text: ""` — identical, on the wire, to a model that
      // Legitimately chose to say nothing. Measured in the field: a provider returned an empty
      // Response with `finishReason: 'unknown'`, the run was journaled as completed, and the caller
      // Had no way to tell the two apart. The framework already knows which happened; it just was
      // Not saying. Additive field, so existing clients are unaffected.
      return c.json({ ok: true, runId: body.runId, text: r.text, interrupts: r.interrupts, finishReason: r.finishReason });
    } catch (e: any) {
      return limitErrorResponse(c, e) ?? blockedErrorResponse(c, e) ?? upstreamErrorResponse(c, e) ?? c.json({ error: String(e?.message ?? e) }, 400);
    }
  });

  /**
   * ── Liveness and readiness ──────────────────────────────────────────────────────────────────
   *
   * Deliberately UNAUTHENTICATED. Every orchestrator that would use these — Docker, Fly, Cloud Run,
   * Kubernetes, a load balancer — probes before it has, or ever will have, a credential. A health
   * Check behind auth is a health check nothing can call.
   *
   * That makes what they SAY the design question. They report reachability and nothing else: no agent
   * Names, no org information, no counts, no configuration. In particular `/ready` never returns the
   * Underlying error text — a Postgres connection failure routinely carries the host, database and
   * User in its message, and this endpoint is world-readable. The operator gets the reason from the
   * Logs; the probe gets a status code.
   *
   * TWO ROUTES, because they answer two different questions and conflating them causes the wrong
   * Action:
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
   * Database. The read itself is cheap (5000 sequential in-memory gets ≈ 66ms), so this is not about
   * CPU — it is about what a BURST costs against a real database: each request is a real query, and
   * When storage HANGS each one parks an uncancelled promise, and its connection, for the whole 2s
   * Budget. Two bounds, both closed over THIS app instance:
   *   - one probe in flight at a time — concurrent requests await the same promise, so a burst parks
   *     One connection rather than one per request;
   *   - a settled answer is reused for 1s. Readiness probes fire on second-scale periods (Kubernetes'
   *     PeriodSeconds defaults to 10, Fly and Cloud Run sit in the same range), so a 1s window changes
   *     No orchestrator's view of this process while collapsing any burst to ≤1 query per second.
   * Deliberately NOT module-level state: `createRestApi` can be called more than once in a process
   * (tests do, and so does anyone mounting two APIs over different storage), and two apps sharing one
   * Cache would answer for each other's journal.
   * The 2s budget and the response contract are unchanged by any of this.
   */
  const readyBudgetMs = 2_000;
  const readyCacheMs = 1_000;
  // The warning is one line per FAILED probe, and a failing probe is exactly the moment an unauthenticated
  // Caller can repeat cheaply — an outage plus a probe loop (or a hostile client) turns the operator's log
  // Into noise that hides the first, useful line. 30s is the shortest interval that still keeps the failure
  // Visible in a log tail while surviving an hour of outage in ~120 lines. The first failure after a quiet
  // Period always warns again, so a recurrence is never silent.
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
      // Key is deliberately one that never exists.
      await baseJournal.get('__gnl_readiness_probe__');
      return true;
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Bounded on purpose: an unreachable database usually HANGS rather than refusing, and a probe that
    // Hangs is read as a timeout by some orchestrators and as success by others. Answer either way.
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
  // Here is platform-admin gated (requirePlatformAdmin) REGARDLESS of whether requireAgentApproval is
  // Turned on — an operator can review/approve agents ahead of flipping the enforcement flag.
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
    const body = parsed.body as any;
    if (!body.runId) return c.json({ error: 'runId required (idempotency key)' }, 400);
    const s = await scope(c);
    if ('error' in s) return c.json({ error: s.error }, s.status);
    const gated = agentGate(c, name, s.orgId);
    if (gated) return gated;
    const approvalDenied = await agentApprovalGate(c, name);
    if (approvalDenied) return approvalDenied;
    // P1.7: computed once here (was previously re-derived below) — also needed by the D4-FGA resourceGate
    // Check right below, which runs AFTER the coarse allowP('agents:run') gate above.
    const principal = principalOf(c.req.raw);
    const resourceDenied = await resourceGate(c, principal, { type: 'agent', id: name }, 'run');
    if (resourceDenied) return resourceDenied;
    // WHOSE run this is — see resolveResourceId. A per-caller identity wins; otherwise the request says.
    const subject = resolveResourceId(principal?.id, body.resourceId, isClient(c));
    if ('error' in subject) return c.json({ error: subject.error }, 400);
    { const denied = await threadOwnershipDenied(c, s, body.threadId, subject.resourceId); if (denied) return denied; }
    // 1.3: resume intent via approvals+runId (a pending tool approval) → the budget gate is skipped
    // CONSISTENTLY with /agents/:name/resume (otherwise a pending interrupt in an over-budget
    // Organization would never finish).
    if (!(await isResumeIntent(s.journal, body.runId))) {
      const over = await budgetGate(c, s);
      if (over) return over;
    }
    // P0.3: same registry as /agents/:name/run — composed with the client's disconnect signal (P0.2).
    const ctrl = new AbortController();
    const key = inflightKey(s, body.runId);
    registerInflight(key, ctrl);
    let result: any;
    try {
      // P1.7: same identity-sealing as /agents/:name/run above — see sealRequestContext.
      result = await s.gnl.stream(name, {
        runId: body.runId,
        prompt: body.prompt,
        messages: body.messages,
        threadId: body.threadId,
        approvals: body.approvals,
        context: sealRequestContext(
          // Not merged here, because sealRequestContext writes `org` itself from the server-derived
          // value. This is a simplification, NOT a fix: measured over 21 body shapes × 4 server states
          // — including a prototype-polluted body, a getter for `org`, a null-prototype object and an
          // empty-string orgId — the merge and the seal never disagree, because the seal's first act is
          // an unconditional delete that dominates anything written here. The security property lives
          // entirely in sealRequestContext; the earlier version of this comment claimed otherwise.
          body.context ?? {},
          { orgId: s.orgId ?? principal?.orgId, resourceId: subject.resourceId },
        ),
        limits: clampLimits(opts.limits, body.limits),
        // P0.2 same as /agents/:name/run above — stop generation (and its token
        // Billing) on client disconnect. Deliberately compatible with W3 resumable SSE just below: an
        // Abort only stops THIS response's fullStream early: the journal still has whatever prefix
        // Completed before the abort, so a resumed/replayed call with the SAME runId (with or without
        // Last-Event-ID) sees the same journal state it would have without the abort.
        // P0.3: OR an explicit cancel via POST /runs/:id/cancel (ctrl.signal) — same non-destructive semantics.
        abortSignal: AbortSignal.any([c.req.raw.signal, ctrl.signal]),
      });
    } catch (e: any) {
      unregisterInflight(key, ctrl);
      return limitErrorResponse(c, e) ?? blockedErrorResponse(c, e) ?? upstreamErrorResponse(c, e) ?? c.json({ error: String(e?.message ?? e) }, 400);
    }
    // P0.3 cleanup: `s.gnl.stream(...)` above only resolves the STREAM RESULT object — the actual
    // FullStream consumption (and hence "this generation is done") happens INSIDE pipeAgentStream's
    // StreamSSE callback below, which Hono drives independently of this handler's return (it doesn't
    // Block on the SSE body finishing). Reaching INTO the streaming path to unregister exactly when the
    // Response body closes would mean contorting sse.ts's generic event loop for one caller's
    // Bookkeeping — not worth it. Instead: `result.finishReason` (a Vercel AI SDK StreamTextResult
    // Promise — see sse.ts's own `await Promise.resolve(result.finishReason)`) settles exactly when
    // FullStream is fully drained (success OR error), which is a genuinely reachable, non-contorting
    // Completion hook — use it. Swallowed on rejection (a stream error already produces its own `error`
    // SSE event in pipeAgentStream); this is ONLY registry bookkeeping.
    void Promise.resolve(result.finishReason).catch(() => {}).finally(() => unregisterInflight(key, ctrl));
    // Disconnect-recovery — if there's a Last-Event-ID header (sent automatically by
    // EventSource) or body.lastEventId, events the client has already seen are not rewritten (see the note in sse.ts).
    const lastEventIdRaw = c.req.header('Last-Event-ID') ?? body.lastEventId;
    const lastEventId = lastEventIdRaw != null && lastEventIdRaw !== '' ? Number(lastEventIdRaw) : undefined;
    return pipeAgentStream(c, body.runId, result, Number.isFinite(lastEventId as number) ? { lastEventId } : undefined);
  });

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
    const resourceDenied = await resourceGate(c, principalOf(c.req.raw), { type: 'workflow', id: name }, 'run');
    if (resourceDenied) return resourceDenied;
    // H2: this endpoint with the same runId is the ONLY resume mechanism for a workflow. If runId is
    // Given AND there's already a trace in the journal (suspended/paused) this is a resume → the budget
    // Gate is skipped (new work is still ENFORCED).
    if (!(body.runId && (await isResumeIntent(s.journal, body.runId)))) {
      const over = await budgetGate(c, s);
      if (over) return over;
    }
    // P0.4: register an org-scoped AbortController in the SAME `inflight` map used by agent runs, but
    // Under a `wf:` sub-namespace — a client-supplied workflow runId and an agent runId could collide,
    // So keying them into the SAME bucket would let `/runs/:id/cancel` (agent-only) abort a workflow run
    // By accident. Only `POST /workflows/runs/:id/cancel` below targets this namespace; only registered
    // When body.runId is known (an auto-generated runId has no addressable key for a future cancel).
    const ctrl = new AbortController();
    const wfKey = body.runId ? 'wf:' + inflightKey(s, body.runId) : undefined;
    if (wfKey) registerInflight(wfKey, ctrl);
    try {
      const wfOpts = {
        ...(body.runId ? { runId: body.runId } : {}),
        // P0.4 typed resume: `{ [waitId]: payload }` — journaled before any step runs (see waitForResume).
        ...(body.resume ? { resume: body.resume } : {}),
        // Composed with the client's disconnect signal — same non-destructive semantics as P0.2/P0.3 for
        // Agent runs: an abort just stops new steps, the journal keeps whatever prefix already completed.
        signal: AbortSignal.any([c.req.raw.signal, ctrl.signal]),
      };
      const result = await s.gnl.runWorkflow(name, body.input, wfOpts);
      return c.json({ ok: true, ...result });
    } catch (e: any) {
      return limitErrorResponse(c, e) ?? blockedErrorResponse(c, e) ?? upstreamErrorResponse(c, e) ?? c.json({ error: String(e?.message ?? e) }, 400);
    } finally {
      if (wfKey) unregisterInflight(wfKey, ctrl);
    }
  });

  /**
   * P0.4 the suspended/completed/canceled workflow-run REGISTRY query — every run
   * In ONE `wfrun:` prefix scan (see @gnldev/workflow's listWorkflowRuns). Org-scoped via `scope(c)`/
   * `s.journal`: `wfrun:<runId>` keys are NOT runId-prefixed but `withOrg` still prefixes them
   * Unconditionally (prefixes EVERY key), so organization isolation holds automatically — see the
   * `statusKey` JSDoc in workflow.ts. `listKeys` is an optional Journal capability; without it
   * `listWorkflowRuns` throws a clear error — surfaced as 501 (capability-missing, same pattern as
   * Studio's own listKeys-gated routes) rather than a silent empty list.
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
    try {
      return c.json(await listWorkflowRuns(s.journal, status ? { status } : {}));
    } catch (e: any) {
      return c.json({ error: String(e?.message ?? e) }, 501);
    }
  });

  /**
   * P0.4: durably cancels a workflow run — reaches it on OTHER workers at its next step boundary (the
   * `_canceled` flag is checked before EVERY step by runResumable), terminal (a canceled run refuses to
   * Resume forever). Visibility: EITHER the `wfrun:` registry record exists OR the `_suspend` marker does
   * (a run mid-flight whose advisory registry write failed still leaves this trace) — neither existing
   * Means the run doesn't exist IN THIS SCOPE (cross-org 404, same no-existence-leak pattern as
   * AgentGate/`/runs/:id/cancel`). ALSO aborts any in-flight controller registered for this workflow run
   * (the `wf:`-namespaced bucket registered by POST /workflows/:name/run above) — best-effort, same
   * Multi-worker honesty caveat as `/runs/:id/cancel`.
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
    const status = await getWorkflowRunStatus(s.journal, runId);
    const visible = status !== undefined || (await s.journal.get(`${runId}:wf:_suspend`)) !== undefined;
    if (!visible) return c.json({ error: `workflow run '${runId}' not found` }, 404);
    // Same expectation-check as the agent-run cancel next door — a workflow run carries an owner for
    // the same reason and stopping one is the same act.
    { const denied = await ownershipDenied(c, s, runId); if (denied) return denied; }
    // D4-FGA: runs AFTER the coarse allow(c,'write') gate above.
    const resourceDenied = await resourceGate(c, principalOf(c.req.raw), { type: 'workflow', id: runId }, 'cancel');
    if (resourceDenied) return resourceDenied;
    const cancelled = await cancelWorkflowRun(s.journal, runId, {});
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
   * Assert on `runs[0].runId` etc. see byte-identical behavior).
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
    const resourceId = c.req.query('resourceId');
    // Checked BEFORE the no-params shortcut below, which is the branch that would otherwise hand a
    // client the whole organization's run list — the exact read this rule exists to scope.
    { const denied = clientSubjectDenied(c, resourceId); if (denied) return denied; }
    if (limitRaw == null && cursor == null && statusRaw == null && agent == null && resourceId == null) {
      return c.json(await s.journal.listRuns()); // no params → legacy array (unchanged)
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
    // The request. Honest cost: this materializes EVERY run before filtering/slicing (the array method
    // Already does that internally); acceptable since it only triggers when the paged capability is
    // Genuinely absent. `source` is intentionally NOT stamped on the response — the shape stays
    // Identical to the paged branch above ({items, nextCursor}) so callers don't need to branch on it.
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
   * Controllers registered on the SAME process that received THIS request. Behind a load balancer with
   * Multiple workers, a run's `/stream` may be in-flight on a DIFFERENT worker than the one that
   * Receives the cancel → `cancelled: 0` even though the run is genuinely still running elsewhere.
   * Closing that gap needs a journal-level cancel FLAG that every worker polls during generation
   * (deliberately deferred — see P0.4/P2). The run itself is UNAFFECTED by this
   * Limitation: it stays resumable either way (the journal prefix is intact — cancel never deletes
   * Anything, it only stops NEW tokens/tool-calls from being produced on this instance).
   */
  app.post('/runs/:id/cancel', async (c) => {
    if (!(await allowP(c.req.raw, 'run:cancel'))) return deny(c.req.raw, 'write');
    const runId = decodeURIComponent(c.req.param('id'));
    const s = await scope(c);
    if ('error' in s) return c.json({ error: s.error }, s.status);
    // Org-scope visibility: a run from another organization is invisible through THIS scope's prefixed
    // Journal (withOrg strips/prefixes every key) — `:input` is written by every run() /stream() call
    // (persistInput, run.ts) so its absence means either the run never existed or it belongs to a
    // Different organization; both cases return the SAME 404 (no existence leak, same pattern as agentGate).
    // BEFORE the visibility 404: the requirement is about the CREDENTIAL, not about the target, so a
    // client that names nobody must not get as far as learning whether a run exists. Ordered the other
    // way it answered 404-vs-403 to a caller who had not identified who it was acting for, which is a
    // (small) existence oracle handed out for free.
    { const denied = clientSubjectDenied(c); if (denied) return denied; }
    const visible = await s.journal.get(`${runId}:input`);
    if (visible === undefined) return c.json({ error: `run '${runId}' not found` }, 404);
    // Stopping someone else's work is a write, and an application credential serves many end users
    // under one token — so the SAME `?resourceId=` expectation the read path honours is honoured here.
    { const denied = await ownershipDenied(c, s, runId); if (denied) return denied; }
    // D4-FGA: runs AFTER the coarse allow(c,'write') gate above.
    const resourceDenied = await resourceGate(c, principalOf(c.req.raw), { type: 'run', id: runId }, 'cancel');
    if (resourceDenied) return resourceDenied;
    const key = inflightKey(s, runId);
    const set = inflight.get(key);
    const cancelled = set ? set.size : 0;
    if (set) for (const ctrl of set) ctrl.abort();
    // P2-cancel (wave 2, opt-in `?durable=true`): ALSO write the journal cancel flag — reaches runs
    // In-flight on OTHER workers (they stop at their next fresh model step) and makes the run refuse
    // Every future resume (terminal, like a compensated run; recovery = forkRun). WITHOUT the flag the
    // Default behavior is byte-identical to P0.3: in-process abort only, run stays resumable.
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
    if (isClient(c)) return c.json({ error: 'usage is organization-level: not available to a client credential' }, 403);
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
    const resourceId = c.req.query('resourceId') || undefined;
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
    const expected = c.req.query('resourceId');
    if (expected && memory.getThreadResource) {
      const owner = await memory.getThreadResource(threadId);
      // Names neither the real owner nor whether the thread exists — a caller guessing ids would
      // otherwise learn both from the refusal (same wording as the run-ownership check).
      if (owner && owner !== expected) {
        return c.json({ error: 'access denied: this thread belongs to a different resourceId' }, 403);
      }
    }
    return c.json(await memory.getMessages(threadId));
  });
  app.get('/runs/:id', async (c) => {
    if (!(await allowP(c.req.raw, 'runs:read'))) return deny(c.req.raw, 'read');
    const s = await scope(c);
    if ('error' in s) return c.json({ error: s.error }, s.status);
    const runId = decodeURIComponent(c.req.param('id'));
    { const d = clientSubjectDenied(c); if (d) return d; }
    const denied = await ownershipDenied(c, s, runId);
    if (denied) return denied;
    return c.json(await s.journal.readRun(runId));
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
  return toFetchHandler(restApiApp(config, opts));
}
