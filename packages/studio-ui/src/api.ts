// Typed API client (@gnldev/studio JSON endpoints) + react-query hooks + SSE helpers.
import { useEffect } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { config } from './config';
import { authHeader, getToken } from './auth';

// ── Types (structurally compatible with server.ts responses) ────────────────
export interface Capabilities {
  // NOTE: `chat` = the host's optional POST /chat (non-streaming, embedder/programmatic) endpoint. It is
  // DELIBERATELY not surfaced in Studio UI — interactive chat is covered by Playground (streaming,
  // Thread/tool/approval); a separate Chat panel would just be redundant surface. The flag is kept
  // For embedder endpoint discovery.
  resume: boolean; chat: boolean; fork: boolean; playground: boolean; stream: boolean;
  /** Saga: the host wired compensateRun → the run detail offers the (irreversible) Unwind action. */
  compensate: boolean;
  tools: boolean; toolExec: boolean; toolExecDurable: boolean; memory: boolean;
  workflows: boolean; workflowExec: boolean; scorers: boolean; datasets: boolean; mcp: boolean; a2a: boolean;
  queue: boolean; knowledge: boolean; workflowManage: boolean;
  /**
   * Capabilities that are `false` for THIS caller's organization scope but would be `true` for an
   * unscoped operator. Derived server-side by evaluating the capability set twice, once as this caller
   * and once as an operator, and diffing — see `/capabilities` in @gnldev/studio.
   *
   * Without it a view cannot tell "the deployment has no cache" from "your organization cannot reach
   * this deployment's cache", because both arrive as `cache: false`. Measured in a browser: an
   * org-bound admin was shown "Cache disabled" and "No jobs yet" while the API behind them was
   * answering `403 org_scope_refused` with a message naming the fix.
   *
   * Optional: an older server does not send it, and `isScopeRefused` then reports false, which is the
   * previous behaviour.
   */
  scopeRefused?: string[];
  /** "Retry" action in the Jobs view (on if the host implements queue.retry). */
  queueManage?: boolean;
  /** Dead-letter view (@gnldev/events quarantine list — on if the host passed the `events` option).
   *  NOT the `/events` SSE change stream, which is unconditional and unrelated. */
  deadEvents?: boolean;
  /** "Release" action in the Dead-letter view (on if the host implements events.release). */
  eventsManage?: boolean;
  /** Cache view (@gnldev/cache hit/miss ratio + size — on if the host passed the `cache` option). */
  cache?: boolean;
  /** Manual invalidate button in the Cache view (on if the host implements cache.invalidate). */
  cacheManage?: boolean;
  /** Scheduler view (@gnldev/scheduler trigger introspection) — on when the journal is writable + listKeys,
   *  No separate host option required (list comes back empty if the host doesn't use @gnldev/scheduler). */
  scheduler?: boolean;
  // Auth (opt-in): authRequired → the UI requires login. The rest unlock premium surfaces if the paid @gnldev/auth-ee is active.
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
   *  Writable+listKeys (same auto-detection pattern as scheduler/audit, no separate host option needed). */
  processors?: boolean;
  /** D3-A: durable-flag-only agent run cancel (POST /runs/:id/cancel) — no in-process abort in studio,
   *  The run stops at its NEXT fresh model step wherever it's running. */
  runCancel?: boolean;
  /** D3-A: durable workflow-run cancel (POST /workflows/runs/:id/cancel) — same registry surface as the
   *  Suspended-runs inbox (GET /workflows/runs). */
  workflowRunCancel?: boolean;
  /** Agent approval registry (governance): review/approve/block code-defined agents — on when the host's
   *  Journal is writable + listKeys (same auto-detection pattern as audit/scheduler). */
  agentRegistry?: boolean;
}

/**
 * Fetch error: carries the HTTP status → the UI can redirect to login on 401/403.
 * API-05 fix: also carries the server's full JSON error body (when present) — `http()` used to
 * Discard every field but `.error` (folded into `message`), so callers had no channel for
 * Machine-readable fields like `code`/`resumable`/`detail`/`aggregate` (e.g. run_limit_exceeded's
 * `resumable`, or the eval-gate 412's `aggregate`). `code` is pulled out as a convenience shortcut;
 * `body` carries the raw parsed object for anything else. Both stay optional/undefined when the
 * Response wasn't valid JSON (unreadable body) — existing `new ApiError(status, msg)` call sites
 * Keep compiling and behaving exactly as before.
 */
export class ApiError extends Error {
  status: number;
  code?: string;
  body?: Record<string, unknown>;
  constructor(status: number, message: string, body?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    if (body && typeof body.code === 'string') this.code = body.code;
  }
}

/**
 * Bug-investigation fix: a clean message to show the USER for an error.
 * Returns the `message` of `ApiError`/`Error` (without the technical "ApiError:" prefix — `String(e)`
 * Used to add that). Since `http()` now puts the server's error body (`{error}`) into the message,
 * Toasts show meaningful text. Use this in all views' toast/error display.
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
 * A 403 that means "not for your scope", not "your token is bad".
 *
 * The server labels the organization-scope refusals it serves for a host object with no organization
 * boundary (`org_scope_refused`). They are a property of WHERE the caller is, not of WHO they are.
 */
/** True when `cap` is false only because of the caller's organization scope — see `Capabilities.scopeRefused`. */
export function isScopeRefused(caps: Capabilities | undefined, cap: keyof Capabilities): boolean {
  return !!caps?.scopeRefused?.includes(cap as string);
}

export function isScopeError(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'org_scope_refused';
}

/**
 * Is this the server saying the CREDENTIAL is no good?
 *
 * Only 401 — and the reason is about COVERAGE, not about what a 403 means in the abstract.
 *
 * A first version of this note claimed no 403 ever indicates a bad credential. That is false, and
 * measured: on the free `roleAuth` path a WRITE with no valid identity answers 403, not 401
 * (`auth/role-auth.ts:202`, and the same choice in `adapter.ts:37` and `gate.ts:143`, both
 * `action === 'write' ? 403 : 401`).
 *
 * What holds is narrower and sufficient: every READ answers 401 for an unidentified caller
 * (`role-auth.ts:206`, `auth-ee/rbac.ts:68` — measured across five provider configurations), and
 * there is no screen in this UI that does not read. So a revoked or expired token still produces a
 * 401 within the first render, and the session still ends. Ignoring 403 costs nothing that 401 does
 * not already cover, and buys the case below.
 *
 * The residual: a reverse proxy in front of Studio that answers 403 to EVERYTHING would never trip
 * the automatic sign-out. Manual logout is unaffected — it is bound to no query.
 *
 * The cost of collapsing it was a loop with no exit. Measured: a principal whose grants omit
 * `threads:read` lands on `/inspector` (the default route), `useThreads` fires, 403 comes back, and
 * the token — a perfectly valid one — is cleared. Signing in again returns them to the same page and
 * the same 403. `threads:read` sits in the permission catalogue described as "View conversations —
 * end users' own words", which is exactly the grant an operator withholds on purpose, and the Users
 * screen exists to compose such sets.
 *
 * An earlier fix took the same shape but only exempted refusals CARRYING `org_scope_refused`, so a
 * permission denial — which carries no code — fell straight back into the loop. Keyed on status now,
 * so a new kind of 403 cannot reopen it.
 */
