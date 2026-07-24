// Public API type helpers — types expressing intent instead of `any` (consumers get these from @gnl/durable).
import type { LanguageModelV2 } from '@ai-sdk/provider';

/** An AI SDK model OR a 'provider/model' string (resolved via the model router). */
export type ModelInput = LanguageModelV2 | string;

/** The minimal tool surface durableTool can wrap (AI SDK `tool()` output or {execute}). */
export interface AnyTool {
  execute?: (input: any, options: any) => any;
  description?: string;
  inputSchema?: unknown;
  /**
   * H7 SAFE DEFAULT: an unmarked tool is considered SIDE-EFFECTFUL (sideEffect ?? idempotent !== true).
   * A side-effectful tool is NOT AUTOMATICALLY RETRIED after `failed` AND on stale-'running' (crash
   * window) reclaim unless the user explicitly grants permission via `approvals[toolCallId]=true`
   * (e.g. tools like payment/withdrawal that create a double side-effect if run twice). If unspecified
   * (undefined), it is NOT automatically RE-RUN (requires approvals[toolCallId]=true). Mark a tool
   * whose repetition is harmless as `idempotent: true` → smooth retry/reclaim comes back (subject to maxRetries).
   */
  sideEffect?: boolean;
  /** The synonymous inverse of `sideEffect`: `idempotent === false` ⇔ `sideEffect === true`. */
  idempotent?: boolean;
  /**
   * GOREV (taint-aware guard): this tool's OUTPUT is EXTERNAL/UNTRUSTED content (web fetch, inbox
   * read, RAG retrieval — anything an attacker could have authored). Once such an output enters the
   * conversation, the run is marked TAINTED (journaled, monotonic for the rest of the run) and every
   * SUBSEQUENT side-effect tool call goes through the `limits.taintedSideEffects` action ladder —
   * the runtime's conservative answer to prompt injection: it cannot know WHICH tokens influenced
   * the model (model-internal flow tracking is not a thing), so it treats every post-taint side
   * effect as suspect. Unmarked tools produce no taint → the feature costs nothing until you declare
   * a source. (A tool-result processor can also set taint dynamically — see markRunTainted.)
   */
  untrusted?: boolean;
  /**
   * GOREV 4.3: total number of attempts allowed after `failed` for this tool (retry limit).
   * If unspecified, the reasonable default (3) in durable-tool.ts is used. Once the limit is
   * reached, the record stays permanently 'failed' — there is NO infinite automatic retry loop.
   */
  maxRetries?: number;
  /**
   * H9 — ASK THE PROVIDER FOR THE TRUTH (automates exactly-once): on a crash window (stale
   * 'running') or an ambiguous 'failed' (e.g. timeout — it may have gone through on the server side!),
   * the framework calls THIS instead of asking a human: "did the operation with this idempotencyKey happen?"
   *   { done: true, output }  → the side effect ALREADY happened → the result is recorded, the run continues automatically (NO retry).
   *   { done: false }         → it never happened → safely retried automatically.
   * If it throws/is undefined → safe last resort: an approval gate (SideEffectRetryBlockedError).
   * Example (Stripe): look up the charge by idempotencyKey and return the result if found.
   */
  recover?(input: any, opts: { idempotencyKey: string; toolCallId: string }): Promise<{ done: true; output: unknown } | { done: false }>;
  /**
   * GOREV (saga/compensation — `recover`'s twin, in the reverse direction): HOW TO UNDO this tool's side effect
   * (refund the charge, release the reservation, delete the created record). Called ONLY by an
   * EXPLICIT `compensateRun(runId, …)` — NEVER automatically on failure (a transient failure +
   * resume is GNL's whole point; auto-unwinding would refund a charge the resume then re-charges).
   * Receives the ORIGINAL input and output (the journal stores `input` on succeeded records of
   * compensate-bearing tools precisely for this) + a stable `idempotencyKey` to carry to the
   * downstream API (a refund must be exactly-once too — the framework journals each compensation
   * with the same claim/terminal discipline as the original execution). Design the hook IDEMPOTENT:
   * a crash between the downstream call and the journal write means one retried delivery.
   */
  compensate?(input: any, output: any, opts: { idempotencyKey: string; toolCallId: string; runId: string }): Promise<unknown>;
  /**
   * Y1 (opt-in): the timeout (ms) applied to this tool's execute. On timeout the tool is written as
   * 'failed' (side-effect ambiguity is resolved via the H9 recover / approval ladder) and an
   * AbortSignal is passed to execute (cooperative cancellation). If unspecified, ctx.toolTimeoutMs
   * (runDurable `timeouts.toolMs`) applies, and if that's also absent, there is NO timeout
   * (existing behavior).
   */
  timeoutMs?: number;
  /**
   * Y3 (opt-in): the threshold (ms; default 30s) at which a 'running' claim is considered stale.
   * Raise it for a tool that LEGITIMATELY runs longer than 30 seconds — otherwise a concurrent
   * resume may think it "crashed" and (if idempotent) start a SECOND copy. Also configurable
   * run-wide via ctx.claimTtlMs.
   */
  claimTtlMs?: number;
  /**
   * GOREV (argument-based idempotency, opt-in): the TYPE of the exactly-once key.
   *   - 'call' (DEFAULT): today's behavior — the journal key is the `toolCallId` given by the AI SDK.
   *   - 'args': the journal key is derived from the tool's ARGUMENTS (argsHash, or the hash of
   *     `idempotencyKey` if given). Even if the model produces a NEW `toolCallId` with the SAME
   *     arguments (a known LLM behavior — a documented AI SDK pattern: a model can call the same tool
   *     with the same arguments multiple times in a single turn, each time with a DIFFERENT toolCallId),
   *     ALL of these calls fall onto the SAME journal key → the tool runs only ONCE, the others get
   *     the same output from the journal. If `idempotencyKey` is given, this mode is ALREADY IMPLIED
   *     (no need to also specify it). The claim/retry/approval/recover (H7/H9) ladder works exactly
   *     the same over the SAME key; the only difference is that when a PARALLEL duplicate in the
   *     same turn loses the claim, instead of the 'call' mode's `RunBusyError` it waits via short-
   *     interval POLLING until a terminal record (upper bound: claimTtl) — it does NOT stop the run
   *     by mistake.
   *     SCOPE BOUNDARY: the window is RUN-SCOPED (the journal key is prefixed with `${runId}:`) by
   *     DEFAULT. For cross-run dedup, opt into `idempotencyWindow: 'cross-run'` (below).
   */
  idempotency?: 'call' | 'args';
  /**
   * GOREV (optional custom dedup key, e.g. `(args) => args.orderId`): IF GIVEN, it FORCES 'args'
   * mode even if the `idempotency` field isn't separately specified. The returned string is embedded
   * into the journal key NOT AS-IS but HASHED (so characters like ':' don't break the
   * `${runId}:tool:args-...` key SCHEMA). If different arguments (e.g. different incidental fields)
   * share the SAME logical key (e.g. the same orderId), it collapses to a single execution.
   */
  idempotencyKey?: (input: unknown) => string;
  /**
   * GOREV (cross-run dedup, opt-in): the DEDUP WINDOW's scope.
   *   - 'run' (DEFAULT): today's behavior UNCHANGED — the args-idempotency journal key is prefixed
   *     with `${runId}:`, so the SAME arguments in a DIFFERENT run execute again (see `idempotency`
   *     field's SCOPE BOUNDARY note above).
   *   - 'cross-run': the dedup window is widened to SPAN RUNS — e.g. "orderId=X gets charged exactly
   *     ONCE no matter which run/retry it comes from" (a retried job, an agent re-triggered from a
   *     queue). Giving `'cross-run'` IMPLIES 'args' mode (no need to also specify `idempotency: 'args'`
   *     or `idempotencyKey`) — the journal key derives from the tool's arguments (or `idempotencyKey`),
   *     same as 'args' mode, just WITHOUT the `${runId}:` prefix.
   *     HONEST LIMITS (read before opting in):
   *     (a) the record is NOT tied to any runId, so run-retention/sweep (which deletes by runId prefix)
   *         does NOT clean it up — it is PERMANENT until explicitly purged via
   *         `journal.deletePrefix('xrun:')` (see runKeys.toolCrossRun in journal.ts).
   *     (b) because the window is SHARED across runs, a 'failed' record left by ONE run puts a
   *         DIFFERENT run's call to the SAME arguments onto the SAME retry/approval ladder (claim/
   *         poll/retry/recover) — this is INTENTIONAL (the natural consequence of sharing the window),
   *         not a bug.
   */
  idempotencyWindow?: 'run' | 'cross-run';
}

/** Agent tool set (name → tool). */
export type ToolSet = Record<string, AnyTool>;
