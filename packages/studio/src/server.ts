import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { toFetchHandler, type FetchHandler } from './handler.js';
import { Hono, type Context } from 'hono';
import { sseResponse } from './sse.js';

import { asReaderJournal, reconstructState, forkRun, getRunCost, withOrg, appendLog, listLog, purgeRun, purgeOrganization, sweepRuns, POLICY_KEY, BUDGET_PRE, readBudget, replayRun, regressionReport, resolveModel, getNetworkTrace, RunLimitExceededError, ToolLoopDetectedError, blockedErrorCode, upstreamFailure, readProcessorReports, readIncidents, agentVisibleToOrg, readMetricsSummary, metricsRunKey, cancelAgentRun, listAgentRegistry, approveAgent, blockAgent } from '@gnldev/durable';
import type { PolicyDoc, PolicyRule, BudgetLimit } from '@gnldev/durable';
import type { JournalReader, Journal, WorkflowLike, MetricsRunRow } from '@gnldev/durable';
import { makeGate, normalizeAuth, principalOf, isPlatformAdmin, principalScope, assertAssignablePrivileges, type AuthProvider, type Principal } from '@gnldev/auth';
import { listTriggers } from '@gnldev/scheduler';
import { mountSpa, notBuiltHtml } from './spa.js';
import { openapiSpec, swaggerHtml } from './swagger.js';
import { pipeAgentStream } from './sse.js';

/** Scheduler view trigger row (same shape as @gnldev/scheduler `listTriggers` — see GET /scheduler/triggers). */
export type { TriggerInfo } from '@gnldev/scheduler';

export type StudioResume = (
  runId: string,
  approvals: Record<string, boolean>,
) => Promise<{ text?: string; interrupts?: unknown[]; finishReason?: string }>;

export type StudioChat = (
  message: string,
  opts?: { runId?: string },
) => Promise<{ runId?: string; text?: string; interrupts?: unknown[]; finishReason?: string }>;

/** Metadata for a single tool (for the Tools view + agent context panel). */
export interface ToolMeta {
  name: string;
  description?: string;
  /** JSON Schema (if the app supplied `toJsonSchema`); otherwise undefined. */
  inputSchema?: unknown;
  /** True if an agent using this tool has a guard (test-run respects the guard). */
  guarded?: boolean;
}

/** Flat tool list item: which agents use it + whether it's shared. */
export interface ToolListItem extends ToolMeta {
  agents: string[];
  shared: boolean;
}

/** Agent metadata (for the playground selector; the model object is hidden → string id / 'custom'). */
export interface AgentMeta {
  name: string;
  model: string;
  system?: string;
  hasTools: boolean;
  maxSteps: number;
  /** Tools this agent sees (shared + agent-specific); filled in by createStudioRunner. */
  tools?: ToolMeta[];
  /** Orgs this org-scoped agent belongs to (UI label + visibility filter); undefined for global agents. */
  orgs?: string[];
}

/**
 * Playground runner (duck-typed): lets studio run an agent from the browser. Produced from a createGnl
 * Instance via `createStudioRunner` — the studio core does not require createGnl at runtime.
 */
export interface StudioAgentRunner {
  listAgents (): Promise<AgentMeta[]> | AgentMeta[];
  run (name: string, opts: { runId: string; prompt?: string; messages?: unknown; threadId?: string; resourceId?: string; approvals?: Record<string, boolean>; model?: string; temperature?: number; topP?: number; system?: string; tools?: string[] }): Promise<{ text?: string; interrupts?: unknown[]; finishReason?: string }>;
  stream?(name: string, opts: { runId: string; prompt?: string; messages?: unknown; threadId?: string; resourceId?: string; approvals?: Record<string, boolean>; model?: string; temperature?: number; topP?: number; system?: string; tools?: string[] }): Promise<any>;
  /** If given, the Tools view shows the tool list. */
  listTools?(): Promise<ToolListItem[]> | ToolListItem[];
  /** If given, tools can be run for TEST purposes (respects the guard; opts.durable → writes to the
   *  Journal; opts.approve → approve/deny and resume a suspended durable test). */
  runTool?(
    name: string,
    input: unknown,
    opts?: { durable?: boolean; approve?: { runId: string; toolCallId: string; approved: boolean } },
  ): Promise<{ result?: unknown; error?: string; blocked?: 'deny' | 'approval'; runId?: string }>;
  /** True when runTool's durable mode is supported (a journal exists). */
  toolExecDurable?: boolean;
  /** If given, the Workflows view lists workflow definitions. */
  listWorkflows?(): WorkflowMeta[] | Promise<WorkflowMeta[]>;
  /** If given, workflows can run durably; if opts.runId is given, RESUMES the SAME run.
   * P0.4 opts.resume delivers typed HITL payloads (see @gnldev/workflow's
   *  WaitForResume); a canceled run (durable cancel or an aborted signal upstream) reports `canceled`. */
  runWorkflow?(
    name: string,
    input: unknown,
    opts?: { runId?: string; maxSteps?: number; resume?: Record<string, unknown> },
  ): Promise<{ runId: string; output?: unknown; suspended?: boolean; paused?: boolean; canceled?: boolean; stepId?: string; reason?: unknown; steps: { id: string; kind: string; output: unknown }[] }>;
}

/**
 * For the Memory/Threads view (optional). The app wraps a @gnldev/memory (AgentMemory) instance in this interface.
 * `listThreads` takes a resourceId (threads are indexed by resource).
 */
export interface StudioMemory {
  listThreads (resourceId?: string): Promise<unknown[]> | unknown[];
  getMessages (threadId: string): Promise<unknown[]> | unknown[];
  getWorkingMemory?(threadId: string): Promise<unknown> | unknown;
  /** Updates the thread's title/metadata (rename). Returns 501 from the route if the adapter doesn't support it. */
  updateThread?(threadId: string, patch: { title?: string; metadata?: Record<string, unknown> }): Promise<unknown> | unknown;
  /** Deletes the thread (soft-delete). Returns 501 from the route if the adapter doesn't support it. */
  deleteThread?(threadId: string): Promise<void> | void;
  /** Truncates the thread: deletes the message at `afterIndex` and every message after it (index base:
   *  The `getMessages` list — i.e. matches the `/threads/:id/messages` response 1:1). `afterIndex === -1`
   *  Deletes every message. Returns the number of deleted messages, or `null` if the underlying store
   *  Doesn't support the capability. Returns 501 from the route if the adapter doesn't support it. */
  truncateMessages?(threadId: string, afterIndex: number): Promise<number | null> | number | null;
}

/** Introspection for a single workflow (Workflows view). */
export interface WorkflowMeta {
  name: string;
  steps: { id: string; kind?: string }[];
  /** INPUT metadata the workflow expects; the `/workflows` route fills this from the `workflowInputs` option. */
  input?: { schema?: unknown; example?: unknown; description?: string };
  /** 'code' = defined in code (read-only), 'managed' = managed via the Studio editor. */
  source?: 'code' | 'managed';
  description?: string;
}

/** For the Workflows view (optional). The app extracts its own workflows via `w.build()` and provides them. */
export interface StudioWorkflows {
  listWorkflows (): Promise<WorkflowMeta[]> | WorkflowMeta[];
}

/** A managed workflow step — created/edited via the Studio editor. */
export interface WorkflowStepDef {
  id: string;
  agentName: string;
  /** Prompt template: {{input}} = initial input, {{prev}} = previous step's output. */
  prompt?: string;
}
/** A managed workflow definition — stored persistently via Studio CRUD. */
export interface WorkflowDef {
  name: string;
  description?: string;
  steps: WorkflowStepDef[];
  createdAt?: number;
  updatedAt?: number;
}
/** A single (immutable) version of a managed agent — promote only moves the pointer. */
export interface AgentVersion {
  version: number;
  model: string;
  system?: string;
  maxSteps?: number;
  /** Version note (what changed). */
  note?: string;
  createdAt: number;
}
/** Managed agent record: version history + active (prod) version number (null = never promoted). */
export interface ManagedAgentRecord {
  name: string;
  active: number | null;
  versions: AgentVersion[];
}

/** Managed workflow store — if not given, a writable journal is used automatically. */
export interface StudioWorkflowStore {
  list (): Promise<WorkflowDef[]> | WorkflowDef[];
  get (name: string): Promise<WorkflowDef | undefined> | WorkflowDef | undefined;
  set (def: WorkflowDef): Promise<void> | void;
  delete (name: string): Promise<void> | void;
}

/**
 * Compiles a managed WorkflowDef into an executable WorkflowLike. The host passes `compileManagedWorkflow`
 * From `@gnldev/studio/workflow` (the @gnldev/workflow import is isolated there so the studio core stays decoupled).
 * If given, managed workflows run with the SAME engine as code workflows (each step is journaled → exactly-once,
 * Suspend/resume, poll-to-stream/history/inspector all work the same way).
 */
export type CompileWorkflowFn = (
  def: WorkflowDef,
  runAgent: (name: string, opts: { runId: string; prompt?: string }) => Promise<{ text?: string }>,
  input: unknown,
) => WorkflowLike;

/** A single score result (Scorers view). */
export interface ScoreRunResultLike {
  output?: string;
  scores: Record<string, { score: number; reason?: string }>;
}

/**
 * For the Scorers/Evals view (optional). The app supplies scorer names + a scoring function
 * (internally calls @gnldev/evals `scoreRun(reader, runId, scorers, {expected})` → studio has no dependency on evals).
 */
export interface StudioScorers {
  list (): Promise<string[]> | string[];
  score (runId: string, scorerNames: string[], opts?: { expected?: string }): Promise<ScoreRunResultLike> | ScoreRunResultLike;
}

/** Eval dataset info (for the Evals view list). */
export interface DatasetMeta { id: string; cases: number; description?: string }
/** A dataset eval suite result (structurally compatible with @gnldev/evals `evalDataset` output). */
export interface EvalDatasetResultLike {
  datasetId: string;
  cases: { caseId: string; output: string; scores: Record<string, { score: number; reason?: string }> }[];
  aggregate: Record<string, number>;
}
/**
 * For the Evals/datasets view (optional). The app supplies a dataset list + a runner (internally calls
 * @gnldev/evals `evalDataset(...)` → studio has no dependency on evals).
 */
export interface StudioDatasets {
  list (): Promise<DatasetMeta[]> | DatasetMeta[];
  run (id: string, opts?: { scorers?: string[] }): Promise<EvalDatasetResultLike> | EvalDatasetResultLike;
}

/** An MCP server's definition as given to studio (MCP Servers view). */
export interface StudioMcpServer {
  id: string;
  name?: string;
  client: { listTools (): Promise<{ tools: { name: string; description?: string; inputSchema?: unknown }[] }> };
}

/** Queue/Jobs view: summary of background jobs (fed by @gnldev/queue listJobs). */
export interface StudioJob { id: string; type: string; status: string; attempts: number; }
export interface StudioQueue {
  listJobs (): Promise<StudioJob[]> | StudioJob[];
  /**
   * If given, `POST /jobs/:id/retry` works (the host typically wraps @gnldev/queue's `retryJob(work, id)`):
   * Re-queues a failed (dead-letter/qfail) job as a NEW job with the original type/payload, and returns
   * The new job id. Returns `null` if the job isn't found OR isn't yet terminal-failed (pending/done — to
   * Prevent DOUBLE-RUNNING it); the server reflects this as a 409.
   */
  retry?(id: string): Promise<string | null> | string | null;
}

/** Cache view: hit/miss ratio + size (duck-type compatible with @gnldev/cache `stats()`). */
export interface StudioCacheStats { hits: number; misses: number; hitRate: number; size: number; }
/** Cache view contract — studio has no DEPENDENCY on @gnldev/cache; the host wraps its own cache instance
 *  (same pattern as Queue/Vectors: optional, duck-typed interface). */
export interface StudioCache {
  stats (): Promise<StudioCacheStats> | StudioCacheStats;
  /**
   * If given, `POST /cache/invalidate` works: if `key` is given, only that key is removed; if not given
   * (best-effort — CacheStore doesn't offer key enumeration), all keys the host KNOWS ABOUT are removed
   * (see @gnldev/cache `invalidate()`). Returns the number of keys removed.
   */
  invalidate?(key?: unknown): Promise<number> | number;
}

/** Knowledge view: vector store search (the host app wraps its own embed+store). */
export interface StudioVectorMatch { id: string; text: string; score: number; metadata?: Record<string, unknown>; }
export interface StudioVectors { search (query: string, topK?: number): Promise<StudioVectorMatch[]> | StudioVectorMatch[]; }

/** Safe user view exposed to studio (no secrets/tokens). */
export interface StudioUser {
  id: string;
  email?: string;
  name?: string;
  roles: string[];
  /** EXPLICIT fine-grained permissions (overrides role grants). Undefined → permission comes from roles. */
  permissions?: string[];
  orgId?: string;
  createdAt?: number;
  /** The token's expiry (epoch ms). Never expires if not given. */
  expiresAt?: number;
  /** Last successful authenticate time (epoch ms, best-effort). */
  lastUsedAt?: number;
  /** true → the token is revoked (access is cut WITHOUT deleting the user). */
  revoked?: boolean;
}
/** User management contract (paid; implemented by @gnldev/auth-ee createJournalUserStore). */
export interface StudioUserStore {
  list(): Promise<StudioUser[]> | StudioUser[];
  create(input: { email?: string; name?: string; roles?: string[]; permissions?: string[]; orgId?: string; ttlMs?: number; expiresAt?: number }): Promise<{ user: StudioUser; token: string }>;
  remove(id: string): Promise<void>;
  /** Revokes the user's token WITHOUT deleting the user (optional — backward compat). */
  revoke?: (id: string) => Promise<void>;
  /**
   * Updates a user's roles and/or explicit permissions in place (token unchanged). Optional — a host
   * Without it returns 501 from PATCH /users/:id. An empty `permissions` array clears the explicit override.
   */
  update?: (id: string, patch: { roles?: string[]; permissions?: string[] }) => Promise<StudioUser>;
}

/** A single fine-grained permission the customer admin can assign to a user (checkbox in the UI). */
export interface PermissionCatalogEntry {
  /** The permission id enforced by the backend (e.g. 'agents:run'). MUST match a real `allowP` call. */
  id: string;
  label: string;
  group?: string;
  description?: string;
}

/**
 * PERMISSION CATALOG — the GNL-team-owned, CODE-DEFINED source of truth for fine-grained permissions.
 * READ-ONLY on purpose: customers do NOT create permission TYPES from Studio. A permission only does
 * Anything if a GNL endpoint actually ENFORCES it (via gate.allowP) — so the definition belongs to GNL,
 * Not the customer. Extending the catalog = the GNL team adding a new entry HERE *plus* its enforcement
 * (an allowP call) in a release; it is never a runtime/customer action. The customer admin only ASSIGNS
 * These permissions to users (POST/PATCH /users). Exposed read-only at GET /permissions/catalog.
 */
export const PERMISSION_CATALOG: PermissionCatalogEntry[] = [
  { id: 'agents:run', label: 'Run agents', group: 'run', description: 'Execute / stream / resume agents' },
  { id: '*:read', label: 'View runs & data', group: 'read', description: 'Read-only access to runs, usage, audit' },
  { id: 'run:write', label: 'Fork/resume runs', group: 'run', description: 'Fork a run or resume an approval' },
  { id: 'run:delete', label: 'Delete/purge runs', group: 'run', description: 'Permanently purge a run (GDPR)' },
  { id: 'users:write', label: 'Manage users', group: 'admin', description: 'Create / update / delete / revoke users' },
  { id: 'budget:write', label: 'Manage budgets', group: 'admin', description: 'Set per-org budget / quota' },
  { id: 'org:write', label: 'Manage organizations', group: 'admin', description: 'Create / delete organizations' },
  { id: 'policy:write', label: 'Manage policy', group: 'admin', description: 'Edit the global tool policy' },
  { id: 'workflow:write', label: 'Manage workflows', group: 'workflow', description: 'Create / update / delete managed workflows' },
];

/**
 * Role → pre-checked permissions. MIRRORS the @gnldev/auth-ee rbac.ts default grants (both are code, kept in
 * Sync by the GNL team in one release). The UI seeds a role's checkboxes from this when a role is picked;
 * The customer admin can then tick/untick individual boxes and PATCH the user's explicit permissions.
 */
export const ROLE_PERMISSION_PRESETS: Record<string, string[]> = {
  viewer: ['*:read'],
  member: ['*:read', 'agents:run'],
  admin: ['*'],
};

/** Role-based access: `read` gates GET (viewer), `write` gates POST resume/fork/chat (admin). Open if not given. */
export interface StudioAuth {
  read?: (req: Request) => boolean | Promise<boolean>;
  write?: (req: Request) => boolean | Promise<boolean>;
}

export interface StudioApiOptions {
  reader: JournalReader;
  /** If given, approval/fork → resume works. */
  resume?: StudioResume;
  /**
   * If given, POST /runs/:id/compensate works — the operator's "unwind this abandoned
   * Run" action. The host wires it to @gnldev/durable compensateRun with ITS tool set (the compensate
   * Hooks live in code): `compensate: (runId, o) => compensateRun(runId, { journal, tools, ...o })`.
   * IRREVERSIBLE (a condemned run never resumes) → the endpoint is write-gated and audited.
   */
  compensate?: (runId: string, opts?: { dryRun?: boolean }) => Promise<unknown>;
  /** If given, live chat works. */
  chat?: StudioChat;
  /** If given, the Playground works: pick an agent from the browser + prompt + (streaming) response + approval. */
  gnl?: StudioAgentRunner;
  /** If given, the Memory/Threads view works. */
  memory?: StudioMemory;
  /** If `memory` isn't given and reader is a writable Journal, derives StudioMemory from it (CLI/dev default). */
  memoryFactory?: (reader: Journal) => StudioMemory;
  /** If given, the Workflows view works. */
  workflows?: StudioWorkflows;
  /** Per-workflow INPUT metadata (shows expected parameters + an example in the Workflows view). Key = workflow name. */
  workflowInputs?: Record<string, { schema?: unknown; example?: unknown; description?: string }>;
  /** If given, the Scorers view works (run scoring in the Inspector). */
  scorers?: StudioScorers;
  /** If given, the Evals view works (dataset list + run suite). */
  datasets?: StudioDatasets;
  /** If given, the MCP Servers view works. */
  mcp?: StudioMcpServer[];
  /** true → the A2A Networks view (agent-to-agent call edges are extracted from the journal). */
  a2a?: boolean;
  /** If given, the Queue/Jobs view works. */
  queue?: StudioQueue;
  /** If given, the Cache view works (@gnldev/cache hit/miss ratio + manual invalidate). */
  cache?: StudioCache;
  /** If given, the Knowledge (vector search) view works. */
  vectors?: StudioVectors;
  /** Managed workflow store — if not given, a writable journal is used (create/edit/delete). */
  workflowStore?: StudioWorkflowStore;
  /**
   * Optional user management (a PAID feature — the contract lives here, the implementation lives in
   * @gnldev/auth-ee `createJournalUserStore`). If given, the Studio "Users" view + /users endpoints are enabled.
   * The `token` returned on creation is shown in the UI ONCE (the server never stores it in plaintext).
   */
  users?: StudioUserStore;
  /** Compiler to run a managed workflow with the real engine (@gnldev/studio/workflow → compileManagedWorkflow). */
  compileWorkflow?: CompileWorkflowFn;
  /**
   * Optional auth (opt-in). If not given, all endpoints are open. Accepts either the backward-compatible
   * `StudioAuth` {read,write} or an `AuthProvider` (free @gnldev/auth `roleAuth` or paid @gnldev/auth-ee).
   */
  auth?: StudioAuth | AuthProvider;
  /**
   * DELIBERATE opt-in to run Studio without a provider in production. Auth stays opt-in; but calling
   * CreateStudioApi/createStudioApp without `auth` under NODE_ENV=production THROWS at setup — silent
   * Fail-open was removed (audit #2). Set this flag to true if open access is really intended.
   * Outside production: just a single console.warn on the first request.
   */
  allowOpenAccess?: boolean;
  /**
   * Opt-in multi-org support (v1 = READ-ONLY audit): if an org resolves (default: the `x-gnl-org`
   * Header), the entire read surface (runs/state/diff/trace/metrics/threads) is scoped to that org via
   * WithOrg. In an org context, WRITES (POST/PATCH/DELETE) return 403 — since the runner/resume are tied
   * To the caller's gnl instance, a half-scoped write would create data confusion; use @gnldev/server's
   * `org` option for the write path (the option name is KEPT for consistency with @gnldev/server). A request
   * Without an org runs in the shared space.
   */
  org?: {
    /**
     * Takes a web `Request`, not a Hono `Context` — the last place this package's public surface
     * Leaked its own HTTP library. A host that mounts the handler from Express or Fastify has a
     * Request, never a Context, so the old signature made this option unusable exactly where the
     * Fetch handler was supposed to open the door.
     */
    resolve?: (req: Request) => string | undefined | Promise<string | undefined>;
  };
  /**
   * Eval gate (governance): this dataset suite runs BEFORE an agent is promoted; if ANY aggregate score
   * Fails to clear minAvg (default 0.5), the promote is rejected with 412. The gate decision
   * (passed/failed + aggregate) is always logged to audit. Requires the `datasets` option.
   */
  evalGate?: { datasetId: string; minAvg?: number };
  /**
   * Retention policy (POST /retention/sweep defaults): runs whose last activity is older than
   * OlderThanMs are deleted. Suspended and timestamp-less runs are always preserved (keepSuspended=false
   * Includes suspended ones in the sweep too). Sweeping is only triggered on request (the host can wire it to cron).
   */
  retention?: { olderThanMs: number; keepSuspended?: boolean };
  /**
   * Org budgets (GET /organizations): an org's limit is `perOrg[id] ?? default`; exceeded =
   * (if usdLimit is set, costUsd>usdLimit) || (if tokenLimit is set, tokens>tokenLimit).
   */
  budgets?: { default?: { usdLimit?: number; tokenLimit?: number }; perOrg?: Record<string, { usdLimit?: number; tokenLimit?: number }> };
  /**
   * Alert webhook: if defined, a SINGLE POST is fired for (1) an org that exceeds its budget and
   * (2) each tool call awaiting approval (via a first-write-wins `__alert__` marker; webhook errors are
   * Swallowed — never breaks the main flow). Payload.type: 'budget-exceeded' | 'approval-pending'.
   */
  alerts?: { webhook?: string };
  /**
   * W5 regression: converts POST /runs/:id/regression body.model (a 'provider/model' spec) to a real
   * Model. If not given, @gnldev/durable's `resolveModel` is used (dynamically imports the relevant provider
   * Package → a real API call). Provide this on hosts with a test/mock model store.
   */
  regressionModel?: (spec: string) => Promise<unknown> | unknown;
  /**
   * OTEL export (host-provided): the UI/client NEVER sends data to an arbitrary endpoint — the host
   * Itself CALLS @gnldev/otel's `exportRunToOtlp` with its configured target (Langfuse/Honeycomb/Datadog/
   * Collector) + auth (API key); Studio only TRIGGERS it (POST /runs/:id/otel-export). If not given,
   * The route returns 501 and the button (capabilities.otelExport) is hidden.
   */
  otelExport?: (runId: string) => Promise<{ ok: boolean; target?: string; error?: string }>;
}

