// Typed API client (@gnl/studio JSON endpoints) + react-query hooks + SSE helpers.
import { useEffect } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { config } from './config';
import { authHeader, getToken } from './auth';

// ── Types (structurally compatible with server.ts responses) ────────────────
export interface Capabilities {
  // NOTE: `chat` = the host's optional POST /chat (non-streaming, embedder/programmatic) endpoint. It is
  // DELIBERATELY not surfaced in Studio UI — interactive chat is covered by Playground (streaming,
  // thread/tool/approval); a separate Chat panel would just be redundant surface. The flag is kept
  // for embedder endpoint discovery.
  resume: boolean; chat: boolean; fork: boolean; playground: boolean; stream: boolean;
  /** Saga: the host wired compensateRun → the run detail offers the (irreversible) Unwind action. */
  compensate: boolean;
  tools: boolean; toolExec: boolean; toolExecDurable: boolean; memory: boolean;
  workflows: boolean; workflowExec: boolean; scorers: boolean; datasets: boolean; mcp: boolean; a2a: boolean;
  queue: boolean; knowledge: boolean; workflowManage: boolean;
  /** "Retry" action in the Jobs view (on if the host implements queue.retry). */
  queueManage?: boolean;
  /** Cache view (@gnl/cache hit/miss ratio + size — on if the host passed the `cache` option). */
  cache?: boolean;
  /** Manual invalidate button in the Cache view (on if the host implements cache.invalidate). */
  cacheManage?: boolean;
  /** Scheduler view (@gnl/scheduler trigger introspection) — on when the journal is writable + listKeys,
   *  no separate host option required (list comes back empty if the host doesn't use @gnl/scheduler). */
  scheduler?: boolean;
  // Auth (opt-in): authRequired → the UI requires login. The rest unlock premium surfaces if the paid @gnl/auth-ee is active.
  authRequired?: boolean; sso?: boolean; rbac?: boolean; audit?: boolean; multiOrganization?: boolean; users?: boolean;
  // EE license info (flows from auth-ee capabilities): plan badge + expiry warning.
  plan?: string; licenseExp?: number;
  // Governance surfaces: approvals inbox / audit log / organization counters (server opt-in flags).
  approvals?: boolean; organizations?: boolean; org?: boolean; agentVersions?: boolean; policy?: boolean; evalGate?: boolean; purge?: boolean; retention?: boolean;
  /** W5: replay-based regression ("rerun" + decision-point diff) — requires a writable journal. */
  regression?: boolean;
  /** Organization budgets living in the journal can be edited from the UI (writable journal). */
  budgetManage?: boolean;
  /** Create/delete organizations (writable + listKeys). */
  orgManage?: boolean;
  /** User management (if the host provided a userStore). */
  userManage?: boolean;
  /** OTEL export button (on if the host passed opts.otelExport — exports the run trace to an external APM). */
  otelExport?: boolean;
  /** Audit reports (PII/moderation/prompt-injection processor findings) — on when the journal is
   *  writable+listKeys (same auto-detection pattern as scheduler/audit, no separate host option needed). */
  processors?: boolean;
  /** D3-A: durable-flag-only agent run cancel (POST /runs/:id/cancel) — no in-process abort in studio,
   *  the run stops at its NEXT fresh model step wherever it's running. */
  runCancel?: boolean;
  /** D3-A: durable workflow-run cancel (POST /workflows/runs/:id/cancel) — same registry surface as the
   *  suspended-runs inbox (GET /workflows/runs). */
  workflowRunCancel?: boolean;
  /** Agent approval registry (governance): review/approve/block code-defined agents — on when the host's
   *  journal is writable + listKeys (same auto-detection pattern as audit/scheduler). */
  agentRegistry?: boolean;
}

/** Fetch error: carries the HTTP status → the UI can redirect to login on 401/403. */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * Bug-investigation fix: a clean message to show the USER for an error.
 * Returns the `message` of `ApiError`/`Error` (without the technical "ApiError:" prefix — `String(e)`
 * used to add that). Since `http()` now puts the server's error body (`{error}`) into the message,
 * toasts show meaningful text. Use this in all views' toast/error display.
 */
export function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return 'Unknown error';
}

// ── F6.2: session-rejection detection (pure logic — tested) ─────────────────
/** Is the error an ApiError with HTTP 401/403? (token invalid/revoked/unauthorized). */
export function isAuthError(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.status === 403);
}

/**
 * Mid-session 401/403 → should we fall back to a clean login?
 * Returns true ONLY when auth is ON (authRequired) AND a token is present. When there is no
 * token (we're already on the Login screen), always returns false to avoid a re-login loop —
 * the 401 there is shown by the Login component with its own error message.
 */
export function shouldForceReauth(input: { err: unknown; authRequired: boolean; hasToken: boolean }): boolean {
  return input.authRequired && input.hasToken && isAuthError(input.err);
}

/**
 * Bug-investigation fix #4: react-query retry — 401/403 (token invalid/revoked/unauthorized) isn't
 * worth retrying; App.tsx already falls back to a clean login via forceReauthIf, so a retry would
 * only delay that reauth trigger. For other errors (network/5xx) retry at most once.
 */
