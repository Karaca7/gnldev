// Public API type helpers — types expressing intent instead of `any` (consumers get these from @gnldev/durable).
import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { SemanticIdentity } from './semantic-dup.js';

/** An AI SDK model OR a 'provider/model' string (resolved via the model router). */
export type ModelInput = LanguageModelV4 | string;

/** Static description text, or undefined when the SDK computes it dynamically (see AnyTool.description). */
export function toolDescriptionText(t: { description?: unknown } | undefined): string | undefined {
  return typeof t?.description === 'string' ? t.description : undefined;
}

/** The minimal tool surface durableTool can wrap (AI SDK `tool()` output or {execute}). */
export interface AnyTool {
  execute?: (input: any, options: any) => any;
  /**
   * AI SDK 7 allows a DYNAMIC description — a function the SDK calls with the tool's context. Any
   * place we render one without that context (the network router's tool list, MCP's manifest, the
   * firewall's poisoning hash) has no honest string to show, so `toolDescriptionText` returns
   * undefined rather than stringifying a function into a model prompt.
   */
  description?: string | ((options: any) => string);
  inputSchema?: unknown;
  /**
   * H7 SAFE DEFAULT: an unmarked tool is considered SIDE-EFFECTFUL (sideEffect ?? idempotent !== true).
   * A side-effectful tool is NOT AUTOMATICALLY RETRIED after `failed` AND on stale-'running' (crash
   * Window) reclaim unless the user explicitly grants permission via `approvals[toolCallId]=true`
   * (e.g. tools like payment/withdrawal that create a double side-effect if run twice). If unspecified
   * (undefined), it is NOT automatically RE-RUN (requires approvals[toolCallId]=true). Mark a tool
   * Whose repetition is harmless as `idempotent: true` → smooth retry/reclaim comes back (subject to maxRetries).
   */
  sideEffect?: boolean;
  /** The synonymous inverse of `sideEffect`: `idempotent === false` ⇔ `sideEffect === true`. */
  idempotent?: boolean;
  /**
   * This tool's OUTPUT is EXTERNAL/UNTRUSTED content (web fetch, inbox
   * Read, RAG retrieval — anything an attacker could have authored). Once such an output enters the
   * Conversation, the run is marked TAINTED (journaled, monotonic for the rest of the run) and every
   * SUBSEQUENT side-effect tool call goes through the `limits.taintedSideEffects` action ladder —
   * The runtime's conservative answer to prompt injection: it cannot know WHICH tokens influenced
   * The model (model-internal flow tracking is not a thing), so it treats every post-taint side
   * Effect as suspect. Unmarked tools produce no taint → the feature costs nothing until you declare
   * A source. (A tool-result processor can also set taint dynamically — see markRunTainted.)
   */
  untrusted?: boolean;
  /**
   * Total number of attempts allowed after `failed` for this tool (retry limit).
   * If unspecified, the reasonable default (3) in durable-tool.ts is used. Once the limit is
   * Reached, the record stays permanently 'failed' — there is NO infinite automatic retry loop.
   */
  maxRetries?: number;
  /**
   * H9 — ASK THE PROVIDER FOR THE TRUTH (automates exactly-once): on a crash window (stale
   * 'running') or an ambiguous 'failed' (e.g. timeout — it may have gone through on the server side!),
   * The framework calls THIS instead of asking a human: "did the operation with this idempotencyKey happen?"
   *   { done: true, output }  → the side effect ALREADY happened → the result is recorded, the run continues automatically (NO retry).
   *   { done: false }         → it never happened → safely retried automatically.
   * If it throws/is undefined → safe last resort: an approval gate (SideEffectRetryBlockedError).
   * Example (Stripe): look up the charge by idempotencyKey and return the result if found.
   */
  recover?(input: any, opts: { idempotencyKey: string; toolCallId: string }): Promise<{ done: true; output: unknown } | { done: false }>;
  /**
   * HOW TO UNDO this tool's side effect
   * (refund the charge, release the reservation, delete the created record). Called ONLY by an
   * EXPLICIT `compensateRun(runId, …)` — NEVER automatically on failure (a transient failure +
   * Resume is GNL's whole point; auto-unwinding would refund a charge the resume then re-charges).
   * Receives the ORIGINAL input and output (the journal stores `input` on succeeded records of
   * Compensate-bearing tools precisely for this) + a stable `idempotencyKey` to carry to the
   * Downstream API (a refund must be exactly-once too — the framework journals each compensation
   * With the same claim/terminal discipline as the original execution). Design the hook IDEMPOTENT:
   * A crash between the downstream call and the journal write means one retried delivery.
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
   * Resume may think it "crashed" and (if idempotent) start a SECOND copy. Also configurable
   * Run-wide via ctx.claimTtlMs.
   */
  claimTtlMs?: number;
  /**
   * The TYPE of the exactly-once key.
   * 'call' (DEFAULT): today's behavior — the journal key is the `toolCallId` given by the AI SDK.
   * 'args': the journal key is derived from the tool's ARGUMENTS (argsHash, or the hash of
   *     `idempotencyKey` if given). Even if the model produces a NEW `toolCallId` with the SAME
   *     Arguments (a known LLM behavior — a documented AI SDK pattern: a model can call the same tool
   *     With the same arguments multiple times in a single turn, each time with a DIFFERENT toolCallId),
   * ALL of these calls fall onto the SAME journal key → the tool runs only ONCE, the others get
   *     The same output from the journal. If `idempotencyKey` is given, this mode is ALREADY IMPLIED
   *     (no need to also specify it). The claim/retry/approval/recover (H7/H9) ladder works exactly
   *     The same over the SAME key; the only difference is that when a PARALLEL duplicate in the
   *     Same turn loses the claim, instead of the 'call' mode's `RunBusyError` it waits via short-
   *     Interval POLLING until a terminal record (upper bound: claimTtl) — it does NOT stop the run
   *     By mistake.
   * SCOPE BOUNDARY: the window is RUN-SCOPED (the journal key is prefixed with `${runId}:`) by
   * DEFAULT. For cross-run dedup, opt into `idempotencyWindow: 'cross-run'` (below).
   */
  idempotency?: 'call' | 'args';
  /**
   * (optional custom dedup key, e.g. `(args) => args.orderId`): IF GIVEN, it FORCES 'args'
   * Mode even if the `idempotency` field isn't separately specified. The returned string is embedded
   * Into the journal key NOT AS-IS but HASHED (so characters like ':' don't break the
   * `${runId}:tool:args-...` key SCHEMA). If different arguments (e.g. different incidental fields)
   * Share the SAME logical key (e.g. the same orderId), it collapses to a single execution.
   */
  idempotencyKey?: (input: unknown) => string;
  /**
   * The DEDUP WINDOW's scope.
   * 'run' (DEFAULT): today's behavior UNCHANGED — the args-idempotency journal key is prefixed
   *     With `${runId}:`, so the SAME arguments in a DIFFERENT run execute again (see `idempotency`
   *     Field's SCOPE BOUNDARY note above).
   * 'cross-run': the dedup window is widened to SPAN RUNS — e.g. "orderId=X gets charged exactly
   * ONCE no matter which run/retry it comes from" (a retried job, an agent re-triggered from a
   *     Queue). Giving `'cross-run'` IMPLIES 'args' mode (no need to also specify `idempotency: 'args'`
   *     Or `idempotencyKey`) — the journal key derives from the tool's arguments (or `idempotencyKey`),
   *     Same as 'args' mode, just WITHOUT the `${runId}:` prefix.
   * HONEST LIMITS (read before opting in):
   *     (a) the record is NOT tied to any runId, so run-retention/sweep (which deletes by runId prefix)
   *         Does NOT clean it up — it is PERMANENT until explicitly purged via
   *         `journal.deletePrefix('xrun:')` (see runKeys.toolCrossRun in journal.ts).
   *     (b) because the window is SHARED across runs, a 'failed' record left by ONE run puts a
   * DIFFERENT run's call to the SAME arguments onto the SAME retry/approval ladder (claim/
   *         Poll/retry/recover) — this is INTENTIONAL (the natural consequence of sharing the window),
   *         Not a bug.
   * 'thread' (FAZ-3): the window spans every run OF ONE CONVERSATION — "this thread already created
   *     That product yesterday" dedups, while another user's thread legitimately creates its own.
   *     IMPLIES 'args' mode, keys under `xthr:<threadId>:` (runKeys.toolThread) so `purgeThread`
   *     Reclaims the records WITH the thread (the cross-run 'immortal key' problem does not recur).
   *     Requires a `threadId` at call time — without one it falls back to 'run' with a LOUD
   *     Console.warn (silent fallback would report dedup the caller isn't getting).
   * SINGLE-HOME BOUND (all shared windows): 'cross-run' and 'thread' dedup live in ONE journal
   *     Store — independent journals (multi-region) are independent windows; route a business key's
   *     Traffic to its home journal or the "exactly once" here silently becomes "once per region"
   *     (full statement: the Journal interface JSDoc's SCOPE note).
   * USE THE RIGHT LAYER: silent windows are for DETERMINISTIC business keys (an orderId/SKU via
   *     `idempotencyKey`) where dedup is unambiguously correct. For LLM-derived raw args, silence is
   *     Wrong by design — an identical-looking second request may be a genuine second intent; that
   *     Case belongs to the suspend ladder (`limits.sideEffectDuplicates: 'suspend'` or `confirm`),
   *     Where a human answers.
   */
  idempotencyWindow?: 'run' | 'cross-run' | 'thread';
  /**
   * FAZ-3 — first-call HUMAN gate, declared on the tool itself (no guard factory needed). SCOPE: the
   * Gate is PER toolCallId ('call' mode) / per dedup key ('args' mode) — a model issuing a NEW call
   * Of the same tool asks again; it is not a once-per-tool switch. The fresh call suspends with the
   * Standard `__gnl_suspend` sentinel and waits for
   * `approvals[toolCallId]` — the SAME approvals flow as guard suspensions (Studio inbox, chat
   * `approve()`), so nothing new to wire. `true` uses a generic reason; `{ reason }` derives one from
   * The args ("charge 5000 TRY to card ****42 — confirm?"). A pre-supplied approval skips the gate
   * (and still passes the guard, if one exists). Deny writes a terminal 'denied' record.
   * WHERE IT SITS in the dedup hierarchy (docs): deterministic dedup (idempotencyKey/unique
   * Constraint) > human gate (`confirm`, suspend ladders) > probabilistic mitigations (working
   * Memory). `confirm` is the tool-author's declaration that this effect is consequential enough to
   * Ask a human EVERY first time — not a substitute for an idempotencyKey.
   */
  confirm?: boolean | { reason?: (args: unknown) => string };
  /**
   * FAZ-6 — the tool-level half of the semantic dup gate's DOUBLE opt-in (the run-level half is
   * `limits.sideEffectDuplicates.semantic`). Declares which arg fields carry the business IDENTITY
   * (`keys` — required, non-empty, THROWS empty), which carry magnitudes (`amountFields`) and which
   * Flip the action's meaning (`discriminatorFields` — cancel/direction booleans+enums). The
   * Embedding only FINDS candidates; these declared fields DECIDE, and a human confirms. The
   * Declaration's quality IS the protection's quality (a per-call-unique key silently disables the
   * Layer — documented limit, telemetry is the only signal). See semantic-dup.ts.
   */
  semanticIdentity?: SemanticIdentity;
  /**
   * Yan-etki SINIFI beyanı (heyet matrisi): tekrarın bedeli işe göre değişir — para durdurur-sorar,
   * bildirim atlar-söyler, upsert sessiz replay'lenir. Preset'lerin sınıf-bazlı politika matrisi
   * (policy-matrix.ts) bu beyanla eşleşir; beyansız araç profilin default hücresine düşer.
   */
  effectClass?: import('./policy-matrix.js').EffectClass;
  /**
   * FAZ-7 — read-before-write's framework leg (a LAYER-1 tightening: same-key duplicates; it cannot
   * See a different-args same-intent request — that is the suspend/semantic gates' job). On a FRESH
   * First attempt of a side-effect tool, the engine asks the EXTERNAL system before firing:
   * `{exists: true, output}` → the effect already exists downstream; `output` is journaled as this
   * Call's success and the body never runs. `{exists: false}` → execute normally. A throw is
   * Fail-open with a loud warn (proceeding as not-found IS today's behavior — a flaky lookup must
   * Not block work it cannot decide about). Distinct from `recover` on purpose (İhtilaf D):
   * `recover` answers the CRASH window after a failure; `lookup` answers BEFORE the first attempt.
   */
  lookup?(input: any, opts: { idempotencyKey: string; toolCallId: string }): Promise<{ exists: true; output: unknown } | { exists: false }>;
}

