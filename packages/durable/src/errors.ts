// @gnldev/durable error types. Separate file: imported by both journal and durable-tool/run-lock.

/**
 * Non-determinism detected during replay: the argsHash of a succeeded tool record doesn't match
 * the hash of the new input produced by the model during replay. Thrown in `replay:'strict'` mode.
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
 * execute in-flight). Thrown by opt-in concurrency control.
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
 * the double side-effect risk — e.g. double charging). Unmarked tools never throw this error (backward compatible).
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
 * instead of an infinite automatic retry loop (the record stays 'failed' in the journal, not retried again).
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
 * acknowledged the write within the timeout (native Redis `WAIT`). The claim itself already happened —
 * this only means the async-replication gap (the core-hardening review: a claim acked only by the primary
 * can be lost on the replica promoted during failover) could not be ruled out within the deadline.
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
 * an INSTALLED sibling @gnldev/* package's version differs from @gnldev/durable's own — a project that
 * bypassed the package manager's caret range (--force/overrides/manual node_modules edits) ended up
 * with an incompatible suite. Thrown only when `onMismatch: 'throw'` was requested (default is 'warn' —
 * see suite-consistency.ts).
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
 * K1: maps the class name of the three "blocked" errors above → the snake_case error code sent to
 * the client. The SINGLE source of truth — @gnldev/server (sse.ts), @gnldev/agui (route.ts) and
 * @gnldev/studio (server.ts) all use this same map here (previously each package had its own copy that
 * needed to stay in sync).
 */
export const BLOCKED_ERROR_CODES: Record<string, string> = {
  SideEffectRetryBlockedError: 'side_effect_retry_blocked',
  RetryLimitExceededError: 'retry_limit_exceeded',
  RunBusyError: 'run_busy',
};

/**
 * Returns the blocked error code for the given error (if any). Works via `err?.name` (NOT
 * instanceof) — to be resilient since class identity can differ across dist/src build boundaries
 * (in the same spirit as the existing `instanceof X || name === 'X'` pattern in
 * packages/server/src/index.ts). Returns undefined if there's no match.
 */
export function blockedErrorCode(err: unknown): string | undefined {
  const name = (err as { name?: unknown } | null | undefined)?.name;
  return typeof name === 'string' ? BLOCKED_ERROR_CODES[name] : undefined;
}

/**
 * What an upstream failure should look like to the caller.
 *
 * Everything the taxonomy above recognises is OURS — a limit we enforced, a lock we held, a retry we
 * refused. A failure from the model provider matches none of them, so it fell through to a generic
 * 400: measured on a live rig, a free endpoint answering 429 arrived at the caller as
 * `400 {"error":"Failed after 3 attempts. Last error: Too Many Requests"}`. 400 means "your request
 * was malformed", the request was fine, and a client with retry logic reads 400 as "never retry" —
 * exactly backwards from what a 429 is asking for.
 *
 * Duck-typed on purpose. These errors come from the AI SDK, which this package does not and should
 * not depend on; matching on `name` and reading `statusCode` keeps the taxonomy free of that edge and
 * works for any provider that follows the same shape.
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
 * - 429 stays **429** with `Retry-After` — the one case where the caller's own backoff is the answer.
 * - 401/403 becomes **502**, NOT 401. The credential that failed is the OPERATOR's; answering 401
 *   would tell the caller to fix an API key it has never seen and cannot reach.
 * - a timeout becomes **504**, other 5xx and transport failures become **502** — a dependency broke,
 *   which is the definition of a bad gateway.
 * - a 4xx the provider blamed on the request body (400/404/422) also becomes **502**: the request the
 *   provider rejected is the one WE built, not the one the caller sent.
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
  // reports these as a TypeError whose message is uninformative, so the name/cause is all there is.
  if (e.name === 'AI_APICallError') return { status: 502, code: 'upstream_unavailable' };
  if (e.name === 'TimeoutError') return { status: 504, code: 'upstream_timeout' };
  return undefined;
}
