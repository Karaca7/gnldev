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
 * A refusal, in the three parts that make one teachable.
 *
 * Taken from rustc, whose diagnostics are never two parts: what already happened (past tense, because
 * it has), why that matters and what it costs, and a line to copy. Ours stopped at the first —
 * `run 'x' is locked by another process` is accurate, unactionable, and reads as breakage even when it
 * is the protection doing its job.
 *
 * ONE formatter rather than three hand-built strings, for the same reason `formatProtections` is one
 * function: the shape is what a reader learns, and a shape maintained in several places is a shape
 * that means something slightly different in each. The indentation is part of it — an error body is
 * often dumped into a log line, and the two-space limbs are what keep it readable there.
 */
export function teachingError(parts: { error: string; note: string; help: string }): string {
  const wrap = (label: string, body: string): string =>
    `\n  ${label}: ${body.split('\n').map((l, i) => (i === 0 ? l : `        ${l.trim()}`)).join('\n')}`;
  return `${parts.error}${wrap('note', parts.note)}${wrap('help', parts.help)}`;
}

/**
 * The `run_busy` sentence, in one place, because it is thrown from four.
 *
 * WHAT THE NOTE HAS TO SAY, and why it is the whole point of this rewrite: a 409 reads as "something
 * broke", and the honest reading here is usually the opposite — one run is doing the work and a
 * duplicate was declined, which is what the lock was asked to do. A caller who cannot tell those apart
 * writes a retry loop around a lock, and a retry loop around a lock is how a transient collision turns
 * into a stampede.
 *
 * WHICH WORD THE HELP USES, now that there are two. The gate still hangs on the runId — that is what
 * the lock is keyed by, and it always will be — but the caller who reads this usually did not choose
 * one: they named the work and the engine derived `run1_<digest>` from that name (§8 of
 * docs/RUNID-WORKKEY-HEYET-KARARI.md). Telling them to "use a different runId" would be advice about
 * a field they never filled in. So the help speaks the axis the caller actually holds — one workKey
 * is one job — and names the raw surface in a parenthesis, because `runDurable`/`resumeRun` callers
 * genuinely do hold the id and the sentence has to stay true for them too.
 *
 * The ERROR line keeps the id and only the id, per the same section's three-line rule: an error
 * string is the most casually logged field there is, and a workKey is free text a caller chose.
 */
export function runBusyMessage(what: string): string {
  return teachingError({
    error: `@gnldev/durable: ${what}`,
    note:
      'the second run was NOT started — nothing ran twice, and no partial work was left behind.\n' +
      'If you meant to run one thing once, this is the normal outcome and not an error to\n' +
      'retry around: the first run is still going and will produce the answer.',
    help:
      'To follow the run that IS live, use its id — responses carry it as `X-Gnl-Run-Id`.\n' +
      'To start genuinely different work, give it a different NAME: one workKey is one job,\n' +
      'so two jobs sent under one workKey are one job as far as this gate is concerned.\n' +
      'On the raw surface the id IS the name — there, pass a different runId.',
  });
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
 * run start (fingerprint mismatch). Same family as RunThreadMismatchError: a caller mistake with no
 * resolution path for THIS runId+content pair → 409 without `resumable`. Exemption at the check
 * site: an approval addressed to a toolCallId whose journal record is genuinely 'suspended' (the
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
 * bound into the frozen input, first-wins). No actor on either side = no check (an auth-less profile
 * has no protection here — documented, not silent).
 */
/**
 * A request named a SUBJECT and a THREAD that belong to different people.
 *
 * `@gnldev/server` already refuses this at the edge (`threadOwnershipDenied`, 403) — but the edge is
 * one of several ways in. chat-adapter, agui and batch reach the engine directly, and there the only
 * thing a thread id had to be was a string: whoever sent it got that conversation's history loaded
 * into the model's prompt, and this turn appended to it. The check therefore lives with the memory
 * load rather than with any one route.
 *
 * SILENT WHEN EITHER SIDE IS UNKNOWN, deliberately: a first turn creates the thread and has no owner
 * yet, and a caller that names no subject is the operator case the whole ownership rule exempts.
 * Refusing an unknown owner would refuse every new conversation.
 */
export class ThreadOwnerMismatchError extends Error {
  constructor(
    message: string,
    public readonly detail: { threadId: string; owner: string; requested: string },
  ) {
    super(message);
    this.name = 'ThreadOwnerMismatchError';
  }
}

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
 * A DERIVED run (`run1_<digest>`) was addressed by somebody other than the person it belongs to.
 *
 * The sibling of `RunActorMismatchError`, and deliberately not the same error: `actor` is the opaque
 * caller identity a `critical` deployment opts into, while this one is about the SUBJECT the run was
 * born under (`resourceId`) and it is never opt-in. Inside `run1_` the id is a hash of a scope and a
 * name, so an id is no longer something only its owner could know — anyone who can compute the digest
 * can spell it. Unguessability was never the defence here (§11 says so out loud); this check is.
 *
 * WHY THE ENGINE AND NOT THE EDGE (§6, condition 2b). `@gnldev/server` has an ownership gate, and it
 * is one of several doors: chat-adapter, agui, batch, the CLI and every embedded host reach the
 * engine directly, and an embedded deployment has no HTTP layer at all. The scenario that made this
 * blocking is quiet rather than dramatic — a `workScope: 'org'` declared where `'resource'` was meant
 * hands two tenants ONE digest, so tenant B's call replays tenant A's answer and every gate upstream
 * sees a perfectly ordinary request for an id that exists.
 *
 * SCOPED TO `run1_`, on purpose. A raw runId keeps today's behaviour byte for byte: it is a name the
 * caller chose, and hosts legitimately hand one run between workers under their own rules. What
 * changes inside the derived namespace is that the engine minted the id, so the engine is the one
 * that knows who it was minted for.
 *
 * Family rule: 409 WITHOUT `resumable` — no retry clears it — and, like its siblings, it must NOT
 * count as the victim's run failing (`outcome.ts`'s `NOT_A_RUN_FAILURE`): a refused stranger may not
 * rewrite a finished run's history to 'failed'.
 */
