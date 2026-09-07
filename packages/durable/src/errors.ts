// @gnldev/durable error types. Separate file: imported by both journal and durable-tool/run-lock.

/**
 * Non-determinism detected during replay: the argsHash of a succeeded tool record doesn't match
 * The hash of the new input produced by the model during replay. Thrown in `replay:'strict'` mode.
 */
export class DivergenceError extends Error {
  constructor(
    message: string,
    public readonly detail: { key: string; expected?: string; actual: string },
  ) {
    super(message);
    this.name = 'DivergenceError';
  }
}

/**
 * The same runId is being run by another process/concurrent call (run-level lock held, or a tool
 * Execute in-flight). Thrown by opt-in concurrency control.
 */
export class RunBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunBusyError';
  }
}

/**
 * A `failed` record for a side-effectful (non-idempotent) tool is NOT automatically
 * RETRIED unless the user explicitly grants permission via `approvals[toolCallId]=true` (closes off
 * The double side-effect risk — e.g. double charging). Unmarked tools never throw this error (backward compatible).
 */
export class SideEffectRetryBlockedError extends Error {
  constructor(
    message: string,
    public readonly detail: { key: string; attempts: number },
  ) {
    super(message);
    this.name = 'SideEffectRetryBlockedError';
  }
}

/**
 * A tool's `failed` record reached the `maxRetries` limit → left permanently failed
 * Instead of an infinite automatic retry loop (the record stays 'failed' in the journal, not retried again).
 */
export class RetryLimitExceededError extends Error {
  constructor(
    message: string,
    public readonly detail: { key: string; attempts: number; maxRetries: number },
  ) {
    super(message);
    this.name = 'RetryLimitExceededError';
  }
}

/**
 * After a successful claim
 * (putIfAbsent/putIfMatch genuinely wrote something new), fewer than the requested number of replicas
 * Acknowledged the write within the timeout (native Redis `WAIT`). The claim itself already happened —
 * This only means the async-replication gap (the core-hardening review: a claim acked only by the primary
 * Can be lost on the replica promoted during failover) could not be ruled out within the deadline.
 * Thrown only when `waitReplicas.onTimeout === 'throw'` (default is 'warn' — see redis-storage.ts).
 */
export class ReplicationNotAcknowledgedError extends Error {
  constructor(
    message: string,
    public readonly detail: { requested: number; acknowledged: number; timeoutMs: number },
  ) {
    super(message);
    this.name = 'ReplicationNotAcknowledgedError';
  }
}

/**
 * (Task 3 — suite-consistency guard, `assertSuiteConsistent`/`createGnl({ checkSuiteConsistency })`):
 * An INSTALLED sibling @gnldev/* package's version differs from @gnldev/durable's own — a project that
 * Bypassed the package manager's caret range (--force/overrides/manual node_modules edits) ended up
 * With an incompatible suite. Thrown only when `onMismatch: 'throw'` was requested (default is 'warn' —
 * See suite-consistency.ts).
 */
export class SuiteVersionMismatchError extends Error {
  constructor(
    message: string,
    public readonly detail: { durableVersion: string; mismatches: { pkg: string; version: string }[] },
  ) {
    super(message);
    this.name = 'SuiteVersionMismatchError';
  }
}

/**
 * A runId owns one conversation (see run.ts's frozen-input hardening): the caller re-used a runId
 * that already froze its `:input` under a DIFFERENT threadId. Thrown BEFORE any journal write for the
 * new attempt — see `assertThreadOwnership` in run.ts, which is called before `runStarted`/
 * `resolveApprovals` for exactly this reason: a run/thread mismatch is the caller's mistake, not a
 * running attempt, so it must not flip a possibly-already-'completed' run to 'failed' (see
 * `outcome.ts`'s `NOT_A_RUN_FAILURE`) and must not journal an approval decision for a call that was
 * never evaluated.
 */
export class RunThreadMismatchError extends Error {
  constructor(
    message: string,
    public readonly detail: { runId: string; startedForThread: string; requestedThread: string },
  ) {
    super(message);
    this.name = 'RunThreadMismatchError';
  }
}

/**
 * FAZ-4 (critical profile) — the SAME runId arrived with DIFFERENT content than the input frozen at
 * Run start (fingerprint mismatch). Same family as RunThreadMismatchError: a caller mistake with no
 * Resolution path for THIS runId+content pair → 409 without `resumable`. Exemption at the check
 * Site: an approval addressed to a toolCallId whose journal record is genuinely 'suspended' (the
 * Chat approval re-POST legitimately carries a grown message history). PII-free: hashes only.
 */