/** Agent tool set (name → tool). */
export type ToolSet = Record<string, AnyTool>;

/**
 * The durability options a tool can carry, without the AI SDK tool surface.
 *
 * These live on the tool object and are read by `durableTool`, but `runDurable`'s `tools` parameter
 * is the AI SDK's `ToolSet`, whose type has no idea they exist. Writing them inline inside `tool({…})`
 * is therefore an excess-property error — TypeScript rejects the CORRECT code — while writing them
 * on a plain object literal type-checks a misspelling like `sideEffct` into silence. Neither
 * direction is acceptable for the options that decide whether a card is charged twice.
 */
export type ToolDurability = Pick<
  AnyTool,
  | 'sideEffect' | 'idempotent' | 'idempotency' | 'idempotencyKey' | 'idempotencyWindow'
  | 'untrusted' | 'maxRetries' | 'timeoutMs' | 'claimTtlMs' | 'recover' | 'compensate' | 'confirm' | 'semanticIdentity' | 'lookup' | 'effectClass'
>;

/**
 * Attaches durability options to an AI SDK tool, with both halves type-checked.
 *
 * ```ts
 * const chargeCard = gnlTool(
 *   tool({ description: '…', inputSchema: z.object({ amount: z.number() }), execute: charge }),
 *   { sideEffect: true, idempotency: 'args' },
 * );
 * ```
 *
 * `tool()` is evaluated first, so its schema inference for `execute` is untouched; the second
 * argument is checked against ToolDurability, so a misspelt option is a compile error rather than a
 * field the runtime silently ignores.
 */
