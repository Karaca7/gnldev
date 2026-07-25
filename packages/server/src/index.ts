// @gnldev/server — serves the createGnl registry over HTTP (auto-REST + OpenAPI). Every endpoint
// descends into runDurable → exactly-once/durability inherited for free. (The durable counterpart of the common auto-REST pattern.)
import { Hono, type Context } from 'hono';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createGnl, agentVisibleToOrg, withOrg, checkBudget, getOrgUsage, budgetsEnforceable, toJournal, appendLog, cancelAgentRun, RunLimitExceededError, ToolLoopDetectedError, blockedErrorCode, sealRequestContext, fingerprintAgent, recordAgent, approveAgent, blockAgent, isAgentServable, listAgentRegistry } from '@gnldev/durable';
import type { CreateGnlConfig, Journal, JournalReader, BudgetLimit, UsageCostCache, RunLimits } from '@gnldev/durable';
import { makeGate, normalizeAuth, principalOf, isPlatformAdmin, type AuthProvider, type ReadWriteAuth, type Principal } from '@gnldev/auth';
// P0.4 (AUDIT-R2): @gnldev/workflow is zero-dependency (see its package.json) — depending on it
// from @gnldev/server is a clean one-way edge (server→workflow), NOT circular: @gnldev/durable's registry.ts
// deliberately stays workflow-agnostic (WorkflowLike is a structural type, no import) to avoid a
// durable→workflow edge; server has no such constraint and needs the real functions at runtime.
import { listWorkflowRuns, getWorkflowRunStatus, cancelWorkflowRun } from '@gnldev/workflow';
import type { WorkflowRunStatus } from '@gnldev/workflow';
import { buildOpenApi } from './openapi.js';
import { pipeAgentStream } from './sse.js';