export function queryRetry(failureCount: number, error: unknown): boolean {
  return !isAuthError(error) && failureCount < 1;
}
export interface JobStatus { id: string; type: string; status: string; attempts: number; }
/** Structurally compatible with @gnl/cache `stats()` (server GET /cache/stats). */
export interface CacheStats { hits: number; misses: number; hitRate: number; size: number; }
/** Structurally compatible with @gnl/scheduler `TriggerInfo` (server GET /scheduler/triggers). */
export interface SchedulerTrigger {
  id: string;
  name: string;
  kind: 'at' | 'every' | 'cron';
  /** kind='at' → epoch ms; kind='every' → period (ms); kind='cron' → a 5-field cron expression. */
  value: number | string;
  input?: unknown;
  nextRunAt: number;
  attempts: number;
  maxAttempts: number;
  fireCount: number;
  status: 'pending' | 'done' | 'failed';
  misfire: 'skip' | 'catchup';
  lastError?: string;
  lastErrorAt?: number;
}
export interface VectorMatch { id: string; text: string; score: number; metadata?: Record<string, unknown>; }
export interface DatasetMeta { id: string; cases: number; description?: string; }
export interface EvalDatasetResult { datasetId: string; cases: { caseId: string; output: string; scores: Record<string, { score: number; reason?: string }> }[]; aggregate: Record<string, number>; }
// threadId is optional: only present on runs tied to a thread (backend ready — server /runs).
export interface RunSummary { runId: string; status: 'completed' | 'suspended'; modelSteps: number; toolCalls: number; threadId?: string; agent?: string; }
/** S4 pagination envelope: GET /runs?limit=&cursor= (newest first). */
export interface RunsPage { items: RunSummary[]; nextCursor?: string; total: number; }
/** POST /retention/sweep response (purged is truncated to the first 100 runIds). */
export interface SweepResult { ok: boolean; scanned: number; purged: string[]; keptSuspended: number; keptNoTs: number; deletedEntries: number; }
export interface JournalEntry { key: string; runId: string; kind: 'model' | 'tool'; value: unknown; seq: number; ts?: number; }
export interface RunState { step: number; messages: any[]; pending: { toolCallId: string; toolName: string }[]; }
export interface DiffResult { step: number; added: any[]; pendingBefore: any[]; pendingAfter: any[]; }
export interface RunCost { inputTokens: number; outputTokens: number; cachedTokens?: number; totalTokens: number; costUsd: number; byModel?: Record<string, any>; }
export interface TraceSpan {
  name: string; kind: 'model' | 'tool'; startMs: number; durationMs: number;
  /** step order for model spans. */
  step?: number;
  /** index of the model span a tool span belongs to (nested tree); null for model spans. */
  parent?: number | null;
  attrs?: Record<string, unknown>;
}
export interface TraceResult { totalMs: number; cost: RunCost; spans: TraceSpan[]; }
/** Dynamic agent-network trace for a single run (matches server getNetworkTrace exactly). */
export type NetworkRouteDecision = { action: 'route'; agent: string; task: string } | { action: 'final'; answer: string };
export interface NetworkTraceStep { i: number; agent: string; task: string; text: string; }
export interface NetworkTrace { routes: { i: number | 'final'; decision: NetworkRouteDecision }[]; steps: NetworkTraceStep[]; }
/** Audit report (structurally identical to @gnl/durable recordProcessorReport/readProcessorReports). */
export interface ProcessorReport { name: string; phase: 'input' | 'output' | 'tool'; findings: unknown; ts?: number; }
/** A guard decision journaled by the runtime (duplicate guard / loop detection / maxToolCalls). */
export interface RunIncident {
  at: number;
  source: 'duplicate-guard' | 'loop-detection' | 'max-tool-calls' | 'taint-guard';
  action: 'warn' | 'reflect' | 'block' | 'suspend';
  toolName: string;
  toolCallId: string;
  message: string;
  detail?: Record<string, unknown>;
}
/** One materialized day (or all-time) bucket's counter fields — see @gnl/durable readMetricsSummary.
 *  `score:<name>:avg` fields (P2-skor) appear dynamically, one pair per scorer that has run in that bucket. */
export interface MetricsDayEntry { day: string; fields?: Record<string, number>; }
export interface Metrics {
  total: number; byStatus: Record<string, number>; costUsd: number; tokens: number;
  /** 'materialized' (counters available → byDay is populated) | 'scan' (legacy full scan, no byDay). Absent on older servers. */
  source?: 'materialized' | 'scan';
  /** Last N UTC day buckets, oldest first — only present when source === 'materialized'. */
  byDay?: MetricsDayEntry[];
}
export interface MetricsRun {
  runId: string; status: string; modelSteps: number; toolCalls: number;
  startTs: number | null; durationMs: number | null; costUsd: number; totalTokens: number;
}
export interface AgentMeta { name: string; model: string; system?: string; hasTools: boolean; maxSteps?: number; tools?: ToolMeta[]; orgs?: string[]; }
// ── Agent approval registry (governance — structurally compatible with @gnl/durable's agent-registry.ts) ──
export type AgentApprovalStatus = 'pending' | 'approved' | 'changed' | 'blocked';
export interface AgentRegistryRecord {
  name: string;
  status: AgentApprovalStatus;
  /** Fingerprint of the CURRENTLY-seen config; for `changed` this is the NEW (drifted) fingerprint. */
  fingerprint: string;
  /** The fingerprint that was approved (set on approve) — drift = fingerprint !== approvedFingerprint. */
  approvedFingerprint?: string;
  firstSeenAt: number;
  updatedAt: number;
  approvedBy?: string;
  approvedAt?: number;
  note?: string;
}
export interface ToolMeta { name: string; description?: string; guarded?: boolean; }
export interface ToolListItem { name: string; description?: string; guarded?: boolean; agents: string[]; shared?: boolean; inputSchema?: unknown; }
export interface WorkflowMeta { name: string; steps: { id: string; kind: string }[]; input?: { schema?: unknown; example?: unknown; description?: string }; source?: 'code' | 'managed'; description?: string; }
export interface WorkflowStepDef { id: string; agentName: string; prompt?: string; }
export interface WorkflowDef { name: string; description?: string; steps: WorkflowStepDef[]; createdAt?: number; updatedAt?: number; }
export interface ThreadRecord { id: string; resourceId?: string; title?: string; createdAt?: number; updatedAt?: number; }
export interface A2AEdge { parentRunId: string; remoteAgent: string; remoteRunId?: string; status?: string; }
export interface McpServerInfo { id: string; name?: string; tools: { name: string; description?: string; inputSchema?: unknown }[]; error?: string; }
export interface WorkflowRunResult { ok?: boolean; runId: string; output?: unknown; suspended?: boolean; paused?: boolean; canceled?: boolean; dryRun?: boolean; stepId?: string; reason?: unknown; steps: { id: string; kind: string; output: unknown }[]; }
export interface WorkflowRunSummary { runId: string; startedAt?: number; steps: number; status: 'completed' | 'suspended'; suspended: boolean; }
/**
 * D3-A: one record from the `wfrun:` run REGISTRY (GET /workflows/runs — P0.4), covering code AND
 * managed workflows in one scan. Deliberately does NOT carry the workflow's `name` — the registry key
 * is only `wfrun:<runId>`, so the workflow that produced a suspended run must be picked by the user
 * (see Workflows.tsx's suspended-runs inbox) rather than inferred.
 */