export class RunOwnerMismatchError extends Error {
  constructor(
    message: string,
    public readonly detail: { runId: string; owner: string; requested: string },
  ) {
    super(message);
    this.name = 'RunOwnerMismatchError';
  }
}

/**
 * FAZ-4 (critical profile, `tombstonePolicy: 'reject'`) — the runId was retention-swept
 * (`${runId}:swept` tombstone) and a late retry arrived AFTER the dedup window died with the run.
 * Re-running it silently would repeat the side effects the swept journal used to dedup; the critical
 * profile refuses instead. The REAL contract remains: retention window ≥ client retry horizon.
 */
export class RunSweptError extends Error {
  constructor(
    message: string,
    /**
     * `workKeyHash`/`workScope` come off the TOMBSTONE, which is all the storage side has left: the
     * swept run's workKey text is gone on purpose (§10.3), so the refusal can say "this id used to
     * name a job, in a resource scope" without resurrecting the name. The caller's OWN workKey is
     * echoed back into this detail from the REQUEST — by the HTTP surfaces, in packages #3/#5, since
     * they are the ones holding it. A late retry therefore reads its own name plus a hash it can
     * match against a log line, and the deletion still stands.
     */
    public readonly detail: { runId: string; sweptAt?: number; workKeyHash?: string; workScope?: 'resource' | 'org' },
  ) {
    super(message);
    this.name = 'RunSweptError';
  }
}

/**
 * K1: maps the class name of the three "blocked" errors above → the snake_case error code sent to
 * the client. The SINGLE source of truth — @gnldev/server (sse.ts), @gnldev/agui (route.ts) and
 * @gnldev/studio (server.ts) all use this same map here (previously each package had its own copy that
 * needed to stay in sync).
 */
/**
 * FAZ-4 K9: the caller-conflict family's SINGLE code map — server, chat-adapter AND agui all consume
 * this one export (a literal copy per consumer is exactly the drift that left agui unmapped in the
 * first cut). Same contract for every member: 409 WITHOUT `resumable` (the id/content/actor is what
 * needs fixing; no retry clears it).
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

/**
 * Bu runId bir AJAN koşumuna ait değil — bir iş akışı, AĞ ya da batch item koşumuna ait.
 *
 * `<runId>:input` iki farklı işi birden görüyor: ajan yolunda DONMUŞ GİRDİ (prompt/messages/system),
 * iş akışı/ağ/batch yolunda ise yalnız KİMLİK ({resourceId, workflow|network|batch, …}) — sahiplik kapısı,
 * `listRuns({resourceId})` ve `purgeResource` o anahtarı okuduğu için. Ajan yolu anahtarın
 * VARLIĞINI "girdi donmuş" diye okur, ve bir kimlik kaydını benimsemek prompt/messages/system'ı
 * undefined'a set eder: boş girdiyle model çağrısı, üstüne o id'nin altına karışan ajan kayıtları.
 *
 * Aile gereği 409 + `resumable` YOK: düzeltilecek şey id'nin kendisi, hiçbir retry temizlemez.
 */
export class NotAnAgentRunError extends Error {
  constructor(
    message: string,
    public readonly detail: { runId: string; kind: 'workflow' | 'network' | 'batch'; name?: string },
  ) {
    super(message);
    this.name = 'NotAnAgentRunError';
  }
}