/** GOREV (audit: A2A unsigned) — signature window: a request with a timestamp this old/future is rejected (replay resistance). */
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
 * depend on the paid @gnldev/auth-ee package, so these are typed here rather than imported (see
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
  resolve?: (c: Context) => string | undefined | Promise<string | undefined>;
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
   * GOREV W1: SERVER-SIDE UPPER BOUND (opt-in) for per-run cost cap + loop detection. The `limits` in the
   * request body (client request) CANNOT EXCEED this cap — the effective limit for each field is computed
   * as `min(server, client)` (see `clampLimits`); if the client doesn't specify a field, the server cap
   * applies, and if neither server nor client specifies it, that field is never enforced. If neither is
   * given (default), behavior is preserved EXACTLY AS IS (unlimited).
   */
  limits?: RunLimits;
  /**
   * GOREV (audit: A2A unsigned) — opt-in A2A request verification: if given, the `x-gnl-signature`/
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
}

/**
 * GOREV W1: merge the server cap with the client request — the STRICTER one (smaller number) wins, the
 * client can NEVER loosen the server cap. If neither side gives a field, that field ends up absent (never
 * enforced) — the existing unlimited behavior is preserved.
 */
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
 *   POST /agents/:name/run       {runId, prompt|messages, threadId?, approvals?}
 *   POST /agents/:name/resume    {runId, approvals?}   (input is read from the journal)
 *   POST /agents/:name/stream    SSE
 *   GET  /agents                 agent metadata
 *   POST /workflows/:name/run    {runId?, input, resume?}  (suspend/resume/cancel safe)
 *   GET  /workflows              workflow metadata (name + steps)
 *   GET  /workflows/runs         P0.4: wfrun: registry query (?status=suspended|completed|canceled)
 *   POST /workflows/runs/:id/cancel  P0.4: durable cross-process workflow cancel
 *   GET  /runs/:id               journal timeline
 *   GET  /runs                   run summaries
 *   GET  /usage                  scope's token/cost usage + effective budget limit
 *   GET  /openapi.json           generated schema (agent + workflow)
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
 * side_effect_retry_blocked/run_busy → 409 + resumable:true (resolved via approval/retry);
 * retry_limit_exceeded → 422, NO resumable (a permanent 'failed' is left in the journal, the same runId
 * won't resume). If it doesn't match, returns undefined → the caller falls through to the generic 400
 * path.
 */
function blockedErrorResponse(c: Context, e: unknown): Response | undefined {
  const code = blockedErrorCode(e);
  if (!code) return undefined;
  const err = e as { message?: string; detail?: unknown } | null | undefined;
  const body = { error: err?.message ?? String(e), code, detail: err?.detail };
  return code === 'retry_limit_exceeded' ? c.json(body, 422) : c.json({ ...body, resumable: true }, 409);
}

export function createRestApi(config: CreateGnlConfig, opts: RestApiOptions = {}): Hono {
  // storage.runs (RunJournal) returns paginated listRuns → toJournal bridges it to the old array contract
  // (routes /runs, /usage, withOrg, and the budget gate all see the same shape).
  const baseJournal = (config.storage ? toJournal(config.storage.runs) : config.journal) as Journal & JournalReader;
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
  // HARDENING: one-time warn when a multi-org deployment serves an org-less request in the shared scope (see scope()).
  let warnedSharedOrgFallback = false;
  // Org registration record prefix (studio POST /organizations writes `__org__:<id>`; opt-in requireRegistration gate reads it).
  const ORG_RECORD_PRE = '__org__:';

  // Multi-organization: lazy registry per organization (same agent config, journal scoped to the
  // organization). Since the registry is per-org, model-fallback freezing and memory are also isolated
  // per organization.
  type Instance = typeof defaultInstance;
  const orgs = new Map<string, Instance>();
  function orgInstance(id: string): Instance {
    let inst = orgs.get(id);
    if (!inst) {
      const scoped = withOrg(baseJournal, id) as Journal & JournalReader;
      inst = { gnl: createGnl({ ...config, storage: undefined, journal: scoped }), journal: scoped, orgId: id };
      orgs.set(id, inst);
    }
    return inst;
  }
  /**
   * Resolve the request scope. An organization bound to identity (Principal.orgId, verified during
   * allow()) OVERRIDES the header and enforces isolation even if the org option is NOT SET UP (the
   * Cred.orgId promise: "organization isolation is enforced by identity"). If the bound identity requests
   * a different organization, 403.
   */
  async function scope(c: Context): Promise<Instance | { error: string; status: 400 | 403 }> {
    const principal = principalOf(c);
    const bound = principal?.orgId;
    // B2 — tenant isolation must NOT depend on the paid license capability: when the host configured
    // per-request orgs (opts.org) with an auth provider that produces NO principal (e.g. legacy
    // {read,write} auth whose authenticate()=null), the raw `x-gnl-org` header would drive the scope
    // with ZERO identity binding — cross-tenant read/write. There is no identity to isolate on, so this
    // combination is unsafe regardless of the license → fail closed. (An ABSENT auth provider is the
    // deliberate single-operator/no-auth mode and is unaffected.)
    if ((strictMultiOrg || !!opts.org) && authProvider && !principal) {
      return { error: 'access denied: tenant isolation is configured but this auth provider binds no identity to an organization (fail-closed)', status: 403 };
    }
    // STRICT (EE multi-org) FAIL-CLOSED: an authenticated identity with NO org binding AND NO explicit
    // platform-admin grant gets 403 — it is NOT the accidental super-admin. Kept license-gated on
    // purpose: the FREE tier's contract is that an unbound admin is the legacy cross-org OPERATOR
    // (see auth-org.test 'operator scenario'); a host wanting strict isolation binds every token's
    // Cred.orgId or runs the paid strict-multi-org model.
    if (strictMultiOrg && principal && !bound && !isPlatformAdmin(principal)) {
      return { error: 'access denied: no organization scope and no platform-admin grant (fail-closed)', status: 403 };
    }
    // If neither the org option nor an identity-bound organization exists → shared default (existing behavior).
    if (!opts.org && !bound) return defaultInstance;
    const resolve = opts.org?.resolve ?? ((ctx: Context) => ctx.req.header('x-gnl-org'));
    const requested = await resolve(c);
    if (bound && requested && requested !== bound) {
      return { error: `organization mismatch: identity is bound to organization '${bound}'`, status: 403 };
    }
    const id = bound ?? requested;
    if (!id) {
      if (opts.org?.required) return { error: 'organization required (x-gnl-org header)', status: 400 };
      // HARDENING (silent cross-tenant mixing): multi-org IS configured (`opts.org` set — we passed the
      // single-tenant early-return above) yet this request carries NO org and NO org-bound identity, so
      // it lands in the SHARED (unprefixed) scope alongside every other org-less request. That is a
      // potential data-mixing footgun a misconfigured client (missing x-gnl-org header) hits SILENTLY.
      // Behavior is unchanged (still served in shared scope — an operator who set `required:false`
      // opted into this), but it is no longer silent: warn ONCE so the operator discovers they likely
      // want `org.required = true` for strict tenant isolation.
      if (!warnedSharedOrgFallback) {
        warnedSharedOrgFallback = true;
        console.warn('@gnldev/server: multi-org is configured but a request resolved NO organization → served in the SHARED scope (its data mixes with other org-less requests). Set `org.required = true` to reject such requests instead (fail-closed). This warning fires once.');
      }
      return defaultInstance;
    }
    // HARDENING (opt-in): the resolved org must be EXPLICITLY REGISTERED. Without this, an org-bound
    // identity (or an x-gnl-org header) runs under `org:<id>:` whether or not that org was ever created
    // — a deleted org's still-valid tokens keep working, and a typo'd header silently forks a new
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
    return allowed ? undefined : c.json({ error: `resource access denied: ${resource.type}:${resource.id}`, code: 'resource_denied' }, 403);
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
    return c.json({ error: 'agent not approved to serve', code: 'agent_not_approved' }, 403);
  }

  /**
   * PLATFORM-ADMIN gate for the agent registry endpoints below — mirrors @gnldev/studio's
   * `requirePlatformAdmin` (packages/studio/src/server.ts). Approval is a PLATFORM decision (should this
   * code-agent serve AT ALL), never per-org, so an org-bound identity is always denied; in the strict
   * multi-org model an unbound identity additionally needs the EXPLICIT platform-admin grant.
   */
  function requirePlatformAdmin(c: Context, orgBoundMsg: string): Response | undefined {
    const p = principalOf(c);
    if (p?.orgId) return c.json({ error: orgBoundMsg }, 403);
    if (strictMultiOrg && !isPlatformAdmin(p)) {
      return c.json({ error: 'platform-admin required (fail-closed: no org scope and no platform-admin grant)' }, 403);
    }
    return undefined;
  }

  // Budget/quota WRITE PATH gate. Budgets are PER-ORG:
  //  - org ON + a request without an organization (root) → the root scope is NOT an organization, it
  //    spans the total across all organizations; the per-org `default` limit does not apply to it
  //    (otherwise it would produce a false 402).
  //  - org OFF → a single global scope can use the `default` limit (a legitimate global cap).
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
      ? c.json({ error: 'budget/quota exceeded — new run rejected', code: 'budget_exceeded', usage: check.usage, limit: check.limit }, 402)
      : undefined;
  }

  /**
   * "Resume intent" test (H2/1.3): if state ALREADY exists in the journal for the given runId (a
   * pending tool approval, a suspended/paused workflow, or the exactly-once repeat of a completed run),
   * this is NOT new work, it's a continuation of existing work — budgetGate is SKIPPED (otherwise
   * suspended work in an over-budget organization could NEVER be finished, an exactly-once violation).
   * For new-work requests (where the runId has no trace at all in the journal) the gate is ENFORCED
   * normally — no regression. `listKeys` is an optional Journal capability; without it, intent can't be
   * detected and it fails closed (the gate behaves normally; only this optimization is missed).
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
   * P0.3 (AUDIT-R2): in-process registry of the AbortControllers backing CURRENTLY IN-FLIGHT
   * `/run` and `/stream` generations, keyed by an ORG-SCOPED key (NOT the raw runId — two different
   * organizations may legitimately use the SAME client-supplied runId for unrelated work; a flat
   * `runId → controllers` map would let org A's cancel abort org B's generation, a cross-tenant
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
    const p = principalOf(c);
    return p?.id ?? c.req.header('x-gnl-actor') ?? (p?.roles[0] ? `role:${p.roles[0]}` : 'anon');
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
      const p = principalOf(c);
      const org = p?.orgId ?? orgId;
      // ALWAYS the ROOT journal (baseJournal), NEVER an org-scoped view — the `__audit__` contract
      // (see @gnldev/studio server.ts's /audit reader) is a SINGLE root-level trail with the organization
      // carried as a PAYLOAD FIELD for filtering. An org-prefixed write (`org:<id>:__audit__:…`) would
      // be invisible to studio's audit view (it deliberately reads the root journal for exactly this reason).
      await appendLog(baseJournal, '__audit__', { actor, action, target, ...(org ? { org } : {}), ...(detail !== undefined ? { detail } : {}) });
    } catch { /* audit is best-effort — swallow */ }
  }

  app.post('/agents/:name/run', async (c) => {
    // Running an agent is the `agents:run` permission (member + admin; viewer denied). In the free tier
    // this reduces to 'write' → identical to the previous allow(c,'write') (admin only) → no regression.
    if (!(await allowP(c, 'agents:run'))) return deny(c, 'write');
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
    // check right below, which runs AFTER the coarse allowP('agents:run') gate above.
    const principal = principalOf(c);
    const resourceDenied = await resourceGate(c, principal, { type: 'agent', id: name }, 'run');
    if (resourceDenied) return resourceDenied;
    // CONSISTENT with 1.3: continuing a suspended run from this endpoint with the SAME runId + approvals
    // (like stream does) is also resume intent → if there's a trace in the journal the budget gate is
    // skipped; new runIds are still ENFORCED (no regression).
    if (!(await isResumeIntent(s.journal, body.runId))) {
      const over = await budgetGate(c, s);
      if (over) return over;
    }
    // P0.3: register an org-scoped AbortController so POST /runs/:id/cancel can stop THIS generation.
    // Composed with the client's own disconnect signal (P0.2) via AbortSignal.any — whichever fires
    // first wins; either way the journal keeps whatever prefix already completed (resumable, same as P0.2).
    const ctrl = new AbortController();
    const key = inflightKey(s, body.runId);
    registerInflight(key, ctrl);
    try {
      // P1.7 (AUDIT-R2): seal the AUTHENTICATED identity into context — a body-supplied
      // `context.__gnl_orgId`/`__gnl_resourceId`/`__gnl_threadId` (spoof attempt) is stripped and
      // replaced by (or removed in favor of) the server-derived value. See sealRequestContext.
      const r = await s.gnl.run(name, {
        runId: body.runId,
        prompt: body.prompt,
        messages: body.messages,
        threadId: body.threadId,
        approvals: body.approvals,
        context: sealRequestContext(
          { ...(body.context ?? {}), ...(s.orgId ? { org: s.orgId } : {}) },
          { orgId: s.orgId ?? principal?.orgId, resourceId: principal?.id },
        ),
        limits: clampLimits(opts.limits, body.limits),
        // P0.2 (AUDIT-R2): a client disconnect stops generation instead of billing tokens to
        // completion — an abort mid-run does NOT break resumable behavior, the journal keeps whatever
        // prefix already completed and a later call with the SAME runId resumes/replays as before.
        // P0.3: OR an explicit cancel via POST /runs/:id/cancel (ctrl.signal) — same non-destructive semantics.
        abortSignal: AbortSignal.any([c.req.raw.signal, ctrl.signal]),
      });
      return c.json({ ok: true, runId: body.runId, text: r.text, interrupts: r.interrupts });
    } catch (e: any) {
      return limitErrorResponse(c, e) ?? blockedErrorResponse(c, e) ?? c.json({ error: String(e?.message ?? e) }, 400);
    } finally {
      unregisterInflight(key, ctrl);
    }
  });

  app.post('/agents/:name/resume', async (c) => {
    if (!(await allowP(c, 'agents:run'))) return deny(c, 'write');
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
    // CONSISTENT with H2/1.3: only a REAL resume (there's a trace in the journal) skips the budget
    // gate — otherwise this endpoint would be an unlimited backdoor (bypassing the quota with a
    // traceless/made-up runId). Without a trace (typo/abuse) it's ENFORCED normally; input also comes
    // back empty and the request fails harmlessly.
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
        context: s.orgId ? { org: s.orgId } : undefined,
        limits: clampLimits(opts.limits, body.limits),
        ...(input.messages ? { messages: input.messages } : { prompt: input.prompt }),
      });
      return c.json({ ok: true, runId: body.runId, text: r.text, interrupts: r.interrupts });
    } catch (e: any) {
      return limitErrorResponse(c, e) ?? blockedErrorResponse(c, e) ?? c.json({ error: String(e?.message ?? e) }, 400);
    }
  });

  // Metadata list of registered agents (for the client/playground agent selector).
  // Org-scoped: an org-bound caller only sees GLOBAL agents + agents whose `orgs` include their org.
  app.get('/agents', async (c) => {
    if (!(await allow(c, 'read'))) return deny(c, 'read');
    const s = await scope(c);
    if ('error' in s) return c.json({ error: s.error }, s.status);
    return c.json(listAgentMeta(config, s.orgId));
  });

  // ── Agent approval registry (governance surface — see RestApiOptions.requireAgentApproval) ──────
  // Platform-level: "should this code-agent serve AT ALL" is never a per-org decision, so every endpoint
  // here is platform-admin gated (requirePlatformAdmin) REGARDLESS of whether requireAgentApproval is
  // turned on — an operator can review/approve agents ahead of flipping the enforcement flag.
  app.get('/agents/registry', async (c) => {
    if (!(await allow(c, 'read'))) return deny(c, 'read');
    { const denied = requirePlatformAdmin(c, 'an org-bound identity cannot view the agent registry (operator required)'); if (denied) return denied; }
    await agentRegistryBoot;
    try {
      return c.json(await listAgentRegistry(baseJournal));
    } catch (e: any) {
      return c.json({ error: String(e?.message ?? e) }, 501);
    }
  });

  app.post('/agents/registry/:name/approve', async (c) => {
    if (!(await allow(c, 'write'))) return deny(c, 'write');
    { const denied = requirePlatformAdmin(c, 'an org-bound identity cannot approve an agent (operator required)'); if (denied) return denied; }
    await agentRegistryBoot;
    const name = decodeURIComponent(c.req.param('name'));
    const body = (await c.req.json().catch(() => ({}))) as { note?: string };
    const rec = await approveAgent(baseJournal, name, actorOf(c), body.note);
    await audit(c, undefined, 'agent.approve', name, body.note !== undefined ? { note: body.note } : undefined);
    return c.json({ ok: true, record: rec });
  });

  app.post('/agents/registry/:name/block', async (c) => {
    if (!(await allow(c, 'write'))) return deny(c, 'write');
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
    if (!(await allowP(c, 'agents:run'))) return deny(c, 'write');
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
    // check right below, which runs AFTER the coarse allowP('agents:run') gate above.
    const principal = principalOf(c);
    const resourceDenied = await resourceGate(c, principal, { type: 'agent', id: name }, 'run');
    if (resourceDenied) return resourceDenied;
    // 1.3: resume intent via approvals+runId (a pending tool approval) → the budget gate is skipped
    // CONSISTENTLY with /agents/:name/resume (otherwise a pending interrupt in an over-budget
    // organization would never finish).
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
          { ...(body.context ?? {}), ...(s.orgId ? { org: s.orgId } : {}) },
          { orgId: s.orgId ?? principal?.orgId, resourceId: principal?.id },
        ),
        limits: clampLimits(opts.limits, body.limits),
        // P0.2 (AUDIT-R2): same as /agents/:name/run above — stop generation (and its token
        // billing) on client disconnect. Deliberately compatible with W3 resumable SSE just below: an
        // abort only stops THIS response's fullStream early: the journal still has whatever prefix
        // completed before the abort, so a resumed/replayed call with the SAME runId (with or without
        // Last-Event-ID) sees the same journal state it would have without the abort.
        // P0.3: OR an explicit cancel via POST /runs/:id/cancel (ctrl.signal) — same non-destructive semantics.
        abortSignal: AbortSignal.any([c.req.raw.signal, ctrl.signal]),
      });
    } catch (e: any) {
      unregisterInflight(key, ctrl);
      return limitErrorResponse(c, e) ?? blockedErrorResponse(c, e) ?? c.json({ error: String(e?.message ?? e) }, 400);
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
    // GOREV W3: disconnect-recovery — if there's a Last-Event-ID header (sent automatically by
    // EventSource) or body.lastEventId, events the client has already seen are not rewritten (see the note in sse.ts).
    const lastEventIdRaw = c.req.header('Last-Event-ID') ?? body.lastEventId;
    const lastEventId = lastEventIdRaw != null && lastEventIdRaw !== '' ? Number(lastEventIdRaw) : undefined;
    return pipeAgentStream(c, body.runId, result, Number.isFinite(lastEventId as number) ? { lastEventId } : undefined);
  });

  // Metadata list of registered workflows (name + steps + kind).
  app.get('/workflows', async (c) => ((await allow(c, 'read')) ? c.json(defaultInstance.gnl.listWorkflows()) : deny(c, 'read')));

  // Run the workflow durably: {runId?, input}. If runId is given, it can be resumed with the same runId.
  app.post('/workflows/:name/run', async (c) => {
    if (!(await allow(c, 'write'))) return deny(c, 'write');
    const name = c.req.param('name');
    if (!workflowNames.includes(name)) return c.json({ error: `workflow '${name}' not registered` }, 404);
    const parsed = await readSignedBody(c); // F1: A2A signature enforced here too
    if ('denied' in parsed) return parsed.denied;
    const body = parsed.body as any;
    const s = await scope(c);
    if ('error' in s) return c.json({ error: s.error }, s.status);
    // D4-FGA: runs AFTER the coarse allow(c,'write') gate above.
    const resourceDenied = await resourceGate(c, principalOf(c), { type: 'workflow', id: name }, 'run');
    if (resourceDenied) return resourceDenied;
    // H2: this endpoint with the same runId is the ONLY resume mechanism for a workflow. If runId is
    // given AND there's already a trace in the journal (suspended/paused) this is a resume → the budget
    // gate is skipped (new work is still ENFORCED).
    if (!(body.runId && (await isResumeIntent(s.journal, body.runId)))) {
      const over = await budgetGate(c, s);
      if (over) return over;
    }
    // P0.4: register an org-scoped AbortController in the SAME `inflight` map used by agent runs, but
    // under a `wf:` sub-namespace — a client-supplied workflow runId and an agent runId could collide,
    // so keying them into the SAME bucket would let `/runs/:id/cancel` (agent-only) abort a workflow run
    // by accident. Only `POST /workflows/runs/:id/cancel` below targets this namespace; only registered
    // when body.runId is known (an auto-generated runId has no addressable key for a future cancel).
    const ctrl = new AbortController();
    const wfKey = body.runId ? 'wf:' + inflightKey(s, body.runId) : undefined;
    if (wfKey) registerInflight(wfKey, ctrl);
    try {
      const wfOpts = {
        ...(body.runId ? { runId: body.runId } : {}),
        // P0.4 typed resume: `{ [waitId]: payload }` — journaled before any step runs (see waitForResume).
        ...(body.resume ? { resume: body.resume } : {}),
        // Composed with the client's disconnect signal — same non-destructive semantics as P0.2/P0.3 for
        // agent runs: an abort just stops new steps, the journal keeps whatever prefix already completed.
        signal: AbortSignal.any([c.req.raw.signal, ctrl.signal]),
      };
      const result = await s.gnl.runWorkflow(name, body.input, wfOpts);
      return c.json({ ok: true, ...result });
    } catch (e: any) {
      return limitErrorResponse(c, e) ?? blockedErrorResponse(c, e) ?? c.json({ error: String(e?.message ?? e) }, 400);
    } finally {
      if (wfKey) unregisterInflight(wfKey, ctrl);
    }
  });

  /**
   * P0.4 (AUDIT-R2): the suspended/completed/canceled workflow-run REGISTRY query — every run
   * in ONE `wfrun:` prefix scan (see @gnldev/workflow's listWorkflowRuns). Org-scoped via `scope(c)`/
   * `s.journal`: `wfrun:<runId>` keys are NOT runId-prefixed but `withOrg` still prefixes them
   * unconditionally (prefixes EVERY key), so organization isolation holds automatically — see the
   * `statusKey` JSDoc in workflow.ts. `listKeys` is an optional Journal capability; without it
   * `listWorkflowRuns` throws a clear error — surfaced as 501 (capability-missing, same pattern as
   * studio's own listKeys-gated routes) rather than a silent empty list.
   */
  app.get('/workflows/runs', async (c) => {
    if (!(await allow(c, 'read'))) return deny(c, 'read');
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
   * resume forever). Visibility: EITHER the `wfrun:` registry record exists OR the `_suspend` marker does
   * (a run mid-flight whose advisory registry write failed still leaves this trace) — neither existing
   * means the run doesn't exist IN THIS SCOPE (cross-org 404, same no-existence-leak pattern as
   * agentGate/`/runs/:id/cancel`). ALSO aborts any in-flight controller registered for this workflow run
   * (the `wf:`-namespaced bucket registered by POST /workflows/:name/run above) — best-effort, same
   * multi-worker honesty caveat as `/runs/:id/cancel`.
   */
  app.post('/workflows/runs/:id/cancel', async (c) => {
    if (!(await allow(c, 'write'))) return deny(c, 'write');
    const runId = decodeURIComponent(c.req.param('id'));
    const s = await scope(c);
    if ('error' in s) return c.json({ error: s.error }, s.status);
    const status = await getWorkflowRunStatus(s.journal, runId);
    const visible = status !== undefined || (await s.journal.get(`${runId}:wf:_suspend`)) !== undefined;
    if (!visible) return c.json({ error: `workflow run '${runId}' not found` }, 404);
    // D4-FGA: runs AFTER the coarse allow(c,'write') gate above.
    const resourceDenied = await resourceGate(c, principalOf(c), { type: 'workflow', id: runId }, 'cancel');
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
   * P0.3 (AUDIT-R2): GET /runs — paginated + filtered when any query param is given;
   * EXACTLY the legacy array response with NO params (backward compat — existing clients/tests that
   * assert on `runs[0].runId` etc. see byte-identical behavior).
   *   ?limit=      clamped to [1, 1000] (default 50 — same default every adapter's own listRuns uses)
   *   ?cursor=     opaque — pass back a page's `nextCursor` verbatim
   *   ?status=     'completed' | 'suspended' — else 400
   *   ?agent=      exact match against RunSummary.agent
   */
  app.get('/runs', async (c) => {
    if (!(await allow(c, 'read'))) return deny(c, 'read');
    const s = await scope(c);
    if ('error' in s) return c.json({ error: s.error }, s.status);
    const limitRaw = c.req.query('limit');
    const cursor = c.req.query('cursor');
    const statusRaw = c.req.query('status');
    const agent = c.req.query('agent');
    if (limitRaw == null && cursor == null && statusRaw == null && agent == null) {
      return c.json(await s.journal.listRuns()); // no params → legacy array (unchanged)
    }
    let status: 'completed' | 'suspended' | undefined;
    if (statusRaw != null) {
      if (statusRaw !== 'completed' && statusRaw !== 'suspended') {
        return c.json({ error: `invalid status '${statusRaw}' (expected 'completed' or 'suspended')` }, 400);
      }
      status = statusRaw;
    }
    const limit = limitRaw != null ? Math.max(1, Math.min(1000, Math.trunc(Number(limitRaw)) || 50)) : undefined;
    const q = {
      ...(limit != null ? { limit } : {}),
      ...(cursor ? { cursor } : {}),
      ...(status ? { status } : {}),
      ...(agent ? { agent } : {}),
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
    const filtered = all.filter((r) => (status ? r.status === status : true) && (agent ? r.agent === agent : true));
    const start = cursor ? Number(cursor) || 0 : 0;
    const lim = limit ?? 50;
    const items = filtered.slice(start, start + lim);
    const next = start + lim;
    return c.json({ items, nextCursor: next < filtered.length ? String(next) : undefined });
  });

  /**
   * P0.3 (AUDIT-R2): cancel in-flight generation for a run on THIS server instance.
   * HONESTY (multi-worker): `inflight` is a plain in-process Map — this endpoint can only abort
   * controllers registered on the SAME process that received THIS request. Behind a load balancer with
   * multiple workers, a run's `/stream` may be in-flight on a DIFFERENT worker than the one that
   * receives the cancel → `cancelled: 0` even though the run is genuinely still running elsewhere.
   * Closing that gap needs a journal-level cancel FLAG that every worker polls during generation
   * (deliberately deferred — see AUDIT-R2 P0.4/P2). The run itself is UNAFFECTED by this
   * limitation: it stays resumable either way (the journal prefix is intact — cancel never deletes
   * anything, it only stops NEW tokens/tool-calls from being produced on this instance).
   */
  app.post('/runs/:id/cancel', async (c) => {
    if (!(await allow(c, 'write'))) return deny(c, 'write');
    const runId = decodeURIComponent(c.req.param('id'));
    const s = await scope(c);
    if ('error' in s) return c.json({ error: s.error }, s.status);
    // Org-scope visibility: a run from another organization is invisible through THIS scope's prefixed
    // journal (withOrg strips/prefixes every key) — `:input` is written by every run() /stream() call
    // (persistInput, run.ts) so its absence means either the run never existed or it belongs to a
    // different organization; both cases return the SAME 404 (no existence leak, same pattern as agentGate).
    const visible = await s.journal.get(`${runId}:input`);
    if (visible === undefined) return c.json({ error: `run '${runId}' not found` }, 404);
    // D4-FGA: runs AFTER the coarse allow(c,'write') gate above.
    const resourceDenied = await resourceGate(c, principalOf(c), { type: 'run', id: runId }, 'cancel');
    if (resourceDenied) return resourceDenied;
    const key = inflightKey(s, runId);
    const set = inflight.get(key);
    const cancelled = set ? set.size : 0;
    if (set) for (const ctrl of set) ctrl.abort();
    // P2-cancel (Dalga-2, opt-in `?durable=true`): ALSO write the journal cancel flag — reaches runs
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
    if (!(await allow(c, 'read'))) return deny(c, 'read');
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
  app.get('/runs/:id', async (c) => {
    if (!(await allow(c, 'read'))) return deny(c, 'read');
    const s = await scope(c);
    if ('error' in s) return c.json({ error: s.error }, s.status);
    return c.json(await s.journal.readRun(decodeURIComponent(c.req.param('id'))));
  });
  app.get('/openapi.json', async (c) => ((await allow(c, 'read')) ? c.json(buildOpenApi(names, workflowNames, opts.title)) : deny(c, 'read')));

  return app;
}

export { buildOpenApi } from './openapi.js';
export { pipeAgentStream, interruptsFromSteps } from './sse.js';