export interface WorkflowRunRegistryItem {
  runId: string;
  status: 'suspended' | 'completed' | 'canceled';
  /** Suspended: the step waiting on resume. Canceled: the step that would have run next (if known). */
  stepId?: string;
  /** Suspended: the waitId to key the resume payload by (`{ [waitId]: payload }`) — absent means the
   *  UI cannot address a precise resume target (honestly surfaced, see SuspendedRunsInbox). */
  waitId?: string;
  reason?: unknown;
  updatedAt: number;
}
export interface WorkflowRunState { runId: string; steps: { stepId: string; output: unknown }[]; suspended: boolean; suspend?: unknown; }
export type WfStreamEvent =
  | { type: 'start'; data: { runId: string } }
  | { type: 'step'; data: { stepId: string; output: unknown; ts: number } }
  | { type: 'suspended'; data: WorkflowRunResult }
  | { type: 'done'; data: WorkflowRunResult }
  | { type: 'error'; data: { error: string } };
export interface ToolExecResult { ok?: boolean; result?: unknown; error?: string; blocked?: 'deny' | 'approval'; runId?: string; }
export interface RunResult { ok?: boolean; runId?: string; text?: string; interrupts?: Interrupt[]; error?: string; }
export interface Interrupt { toolCallId: string; toolName: string; args?: unknown; reason?: string; }
// ── Governance types (approvals / audit / organizations endpoints) ──────────────
export interface ApprovalItem { runId: string; toolCallId: string; toolName: string; args?: unknown; reason?: string; }
export interface AuditItem { id: string; at?: number; actor: string; action: string; target: string; org?: string; detail?: unknown; }
export interface OrganizationRow {
  id: string; label?: string; runs: number; tokens: number; costUsd: number;
  /** inherited: true → the limit doesn't come from the organization's OWN document but from the default fallback. */
  budget?: { usdLimit?: number; tokenLimit?: number; exceeded: boolean; inherited: boolean };
}
export interface BudgetLimit { usdLimit?: number; tokenLimit?: number }
export interface StudioUser {
  id: string; email?: string; name?: string; roles: string[]; orgId?: string; createdAt?: number;
  /** EXPLICIT fine-grained permissions (checkbox-level override). Undefined → permission comes from roles. */
  permissions?: string[];
  /** The token's expiry instant (epoch ms). Absent = no expiry. */
  expiresAt?: number;
  /** Last successful authenticate instant (epoch ms). */
  lastUsedAt?: number;
  /** true → the token has been revoked (access cut off, user record still exists). */
  revoked?: boolean;
}
/** A single fine-grained permission the admin can ASSIGN to a user (checkbox in the UI). The catalog
 *  itself is GNL-team-owned/code-defined and read-only — customers assign, never invent, permission ids. */
export interface PermissionCatalogEntry { id: string; label: string; group?: string; description?: string; }
/** GET /permissions/catalog response. `enabled: false` → fine-grained RBAC is off (free tier / no license):
 *  the UI must not render the checkbox editor, only the existing role select applies. */
export interface PermissionCatalog {
  enabled: boolean;
  permissions: PermissionCatalogEntry[];
  /** role → pre-checked permission ids, used to seed the checkboxes when a role is picked. */
  rolePresets: Record<string, string[]>;
}
export interface AuditFilters { limit?: number; action?: string; q?: string; }
export interface AgentVersion { version: number; model: string; system?: string; maxSteps?: number; note?: string; createdAt: number; }
export interface ManagedAgentRecord { name: string; active: number | null; versions: AgentVersion[]; }
export interface PolicyRule { tool: string; action: 'allow' | 'deny' | 'require-approval'; reason?: string; }
export interface PolicyDoc { version: number; rules: PolicyRule[]; updatedAt?: number; }
// ── W5: regression (structurally compatible with @gnl/durable regression.ts — DiffDetail/DiffEntry/RunDiff) ──
export interface RegressionDiffDetail {
  textA?: string; textB?: string;
  toolCallsA?: { toolName: string; argsHash: string }[]; toolCallsB?: { toolName: string; argsHash: string }[];
  toolName?: string; argsHashA?: string; argsHashB?: string; statusA?: string; statusB?: string;
  outputA?: unknown; outputB?: unknown; note?: string;
}
export interface RegressionDiffEntry { step: number; kind: 'model' | 'tool'; durum: 'same' | 'changed' | 'missing' | 'added'; detay?: RegressionDiffDetail; }
export interface RegressionRunDiff {
  steps: RegressionDiffEntry[];
  divergentAt?: number;
  summary: { same: number; changed: number; missing: number; added: number };
}
export interface RegressionReport { ok?: boolean; baseRunId: string; newRunId: string; diff: RegressionRunDiff; score?: unknown; }