export const CALLER_CONFLICT_CODES: Record<string, string> = {
  RunThreadMismatchError: 'run_thread_mismatch',
  NotAnAgentRunError: 'not_an_agent_run',
  RunInputMismatchError: 'run_input_mismatch',
  RunActorMismatchError: 'run_actor_mismatch',
  RunOwnerMismatchError: 'run_owner_mismatch',
  ThreadOwnerMismatchError: 'thread_owner_mismatch',
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
  // by NAME here (blockedErrorCode works via err.name) — workflow stays zero-dependency, and a blocked
  // workflow step surfacing through runWorkflow → server/agui/studio still renders a typed code
  // instead of falling through to the generic 400.
  StepRetryBlockedError: 'step_retry_blocked',
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
/**
 * The four codes above, as an ENUMERABLE value rather than only a union in the interface below.
 *
 * A union type vanishes at compile time, so `scripts/check-error-pages.mjs` — which reads BUILT
 * modules on purpose — could not see this family at all. Measured: all four were on the wire with no
 * page under `docs/errors/`, and nothing said so, while the two families that happen to be maps had
 * been fully covered since the day the check was written. That is not a fact about how important
 * these codes are; it is a fact about which ones the check could enumerate.
 *
 * Keyed by the situation, not by an error class, because that is what this family is: `upstreamFailure`
 * classifies a duck-typed provider error, and no single class name maps to a code here.
 */
export const UPSTREAM_ERROR_CODES = {
  rateLimited: 'upstream_rate_limited',
  unauthorized: 'upstream_unauthorized',
  unavailable: 'upstream_unavailable',
  timeout: 'upstream_timeout',
} as const;

export interface UpstreamFailure {
  /** HTTP status to answer the CALLER with — never the upstream's status verbatim (see below). */
  status: 429 | 502 | 504;
  code: (typeof UPSTREAM_ERROR_CODES)[keyof typeof UPSTREAM_ERROR_CODES];
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
 *   would tell the caller to fix an API key it has never seen and cannot reach.
 * a timeout becomes **504**, other 5xx and transport failures become **502** — a dependency broke,
 *   which is the definition of a bad gateway.
 * a 4xx the provider blamed on the request body (400/404/422) also becomes **502**: the request the
 *   provider rejected is the one WE built, not the one the caller sent.
 */
export function upstreamFailure(err: unknown): UpstreamFailure | undefined {
  const e = unwrapRetry(err) as
    | { name?: string; statusCode?: number; responseHeaders?: unknown; message?: string; cause?: unknown }
    | null
    | undefined;
  if (!e || typeof e !== 'object') return undefined;

  if (e.name === 'AI_LoadAPIKeyError') return { status: 502, code: UPSTREAM_ERROR_CODES.unauthorized };

  const status = typeof e.statusCode === 'number' ? e.statusCode : undefined;
  if (status === 429) {
    const retryAfter = retryAfterSeconds(e.responseHeaders);
    return { status: 429, code: UPSTREAM_ERROR_CODES.rateLimited, upstreamStatus: 429, ...(retryAfter !== undefined ? { retryAfter } : {}) };
  }
  if (status === 401 || status === 403) return { status: 502, code: UPSTREAM_ERROR_CODES.unauthorized, upstreamStatus: status };
  if (status === 408 || status === 504) return { status: 504, code: UPSTREAM_ERROR_CODES.timeout, upstreamStatus: status };
  if (status !== undefined) return { status: 502, code: UPSTREAM_ERROR_CODES.unavailable, upstreamStatus: status };

  // No status at all: a transport failure (DNS, refused, reset) or an abort that timed out. `fetch`
  // reports these as a TypeError whose message is uninformative, so the name/cause is all there is.
  if (e.name === 'AI_APICallError') return { status: 502, code: UPSTREAM_ERROR_CODES.unavailable };
  if (e.name === 'TimeoutError') return { status: 504, code: UPSTREAM_ERROR_CODES.timeout };
  return undefined;
}

/**
 * HTTP status per wire code — the single source `check:errors` binds every docs surface to.
 *
 * Until this existed the status lived in three unlinked places — the route literal, a JSDoc
 * sentence, the docs page — and drifted exactly once before it was caught: `dead_scan_busy` taught
 * 409 on two doc surfaces while its route answered 429. The route tests pin the wire behaviour to
 * these numbers; this map pins the documentation to the same ones. A new code without an entry here
 * fails the checker, which is the moment its author still knows the status.
 */
export const WIRE_ERROR_STATUS: Record<string, number> = {
  // caller-conflict — all 409: something about the request needs fixing; no retry clears it
  run_thread_mismatch: 409,
  not_an_agent_run: 409,
  run_input_mismatch: 409,
  run_actor_mismatch: 409,
  run_owner_mismatch: 409,
  thread_owner_mismatch: 409,
  run_swept: 409,
  batch_plan_mismatch: 409,
  // blocked — the run is waiting on a decision; the same id succeeds once it clears
  side_effect_retry_blocked: 409,
  retry_limit_exceeded: 422,
  run_busy: 409,
  step_retry_blocked: 409,
  // upstream — chosen for what the caller should DO, never copied (see upstreamFailure)
  upstream_rate_limited: 429,
  upstream_unauthorized: 502,
  upstream_unavailable: 502,
  upstream_timeout: 504,
};