export class RunInputMismatchError extends Error {
  constructor(
    message: string,
    public readonly detail: { runId: string; expectedHash: string; actualHash: string },
  ) {
    super(message);
    this.name = 'RunInputMismatchError';
  }
}

/**
 * FAZ-4 (critical profile) — the runId was started by one actor and re-used by ANOTHER (`actor`
 * Bound into the frozen input, first-wins). No actor on either side = no check (an auth-less profile
 * Has no protection here — documented, not silent).
 */
export class RunActorMismatchError extends Error {
  constructor(
    message: string,
    public readonly detail: { runId: string; ownerActor: string; requestedActor: string },
  ) {
    super(message);
    this.name = 'RunActorMismatchError';
  }
}

/**
 * FAZ-4 (critical profile, `tombstonePolicy: 'reject'`) — the runId was retention-swept
 * (`${runId}:swept` tombstone) and a late retry arrived AFTER the dedup window died with the run.
 * Re-running it silently would repeat the side effects the swept journal used to dedup; the critical
 * Profile refuses instead. The REAL contract remains: retention window ≥ client retry horizon.
 */
export class RunSweptError extends Error {
  constructor(
    message: string,
    public readonly detail: { runId: string; sweptAt?: number },
  ) {
    super(message);
    this.name = 'RunSweptError';
  }
}

/**
 * K1: maps the class name of the three "blocked" errors above → the snake_case error code sent to
 * The client. The SINGLE source of truth — @gnldev/server (sse.ts), @gnldev/agui (route.ts) and
 * @gnldev/studio (server.ts) all use this same map here (previously each package had its own copy that
 * Needed to stay in sync).
 */
/**
 * FAZ-4 K9: the caller-conflict family's SINGLE code map — server, chat-adapter AND agui all consume
 * This one export (a literal copy per consumer is exactly the drift that left agui unmapped in the
 * First cut). Same contract for every member: 409 WITHOUT `resumable` (the id/content/actor is what
 * Needs fixing; no retry clears it).
 */
/** Batch: bir batchId bir plan taşır — onaylanan plan ile gelen items uyuşmuyor (run.ts strictInput'un batch hali). */
export class BatchPlanMismatchError extends Error {
  readonly detail: { batchId: string; expectedToken?: string; actualToken: string };
  constructor(message: string, detail: { batchId: string; expectedToken?: string; actualToken: string }) {
    super(message);
    this.name = 'BatchPlanMismatchError';
    this.detail = detail;
  }
}

export const CALLER_CONFLICT_CODES: Record<string, string> = {
  RunThreadMismatchError: 'run_thread_mismatch',
  RunInputMismatchError: 'run_input_mismatch',
  RunActorMismatchError: 'run_actor_mismatch',
  RunSweptError: 'run_swept',
  BatchPlanMismatchError: 'batch_plan_mismatch',
};

/** Name-matched like blockedErrorCode below (dist/src class-identity resilience). */
export function callerConflictCode(err: unknown): string | undefined {
  const name = (err as { name?: unknown } | null | undefined)?.name;
  return typeof name === 'string' ? CALLER_CONFLICT_CODES[name] : undefined;
}

export const BLOCKED_ERROR_CODES: Record<string, string> = {
  SideEffectRetryBlockedError: 'side_effect_retry_blocked',
  RetryLimitExceededError: 'retry_limit_exceeded',
  RunBusyError: 'run_busy',
  // FAZ-1: @gnldev/workflow's side-effect claim refusal (StepRetryBlockedError, workflow.ts). Matched
  // By NAME here (blockedErrorCode works via err.name) — workflow stays zero-dependency, and a blocked
  // Workflow step surfacing through runWorkflow → server/agui/studio still renders a typed code
  // Instead of falling through to the generic 400.
  StepRetryBlockedError: 'step_retry_blocked',
};

/**
 * Returns the blocked error code for the given error (if any). Works via `err?.name` (NOT
 * Instanceof) — to be resilient since class identity can differ across dist/src build boundaries
 * (in the same spirit as the existing `instanceof X || name === 'X'` pattern in
 * Packages/server/src/index.ts). Returns undefined if there's no match.
 */
export function blockedErrorCode(err: unknown): string | undefined {
  const name = (err as { name?: unknown } | null | undefined)?.name;
  return typeof name === 'string' ? BLOCKED_ERROR_CODES[name] : undefined;
}