// ── fetch helpers ─────────────────────────────────────────────────────────
async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(config.apiBase + path, {
    ...init,
    // authHeader(): adds Authorization if a token exists (empty if auth is off → old behavior).
    headers: { 'content-type': 'application/json', ...authHeader(), ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    // Bug-investigation fix: the server produces a meaningful error body ({error:'...'}) —
    // this used to go unread, so the user only saw a generic "400 Bad Request". Read the body,
    // use the `.error` field as the message if present; fall back to the old generic text if unreadable.
    let msg = `${res.status} ${res.statusText} @ ${path}`;
    try {
      const body = await res.clone().json();
      if (body && typeof body.error === 'string' && body.error) msg = body.error;
    } catch {
      /* not JSON / empty body → keep the generic message */
    }
    throw new ApiError(res.status, msg);
  }
  const ct = res.headers.get('content-type') ?? '';
  return (ct.includes('application/json') ? res.json() : res.text()) as Promise<T>;
}
const get = <T>(p: string) => http<T>(p);
const post = <T>(p: string, body: unknown) => http<T>(p, { method: 'POST', body: JSON.stringify(body) });
const del = <T>(p: string) => http<T>(p, { method: 'DELETE' });
const patch = <T>(p: string, body: unknown) => http<T>(p, { method: 'PATCH', body: JSON.stringify(body) });

export const api = {
  capabilities: () => get<Capabilities>('/capabilities'),
  runs: () => get<RunSummary[]>('/runs'),
  runsPage: (limit: number, cursor?: string) =>
    get<RunsPage>(`/runs?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
  /** GDPR purge: permanently deletes ALL journal entries for the run (operator; caps.purge). */
  purgeRun: (id: string) => del<{ ok: boolean; deleted: number }>(`/runs/${encodeURIComponent(id)}`),
  /** TTL sweep: purges runs older than olderThanMs (suspended ones are kept by default). */
  retentionSweep: (body: { olderThanMs: number; keepSuspended?: boolean }) =>
    post<SweepResult>('/retention/sweep', body),
  run: (id: string) => get<JournalEntry[]>(`/runs/${encodeURIComponent(id)}`),
  state: (id: string, step?: number) => get<RunState>(`/runs/${encodeURIComponent(id)}/state${step != null ? `?step=${step}` : ''}`),
  diff: (id: string, step: number) => get<DiffResult>(`/runs/${encodeURIComponent(id)}/diff?step=${step}`),
  cost: (id: string) => get<RunCost>(`/runs/${encodeURIComponent(id)}/cost`),
  runScores: (id: string) => get<{ scores: Record<string, { score: number; reason?: string }> }>(`/runs/${encodeURIComponent(id)}/scores`),
  /** Audit reports: PII redaction/prompt-injection detection/moderation findings (only call when caps.processors is on). */
  processorReports: (id: string) => get<{ reports: ProcessorReport[] }>(`/runs/${encodeURIComponent(id)}/processors`),
  /** Guard incidents (duplicate guard / loop detection / maxToolCalls — warn/reflect/block/suspend). */
  runIncidents: (id: string) => get<{ incidents: RunIncident[] }>(`/runs/${encodeURIComponent(id)}/incidents`),
  /** Saga unwind (IRREVERSIBLE unless dryRun): undo the run's executed side effects in reverse order. */
  compensateRun: (id: string, dryRun = false) =>
    post<{ ok: boolean; report: { entries: { toolName?: string; status: string }[] } }>(`/runs/${encodeURIComponent(id)}/compensate`, { dryRun }),
  trace: (id: string) => get<TraceResult>(`/runs/${encodeURIComponent(id)}/trace`),
  // Gap closer: a single run's dynamic agent-network (runNetwork) routing decisions + steps.
  // Server GET /runs/:id/network already existed (getNetworkTrace); it just wasn't used in the UI.
  runNetwork: (id: string) => get<NetworkTrace>(`/runs/${encodeURIComponent(id)}/network`),
  metrics: () => get<Metrics>('/metrics'),
  metricsRuns: () => get<{ runs: MetricsRun[] }>('/metrics/runs'),
  agents: () => get<AgentMeta[]>('/agents'),
  tools: () => get<ToolListItem[]>('/tools'),
  workflows: () => get<WorkflowMeta[]>('/workflows'),
  threads: (resourceId?: string) => get<ThreadRecord[]>(`/threads${resourceId ? `?resourceId=${encodeURIComponent(resourceId)}` : ''}`),
  messages: (id: string) => get<any[]>(`/threads/${encodeURIComponent(id)}/messages`),
  workingMemory: (id: string) => get<unknown>(`/threads/${encodeURIComponent(id)}/working-memory`),
  renameThread: (id: string, title: string) => patch<{ ok: boolean; thread: ThreadRecord }>(`/threads/${encodeURIComponent(id)}`, { title }),
  deleteThread: (id: string) => del<{ ok: boolean }>(`/threads/${encodeURIComponent(id)}`),
  scorers: () => get<string[]>('/scorers'),
  datasets: () => get<DatasetMeta[]>('/datasets'),
  runDataset: (id: string, scorers?: string[]) => post<EvalDatasetResult>(`/datasets/${encodeURIComponent(id)}/run`, { scorers }),
  a2aNetwork: () => get<A2AEdge[]>('/a2a-network'),
  mcpServers: () => get<McpServerInfo[]>('/mcp-servers'),
  fork: (id: string, step: number, newRunId?: string) => post<any>(`/runs/${encodeURIComponent(id)}/fork`, { step, newRunId }),
  resume: (id: string, approvals: Record<string, boolean>) => post<RunResult>(`/runs/${encodeURIComponent(id)}/resume`, { approvals }),
  runAgent: (name: string, body: AgentRunBody) => post<RunResult>(`/agents/${encodeURIComponent(name)}/run`, body),
  jobs: () => get<JobStatus[]>('/jobs'),
  /** Re-queues a failed (dead-letter) job (only call when caps.queueManage is on). */
  retryJob: (id: string) => post<{ ok: boolean; id: string }>(`/jobs/${encodeURIComponent(id)}/retry`, {}),
  cacheStats: () => get<CacheStats>('/cache/stats'),
  /** If key is given, only that key is deleted; if not given, (best-effort) all keys known to the host
   *  are deleted (only call when caps.cacheManage is on). */
  invalidateCache: (key?: unknown) => post<{ ok: boolean; deleted: number }>('/cache/invalidate', { key }),
  schedulerTriggers: () => get<SchedulerTrigger[]>('/scheduler/triggers'),
  knowledgeSearch: (query: string, topK?: number) => post<VectorMatch[]>('/knowledge/search', { query, topK }),
  runWorkflow: (name: string, body: { input?: unknown; runId?: string; maxSteps?: number; dryRun?: boolean; resume?: Record<string, unknown> }) => post<WorkflowRunResult>(`/workflows/${encodeURIComponent(name)}/run`, body),
  workflowRun: (runId: string) => get<WorkflowRunState>(`/workflows/run/${encodeURIComponent(runId)}`),
  workflowRuns: (name: string, limit?: number) =>
    get<WorkflowRunSummary[]>(`/workflows/${encodeURIComponent(name)}/runs${limit ? `?limit=${limit}` : ''}`),
  /** D3-A: the cross-workflow `wfrun:` registry (GET /workflows/runs — P0.4), optionally filtered by status. */
  workflowRunsRegistry: (status?: 'suspended' | 'completed' | 'canceled') =>
    get<WorkflowRunRegistryItem[]>(`/workflows/runs${status ? `?status=${status}` : ''}`),
  /** D3-A: durably cancels a workflow run (studio's counterpart of @gnl/server's P0.4 cancel). */
  cancelWorkflowRun: (runId: string) =>
    post<{ ok: boolean; cancelled: boolean; note?: string }>(`/workflows/runs/${encodeURIComponent(runId)}/cancel`, {}),
  /** D3-A: durable-flag-only agent run cancel (stops at the run's next fresh model step, cross-worker). */
  cancelRun: (id: string) => post<{ ok: boolean; durable: boolean }>(`/runs/${encodeURIComponent(id)}/cancel`, {}),
  workflowDef: (name: string) => get<WorkflowDef>(`/workflows/${encodeURIComponent(name)}/def`),
  forkWorkflowRun: (name: string, runId: string, upto: number) =>
    post<{ ok: boolean; newRunId: string; copied: number; keptSteps: string[] }>(
      `/workflows/${encodeURIComponent(name)}/runs/${encodeURIComponent(runId)}/fork`, { upto },
    ),
  createWorkflow: (def: WorkflowDef) => post<{ ok: boolean; workflow: WorkflowMeta }>('/workflows', def),
  updateWorkflow: (name: string, def: Partial<WorkflowDef>) =>
    http<{ ok: boolean }>(`/workflows/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify(def) }),
  deleteWorkflow: (name: string) => del<{ ok: boolean }>(`/workflows/${encodeURIComponent(name)}`),
  executeTool: (name: string, body: { input?: unknown; durable?: boolean; approve?: { runId: string; toolCallId: string; approved: boolean } }) =>
    post<ToolExecResult>(`/tools/${encodeURIComponent(name)}/execute`, body),
  score: (id: string, scorers: string[], expected?: string) => post<any>(`/runs/${encodeURIComponent(id)}/score`, { scorers, expected }),
  approvals: () => get<{ items: ApprovalItem[] }>('/approvals'),
  audit: (params?: AuditFilters) => {
    const qs = new URLSearchParams();
    if (params?.limit != null) qs.set('limit', String(params.limit));
    if (params?.action) qs.set('action', params.action);
    if (params?.q) qs.set('q', params.q);
    const s = qs.toString();
    return get<{ items: AuditItem[] }>(`/audit${s ? `?${s}` : ''}`);
  },
  organizations: () => get<{ organizations?: OrganizationRow[]; defaultBudget?: BudgetLimit | null }>('/organizations'),
  // Budget management: the __budget__ document in the journal (id 'default' = fallback for all organizations).
  setOrgBudget: (id: string, budget: { usdLimit?: number | null; tokenLimit?: number | null }) =>
    http<{ ok: boolean; id: string; budget: BudgetLimit | null }>(`/organizations/${encodeURIComponent(id)}/budget`, { method: 'PUT', body: JSON.stringify(budget) }),
  // Create/delete an organization (operator identity only, no org context).
  createOrganization: (id: string, label?: string) =>
    http<{ ok: boolean; organization: { id: string; label?: string } }>('/organizations', { method: 'POST', body: JSON.stringify({ id, label }) }),
  deleteOrganization: (id: string) => del<{ ok: boolean; id: string; deleted: number }>(`/organizations/${encodeURIComponent(id)}`),
  // Users (paid): list/create/delete. create → token is returned ONCE.
  // platformAdmin/scope/strictMultiOrg are optional — older servers may not send them yet (the UI
  // treats a missing platformAdmin as false, see Agents.tsx's canSeeRegistry).
  me: () => get<{ id: string | null; roles: string[]; orgId: string | null; operator: boolean; platformAdmin?: boolean; scope?: string; strictMultiOrg?: boolean }>('/me'),
  users: () => get<{ users: StudioUser[] }>('/users'),
  /** Read-only permission catalog + role→preset map (RBAC, paid). `enabled:false` on free tier/no license. */
  permissionsCatalog: () => get<PermissionCatalog>('/permissions/catalog'),
  createUser: (input: { email?: string; name?: string; roles?: string[]; permissions?: string[]; orgId?: string; ttlMs?: number; expiresAt?: number }) =>
    http<{ ok: boolean; user: StudioUser; token: string }>('/users', { method: 'POST', body: JSON.stringify(input) }),
  deleteUser: (id: string) => del<{ ok: boolean; id: string }>(`/users/${encodeURIComponent(id)}`),
  /** Revoke a user's token WITHOUT deleting the user (501 if the host doesn't support revoke). */
  revokeUser: (id: string) => http<{ ok: boolean; id: string }>(`/users/${encodeURIComponent(id)}/revoke`, { method: 'POST' }),
  /** Update a user's roles and/or explicit permissions (token unchanged). An empty `permissions` array
   *  CLEARS the explicit override → authorization falls back to the role's default grants. */
  updateUser: (id: string, body: { roles?: string[]; permissions?: string[] }) =>
    patch<{ ok: boolean; user: StudioUser }>(`/users/${encodeURIComponent(id)}`, body),
  managedAgents: () => get<{ agents: ManagedAgentRecord[] }>('/managed-agents'),
  // Agent approval registry (governance, platform-admin only server-side — see caps.agentRegistry).
  agentRegistry: () => get<AgentRegistryRecord[]>('/agents/registry'),
  approveAgent: (name: string, note?: string) =>
    post<{ ok: boolean; record: AgentRegistryRecord }>(`/agents/registry/${encodeURIComponent(name)}/approve`, note ? { note } : {}),
  blockAgent: (name: string, note?: string) =>
    post<{ ok: boolean; record: AgentRegistryRecord }>(`/agents/registry/${encodeURIComponent(name)}/block`, note ? { note } : {}),
  policy: () => get<{ policy: PolicyDoc | null }>('/policy'),
  savePolicy: (rules: PolicyRule[]) => http<{ ok: boolean; version: number }>('/policy', { method: 'PUT', body: JSON.stringify({ rules }) }),
  createAgentVersion: (body: { name: string; model: string; system?: string; maxSteps?: number; note?: string }) =>
    post<{ ok: boolean; name: string; version: number; active: number | null }>('/managed-agents', body),
  promoteAgentVersion: (name: string, version: number) =>
    post<{ ok: boolean; name: string; active: number; previous: number | null }>(`/managed-agents/${encodeURIComponent(name)}/promote`, { version }),
  /** PERMANENTLY deletes a managed agent record (with ALL its versions) — only the managed override goes
   *  away; a code-defined agent (if any) keeps coming from the registry (501 if the host doesn't support deletePrefix). */
  deleteManagedAgent: (name: string) => del<{ ok: boolean; name: string }>(`/managed-agents/${encodeURIComponent(name)}`),
  /** Deletes a single VERSION. The active (prod) version cannot be deleted (409); once the last version is gone the agent disappears entirely. */
  deleteAgentVersion: (name: string, version: number) =>
    del<{ ok: boolean; name: string; version: number; active: number | null; remaining: number }>(`/managed-agents/${encodeURIComponent(name)}/versions/${version}`),
  // W5 regression: rerun a recorded run with a new model/system (replayRun) → returns the decision-point diff.
  runRegression: (id: string, body: { model: string; system?: string }) =>
    post<RegressionReport>(`/runs/${encodeURIComponent(id)}/regression`, body),
  // Diff two EXISTING runs (without rerunning) at the decision-point level.
  regressionDiff: (id: string, otherId: string) =>
    get<RegressionReport>(`/runs/${encodeURIComponent(id)}/regression/${encodeURIComponent(otherId)}`),
  // OTEL export: exports the run trace to the APM the host configured (Langfuse/Honeycomb/Datadog/Collector)
  // (only call when caps.otelExport is on — the server returns 501 if the host didn't pass otelExport).
  otelExport: (id: string) => post<{ ok: boolean; target?: string; error?: string }>(`/runs/${encodeURIComponent(id)}/otel-export`, {}),
};

