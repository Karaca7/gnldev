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
 * GOREV 4.3: a `failed` record for a side-effectful (non-idempotent) tool is NOT automatically
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
 * GOREV 4.3: a tool's `failed` record reached the `maxRetries` limit → left permanently failed
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
 * GOREV (Task 2 — Redis WAIT opt-in, `RedisStorageOptions.waitReplicas`): after a successful claim
 * (putIfAbsent/putIfMatch genuinely wrote something new), fewer than the requested number of replicas
 * acknowledged the write within the timeout (native Redis `WAIT`). The claim itself already happened —
 * this only means the async-replication gap (CORE-HARDENING.md §8.2: a claim acked only by the primary
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
 * GOREV (Task 3 — suite-consistency guard, `assertSuiteConsistent`/`createGnl({ checkSuiteConsistency })`):
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