export function isCredentialError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

/**
 * Mid-session rejection → should we fall back to a clean login?
 * Returns true ONLY when auth is ON (authRequired) AND a token is present. When there is no
 * Token (we're already on the Login screen), always returns false to avoid a re-login loop —
 * The 401 there is shown by the Login component with its own error message.
 *
 * A 403 never gets here (see `isCredentialError`), and that is not a refinement — it is the whole
 * Behaviour. Every route stays registered even when the nav hides its row, so typing `/cache` or
 * Landing on the default `/inspector` mounts a view whose hooks fire regardless of the caller's
 * Grants. Answering those refusals by clearing the token signed people out for VISITING A PAGE: every
 * 5s, on every login, until they stopped using the URL.
 *
 * Fixed once for organization-scope refusals only, by exempting the `org_scope_refused` code. A
 * Permission denial carries no code, so it went straight back into the same loop — and that is the
 * Common case, since composing narrow grants is what the Users screen is for.
 */
export function shouldForceReauth(input: { err: unknown; authRequired: boolean; hasToken: boolean }): boolean {
  return input.authRequired && input.hasToken && isCredentialError(input.err);
}

/**
 * Bug-investigation fix #4: react-query retry — 401/403 (token invalid/revoked/unauthorized) isn't
 * Worth retrying; App.tsx already falls back to a clean login via forceReauthIf, so a retry would
 * Only delay that reauth trigger. For other errors (network/5xx) retry at most once.
 */
export function queryRetry(failureCount: number, error: unknown): boolean {
  return !isAuthError(error) && failureCount < 1;
}
export interface JobStatus { id: string; type: string; status: string; attempts: number; }
/**
 * One quarantined event delivery (GET /dead-events) — the shape @gnldev/events' `listDeadEvents`
 * returns. Addressed by the triple `(topic, consumer, id)`, never by `id` alone: a topic fans out, so
 * the same event carries one dead-letter record for every consumer whose handler gave up on it.
 */
export interface DeadEvent {
  id: string;
  topic: string;
  consumer: string;
  /** `quarantined` = parked. `released` = handed back, awaiting the next poll. `delivered` = it later succeeded (kept as history). */
  status: 'quarantined' | 'released' | 'delivered';
  /**
   * The handler's own failure text — present only when the caller carries `payloads:read`.
   *
   * It is gated alongside the body rather than with the rest of the row because it is PRODUCED from
   * the body: a handler that validates an event quotes the value it rejected, so this field carries
   * the payload by another name (measured: `ValidationError: ssn '123-45-6789' invalid…`).
   */
  error?: string;
  /** This record has failure text the caller may not read. Never set together with `error`. */
  errorRestricted?: boolean;
  attempts: number;
  at: number;
  /** Set once released — a release stamps the record, it does not remove it. */
  releasedAt?: number;
  /** How many times it has been handed back. */
  releases?: number;
  /**
   * The event body as the producer emitted it — present only when the caller carries `payloads:read`
   * (the server withholds it otherwise; see `payloadRestricted`). `undefined` is ambiguous on its own,
   * Which is exactly why the server sends the flag rather than leaving the field missing.
   */
  payload?: unknown;
  /** The caller asked for the body and may not see it. Never set together with `payload`. */
  payloadRestricted?: boolean;
}
/** One (topic, consumer) pair the dead-letter view can be pointed at (GET /dead-events/topics). */
export interface EventTopic { topic: string; consumers: string[] }
/** Structurally compatible with @gnldev/cache `stats()` (server GET /cache/stats). */
export interface CacheStats { hits: number; misses: number; hitRate: number; size: number; }
/** Structurally compatible with @gnldev/scheduler `TriggerInfo` (server GET /scheduler/triggers). */
export interface SchedulerTrigger {
  id: string;
  name: string;
  kind: 'at' | 'every' | 'cron';
  /** kind='at' → epoch ms; kind='every' → period (ms); kind='cron' → a 5-field cron expression. */
  value: number | string;
  /** The scheduled workflow's argument. Withheld without `payloads:read` — nothing here renders it. */
  input?: unknown;
  nextRunAt: number;
  attempts: number;
  maxAttempts: number;
  fireCount: number;
  status: 'pending' | 'done' | 'failed';
  misfire: 'skip' | 'catchup';
  /**
   * The failed workflow's own error text — withheld without `payloads:read`, because the workflow
   * ran on `input` and its message can quote it (same reasoning as `DeadEvent.error`).
   */
  lastError?: string;
  /** This trigger failed with text the caller may not read. Never set together with `lastError`. */
  lastErrorRestricted?: boolean;
  lastErrorAt?: number;
}
export interface VectorMatch { id: string; text: string; score: number; metadata?: Record<string, unknown>; }
export interface DatasetMeta { id: string; cases: number; description?: string; }
export interface EvalDatasetResult { datasetId: string; cases: { caseId: string; output: string; scores: Record<string, { score: number; reason?: string }> }[]; aggregate: Record<string, number>; }
// ThreadId is optional: only present on runs tied to a thread (backend ready — server /runs).
export interface RunSummary { runId: string; status: 'completed' | 'suspended' | 'failed' | 'running' | 'canceled'; modelSteps: number; toolCalls: number; threadId?: string; agent?: string; }
/**
 * S4 pagination envelope: GET /runs?limit=&cursor= (newest first).
 *
 * `total` is OPTIONAL because only some backends can produce it. Studio's own `/runs` returns it
 * (it has a cheap status aggregate); `@gnldev/server`'s `/runs` returns `{items,nextCursor}` and
 * never has — this type used to require it anyway, so against a real server `total` was `undefined`
 * at runtime and every consumer's `?? 0` rendered a confident **0 runs** next to a full list.
 *
 * It stays optional rather than being backfilled into the server for the same reason
 * `WorkflowRunRegistryPage` below has never carried one: the paged path delegates to
 * `listRunsPaged`, and there is no CHEAP filtered count behind it. Not "impossible" — a count can
 * always be bought with another query — which is why this is a `?count=1`-shaped opt-in later rather
 * than a field the envelope guarantees. Render the count when it is there; when it is not, say how
 * many are loaded and that more exist — never invent a denominator.
 */