/** createStudioApp additionally takes the admin HTML's API base (apiBase). */
export interface StudioAppOptions extends StudioApiOptions {
  /** API prefix the admin HTML fetches against. Depending on mount location: '' (same-origin) or '/studio'. */
  apiBase?: string;
}

function isReader (x: any): x is JournalReader {
  return typeof x?.listRuns === 'function' && typeof x?.readRun === 'function';
}

/**
 * **Studio API** (JSON only, no UI). Mount it on your own app — `app.mount('/studio/api', createStudioApi(...))`
 * On Hono, `toNodeHandler(...)` anywhere else — auth-gate it (viewer/admin), use it programmatically.
 * NOT `app.route()`: that takes a Hono sub-app and unpacks its routes, and what comes out of here is a
 * Fetch handler. Routes are prefix-independent: /capabilities, /runs, /runs/:id, ...
 */
function studioApiApp (input: JournalReader | StudioApiOptions): Hono {
  const opts: StudioApiOptions = isReader(input) ? { reader: input } : input;
  const { reader: rawReaderIn, resume, compensate, chat, gnl, memory, workflows, scorers, datasets, mcp, a2a, queue, cache, vectors, workflowInputs, workflowStore: _wfStoreOpt, compileWorkflow, auth } = opts;
  // The host may hand back `storage.runs` (a RunJournal → Page) rather than a bridged reader — the
  // README's quickstart does exactly that. Every listRuns consumer below expects the array contract.
  const rawReader = asReaderJournal(rawReaderIn as object) as typeof rawReaderIn;
  const app = new Hono();

  // Opt-in auth: an AuthProvider (free roleAuth / paid @gnldev/auth-ee) or the backward-compatible {read,write}.
  // If there's no provider, endpoints are open; in production that's only possible with allowOpenAccess: true
  // (otherwise makeGate throws at setup), and outside production it's warned once. Since the org middleware
  // Needs the identity-bound org (Principal.orgId), the gate is set up HERE, before the middleware.
  const authProvider = normalizeAuth(auth);
  const { allow, allowP, deny } = makeGate(authProvider, { allowOpenAccess: opts.allowOpenAccess });
  // RBAC (fine-grained permissions) is a PAID capability. When ON, allowP matches the exact permission
  // Against the principal's effective permissions; the permission catalog surface is also gated on this.
  // When OFF (free tier), allowP transparently reduces to read/write → the coarse legacy behavior.
  const rbacEnabled = authProvider?.capabilities?.().rbac === true;
  // STRICT multi-org model = PAID gate: ON only when the auth provider (paid @gnldev/auth-ee, valid
  // License) reports the `multiOrganization` capability. When ON, an org-less identity is NO LONGER the
  // All-seeing operator by default — it must carry the EXPLICIT `platform-admin` grant (scope:
  // 'platform'); otherwise it is fail-closed (403 on org data + org management). When OFF (free tier /
  // Host-provided `opts.org` without a paid license / no auth) behavior is preserved EXACTLY: an
  // Org-less identity is the legacy operator that sees & manages everything. NOTE: this is deliberately
  // NARROWER than `multiOrganizationEnabled` below (which also turns on for a bare `opts.org`) — the
  // Strict fail-closed is a paid-only behavior change, gated on the license capability alone.
  const strictMultiOrg = authProvider?.capabilities?.().multiOrganization === true;
  /**
   * Strict-model "operator" check for PLATFORM (cross-org) actions. Returns a 403 Response if the
   * Caller may NOT act platform-wide, else undefined.
   *  • org-bound identity → NEVER a platform actor (its own `orgBoundMsg` is preserved for back-compat).
   *  • strict mode + org-less WITHOUT the platform-admin grant → fail-closed 403.
   *  • free mode + org-less → allowed (legacy operator).  • platform-admin → allowed.
   */
  const requirePlatformAdmin = (c: Context, orgBoundMsg: string): Response | undefined => {
    const p = principalOf(c.req.raw);
    if (p?.orgId) return c.json({ error: orgBoundMsg }, 403);
    if (strictMultiOrg && !isPlatformAdmin(p)) {
      return c.json({ error: 'platform-admin required (fail-closed: no org scope and no platform-admin grant)' }, 403);
    }
    return undefined;
  };

  // Multi-org (v1 read-only): the org middleware stores it in ALS; on every call `reader` delegates to
  // The view scoped to the current org. A request without an org uses the raw reader. ALS is ALWAYS set
  // Up (not ONLY gated by opts.org): the identity-bound org (Principal.orgId) must scope the read surface
  // Even if opts.org isn't given (a contract from types.ts — see the middleware below).
  const orgALS = new AsyncLocalStorage<string>();
  const orgViews = new Map<string, JournalReader>();
  function scopedNow (): JournalReader {
    const org = orgALS.getStore();
    if (!org) return rawReader;
    let v = orgViews.get(org);
    if (!v) {
      v = withOrg(rawReader as unknown as Journal, org) as unknown as JournalReader;
      orgViews.set(org, v);
    }
    return v;
  }
  const reader: JournalReader = {
    listRuns: () => scopedNow().listRuns(),
    readRun: (id: string) => scopedNow().readRun(id),
    // The writable surface is only bridged if the raw reader supports it (so writable detection stays intact).
    ...(typeof (rawReader as any).get === 'function' ? { get: (k: string) => (scopedNow() as any).get(k) } : {}),
    ...(typeof (rawReader as any).put === 'function' ? { put: (k: string, v: unknown) => (scopedNow() as any).put(k, v) } : {}),
    ...(typeof (rawReader as any).putIfAbsent === 'function' ? { putIfAbsent: (k: string, v: unknown) => (scopedNow() as any).putIfAbsent(k, v) } : {}),
    ...(typeof (rawReader as any).listKeys === 'function' ? { listKeys: (p: string) => (scopedNow() as any).listKeys(p) } : {}),
    // DeletePrefix is bridged too (purge/retention call it via `rw`); since ALS is never set up on the
    // Write path (see the middleware), scopedNow() always falls through to the raw journal — behavior unchanged.
    ...(typeof (rawReader as any).deletePrefix === 'function' ? { deletePrefix: (p: string) => (scopedNow() as any).deletePrefix(p) } : {}),
    // P1.6 getCounters bridged the same way — GET /metrics reads the materialized
    // Per-org metrics counters (readMetricsSummary) through this SAME org-scoped accessor, so the
    // Isolation guarantee (withOrg prefixing) automatically covers it, same as every other bridge here.
    ...(typeof (rawReader as any).getCounters === 'function' ? { getCounters: (k: string) => (scopedNow() as any).getCounters(k) } : {}),
    // P1.6b: getMany bridged the SAME way — withOrg mirrors it 1:1 with the underlying journal (every
    // Key inside is prefixed, just like get/put), so a plain delegation is safe here too.
    ...(typeof (rawReader as any).getMany === 'function' ? { getMany: (ks: string[]) => (scopedNow() as any).getMany(ks) } : {}),
    // P1.6b: countRunsByStatus is NOT bridged 1:1 in withOrg (see organization.ts — an org-scoped view
    // Would otherwise leak every organization's counts, since the engine-level aggregate has no per-org
    // Filter). So unlike every other bridge here, this one uses optional chaining on the DELEGATE call
    // (not just the setup-time typeof check) — under an active org, `scopedNow()` returns a view that
    // Genuinely lacks the method, and the call must resolve to `undefined` (→ GET /metrics falls back to
    // Its listRuns-based count) rather than throwing.
    ...(typeof (rawReader as any).countRunsByStatus === 'function'
      ? { countRunsByStatus: () => (scopedNow() as any).countRunsByStatus?.() }
      : {}),
    // API-01: listRunsPaged bridged the same way as every other optional capability above — withOrg
    // ALREADY handles org isolation for it (walks the underlying mixed-org pages and strips/filters by
    // Prefix, see organization.ts's own listRunsPaged bridge), so a plain delegation through
    // ScopedNow() is safe here too, same as listRuns/readRun.
    ...(typeof (rawReader as any).listRunsPaged === 'function'
      ? { listRunsPaged: (q: any) => (scopedNow() as any).listRunsPaged(q) }
      : {}),
  } as JournalReader;

  // The middleware is only set up if opts.org (header-based resolution) OR an auth provider (which can
  // Produce an identity-bound org) exists; if neither exists, no request is scoped (existing shared behavior).
  if (opts.org || authProvider) {
    // Header-based resolution: `x-gnl-org`.
    const resolveOrg = opts.org?.resolve ?? ((req: Request) => req.headers.get('x-gnl-org') ?? undefined);
    app.use('*', async (c, next) => {
      // Header-based org resolution only kicks in if opts.org is EXPLICITLY given (a header never implies
      // A non-opt-in org); the identity-bound org is always valid whenever an auth provider exists.
      const requested = opts.org ? await resolveOrg(c.req.raw) : undefined;
      // An identity-bound org (Cred.orgId → Principal.orgId) OVERRIDES the header: if the bound identity
      // Requests a different org, 403 — org scope is based on identity, not a spoofable header.
      const principal = authProvider ? await authProvider.authenticate(c.req.raw) : null;
      const bound = principal?.orgId;
      // STRICT (EE multi-org) FAIL-CLOSED NET: an AUTHENTICATED identity with no org binding AND no
      // Explicit platform-admin grant may NOT reach org data/management surfaces — without this, an
      // Unbound principal would fall through unscoped and read the whole root journal (the accidental
      // Super-admin bug). `/me` + `/capabilities` are exempt so a denied caller can still learn its own
      // Scope and the auth mode. principal === null (no token) is NOT touched here → the per-endpoint
      // Gate returns the correct 401 (unauthenticated) instead of a misleading 403. Free mode: skipped
      // Entirely (strictMultiOrg=false) → behavior unchanged.
      if (
        strictMultiOrg && principal && !bound && !isPlatformAdmin(principal) &&
        !c.req.path.endsWith('/me') && !c.req.path.endsWith('/capabilities')
      ) {
        return c.json({ error: 'access denied: no org scope and no platform-admin grant (fail-closed)' }, 403);
      }
      if (bound && requested && requested !== bound) {
        return c.json({ error: `org mismatch: identity is bound to org '${bound}'` }, 403);
      }
      // An identity-bound org ONLY scopes the READ (GET) surface. Management writes (fork/resume/
      // Policy/budget PUT) run against the root journal and are not org-scoped → a bound admin can still
      // Write (otherwise binding would lock out all Studio management). On non-GET, an org can only be
      // Requested via an EXPLICIT header, and that's rejected by the v1 read-only rule.
      const org = c.req.method === 'GET' ? (bound ?? requested) : requested;
      if (!org) return next();
      if (org.includes(':')) return c.json({ error: "invalid org: cannot contain ':'" }, 400);
      if (c.req.method !== 'GET') {
        return c.json({ error: 'writes are not supported in an org context (v1 read-only audit) — use @gnldev/server\'s org option for writes' }, 403);
      }
      await orgALS.run(org, () => next());
    });
  }

  const rw = reader as Partial<Journal> & JournalReader;
  const writable = typeof rw.get === 'function' && typeof rw.put === 'function';
  // If memory isn't given and reader is a writable Journal, derive it from the factory (CLI/dev default).
  const resolvedMemory: StudioMemory | undefined =
    memory ?? (opts.memoryFactory && writable ? opts.memoryFactory(reader as unknown as Journal) : undefined);

  const WF_STORE_PRE = '__studio_wf__';
  const resolvedWfStore: StudioWorkflowStore | undefined = _wfStoreOpt ?? (
    writable && rw.listKeys && rw.get && rw.put
      ? {
        async list () {
          const keys = await rw.listKeys!(WF_STORE_PRE).catch(() => [] as string[]);
          return (await Promise.all(keys.map((k) => rw.get!(k).catch(() => null)))).filter(Boolean) as WorkflowDef[];
        },
        async get (name: string) {
          return ((await rw.get!(WF_STORE_PRE + name).catch(() => undefined)) ?? undefined) as WorkflowDef | undefined;
        },
        async set (def: WorkflowDef) { await rw.put!(WF_STORE_PRE + def.name, def); },
        async delete (name: string) { await rw.put!(WF_STORE_PRE + name, null); },
      }
      : undefined
  );

  // Can a managed workflow run with the REAL engine? (compiler + agent.run + writable journal)
  const canRunManaged = !!resolvedWfStore && !!compileWorkflow && !!gnl?.run && writable && !!rw.get;

  /** Compiles a managed WorkflowDef and runs it with the SAME engine as code workflows (parity with registry.runWorkflow).
   * P0.4 `resume` forwards typed HITL payloads to wf.runResumable (only meaningful
   *  When the compiled workflow supports it); a `{status:'canceled'}` result maps into `canceled` the
   * SAME way `suspended`/`paused` already do (mirrors registry.ts's runWorkflow mapping). */
  async function runManaged (name: string, input: unknown, runId: string, maxSteps?: number, dryRun?: boolean, overridesFor?: (name: string) => Promise<{ model?: string; system?: string } | undefined>, resume?: Record<string, unknown>): Promise<{ runId: string; output?: unknown; suspended: boolean; paused?: boolean; canceled?: boolean; dryRun?: boolean; stepId?: string; reason?: unknown; steps: { id: string; kind: string; output: unknown }[] }> {
    const def = await resolvedWfStore!.get(name);
    if (!def) throw new Error(`workflow '${name}' not found`);
    // Dry-run: the real agent is NEVER CALLED (deterministic stub response) + the journal is TEMPORARY
    // Memory → zero LLM cost, zero persistent trace; validates flow/template/input wiring end-to-end.
    const runAgent = dryRun
      ? async (agentName: string, o: { prompt?: string }) => ({ text: `[dry-run] ${agentName}: ${String(o.prompt ?? '').slice(0, 120)}` })
      : async (n2: string, o: { runId: string; prompt?: string }) => {
          const mo = overridesFor ? await overridesFor(n2) : undefined; // workflow steps also use the promoted version (based on the caller's org)
          return gnl!.run!(n2, { ...o, ...(mo?.model ? { model: mo.model } : {}), ...(mo?.system != null ? { system: mo.system } : {}) });
        };
    const wf = compileWorkflow!(def, runAgent as any, input);
    const mem = dryRun ? new Map<string, unknown>() : null;
    const journal: Journal = mem
      ? ({ get: async (k: string) => mem.get(k), put: async (k: string, v: unknown) => { mem.set(k, v); } } as unknown as Journal)
      : (rw as unknown as Journal);
    const ctx = { runId, journal };
    let output: unknown; let suspended = false; let paused = false; let canceled = false; let stepId: string | undefined; let reason: unknown;
    if (wf.runResumable) {
      const rOpts = {
        ...(maxSteps != null ? { maxSteps } : {}),
        ...(resume ? { resume } : {}),
      };
      const r = await (wf.runResumable as any)(input, ctx, Object.keys(rOpts).length ? rOpts : undefined);
      if (r.status === 'suspended') { suspended = true; stepId = r.stepId; reason = r.reason; }
      else if (r.status === 'paused') { paused = true; stepId = r.stepId; }
      else if (r.status === 'canceled') { canceled = true; stepId = r.stepId; reason = r.reason; }
      else output = r.output;
    } else {
      output = await wf.run(input, ctx);
    }
    const steps: { id: string; kind: string; output: unknown }[] = [];
    for (const s of wf.build()) steps.push({ id: s.id, kind: 'agent', output: await ctx.journal.get(`${runId}:wf:${s.id}`) });
    return { runId, output, suspended, paused, canceled, ...(dryRun ? { dryRun: true } : {}), stepId, reason, steps };
  }

  // ── Governance: audit log ────────────────────────────────────────
  // Every successful WRITE action is logged to the journal as an `__audit__` entry (appendLog).
  // Best-effort: only on a writable journal; errors are SWALLOWED — never breaks the main flow.
  type AuditAction =
    | 'approve' | 'deny' | 'fork'
    | 'thread.rename' | 'thread.delete' | 'thread.truncate'
    | 'workflow.create' | 'workflow.update' | 'workflow.delete'
    | 'tool.exec' | 'agent.run'
    | 'agent.version' | 'agent.promote' | 'agent.gate' | 'agent.delete' | 'agent.version-delete'
    | 'run.purge' | 'run.regression' | 'run.compensate' | 'run.cancel' | 'retention.sweep' | 'policy.update'
    | 'org.budget' | 'org.create' | 'org.delete'
    | 'user.create' | 'user.delete' | 'user.revoke' | 'user.update'
    | 'job.retry' | 'cache.invalidate' | 'run.otel-export' | 'workflow.cancel'
    | 'agent.approve' | 'agent.block';
  /**
   * Actor attribution — priority: an authenticated principal.id (e.g. a basic-auth user) > the
   * X-gnl-actor header (the PERSON behind a shared token — cooperative attribution, like a git author) >
   * Role:<role> > anon. A token-only cred has no principal.id → the header is kept (so teams can keep a
   * Per-person trail); if there's no header either, it falls back to role:<role>. This makes spoofing
   * Pointless (token holders can already impersonate each other) while still preserving person-level
   * Info. Extracted so the agent-registry approve/block endpoints can pass it as approveAgent/blockAgent's
   * `by` argument without duplicating the derivation.
   */
  function actorOf (c: Context): string {
    const p = principalOf(c.req.raw);
    return p?.id ?? c.req.header('x-gnl-actor') ?? (p?.roles[0] ? `role:${p.roles[0]}` : 'anon');
  }
  async function audit (c: Context, action: AuditAction, target: string, detail?: unknown): Promise<void> {
    if (!writable) return;
    try {
      const actor = actorOf(c);
      const p = principalOf(c.req.raw);
      // Org context — the audit "org" column (see Audit.tsx it.org):
      //  (1) the bound identity's orgId (if any) → which org the work was done on behalf of.
      //  (2) for operator actions that MANAGE an org (org.create/delete/budget), the actor is unbound (no orgId),
      //      But the relevant org IS ALREADY the target → use target so the column doesn't stay empty.
      //  (3) user.create: the new user's org is carried in detail.orgId.
      const orgFromTarget = action === 'org.create' || action === 'org.delete' || action === 'org.budget' ? target : undefined;
      const orgFromDetail = action === 'user.create' && detail && typeof detail === 'object'
        ? (detail as { orgId?: string }).orgId : undefined;
      const org = p?.orgId ?? orgFromTarget ?? orgFromDetail;
      await appendLog(rw as Journal, '__audit__', { actor, action, target, ...(org ? { org } : {}), ...(detail !== undefined ? { detail } : {}) });
    } catch { /* audit is best-effort — swallow */ }
  }

  // ── Managed agent versions: draft → promote/rollback (EE governance wave 2) ─────
  // Each agent has a single journal record: version list + active (prod) version number. Versions are
  // IMMUTABLE (a new record = a new version); promote only moves the 'active' pointer → rollback = promoting
  // An older version. Every change is logged to audit.
  const AGENT_STORE_PRE = '__studio_agent__:';
  // Org record prefix: orgs that were EXPLICITLY created (may not have any runs yet) are kept here.
  const ORG_PRE = '__org__:';
  const agentStoreEnabled = writable && typeof rw.listKeys === 'function';
  type AgentStore = {
    list(): Promise<ManagedAgentRecord[]>;
    get(name: string): Promise<ManagedAgentRecord | undefined>;
    put(rec: ManagedAgentRecord): Promise<void>;
    /** Present if the journal supports deletePrefix — PERMANENTLY deletes the agent record (with ALL its
     *  Versions) (as OPPOSED TO the workflow store's tombstone/`put(key,null)` pattern — a real delete).
     * Otherwise the field is absent entirely (the caller must return 501, see DELETE /managed-agents/:name). */
    delete?(name: string): Promise<void>;
  };
  /** Agent version store (list/get/put[/delete]) over the given journal. Requires listKeys+get+put. */
  function makeAgentStore(j: Partial<Journal>): AgentStore | undefined {
    if (!agentStoreEnabled || typeof j.listKeys !== 'function' || typeof j.get !== 'function' || typeof j.put !== 'function') return undefined;
    const lk = j.listKeys.bind(j); const g = j.get.bind(j); const p = j.put.bind(j);
    const dp = typeof j.deletePrefix === 'function' ? j.deletePrefix.bind(j) : undefined;
    return {
      async list() {
        const keys = await lk(AGENT_STORE_PRE).catch(() => [] as string[]);
        const out: ManagedAgentRecord[] = [];
        for (const k of keys) {
          const rec = (await g(k).catch(() => null)) as ManagedAgentRecord | null;
          if (rec && typeof rec === 'object' && Array.isArray(rec.versions)) out.push(rec);
        }
        return out.sort((a, b) => a.name.localeCompare(b.name));
      },
      get: async (name) => ((await g(AGENT_STORE_PRE + name).catch(() => undefined)) ?? undefined) as ManagedAgentRecord | undefined,
      put: async (rec) => { await p(AGENT_STORE_PRE + rec.name, rec); },
      ...(dp
        ? {
          async delete(name: string) {
            const key = AGENT_STORE_PRE + name;
            // DeletePrefix is RANGE-based (key >= prefix && key < prefix+'￿') — in our key format
            // (`AGENT_STORE_PRE + name`, with NO trailing separator) `name` can be an EXACT string
            // Prefix of another agent's name (e.g. deleting 'dd' also catches 'dd2' in the range —
            // See run purge using a `${runId}:` separator against the same class of bug, retention.ts).
            // First read the colliding sibling keys, write them back after the sweep — only the
            // EXACTLY matching record is permanently deleted.
            const hits = await lk(key).catch(() => [] as string[]);
            const siblings = hits.filter((k) => k !== key);
            const preserved = await Promise.all(siblings.map(async (k) => [k, await g(k).catch(() => null)] as const));
            await dp(key);
            for (const [k, v] of preserved) if (v != null) await p(k, v as ManagedAgentRecord);
          },
        }
        : {}),
    };
  }
  /**
   * ORG-SCOPED agent version store: a bound identity (Principal.orgId) only manages/sees/promotes ITS OWN
   * Org's versions (via the withOrg prefix); an unbound operator manages the root (shared) namespace.
   * Note: runtime enforcement (@gnldev/server's actual traffic) is a separate layer — this store brings org
   * Isolation to Studio playground/workflow runs and to management/visibility.
   */
  function agentStoreFor(c: Context): AgentStore | undefined {
    // Priority: identity-bound org (Principal.orgId) > org resolved from header/ALS (GET only; the read
    // Context scoped by the org middleware) > root (shared) namespace. Without the former, header-based
    // Org resolution (when there's no auth binding) would make GET /managed-agents return the root store
    // For EVERY org (a leak) — see Phase 0.4.
    const bound = principalOf(c.req.raw)?.orgId ?? orgALS.getStore();
    const base = rawReader as unknown as Journal;
    const j = (bound ? (withOrg(base, bound) as unknown as Partial<Journal>) : (base as unknown as Partial<Journal>));
    return makeAgentStore(j);
  }

  /** If an active (promoted) managed version exists, returns its model/system override (per the caller's org).
   * An explicit user override (body.model/system) OVERRIDES the managed version (playground experimentation). */
  async function managedOverrides(name: string, c: Context): Promise<{ model?: string; system?: string } | undefined> {
    const store = agentStoreFor(c);
    if (!store) return undefined;
    const rec = await store.get(name);
    if (!rec || rec.active == null) return undefined;
    const v = rec.versions.find((x) => x.version === rec.active);
    return v ? { model: v.model, ...(v.system != null ? { system: v.system } : {}) } : undefined;
  }

  // Is multi-org ON? Only if the host gave org OR the auth provider reports multiOrganization (paid
  // @gnldev/auth-ee). Neither exists on the free tier → org surfaces are NEVER shown: it runs in a single
  // Implicit org, and the user is never aware multi-org exists.
  const multiOrganizationEnabled = !!opts.org || !!authProvider?.capabilities?.().multiOrganization;

  // PUBLIC (exempt from the read gate): lets the UI discover the auth mode + premium capabilities (sso/rbac...) BEFORE login.
  app.get('/capabilities', (c) =>
    c.json({
      resume: !!resume,
      compensate: !!compensate,
      chat: !!chat,
      org: !!opts.org,
      fork: !!resume && writable,
      playground: !!gnl,
      stream: !!gnl?.stream,
      tools: !!gnl?.listTools,
      toolExec: !!gnl?.runTool,
      toolExecDurable: !!gnl?.runTool && !!gnl?.toolExecDurable,
      memory: !!resolvedMemory,
      workflows: !!gnl?.listWorkflows || !!workflows,
      workflowExec: !!gnl?.runWorkflow || canRunManaged,
      scorers: !!scorers,
      datasets: !!datasets,
      mcp: !!mcp?.length,
      a2a: !!a2a,
      queue: !!queue,
      // "Retry" action in the Jobs view: on if the host implemented queue.retry (RBAC is also
      // Enforced server-side on every request via allow(c,'write') — this is only button visibility).
      queueManage: !!queue?.retry,
      // Cache view (@gnldev/cache hit/miss + size): on if the host gave a cache instance.
      cache: !!cache,
      // Manual invalidate button: on if the host implemented cache.invalidate (RBAC is again enforced
      // Server-side via allow(c,'write') — this is only button visibility, same pattern as queueManage).
      cacheManage: !!cache?.invalidate,
      // Scheduler (@gnldev/scheduler trigger introspection): the journal is READ-ONLY (see GET /scheduler/triggers),
      // It needs neither a separate opts.scheduler surface nor a running instance — writable + listKeys
      // Is enough (same auto-detection pattern as audit/organizations; returns an empty list if the host doesn't use @gnldev/scheduler).
      scheduler: writable && typeof rw.listKeys === 'function',
      knowledge: !!vectors,
      workflowManage: !!resolvedWfStore,
      // Governance: approval queue (needs resume), audit + organizations (need a writable journal + listKeys).
      approvals: !!resume,
      audit: writable && typeof rw.listKeys === 'function',
      // Agent approval registry (governance): review/approve/block code-defined agents recorded by
      // @gnldev/server's boot-time recording (see GET/POST /agents/registry* below) — SAME auto-detection
      // Pattern as audit/scheduler, no separate host option needed.
      agentRegistry: writable && typeof rw.listKeys === 'function',
      // Compliance reports: findings produced in this run by the pii/moderation/prompt-injection
      // Processors (`${runId}:procreport:...`) — the SAME auto-detection pattern as audit/scheduler: writable +
      // ListKeys is enough, no separate host option is NEEDED (returns an empty list if the host doesn't use a processor).
      processors: writable && typeof rw.listKeys === 'function',
      // The organizations surface is shown ONLY when multi-org is on (paid/opt-in). Hidden on free.
      organizations: multiOrganizationEnabled && writable && typeof rw.listKeys === 'function',
      // Budget management lives in the org panel → also depends on multi-org.
      budgetManage: multiOrganizationEnabled && writable,
      // Create/delete org (multi-org + writable + listKeys). Delete additionally needs deletePrefix (checked at the endpoint).
      orgManage: multiOrganizationEnabled && writable && typeof rw.listKeys === 'function',
      // User management (paid): on if the host gave a userStore.
      userManage: !!opts.users,
      agentVersions: agentStoreEnabled,
      evalGate: !!(opts.evalGate && datasets),
      purge: writable && typeof (rw as Partial<Journal>).deletePrefix === 'function',
      // W5: replay-based regression ("re-run" + decision-point diff). replayRun needs a writable
      // Journal since it writes a new run; diffing two EXISTING runs (GET) doesn't depend on that.
      regression: writable,
      policy: writable,
      retention: !!opts.retention && writable && typeof (rw as Partial<Journal>).deletePrefix === 'function',
      // OTEL export button: on if the host gave opts.otelExport (RBAC is again enforced server-side
      // Via allow(c,'write') — this is only button visibility, same pattern as queueManage/cacheManage).
      otelExport: !!opts.otelExport,
      // D3-A: durable run cancel (POST /runs/:id/cancel) — writes cancelAgentRun's cross-worker flag.
      // Studio has no in-process AbortController registry (unlike @gnldev/server's P0.3 in-flight abort),
      // So this is the durable-flag path ONLY: a canceled run stops at its NEXT fresh model step,
      // Wherever it's running. Needs nothing but a writable journal (cancelAgentRun only get/put's a flag).
      runCancel: writable,
      // D3-A: durable workflow-run cancel (POST /workflows/runs/:id/cancel) — mirrors @gnldev/server's
      // P0.4 /workflows/runs/:id/cancel (reimplemented inline, see the route's own JSDoc for why).
      // Same capability gate as the suspended-runs registry itself (GET /workflows/runs) needs.
      workflowRunCancel: writable && typeof rw.listKeys === 'function',
      // Auth: if a provider exists the UI requires login; provider.capabilities() unlocks premium surfaces.
      authRequired: !!authProvider,
      ...(authProvider?.capabilities?.() ?? {}),
    }),
  );
  // S4 pagination: if ?limit= is given, returns a Page envelope {items,nextCursor,total} (newest first);
  // A call without the parameter stays a backward-compatible flat array (existing consumers don't break).
  // API-09: optional status/agent/q filters — SAME parameter names as @gnldev/server's GET /runs (see
  // Packages/server/src/index.ts). Only honored together with `limit` (a bare filter with no `limit`
  // Falls through to the unfiltered flat array below, same as today — matches the "no params → identical
  // To today" backward-compat contract; the studio-ui client always sends `limit`, so this never bites it).
  app.get('/runs', async (c) => {
    if (!(await allow(c.req.raw, 'read'))) return deny(c.req.raw, 'read');
    const limitRaw = c.req.query('limit');
    if (limitRaw === undefined) return c.json(await reader.listRuns());
    const limit = Math.min(Math.max(Math.floor(Number(limitRaw)) || 0, 1), 500);
    const start = Math.max(Math.floor(Number(c.req.query('cursor'))) || 0, 0);
    const statusRaw = c.req.query('status');
    if (statusRaw != null && statusRaw !== 'completed' && statusRaw !== 'suspended' && statusRaw !== 'failed' && statusRaw !== 'running') {
      return c.json({ error: `invalid status '${statusRaw}' (expected 'completed', 'suspended', 'failed' or 'running')` }, 400);
    }
    const status = statusRaw as 'completed' | 'suspended' | 'failed' | 'running' | undefined;
    const agent = c.req.query('agent') || undefined;
    const q = c.req.query('q') || undefined;
    // API-01/API-09: prefer the engine push-down (listRunsPaged) — avoids materializing EVERY run (see
    // Journal.ts JournalReader.listRunsPaged / postgres-storage.ts's indexed `ORDER BY ... LIMIT`)
    // Just to slice out one page. listRunsPaged's own order is ASCENDING (oldest-first, mirroring the
    // Underlying `ORDER BY created_at`), but studio's contract here is "newest first" (see
    // Studio-ui/api.ts's RunsPage type) — so the requested newest-first window [start, start+limit) is
    // Converted into the matching ascending-order range using `total` (countRunsByStatus's push-down
    // Aggregate, the SAME source GET /metrics already uses below) and only that small (≤limit-sized)
    // Slice is reversed locally, never the whole table. Falls back to the legacy full-scan+reverse when
    // Either capability is missing (a bare custom JournalReader, or an adapter without a cheap status
    // Aggregate — e.g. Redis, see redis-storage.ts), when total couldn't be read, or (API-09) when an
    // `agent`/`q` filter is active: countRunsByStatus has no per-agent/per-substring count, so there is
    // No cheap way to learn the FILTERED total upfront (needed for the newest-first↔ascending conversion
    // Above) — those filters fall through to the in-memory path below, no worse than the engine's own
    // Agent handling (postgres-storage.ts also full-scans for `agent` — there's no indexed column for it).
    if (agent === undefined && q === undefined && typeof reader.listRunsPaged === 'function' && typeof rw.countRunsByStatus === 'function') {
      // NOTE: unlike a normal optional-capability call, this can't be `rw.countRunsByStatus().catch(...)`
      // under an active org (see the reader bridge above + organization.ts: countRunsByStatus is
      // Deliberately NOT bridged per-org), the call resolves SYNCHRONOUSLY to `undefined` (not a
      // Rejected promise, via `scopedNow().countRunsByStatus?.()`), and `.catch` on `undefined` throws.
      let counted: Record<string, number> | undefined;
      try { counted = await rw.countRunsByStatus(); } catch { counted = undefined; }
      if (counted) {
        // API-09: total is the FILTERED count — countRunsByStatus's per-status breakdown already gives
        // It for free when `status` is set; unfiltered, sum every status (unchanged from before).
        const total = status ? (counted[status] ?? 0) : Object.values(counted).reduce((a, b) => a + b, 0);
        const ascEnd = Math.max(0, total - start);
        const ascStart = Math.max(0, ascEnd - limit);
        const items = ascEnd > ascStart
          ? (await reader.listRunsPaged({ limit: ascEnd - ascStart, cursor: String(ascStart), ...(status ? { status } : {}) })).items.reverse()
          : [];
        const next = start + limit;
        return c.json({ items, nextCursor: next < total ? String(next) : undefined, total });
      }
    }
    const all = await reader.listRuns();
    // API-09: status/agent/q filters applied server-side BEFORE reversing/slicing — `total` below
    // Therefore already reflects the FILTERED set, never the whole journal (the UI shows `total` in its
    // Search placeholder, and it must describe the same set as `items`).
    const needle = q?.toLowerCase();
    const filtered = all.filter((r) =>
      (status === undefined || r.status === status) &&
      (agent === undefined || r.agent === agent) &&
      (needle === undefined || r.runId.toLowerCase().includes(needle)),
    );
    const newestFirst = [...filtered].reverse(); // journal append order is ascending → reversed = newest first
    // ThreadId now comes from listRuns itself (every adapter surfaces it from the run's invisible `:input`
    // Entry in a SINGLE read, see journal.ts RunSummary.threadId) — no ADDITIONAL N+1 read happens here.
    const items = newestFirst.slice(start, start + limit);
    const next = start + limit;
    return c.json({ items, nextCursor: next < newestFirst.length ? String(next) : undefined, total: newestFirst.length });
  });
  app.get('/runs/:id', async (c) =>
    (await allow(c.req.raw, 'read')) ? c.json(await reader.readRun(decodeURIComponent(c.req.param('id')))) : deny(c.req.raw, 'read'),
  );

  // Materialized state at step N (reconstructState).
  app.get('/runs/:id/state', async (c) => {
    if (!(await allow(c.req.raw, 'read'))) return deny(c.req.raw, 'read');
    const id = decodeURIComponent(c.req.param('id'));
    const entries = await reader.readRun(id);
    const q = Number(c.req.query('step'));
    const step = Number.isFinite(q) ? q : entries.length;
    const seed = writable ? await rw.get!(`${id}:input`) : undefined;
    return c.json(reconstructState(entries, step, seed as any));
  });

  // Memory-context provenance (':memctx', frozen next to ':input' by durable's persistMemoryContext):
  // The frozen input says WHAT the model saw; this says WHERE each part came from — recall hits with
  // Similarity, recent-window count, OM observations, WM injection, echo-trim. `null` for runs
  // Without memory, pre-provenance runs, or a read-only journal — the UI renders that honestly as
  // "no provenance recorded", never as an error.
  app.get('/runs/:id/memory-context', async (c) => {
    if (!(await allow(c.req.raw, 'read'))) return deny(c.req.raw, 'read');
    if (!writable) return c.json({ context: null });
    const id = decodeURIComponent(c.req.param('id'));
    const ctx = await rw.get!(`${id}:memctx`).catch(() => undefined);
    return c.json({ context: ctx ?? null });
  });

  // Cost/token (getRunCost).
  app.get('/runs/:id/cost', async (c) => {
    if (!(await allow(c.req.raw, 'read'))) return deny(c.req.raw, 'read');
    return c.json(await getRunCost(reader, decodeURIComponent(c.req.param('id'))));
  });

  // Runtime scorer results: the registry (AgentConfig.scorers) and the `${runId}:proc:eval:<name>`
  // Records that scoreRun memoizes — the read surface for exactly-once scores.
  app.get('/runs/:id/scores', async (c) => {
    if (!(await allow(c.req.raw, 'read'))) return deny(c.req.raw, 'read');
    if (!writable || typeof rw.listKeys !== 'function') return c.json({ scores: {} });
    const id = decodeURIComponent(c.req.param('id'));
    const prefix = `${id}:proc:eval:`;
    const keys = await rw.listKeys!(prefix).catch(() => [] as string[]);
    const scores: Record<string, unknown> = {};
    for (const k of keys) {
      const rec = (await rw.get!(k).catch(() => undefined)) as { v?: unknown } | undefined;
      if (rec && typeof rec === 'object' && 'v' in rec) scores[k.slice(prefix.length)] = rec.v;
    }
    return c.json({ scores });
  });

  // Compliance reports: findings the pii-redactor/prompt-injection/moderation processors produced in
  // This run (`readProcessorReports` — @gnldev/durable, reads the `${runId}:procreport:...` prefix).
  // Empty list if the host doesn't use a processor / writable+listKeys is missing (SAME fallback as scores).
  app.get('/runs/:id/processors', async (c) => {
    if (!(await allow(c.req.raw, 'read'))) return deny(c.req.raw, 'read');
    if (!writable || typeof rw.listKeys !== 'function') return c.json({ reports: [] });
    const id = decodeURIComponent(c.req.param('id'));
    const reports = await readProcessorReports(rw as any, id).catch(() => []);
    return c.json({ reports });
  });

  // The run's guard incidents (duplicate guard / loop detection /
  // MaxToolCalls — warn/reflect/block/suspend) as queryable telemetry. Same optional-capability
  // Fallback as /processors: no listKeys → empty list (never an error).
  app.get('/runs/:id/incidents', async (c) => {
    if (!(await allow(c.req.raw, 'read'))) return deny(c.req.raw, 'read');
    if (!writable || typeof rw.listKeys !== 'function') return c.json({ incidents: [] });
    const id = decodeURIComponent(c.req.param('id'));
    const incidents = await readIncidents(rw as any, id).catch(() => []);
    return c.json({ incidents });
  });

  // Dynamic agent network trace (runNetwork): CAS-frozen routing decisions + step results —
  // The UI draws the dynamic tree (router → agent → result) from this. Nested run detail at /runs/net:<id>:<i>.
  app.get('/runs/:id/network', async (c) => {
    if (!(await allow(c.req.raw, 'read'))) return deny(c.req.raw, 'read');
    if (!writable || typeof rw.listKeys !== 'function') return c.json({ routes: [], steps: [] });
    const id = decodeURIComponent(c.req.param('id'));
    // Rw is Partial<Journal>; writable + listKeys was checked → the surface getNetworkTrace uses is complete.
    return c.json(await getNetworkTrace(rw as any, id).catch(() => ({ routes: [], steps: [] })));
  });

  // OTEL-like trace: durations from entries' ts + cost (for the waterfall).
  // Enrichment: tool spans are named via the toolCallId→toolName mapping and linked to the model step
  // That called them via `parent` (span index) → the UI draws a real nested tree.
  app.get('/runs/:id/trace', async (c) => {
    if (!(await allow(c.req.raw, 'read'))) return deny(c.req.raw, 'read');
    const id = decodeURIComponent(c.req.param('id'));
    const entries = await reader.readRun(id);
    const cost = await getRunCost(reader, id);
    const first = entries.find((e) => e.ts != null)?.ts ?? 0;
    const last = [...entries].reverse().find((e) => e.ts != null)?.ts ?? first;
    // ToolCallId → toolName from model steps' content (the journal's tool record has no name).
    const toolNames = new Map<string, string>();
    for (const e of entries) {
      if (e.kind !== 'model') continue;
      for (const p of ((e.value as any)?.content ?? []) as any[]) {
        if (p?.type === 'tool-call' && p.toolCallId) toolNames.set(p.toolCallId, p.toolName ?? 'tool');
      }
    }
    let lastModelIdx: number | null = null;
    let modelStep = 0;
    const spans = entries.map((e, i) => {
      const v: any = e.value;
      const start = e.ts ?? first;
      const end = entries[i + 1]?.ts ?? last;
      const base = { kind: e.kind, startMs: start - first, durationMs: Math.max(0, end - start) };
      if (e.kind === 'model') {
        lastModelIdx = i;
        return {
          ...base,
          name: 'llm.generate',
          step: modelStep++,
          parent: null as number | null,
          attrs: { model: v?.response?.modelId, finish: v?.finishReason, inTok: v?.usage?.inputTokens, outTok: v?.usage?.outputTokens },
        };
      }
      const toolCallId = e.key.slice(e.key.lastIndexOf(':tool:') + ':tool:'.length);
      return {
        ...base,
        name: toolNames.get(toolCallId) ?? 'tool.execute',
        parent: lastModelIdx,
        attrs: { status: v?.status, toolCallId },
      };
    });
    return c.json({ totalMs: last - first, cost, spans });
  });

  // Per-step diff: messages added between step N and N-1 + the pending delta (time-travel drill-down).
  app.get('/runs/:id/diff', async (c) => {
    if (!(await allow(c.req.raw, 'read'))) return deny(c.req.raw, 'read');
    const id = decodeURIComponent(c.req.param('id'));
    const entries = await reader.readRun(id);
    const step = Math.max(1, Number(c.req.query('step') ?? entries.length));
    const seed = writable ? await rw.get!(`${id}:input`) : undefined;
    const cur = reconstructState(entries, step, seed as any);
    const prev = reconstructState(entries, step - 1, seed as any);
    return c.json({ step, added: cur.messages.slice(prev.messages.length), pendingBefore: prev.pending, pendingAfter: cur.pending });
  });

  // Aggregate metrics (dashboard): run counts + total cost/tokens.
  // ── Governance endpoints: approval queue / audit / organizations ───────────────────
  // Approval queue (inbox): the pending tool approvals of ALL suspended runs in a single list.
  app.get('/approvals', async (c) => {
    if (!(await allow(c.req.raw, 'read'))) return deny(c.req.raw, 'read');
    const runs = await reader.listRuns();
    const items: { runId: string; toolCallId: string; toolName: string; args?: unknown; reason?: string }[] = [];
    for (const r of runs) {
      if (r.status !== 'suspended') continue;
      const entries = await reader.readRun(r.runId);
      // The sentinel in a suspended tool record carries args/reason → shows context in the inbox
      const meta = new Map<string, { args?: unknown; reason?: string }>();
      for (const e of entries) {
        const v: any = e.value;
        const sus = e.kind === 'tool' && v?.status === 'suspended' ? v?.output?.__gnl_suspend : undefined;
        if (sus?.toolCallId) meta.set(sus.toolCallId, { args: sus.args, reason: sus.reason });
      }
      const st = reconstructState(entries, entries.length);
      for (const pnd of st.pending) {
        items.push({ runId: r.runId, toolCallId: pnd.toolCallId, toolName: pnd.toolName, ...(meta.get(pnd.toolCallId) ?? {}) });
      }
    }
    // Approval webhook: the SAME pattern as the budget alert — a SINGLE POST per pending approval via a
    // First-write-wins __alert__ marker (webhook errors are swallowed, never breaks the inbox flow).
    // Lazy trigger: since the UI polls /approvals every 5s, a suspension is reported within ~5s.
    if (opts.alerts?.webhook && writable) {
      const rootRw = rawReader as Partial<Journal> & JournalReader;
      for (const it of items) {
        try {
          if ((await rootRw.get!(`__alert__:approval:${it.runId}:${it.toolCallId}`)) === undefined) {
            const payload = { type: 'approval-pending', ...it };
            await appendLog(rootRw as Journal, '__alert__', payload, `approval:${it.runId}:${it.toolCallId}`);
            await fetch(opts.alerts.webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }).catch(() => { });
          }
        } catch { /* alert is best-effort — swallow */ }
      }
    }
    return c.json({ items });
  });

  // Audit trail: the __audit__ log — NEWEST FIRST; exact-match action + substring q filters.
  // Org filter: a bound identity (Principal.orgId) sees ONLY its own context (?org= is ignored — it
  // Can't read anyone else's record); an unbound (operator) identity can optionally filter with ?org=.
  // NOTE: __audit__ lives in the ROOT (non-org-prefixed) journal → the raw `rawReader` is used instead
  // Of the ALS-scoped `rw` (otherwise a bound identity's GET would be scoped by the org middleware to a
  // Non-existent prefix like org:<id>:__audit__: and always return empty — see the rootRw pattern in /organizations).
  app.get('/audit', async (c) => {
    if (!(await allow(c.req.raw, 'read'))) return deny(c.req.raw, 'read');
    const rootRw = rawReader as Partial<Journal> & JournalReader;
    if (!writable || typeof rootRw.listKeys !== 'function') return c.json({ items: [] });
    const limit = Math.max(1, Math.min(1000, Number(c.req.query('limit') ?? 200)));
    const action = c.req.query('action');
    const q = c.req.query('q')?.toLowerCase();
    const bound = principalOf(c.req.raw)?.orgId;
    const org = bound ?? (c.req.query('org') || undefined);
    const logs = await listLog<{ actor: string; action: string; target: string; org?: string; detail?: unknown }>(rootRw as Journal, '__audit__');
    const items = logs
      .map((l) => ({ id: l.id, at: l.at, ...l.payload }))
      .filter((i) => !action || i.action === action)
      .filter((i) => !org || i.org === org)
      .filter((i) => !q || i.target.toLowerCase().includes(q) || i.actor.toLowerCase().includes(q))
      .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
      .slice(0, limit);
    return c.json({ items });
  });

  // Organizations: listed from `org:<id>:` prefixes + usage/cost + budget status (opts.budgets).
  // A SINGLE notification to opts.alerts.webhook on budget overrun (first-write-wins __alert__ marker).
  const ORG_KEY_PRE = 'org:';
  const listOrganizations = async (c: Context) => {
    if (!(await allow(c.req.raw, 'read'))) return deny(c.req.raw, 'read');
    if (!writable || typeof rw.listKeys !== 'function') return c.json({ organizations: [] });
    // The scan always happens on the ROOT journal (org: prefixes aren't visible in the org-scoped view);
    // An identity-bound org sees ONLY itself — the global list is open only to unbound (operator) identities.
    const rootRw = rawReader as Partial<Journal> & JournalReader;
    const keys = await rootRw.listKeys!(ORG_KEY_PRE).catch(() => [] as string[]);
    const bound = principalOf(c.req.raw)?.orgId;
    // Merge DISCOVERED orgs (with org:<id>: prefixed data) with EXPLICITLY REGISTERED ones (__org__:<id>) →
    // A newly created org with no runs yet also shows up in the list.
    const discovered = keys.map((k) => { const j = k.indexOf(':', ORG_KEY_PRE.length); return j > ORG_KEY_PRE.length ? k.slice(ORG_KEY_PRE.length, j) : ''; }).filter(Boolean);
    // ListKeys also returns tombstones (put(__org__:id, null) — see DELETE /organizations); the codebase's
    // General convention is `get(...) != null` = "exists" (see ~line 972, ~1029). A deleted org would
    // Otherwise stay in the list (the "0 records deleted but still shows on screen" bug) → skip records with a null value.
    const registered: string[] = [];
    for (const k of await rootRw.listKeys!(ORG_PRE).catch(() => [] as string[])) {
      if ((await rootRw.get!(k).catch(() => undefined)) != null) registered.push(k.slice(ORG_PRE.length));
    }
    const ids = [...new Set([...discovered, ...registered])].filter((id) => !bound || id === bound).sort();
    const orgs: { id: string; label?: string; runs: number; tokens: number; costUsd: number; source?: 'materialized' | 'scan'; budget?: { usdLimit?: number; tokenLimit?: number; exceeded: boolean; inherited: boolean } }[] = [];
    for (const id of ids) {
      const view = withOrg(rootRw as Journal, id) as unknown as Partial<Journal> & JournalReader;
      const runsList = typeof view.listRuns === 'function' ? await view.listRuns() : [];
      let tokens = 0;
      let costUsd = 0;
      // API-02: fast path — the SAME materialized-counter shortcut GET /metrics already uses
      // (readMetricsSummary → O(1) getCounters point-read), instead of a SEQUENTIAL
      // GetRunCost/readRun scan over EVERY run in the organization. withOrg bridges getCounters
      // 1:1 (key-prefixed, see organization.ts) → this stays per-org isolated, same as /metrics'
      // Own use of it. `source` mirrors /metrics' honesty field so the UI/tests can tell which
      // Path served the response.
      let source: 'materialized' | 'scan' = 'scan';
      if (typeof view.getCounters === 'function') {
        const summary = await readMetricsSummary(view as unknown as Journal);
        if (summary.all) {
          tokens = summary.all.tokens ?? 0;
          costUsd = summary.all.costUsd ?? 0;
          source = 'materialized';
        }
      }
      // No materialized data yet (older data / a journal without getCounters) — fall back to the
      // Legacy per-run scan so behavior is IDENTICAL to before this fix. NOTE: `view.countRunsByStatus`
      // Is intentionally NOT used here — withOrg deliberately does not bridge it (an org-scoped
      // Aggregate would otherwise leak every organization's counts, see organization.ts) — run COUNT
      // Keeps coming from `runsList` above (already a cheap listRuns() summary pass, not a per-run
      // ReadRun) in both the fast and the scan path, so it's unaffected either way.
      if (source === 'scan') {
        for (const r of runsList) {
          const rc = await getRunCost(view, r.runId);
          tokens += rc.totalTokens;
          costUsd += rc.costUsd;
        }
      }
      // Label: from the __org__:<id> record document (collected via POST /organizations) — GET used to
      // Never read it, so the label was collected but never shown in the UI (see bug report #1). An
      // Implicit/discovered org (not yet registered) has no label.
      const orgRec = (await rootRw.get!(ORG_PRE + id).catch(() => undefined)) as { label?: string } | undefined;
      const label = orgRec?.label;
      // Effective limit: the journal's __budget__ document (managed from Studio, enforced by @gnldev/server)
      // > the host config fallback (opts.budgets). readBudget resolves the same way as @gnldev/server's enforcement.
      // Inherited: true if the ORG'S OWN __budget__:<id> document is missing/unlimited (inherited from the
      // Default) — distinguished so the UI doesn't pre-fill these inherited values on edit and accidentally
      // Create a per-org override (see bug report #3).
      const ownBudgetDoc = (await rootRw.get!(BUDGET_PRE + id).catch(() => undefined)) as { usdLimit?: number; tokenLimit?: number } | null | undefined;
      const hasOwnBudget = !!ownBudgetDoc && (ownBudgetDoc.usdLimit != null || ownBudgetDoc.tokenLimit != null);
      const lim = (await readBudget(rootRw, id)) ?? opts.budgets?.perOrg?.[id] ?? opts.budgets?.default;
      let budget: { usdLimit?: number; tokenLimit?: number; exceeded: boolean; inherited: boolean } | undefined;
      if (lim && (lim.usdLimit != null || lim.tokenLimit != null)) {
        const exceeded = (lim.usdLimit != null && costUsd > lim.usdLimit) || (lim.tokenLimit != null && tokens > lim.tokenLimit);
        budget = { ...lim, exceeded, inherited: !hasOwnBudget };
        if (exceeded && opts.alerts?.webhook) {
          try {
            if ((await rootRw.get!(`__alert__:budget:${id}`)) === undefined) {
              const payload = { type: 'budget-exceeded', org: id, costUsd, tokens, limits: lim };
              await appendLog(rootRw as Journal, '__alert__', payload, `budget:${id}`);
              await fetch(opts.alerts.webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }).catch(() => { });
            }
          } catch { /* alert is best-effort — swallow */ }
        }
      }
      orgs.push({ id, ...(label ? { label } : {}), runs: runsList.length, tokens, costUsd, source, ...(budget ? { budget } : {}) });
    }
    // The default budget is also included in the response so the panel can edit it (journal > opts fallback).
    const defaultBudget = (await readBudget(rootRw, undefined)) ?? opts.budgets?.default ?? null;
    return c.json({ organizations: orgs, defaultBudget });
  };
  app.get('/organizations', listOrganizations);

  // CREATE org (register): makes an org with no runs yet visible in the list → budget/users can be assigned.
  // Only an unbound (operator) identity can create; an org-bound identity cannot create another org.
  const createOrganization = async (c: Context) => {
    if (!(await allowP(c.req.raw, 'org:write'))) return deny(c.req.raw, 'write');
    if (!writable) return c.json({ error: 'org management requires a writable journal' }, 501);
    if (!multiOrganizationEnabled) return c.json({ error: 'multi-org is not enabled (single org)' }, 501);
    { const denied = requirePlatformAdmin(c, 'an org-bound identity cannot create a new org'); if (denied) return denied; }
    const body = (await c.req.json().catch(() => ({}))) as { id?: string; label?: string };
    const id = String(body.id ?? '').trim();
    if (!id) return c.json({ error: 'id is required' }, 400);
    if (id.includes(':')) return c.json({ error: "invalid org: cannot contain ':'" }, 400);
    if (id === 'default') return c.json({ error: "'default' is reserved (default budget fallback)" }, 400);
    const rootJ = rawReader as unknown as Journal;
    if ((await rootJ.get(ORG_PRE + id)) != null) return c.json({ error: `org '${id}' is already registered` }, 409);
    const rec = { id, ...(body.label ? { label: String(body.label) } : {}), createdAt: Date.now() };
    await rootJ.put(ORG_PRE + id, rec);
    await audit(c, 'org.create', id, { label: rec.label });
    return c.json({ ok: true, organization: rec });
  };
  app.post('/organizations', createOrganization);

  // DELETE org (GDPR/cleanup): PERMANENTLY delete ALL `org:<id>:` data + the record + the budget document (irreversible).
  const deleteOrganization = async (c: Context) => {
    if (!(await allowP(c.req.raw, 'org:write'))) return deny(c.req.raw, 'write');
    if (!writable) return c.json({ error: 'org management requires a writable journal' }, 501);
    if (!multiOrganizationEnabled) return c.json({ error: 'multi-org is not enabled (single org)' }, 501);
    { const denied = requirePlatformAdmin(c, 'an org-bound identity cannot delete an org'); if (denied) return denied; }
    const rootJ = rawReader as unknown as Journal;
    if (typeof rootJ.deletePrefix !== 'function') {
      return c.json({ error: 'org deletion requires journal deletePrefix support (Sqlite/Postgres/InMemory provide it)' }, 501);
    }
    // Note: the standalone `const` handler uses the generic Hono `Context` type (no route-specific path
    // Literal) → ':id' therefore needs `!`.
    const id = decodeURIComponent(c.req.param('id')!);
    if (id.includes(':')) return c.json({ error: "invalid org: cannot contain ':'" }, 400);
    // GDPR runbook: purgeOrganization = the same org:<id>: sweep this line used to do inline, now the
    // ONE documented deletion surface (covers counters/metrics/wfrun/xrun too — see its JSDoc for what
    // Is deliberately NOT deleted: root __audit__ retention, orgless-scope data, EE users [handled below]).
    const deleted = await purgeOrganization(rootJ, id);       // the org's entire run/memory/queue trail
    await rootJ.put(ORG_PRE + id, null);                     // remove the record
    await rootJ.put(BUDGET_PRE + id, null);                     // remove the budget document
    // Prevent orphaned EE users: if members bound to the org aren't also deleted when the org is
    // Deleted, their tokens still validate (a ghost of the deleted org remains). Remove members too if opts.users is given.
    let removedUsers = 0;
    if (opts.users) {
      const members = (await opts.users.list()).filter((u) => u.orgId === id);
      for (const u of members) { await opts.users.remove(u.id); removedUsers++; }
    }
    await audit(c, 'org.delete', id, { deleted, ...(removedUsers ? { removedUsers } : {}) });
    return c.json({ ok: true, id, deleted, ...(removedUsers ? { removedUsers } : {}) });
  };
  app.delete('/organizations/:id', deleteOrganization);

  // ── Identity: the logged-in principal (UI "who am I logged in as" + org context) ───
  // Allow() attaches the principal to the context → principalOf reads it afterward. If auth is off,
  // Allow is always true + principal null → anonymous (everything open); if auth is on with no token, 401.
  app.get('/me', async (c) => {
    if (!(await allow(c.req.raw, 'read'))) return deny(c.req.raw, 'read');
    const p = principalOf(c.req.raw);
    // NEW fields for the (separate) UI iteration:
    //  • platformAdmin — the EXPLICIT cross-org grant (scope: 'platform').
    //  • scope — resolved scope tag: 'platform' | 'org:<id>' | 'none'. In strict mode 'none' means the
    //    Caller is fail-closed (org-less, no grant); in free mode 'none' is the legacy operator.
    //  • strictMultiOrg — whether the paid strict model is active (so the UI can interpret 'none').
    // `operator` is kept UNCHANGED (legacy: org-less) for backward-compat.
    const s = principalScope(p);
    const scope = s.kind === 'org' ? `org:${s.orgId}` : s.kind; // 'platform' | 'org:<id>' | 'none'
    return c.json({
      id: p?.id ?? null,
      roles: p?.roles ?? [],
      orgId: p?.orgId ?? null,
      operator: !!p && !p.orgId,
      platformAdmin: isPlatformAdmin(p),
      scope,
      strictMultiOrg,
    });
  });

  // ── Permission catalog (read-only; the code-defined, GNL-team-owned list) ───────────────
  // Exposes the fine-grained permission catalog + the role→preset map so the UI can render assignment
  // Checkboxes and seed them from a role. Fine-grained permissions are a PAID (RBAC) capability → when
  // RBAC is OFF (free tier, coarse read/write only) the catalog is reported disabled/empty so the UI
  // Doesn't offer a model the backend can't enforce. This endpoint is READ-ONLY: there is no create/edit/
  // Delete of permission TYPES — the GNL team extends the catalog in code together with its enforcement.
  app.get('/permissions/catalog', async (c) => {
    if (!(await allow(c.req.raw, 'read'))) return deny(c.req.raw, 'read');
    if (!rbacEnabled) return c.json({ enabled: false, permissions: [], rolePresets: {} });
    return c.json({ enabled: true, permissions: PERMISSION_CATALOG, rolePresets: ROLE_PERMISSION_PRESETS });
  });

  // ── User management (paid; if opts.users is given) ────────────────────────
  // ORG MODEL: org = organization, user = a MEMBER belonging to exactly 1 org, operator = a user with no
  // Org (platform-level). The token is returned ONCE on creation (the server never stores it in plaintext).
  //  • Operator (org-less admin): creates/deletes members in any org + can create org-less (operator) users.
  //  • Org-admin (bound admin): manages ONLY its OWN org's members (orgId is forced to its own org).
  //  • Member assignment is validated against an EXISTING org (a member cannot be added to a ghost org).
  async function orgExists(id: string): Promise<boolean> {
    const rootRw = rawReader as Partial<Journal> & JournalReader;
    if ((await rootRw.get?.(ORG_PRE + id)) != null) return true; // explicitly registered
    const keys = await rootRw.listKeys?.(`${ORG_KEY_PRE}${id}:`).catch(() => [] as string[]);
    return !!keys?.length; // or an org with (implicit) data
  }

  app.get('/users', async (c) => {
    if (!(await allow(c.req.raw, 'read'))) return deny(c.req.raw, 'read');
    if (!opts.users) return c.json({ users: [] });
    const own = principalOf(c.req.raw)?.orgId;
    const all = await opts.users.list();
    // Org-admin sees ONLY its own org's members; operator sees all.
    return c.json({ users: own ? all.filter((u) => u.orgId === own) : all });
  });

  app.post('/users', async (c) => {
    if (!(await allowP(c.req.raw, 'users:write'))) return deny(c.req.raw, 'write');
    if (!opts.users) return c.json({ error: 'user management is not enabled (the host must provide a userStore)' }, 501);
    const own = principalOf(c.req.raw)?.orgId;
    const body = (await c.req.json().catch(() => ({}))) as { email?: string; name?: string; roles?: string[]; permissions?: string[]; orgId?: string; ttlMs?: number; expiresAt?: number };
    if (body.roles && (!Array.isArray(body.roles) || body.roles.some((r) => typeof r !== 'string'))) {
      return c.json({ error: 'roles must be a string array' }, 400);
    }
    if (body.permissions && (!Array.isArray(body.permissions) || body.permissions.some((p) => typeof p !== 'string'))) {
      return c.json({ error: 'permissions must be a string array' }, 400);
    }
    if (body.ttlMs != null && (typeof body.ttlMs !== 'number' || body.ttlMs <= 0)) {
      return c.json({ error: 'ttlMs must be a positive number' }, 400);
    }
    if (body.expiresAt != null && typeof body.expiresAt !== 'number') {
      return c.json({ error: 'expiresAt must be an epoch ms number' }, 400);
    }
    // PRIVILEGE CEILING: `users:write` lets an admin manage users, but it must NOT let a non-platform-admin
    // MINT the reserved `platform-admin` role (or the `'*'` super-grant) — that would create a cross-org
    // Super-admin out of an org-bound admin. Same-org checks below guard the target's org, not its privileges.
    {
      const ceiling = assertAssignablePrivileges(principalOf(c.req.raw), { roles: body.roles, permissions: body.permissions });
      if (!ceiling.ok) return c.json({ error: ceiling.reason }, 403);
    }
    let targetOrg = body.orgId?.trim() || undefined;
    if (own) {
      // Org-admin: the target is always ITS OWN org (a different/operator request is rejected).
      if (targetOrg && targetOrg !== own) {
        return c.json({ error: `you can only create users in your own org ('${own}')` }, 403);
      }
      targetOrg = own;
    } else if (targetOrg) {
      // Operator: a member must be assigned to an EXISTING org (org-less = legitimately creating another operator).
      if (targetOrg.includes(':')) return c.json({ error: "invalid org: cannot contain ':'" }, 400);
      if (!(await orgExists(targetOrg))) {
        return c.json({ error: `org '${targetOrg}' doesn't exist — create the org first` }, 400);
      }
    }
    try {
      const created = await opts.users.create({
        email: body.email, name: body.name, roles: body.roles,
        ...(body.permissions?.length ? { permissions: body.permissions } : {}),
        orgId: targetOrg,
        ...(body.ttlMs != null ? { ttlMs: body.ttlMs } : {}),
        ...(body.expiresAt != null ? { expiresAt: body.expiresAt } : {}),
      });
      await audit(c, 'user.create', created.user.id, { roles: created.user.roles, ...(created.user.permissions ? { permissions: created.user.permissions } : {}), orgId: created.user.orgId });
      return c.json({ ok: true, ...created }); // { user, token } — token only here
    } catch (e: any) {
      return c.json({ error: String(e?.message ?? e) }, 400);
    }
  });

  app.delete('/users/:id', async (c) => {
    if (!(await allowP(c.req.raw, 'users:write'))) return deny(c.req.raw, 'write');
    if (!opts.users) return c.json({ error: 'user management is not enabled' }, 501);
    const id = decodeURIComponent(c.req.param('id'));
    const own = principalOf(c.req.raw)?.orgId;
    if (own) {
      // Org-admin can only delete a member of ITS OWN org.
      const target = (await opts.users.list()).find((u) => u.id === id);
      if (target && target.orgId !== own) {
        return c.json({ error: `you can only delete members of your own org ('${own}')` }, 403);
      }
    }
    await opts.users.remove(id);
    await audit(c, 'user.delete', id);
    return c.json({ ok: true, id });
  });

  // Invalidate the user's token WITHOUT deleting the user (audit/history remains). Only enabled if
  // Opts.users.revoke is provided (501 if the host doesn't support it). SAME permission rule as DELETE /users/:id.
  app.post('/users/:id/revoke', async (c) => {
    if (!(await allowP(c.req.raw, 'users:write'))) return deny(c.req.raw, 'write');
    if (!opts.users) return c.json({ error: 'user management is not enabled' }, 501);
    if (!opts.users.revoke) return c.json({ error: 'revoke is not enabled for this host' }, 501);
    const id = decodeURIComponent(c.req.param('id'));
    const own = principalOf(c.req.raw)?.orgId;
    if (own) {
      // Org-admin can only revoke a member of ITS OWN org.
      const target = (await opts.users.list()).find((u) => u.id === id);
      if (target && target.orgId !== own) {
        return c.json({ error: `you can only revoke members of your own org ('${own}')` }, 403);
      }
    }
    await opts.users.revoke(id);
    await audit(c, 'user.revoke', id);
    return c.json({ ok: true, id });
  });

  // PATCH a user's roles and/or explicit permissions (the customer admin ASSIGNS catalog permissions to a
  // User via checkboxes). The token is unchanged; the next authenticate picks up the new grants. SAME
  // Permission + org-scope rules as the other /users writes (org-admin: own org only; operator: any).
  app.patch('/users/:id', async (c) => {
    if (!(await allowP(c.req.raw, 'users:write'))) return deny(c.req.raw, 'write');
    if (!opts.users) return c.json({ error: 'user management is not enabled' }, 501);
    if (!opts.users.update) return c.json({ error: 'user update is not enabled for this host' }, 501);
    const id = decodeURIComponent(c.req.param('id'));
    const own = principalOf(c.req.raw)?.orgId;
    if (own) {
      const target = (await opts.users.list()).find((u) => u.id === id);
      if (target && target.orgId !== own) {
        return c.json({ error: `you can only update members of your own org ('${own}')` }, 403);
      }
    }
    const body = (await c.req.json().catch(() => ({}))) as { roles?: string[]; permissions?: string[] };
    if (body.roles !== undefined && (!Array.isArray(body.roles) || body.roles.some((r) => typeof r !== 'string'))) {
      return c.json({ error: 'roles must be a string array' }, 400);
    }
    if (body.permissions !== undefined && (!Array.isArray(body.permissions) || body.permissions.some((p) => typeof p !== 'string'))) {
      return c.json({ error: 'permissions must be a string array' }, 400);
    }
    if (body.roles === undefined && body.permissions === undefined) {
      return c.json({ error: 'nothing to update (provide roles and/or permissions)' }, 400);
    }
    // PRIVILEGE CEILING (see POST /users): an admin cannot ELEVATE a user (or itself) to `platform-admin`
    // / `'*'` via PATCH either — this is the self-grant path (PATCH /users/<own-id> {roles:[...]}).
    {
      const ceiling = assertAssignablePrivileges(principalOf(c.req.raw), { roles: body.roles, permissions: body.permissions });
      if (!ceiling.ok) return c.json({ error: ceiling.reason }, 403);
    }
    try {
      const user = await opts.users.update(id, {
        ...(body.roles !== undefined ? { roles: body.roles } : {}),
        ...(body.permissions !== undefined ? { permissions: body.permissions } : {}),
      });
      await audit(c, 'user.update', id, { roles: user.roles, ...(user.permissions ? { permissions: user.permissions } : {}) });
      return c.json({ ok: true, user });
    } catch (e: any) {
      return c.json({ error: String(e?.message ?? e) }, 400);
    }
  });

  // Write/clear an org's budget (management — admin): the `__budget__:<id>` document in the journal.
  // Id='default' is the fallback for all orgs. Empty body/null values → the budget is deleted.
  // @gnldev/server's write path reads this document LIVE → changes take effect without a redeploy.
  const putOrganizationBudget = async (c: Context) => {
    if (!(await allowP(c.req.raw, 'budget:write'))) return deny(c.req.raw, 'write');
    if (!writable) return c.json({ error: 'budget management requires a writable journal' }, 501);
    // Note: the standalone `const` handler uses the generic Hono `Context` type (no route-specific path
    // Literal) → ':id' therefore needs `!` (see the note on the DELETE handler).
    const id = decodeURIComponent(c.req.param('id')!);
    // An identity-bound org can ONLY write ITS OWN budget — it cannot change someone else's or the
    // 'default' fallback (the write-side counterpart of the visibility restriction in GET /organizations).
    // An unbound (operator) identity manages all of them.
    const bound = principalOf(c.req.raw)?.orgId;
    if (bound && id !== bound) {
      return c.json({ error: `unauthorized: identity is bound to org '${bound}', cannot manage the budget of '${id}'` }, 403);
    }
    if (id.includes(':')) return c.json({ error: "invalid org: cannot contain ':'" }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { usdLimit?: number | null; tokenLimit?: number | null };
    const usd = body.usdLimit;
    const tok = body.tokenLimit;
    for (const [k, v] of [['usdLimit', usd], ['tokenLimit', tok]] as const) {
      if (v != null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
        return c.json({ error: `${k} must be a non-negative number` }, 400);
      }
    }
    const rootJ = rawReader as unknown as Journal;
    const budget: BudgetLimit | null = (usd == null && tok == null)
      ? null
      : { ...(usd != null ? { usdLimit: usd } : {}), ...(tok != null ? { tokenLimit: tok } : {}) };
    await rootJ.put(BUDGET_PRE + id, budget);
    await audit(c, 'org.budget', id, { budget });
    return c.json({ ok: true, id, budget });
  };
  app.put('/organizations/:id/budget', putOrganizationBudget);

  // P1.6 fast path — if the (org-scoped) journal has materialized counters
  // (`getCounters` bridged above + `__metrics__:all` has data), byStatus is STILL a cheap listRuns()
  // Summary pass (no readRun/getRunCost per run), and costUsd/tokens/byDay come straight off the
  // Counters (O(1 + days), see readMetricsSummary) — no per-run scan at all. `source` tells the caller
  // Which path served the response (materialized vs the legacy full scan) so Studio's UI/tests can tell.
  app.get('/metrics', async (c) => {
    if (!(await allow(c.req.raw, 'read'))) return deny(c.req.raw, 'read');
    if (typeof rw.getCounters === 'function') {
      const daysParam = Number(c.req.query('days'));
      const days = Number.isFinite(daysParam) ? Math.trunc(daysParam) : undefined;
      const summary = await readMetricsSummary(rw as unknown as Journal, { days });
      if (summary.all) {
        // P1.6b: when the (org-scoped) reader exposes `countRunsByStatus`, use the ENGINE-LEVEL push-down
        // Aggregate (O(distinct statuses), see journal.ts JournalReader.countRunsByStatus) instead of
        // Materializing every RunSummary via listRuns() just to count them. Falls back to the listRuns
        // Scan when unavailable (custom journal, or an org-scoped view — countRunsByStatus is
        // Deliberately NOT bridged per-org, see organization.ts).
        const counted = typeof rw.countRunsByStatus === 'function' ? await rw.countRunsByStatus().catch(() => undefined) : undefined;
        let total: number;
        let byStatus: Record<string, number>;
        if (counted) {
          byStatus = counted;
          total = Object.values(counted).reduce((a, b) => a + b, 0);
        } else {
          const runs = await reader.listRuns();
          byStatus = {};
          for (const r of runs) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
          total = runs.length;
        }
        return c.json({
          total,
          byStatus,
          costUsd: summary.all.costUsd ?? 0,
          tokens: summary.all.tokens ?? 0,
          source: 'materialized',
          byDay: summary.byDay,
        });
      }
    }
    // Legacy full scan (no materialized counters yet — pre-P1.6 data, or a journal without incrBy/getCounters).
    const runs = await reader.listRuns();
    const byStatus: Record<string, number> = {};
    let costUsd = 0, tokens = 0;
    for (const r of runs) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    for (const r of runs) { const rc = await getRunCost(reader, r.runId); costUsd += rc.costUsd; tokens += rc.totalTokens; }
    return c.json({ total: runs.length, byStatus, costUsd, tokens, source: 'scan' });
  });

  // Per-run metric rows (Observability: time-series + latency percentiles + a rich table).
  // P1.6: for a finalized run, the `__metrics__run:<runId>` row (written once at completion — see
  // Registry.ts's post-run hook / metrics.ts recordRunMetrics) is read directly — no readRun/getRunCost.
  // Only runs WITHOUT that row (in-flight, or older than this feature / a journal without incrBy) fall
  // Back to the readRun+getRunCost scan. Response shape is UNCHANGED (same field names as before).
  app.get('/metrics/runs', async (c) => {
    if (!(await allow(c.req.raw, 'read'))) return deny(c.req.raw, 'read');
    let runs = await reader.listRuns();
    // P1.6b: optional ?limit= — clamp 1..1000, slicing the run list BEFORE fetching any rows (a cheap
    // Partial win). Full cursor-based pagination for this endpoint is P0.3's job — not attempted here.
    const limitRaw = c.req.query('limit');
    if (limitRaw !== undefined) {
      const limit = Math.min(Math.max(Math.floor(Number(limitRaw)) || 0, 1), 1000);
      runs = runs.slice(0, limit);
    }
    // P1.6b: ONE getMany round-trip for every fast-path row instead of N sequential rw.get calls, when
    // The (org-scoped) reader exposes it; falls back to the per-run rw.get loop otherwise (custom
    // Journal, or a journal without getMany at all).
    const fastRows: (MetricsRunRow | undefined)[] = typeof rw.getMany === 'function'
      ? await rw.getMany<MetricsRunRow>(runs.map((r) => metricsRunKey(r.runId))).catch(() => runs.map(() => undefined))
      : [];
    const rows = [];
    for (let i = 0; i < runs.length; i++) {
      const r = runs[i]!;
      const row = fastRows[i] ?? (typeof rw.getMany !== 'function' && typeof rw.get === 'function'
        ? await rw.get<MetricsRunRow>(metricsRunKey(r.runId)).catch(() => undefined)
        : undefined);
      if (row) {
        rows.push({
          runId: r.runId,
          status: row.status,
          modelSteps: row.modelSteps,
          toolCalls: row.toolCalls,
          startTs: row.startTs,
          durationMs: row.durationMs,
          costUsd: row.costUsd,
          totalTokens: row.totalTokens,
        });
        continue;
      }
      const entries = await reader.readRun(r.runId);
      const ts = entries.map((e) => e.ts).filter((t): t is number => t != null);
      const startTs = ts.length ? Math.min(...ts) : null;
      const endTs = ts.length ? Math.max(...ts) : null;
      const rc = await getRunCost(reader, r.runId);
      rows.push({
        runId: r.runId,
        status: r.status,
        modelSteps: r.modelSteps,
        toolCalls: r.toolCalls,
        startTs,
        durationMs: startTs != null && endTs != null ? endTs - startTs : null,
        costUsd: rc.costUsd,
        totalTokens: rc.totalTokens,
      });
    }
    return c.json({ runs: rows });
  });

  // ── SSE ticket (opt-in, audit #2): since EventSource can't send headers, the roleAuth `?token=`
  // Fallback carries the persistent secret in the URL (a log-leak risk — see role-auth.ts's JSDoc). An
  // Alternative: authenticated `POST /auth/sse-ticket` generates a SINGLE-USE random ticket with a 60s TTL;
  // `GET /events?ticket=...` consumes it IMMEDIATELY (unusable again). An in-memory Map; TTL sweeping is
  // Done lazily on every issue/consume call (no separate timer needed, leaves no dangling handle at
  // Test/process shutdown). The existing `?token=` behavior is preserved UNCHANGED — this is only a safer
  // ADDITIONAL path (backward compatible).
  const SSE_TICKET_TTL_MS = 60_000;
  const sseTickets = new Map<string, { principal: Principal | null; expiresAt: number }>();
  function sweepSseTickets(now: number): void {
    for (const [t, v] of sseTickets) if (v.expiresAt <= now) sseTickets.delete(t);
  }
  function issueSseTicket(principal: Principal | null): { ticket: string; expiresAt: number } {
    const now = Date.now();
    sweepSseTickets(now);
    const ticket = randomUUID();
    const expiresAt = now + SSE_TICKET_TTL_MS;
    sseTickets.set(ticket, { principal, expiresAt });
    return { ticket, expiresAt };
  }
  /** If the ticket is valid, returns its principal AND CONSUMES IT IMMEDIATELY (single-use); undefined if invalid/expired. */
  function consumeSseTicket(ticket: string): Principal | null | undefined {
    const now = Date.now();
    sweepSseTickets(now);
    const v = sseTickets.get(ticket);
    if (!v) return undefined;
    sseTickets.delete(ticket); // single-use: found or not, it never becomes valid again
    return v.expiresAt > now ? v.principal : undefined;
  }
  // Getting a ticket also requires READ permission (viewer/admin) — if auth is off (no provider), allow()
  // Already returns true, so the ticket is issued freely (consistent with the existing open behavior).
  app.post('/auth/sse-ticket', async (c) => {
    if (!(await allow(c.req.raw, 'read'))) return deny(c.req.raw, 'read');
    const { ticket, expiresAt } = issueSseTicket(principalOf(c.req.raw));
    return c.json({ ticket, expiresAt });
  });

  // SSE: pushes when the run list changes (live instead of polling). EventSource can't send headers →
  // Gated with ?token= (roleAuth fallback) OR ?ticket= (the single-use ticket above).
  // API-04: poll interval — 2s (was 1s). The cheap-signal path below only pays for a full listRuns()
  // Scan when something has ACTUALLY changed (see readCheapEventsSignal), so this interval mostly gates
  // The cheap probe itself (already O(distinct statuses) via the engine's countRunsByStatus push-down,
  // Or a single indexed page read for the newest run) — 2s keeps the UI feeling live while halving even
  // That probe's frequency, with no user-visible latency cost worth calling out.
  const EVENTS_POLL_MS = 2000;
  /**
   * API-04-followup: the cheap signal (readCheapEventsSignal, below) only tracks per-status totals + the
   * Newest run's tuple, so an OLDER (non-newest) run's step progress can advance without moving it (see
   * The KNOWN GAP note below). Rather than pay for a full listRuns() scan every tick to close that gap,
   * A full listRuns() diff also runs unconditionally once every FULL_SCAN_EVERY_TICKS ticks — bounding
   * The worst-case staleness for a non-newest run's progress to one full-scan period (~10s at the 2s poll
   * Interval) instead of "until its own status changes". Net cost: 1 full scan per ~10s instead of per
   * 1s pre-API-04 (~10x cut) while every change is still surfaced within a bounded delay.
   * Not part of the public API (StudioApiOptions) — overridable only via an internal, untyped option so
   * Tests don't have to wait out the full 10s in real time.
   */
  const FULL_SCAN_EVERY_TICKS: number = (opts as any).__fullScanEveryTicks ?? 5;
  /**
   * API-04: a CHEAP fingerprint of "has anything changed" — deliberately NOT a full listRuns() scan.
   * Combines countRunsByStatus()'s per-status totals (catches a run being added/removed, or any run
   * Transitioning completed↔suspended — O(distinct statuses), see journal.ts's JSDoc) with the newest
   * Run's own summary tuple, read via a single indexed listRunsPaged({limit:1}) tail slice — the SAME
   * Total→ascending-range conversion GET /runs already uses above (catches the common case: the
   * Most-recently-created run's modelSteps/toolCalls advancing while it's still mid-flight).
   * Returns undefined when the underlying reader doesn't support countRunsByStatus (a bare/custom
   * JournalReader, or an org-scoped view — countRunsByStatus is deliberately not bridged per-org, see
   * The `reader` construction above) → callers fall back to the pre-API-04 full-scan behavior.
   * KNOWN GAP (bounded, not lost): an OLDER (non-newest) run advancing its steps while a newer run also
   * Exists won't move this fingerprint until ITS OWN status changes — but the periodic full scan below
   * (FULL_SCAN_EVERY_TICKS) still catches it within at most ~10s, so this is a bounded delay, not a
   * Missed event; the fallback path below has no such gap (or delay) at all.
   */
  async function readCheapEventsSignal(): Promise<string | undefined> {
    if (typeof rw.countRunsByStatus !== 'function') return undefined;
    let counted: Record<string, number> | undefined;
    try { counted = await rw.countRunsByStatus(); } catch { counted = undefined; }
    if (!counted) return undefined;
    const total = Object.values(counted).reduce((a, b) => a + b, 0);
    let newest: [string, string, number, number] | null = null;
    if (total > 0 && typeof reader.listRunsPaged === 'function') {
      try {
        const page = await reader.listRunsPaged({ limit: 1, cursor: String(total - 1) });
        const r = page.items[0];
        if (r) newest = [r.runId, r.status, r.modelSteps, r.toolCalls];
      } catch { newest = null; }
    }
    return JSON.stringify([counted, newest]);
  }
  app.get('/events', async (c) => {
    const ticket = c.req.query('ticket');
    let ticketOrg: string | undefined;
    if (ticket !== undefined) {
      const principal = consumeSseTicket(ticket);
      if (principal === undefined) return c.json({ error: 'invalid or expired ticket' }, 401);
      // If the ticket is org-bound (multi-org), the read is scoped to that org — PARITY with the org
      // Middleware's bound-principal behavior (see the app.use('*') block above).
      ticketOrg = principal?.orgId;
    } else if (!(await allow(c.req.raw, 'read'))) {
      return deny(c.req.raw, 'read');
    }
    const run = () => sseResponse(c, async (stream) => {
      // API-04: the event body is now INFORMATIVE — `{"runIds":[...],"at":<epoch ms>}` naming exactly
      // Which runs changed, instead of the old signal-only `data:'runs'` — so the client can patch just
      // Those rows (see studio-ui/api.ts's useLiveRuns) instead of refetching every loaded page.
      // BACKWARD COMPAT is handled CLIENT-SIDE (a JSON.parse failure there falls back to full
      // Invalidation) — this endpoint doesn't fork into two implementations for old vs new clients.
      let cheapSig: string | undefined;
      let known = new Map<string, string>(); // runId -> `${status}|${modelSteps}|${toolCalls}`
      let baselined = false;
      let legacyLast = ''; // fallback-path signature, used ONLY when countRunsByStatus is unavailable
      let tick = 0; // counts cheap-path ticks SINCE the baseline (for FULL_SCAN_EVERY_TICKS below)
      while (!stream.aborted) {
        const sig = await readCheapEventsSignal();
        if (sig !== undefined) {
          if (!baselined) {
            // First tick: establish the baseline silently (no event) — a freshly-connected client just
            // Did its own initial fetch, so reporting every existing run as "changed" here would be a
            // Needless (and, at tens of thousands of runs, large) initial payload.
            cheapSig = sig;
            known = new Map((await reader.listRuns()).map((r) => [r.runId, `${r.status}|${r.modelSteps}|${r.toolCalls}`]));
            baselined = true;
          } else {
            tick++;
            // Periodic full scan (FULL_SCAN_EVERY_TICKS): runs a full listRuns() diff even when the cheap
            // Signal DIDN'T change, so a non-newest run's progress (the KNOWN GAP above) is still caught
            // Within a bounded delay instead of only when its status flips.
            const forceFullScan = tick % FULL_SCAN_EVERY_TICKS === 0;
            if (sig !== cheapSig || forceFullScan) {
              cheapSig = sig;
              const runs = await reader.listRuns();
              const nextKnown = new Map<string, string>();
              const changed: string[] = [];
              for (const r of runs) {
                const fp = `${r.status}|${r.modelSteps}|${r.toolCalls}`;
                nextKnown.set(r.runId, fp);
                if (known.get(r.runId) !== fp) changed.push(r.runId);
              }
              // A run disappearing (purge/retention sweep) also counts as "changed" — the client needs
              // Its id to drop the row from cached pages, not just to see growth/edits.
              for (const id of known.keys()) if (!nextKnown.has(id)) changed.push(id);
              known = nextKnown;
              if (changed.length > 0) {
                await stream.writeSSE({ data: JSON.stringify({ runIds: changed, at: Date.now() }), event: 'change' });
              }
            }
          }
        } else {
          // Fallback: no cheap aggregate available → PRESERVE the exact pre-API-04 behavior (full
          // ListRuns() scan every poll, diffed as one whole-list signature, old uninformative payload).
          const runs = await reader.listRuns();
          const fullSig = JSON.stringify(runs.map((r) => [r.runId, r.status, r.modelSteps, r.toolCalls]));
          if (fullSig !== legacyLast) { legacyLast = fullSig; await stream.writeSSE({ data: 'runs', event: 'change' }); }
        }
        await stream.sleep(EVENTS_POLL_MS);
      }
    });
    return ticketOrg ? orgALS.run(ticketOrg, run) : run();
  });

  // "re-run from here" (admin).
  app.post('/runs/:id/fork', async (c) => {
    if (!(await allowP(c.req.raw, 'run:write'))) return deny(c.req.raw, 'write');
    if (!resume) return c.json({ error: 'fork requires resume' }, 501);
    if (!writable) return c.json({ error: 'fork requires a writable journal' }, 501);
    const id = decodeURIComponent(c.req.param('id'));
    const body = (await c.req.json().catch(() => ({}))) as { step?: number; newRunId?: string };
    const fork = await forkRun(reader as any, id, body.step ?? 0, body.newRunId);
    const r = await resume(fork.newRunId, {});
    await audit(c, 'fork', id, { step: body.step ?? 0, newRunId: fork.newRunId });
    return c.json({ ok: true, ...fork, ...r });
  });

  // Approval → resume (admin).
  app.post('/runs/:id/resume', async (c) => {
    if (!(await allowP(c.req.raw, 'run:write'))) return deny(c.req.raw, 'write');
    if (!resume) return c.json({ error: 'resume is not enabled' }, 501);
    const id = decodeURIComponent(c.req.param('id'));
    const body = (await c.req.json().catch(() => ({}))) as { approvals?: Record<string, boolean> };
    const result = await resume(id, body.approvals ?? {});
    // 'approve' if any value in approvals is true, otherwise 'deny' (the detail carries the full decision set)
    const anyApproved = Object.values(body.approvals ?? {}).some((v) => v === true);
    await audit(c, anyApproved ? 'approve' : 'deny', id, { approvals: body.approvals });
    return c.json({ ok: true, ...result });
  });

  /**
   * D3-A durably cancels an agent run — the studio-side counterpart of
   * @gnldev/server's POST /runs/:id/cancel. UNLIKE @gnldev/server, studio keeps no in-process AbortController
   * Registry for streamed generations (there is no equivalent of its `inflight` map here), so this is
   * ONLY the durable-flag path: `cancelAgentRun` writes a cross-worker flag every fresh model step
   * Checks (durable-model.ts) — a run in flight elsewhere stops at its NEXT step boundary, and every
   * Future resume attempt is refused (terminal, like a compensated run; recovery = fork). Visibility:
   * The SAME `${id}:input` presence check @gnldev/server's cancel endpoint uses (persistInput is written by
   * Every run()/stream() call) — a run from another organization is invisible through the org-scoped
   * `rw` (withOrg prefixes every key), so this returns the same 404 (no existence leak) as elsewhere.
   */
  app.post('/runs/:id/cancel', async (c) => {
    if (!(await allowP(c.req.raw, 'run:write'))) return deny(c.req.raw, 'write');
    if (!writable) return c.json({ error: 'cancel requires a writable journal' }, 501);
    const id = decodeURIComponent(c.req.param('id'));
    const visible = await rw.get!(`${id}:input`).catch(() => undefined);
    if (visible === undefined) return c.json({ error: `run '${id}' not found` }, 404);
    await cancelAgentRun(rw as unknown as Journal, id, { reason: 'studio-cancel' });
    await audit(c, 'run.cancel', id, { durable: true });
    return c.json({ ok: true, durable: true });
  });

  // Unwind an abandoned run — every executed side effect whose tool declares a
  // `compensate` hook is undone in reverse order, exactly-once (@gnldev/durable compensateRun). The run
  // Is CONDEMNED first (never resumable again) → write-gated + audited with the report summary.
  // `dryRun: true` previews the work without condemning or executing anything.
  app.post('/runs/:id/compensate', async (c) => {
    if (!(await allowP(c.req.raw, 'run:write'))) return deny(c.req.raw, 'write');
    if (!compensate) return c.json({ error: 'compensate is not enabled (pass the compensate option — see StudioApiOptions)' }, 501);
    const id = decodeURIComponent(c.req.param('id'));
    const body = (await c.req.json().catch(() => ({}))) as { dryRun?: boolean };
    const report = (await compensate(id, { dryRun: !!body.dryRun })) as { entries?: { status: string }[] };
    if (!body.dryRun) {
      const counts: Record<string, number> = {};
      for (const e of report.entries ?? []) counts[e.status] = (counts[e.status] ?? 0) + 1;
      await audit(c, 'run.compensate', id, { counts });
    }
    return c.json({ ok: true, report });
  });

  // GDPR/PII purge: PERMANENTLY delete ALL trace of a run (irreversible) — the one exception to the
  // Journal's append-only philosophy; only for legal deletion. The decision is logged to audit (actor + deleted record count).
  app.delete('/runs/:id', async (c) => {
    if (!(await allowP(c.req.raw, 'run:delete'))) return deny(c.req.raw, 'write');
    // Root-level management: run purge runs ORG-UNSCOPED (rw = raw journal) → a bound identity could
    // Otherwise also delete another org's run. Only an unbound operator can do this.
    { const denied = requirePlatformAdmin(c, 'an org-bound identity cannot purge a run (operator required)'); if (denied) return denied; }
    if (typeof (rw as Partial<Journal>).deletePrefix !== 'function') {
      return c.json({ error: 'purge requires journal deletePrefix support (Sqlite/Postgres/InMemory provide it)' }, 501);
    }
    const id = decodeURIComponent(c.req.param('id'));
    const deleted = await purgeRun(rw as unknown as Journal, id);
    await audit(c, 'run.purge', id, { deleted });
    return c.json({ ok: true, deleted });
  });

  // ── W5: Replay-based regression (durable regression.ts: replayRun + regressionReport) ────
  // Independently re-runs a recorded run's INPUT (runKeys.input) with a new model/system
  // (replayRun — NOT forkRun, it never touches the original run's journal records), then
  // Returns the decision-point diff (regressionReport → diffRuns).
  app.post('/runs/:id/regression', async (c) => {
    if (!(await allow(c.req.raw, 'write'))) return deny(c.req.raw, 'write');
    if (!writable) return c.json({ error: 'regression requires a writable journal' }, 501);
    const id = decodeURIComponent(c.req.param('id'));
    const body = (await c.req.json().catch(() => ({}))) as { model?: string; system?: string; newRunId?: string; memoryOff?: boolean };
    if (!body.model) return c.json({ error: 'model is required (e.g. "openai/gpt-4o")' }, 400);
    let model: unknown;
    try {
      model = await (opts.regressionModel ?? resolveModel)(body.model);
    } catch (e: any) {
      return c.json({ error: String(e?.message ?? e) }, 400);
    }
    try {
      const { newRunId } = await replayRun({
        journal: rw as unknown as Journal & JournalReader,
        runId: id,
        model: model as any,
        ...(body.system != null ? { system: body.system } : {}),
        ...(body.newRunId ? { newRunId: body.newRunId } : {}),
        // Counterfactual memory-off replay (see durable regression.ts stripMemoryContext): re-ask the
        // Turn WITHOUT what memory injected — provable causation instead of "it probably read it".
        ...(body.memoryOff ? { stripMemoryContext: true } : {}),
      });
      const report = await regressionReport(reader, id, newRunId);
      await audit(c, 'run.regression', id, { newRunId, model: body.model, divergentAt: report.diff.divergentAt, ...(body.memoryOff ? { memoryOff: true } : {}) });
      return c.json({ ok: true, ...report });
    } catch (e: any) {
      return c.json({ error: String(e?.message ?? e) }, 400);
    }
  });

  // Diffs two EXISTING runs (without re-running) at the decision-point level — read-only.
  app.get('/runs/:id/regression/:otherId', async (c) => {
    if (!(await allow(c.req.raw, 'read'))) return deny(c.req.raw, 'read');
    const id = decodeURIComponent(c.req.param('id'));
    const otherId = decodeURIComponent(c.req.param('otherId'));
    return c.json(await regressionReport(reader, id, otherId));
  });

  // Export a run's trace to an external APM (Langfuse/Honeycomb/Datadog/Collector). SECURITY: Studio
  // NEVER holds the target endpoint/API key itself — the host CALLS opts.otelExport with its own
  // Configured target (internally the host runs @gnldev/otel's `exportRunToOtlp` with its own preset); we only TRIGGER it.
  app.post('/runs/:id/otel-export', async (c) => {
    if (!(await allow(c.req.raw, 'write'))) return deny(c.req.raw, 'write');
    if (!opts.otelExport) return c.json({ error: 'OTEL export is not enabled (the host must provide otelExport)' }, 501);
    const id = decodeURIComponent(c.req.param('id'));
    const result = await opts.otelExport(id);
    await audit(c, 'run.otel-export', id, result);
    return c.json(result);
  });

  // Retention sweep: PERMANENTLY clean up old runs per the policy (or the request body).
  app.post('/retention/sweep', async (c) => {
    if (!(await allow(c.req.raw, 'write'))) return deny(c.req.raw, 'write');
    // Root-level management: the sweep scans runs across ALL orgs (org-unscoped) → a bound identity could
    // Otherwise also delete other orgs' data. Only an unbound operator can do this.
    { const denied = requirePlatformAdmin(c, 'an org-bound identity cannot run a retention sweep (operator required)'); if (denied) return denied; }
    if (typeof (rw as Partial<Journal>).deletePrefix !== 'function') {
      return c.json({ error: 'retention requires journal deletePrefix support' }, 501);
    }
    const body = (await c.req.json().catch(() => ({}))) as { olderThanMs?: number; keepSuspended?: boolean };
    const olderThanMs = body.olderThanMs ?? opts.retention?.olderThanMs;
    if (olderThanMs == null) return c.json({ error: 'olderThanMs is required (body or the retention option)' }, 400);
    const keepSuspended = body.keepSuspended ?? opts.retention?.keepSuspended ?? true;
    const result = await sweepRuns(rw as any, { olderThanMs, keepSuspended });
    await audit(c, 'retention.sweep', 'runs', {
      olderThanMs, keepSuspended,
      scanned: result.scanned, purged: result.purged.length,
      keptSuspended: result.keptSuspended, keptNoTs: result.keptNoTs,
    });
    return c.json({ ok: true, ...result, purged: result.purged.slice(0, 100) });
  });

  // ── Guard/policy editor: rules live in the journal (__policy__), policyGuard reads them live ──────────
  app.get('/policy', async (c) => {
    if (!(await allow(c.req.raw, 'read'))) return deny(c.req.raw, 'read');
    if (!writable) return c.json({ policy: null });
    return c.json({ policy: (await rw.get!(POLICY_KEY)) ?? null });
  });

  app.put('/policy', async (c) => {
    if (!(await allowP(c.req.raw, 'policy:write'))) return deny(c.req.raw, 'write');
    if (!writable) return c.json({ error: 'editing the policy requires a writable journal' }, 501);
    // Root-level management: the policy is a SINGLE GLOBAL rule set for ALL orgs (org-unscoped) → a
    // Bound identity could otherwise change everyone's guard. Only an unbound operator can do this.
    { const denied = requirePlatformAdmin(c, 'an org-bound identity cannot update the global policy (operator required)'); if (denied) return denied; }
    const body = (await c.req.json().catch(() => null)) as { rules?: PolicyRule[]; ifVersion?: number } | null;
    if (!Array.isArray(body?.rules)) return c.json({ error: 'a rules array is required' }, 400);
    const ACTIONS = new Set(['allow', 'deny', 'require-approval']);
    for (const r of body.rules) {
      if (!r || typeof r.tool !== 'string' || !r.tool.trim() || !ACTIONS.has(r.action)) {
        return c.json({ error: "every rule must be { tool: string, action: 'allow'|'deny'|'require-approval', reason? }" }, 400);
      }
    }
    const prev = (await rw.get!(POLICY_KEY)) as PolicyDoc | undefined;
    // Optimistic lock (API-08): if the caller tells us which version it edited, refuse a silent
    // Lost update when another admin has since saved. Omitted `ifVersion` → old behavior (backward
    // Compat for existing clients / @gnldev/server, which never sends it).
    if (body.ifVersion != null) {
      const current = prev?.version ?? 0;
      if (body.ifVersion !== current) {
        return c.json({
          error: `policy was modified by another admin (expected v${body.ifVersion}, current v${current})`,
          code: 'version_conflict',
          current: prev ?? null,
        }, 409);
      }
    }
    const doc: PolicyDoc = { version: (prev?.version ?? 0) + 1, rules: body.rules, updatedAt: Date.now() };
    await rw.put!(POLICY_KEY, doc);
    // The FULL rule set is in the audit detail → past versions can be read back from the audit trail.
    await audit(c, 'policy.update', 'policy', { version: doc.version, rules: doc.rules });
    return c.json({ ok: true, version: doc.version });
  });

  // Live chat (admin).
  app.post('/chat', async (c) => {
    if (!(await allow(c.req.raw, 'write'))) return deny(c.req.raw, 'write');
    if (!chat) return c.json({ error: 'chat is not enabled' }, 501);
    const body = (await c.req.json().catch(() => ({}))) as { message?: string; runId?: string };
    if (!body.message) return c.json({ error: 'message is required' }, 400);
    try {
      return c.json({ ok: true, ...(await chat(String(body.message), { runId: body.runId })) });
    } catch (e) {
      // This endpoint had no catch at all, so the SAME upstream failure that other endpoints turned
      // Into a 400 became an unhandled 500 here — one fault, two answers, depending only on which
      // Path the caller took. Now it goes through the same taxonomy as the rest.
      return runErrorResponse(c, e) ?? c.json({ error: String((e as Error)?.message ?? e) }, 400);
    }
  });

  /**
   * K1/W1: the SAME mapping as `limitErrorResponse`/`blockedErrorResponse` in @gnldev/server — but Studio is
   * NOT dependent on @gnldev/server (no dependency in package.json, only @gnldev/durable) → it's set up
   * LOCALLY here. The code/HTTP status choices are IDENTICAL to packages/server/src/index.ts: run_limit_
   * Exceeded/tool_loop_detected → 422 + resumable:true; side_effect_retry_blocked/run_busy → 409 +
   * Resumable:true; retry_limit_exceeded → 422, NO resumable (permanently 'failed' in the journal). If
   * Nothing matches → undefined → the caller falls through to the generic 400 path (existing behavior).
   */
  function runErrorResponse(c: Context, e: unknown): Response | undefined {
    if (e instanceof RunLimitExceededError || (e as any)?.name === 'RunLimitExceededError') {
      const err = e as RunLimitExceededError;
      return c.json({ error: err.message, code: 'run_limit_exceeded', detail: err.detail, resumable: true }, 422);
    }
    if (e instanceof ToolLoopDetectedError || (e as any)?.name === 'ToolLoopDetectedError') {
      const err = e as ToolLoopDetectedError;
      return c.json({ error: err.message, code: 'tool_loop_detected', detail: err.detail, resumable: true }, 422);
    }
    // A provider failure is not one of OURS — it matches nothing above and used to fall through to
    // The generic 400, telling the caller its request was malformed when the request was fine.
    // Measured: a free endpoint answering 429 arrived as `400 "Failed after 3 attempts…"`, which a
    // Client with retry logic reads as "never retry" at the exact moment it should wait.
    const up = upstreamFailure(e);
    if (up) {
      const eu = e as { message?: string } | null | undefined;
      const res = c.json({
        error: eu?.message ?? String(e),
        code: up.code,
        ...(up.upstreamStatus !== undefined ? { upstreamStatus: up.upstreamStatus } : {}),
        ...(up.retryAfter !== undefined ? { retryAfter: up.retryAfter } : {}),
      }, up.status);
      if (up.retryAfter !== undefined) res.headers.set('Retry-After', String(up.retryAfter));
      return res;
    }
    const code = blockedErrorCode(e);
    if (!code) return undefined;
    const err = e as { message?: string; detail?: unknown } | null | undefined;
    const body = { error: err?.message ?? String(e), code, detail: err?.detail };
    return code === 'retry_limit_exceeded' ? c.json(body, 422) : c.json({ ...body, resumable: true }, 409);
  }

  // ── Playground (if gnl is given) ──────────────────────────────────────────────
  /**
   * Org-scoped agent visibility (SHARED helper with server): the caller's org = identity-bound
   * Principal.orgId (else the header-resolved org in ALS; operator/auth-off → undefined → everything visible).
   * A global agent (no orgs) is always visible → backward-compatible.
   */
  const callerOrg = (c: Context): string | undefined => principalOf(c.req.raw)?.orgId ?? orgALS.getStore();
  /**
   * An org-invisible CODE-DEFINED agent → 404 (does NOT LEAK that it exists, same body as unknown-agent).
   * `orgs` is a property only of code-defined AgentConfig; names NOT IN listAgents (managed agent /
   * Unknown) pass through the existing run path UNTOUCHED (managed agents are already org-isolated via
   * The journal prefix, backward compat preserved). So the gate kicks in ONLY when: the name IS in the
   * List AND is invisible to the caller.
   */
  async function agentGate(c: Context, name: string): Promise<Response | undefined> {
    if (!gnl) return undefined; // playground off → caller already gets a 501
    const m = (await gnl.listAgents()).find((a) => a.name === name);
    if (m && !agentVisibleToOrg(m, callerOrg(c))) return c.json({ error: `agent '${name}' not registered` }, 404);
    return undefined;
  }
  // Registered agent list (for the selector). Visible if read is open; running requires write.
  // Org-scoped: an org-bound caller only sees GLOBAL agents + agents whose `orgs` include their org.
  app.get('/agents', async (c) => {
    if (!(await allow(c.req.raw, 'read'))) return deny(c.req.raw, 'read');
    if (!gnl) return c.json([]);
    const org = callerOrg(c);
    const list = await gnl.listAgents();
    return c.json(list.filter((m) => agentVisibleToOrg(m, org)));
  });

  // ── Agent approval registry (governance) ────────────────────────────────────────────────────
  // @gnldev/server RECORDS each `config.agents` entry (fingerprinted) into the ROOT journal at its own
  // Boot — Studio only EXPOSES those same `__agent_registry__:<name>` records for review/approve/block;
  // It never computes a fingerprint itself (the playground runner is duck-typed via StudioAgentRunner
  // And doesn't carry the real AgentConfig — see its JSDoc above). Platform-level (never per-org, same
  // As /organizations) → gated by requirePlatformAdmin regardless of the org middleware.
  app.get('/agents/registry', async (c) => {
    if (!(await allow(c.req.raw, 'read'))) return deny(c.req.raw, 'read');
    { const denied = requirePlatformAdmin(c, 'an org-bound identity cannot view the agent registry (operator required)'); if (denied) return denied; }
    if (!writable || typeof rw.listKeys !== 'function') return c.json([]);
    try {
      return c.json(await listAgentRegistry(rawReader as unknown as Journal));
    } catch (e: any) {
      return c.json({ error: String(e?.message ?? e) }, 501);
    }
  });

  app.post('/agents/registry/:name/approve', async (c) => {
    if (!(await allow(c.req.raw, 'write'))) return deny(c.req.raw, 'write');
    { const denied = requirePlatformAdmin(c, 'an org-bound identity cannot approve an agent (operator required)'); if (denied) return denied; }
    if (!writable) return c.json({ error: 'agent registry requires a writable journal' }, 501);
    const name = decodeURIComponent(c.req.param('name'));
    const body = (await c.req.json().catch(() => ({}))) as { note?: string };
    const rec = await approveAgent(rawReader as unknown as Journal, name, actorOf(c), body.note);
    await audit(c, 'agent.approve', name, body.note !== undefined ? { note: body.note } : undefined);
    return c.json({ ok: true, record: rec });
  });

  app.post('/agents/registry/:name/block', async (c) => {
    if (!(await allow(c.req.raw, 'write'))) return deny(c.req.raw, 'write');
    { const denied = requirePlatformAdmin(c, 'an org-bound identity cannot block an agent (operator required)'); if (denied) return denied; }
    if (!writable) return c.json({ error: 'agent registry requires a writable journal' }, 501);
    const name = decodeURIComponent(c.req.param('name'));
    const body = (await c.req.json().catch(() => ({}))) as { note?: string };
    const rec = await blockAgent(rawReader as unknown as Journal, name, actorOf(c), body.note);
    await audit(c, 'agent.block', name, body.note !== undefined ? { note: body.note } : undefined);
    return c.json({ ok: true, record: rec });
  });

  // Run an agent (admin). The same runId as an approval → the suspended tool is released for free (resume for free).
  app.post('/agents/:name/run', async (c) => {
    if (!(await allowP(c.req.raw, 'agents:run'))) return deny(c.req.raw, 'write');
    if (!gnl) return c.json({ error: 'playground is not enabled' }, 501);
    const name = decodeURIComponent(c.req.param('name'));
    const gated = await agentGate(c, name);
    if (gated) return gated;
    const body = (await c.req.json().catch(() => ({}))) as any;
    if (!body.runId) return c.json({ error: 'runId is required (idempotency key)' }, 400);
    try {
      const mo = await managedOverrides(name, c);
      const r = await gnl.run(name, {
        runId: body.runId,
        prompt: body.prompt,
        messages: body.messages,
        threadId: body.threadId,
        resourceId: body.resourceId,
        approvals: body.approvals,
        model: body.model ?? mo?.model,
        temperature: body.temperature,
        topP: body.topP,
        system: body.system ?? mo?.system,
        ...(Array.isArray(body.tools) ? { tools: body.tools as string[] } : {}),
      });
      await audit(c, 'agent.run', name, { runId: body.runId, ...(mo && body.model == null ? { managedVersion: true } : {}) });
      // `finishReason` is here because without it an empty answer is unreadable. A run whose model
      // Returned nothing answers 200 with `text: ""` — identical, on the wire, to a model that
      // Legitimately chose to say nothing. Measured in the field: a provider returned an empty
      // Response with `finishReason: 'unknown'`, the run was journaled as completed, and the caller
      // Had no way to tell the two apart. The framework already knows which happened; it just was
      // Not saying. Additive field, so existing clients are unaffected.
      return c.json({ ok: true, runId: body.runId, text: r.text, interrupts: r.interrupts ?? [], finishReason: r.finishReason });
    } catch (e: any) {
      return runErrorResponse(c, e) ?? c.json({ error: String(e?.message ?? e) }, 400);
    }
  });

  // Run an agent with streaming (admin) — the same SSE schema as @gnldev/server.
  app.post('/agents/:name/stream', async (c) => {
    if (!(await allowP(c.req.raw, 'agents:run'))) return deny(c.req.raw, 'write');
    if (!gnl?.stream) return c.json({ error: 'streaming is not enabled' }, 501);
    const name = decodeURIComponent(c.req.param('name'));
    const gated = await agentGate(c, name);
    if (gated) return gated;
    const body = (await c.req.json().catch(() => ({}))) as any;
    if (!body.runId) return c.json({ error: 'runId is required (idempotency key)' }, 400);
    let result: any;
    try {
      const mo = await managedOverrides(name, c);
      result = await gnl.stream(name, {
        runId: body.runId,
        prompt: body.prompt,
        messages: body.messages,
        threadId: body.threadId,
        resourceId: body.resourceId,
        approvals: body.approvals,
        model: body.model ?? mo?.model,
        temperature: body.temperature,
        topP: body.topP,
        system: body.system ?? mo?.system,
        ...(Array.isArray(body.tools) ? { tools: body.tools as string[] } : {}),
      });
    } catch (e: any) {
      // Same taxonomy as the non-streaming /agents/:name/run handler above: this catch fires
      // BEFORE the SSE body starts (gnl.stream() only sets up the run — pipeAgentStream() below
      // Is what actually streams), so a normal JSON error response is still safe here.
      return runErrorResponse(c, e) ?? c.json({ error: String(e?.message ?? e) }, 400);
    }
    await audit(c, 'agent.run', name, { runId: body.runId, stream: true });
    return pipeAgentStream(c, body.runId, result);
  });

  // ── Tools (if gnl.listTools is given) ─────────────────────────────────────────
  // Flat tool list (name, description, JSON schema, which agents). For schema-driven form generation.
  app.get('/tools', async (c) => {
    if (!(await allow(c.req.raw, 'read'))) return deny(c.req.raw, 'read');
    return c.json(gnl?.listTools ? await gnl.listTools() : []);
  });

  // Run a tool for TEST purposes (admin) — NON-DURABLE: no journal/guard. Watch out for side effects.
  app.post('/tools/:name/execute', async (c) => {
    if (!(await allow(c.req.raw, 'write'))) return deny(c.req.raw, 'write');
    if (!gnl?.runTool) return c.json({ error: 'tool execution is not enabled' }, 501);
    const name = decodeURIComponent(c.req.param('name'));
    const body = (await c.req.json().catch(() => ({}))) as { input?: unknown; durable?: boolean; approve?: { runId: string; toolCallId: string; approved: boolean } };
    const r = await gnl.runTool(name, body.input, { durable: !!body.durable, approve: body.approve });
    await audit(c, 'tool.exec', name, { durable: !!body.durable });
    return c.json(r.error ? { error: r.error, blocked: r.blocked, runId: r.runId } : { ok: true, result: r.result, runId: r.runId });
  });

  // ── Memory / Threads (if memory is given) ─────────────────────────────────────
  app.get('/threads', async (c) => {
    if (!(await allow(c.req.raw, 'read'))) return deny(c.req.raw, 'read');
    if (!resolvedMemory) return c.json([]);
    const resourceId = c.req.query('resourceId') || undefined;
    return c.json(await resolvedMemory.listThreads(resourceId));
  });
  app.get('/threads/:id/messages', async (c) => {
    if (!(await allow(c.req.raw, 'read'))) return deny(c.req.raw, 'read');
    if (!resolvedMemory) return c.json([]);
    return c.json(await resolvedMemory.getMessages(decodeURIComponent(c.req.param('id'))));
  });
  app.get('/threads/:id/working-memory', async (c) => {
    if (!(await allow(c.req.raw, 'read'))) return deny(c.req.raw, 'read');
    if (!resolvedMemory?.getWorkingMemory) return c.json({ value: null });
    return c.json({ value: (await resolvedMemory.getWorkingMemory(decodeURIComponent(c.req.param('id')))) ?? null });
  });
  app.patch('/threads/:id', async (c) => {
    if (!(await allow(c.req.raw, 'write'))) return deny(c.req.raw, 'write');
    if (!resolvedMemory?.updateThread) return c.json({ error: 'updateThread is not supported' }, 501);
    const patch = (await c.req.json().catch(() => ({}))) as { title?: string; metadata?: Record<string, unknown> };
    try {
      const thread = await resolvedMemory.updateThread(decodeURIComponent(c.req.param('id')), patch);
      await audit(c, 'thread.rename', decodeURIComponent(c.req.param('id')), patch);
      return c.json({ ok: true, thread });
    } catch (e) {
      return c.json({ error: String((e as Error)?.message ?? e) }, 400);
    }
  });
  app.delete('/threads/:id', async (c) => {
    if (!(await allow(c.req.raw, 'write'))) return deny(c.req.raw, 'write');
    if (!resolvedMemory?.deleteThread) return c.json({ error: 'deleteThread is not supported' }, 501);
    try {
      await resolvedMemory.deleteThread(decodeURIComponent(c.req.param('id')));
      await audit(c, 'thread.delete', decodeURIComponent(c.req.param('id')));
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: String((e as Error)?.message ?? e) }, 400);
    }
  });
  // Truncates a thread FROM a message index onward (destructive, e.g. for "retry from here"/branching
  // Flows) — deletes the message at afterIndex and everything after it (index base: getMessages, same
  // List the /threads/:id/messages route returns). afterIndex===-1 deletes the whole thread's messages.
  // 501 both when the adapter doesn't implement truncateMessages AND when it does but the underlying
  // Store can't support it (signaled by a `null` return) — same externally-observable outcome either way.
  app.delete('/threads/:id/messages', async (c) => {
    if (!(await allow(c.req.raw, 'write'))) return deny(c.req.raw, 'write');
    if (!resolvedMemory?.truncateMessages) return c.json({ error: 'truncateMessages is not supported' }, 501);
    const body = (await c.req.json().catch(() => ({}))) as { afterIndex?: unknown };
    if (typeof body.afterIndex !== 'number' || !Number.isFinite(body.afterIndex)) {
      return c.json({ error: 'afterIndex (number) is required' }, 400);
    }
    try {
      const id = decodeURIComponent(c.req.param('id'));
      const removed = await resolvedMemory.truncateMessages(id, body.afterIndex);
      if (removed == null) return c.json({ error: 'truncateMessages is not supported' }, 501);
      await audit(c, 'thread.truncate', id, { afterIndex: body.afterIndex, removed });
      return c.json({ ok: true, removed });
    } catch (e) {
      return c.json({ error: String((e as Error)?.message ?? e) }, 400);
    }
  });

  // ── Queue / Jobs (if queue is given) ──────────────────────────────────────────
  app.get('/jobs', async (c) => {
    if (!(await allow(c.req.raw, 'read'))) return deny(c.req.raw, 'read');
    if (!queue) return c.json([]);
    return c.json(await queue.listJobs());
  });

  // Re-queue a failed (dead-letter/qfail) job (if queue.retry is given — the host typically wraps
  // @gnldev/queue's retryJob). Only a TERMINAL-FAIL job can be retried: retrying a job that's still
  // Pending/locked would queue work the worker is ALREADY going to process a second time, causing a
  // DOUBLE-RUN — this protection lives on queue.retry's own side (returns null → 409).
  app.post('/jobs/:id/retry', async (c) => {
    if (!(await allow(c.req.raw, 'write'))) return deny(c.req.raw, 'write');
    if (!queue?.retry) return c.json({ error: 'job retry is not supported (queue not given or retry not implemented)' }, 501);
    const id = decodeURIComponent(c.req.param('id'));
    const newId = await queue.retry(id);
    if (newId == null) {
      return c.json({ error: `job '${id}' not found or not in a retryable state (only failed/dead-letter jobs can be retried)` }, 409);
    }
    await audit(c, 'job.retry', id, { newId });
    return c.json({ ok: true, id: newId });
  });

  // ── Cache (if cache is given): hit/miss ratio + manual invalidate (@gnldev/cache stats()/invalidate() duck-type) ──
  app.get('/cache/stats', async (c) => {
    if (!(await allow(c.req.raw, 'read'))) return deny(c.req.raw, 'read');
    if (!cache) return c.json({ hits: 0, misses: 0, hitRate: 0, size: 0 });
    return c.json(await cache.stats());
  });

  // Manual invalidate: if body.key is given, only that key; if not (best-effort — CacheStore doesn't
  // Offer key enumeration), all keys the host knows about are removed (see StudioCache.invalidate).
  app.post('/cache/invalidate', async (c) => {
    if (!(await allow(c.req.raw, 'write'))) return deny(c.req.raw, 'write');
    if (!cache?.invalidate) return c.json({ error: 'cache invalidate is not supported (cache not given or invalidate not implemented)' }, 501);
    const body = (await c.req.json().catch(() => ({}))) as { key?: unknown };
    const deleted = await cache.invalidate(body.key);
    await audit(c, 'cache.invalidate', body.key !== undefined ? String(body.key) : '*', { deleted });
    return c.json({ ok: true, deleted });
  });

  // ── Scheduler (@gnldev/scheduler trigger introspection): the journal is READ-ONLY, it needs NO separate
  // Running scheduler instance (see @gnldev/scheduler's `listTriggers` — reads the SAME sched:def:/
  // Sched:state:/sched:fail: keys as pollScheduler, never MUTATES any state). Returns an empty list if
  // The journal isn't writable + doesn't support listKeys (or the host doesn't use @gnldev/scheduler at all) (same pattern as queue/jobs).
  app.get('/scheduler/triggers', async (c) => {
    if (!(await allow(c.req.raw, 'read'))) return deny(c.req.raw, 'read');
    if (!writable || typeof rw.listKeys !== 'function' || typeof rw.get !== 'function') return c.json([]);
    return c.json(await listTriggers(rw as unknown as Journal));
  });

  // ── Knowledge / vector search (if vectors is given) ────────────────────────────
  app.post('/knowledge/search', async (c) => {
    if (!(await allow(c.req.raw, 'read'))) return deny(c.req.raw, 'read');
    if (!vectors) return c.json([]);
    const body = (await c.req.json().catch(() => ({}))) as { query?: string; topK?: number };
    if (!body.query?.trim()) return c.json([]);
    return c.json(await vectors.search(body.query, body.topK));
  });

  // ── Workflows (if gnl.listWorkflows or the workflows option is given) ──────────
  app.get('/workflows', async (c) => {
    if (!(await allow(c.req.raw, 'read'))) return deny(c.req.raw, 'read');
    const rawCode = gnl?.listWorkflows ? await gnl.listWorkflows() : (workflows ? await workflows.listWorkflows() : []);
    const code: WorkflowMeta[] = rawCode.map((w) => ({ ...w, source: 'code' as const, ...(workflowInputs?.[w.name] ? { input: workflowInputs[w.name] } : {}) }));
    const managed: WorkflowMeta[] = resolvedWfStore
      ? (await resolvedWfStore.list()).map((d) => ({ name: d.name, description: d.description, steps: d.steps.map((s) => ({ id: s.id, kind: 'agent' })), source: 'managed' as const }))
      : [];
    const codeNames = new Set(code.map((w) => w.name));
    return c.json([...code, ...managed.filter((m) => !codeNames.has(m.name))]);
  });

  // Run a workflow durably (admin) — give input, get step results back.
  app.post('/workflows/:name/run', async (c) => {
    if (!(await allow(c.req.raw, 'write'))) return deny(c.req.raw, 'write');
    const name = decodeURIComponent(c.req.param('name'));
    const body = (await c.req.json().catch(() => ({}))) as { input?: unknown; runId?: string; maxSteps?: number; dryRun?: boolean; resume?: Record<string, unknown> };
    // Try code-defined first.
    if (gnl?.runWorkflow) {
      const codeNames = gnl.listWorkflows ? (await gnl.listWorkflows()).map((w) => w.name) : [];
      if (codeNames.includes(name)) {
        if (body.dryRun) return c.json({ error: 'dry-run is only supported for managed workflows — code workflows require the real engine' }, 501);
        try {
          // P0.4: forward resume alongside runId/maxSteps (typed HITL payload — see StudioAgentRunner.runWorkflow).
          const wfOpts = {
            ...(body.runId ? { runId: body.runId } : {}),
            ...(body.maxSteps != null ? { maxSteps: body.maxSteps } : {}),
            ...(body.resume ? { resume: body.resume } : {}),
          };
          return c.json({ ok: true, ...(await gnl.runWorkflow(name, body.input, Object.keys(wfOpts).length ? wfOpts : undefined)) });
        } catch (e: any) {
          return c.json({ error: String(e?.message ?? e) }, 400);
        }
      }
    }
    // Managed workflow — compile it and run with the REAL engine (same journaling/suspend as code workflows).
    if (canRunManaged && (await resolvedWfStore!.get(name))) {
      try {
        const runId = body.runId ?? `${body.dryRun ? 'dry-' : ''}wf-${name}-${Date.now()}`;
        return c.json({ ok: true, ...(await runManaged(name, body.input, runId, body.maxSteps, body.dryRun, (n) => managedOverrides(n, c), body.resume)) });
      } catch (e: any) {
        return c.json({ error: String(e?.message ?? e) }, 400);
      }
    }
    if (resolvedWfStore && !compileWorkflow && (await resolvedWfStore.get(name)))
      return c.json({ error: 'running a managed workflow requires compileWorkflow (@gnldev/studio/workflow)' }, 501);
    if (!gnl?.runWorkflow && !canRunManaged) return c.json({ error: 'workflow execution is not enabled' }, 501);
    return c.json({ error: `workflow '${name}' not found` }, 404);
  });

  // Run a workflow LIVE (admin) — SSE: streams in real time as steps land in the journal (poll-to-stream).
  // Without changing the engine: start runWorkflow + poll the `<runId>:wf:*` keys. Requires listKeys+get.
  // What-if fork (workflow): copy the output of the first `upto` steps to a new runId → with the same
  // Input, the copied ones REPLAY on resume, and the selected step onward re-runs. The workflow
  // Counterpart of the agent fork (forkRun) — "what-if" analysis that can't be copied without a journal.
  app.post('/workflows/:name/runs/:id/fork', async (c) => {
    if (!(await allow(c.req.raw, 'write'))) return deny(c.req.raw, 'write');
    if (!writable || typeof rw.listKeys !== 'function') return c.json({ error: 'fork requires a writable journal (listKeys)' }, 501);
    const name = decodeURIComponent(c.req.param('name'));
    const src = decodeURIComponent(c.req.param('id'));
    const body = (await c.req.json().catch(() => ({}))) as { upto?: number; newRunId?: string };
    // Step order: code workflow metadata → otherwise the managed definition.
    let stepIds: string[] | undefined;
    if (gnl?.listWorkflows) stepIds = (await gnl.listWorkflows()).find((w) => w.name === name)?.steps.map((s) => s.id);
    if (!stepIds?.length && workflows) stepIds = (await workflows.listWorkflows()).find((w) => w.name === name)?.steps.map((s) => s.id);
    if (!stepIds?.length && resolvedWfStore) stepIds = (await resolvedWfStore.get(name))?.steps.map((s) => s.id);
    if (!stepIds?.length) return c.json({ error: `workflow '${name}' not found` }, 404);

    const upto = Math.max(0, Math.min(body.upto ?? stepIds.length, stepIds.length));
    const keep = new Set(stepIds.slice(0, upto));
    const dst = body.newRunId ?? `${src}:fork:${Date.now()}`;
    const prefix = `${src}:wf:`;
    const keys = await rw.listKeys!(prefix).catch(() => [] as string[]);
    let copied = 0;
    for (const k of keys) {
      const rest = k.slice(prefix.length);
      // Composite sub-keys are also attributed to their step: foreach[0], loop#2, nested:child …
      const owner = stepIds.find((sid) => rest === sid || rest.startsWith(sid + '[') || rest.startsWith(sid + '#') || rest.startsWith(sid + ':'));
      if (owner && keep.has(owner)) {
        await rw.put!(`${dst}:wf:${rest}`, await rw.get!(k));
        copied++;
      }
    }
    await audit(c, 'fork', src, { workflow: name, upto, newRunId: dst });
    return c.json({ ok: true, newRunId: dst, copied, keptSteps: [...keep] });
  });

  app.post('/workflows/:name/run-stream', async (c) => {
    if (!(await allow(c.req.raw, 'write'))) return deny(c.req.raw, 'write');
    if (!rw.listKeys || !rw.get) return c.json({ error: 'streaming requires a writable journal (listKeys+get)' }, 501);
    const name = decodeURIComponent(c.req.param('name'));
    const body = (await c.req.json().catch(() => ({}))) as { input?: unknown; runId?: string };
    const runId = body.runId || `wf-${name}-${Date.now()}`;

    // Code or managed? → pick the right starter. Both journal to `${runId}:wf:*` → poll-to-stream is shared.
    const codeNames = gnl?.listWorkflows ? (await gnl.listWorkflows()).map((w) => w.name) : [];
    const isCode = codeNames.includes(name);
    let begin: (() => Promise<any>) | null = null;
    if (isCode && gnl?.runWorkflow) {
      const runWf = gnl.runWorkflow.bind(gnl); // unbound method → loses this; bind it.
      begin = () => runWf(name, body.input, { runId });
    } else if (!isCode && canRunManaged && (await resolvedWfStore!.get(name))) {
      begin = () => runManaged(name, body.input, runId, undefined, undefined, (n) => managedOverrides(n, c));
    }
    if (!begin) {
      if (resolvedWfStore && !compileWorkflow && (await resolvedWfStore.get(name)))
        return c.json({ error: 'running a managed workflow requires compileWorkflow (@gnldev/studio/workflow)' }, 501);
      if (!gnl?.runWorkflow && !canRunManaged) return c.json({ error: 'workflow execution is not enabled' }, 501);
      return c.json({ error: `workflow '${name}' not found` }, 404);
    }

    const pre = `${runId}:wf:`;
    const jkeys = rw.listKeys.bind(rw);
    const jget = rw.get.bind(rw);
    const start = begin;
    return sseResponse(c, async (stream) => {
      await stream.writeSSE({ event: 'start', data: JSON.stringify({ runId }) });
      const seen = new Set<string>();
      const emitNew = async () => {
        const keys = await jkeys(pre).catch(() => [] as string[]);
        for (const k of keys) {
          if (seen.has(k)) continue;
          seen.add(k);
          const stepId = k.slice(pre.length);
          if (stepId === '_suspend') continue;
          const output = await jget(k).catch(() => undefined);
          await stream.writeSSE({ event: 'step', data: JSON.stringify({ stepId, output, ts: Date.now() }) });
        }
      };
      let settled = false;
      let result: any;
      let error: any;
      const p = start()
        .then((r) => { result = r; })
        .catch((e) => { error = e; })
        .finally(() => { settled = true; });
      while (!settled && !stream.aborted) { await emitNew(); await stream.sleep(120); }
      await p;
      await emitNew(); // final steps the poll didn't catch up to
      if (error) await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: String(error?.message ?? error) }) });
      else await stream.writeSSE({ event: result?.suspended ? 'suspended' : 'done', data: JSON.stringify(result ?? { runId }) });
    });
  });

  // The status of a workflow RUN (step outputs + suspend, from the journal) — open a past run / replay.
  app.get('/workflows/run/:runId', async (c) => {
    if (!(await allow(c.req.raw, 'read'))) return deny(c.req.raw, 'read');
    if (!rw.listKeys || !rw.get) return c.json({ error: 'wf run state requires listKeys+get' }, 501);
    const runId = decodeURIComponent(c.req.param('runId'));
    const pre = `${runId}:wf:`;
    const keys = await rw.listKeys(pre);
    const steps: { stepId: string; output: unknown }[] = [];
    let suspend: unknown = null;
    for (const k of keys) {
      const stepId = k.slice(pre.length);
      const v = await rw.get(k);
      if (stepId === '_suspend') suspend = v;
      else steps.push({ stepId, output: v });
    }
    return c.json({ runId, steps, suspended: !!suspend, suspend });
  });

  // Lists ALL runs of a workflow (persistent history; server-side instead of localStorage).
  // Extracts `wf-<name>-` prefixed runIds from the journal (pure-wf runs don't land in listRuns → listKeys).
  app.get('/workflows/:name/runs', async (c) => {
    if (!(await allow(c.req.raw, 'read'))) return deny(c.req.raw, 'read');
    if (!rw.listKeys || !rw.get) return c.json({ error: 'wf run listing requires listKeys+get' }, 501);
    const name = decodeURIComponent(c.req.param('name'));
    const limit = Math.max(1, Math.min(500, Number(c.req.query('limit')) || 100));
    const prefix = `wf-${name}-`;
    // Disambiguate sibling workflow prefix collisions (wf-order-… ⊃ wf-order-fulfillment-…).
    const siblings = gnl?.listWorkflows ? (await gnl.listWorkflows()).map((w) => w.name) : [];
    const longerSibs = siblings.filter((s) => s !== name && s.startsWith(name + '-'));
    const keys = await rw.listKeys(prefix);
    const byRun = new Map<string, { steps: Set<string>; suspend: boolean }>();
    for (const k of keys) {
      const sep = k.indexOf(':wf:');
      if (sep < 0) continue;
      const runId = k.slice(0, sep);
      if (!runId.startsWith(prefix)) continue;
      if (longerSibs.some((s) => runId.startsWith(`wf-${s}-`))) continue;
      const rest = k.slice(sep + ':wf:'.length);
      let e = byRun.get(runId);
      if (!e) { e = { steps: new Set(), suspend: false }; byRun.set(runId, e); }
      if (rest === '_suspend') e.suspend = true;
      else e.steps.add(rest);
    }
    const runs: { runId: string; startedAt?: number; steps: number; status: 'completed' | 'suspended'; suspended: boolean }[] = [];
    for (const [runId, e] of byRun) {
      let status: 'completed' | 'suspended' = 'completed';
      if (e.suspend) {
        // _suspend is sticky: if the suspended step's output now exists, the run was resumed and completed.
        const s = (await rw.get(`${runId}:wf:_suspend`).catch(() => null)) as { stepId?: string } | null;
        status = s?.stepId && e.steps.has(s.stepId) ? 'completed' : 'suspended';
      }
      const tail = runId.slice(prefix.length);
      runs.push({ runId, startedAt: /^\d+$/.test(tail) ? Number(tail) : undefined, steps: e.steps.size, status, suspended: status === 'suspended' });
    }
    runs.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0) || (a.runId < b.runId ? 1 : -1));
    return c.json(runs.slice(0, limit));
  });

  /**
   * P0.4 the suspended/completed/canceled workflow-run REGISTRY query — every run
   * (code OR managed) in ONE `wfrun:` prefix scan. Deliberately reimplemented INLINE against `rw` rather
   * Than importing @gnldev/workflow's `listWorkflowRuns`: the studio CORE stays decoupled from @gnldev/workflow
   * (see WorkflowLike/managed-workflow.ts — only the optional `./workflow` compiler subpath depends on
   * It), and `rw` here already goes through the org-scoped ALS bridge on GET (same isolation guarantee
   * Every other listKeys-based route in this file gets — see `reader`'s `scopedNow()` above). The
   * `wfrun:<runId>` key shape is a documented contract of @gnldev/workflow's workflow.ts (statusKey),
   * Stable to read directly without importing the package.
   */
  app.get('/workflows/runs', async (c) => {
    if (!(await allow(c.req.raw, 'read'))) return deny(c.req.raw, 'read');
    if (!rw.listKeys || !rw.get) return c.json({ error: 'workflow run listing requires listKeys+get' }, 501);
    const statusRaw = c.req.query('status');
    if (statusRaw != null && statusRaw !== 'suspended' && statusRaw !== 'completed' && statusRaw !== 'canceled') {
      return c.json({ error: `invalid status '${statusRaw}' (expected 'suspended', 'completed', or 'canceled')` }, 400);
    }
    type WfRunRow = { runId: string; status: string; stepId?: string; waitId?: string; reason?: unknown; updatedAt: number };
    const keys = await rw.listKeys('wfrun:');
    const limitRaw = c.req.query('limit');

    // API-03: `limit` omitted → the legacy flat-array contract, UNCHANGED (older callers — e.g.
    // Packages/server — never send `limit` and must keep getting a bare array back).
    if (limitRaw === undefined) {
      const out: WfRunRow[] = [];
      for (const k of keys) {
        const st = (await rw.get(k)) as WfRunRow | undefined;
        if (st && (!statusRaw || st.status === statusRaw)) out.push(st);
      }
      out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      return c.json(out);
    }

    // API-03: `limit` given → a paged `{items,nextCursor}` envelope (same shape GET /runs above uses)
    // AND a bounded scan. This route used to `get` EVERY `wfrun:*` key on every poll regardless of how
    // Few rows the caller actually wanted (Workflows.tsx refetches it repeatedly for the suspended-runs
    // Inbox) — a 20k-run registry meant ~20k reads just to show 3 suspended rows. `listKeys` returns keys
    // Oldest-first (created_at ASC — see journal.ts/postgres-storage.ts), so reversing gives newest-first;
    // `cursor` is an offset into that reversed order, and the scan stops as soon as `limit` matches are
    // Found (the `status` filter still can't be pushed into the key shape itself, so this is the cheapest
    // Bound available without changing the `wfrun:` record format).
    const limit = Math.min(Math.max(Math.floor(Number(limitRaw)) || 0, 1), 500);
    const start = Math.max(Math.floor(Number(c.req.query('cursor'))) || 0, 0);
    const window = [...keys].reverse().slice(start);

    const out: WfRunRow[] = [];
    let scanned = 0;
    if (typeof rw.getMany === 'function') {
      // ONE batched round-trip for the whole remaining window instead of a `get` call per key (same
      // Pattern as /metrics/runs above) — the early exit below still keeps the RESPONSE bounded even
      // Though the batch itself already happened.
      const values = await rw.getMany<WfRunRow>(window);
      for (; scanned < values.length; scanned++) {
        const st = values[scanned];
        if (st && (!statusRaw || st.status === statusRaw)) out.push(st);
        if (out.length >= limit) { scanned++; break; }
      }
    } else {
      for (; scanned < window.length; scanned++) {
        const st = (await rw.get(window[scanned]!)) as WfRunRow | undefined;
        if (st && (!statusRaw || st.status === statusRaw)) out.push(st);
        if (out.length >= limit) { scanned++; break; }
      }
    }
    out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const nextCursor = scanned < window.length ? String(start + scanned) : undefined;
    return c.json({ items: out, nextCursor });
  });

  /**
   * D3-A durably cancels a workflow run — studio's counterpart of
   * @gnldev/server's POST /workflows/runs/:id/cancel (P0.4). Reimplemented INLINE against `rw` rather than
   * Importing @gnldev/workflow's `cancelWorkflowRun` — same reason GET /workflows/runs above is inline
   * (the studio CORE stays decoupled from @gnldev/workflow; only the optional `./workflow` compiler
   * Subpath depends on it). Writes the SAME two keys `cancelWorkflowRun` does: the per-run
   * `${runId}:wf:_canceled` flag (checked by runResumable before every step — reaches a run in flight
   * On ANOTHER worker at its next step boundary) and the `wfrun:<runId>` registry record with
   * `status:'canceled'` (so it moves out of the suspended-runs inbox and GET /workflows/runs?status=canceled
   * Picks it up) — see workflow-p04.test.ts's own comment on this exact key shape. A run whose registry
   * Record already reports `completed` is a no-op (nothing left to cancel); visibility follows the SAME
   * Pattern GET /workflows/runs/:id (fork) uses elsewhere: EITHER the registry record OR the `_suspend`
   * Marker must exist, otherwise this is a cross-org/nonexistent runId → 404 (no existence leak).
   */
  app.post('/workflows/runs/:id/cancel', async (c) => {
    if (!(await allow(c.req.raw, 'write'))) return deny(c.req.raw, 'write');
    if (!writable || typeof rw.listKeys !== 'function' || typeof rw.get !== 'function' || typeof rw.put !== 'function') {
      return c.json({ error: 'workflow cancel requires a writable journal (listKeys+get+put)' }, 501);
    }
    const runId = decodeURIComponent(c.req.param('id'));
    const statusKey = `wfrun:${runId}`;
    const existing = (await rw.get!(statusKey).catch(() => undefined)) as
      { status?: string; stepId?: string; waitId?: string } | undefined;
    const visible = existing !== undefined || (await rw.get!(`${runId}:wf:_suspend`).catch(() => undefined)) !== undefined;
    if (!visible) return c.json({ error: `workflow run '${runId}' not found` }, 404);
    if (existing?.status === 'completed') {
      await audit(c, 'workflow.cancel', runId, { cancelled: false });
      return c.json({ ok: true, cancelled: false, note: 'run already completed' });
    }
    const now = Date.now();
    await rw.put!(`${runId}:wf:_canceled`, { at: now });
    await rw.put!(statusKey, {
      runId, status: 'canceled', updatedAt: now,
      ...(existing?.stepId ? { stepId: existing.stepId } : {}),
      ...(existing?.waitId ? { waitId: existing.waitId } : {}),
    });
    await audit(c, 'workflow.cancel', runId, { cancelled: true });
    return c.json({ ok: true, cancelled: true });
  });

  // ── Workflow CRUD (managed; if resolvedWfStore exists) ─────────────────────────
  app.get('/workflows/:name/def', async (c) => {
    if (!(await allow(c.req.raw, 'read'))) return deny(c.req.raw, 'read');
    if (!resolvedWfStore) return c.json({ error: 'no workflow store is available' }, 501);
    const name = decodeURIComponent(c.req.param('name'));
    const def = await resolvedWfStore.get(name);
    if (!def) return c.json({ error: 'not found' }, 404);
    return c.json(def);
  });

  app.post('/workflows', async (c) => {
    if (!(await allowP(c.req.raw, 'workflow:write'))) return deny(c.req.raw, 'write');
    if (!resolvedWfStore) return c.json({ error: 'no workflow store is available' }, 501);
    const body = (await c.req.json().catch(() => null)) as WorkflowDef | null;
    if (!body?.name?.trim()) return c.json({ error: 'name is required' }, 400);
    const now = Date.now();
    const def: WorkflowDef = { ...body, steps: body.steps ?? [], createdAt: body.createdAt ?? now, updatedAt: now };
    await resolvedWfStore.set(def);
    await audit(c, 'workflow.create', def.name);
    return c.json({ ok: true, workflow: { name: def.name, description: def.description, steps: def.steps.map((s) => ({ id: s.id, kind: 'agent' })), source: 'managed' } });
  });

  app.put('/workflows/:name', async (c) => {
    if (!(await allowP(c.req.raw, 'workflow:write'))) return deny(c.req.raw, 'write');
    if (!resolvedWfStore) return c.json({ error: 'no workflow store is available' }, 501);
    const name = decodeURIComponent(c.req.param('name'));
    const body = (await c.req.json().catch(() => null)) as Partial<WorkflowDef> | null;
    if (!body) return c.json({ error: 'invalid body' }, 400);
    const existing = await resolvedWfStore.get(name);
    const def: WorkflowDef = { ...existing, ...body, steps: body.steps ?? existing?.steps ?? [], name, updatedAt: Date.now(), createdAt: existing?.createdAt ?? Date.now() };
    await resolvedWfStore.set(def);
    await audit(c, 'workflow.update', name);
    return c.json({ ok: true });
  });

  app.delete('/workflows/:name', async (c) => {
    if (!(await allowP(c.req.raw, 'workflow:write'))) return deny(c.req.raw, 'write');
    if (!resolvedWfStore) return c.json({ error: 'no workflow store is available' }, 501);
    const name = decodeURIComponent(c.req.param('name'));
    const codeNames = gnl?.listWorkflows ? (await gnl.listWorkflows()).map((w) => w.name) : [];
    if (codeNames.includes(name)) return c.json({ error: 'a code-defined workflow cannot be deleted' }, 403);
    await resolvedWfStore.delete(name);
    await audit(c, 'workflow.delete', name);
    return c.json({ ok: true });
  });

  // ── Scorers / Evals (if scorers is given) ─────────────────────────────────────
  app.get('/scorers', async (c) => {
    if (!(await allow(c.req.raw, 'read'))) return deny(c.req.raw, 'read');
    return c.json(scorers ? await scorers.list() : []);
  });
  // Score a run with the selected scorers (read; deterministic, reads from a journaled run).
  // ── Managed agent versions: list / new version / promote (rollback = promoting an older version) ──
  app.get('/managed-agents', async (c) => {
    if (!(await allow(c.req.raw, 'read'))) return deny(c.req.raw, 'read');
    const store = agentStoreFor(c); // org-scoped: a bound identity sees only its own versions
    if (!store) return c.json({ agents: [] });
    return c.json({ agents: await store.list() });
  });

  app.post('/managed-agents', async (c) => {
    if (!(await allow(c.req.raw, 'write'))) return deny(c.req.raw, 'write');
    const store = agentStoreFor(c); // a bound identity manages only ITS OWN org's versions
    if (!store) return c.json({ error: 'agent versioning requires a writable journal (listKeys)' }, 501);
    const body = (await c.req.json().catch(() => null)) as { name?: string; model?: string; system?: string; maxSteps?: number; note?: string } | null;
    if (!body?.name?.trim() || !body?.model?.trim()) return c.json({ error: 'name and model are required' }, 400);
    const name = body.name.trim();
    // GOVERNANCE OVER CODE-DEFINED AGENTS (deliberate boundary — no-code builder is deferred):
    // A managed version only OVERRIDES an existing code agent's model/system (see managedOverrides).
    // Versioning a name with NO code counterpart would create a record that can never run (the registry
    // Throws "not registered"). Reject it at the source so the managed layer stays honest — it governs
    // Code agents; it is not a no-code agent factory. Enforced only when a runner is wired (`gnl`): with
    // No runner the studio is store-only (nothing runs anyway) and the UI's agent dropdown is empty, so
    // There's nothing to guard against. (An org-bound caller sees the same code registry.)
    const isCodeDefined = !gnl || (await gnl.listAgents()).some((a) => a.name === name);
    if (!isCodeDefined) return c.json({ error: `'${name}' is not a code-defined agent. Managed versions govern code-defined agents — define '${name}' in createGnl first.` }, 422);
    const rec = (await store.get(name)) ?? { name, active: null, versions: [] };
    const version = (rec.versions[rec.versions.length - 1]?.version ?? 0) + 1;
    rec.versions.push({
      version,
      model: body.model.trim(),
      ...(body.system != null ? { system: body.system } : {}),
      ...(body.maxSteps != null ? { maxSteps: body.maxSteps } : {}),
      ...(body.note ? { note: body.note } : {}),
      createdAt: Date.now(),
    });
    // The first version is auto-promoted to prod: if there's no active version yet (active == null), the
    // Newly created version becomes prod → a new managed agent works immediately (no "I created it but
    // Why doesn't it run" friction). Subsequent versions stay drafts (active untouched) → require promote.
    // EXCEPTION: if the eval gate (opts.evalGate) is configured, even the first version is NOT
    // Auto-promoted — otherwise it would land in prod without clearing the eval suite (a governance
    // Bypass). While the gate is on, the user promotes manually (the gate runs then).
    const autoPromoted = rec.active == null && !opts.evalGate;
    if (autoPromoted) rec.active = version;
    await store.put(rec);
    await audit(c, 'agent.version', name, { version });
    if (autoPromoted) await audit(c, 'agent.promote', name, { from: null, to: version, auto: true });
    return c.json({ ok: true, name, version, active: rec.active });
  });

  app.post('/managed-agents/:name/promote', async (c) => {
    if (!(await allow(c.req.raw, 'write'))) return deny(c.req.raw, 'write');
    const store = agentStoreFor(c);
    if (!store) return c.json({ error: 'agent versioning requires a writable journal (listKeys)' }, 501);
    const name = decodeURIComponent(c.req.param('name'));
    const rec = await store.get(name);
    if (!rec) return c.json({ error: `agent '${name}' not found` }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { version?: number };
    const target = rec.versions.find((v) => v.version === body.version);
    if (!target) return c.json({ error: `version ${body.version} not found (available: ${rec.versions.map((v) => v.version).join(', ')})` }, 400);

    // Eval gate: run the suite → all aggregate scores must clear the threshold; the decision is logged to audit.
    if (opts.evalGate) {
      if (!datasets) return c.json({ error: 'evalGate is configured but the datasets option is missing' }, 501);
      const minAvg = opts.evalGate.minAvg ?? 0.5;
      let aggregate: Record<string, number>;
      try {
        aggregate = (await datasets.run(opts.evalGate.datasetId)).aggregate;
      } catch (e: any) {
        return c.json({ error: `eval gate could not run: ${String(e?.message ?? e)}` }, 500);
      }
      const failing = Object.entries(aggregate).filter(([, v]) => v < minAvg);
      const passed = failing.length === 0;
      await audit(c, 'agent.gate', name, { version: target.version, datasetId: opts.evalGate.datasetId, minAvg, aggregate, passed });
      if (!passed) {
        return c.json({
          error: `eval gate FAILED: ${failing.map(([k, v]) => `${k}=${v.toFixed(2)}<${minAvg}`).join(', ')} — promote rejected`,
          aggregate,
        }, 412);
      }
    }

    const from = rec.active;
    rec.active = target.version;
    await store.put(rec);
    await audit(c, 'agent.promote', name, { from, to: target.version });
    return c.json({ ok: true, name, active: rec.active, previous: from });
  });

  // PERMANENTLY delete a managed agent record (with ALL its versions) — removes only the MANAGED record;
  // A code-defined agent (createGnl agents) doesn't come from this store, so it can't be deleted/affected.
  // If code + managed share a name, deleting only removes the managed override — the code agent (registry) keeps showing as-is.
  app.delete('/managed-agents/:name', async (c) => {
    if (!(await allow(c.req.raw, 'write'))) return deny(c.req.raw, 'write');
    const store = agentStoreFor(c); // a bound identity deletes only ITS OWN org's record
    if (!store) return c.json({ error: 'agent versioning requires a writable journal (listKeys)' }, 501);
    const name = decodeURIComponent(c.req.param('name'));
    const existing = await store.get(name);
    if (!existing) return c.json({ error: `agent '${name}' not found` }, 404);
    if (!store.delete) return c.json({ error: 'agent deletion requires journal deletePrefix support (Sqlite/Postgres/InMemory provide it)' }, 501);
    await store.delete(name);
    await audit(c, 'agent.delete', name, { versions: existing.versions.length, hadActive: existing.active != null });
    return c.json({ ok: true, name });
  });

  // Delete a SINGLE VERSION. The ACTIVE (prod) version cannot be deleted → promote another version first
  // (409). Since the active version is never deleted, the active pointer always stays valid. If the last
  // Version is deleted too, the agent record is removed entirely (same as whole-agent delete — needs store.delete; only in that case).
  app.delete('/managed-agents/:name/versions/:version', async (c) => {
    if (!(await allow(c.req.raw, 'write'))) return deny(c.req.raw, 'write');
    const store = agentStoreFor(c);
    if (!store) return c.json({ error: 'agent versioning requires a writable journal (listKeys)' }, 501);
    const name = decodeURIComponent(c.req.param('name'));
    const version = Number(c.req.param('version'));
    const rec = await store.get(name);
    if (!rec) return c.json({ error: `agent '${name}' not found` }, 404);
    if (!rec.versions.some((v) => v.version === version)) {
      return c.json({ error: `version ${version} not found (available: ${rec.versions.map((v) => v.version).join(', ')})` }, 400);
    }
    if (rec.active === version) {
      return c.json({ error: `active (prod) version v${version} cannot be deleted — promote another version first` }, 409);
    }
    rec.versions = rec.versions.filter((v) => v.version !== version);
    if (rec.versions.length === 0) {
      if (!store.delete) return c.json({ error: 'deleting the last version requires journal deletePrefix support' }, 501);
      await store.delete(name);
    } else {
      await store.put(rec);
    }
    await audit(c, 'agent.version-delete', name, { version, remaining: rec.versions.length });
    return c.json({ ok: true, name, version, active: rec.active, remaining: rec.versions.length });
  });

  app.post('/runs/:id/score', async (c) => {
    if (!(await allow(c.req.raw, 'read'))) return deny(c.req.raw, 'read');
    if (!scorers) return c.json({ error: 'scorers is not enabled' }, 501);
    const id = decodeURIComponent(c.req.param('id'));
    const body = (await c.req.json().catch(() => ({}))) as { scorers?: string[]; expected?: string };
    try {
      return c.json({ ok: true, ...(await scorers.score(id, body.scorers ?? [], { expected: body.expected })) });
    } catch (e: any) {
      return c.json({ error: String(e?.message ?? e) }, 400);
    }
  });

  // ── Evals / Datasets (if datasets is given) ───────────────────────────────────
  app.get('/datasets', async (c) => ((await allow(c.req.raw, 'read')) ? c.json(datasets ? await datasets.list() : []) : deny(c.req.raw, 'read')));
  // Run a dataset suite (admin — runs the agent → LLM). Returns a result table + aggregate.
  app.post('/datasets/:id/run', async (c) => {
    if (!(await allow(c.req.raw, 'write'))) return deny(c.req.raw, 'write');
    if (!datasets) return c.json({ error: 'datasets is not enabled' }, 501);
    const id = decodeURIComponent(c.req.param('id'));
    const body = (await c.req.json().catch(() => ({}))) as { scorers?: string[] };
    try {
      return c.json({ ok: true, ...(await datasets.run(id, { scorers: body.scorers })) });
    } catch (e: any) {
      return c.json({ error: String(e?.message ?? e) }, 400);
    }
  });

  // ── A2A Networks (if the a2a option is on) — extracts agent-to-agent edges from the journal ───────
  app.get('/a2a-network', async (c) => {
    if (!(await allow(c.req.raw, 'read'))) return deny(c.req.raw, 'read');
    if (!a2a) return c.json([]);
    const runs = await reader.listRuns();
    const edges: { parentRunId: string; remoteAgent: string; remoteRunId?: string; status: string }[] = [];
    for (const r of runs) {
      const entries = await reader.readRun(r.runId);
      for (const e of entries) {
        const out: any = (e.value as any)?.output;
        if (e.kind === 'tool' && out && typeof out === 'object' && out.remoteAgent) {
          edges.push({ parentRunId: r.runId, remoteAgent: String(out.remoteAgent), remoteRunId: out.runId, status: (e.value as any)?.status ?? '?' });
        }
      }
    }
    return c.json(edges);
  });

  // ── MCP Servers (if mcp is given) — list each client's tools ─────────
  app.get('/mcp-servers', async (c) => {
    if (!(await allow(c.req.raw, 'read'))) return deny(c.req.raw, 'read');
    if (!mcp?.length) return c.json([]);
    const out: { id: string; name?: string; tools: unknown[]; error?: string }[] = [];
    for (const s of mcp) {
      try {
        const { tools } = await s.client.listTools();
        out.push({ id: s.id, name: s.name, tools });
      } catch (e: any) {
        out.push({ id: s.id, name: s.name, tools: [], error: String(e?.message ?? e) });
      }
    }
    return c.json(out);
  });

  return app;
}