export interface AgentRunBody { runId: string; prompt?: string; messages?: unknown[]; threadId?: string; resourceId?: string; approvals?: Record<string, boolean>; model?: string; temperature?: number; topP?: number; system?: string; }

// ── POST-SSE: agent streaming (EventSource can't POST → fetch + manual SSE parsing) ──
export type StreamEvent =
  | { type: 'text-delta'; data: { text: string } }
  | { type: 'tool-call'; data: { toolCallId: string; toolName: string; input: unknown } }
  | { type: 'tool-result'; data: { toolCallId: string; toolName: string; output: unknown } }
  | { type: 'interrupt'; data: { interrupts: Interrupt[] } }
  | { type: 'error'; data: { error: string } }
  | { type: 'done'; data: { runId: string; finishReason?: string; usage?: unknown } };

export async function streamAgent(name: string, body: AgentRunBody, on: (ev: StreamEvent) => void, signal?: AbortSignal): Promise<void> {
  // Bug-investigation fix #3: a fetch() network exception used to leak as a raw promise rejection
  // (a different error path than the HTTP-not-ok case). It's now caught and reported through the
  // same on({type:'error'}) contract — the caller sees a single error path. Cancellation (AbortController) stays silent (same as before).
  let res: Response;
  try {
    res = await fetch(`${config.apiBase}/agents/${encodeURIComponent(name)}/stream`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...authHeader() }, body: JSON.stringify(body), signal,
    });
  } catch (e) {
    if (signal?.aborted) return; // user cancelled → silent
    on({ type: 'error', data: { error: errMessage(e) } });
    return;
  }
  if (!res.ok || !res.body) { on({ type: 'error', data: { error: `${res.status} ${res.statusText}` } }); return; }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const chunks = buf.split('\n\n');
    buf = chunks.pop() ?? '';
    for (const chunk of chunks) {
      let event = 'message';
      let data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      try { on({ type: event as StreamEvent['type'], data: JSON.parse(data) }); } catch { /* ignore */ }
    }
  }
}