export interface RunsPage { items: RunSummary[]; nextCursor?: string; total?: number; }
/** API-09: optional GET /runs filters (status/agent pushed down server-side; q = runId substring). */
export interface RunsFilter { status?: RunSummary['status']; agent?: string; q?: string; }
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
/** Audit report (structurally identical to @gnldev/durable recordProcessorReport/readProcessorReports). */
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
/** One materialized day (or all-time) bucket's counter fields — see @gnldev/durable readMetricsSummary.
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
/** One recalled message ref from GET /runs/:id/memory-context — score present only on similarity HITS. */
export interface RecalledMessageRef { threadId: string; seq: number; role: string; preview: string; score?: number }
/** The ':memctx' provenance record durable freezes next to ':input' — WHERE each context part came from. */
export interface MemoryContextRecord {
  v: 1; threadId: string; recalled: RecalledMessageRef[]; recentCount: number;
  /** The window messages themselves (capped) — absent on records written before the field existed. */
  recent?: RecalledMessageRef[];
  observationCount?: number; workingMemoryChars?: number; incomingCount: number; echoTrimmed: number;
  /**
   * SILENT DATA LOSS, made visible: the input-processor chain left no recoverable copy of this turn,
   * so the thread was stored with an answer and NO question (`incomingCount` is then 0). The value
   * says which of the three ways it happened — `messages-dropped` (the chain returned no `messages`
   * array at all), `boundary-lost` (it rebuilt everything, so nothing anchors the history/incoming
   * split), `turn-dropped` (the split is known and the chain removed the turn from it). Absent on
   * every healthy run, and on records written before @gnldev/durable started stamping it.
   */
  incomingUnrecoverable?: 'messages-dropped' | 'boundary-lost' | 'turn-dropped';
  /**
   * The turn was deduplicated on the POST-processor (masked) shapes. What is lost is the turn COUNT,
   * not content: two genuinely different raw questions that redact to the same string are
   * indistinguishable at that point, and the model sees one identical string either way. A note, not
   * a warning. Absent when the dedupe did not fire.
   */
  incomingDedupedByShape?: true;
}
export interface AgentMeta { name: string; model: string; system?: string; hasTools: boolean; maxSteps?: number; tools?: ToolMeta[]; orgs?: string[]; }
// ── Agent approval registry (governance — structurally compatible with @gnldev/durable's agent-registry.ts) ──
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
 * Managed workflows in one scan. The registry key is only `wfrun:<runId>` — historically the record
 * Carried no workflow `name`, so the workflow that produced a suspended run had to be picked by the
 * User (see Workflows.tsx's suspended-runs inbox) rather than inferred.
 * FLOW-08: `workflowName` is an OPTIONAL server-side addition — OLDER registry records (written before
 * The server started stamping it) won't have it, so callers must keep working when it's absent (see
 * Workflows.tsx's `deriveWorkflowName` fallback, which derives it from the runId's `wf-<name>-<ts>`
 * Convention instead of forcing the user to guess from a flat dropdown).
 */
export interface WorkflowRunRegistryItem {
  runId: string;
  status: 'suspended' | 'completed' | 'canceled';
  /** FLOW-08: the workflow this run belongs to, when the server recorded it (optional — absent on
   *  Older records). When present, this is authoritative (not a guess). */
  workflowName?: string;
  /** Suspended: the step waiting on resume. Canceled: the step that would have run next (if known). */
  stepId?: string;
  /** Suspended: the waitId to key the resume payload by (`{ [waitId]: payload }`) — absent means the
   * UI cannot address a precise resume target (honestly surfaced, see SuspendedRunsInbox). */
  waitId?: string;
  reason?: unknown;
  updatedAt: number;
}
/** API-03: paged envelope for GET /workflows/runs?limit= (same shape as RunsPage, minus `total` — the
 *  Registry doesn't have a cheap filtered-count aggregate, see server.ts's route JSDoc). */
export interface WorkflowRunRegistryPage { items: WorkflowRunRegistryItem[]; nextCursor?: string; }
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
export interface ApprovalItem { runId: string; toolCallId: string; toolName: string; args?: unknown; reason?: string; /** FAZ-8: the run's last activity — the inbox ages rows and flags abandoned ones. */ suspendedAt?: number; }
export interface SemanticGuardSummary {
  totals: { suspend: number; warn: number };
  byTool: Record<string, { suspend: number; warn: number }>;
  /** precision@suspend: her semantik askının insan sonucu (denied = gerçek mükerrer yakalandı,
   *  approved = "yine de koş" ≈ yanlış alarm payı üst sınırı). rate = denied/(denied+approved),
   *  karar yokken null. Eski sunucuda alan hiç yok (additive). */
  precision?: { approved: number; denied: number; pending: number; rate: number | null };
  /** FAZ-7: which rung asked — deterministic identity, the rule ladder, or the judge. Absent on an
   *  older server (additive), so the card hides rather than showing three zeros. */
  byOrigin?: { identity: number; rule: number; judge: number };
  /** FAZ-7: what the deterministic half did without asking. `grayCalls` is the price quote for
   *  enabling the judge — the unit is CALLS (≤1 judge call each); it must NOT be added to droppedIdentity — with `rules` on,
   *  separator drops move into droppedByRule, so droppedIdentity shrinks on the same traffic. */
  scan?: { droppedIdentity: number; droppedByRule: number; droppedDiscriminator: number; droppedStamp: number; grayCalls: number };
  /** FAZ-7: every arm the judge took, including the ones that asked nothing. */
  judge?: { same: number; different: number; unsure: number; skipped: Record<string, number>; staleReplaced: number };
  recent: { runId: string; at?: number; action: string; toolName: string; message: string }[];
  unavailable?: string;
}
export interface AuditItem { id: string; at?: number; actor: string; action: string; target: string; org?: string; detail?: unknown; }
export interface OrganizationRow {
  id: string; label?: string; runs: number; tokens: number; costUsd: number;
  /** API-02: 'materialized' (counters served tokens/costUsd, O(1)) | 'scan' (legacy per-run readRun scan).
   * Absent on older servers. Mirrors Metrics.source. */
  source?: 'materialized' | 'scan';
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
 *  Itself is GNL-team-owned/code-defined and read-only — customers assign, never invent, permission ids. */
export interface PermissionCatalogEntry { id: string; label: string; group?: string; description?: string; }
/** GET /permissions/catalog response. `enabled: false` → fine-grained RBAC is off (free tier / no license):
 *  The UI must not render the checkbox editor, only the existing role select applies. */
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
/** USD per 1M tokens. `cachedInputPer1M` is the cache-READ rate; cache writes are not modelled. */
export interface ModelPrice { inputPer1M: number; outputPer1M: number; cachedInputPer1M?: number; }
export interface PricingResponse {
  version: number;
  /** Only what is stored in the journal — the operator's own edits. */
  overrides: Record<string, ModelPrice>;
  /** What the runtime actually prices with: the journal document layered over the shipped table. */
  effective: Record<string, ModelPrice>;

  /** The shipped table, so the editor can show what a row falls back to when its override is removed. */

  defaults?: Record<string, ModelPrice>;
  /** When true the document is the WHOLE table and the shipped defaults do not apply. */
  replace?: boolean;
  updatedAt?: number | null;
  /** False on a read-only journal — the screen shows the table but cannot save. */
  editable: boolean;
}
// ── W5: regression (structurally compatible with @gnldev/durable regression.ts — DiffDetail/DiffEntry/RunDiff) ──
export interface RegressionDiffDetail {
  textA?: string; textB?: string;
  toolCallsA?: { toolName: string; argsHash: string }[]; toolCallsB?: { toolName: string; argsHash: string }[];
  toolName?: string; argsHashA?: string; argsHashB?: string; statusA?: string; statusB?: string;
  outputA?: unknown; outputB?: unknown; note?: string;
}
export interface RegressionDiffEntry { step: number; kind: 'model' | 'tool'; status: 'same' | 'changed' | 'missing' | 'added'; detail?: RegressionDiffDetail; }
export interface RegressionRunDiff {
  steps: RegressionDiffEntry[];
  divergentAt?: number;
  summary: { same: number; changed: number; missing: number; added: number };
}
export interface RegressionReport { ok?: boolean; baseRunId: string; newRunId: string; diff: RegressionRunDiff; score?: unknown; }

// ── fetch helpers ─────────────────────────────────────────────────────────
/**
 * API-07: shared HTTP-error-body reader (this used to be `http()`-only logic; the SSE helpers
 * Below — streamAgent/runWorkflowStream — duplicated a stripped-down `!res.ok` branch that never
 * Read the body, so a server-side rejection like `{error:"writes are not supported in an org
 * Context…"}` only ever showed up as "403 Forbidden" in the Playground). Starts from the generic
 * "<status> <statusText>[ @ context]" text, then tries `res.clone().json()` and uses `.error` as
 * The message when it's a non-empty string; non-JSON/empty bodies leave `body` undefined and keep
 * The generic message. `context` (the request path) is optional so the SSE call sites — which have
 * No meaningful path to report — get the same generic text `http()` always produced.
 */
async function parseErrorResponse(res: Response, context?: string): Promise<{ message: string; body?: Record<string, unknown> }> {
  let message = context ? `${res.status} ${res.statusText} @ ${context}` : `${res.status} ${res.statusText}`;
  let body: Record<string, unknown> | undefined;
  try {
    const parsed = await res.clone().json();
    if (parsed && typeof parsed.error === 'string' && parsed.error) message = parsed.error;
    // API-05: keep the whole parsed body (code/detail/resumable/aggregate/…) on the error, not just `.error`.
    if (parsed && typeof parsed === 'object') body = parsed;
  } catch {
    /* not JSON / empty body → keep the generic message, body stays undefined */
  }
  return { message, body };
}
/** Message-only half of parseErrorResponse — used by streamAgent/runWorkflowStream, which report
 *  A plain string via `on({type:'error', data:{error}})` and have no `ApiError.body` to fill. */
async function errorMessageFromResponse(res: Response): Promise<string> {
  return (await parseErrorResponse(res)).message;
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(config.apiBase + path, {
    ...init,
    // AuthHeader(): adds Authorization if a token exists (empty if auth is off → old behavior).
    headers: { 'content-type': 'application/json', ...authHeader(), ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    // Bug-investigation fix: the server produces a meaningful error body ({error:'...'}) —
    // This used to go unread, so the user only saw a generic "400 Bad Request".
    const { message, body } = await parseErrorResponse(res, path);
    throw new ApiError(res.status, message, body);
  }
  const ct = res.headers.get('content-type') ?? '';
  return (ct.includes('application/json') ? res.json() : res.text()) as Promise<T>;
}
const get = <T>(p: string) => http<T>(p);
const post = <T>(p: string, body: unknown) => http<T>(p, { method: 'POST', body: JSON.stringify(body) });
const del = <T>(p: string) => http<T>(p, { method: 'DELETE' });
const patch = <T>(p: string, body: unknown) => http<T>(p, { method: 'PATCH', body: JSON.stringify(body) });

/** D3-A: the cross-workflow `wfrun:` registry (GET /workflows/runs — P0.4), optionally filtered by
 *  Status. API-03: passing `limit` opts into the paged `{items,nextCursor}` envelope (a BOUNDED scan
 *  Server-side, see server.ts's route JSDoc); omitted → the legacy flat array. Overloaded (rather than a
 *  Union return) so a call site that passes a definite `limit` gets a definite `WorkflowRunRegistryPage`
 *  Back — no `Array.isArray` narrowing needed there, and react-query's `useQuery` overload resolution
 *  (which chokes on a bare union queryFn return type) keeps working for useWorkflowRunsRegistry below. */
function workflowRunsRegistry(status?: 'suspended' | 'completed' | 'canceled'): Promise<WorkflowRunRegistryItem[]>;
function workflowRunsRegistry(status: 'suspended' | 'completed' | 'canceled' | undefined, limit: number): Promise<WorkflowRunRegistryPage>;
function workflowRunsRegistry(status?: 'suspended' | 'completed' | 'canceled', limit?: number): Promise<WorkflowRunRegistryItem[] | WorkflowRunRegistryPage> {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (limit != null) params.set('limit', String(limit));
  const qs = params.toString();
  const path = `/workflows/runs${qs ? `?${qs}` : ''}`;
  return limit != null ? get<WorkflowRunRegistryPage>(path) : get<WorkflowRunRegistryItem[]>(path);
}

export const api = {
  capabilities: () => get<Capabilities>('/capabilities'),
  /** Provider prefixes the model router understands — built-ins plus whatever the host registered. */
  modelProviders: () => get<{ providers: string[]; models: string[] }>('/model-providers'),
  runs: () => get<RunSummary[]>('/runs'),
  /** Memory provenance for a turn ('null' = not recorded: old run, memory off, read-only journal). */
  memoryContext: (id: string) => get<{ context: MemoryContextRecord | null }>(`/runs/${encodeURIComponent(id)}/memory-context`),
  // API-09: optional server-side filters — SAME parameter names as @gnldev/server's GET /runs (status/agent
  // Are pushed down to the engine; q is a runId substring). Filtering is done on the server so `total`
  // (shown in the search placeholder) always describes the same set as `items`.
  runsPage: (limit: number, cursor?: string, filters?: RunsFilter) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set('cursor', cursor);
    if (filters?.status) params.set('status', filters.status);
    if (filters?.agent) params.set('agent', filters.agent);
    if (filters?.q) params.set('q', filters.q);
    return get<RunsPage>(`/runs?${params.toString()}`);
  },
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
  // API-10: optional ?limit= (server clamps 1..1000, see server.ts's /metrics/runs) — without it the
  // Client used to download a metrics row for EVERY run in the journal on every 10s poll, no matter how
  // Many the UI actually renders. `undefined` keeps the old unlimited request (used nowhere currently,
  // Kept for API completeness / any future direct caller).
  metricsRuns: (limit?: number) => get<{ runs: MetricsRun[] }>(`/metrics/runs${limit != null ? `?limit=${limit}` : ''}`),
  agents: () => get<AgentMeta[]>('/agents'),
  tools: () => get<ToolListItem[]>('/tools'),
  workflows: () => get<WorkflowMeta[]>('/workflows'),
  threads: (resourceId?: string) => get<ThreadRecord[]>(`/threads${resourceId ? `?resourceId=${encodeURIComponent(resourceId)}` : ''}`),
  messages: (id: string) => get<any[]>(`/threads/${encodeURIComponent(id)}/messages`),
  /**
   * FLOW-10: truncates a thread's PERSISTED history — `afterIndex` is INCLUSIVE (kept), everything
   * After it is removed. Index space matches GET /threads/:id/messages' response order (the same
   * Array Playground's `mapMessages` consumes) — NOT the local, possibly-fanned-out `Msg[]` index.
   * 501 when the host's memory adapter doesn't implement truncateMessages (see Playground's
   * WarnStaleServerHistory fallback); 400 if `afterIndex` is missing/not a number.
   */
  truncateThreadMessages: (id: string, afterIndex: number) =>
    http<{ ok: boolean; removed: number }>(`/threads/${encodeURIComponent(id)}/messages`, { method: 'DELETE', body: JSON.stringify({ afterIndex }) }),
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
  /** The (topic, consumer) pairs the dead-letter list can be pointed at — empty if the host does not enumerate them. */
  deadEventTopics: () => get<EventTopic[]>('/dead-events/topics'),
  /**
   * Quarantined deliveries for ONE topic+consumer. EXPENSIVE server-side (it scans the whole topic
   * Log), so this is fetched on an explicit operator action and never on an interval — and the server
   * Runs one such scan at a time, answering 429 to a second, different one.
   *
   * `payload=1` is sent ALWAYS and is not the thing that decides whether bodies come back: the server
   * Additionally requires `payloads:read`, and a caller without it gets `payloadRestricted: true` per
   * Record instead of the body (and instead of losing the list). Asking unconditionally is what lets
   * The row expander explain WHICH of the two happened without a second request — and a second request
   * Would mean a second whole-log scan, which is the one thing this surface must not do.
   */
  deadEvents: (topic: string, consumer: string) =>
    get<DeadEvent[]>(`/dead-events?topic=${encodeURIComponent(topic)}&consumer=${encodeURIComponent(consumer)}&payload=1`),
  /** Hands a quarantined event back for delivery to ONE consumer (only call when caps.eventsManage is
   *  On). Unlike retryJob this does not open a second record — the existing one becomes `released`. */
  releaseDeadEvent: (topic: string, consumer: string, id: string) =>
    post<{ ok: boolean }>('/dead-events/release', { topic, consumer, id }),
  cacheStats: () => get<CacheStats>('/cache/stats'),
  /** If key is given, only that key is deleted; if not given, (best-effort) all keys known to the host
   *  Are deleted (only call when caps.cacheManage is on). */
  invalidateCache: (key?: unknown) => post<{ ok: boolean; deleted: number }>('/cache/invalidate', { key }),
  schedulerTriggers: () => get<SchedulerTrigger[]>('/scheduler/triggers'),
  knowledgeSearch: (query: string, topK?: number) => post<VectorMatch[]>('/knowledge/search', { query, topK }),
  runWorkflow: (name: string, body: { input?: unknown; runId?: string; maxSteps?: number; dryRun?: boolean; resume?: Record<string, unknown> }) => post<WorkflowRunResult>(`/workflows/${encodeURIComponent(name)}/run`, body),
  workflowRun: (runId: string) => get<WorkflowRunState>(`/workflows/run/${encodeURIComponent(runId)}`),
  workflowRuns: (name: string, limit?: number) =>
    get<WorkflowRunSummary[]>(`/workflows/${encodeURIComponent(name)}/runs${limit ? `?limit=${limit}` : ''}`),
  workflowRunsRegistry,
  /** D3-A: durably cancels a workflow run (studio's counterpart of @gnldev/server's P0.4 cancel). */
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
  approvals: () => get<{ items: ApprovalItem[]; /** FAZ-8: age decisions use the SERVER clock (K2 — both ends of a staleness decision from one source). */ serverNow?: number }>('/approvals'),
  semanticGuard: () => get<SemanticGuardSummary>('/semantic-guard'),
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
  // PlatformAdmin/scope/strictMultiOrg are optional — older servers may not send them yet (the UI
  // Treats a missing platformAdmin as false, see Agents.tsx's canSeeRegistry).
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
   * CLEARS the explicit override → authorization falls back to the role's default grants. */
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
  /** The price table a spend ceiling reads: `effective` is what the runtime uses, `overrides` is the
   *  part stored in the journal. They differ because the document LAYERS over the table compiled into
   *  @gnldev/durable — showing only the overrides would hide the prices most runs are billed at. */
  pricing: () => get<PricingResponse>('/pricing'),
  /** `ifVersion`: the version the caller loaded — optimistic lock, same contract as savePolicy. */
  savePricing: (models: Record<string, ModelPrice>, ifVersion?: number, replace?: boolean) =>
    http<{ ok: boolean; version: number }>('/pricing', { method: 'PUT', body: JSON.stringify({ models, ifVersion, replace }) }),
  /** `ifVersion`: the version the caller loaded — optimistic lock (API-08). Omit for the old
   *  Last-write-wins behavior. Mismatch → 409 ApiError (see `ApiError.status`). */
  savePolicy: (rules: PolicyRule[], ifVersion?: number) =>
    http<{ ok: boolean; version: number }>('/policy', { method: 'PUT', body: JSON.stringify({ rules, ifVersion }) }),
  createAgentVersion: (body: { name: string; model: string; system?: string; maxSteps?: number; note?: string }) =>
    post<{ ok: boolean; name: string; version: number; active: number | null }>('/managed-agents', body),
  promoteAgentVersion: (name: string, version: number) =>
    post<{ ok: boolean; name: string; active: number; previous: number | null }>(`/managed-agents/${encodeURIComponent(name)}/promote`, { version }),
  /** PERMANENTLY deletes a managed agent record (with ALL its versions) — only the managed override goes
   *  Away; a code-defined agent (if any) keeps coming from the registry (501 if the host doesn't support deletePrefix). */
  deleteManagedAgent: (name: string) => del<{ ok: boolean; name: string }>(`/managed-agents/${encodeURIComponent(name)}`),
  /** Deletes a single VERSION. The active (prod) version cannot be deleted (409); once the last version is gone the agent disappears entirely. */
  deleteAgentVersion: (name: string, version: number) =>
    del<{ ok: boolean; name: string; version: number; active: number | null; remaining: number }>(`/managed-agents/${encodeURIComponent(name)}/versions/${version}`),
  // W5 regression: rerun a recorded run with a new model/system (replayRun) → returns the decision-point diff.
  runRegression: (id: string, body: { model: string; system?: string; memoryOff?: boolean }) =>
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
// The FULL wire protocol, kept in sync with packages/studio/src/sse.ts (and its twin,
// Packages/server/src/sse.ts). This used to declare only 6 of the 18 events the server actually
// Sends, which made the other 12 untypeable and therefore unhandled — including `tool-error`, whose
// Absence left a failed tool pulsing "running" forever in the Playground. An event the UI chooses
// To ignore is a decision; an event it cannot even name is an accident waiting to happen.
export type StreamEvent =
  | { type: 'text-delta'; data: { text: string } }
  | { type: 'tool-call'; data: { toolCallId: string; toolName: string; input: unknown } }
  | { type: 'tool-result'; data: { toolCallId: string; toolName: string; output: unknown } }
  | { type: 'tool-error'; data: { toolCallId: string; toolName: string; error: string } }
  // Model reasoning (only emitted by models that expose it) — start/end bracket a thinking phase.
  | { type: 'reasoning-start'; data: { id?: string } }
  | { type: 'reasoning-delta'; data: { id?: string; text: string } }
  | { type: 'reasoning-end'; data: { id?: string } }
  // The model is streaming the ARGUMENTS of a call it is about to make.
  | { type: 'tool-input-start'; data: { toolCallId: string; toolName: string } }
  | { type: 'tool-input-delta'; data: { toolCallId: string; delta: string } }
  | { type: 'tool-input-end'; data: { toolCallId: string } }
  // Agent-loop boundaries: one step = one model call plus the tools it triggers.
  | { type: 'step-start'; data: Record<string, never> }
  | { type: 'step-finish'; data: { finishReason?: string; usage?: unknown } }
  | { type: 'source'; data: { sourceType?: string; id?: string; url?: string; title?: string } }
  | { type: 'file'; data: { mediaType?: string; base64?: string } }
  /** Unknown stream part — carries its type only, so a protocol addition is visible, never silent. */
  | { type: 'raw'; data: { type: string } }
  | { type: 'interrupt'; data: { interrupts: Interrupt[] } }
  | { type: 'error'; data: { error: string } }
  | { type: 'done'; data: { runId: string; finishReason?: string; usage?: unknown } };

export async function streamAgent(name: string, body: AgentRunBody, on: (ev: StreamEvent) => void, signal?: AbortSignal): Promise<void> {
  // Bug-investigation fix #3: a fetch() network exception used to leak as a raw promise rejection
  // (a different error path than the HTTP-not-ok case). It's now caught and reported through the
  // Same on({type:'error'}) contract — the caller sees a single error path. Cancellation (AbortController) stays silent (same as before).
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
  if (!res.ok) {
    // API-07: read the server's {error} body (same helper http() uses) instead of showing just
    // The HTTP status text — e.g. surfaces "writes are not supported in an org context…" on 403.
    on({ type: 'error', data: { error: await errorMessageFromResponse(res) } });
    return;
  }
  if (!res.body) { on({ type: 'error', data: { error: `${res.status} ${res.statusText}` } }); return; }
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
  // It through the uniform on({type:'error'}) contract; cancellation stays silent.
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
  if (!res.ok) {
    // API-07: same fix as streamAgent — read the server's {error} body instead of showing just
    // The HTTP status text.
    on({ type: 'error', data: { error: await errorMessageFromResponse(res) } });
    return;
  }
  if (!res.body) { on({ type: 'error', data: { error: `${res.status} ${res.statusText}` } }); return; }
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

/**
 * A polling query that cannot be constructed without naming the capability it depends on.
 *
 * The rule was previously a convention, and a convention with eight call sites is a convention with
 * holes: `useJobs` (3s), `useCacheStats` (5s), `useSchedulerTriggers` (5s) and `useApprovals` (5s) all
 * polled unconditionally. The nav hides a row whose capability is off, but every route stays
 * registered, so typing the URL mounted the view and started the poll against an endpoint that
 * refuses. Only `useAgentRegistry` took an `enabled` argument — added by hand, after being burned.
 *
 * Putting the capability in the signature makes "capability off ⇒ no background traffic" a property of
 * the type rather than of whoever writes the next hook.
 */
function usePolled<T>(cap: keyof Capabilities, key: unknown[], fn: () => Promise<T>, ms: number) {
  const caps = useCapabilities();
  return useQuery({ queryKey: key, queryFn: fn, refetchInterval: ms, enabled: caps.data?.[cap] === true });
}
/**
 * The router's provider prefixes. Rarely changes within a session (a host registers at boot), so it is
 * fetched once and kept — a datalist that re-requests on every keystroke would be worse than the
 * hardcoded list it replaces.
 */
export const useModelProviders = () => useQuery({
  queryKey: ['model-providers'], queryFn: api.modelProviders, staleTime: Infinity,
});
export const useRuns = () => useQuery({ queryKey: ['runs'], queryFn: api.runs });
/**
 * Paginated run list (newest first). ['runs',…] key → useLiveRuns invalidation still matches (prefix
 * Match on ['runs']), regardless of the filter values appended below.
 * API-09: `filters` (status/agent/q) is part of the query key — changing a filter is a genuinely
 * Different result set, so react-query must re-fetch (not just re-render) when it changes. Two calls
 * With the SAME (or no) filters share the same key → react-query dedupes them to one request/cache
 * Entry (used by Inspector.tsx to reuse the unfiltered list for fork lineage without doubling fetches).
 */
export const RUNS_PAGE_SIZE = 50;
export const useRunsPaged = (filters?: RunsFilter) =>
  useInfiniteQuery({
    queryKey: ['runs', 'paged', filters?.status ?? '', filters?.agent ?? '', filters?.q ?? ''],
    queryFn: ({ pageParam }) => api.runsPage(RUNS_PAGE_SIZE, pageParam, filters),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
  });
export const useRun = (id: string | null) => useQuery({ queryKey: ['run', id], queryFn: () => api.run(id!), enabled: !!id });
export const useRunState = (id: string | null, step?: number) =>
  useQuery({ queryKey: ['state', id, step], queryFn: () => api.state(id!, step), enabled: !!id });
export const useDiff = (id: string | null, step: number) =>
  useQuery({ queryKey: ['diff', id, step], queryFn: () => api.diff(id!, step), enabled: !!id && step > 0 });
export const useRunIncidents = (id: string | null) =>
  useQuery({ queryKey: ['incidents', id], queryFn: () => api.runIncidents(id!), enabled: !!id });
export const useRunNetwork = (id: string | null) => useQuery({ queryKey: ['run-network', id], queryFn: () => api.runNetwork(id!), enabled: !!id });
export const useRunScores = (id: string | null) => useQuery({ queryKey: ['run-scores', id], queryFn: () => api.runScores(id!), enabled: !!id });
/** Lazy per-turn provenance (ThreadDetail expands it on demand) — the record is frozen, cache it long. */
export const useMemoryContext = (id: string | null) =>
  useQuery({ queryKey: ['memctx', id], queryFn: () => api.memoryContext(id!), enabled: !!id, staleTime: 5 * 60_000 });
/** Thread messages for the ledger's ghost-turn detection (unanswered questions have no run). */
export const useThreadMessages = (id: string | null) =>
  useQuery({ queryKey: ['thread-messages', id], queryFn: () => api.messages(id!), enabled: !!id });
export const useProcessorReports = (id: string | null) => useQuery({ queryKey: ['processor-reports', id], queryFn: () => api.processorReports(id!), enabled: !!id });
export const useWorkflowRunState = (id: string | null) =>
  useQuery({ queryKey: ['wf-run-state', id], queryFn: () => api.workflowRun(id!), enabled: !!id });
export const useTrace = (id: string | null) => useQuery({ queryKey: ['trace', id], queryFn: () => api.trace(id!), enabled: !!id });
export const useMetrics = () => useQuery({ queryKey: ['metrics'], queryFn: api.metrics, refetchInterval: 5000 });
// API-10: the Inspector's run list only ever shows RUNS_PAGE_SIZE (50) rows at a time — 200 comfortably
// Covers a few loaded pages without re-downloading a metrics row for every run the journal has ever
// Seen. The limit is part of the query key: a caller that genuinely needs a different (e.g. larger)
// Window must pass an explicit `limit`, which gets its OWN cache entry — reusing this key with a
// Different limit would otherwise mix results from two different requests under one cache slot.
// Pass `null` to opt OUT of the cap and fetch the whole set — Observability's percentiles and CSV
// Export are only correct over ALL runs, so a silent 200-run window would quietly narrow the analytics.
export const useMetricsRuns = (limit: number | null = 200) =>
  useQuery({ queryKey: ['metrics-runs', limit], queryFn: () => api.metricsRuns(limit ?? undefined), refetchInterval: 10000 });
export const useAgents = () => useQuery({ queryKey: ['agents'], queryFn: api.agents });
// Governance: same 10s cadence as useOrganizations — this is a review surface, not a live feed.
// `enabled` MUST be false for a caller who isn't expected to pass the server's platform-admin gate
// (org-bound identity / strict-multi-org non-platform-admin) — GET /agents/registry is platform-admin
// Gated (same as approve/block, see server.ts), and this hook is BACKGROUND-POLLED: an always-on query
// Hitting a steady 403 would trip App.tsx's global "any 401/403 → force logout" handler and boot a
// Legitimate-but-unprivileged user back to the login screen on every poll tick. See Agents.tsx's
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

export const useJobs = () => usePolled('queue', ['jobs'], api.jobs, 3000);
/**
 * Dead-letter surfaces are NOT `usePolled`, and that is the point rather than an omission.
 *
 * `listDeadEvents` reads the WHOLE topic log and does a `get` per event — the exact O(n) scan
 * @gnldev/events' cursor exists to keep out of the delivery path. Putting it on a 3s interval like
 * `useJobs` would have Studio re-scanning every event a topic has ever carried, twenty times a
 * minute, for as long as the tab is open. So the topic inventory is fetched once (cheap, and a host
 * registers its consumers at boot) and the list itself only when the operator asks for it: `enabled`
 * is off until a topic AND a consumer are chosen, and `staleTime: Infinity` means re-mounting the
 * view does not silently re-run the scan. The view's Refresh button is what re-runs it.
 */
export const useDeadEventTopics = () => {
  const caps = useCapabilities();
  return useQuery({
    queryKey: ['dead-event-topics'], queryFn: api.deadEventTopics,
    enabled: caps.data?.deadEvents === true, staleTime: Infinity,
  });
};
export const useDeadEvents = (topic: string | null, consumer: string | null) => {
  const caps = useCapabilities();
  return useQuery({
    queryKey: ['dead-events', topic, consumer],
    queryFn: () => api.deadEvents(topic!, consumer!),
    enabled: caps.data?.deadEvents === true && !!topic && !!consumer,
    staleTime: Infinity,
  });
};
export const useCacheStats = () => usePolled('cache', ['cache-stats'], api.cacheStats, 5000);
export const useSchedulerTriggers = () => usePolled('scheduler', ['scheduler-triggers'], api.schedulerTriggers, 5000);
// Governance: approvals inbox refreshes every 5s, organization counters every 10s; audit is keyed by filters.
export const useApprovals = () => usePolled('approvals', ['approvals'], api.approvals, 5000);
/** FAZ-8: semantic-guard telemetry — not capability-gated; on an OLDER server the request 404s and the card stays HIDDEN (data undefined), it does not show zeros. */
export const useSemanticGuard = () => useQuery({ queryKey: ['semantic-guard'], queryFn: api.semanticGuard, refetchInterval: 10000, retry: false });
export const useAudit = (filters?: AuditFilters) =>
  useQuery({ queryKey: ['audit', filters], queryFn: () => api.audit(filters) });
// API-02: this is a review surface, not a live feed — 30s (was 10s) avoids re-triggering a per-org
// Usage scan every 10s just because the Organizations/Users panel is left open (see server.ts's
// ListOrganizations for the O(1) materialized-counter fast path this interval now backs off).
export const useOrganizations = () => useQuery({ queryKey: ['organizations'], queryFn: api.organizations, refetchInterval: 30000 });
export const useUsers = () => useQuery({ queryKey: ['users'], queryFn: api.users });
export const usePermissionsCatalog = () => useQuery({ queryKey: ['permissions-catalog'], queryFn: api.permissionsCatalog });
export const useMe = () => useQuery({ queryKey: ['me'], queryFn: api.me });
export const useManagedAgents = () => useQuery({ queryKey: ['managed-agents'], queryFn: api.managedAgents });
export const usePolicy = () => useQuery({ queryKey: ['policy'], queryFn: api.policy });
export const usePricing = () => useQuery({ queryKey: ['pricing'], queryFn: api.pricing });
export const useWorkflowRuns = (name: string | null, limit?: number) =>
  useQuery({ queryKey: ['wf-runs', name, limit], queryFn: () => api.workflowRuns(name!, limit), enabled: !!name });
// API-03: the suspended-runs inbox is a review surface, not a live feed — 15s (was 5s) avoids
// Re-scanning the wfrun: registry every 5s just because the Workflows tab is left open. `limit`
// Defaults to 50 (an inbox, not a browsable list — see server.ts's route JSDoc for why no "load more"
// Was added) and is part of the query key so a caller that asks for a different window gets its own
// Cache entry instead of silently mixing pages.
export const useWorkflowRunsRegistry = (status?: 'suspended' | 'completed' | 'canceled', limit = 50) =>
  useQuery({ queryKey: ['wf-runs-registry', status, limit], queryFn: () => api.workflowRunsRegistry(status, limit), refetchInterval: 15000 });

/**
 * Bug-investigation fix #2 — pure decision logic (tested): should we fall back to the persistent
 * Bearer token when the ticket endpoint fails? ONLY when the ticket endpoint behaves as if it
 * TRULY doesn't exist — 404 (old server, endpoint not added yet) → the token fallback is acceptable
 * For backward compatibility. EVERYTHING ELSE (5xx, 429/rate-limit, 401/403, network exception) is
 * Considered TRANSIENT — we do NOT put the persistent token in the URL via `?token=` (it could leak
 * Into logs); an empty string is returned, and useLiveRuns already falls back to polling on an SSE
 * Error/disconnect.
 */
export function sseTicketNeedsTokenFallback(status: number | 'network-error'): boolean {
  return status === 404;
}

/**
 * Auth query-suffix for the SSE URL (F6.6 — token hardening, aligned with server audit finding #2).
 * EventSource can't send headers; putting the persistent bearer token in the URL via `?token=` is a
 * Log-leak risk. Instead we obtain a SINGLE-USE ticket with a 60s TTL from the authenticated
 * `POST /auth/sse-ticket` and use `?ticket=` (the server consumes it immediately). If the ticket
 * Endpoint returns 404 (old server, no endpoint) we fall BACK to the old `?token=` behavior for
 * Compatibility; on TRANSIENT errors like 5xx/429/401/403/network exception the token is NOT put in
 * The URL (see sseTicketNeedsTokenFallback). Returns empty if auth is off (no token).
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

/** The shape useRunsPaged's useInfiniteQuery caches under every `['runs','paged',…]` key. */
type RunsPagedData = InfiniteData<RunsPage, string | undefined>;

/**
 * API-04: applies one /events change notification to the cached `['runs','paged',…]` pages WITHOUT
 * Refetching every loaded page (the old behavior — a bare `invalidateQueries({queryKey:['runs']})`
 * Matched every filter variant AND every page an infinite query had already loaded).
 * For each changed runId: a small existing-endpoint probe (`GET /runs?limit=1&q=<runId>` — the SAME
 * Substring filter the search box already uses, API-09) fetches its current row. If that row is found
 * In an ALREADY-CACHED page (any loaded filter variant), it's patched in place via `setQueriesData`. If
 * The probe comes back empty, the run is gone (purge/retention sweep) and the row is dropped from every
 * Cached page it was in. If the runId isn't in any cached page yet (a brand-new run), only the FIRST
 * Page of each loaded list is reset + refetched — never the pages after it, so a user who has scrolled
 * Down doesn't lose that work over one new run appearing at the top.
 */
async function applyRunChanges(qc: QueryClient, runIds: string[]): Promise<void> {
  for (const runId of runIds) {
    let fresh: RunSummary | undefined;
    try {
      const page = await api.runsPage(1, undefined, { q: runId });
      fresh = page.items.find((r) => r.runId === runId);
    } catch { /* best-effort: a network hiccup here just means this runId's patch is skipped this tick */ }

    let foundInCache = false;
    qc.setQueriesData<RunsPagedData>({ queryKey: ['runs', 'paged'] }, (old) => {
      if (!old) return old;
      let touched = false;
      const pages = old.pages.map((p) => {
        if (!p.items.some((r) => r.runId === runId)) return p;
        touched = true;
        const items = fresh
          ? p.items.map((r) => (r.runId === runId ? fresh! : r))
          : p.items.filter((r) => r.runId !== runId); // the probe found nothing → the run was removed
        return { ...p, items };
      });
      if (!touched) return old;
      foundInCache = true;
      return { ...old, pages };
    });

    if (!foundInCache && fresh) {
      qc.setQueriesData<RunsPagedData>({ queryKey: ['runs', 'paged'] }, (old) =>
        old && old.pages.length > 0 ? { pages: [old.pages[0]!], pageParams: [old.pageParams[0]] } : old,
      );
      await qc.invalidateQueries({ queryKey: ['runs', 'paged'] });
    }
  }
}

/**
 * Live-tail: /events SSE (GET) → patch the runs cache on a 'change' event (live instead of polling).
 * API-04: the event body is now informative — `{"runIds":[...],"at":…}` — so only the changed rows are
 * Patched (applyRunChanges above) instead of invalidating every loaded page. A body that fails to
 * JSON.parse, or has no `runIds` array (an older/incompatible server still sending the bare `'runs'`
 * String), falls back to the pre-API-04 blanket invalidation — this is the ONLY compat handling needed;
 * The server doesn't fork into two implementations for old vs new clients.
 * If SSE can't be established/drops (e.g. under basic-auth setups EventSource can't send a token → 401),
 * We fall back to polling rather than SILENTLY HANGING: on error the connection is closed and periodic
 * Invalidation starts. While auth is on, a short-lived ticket is put in the URL instead of the
 * Persistent token (see sseAuthQuery).
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
    const onChange = (e?: { data?: unknown }) => {
      let parsed: { runIds?: unknown } | undefined;
      try { parsed = typeof e?.data === 'string' ? JSON.parse(e.data) : undefined; } catch { parsed = undefined; }
      const runIds = Array.isArray(parsed?.runIds) ? (parsed!.runIds as string[]) : undefined;
      if (!runIds) { invalidate(); return; } // parse failure / legacy 'runs' payload → old full-invalidate behavior
      void applyRunChanges(qc, runIds);
    };
    // If EventSource doesn't exist at all, poll directly; otherwise fetch a short-lived ticket first, then connect.
    if (typeof EventSource === 'undefined') {
      startPolling();
    } else {
      sseAuthQuery().then((suffix) => {
        if (cancelled) return;
        try {
          es = new EventSource(config.apiBase + '/events' + suffix);
          es.addEventListener('change', onChange as EventListener);
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