/** **Studio Admin** (HTML UI only). Points at the local/remote API via `apiBase`; can be served statically/separately. */
function studioAdminApp (opts: { apiBase?: string } = {}): Hono {
  const app = new Hono();
  app.get('/openapi.json', (c) => c.json(openapiSpec(opts.apiBase ?? '')));
  // The page carries its own <meta> CSP, but the spec IGNORES frame-ancestors in meta form — so the
  // one directive that stops this admin page being framed for clickjacking ("Execute" sits on it) was
  // dead. The server owns this route, so the header goes on here; the meta stays for other hostings.
  app.get('/swagger', (c) => {
    c.header('Content-Security-Policy', "frame-ancestors 'none'");
    c.header('X-Frame-Options', 'DENY'); // the same statement for anything old enough to predate CSP
    return c.html(swaggerHtml(opts.apiBase ?? ''));
  });
  // Prefer the prebuilt React SPA (@gnldev/studio-ui) first; fall back to the old single-file HTML if there's no build.
  if (!mountSpa(app, opts.apiBase ?? '')) app.get('/', (c) => c.html(notBuiltHtml()));
  return app;
}

/**
 * A convenience that combines Admin + API into a single app (backward compatible). Admin at '/', API at '/api/*'.
 * Pass `apiBase` for the prefix it will be mounted at (e.g. '/studio' → admin fetches against /studio/api).
 */