// ── Workflow live run (POST-SSE) ──────────────────────────────────────────────
export async function runWorkflowStream(
  name: string,
  input: unknown,
  runId: string,
  on: (ev: WfStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  // Bug-investigation fix #3: same as streamAgent — catch the fetch() network exception and report
  // it through the uniform on({type:'error'}) contract; cancellation stays silent.
  let res: Response;
  try {
    res = await fetch(`${config.apiBase}/workflows/${encodeURIComponent(name)}/run-stream`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...authHeader() }, body: JSON.stringify({ input, runId }), signal,
    });
  } catch (e) {
    if (signal?.aborted) return;
    on({ type: 'error', data: { error: errMessage(e) } });
    return;
  }
  if (!res.ok || !res.body) { on({ type: 'error', data: { error: `${res.status} ${res.statusText}` } }); return; }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const chunks = buf.split('\n\n');
    buf = chunks.pop() ?? '';
    for (const chunk of chunks) {
      let event = 'message';
      let data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      try { on({ type: event as WfStreamEvent['type'], data: JSON.parse(data) }); } catch { /* ignore */ }
    }
  }
}

// ── react-query hooks ─────────────────────────────────────────────────────
export const useCapabilities = () => useQuery({ queryKey: ['capabilities'], queryFn: api.capabilities });
export const useRuns = () => useQuery({ queryKey: ['runs'], queryFn: api.runs });
/** Paginated run list (newest first). ['runs',…] key → useLiveRuns invalidation covers this too. */
export const RUNS_PAGE_SIZE = 50;
export const useRunsPaged = () =>
  useInfiniteQuery({
    queryKey: ['runs', 'paged'],
    queryFn: ({ pageParam }) => api.runsPage(RUNS_PAGE_SIZE, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
  });
export const useRun = (id: string | null) => useQuery({ queryKey: ['run', id], queryFn: () => api.run(id!), enabled: !!id });
export const useRunState = (id: string | null, step?: number) =>
  useQuery({ queryKey: ['state', id, step], queryFn: () => api.state(id!, step), enabled: !!id });
export const useDiff = (id: string | null, step: number) =>
  useQuery({ queryKey: ['diff', id, step], queryFn: () => api.diff(id!, step), enabled: !!id && step > 0 });
export const useCost = (id: string | null) => useQuery({ queryKey: ['cost', id], queryFn: () => api.cost(id!), enabled: !!id });
export const useRunIncidents = (id: string | null) =>
  useQuery({ queryKey: ['incidents', id], queryFn: () => api.runIncidents(id!), enabled: !!id });
export const useRunNetwork = (id: string | null) => useQuery({ queryKey: ['run-network', id], queryFn: () => api.runNetwork(id!), enabled: !!id });
export const useRunScores = (id: string | null) => useQuery({ queryKey: ['run-scores', id], queryFn: () => api.runScores(id!), enabled: !!id });
export const useProcessorReports = (id: string | null) => useQuery({ queryKey: ['processor-reports', id], queryFn: () => api.processorReports(id!), enabled: !!id });
export const useWorkflowRunState = (id: string | null) =>
  useQuery({ queryKey: ['wf-run-state', id], queryFn: () => api.workflowRun(id!), enabled: !!id });
export const useTrace = (id: string | null) => useQuery({ queryKey: ['trace', id], queryFn: () => api.trace(id!), enabled: !!id });
export const useMetrics = () => useQuery({ queryKey: ['metrics'], queryFn: api.metrics, refetchInterval: 5000 });
export const useMetricsRuns = () => useQuery({ queryKey: ['metrics-runs'], queryFn: api.metricsRuns, refetchInterval: 10000 });
export const useAgents = () => useQuery({ queryKey: ['agents'], queryFn: api.agents });
// Governance: same 10s cadence as useOrganizations — this is a review surface, not a live feed.
// `enabled` MUST be false for a caller who isn't expected to pass the server's platform-admin gate
// (org-bound identity / strict-multi-org non-platform-admin) — GET /agents/registry is platform-admin
// gated (same as approve/block, see server.ts), and this hook is BACKGROUND-POLLED: an always-on query
// hitting a steady 403 would trip App.tsx's global "any 401/403 → force logout" handler and boot a
// legitimate-but-unprivileged user back to the login screen on every poll tick. See Agents.tsx's
// `canSeeRegistry` for the exact (org-unbound OR platform-admin) condition this must be gated on.
export const useAgentRegistry = (enabled: boolean) =>
  useQuery({ queryKey: ['agent-registry'], queryFn: api.agentRegistry, refetchInterval: 10000, enabled });
export const useWorkflows = () => useQuery({ queryKey: ['workflows'], queryFn: api.workflows });
export const useThreads = (resourceId?: string) => useQuery({ queryKey: ['threads', resourceId], queryFn: () => api.threads(resourceId) });
export const useMessages = (id: string | null) => useQuery({ queryKey: ['messages', id], queryFn: () => api.messages(id!), enabled: !!id });
export const useWorkingMemory = (id: string | null) => useQuery({ queryKey: ['wm', id], queryFn: () => api.workingMemory(id!), enabled: !!id });
export const useA2A = () => useQuery({ queryKey: ['a2a'], queryFn: api.a2aNetwork });
export const useTools = () => useQuery({ queryKey: ['tools'], queryFn: api.tools });
export const useMcp = () => useQuery({ queryKey: ['mcp'], queryFn: api.mcpServers });
export const useScorers = () => useQuery({ queryKey: ['scorers'], queryFn: api.scorers });
export const useDatasets = () => useQuery({ queryKey: ['datasets'], queryFn: api.datasets });

export const useJobs = () => useQuery({ queryKey: ['jobs'], queryFn: api.jobs, refetchInterval: 3000 });
export const useCacheStats = () => useQuery({ queryKey: ['cache-stats'], queryFn: api.cacheStats, refetchInterval: 5000 });
export const useSchedulerTriggers = () => useQuery({ queryKey: ['scheduler-triggers'], queryFn: api.schedulerTriggers, refetchInterval: 5000 });
// Governance: approvals inbox refreshes every 5s, organization counters every 10s; audit is keyed by filters.
export const useApprovals = () => useQuery({ queryKey: ['approvals'], queryFn: api.approvals, refetchInterval: 5000 });
export const useAudit = (filters?: AuditFilters) =>
  useQuery({ queryKey: ['audit', filters], queryFn: () => api.audit(filters) });
export const useOrganizations = () => useQuery({ queryKey: ['organizations'], queryFn: api.organizations, refetchInterval: 10000 });
export const useUsers = () => useQuery({ queryKey: ['users'], queryFn: api.users });
export const usePermissionsCatalog = () => useQuery({ queryKey: ['permissions-catalog'], queryFn: api.permissionsCatalog });
export const useMe = () => useQuery({ queryKey: ['me'], queryFn: api.me });
export const useManagedAgents = () => useQuery({ queryKey: ['managed-agents'], queryFn: api.managedAgents });
export const usePolicy = () => useQuery({ queryKey: ['policy'], queryFn: api.policy });
export const useWorkflowRuns = (name: string | null, limit?: number) =>
  useQuery({ queryKey: ['wf-runs', name, limit], queryFn: () => api.workflowRuns(name!, limit), enabled: !!name });
/** D3-A: the suspended-runs inbox — polls at the same 5s cadence as useApprovals (both are "needs attention" queues). */
export const useWorkflowRunsRegistry = (status?: 'suspended' | 'completed' | 'canceled') =>
  useQuery({ queryKey: ['wf-runs-registry', status], queryFn: () => api.workflowRunsRegistry(status), refetchInterval: 5000 });

/**
 * Bug-investigation fix #2 — pure decision logic (tested): should we fall back to the persistent
 * bearer token when the ticket endpoint fails? ONLY when the ticket endpoint behaves as if it
 * TRULY doesn't exist — 404 (old server, endpoint not added yet) → the token fallback is acceptable
 * for backward compatibility. EVERYTHING ELSE (5xx, 429/rate-limit, 401/403, network exception) is
 * considered TRANSIENT — we do NOT put the persistent token in the URL via `?token=` (it could leak
 * into logs); an empty string is returned, and useLiveRuns already falls back to polling on an SSE
 * error/disconnect.
 */
export function sseTicketNeedsTokenFallback(status: number | 'network-error'): boolean {
  return status === 404;
}

/**
 * Auth query-suffix for the SSE URL (F6.6 — token hardening, aligned with server audit finding #2).
 * EventSource can't send headers; putting the persistent bearer token in the URL via `?token=` is a
 * log-leak risk. Instead we obtain a SINGLE-USE ticket with a 60s TTL from the authenticated
 * `POST /auth/sse-ticket` and use `?ticket=` (the server consumes it immediately). If the ticket
 * endpoint returns 404 (old server, no endpoint) we fall BACK to the old `?token=` behavior for
 * compatibility; on TRANSIENT errors like 5xx/429/401/403/network exception the token is NOT put in
 * the URL (see sseTicketNeedsTokenFallback). Returns empty if auth is off (no token).
 */
export async function sseAuthQuery(): Promise<string> {
  const token = getToken();
  if (!token) return ''; // auth off → old open behavior
  let status: number | 'network-error' = 'network-error';
  try {
    const res = await fetch(config.apiBase + '/auth/sse-ticket', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader() },
    });
    status = res.status;
    if (res.ok) {
      const { ticket } = (await res.json()) as { ticket?: string };
      if (ticket) return `?ticket=${encodeURIComponent(ticket)}`;
    }
  } catch { /* network exception → status stays 'network-error' */ }
  return sseTicketNeedsTokenFallback(status) ? `?token=${encodeURIComponent(token)}` : '';
}