export function gnlTool<T>(t: T, durability: ToolDurability): T {
  return Object.assign(t as any, durability) as T;
}

/**
 * A tool-schema compatibility rule, declared STRUCTURALLY here rather than imported from
 * `@gnldev/tool-schema`.
 *
 * That package is an OPTIONAL peer — the whole point of `schemaCompat` being opt-in is that a caller
 * who does not use it never installs it. But `run.d.ts` and `registry.d.ts` referenced its types
 * unconditionally, and a published `.d.ts` is compiled by the CONSUMER. Measured on a project with
 * every required peer installed and only this optional one absent, `skipLibCheck: false`:
 *
 *   run.d.ts(9,37):      error TS2307: Cannot find module '@gnldev/tool-schema'
 *   registry.d.ts(3,37): error TS2307: Cannot find module '@gnldev/tool-schema'
 *
 * So "optional" held at install time and at runtime, and broke at typecheck — for people who had done
 * nothing wrong except not opt in. `skipLibCheck: true` hides it, which is why it went unnoticed.
 *
 * Structural, so a caller who DOES install the package can still pass the real `ToolSchemaRule`: the
 * shapes are compatible by definition, and tool-schema's own test suite asserts that both directions
 * stay assignable so the two cannot drift apart silently.
 */
export interface ToolSchemaRuleLike {
  /** Stable, unique name (for logging/diagnostics). */
  name: string;
  /** Does this rule apply to the given model? */
  shouldApply(model: { provider: string; modelId: string }): boolean;
  /** Transform the JSON Schema (may mutate in place and return the same object). */
  transform(schema: Record<string, any>, model: { provider: string; modelId: string }): Record<string, any>;
}