function studioAppApp (input: JournalReader | StudioAppOptions): Hono {
  const opts: StudioAppOptions = isReader(input) ? { reader: input } : input;
  const app = new Hono();
  app.route('/api', studioApiApp(opts));
  app.get('/openapi.json', (c) => c.json(openapiSpec(opts.apiBase ?? '')));
  // The page carries its own <meta> CSP, but the spec IGNORES frame-ancestors in meta form — so the
  // one directive that stops this admin page being framed for clickjacking ("Execute" sits on it) was
  // dead. The server owns this route, so the header goes on here; the meta stays for other hostings.
  app.get('/swagger', (c) => {
    c.header('Content-Security-Policy', "frame-ancestors 'none'");
    c.header('X-Frame-Options', 'DENY'); // the same statement for anything old enough to predate CSP
    return c.html(swaggerHtml(opts.apiBase ?? ''));
  });
  // Prefer the prebuilt React SPA (@gnldev/studio-ui) first; fall back to the old single-file HTML if there's no build.
  if (!mountSpa(app, opts.apiBase ?? '')) app.get('/', (c) => c.html(notBuiltHtml()));
  return app;
}

/**
 * The public factories. Each returns a fetch handler, not a Hono app — see `handler.ts` for why.
 *
 * Hono host:      app.mount('/studio', createStudioApp(...))
 * Anything else:  toNodeHandler(createStudioApp(...))   // @gnldev/studio/node
 * Standalone:     serve({ fetch: createStudioApp(...).fetch })
 */
export function createStudioApi (input: JournalReader | StudioApiOptions): FetchHandler {
  return toFetchHandler(studioApiApp(input));
}
export function createStudioAdmin (opts: { apiBase?: string } = {}): FetchHandler {
  return toFetchHandler(studioAdminApp(opts));
}
export function createStudioApp (input: JournalReader | StudioAppOptions): FetchHandler {
  return toFetchHandler(studioAppApp(input));
}

// Backward-compatible type alias.
export type StudioOptions = StudioApiOptions;