/**
 * What an upstream failure should look like to the caller.
 *
 * Everything the taxonomy above recognises is OURS — a limit we enforced, a lock we held, a retry we
 * Refused. A failure from the model provider matches none of them, so it fell through to a generic
 * 400: measured on a live rig, a free endpoint answering 429 arrived at the caller as
 * `400 {"error":"Failed after 3 attempts. Last error: Too Many Requests"}`. 400 means "your request
 * Was malformed", the request was fine, and a client with retry logic reads 400 as "never retry" —
 * Exactly backwards from what a 429 is asking for.
 *
 * Duck-typed on purpose. These errors come from the AI SDK, which this package does not and should
 * Not depend on; matching on `name` and reading `statusCode` keeps the taxonomy free of that edge and
 * Works for any provider that follows the same shape.
 */
export interface UpstreamFailure {
  /** HTTP status to answer the CALLER with — never the upstream's status verbatim (see below). */
  status: 429 | 502 | 504;
  code: 'upstream_rate_limited' | 'upstream_unauthorized' | 'upstream_unavailable' | 'upstream_timeout';
  /** Seconds to wait, when the upstream said so. Rendered as `Retry-After` by the HTTP layer. */
  retryAfter?: number;
  /** The upstream's own status, when it had one — for logs and for the error body, not for the wire. */
  upstreamStatus?: number;
}

/** `AI_RetryError` wraps the failure that actually happened; the wrapper's own shape says nothing. */
function unwrapRetry(err: unknown): unknown {
  const e = err as { name?: string; lastError?: unknown; errors?: unknown[] } | null | undefined;
  if (e?.name !== 'AI_RetryError') return err;
  return e.lastError ?? (Array.isArray(e.errors) ? e.errors[e.errors.length - 1] : err) ?? err;
}

function retryAfterSeconds(headers: unknown): number | undefined {
  const h = headers as Record<string, string> | undefined;
  const raw = h?.['retry-after'] ?? h?.['Retry-After'];
  if (!raw) return undefined;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
  const at = Date.parse(raw); // the header may be an HTTP-date instead of a delta
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - Date.now()) / 1000)) : undefined;
}

/**
 * Classifies a provider/network failure, or returns undefined when the error is not one.
 *
 * The mapping answers "whose fault is this, and what should the caller do":
 * 429 stays **429** with `Retry-After` — the one case where the caller's own backoff is the answer.
 * 401/403 becomes **502**, NOT 401. The credential that failed is the OPERATOR's; answering 401
 *   Would tell the caller to fix an API key it has never seen and cannot reach.
 * a timeout becomes **504**, other 5xx and transport failures become **502** — a dependency broke,
 *   Which is the definition of a bad gateway.
 * a 4xx the provider blamed on the request body (400/404/422) also becomes **502**: the request the
 *   Provider rejected is the one WE built, not the one the caller sent.
 */
export function upstreamFailure(err: unknown): UpstreamFailure | undefined {
  const e = unwrapRetry(err) as
    | { name?: string; statusCode?: number; responseHeaders?: unknown; message?: string; cause?: unknown }
    | null
    | undefined;
  if (!e || typeof e !== 'object') return undefined;

  if (e.name === 'AI_LoadAPIKeyError') return { status: 502, code: 'upstream_unauthorized' };

  const status = typeof e.statusCode === 'number' ? e.statusCode : undefined;
  if (status === 429) {
    const retryAfter = retryAfterSeconds(e.responseHeaders);
    return { status: 429, code: 'upstream_rate_limited', upstreamStatus: 429, ...(retryAfter !== undefined ? { retryAfter } : {}) };
  }
  if (status === 401 || status === 403) return { status: 502, code: 'upstream_unauthorized', upstreamStatus: status };
  if (status === 408 || status === 504) return { status: 504, code: 'upstream_timeout', upstreamStatus: status };
  if (status !== undefined) return { status: 502, code: 'upstream_unavailable', upstreamStatus: status };

  // No status at all: a transport failure (DNS, refused, reset) or an abort that timed out. `fetch`
  // Reports these as a TypeError whose message is uninformative, so the name/cause is all there is.
  if (e.name === 'AI_APICallError') return { status: 502, code: 'upstream_unavailable' };
  if (e.name === 'TimeoutError') return { status: 504, code: 'upstream_timeout' };
  return undefined;
}