/**
 * Live-tail: /events SSE (GET) → invalidate the runs query on a 'change' event (live instead of polling).
 * If SSE can't be established/drops (e.g. under basic-auth setups EventSource can't send a token → 401),
 * we fall back to polling rather than SILENTLY HANGING: on error the connection is closed and periodic
 * invalidation starts. While auth is on, a short-lived ticket is put in the URL instead of the
 * persistent token (see sseAuthQuery).
 */
export function useLiveRuns() {
  const qc = useQueryClient();
  useEffect(() => {
    let es: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let cancelled = false; // unmount → prevent a late-arriving ticket from setting up an ES
    const invalidate = () => qc.invalidateQueries({ queryKey: ['runs'] });
    const startPolling = () => {
      if (poll) return;
      poll = setInterval(invalidate, 5000); // 5s polling when there's no SSE — the list still updates
    };
    // If EventSource doesn't exist at all, poll directly; otherwise fetch a short-lived ticket first, then connect.
    if (typeof EventSource === 'undefined') {
      startPolling();
    } else {
      sseAuthQuery().then((suffix) => {
        if (cancelled) return;
        try {
          es = new EventSource(config.apiBase + '/events' + suffix);
          es.addEventListener('change', invalidate);
          // 401/network error/disconnect → drop SSE, fall back to polling (no silent hang).
          es.addEventListener('error', () => { es?.close(); es = null; startPolling(); });
        } catch {
          startPolling();
        }
      });
    }
    return () => { cancelled = true; es?.close(); if (poll) clearInterval(poll); };
  }, [qc]);
}
