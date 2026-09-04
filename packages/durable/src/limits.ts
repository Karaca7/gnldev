// Per-run COST CAP + RUNAWAY protection. Competitive report (wave 1-#2): 63 budget-overrun
// Incidents, a single retry loop costing thousands of dollars, sub-agent fan-out bypassing the budget.
// `budget.ts` enforces the ORGANIZATION-scoped (long-term) quota; this file enforces the RUN-scoped (single
// Run) cap — the TWO COMPLEMENT each other, neither replaces the other. FULLY OPT-IN: if `limits` is
// Not provided (undefined/unset fields), no check runs → existing tests/behavior are preserved AS-IS.
//
// (audit — O(step³) finding): previously `checkToolGate`/`enforceStepLimits`/`scopedUsage` fetched
// ALL of the run's records (+ RECURSIVELY the sub-runs) via `readRun(runId)` on EVERY call — for an
// N-step run that's O(N) scan per step × N steps = O(N²) (even worse with fan-out). This file now keeps
// CUMULATIVE counters in a SINGLE per-run "limit state" key (`runKeys.proc(runId, '__gnl_limits_state')`
// runKeys.proc is the SAME family as other internal journals (model-claim, stream-checkpoint); it is
// INVISIBLE to parseJournalKey, does NOT affect reader/time-travel/forkRun):
// IF the key EXISTS: O(1) `get` + (only if there's new data) UPDATE with targeted O(1) `get`s — no readRun.
// IF the key DOES NOT EXIST (the run's FIRST encounter with limits — a fresh run or an old run that
//     Later had limits enabled): computed FROM SCRATCH with a ONE-TIME `readRun`, and the key is SEEDED
//     (backward compatible: correct count on an old run's resume) — from the NEXT call onward it drops to O(1).
// Model steps are STRICTLY SEQUENTIAL and NEVER OVERWRITTEN once written (durable-model.ts: `step`
// Only increments AFTER a SUCCESSFUL journal write) → `enforceStepLimits` finds new steps by "chasing"
// The `runKeys.model` keys IN ORDER with targeted `get`s (see `computeModelStepsDelta`) — ENTIRELY
// Targeted reads, no readRun. Tool calls, on the other hand, are keyed by toolCallId (opaque, not
// Sequential) and `checkToolGate` decides BEFORE execution (prospectively) — WHICH IS WHY it cannot yet
// Know this call's OUTCOME; the state update (loop chain/succeeded counter/fan-out toolCallId list) is
// Instead done via `recordToolOutcome` at the MOMENT durable-tool.ts writes the tool's OUTCOME to the
// Journal (checkToolGate ITSELF still only READS — the read/write responsibility stays separated, no confusion).
//
// AUDIT FIX (lost-update — Finding A): previously ALL fields (numeric counters + loop chain + fan-out
// List) lived TOGETHER in a SINGLE '__gnl_limits_state' key, written via `get`→(in-memory mutate)→`put`.
// Because the AI SDK runs a model step's tools in PARALLEL via `Promise.all` (confirmed), two concurrent
// `recordToolOutcome` calls would read the SAME stale struct and BOTH write the ENTIRE struct back (not
// Just the field EACH ONE changed) → the second `put` SILENTLY overwrote the first one's increment
// (succeededToolCalls/totalTokens/costUsd/consecutiveRepeats PERMANENTLY undercounted; maxToolCalls/
// MaxCostUsd/loopDetection silently UNDER-enforced — the limit-BREACH direction, the unsafe side).
//
// FIX: the state is now SPLIT into TWO SEPARATE keys:
// `__gnl_limits_counters`: ONLY PURELY-ADDITIVE numeric fields (modelStepsSeen/totalTokens/costUsd/
//     SucceededToolCalls) — written ATOMICALLY via `journal.incrBy` (H8a, engine-internal atomic: SQL
// UPSERT arithmetic/Redis HINCRBYFLOAT), read via `getCounters`. incrBy is COMMUTATIVE: no matter
// WHICH ORDER two concurrent deltas are applied in, both are summed WITHOUT LOSS — the "last writer
//     Wins" risk of a struct-put is STRUCTURALLY eliminated. On an adapter without incrBy (e.g. a custom
// RedisLike client) it falls back to get→put (the SAME fallback pattern as budget.ts's `addUsage` —
// SINGLE-PROCESS safe, the old bound still applies under distributed contention, documented risk).
// `__gnl_limits_state` (name preserved): ONLY the RESETTABLE/conditional "chain" fields
//     (lastToolName/lastArgsHash/consecutiveRepeats/subRunIds) — these are NOT additive (RESET to
//     0/undefined when the chain breaks), don't fit incrBy; so they're written via `journal.putIfMatch`
//     (H1) with CAS-RETRY (up to 3 attempts: read → apply mutate → `putIfAbsent` if the key is missing /
//     `putIfMatch(read-value, new-value)` if present; if lost, retry with the FRESH value). On an adapter
//     Without putIfMatch, (again) a get→put fallback — SINGLE-PROCESS safe, the same documented bound
//     (the SAME spirit as the H1/H8a fallbacks elsewhere in this file).
// SEEDING (`ensureSeeded`): on the run's FIRST encounter with limits (a ONE-TIME full scan via
//     ReadRun), the reconstructed counters are now written via `incrBy` INSTEAD OF a put — so that a
// LIVE increment (incrBy) that happens to interleave with the seeding is NOT LOST (thanks to incrBy's
//     Commutativity — "subsequent increments are never lost"). SEEDING ITSELF (the readRun scan) is
//     Limited to a SINGLE winner via an ATOMIC `putIfAbsent` on the chain key (or a `claim()` get+put
//     Fallback if unavailable): if multiple concurrent "first encounter" calls happen, only the winner
//     Scans + seeds, the losers fall through to the normal live-increment path (`recordToolOutcome` below).
// KNOWN NARROW BOUND (documented, knowingly accepted): a losing `recordToolOutcome` call's OWN
//     ToolCallId may (depending on timing) ALREADY have been captured by the winner's scan — in that
//     Case that ONE event may rarely be DOUBLE counted. This is a narrow race window that can occur only
// ONCE in the run's LIFETIME (at the moment of first encounter, and only if it's TRULY concurrent) —
// NOT a persistent/ongoing drift, in the SAME spirit as the file's "advisory + single-executor
//     Assumption" bound (see the COMPATIBILITY NOTE below). BEYOND this (steady-state — once the run is
//     Already seeded) ALL concurrent `recordToolOutcome` calls are LOSSLESS thanks to incrBy/CAS-retry —
//     This is exactly the main (and frequently recurring) Finding A scenario (see test/limits-concurrency.test.ts).
//
// COMPATIBILITY NOTE (fail-safe direction): if a toolCallId transitions failed→succeeded (or
// Suspended→approved→succeeded) via crash+resume — ONLY in this RARE crash-resume-retry scenario — the
// Loop chain's consecutive count may (briefly) also count that toolCallId's INTERMEDIATE transient state
// As a chain-breaker; this can ONLY make the chain appear SHORTER than it is (never LONGER) → it ONLY
// REDUCES conservatism (the false-negative direction — it may skip a block, it will NEVER block WRONGLY).
// Cost counters are NOT AFFECTED by this transition (the terminal status per toolCallId is counted
// Exactly once). The `succeededToolCalls` counter NOW ALSO counts a FAILED SIDE-EFFECT attempt (audit
// C3 — the effect may have executed before the throw), so a failed→succeeded transition on a side-effect
// Tool may count that ONE toolCallId TWICE — but only ever in the OVER-count (limit-STRICTER, fail-SAFE)
// Direction, never under. Failed read-only tools and running intermediate statuses are still never counted.
//
// The determinism principle is PRESERVED: counters are cumulative sums DERIVED from journal records (no
// In-memory shared counter — the keys live in the journal) → resume/replay still produces the SAME result.
//
// TWO DIFFERENT THROW PATHS (BECAUSE OF the AI SDK's tool-execute error-swallowing behavior — see NOTE):
// Model-step limits (maxTokens/maxCostUsd): thrown directly AFTER doGenerate in durable-model.ts —
//    A model-call error TRULY rejects generateText (unlike a tool error, it isn't swallowed).
// Tool-step limits (maxToolCalls/loop): the AI SDK's `executeTools` swallows EVERY error thrown from
//    Tool.execute and turns it into a 'tool-error' content part (so the model can self-correct) — that's
//    Why, instead of THROWING here, a SENTINEL (the SAME pattern as guard.ts's `__gnl_suspend`) is
// RETURNED: `checkToolGate` returns the block info WITHOUT the tool ever RUNNING (nothing written to
//    The journal); run.ts's composeStopWhen detects this like a suspend and stops the loop, and
//    RunDurableInner converts the sentinel into a real error and throws it IMMEDIATELY AFTER generateText
//    Returns normally (BEFORE memory/recordRunUsage). Because nothing was written to the journal, a
//    Blocked call is re-evaluated FROM SCRATCH on the NEXT attempt once the limit is RAISED (replay
//    Regenerates the same toolCallId) — no approval is REQUIRED (DIFFERENT from guard's require-approval).
import { claim, runKeys, nestedAgentRunId } from './journal.js';
import { usageAndCostFromModelValue, type RunCostOptions } from './cost.js';
import { effectivePricingTable } from './pricing.js';
import type { Journal, JournalReader, ToolJournalRecord } from './journal.js';

/** Per-run runaway protection (opt-in): fields that aren't provided are not enforced. */
export interface RunLimits {
  /**
   * If the cumulative USD cost EXCEEDS (>) this value, the run stops.
   *
   * HONEST BOUND (audit C1): this is checked AFTER a model step is fully journaled — it stops the run
   * BEFORE the NEXT step, it does NOT cap a SINGLE step's spend. One step whose output balloons can land
   * ABOVE this ceiling (and is billed) before the run halts (observed: a $-cap crossed mid-step). It
   * Bounds the RUNAWAY (the loop can't keep spending), not the exact total. To bound a single step, pass a
   * Provider-side `max_tokens`/`max_completion_tokens` through the model.
   */
  maxCostUsd?: number;
  /**
   * If the cumulative total tokens (input+output+cached) EXCEED (>) this value, the run stops.
   *
   * HONEST BOUND (audit C1): same per-step granularity as `maxCostUsd` — checked AFTER the step is
   * Journaled, so a single step can OVERSHOOT this value (observed: a 900 cap stopped at 1521 real
   * Tokens). It stops the run before the next step; it is not a hard single-step ceiling.
   */
  maxTokens?: number;
  /** If the count of tool-call ATTEMPTS REACHES (>=) this number, the NEXT call is blocked. Counts every
   *  Successful tool call PLUS every FAILED SIDE-EFFECT call (audit C3: a side-effect tool that executed
   *  Its effect then threw counts — a failed READ-ONLY tool does not). Denied/suspended/reflected (never
   *  Executed) do not count. */
  maxToolCalls?: number;
  /**
   * Loop detection (opt-in, a separate field — OFF if not provided): if the same tool + same argsHash
   * Ran SUCCESSFULLY `maxRepeats` times in a row, the NEXT identical repeat is blocked WITHOUT RUNNING.
   *
   * `onRepeat` (default `'block'` — existing behavior byte-for-byte unchanged):
   * `'block'`: the repeat is stopped via the ToolLoopDetectedError sentinel (the run ends).
   * `'reflect'`: ONE "reconsider" nudge is returned to the model AS THE TOOL RESULT instead (the
   *    Call is NOT executed, the run CONTINUES — the model can reuse the previous result or take a
   *    Different action). If the model IGNORES the nudge and repeats with IDENTICAL arguments again,
   *    It falls back to the hard block (warn once → then stop; insistence is never auto-trusted for
   *    A side-effecting repeat).
   *
   * HONEST BOUNDS of 'reflect' (why it is still safe to enable):
   * Efficacy is MODEL-dependent: the runtime GUARANTEES the nudge is delivered (journaled,
   *    Replay-identical) and that an identical repeat afterwards hard-blocks — it cannot guarantee
   *    The model USES the nudge well. Worst case ≡ 'block' plus one model step; best case the run
   *    Recovers instead of dying. The duplicate-execution surface is IDENTICAL to 'block' in both cases.
   * The detector (both modes) only sees CONSECUTIVE identical calls; a run oscillating between
   *    Different calls is real work to it. Pair 'reflect' with `maxToolCalls`/`maxCostUsd` so a
   *    Nudge→other-call→repeat oscillation stays bounded (defense in depth, not an alternative).
   */
  loopDetection?: { maxRepeats?: number; onRepeat?: 'block' | 'reflect' };
  /**
   * What to do when a SIDE-EFFECT tool (H7 signal —
   * `tool.sideEffect ?? tool.idempotent !== true`, i.e. everything not explicitly marked safe) in
   * DEFAULT 'call' mode is about to EXECUTE AGAIN with arguments identical to an earlier SUCCESSFUL
   * Call of the same run. This is the exact window `idempotency: 'args'` closes when the developer
   * Remembers to set it — this guard is the runtime's answer for when they FORGET (the journal knows
   * A duplicate is happening; staying silent would be complicity).
   *
   * DEFAULT `'warn'` (H7 spirit: the safety net must not depend on remembering to opt in): the call
   * Still executes — behavior is unchanged — but a console warning names the incident and BOTH exits
   * (repeats harmless → `idempotent: true`; must never duplicate → `idempotency: 'args'` +
   * `idempotencyKey`, or escalate this setting).
   * `'off'`: no detection (and no marker bookkeeping).
   * `'warn'` (default): execute + console warning per occurrence.
   * `'reflect'`: ONE reconsider nudge to the model (same contract as loopDetection's reflect —
   *    Journaled 'reflected' record, replay-identical); an identical repeat after the nudge → block.
   * `'block'`: stop via the DuplicateSideEffectError sentinel (nothing written — same contract
   *    As the loop block: re-evaluated from scratch if the config is relaxed).
   * `'suspend'`: write a suspended record with the standard `__gnl_suspend` shape → the run
   *    Suspends and the duplicate lands in the Approvals flow (a HUMAN decides the ambiguous case);
   *    An approval for that toolCallId executes it exactly once.
   *
   * HONEST BOUNDS: (1) detection is per-run and builds from LIVE successes (a run started before
   * This feature has no markers for its old successes); (2) SAME-STEP parallel identical duplicates
   * (the documented duplicate-toolCallId pattern) run before either succeeds — `idempotency: 'args'`'s claim/poll ladder is the
   * Correct tool there, this guard covers the cross-step window; (3) 'warn' proves nothing was
   * Prevented — it is the adoption ramp toward the stricter modes, not the destination.
   *
   * FAZ-3 object form — `{ action, scope, ttlMs }`:
   * `scope: 'thread'` widens the marker to THE CONVERSATION (key `xthr:<threadId>:dup-…`, taintScope
   *    Precedent): "this thread already fired that exact effect YESTERDAY, in another run" is caught,
   *    Which the per-run marker is structurally blind to. Pair it with `action: 'suspend'` for the
   *    Chat story — the ambiguous repeat becomes an approval question carrying `firstToolCallId`, so
   *    The UI can show the FIRST result next to the question (an uninformed approval is not an
   *    Approval). Requires threadId (loud warn + run-scope fallback without one).
   * `ttlMs` (optional) expires the marker: past it, an identical call is NOT treated as a duplicate.
   *    DEFAULT IS NO TTL — deliberately (heyet İhtilaf F): a false positive costs one extra approval
   *    Question, a false negative fires the effect twice; the marker lives as long as the thread and
   *    Dies with it (`purgeThread` sweeps `xthr:<threadId>:`).
   * Plain-string form ≡ `{ action, scope: 'run' }` — every existing caller byte-for-byte unchanged.
   */
  sideEffectDuplicates?:
    | 'off' | 'warn' | 'reflect' | 'block' | 'suspend'
    | { action: 'off' | 'warn' | 'reflect' | 'block' | 'suspend'; scope?: 'run' | 'thread'; ttlMs?: number };
  /**
   * How far one human approval reaches.
   *
   * An approval answers a specific question — "this crashed mid-flight and the effect MAY have
   * landed; attempt it anyway?" — and it is journaled per toolCallId so a crash cannot lose the
   * decision. That is the default, `'call'`: the answer stands for that call, and further attempts
   * are bounded by `maxRetries`.
   *
   * The cost of that convenience is that a later resume faces the SAME uncertainty afresh and
   * proceeds on an answer the operator gave about an EARLIER attempt. For a payment that is one
   * click authorising several charges, most of them unasked. `'attempt'` spends the approval on the
   * attempt it unblocks: if that attempt fails, the next one asks again.
   *
   * A DENIAL is never spent under either setting — it keeps denying without re-asking.
   *
   * Default `'call'`, which is the behaviour that shipped; choose `'attempt'` where a repeat is
   * expensive enough that a second click is cheaper than a second effect.
   */
  approvalScope?: 'call' | 'attempt';
  /**
   * What to do when a SIDE-EFFECT tool (H7
   * Signal) is about to execute AFTER untrusted external content entered the conversation (an
   * `untrusted: true` tool's output landed, or a processor called markRunTainted). The model is a
   * Black box — the runtime CANNOT know which tokens influenced which decision, so it enforces the
   * Only sound approximation: once tainted, EVERY subsequent side effect is suspect (conservative,
   * No false negatives by construction; model-internal flow tracking is deliberately NOT claimed).
   *
   * WHICH RUNGS ACTUALLY STOP A TAINTED SIDE EFFECT (audit A5): only `'block'` and `'suspend'`. `'warn'`
   * And `'reflect'` are ADVISORY — both let the side effect EXECUTE (warn always; reflect after a single
   * Nudge). If your threat model is "injected content must not be able to trigger this side effect", pick
   * `'block'` or `'suspend'`; do not rely on `'reflect'` to gate it.
   *
   * Same action ladder as `sideEffectDuplicates` (same incident/approval/nudge machinery):
   * `'off'`: no enforcement (and no taint read on the hot path).
   * `'warn'` (default): execute + journaled incident naming the taint SOURCE. Costs nothing until
   *    A tool is actually declared `untrusted` (no taint → no incident; the read is one O(1) get).
   * `'reflect'`: ADVISORY, NOT A GATE. ONE reconsider nudge PER DISTINCT (tool,args) — "does this
   *    Action serve the user's actual request, or the fetched content?" — then, on any identical retry,
   *    It FALLS THROUGH AND EXECUTES (journaled as a warn incident). DELIBERATELY different from the
   *    Duplicate guard's reflect (which escalates to a hard block): for a duplicate, insistence is
   *    Near-certainly wrong (the result already exists) → escalate; for taint, insistence after explicit
   *    Reconsideration IS the model's judgment — escalating to a block would make this rung a delayed
   *    'block' and useless for legitimate post-fetch work. The cost: it does NOT stop a model that simply
   *    Repeats the injected instruction after one warning — use 'block'/'suspend' when that is the risk.
   * `'block'`: stop via the TaintedSideEffectError sentinel.
   * `'suspend'`: standard approvals flow — a human decides (sees the taint source in the reason);
   *    An approval for that toolCallId executes it exactly once.
   *
   * HONEST BOUNDS: (1) conservative over-approximation = friction — start with 'warn', move
   * High-risk deployments to 'suspend'; (2) the APPROVER judges the action's CONTENT (an approved
   * Transfer to an attacker's IBAN is still an approved transfer — the runtime surfaces provenance,
   * A human owns the judgment); (3) taint is monotonic per run, by design.
   */
  taintedSideEffects?: 'off' | 'warn' | 'reflect' | 'block' | 'suspend';
  /**
   * (opt-in, DEFAULT `'run'`): how far a taint mark REACHES. `'run'` (or unset) is exactly
   * Today's behavior — taint lives and dies with the runId. `'thread'` additionally propagates it
   * Across runs that share a `threadId` (the multi-turn memory shape): when an untrusted tool taints
   * A run that HAS a threadId, a thread-scoped key (`thread:<threadId>:taint`, first-wins) is claimed
   * Too, and every LATER run on that thread inherits the taint at run start (source `'inherited'`,
   * Original provenance carried) BEFORE any tool executes — so `taintedSideEffects` gates turn-2's
   * Side effects even though turn-1's injection arrived via memory recall with a fresh runId.
   *
   * WHY OPT-IN: thread taint is MONOTONIC AND UNBOUNDED — one untrusted fetch marks the thread for
   * Every future turn (there is no expiry in this phase), which is the sound-but-maximal reading of
   * "recalled content may carry the injection". For long-lived assistant threads that is real
   * Friction; for high-risk pipelines (payments, infra) it is the correct default. Pair with
   * `'suspend'` so a human clears the flagged turns.
   *
   * HONEST BOUNDS: (1) requires a `threadId` on the runs — no threadId, nothing to propagate;
   * (2) a processor calling `markRunTainted` directly (3-arg form) marks only the RUN — pass
   * `{ threadId }` as the 4th argument to reach the thread; (3) by DEFAULT the thread mark is
   * Persistent even after the tainted messages were pruned/summarized out of recall — the opt-in
   * `taintLifetime: 'content-window'` (taint phase 3, below) models exactly that content-lifetime
   * Nuance and lets the taint expire once the poisoned content leaves everything the model sees.
   */
  taintScope?: 'run' | 'thread';
  /**
   * TAINT PHASE 3 (opt-in, DEFAULT `'persistent'`): how LONG a THREAD taint keeps gating. Only
   * Meaningful together with `taintScope: 'thread'` — with any other scope this option is a NO-OP
   * (there is no thread carry to expire; the per-run mark always lives and dies with its run).
   *
   * `'persistent'` (or unset) is exactly the phase-1 behavior: the thread mark is monotonic and
   * Never expires. `'content-window'` refines it with the content-lifetime insight: the injection
   * Danger only exists while the poisoned content is still VISIBLE to the model. Memory is a sliding
   * Window (`recentN`) — once the tainting messages have scrolled out of what `getMessages`/
   * `loadContext` returns AND are not recalled back AND are not hiding in working memory, the taint
   * Can safely expire. Mechanics: messages appended by a DIRECTLY-tainted run (source 'tool'/
   * 'processor' — not 'inherited') are content-hashed into a thread provenance record
   * (`thread:<id>:taintProv`, taint.ts); at every later run start the inherit step checks whether any
   * Provenance hash is present in the messages ACTUALLY loaded for THIS run (recent + recalled — so
   * Semantic recall re-surfacing an old poisoned message REVIVES the taint) or whether working memory
   * Is non-empty. Absent everywhere → the thread taint is treated as EXPIRED for this run (the thread
   * Key itself is kept LATENT, not cleared — a later recall can still revive it).
   *
   * HONEST BOUNDS (all fail toward OVER-gating, never early expiry, except (4)):
   *  (1) WORKING MEMORY is checked conservatively — ANY non-empty WM keeps the taint (we cannot tell
   *      Whether the poison was summarized into it). Resource-scoped WM (`@gnldev/memory` `scope:
   *      'resource'`) is read via `getWorkingMemory(threadId)` and may be missed — pair OM/resource-WM
   *      Setups with `'persistent'` if that matters to you.
   *  (2) memory-SYNTHESIZED content: any system-role message in the loaded window (the OM
   *      Observations shape) keeps the taint — summaries cannot be hash-attributed.
   *  (3) no provenance record (the tainting run had no memory attached, or pre-phase-3 taint) →
   *      Never expires (persistent fallback).
   *  (4) TRANSITIVE ECHOES are NOT tracked: messages of runs that only INHERITED taint are not
   *      Stamped (stamping them would re-extend the window every turn and the taint could never
   *      Expire). If the model copied the injected instruction into its own reply during a tainted
   *      Turn, that echo expires with the window like any other message — the deliberate trade that
   *      Makes expiry possible at all.
   *  (5) provenance matching requires the Memory implementation to return appended messages
   *      Structurally unchanged (JSON round-trip is fine; a transforming adapter or a history-
   *      Rewriting input processor breaks the match — combine those with `'persistent'`).
   */
  taintLifetime?: 'persistent' | 'content-window';
  /**
   * C4 (opt-in escape hatch, DEFAULT false/undefined): maxCostUsd/maxTokens/maxToolCalls/loopDetection
   * Can ONLY be enforced on a journal that implements `readRun` (all first-party adapters do; a
   * Hand-written `Journal` with only get/put/putIfAbsent does NOT). When such a journal is used with
   * Limits configured, the DEFAULT is to fail OPEN with a LOUD one-time `console.warn` naming exactly
   * Which protections are silently disabled. Set `strict: true` to instead THROW at the enforcement
   * Point — turning a silent non-enforcement into a hard, visible failure. Does NOT change behavior on
   * Journals that already have `readRun` (limits enforce normally regardless of this flag).
   */
  strict?: boolean;
}

export type RunLimitKind = 'maxCostUsd' | 'maxTokens' | 'maxToolCalls';

/**
 * The per-run cost/quota cap was exceeded. At the moment it's thrown, the journal is ALWAYS consistent
 * (the step/tool call that caused the breach is FULLY written — NO half-step, or for tool-step limits
 * NOTHING was written at all); only the CONTINUATION of the run stops. If `limits` is raised and the
 * SAME runId is resumed, it continues from where it left off.
 */
export class RunLimitExceededError extends Error {
  constructor(
    message: string,
    public readonly detail: { kind: RunLimitKind; value: number; limit: number },
  ) {
    super(message);
    this.name = 'RunLimitExceededError';
  }
}

/**
 * The same tool + same argsHash ran SUCCESSFULLY `maxRepeats` times in a row — a loop was detected.
 * The count is derived from the SUCCESSFUL tool records in the journal (replay-safe); this is thrown
 * WITHOUT WRITING ANYTHING to the journal (the tool never RAN) → the journal always stays consistent.
 */
export class ToolLoopDetectedError extends Error {
  constructor(
    message: string,
    public readonly detail: { toolName: string; argsHash: string; repeats: number; maxRepeats: number },
  ) {
    super(message);
    this.name = 'ToolLoopDetectedError';
  }
}

/**
 * A side-effect tool was about to EXECUTE AGAIN with arguments identical to an earlier
 * Successful call of the same run, and the policy stopped it. Thrown via the same sentinel path as
 * ToolLoopDetectedError (nothing written for the blocked call → journal stays consistent; relaxing
 * The policy and resuming re-evaluates from scratch).
 */
export class DuplicateSideEffectError extends Error {
  constructor(
    message: string,
    public readonly detail: { toolName: string; argsHash: string; firstToolCallId: string; toolCallId: string },
  ) {
    super(message);
    this.name = 'DuplicateSideEffectError';
  }
}

/**
 * A
 * Side-effect tool was about to execute after untrusted content entered the conversation, and the
 * Policy stopped it. Same sentinel path/consistency contract as DuplicateSideEffectError.
 */
export class TaintedSideEffectError extends Error {
  constructor(
    message: string,
    public readonly detail: { toolName: string; toolCallId: string; taintSource: { toolCallId: string; toolName: string } },
  ) {
    super(message);
    this.name = 'TaintedSideEffectError';
  }
}

// ── Per-run limit-state keys ─────────────────────────────────────
// INTERNAL journals like runKeys.proc — INVISIBLE to parseJournalKey (only `${runId}:model:*` /
// `${runId}:tool:*` are made visible), meaning it does not affect any existing mechanism other than
// Reader/time-travel/forkRun/retention.purgeRun's `${runId}:` prefix-deletion.
const LIMITS_CHAIN_NAME = '__gnl_limits_state';
const LIMITS_COUNTERS_NAME = '__gnl_limits_counters';

/** Purely-ADDITIVE (monotonically increasing) counters — written ATOMICALLY via H8a `incrBy` (see the FIX note at the top of the file). */
interface LimitCounters {
  /** The NEXT model-step index to be read (0-based) — ALL steps below this index have been counted. */
  modelStepsSeen: number;
  totalTokens: number;
  costUsd: number;
  /** The count of this run's OWN (EXCLUDING fan-out) successful tool calls. */
  succeededToolCalls: number;
}

/** RESETTABLE/conditional "loop chain" fields — DON'T FIT incrBy, written via CAS-retry (putIfMatch). */
interface LimitChain {
  /** Loop chain: a FORWARD rolling counter that is MATHEMATICALLY IDENTICAL to "how many times in a row
   * SUCCEEDED with the same tool+argsHash, counted backward from the END of the journal" (see the
   * COMPATIBILITY NOTE at the top of the file). */
  lastToolName?: string;
  lastArgsHash?: string;
  consecutiveRepeats: number;
  /** The reconsider nudge has been DELIVERED for THIS chain (see
   * RunLimits.loopDetection.onRepeat) — the next identical repeat escalates to the hard block. Reset
   *  Together with the chain (any different/failed call builds a fresh object without the flag).
   * Absent on records written before this field existed → false (backward compatible). */
  reflected?: boolean;
  /** toolCallIds seen from this run's tool entries — candidates for fan-out inheritance
   *  (`agent:${toolCallId}`); `sumSubRuns` sums these RECURSIVELY with O(1) `get`s (no readRun). */
  subRunIds: string[];
}

function emptyCounters(): LimitCounters {
  return { modelStepsSeen: 0, totalTokens: 0, costUsd: 0, succeededToolCalls: 0 };
}

function emptyChain(): LimitChain {
  return { consecutiveRepeats: 0, subRunIds: [] };
}

function chainKey(runId: string): string {
  return runKeys.proc(runId, LIMITS_CHAIN_NAME);
}

function countersKey(runId: string): string {
  return runKeys.proc(runId, LIMITS_COUNTERS_NAME);
}

/** The minimal surface accepted by checkToolGate/enforceStepLimits/recordToolOutcome: the real
 *  `ctx.journal` (Journal) ALWAYS provides get/put; CAS/counter primitives (H1/H8a) are used IF
 * AVAILABLE (otherwise falls back to fail-open/get→put); readRun comes from JournalReader (optional).
 * ALL fields are kept optional (to STAY COMPATIBLE with the existing `as unknown as JournalReader`
 *  Cast at the CALL SITES) — whichever is missing, that path is silently skipped (fail-open). */
type LimitsStore = Partial<Pick<Journal, 'get' | 'put' | 'putIfAbsent' | 'putIfMatch' | 'incrBy' | 'getCounters'>> &
  Partial<JournalReader>;

async function readChain(store: LimitsStore, runId: string): Promise<LimitChain | undefined> {
  if (typeof store.get !== 'function') return undefined;
  return store.get<LimitChain>(chainKey(runId));
}

/** H8a unified read: `getCounters` on adapters that support `incrBy`; otherwise a plain-key `get`
 *  (the same one the fallback write path uses). */
async function readCounters(store: LimitsStore, runId: string): Promise<LimitCounters | undefined> {
  if (typeof store.getCounters === 'function') {
    const c = await store.getCounters(countersKey(runId));
    if (c) {
      return {
        modelStepsSeen: c.modelStepsSeen ?? 0,
        totalTokens: c.totalTokens ?? 0,
        costUsd: c.costUsd ?? 0,
        succeededToolCalls: c.succeededToolCalls ?? 0,
      };
    }
  }
  if (typeof store.get === 'function') {
    const c = await store.get<LimitCounters>(countersKey(runId));
    if (c) return c;
  }
  return undefined;
}

/** H8a unified write (delta): ATOMIC at the engine level IF `incrBy` is AVAILABLE (lost-update is
 *  Impossible — see the FIX note at the top of the file); otherwise/on failure falls back to get→put
 *  (the SAME pattern as budget.ts's `addUsage` — SINGLE-PROCESS safe fallback, documented bound). Zero
 *  Deltas are SKIPPED to reduce noise. */
async function incrCounters(store: LimitsStore, runId: string, delta: Partial<LimitCounters>): Promise<void> {
  const clean: Record<string, number> = {};
  for (const [k, v] of Object.entries(delta)) if (v) clean[k] = v;
  if (Object.keys(clean).length === 0) return;
  if (typeof store.incrBy === 'function') {
    try {
      await store.incrBy(countersKey(runId), clean);
      return;
    } catch {
      // A custom client (e.g. a RedisLike without hincrbyfloat) → the legacy path
    }
  }
  if (typeof store.get !== 'function' || typeof store.put !== 'function') return;
  warnCasFallback(store, '`incrBy` (or its call failed)');
  const current = (await store.get<LimitCounters>(countersKey(runId))) ?? emptyCounters();
  await store.put(countersKey(runId), {
    modelStepsSeen: current.modelStepsSeen + (clean.modelStepsSeen ?? 0),
    totalTokens: current.totalTokens + (clean.totalTokens ?? 0),
    costUsd: current.costUsd + (clean.costUsd ?? 0),
    succeededToolCalls: current.succeededToolCalls + (clean.succeededToolCalls ?? 0),
  });
}

/** (distributed honesty — mirrors journal.ts claim()'s warn-once): the get→put fallbacks below
 *  Are SILENT degradations on custom journals that omit a CAS primitive (all first-party adapters
 *  Provide them — see the parity matrix in journal.ts). Single-process they are safe; multi-worker
 *  They can lose updates. A degradation this consequential must be SAID once, not discovered in prod. */
const casFallbackWarned = new WeakSet<object>();
function warnCasFallback(store: object, missing: string): void {
  if (casFallbackWarned.has(store)) return;
  casFallbackWarned.add(store);
  console.warn(
    `@gnldev/durable: this journal does not implement ${missing} — limit-state updates fell back to get→put. ` +
      'Safe in single-process usage; in multi-worker/distributed environments concurrent updates can be ' +
      'LOST (limits may under-enforce). Implement the primitive (see the Journal interface / parity matrix in journal.ts).',
  );
}

const CHAIN_CAS_ATTEMPTS = 3;

/**
 * Updates the chain fields (lastToolName/lastArgsHash/consecutiveRepeats/subRunIds) via CAS-RETRY: if
 * `putIfMatch`/`putIfAbsent` are AVAILABLE, up to `CHAIN_CAS_ATTEMPTS` attempts (read → apply `mutate` →
 * `putIfAbsent` if the key is missing / `putIfMatch(read-value, new-value)` if present; if lost, retry
 * With the FRESH value) — a loser NEVER blindly overwrites. IF the CAS primitives are UNAVAILABLE (or
 * All attempts are exhausted under high contention), falls back to get→put: SINGLE-PROCESS safe, a rare
 * INTERMEDIATE update may be overwritten under distributed multi-worker contention — the SAME as the
 * "advisory" bound documented at the top of the file.
 */
async function writeChainCas(
  store: LimitsStore,
  runId: string,
  mutate: (chain: LimitChain) => LimitChain,
): Promise<void> {
  if (typeof store.put !== 'function' || typeof store.get !== 'function') return;
  const key = chainKey(runId);
  for (let attempt = 0; attempt < CHAIN_CAS_ATTEMPTS; attempt++) {
    const current = await store.get<LimitChain>(key);
    const next = mutate(current ?? emptyChain());
    if (current === undefined) {
      if (typeof store.putIfAbsent === 'function') {
        if (await store.putIfAbsent(key, next)) return;
        continue; // someone created it before us — retry with the fresh value
      }
      warnCasFallback(store, '`putIfAbsent`');
      await store.put(key, next);
      return;
    }
    if (typeof store.putIfMatch === 'function') {
      if (await store.putIfMatch(key, current, next)) return;
      continue; // an interleaving write happened — retry with the fresh value
    }
    warnCasFallback(store, '`putIfMatch`');
    await store.put(key, next);
    return;
  }
  // High contention: CHAIN_CAS_ATTEMPTS exhausted → last-resort best-effort get→put (documented bound, see above).
  const current = await store.get<LimitChain>(key);
  await store.put(key, mutate(current ?? emptyChain()));
}

/** Adds a model-step record to the counter DELTA (O(1), the pricing logic is SHARED with cost.ts). */
function applyModelStepDelta(delta: LimitCounters, value: unknown, opts: RunCostOptions, unpriced?: Set<string>): void {
  const u = usageAndCostFromModelValue(value, opts);
  if (u) {
    delta.totalTokens += u.totalTokens;
    delta.costUsd += u.costUsd;
    if (!u.priced) unpriced?.add(u.modelId);
  }
  delta.modelStepsSeen++;
}

/**
 * Adds a tool call's OUTCOME (succeeded/failed/denied/suspended) to the chain — used BOTH by the live
 * `recordToolOutcome` hook AND BY `seedFromHistory`'s replay of the historical scan with the SAME logic
 * (since both paths call the SAME function, seeding and incremental updates are ALWAYS consistent). The
 * SucceededToolCalls counter is NOT applied HERE, it's applied separately by the caller via
 * `incrCounters` (this function only returns the RESETTABLE chain fields).
 */
function applyToolOutcomeToChain(
  chain: LimitChain,
  toolCallId: string,
  toolName: string | undefined,
  argsHash: string | undefined,
  status: ToolJournalRecord['status'] | undefined,
): LimitChain {
  const subRunIds = chain.subRunIds.includes(toolCallId) ? chain.subRunIds : [...chain.subRunIds, toolCallId];
  if (status === 'succeeded') {
    if (chain.lastToolName === toolName && chain.lastArgsHash === argsHash) {
      return { ...chain, subRunIds, consecutiveRepeats: chain.consecutiveRepeats + 1 };
    }
    return { lastToolName: toolName, lastArgsHash: argsHash, consecutiveRepeats: 1, subRunIds };
  }
  // A 'reflected' record must NOT break the chain — the nudge is ABOUT this
  // Very chain; resetting it would hand the model a fresh window of maxRepeats identical executions
  // Right after being warned (the nudge would never escalate). Counts are PRESERVED, only the
  // "delivered" flag is set → checkToolGate escalates the next identical repeat to the hard block.
  // (This branch is also replayed VERBATIM by seedFromHistory's scan — a reseeded chain reconstructs
  // The flag from the journaled 'reflected' record, so the escalation survives a state-key loss.)
  // MATCH-ONLY flag: a 'reflected' record can also come from the DUPLICATE guard (sideEffectDuplicates:
  // 'reflect'), whose (tool,args) may NOT be the current consecutive chain — flagging a FOREIGN chain
  // Would silently swallow that chain's own future nudge (it would hard-block un-warned). The loop
  // Detector's own reflections always match by construction, so this narrowing changes nothing for them.
  if (status === 'reflected') {
    if (chain.lastToolName === toolName && chain.lastArgsHash === argsHash) {
      return { ...chain, subRunIds, reflected: true };
    }
    return { ...chain, subRunIds };
  }
  // EVERY FAILED/denied/suspended record BREAKS the chain — SAME as the original backward-scan
  // Algorithm (the old version of limits.ts): stop at the first record where `v.status !== 'succeeded'`.
  return { lastToolName: undefined, lastArgsHash: undefined, consecutiveRepeats: 0, subRunIds };
}

/**
 * A ONE-TIME full scan (called ONLY WHEN the chain key does NOT EXIST — first encounter/seeding an old
 * Run). THANKS TO `reader.readRun`'s ordering contract (ASCENDING by write time) AND the strict
 * Sequentiality of model steps, both the counter totals and the chain/fan-out candidates are
 * Reconstructed correctly in a single FORWARD pass, in the CORRECT order (the order readRun returns =
 * The actual order of occurrence).
 */
async function seedFromHistory(
  reader: JournalReader,
  runId: string,
  opts: RunCostOptions,
  unpriced?: Set<string>,
): Promise<{ counters: LimitCounters; chain: LimitChain }> {
  const entries = await reader.readRun(runId);
  const counters = emptyCounters();
  let chain = emptyChain();
  const prefix = `${runId}:tool:`;
  for (const e of entries) {
    if (e.kind === 'model') {
      applyModelStepDelta(counters, e.value, opts, unpriced);
      continue;
    }
    if (e.kind !== 'tool') continue;
    if (!e.key.startsWith(prefix)) continue; // unexpected key shape — skip (defensive, same as old behavior)
    const toolCallId = e.key.slice(prefix.length);
    const v = e.value as ToolJournalRecord | undefined;
    // A SHADOW of a record whose authoritative key is not run-scoped — skipped for the same reason
    // `compensateRun` skips it (compensation.ts), and to keep the rule above true.
    //
    // The live rule only ever fires from `writeToolTerminal`. A cross-run DEDUP HIT returns from the
    // journal without writing a terminal, so it increments nothing — but it does leave a shadow, and
    // counting that here made the seed disagree with the live path. Measured, two runs sharing one
    // cross-run charge under `maxToolCalls: 1`: the deduping run executed ZERO tools and died with
    // RunLimitExceededError where it used to complete, and whether it died depended on whether the
    // dedup hit happened to be the run's FIRST tool call — same work, same run, different budget.
    //
    // The executing run's shadow is skipped too, and that is deliberate rather than overlooked: its
    // call WAS counted live at the moment it ran, and this scan only happens when the chain key is
    // absent — which means limits were not in play then either, so there was nothing to reconstruct. I
    // tried to build a case where the executor's shadow needed to count (a later resume, a fork with
    // limits added afterwards) and could not produce one; a narrower marker distinguishing the two
    // shadows was written and then removed, because a schema field justified only by an unmeasured
    // scenario is a liability. If such a case turns up, this is the line to split.
    if (v?.mirrorOf !== undefined) continue;
    // MUST match recordToolOutcome's live-increment rule EXACTLY so a first-encounter
    // Seed reconstructs the SAME count — a succeeded call OR a failed SIDE-EFFECT attempt (the failed
    // Record carries `sideEffect`; older records without it fall back to not-counted, matching pre-C3).
    if (v?.status === 'succeeded' || (v?.status === 'failed' && v.sideEffect === true)) counters.succeededToolCalls++;
    chain = applyToolOutcomeToChain(chain, toolCallId, (v as any)?.toolName, (v as any)?.argsHash, v?.status);
  }
  return { counters, chain };
}

/**
 * On the run's FIRST encounter with limits (chain key MISSING), seeds via a ONE-TIME full scan (readRun)
 * (see the FIX note at the top of the file). Seeding is limited to a SINGLE winner via an ATOMIC
 * `putIfAbsent` on the chain key (or a `claim()` get+put fallback if unavailable): ONLY the WINNER adds
 * The counters via `incrCounters` + writes the chain; the LOSER writes nothing (the caller falls through
 * To the normal live-increment path). `true` ⟺ THIS call won (the readRun scan MAY ALREADY INCLUDE this
 * Call's own contribution — the winner must NOT apply it AGAIN, to avoid double counting — see the early
 * Return in `recordToolOutcome`).
 */
async function ensureSeeded(
  reader: JournalReader,
  store: LimitsStore,
  runId: string,
  opts: RunCostOptions,
  unpriced?: Set<string>,
): Promise<boolean> {
  if ((await readChain(store, runId)) !== undefined) return false; // already seeded
  if (typeof reader.readRun !== 'function') return false; // fail-open
  const seeded = await seedFromHistory(reader, runId, opts, unpriced);
  const key = chainKey(runId);
  const won = typeof store.putIfAbsent === 'function'
    ? await store.putIfAbsent(key, seeded.chain)
    : await claim(store as Journal, key, seeded.chain);
  if (!won) return false; // another call already seeded it — fall through to the normal increment path
  await incrCounters(store, runId, seeded.counters);
  return true;
}

/**
 * FAN-OUT INHERITANCE (W1 design decision — see apiOrNotes): RECURSIVELY sums the usage of a
 * RunId's sub-agent (agent-tool.ts `createAgentTool`/`runSubAgent`) runs. Sub-agent runIds are
 * DETERMINISTICALLY derived (`agent:${toolCallId}`, the SAME pattern as agent-tool.ts). O(1) `get`(s)
 * Are read from EACH sub-run's OWN counter/chain key (since the sub-run inherits the SAME `limits`
 * Through agent-tool.ts, it already kept a cumulative total DURING its own run) → the total cost is
 * O(number of sub-runs) `get`s, no readRun. If a sub-agent never ran (no counter key), its contribution
 * Is zero — harmless. `seen`: defense against cyclic/double-counted references.
 */
/**
 * Nested run ids PROVEN ABSENT, per store. Misses only — a hit is re-read every time, because a
 * sub-agent's counters are exactly the thing that must stay live.
 *
 * `subRunIds` collects EVERY tool call, and almost none of them are sub-agents; each non-sub-agent
 * costs two `get`s (the parent-scoped id and the legacy bare one) on EVERY subsequent model step. That
 * is quadratic and it was measured that way — one tool call per step, counting only counter reads:
 *
 *   10 steps →   200      30 steps →  1800      60 steps →  7200      (= 2k²)
 *
 * Cheap on a local store; on Postgres it is 7200 round trips inside one run's spend check.
 *
 * Why a miss is permanent: a toolCallId enters `subRunIds` from `recordToolOutcome`, which
 * durable-tool.ts calls at the moment it writes the tool's OUTCOME — so the tool's execute has already
 * returned, and a sub-agent it ran has already written its counters. If neither key exists then,
 * neither ever will. A suspended sub-agent is a HIT (its counters exist and are non-zero), so it keeps
 * being re-read and its later growth is still counted.
 *
 * KNOWN BOUND, accepted deliberately: a tool that starts a sub-agent WITHOUT awaiting it returns
 * before those counters are written, so it is cached as a miss and never attributed. Such a run
 * already escapes attribution in every other respect — it can outlive its parent entirely — and
 * `createAgentTool` awaits.
 *
 * In-memory and per store object, so it costs nothing durable and cannot go stale across processes: a
 * resumed run in a fresh process simply re-probes once per id and re-learns.
 */
const absentNestedRuns = new WeakMap<object, Set<string>>();

function absentFor(store: LimitsStore): Set<string> {
  let s = absentNestedRuns.get(store as object);
  if (!s) { s = new Set(); absentNestedRuns.set(store as object, s); }
  return s;
}

async function sumSubRuns(
  store: LimitsStore,
  parentRunId: string | undefined,
  subRunIds: string[],
  opts: RunCostOptions,
  seen: Set<string>,
): Promise<{ totalTokens: number; costUsd: number; succeededToolCalls: number }> {
  const absent = absentFor(store);
  let totalTokens = 0;
  let costUsd = 0;
  let succeededToolCalls = 0;
  for (const toolCallId of subRunIds) {
    // Both shapes: the parent-scoped id a sub-agent uses now, and the bare legacy one still present
    // In journals written before it was scoped. A miss costs one O(1) `get` and sums 0.
    const candidates = [nestedAgentRunId(parentRunId, toolCallId), `agent:${toolCallId}`];
    for (const nestedRunId of new Set(candidates)) {
      if (seen.has(nestedRunId)) continue;
      if (absent.has(nestedRunId)) continue; // proven absent on an earlier step — see absentNestedRuns
      seen.add(nestedRunId);
      const nested = await readCounters(store, nestedRunId); // O(1) — the sub-run already kept this DURING its own run
      if (!nested) { absent.add(nestedRunId); continue; } // the sub-agent never ran → harmless 0, and never will
      totalTokens += nested.totalTokens;
      costUsd += nested.costUsd;
      succeededToolCalls += nested.succeededToolCalls;
      const nestedChain = await readChain(store, nestedRunId);
      if (nestedChain?.subRunIds.length) {
        const grand = await sumSubRuns(store, nestedRunId, nestedChain.subRunIds, opts, seen); // multi-level fan-out
        totalTokens += grand.totalTokens;
        costUsd += grand.costUsd;
        succeededToolCalls += grand.succeededToolCalls;
      }
    }
  }
  return { totalTokens, costUsd, succeededToolCalls };
}

/**
 * Model steps are STRICTLY SEQUENTIAL and write-once (durable-model.ts: `step` only increments AFTER a
 * SUCCESSFUL write, the same key is NEVER overwritten) → walks FORWARD from `modelStepsSeen` with
 * Targeted `get(runKeys.model(runId, n))` calls; stops at the first `undefined`. In the normal flow
 * (since enforceStepLimits is called immediately AFTER each step) this finishes with EXACTLY 1 `get` —
 * No readRun. Returns a DELTA (no mutation — model steps are never processed concurrently, see the FIX
 * Note at the top of the file, but it's still kept delta-based so `incrCounters` remains the single
 * Source of truth).
 */
async function computeModelStepsDelta(
  store: LimitsStore,
  runId: string,
  modelStepsSeen: number,
  opts: RunCostOptions,
  /** Model ids this delta could not price — collected so the caller can refuse to claim a $ ceiling. */
  unpriced: Set<string> = new Set(),
): Promise<Partial<LimitCounters> | undefined> {
  if (typeof store.get !== 'function') return undefined;
  let seen = modelStepsSeen;
  let totalTokens = 0;
  let costUsd = 0;
  let stepsAdded = 0;
  for (;;) {
    const rec = await store.get(runKeys.model(runId, seen));
    if (rec === undefined) break;
    const u = usageAndCostFromModelValue(rec, opts);
    if (u) {
      totalTokens += u.totalTokens;
      costUsd += u.costUsd;
      if (!u.priced) unpriced.add(u.modelId);
    }
    seen++;
    stepsAdded++;
  }
  if (stepsAdded === 0) return undefined;
  return { modelStepsSeen: stepsAdded, totalTokens, costUsd };
}

/**
 * Called AFTER a model step is SUCCESSFULLY journaled (durable-model.ts, both on a fresh call and on a
 * REPLAY hit — checking on replay too guarantees that when the SAME runId is called repeatedly WITHOUT
 * The limit CHANGING, it re-throws IMMEDIATELY at the SAME point, never leaking extra progress):
 * Computes cumulative usage (own + sub-agents) via O(1)/targeted reads; throws IF `limits.maxTokens`/
 * `maxCostUsd` is exceeded. Since the step is ALREADY written to the journal, throwing here does NOT
 * Corrupt the journal.
 */
/**
 * C4: limits are configured but the store cannot enforce them (no `readRun`). Returns the list of
 * Configured protections that are therefore disabled — empty if nothing enforceable is configured.
 */
function unenforceableProtections(limits: RunLimits): string[] {
  const p: string[] = [];
  if (limits.maxCostUsd != null) p.push('maxCostUsd');
  if (limits.maxTokens != null) p.push('maxTokens');
  if (limits.maxToolCalls != null) p.push('maxToolCalls');
  if (limits.loopDetection?.maxRepeats != null && limits.loopDetection.maxRepeats > 0) p.push('loopDetection');
  return p;
}

// C4: warn ONCE per store (same pattern as journal.ts's claimFallbackWarned) — a fail-open on a
// ReadRun-less journal must be LOUD but not spam every step/tool call.
const limitsFailOpenWarned = new WeakSet<object>();

/**
 * C4 enforcement-point guard: called where a limit CANNOT be enforced because the journal lacks
 * `readRun`. If nothing enforceable is configured → no-op (return false, caller fails open as before).
 * Otherwise: `strict: true` → THROW (a configured protection that cannot fire is a hard error); default
 * → a LOUD one-time `console.warn` naming exactly which protections are disabled, then return true so
 * The caller fails open (unchanged behavior).
 */
function reportUnenforceableLimits(store: object, limits: RunLimits): void {
  const disabled = unenforceableProtections(limits);
  if (disabled.length === 0) return; // nothing this reader would enforce is configured
  if (limits.strict) {
    throw new Error(
      `@gnldev/durable: run limits (${disabled.join(', ')}) are configured with \`strict: true\`, but this ` +
        'journal does not implement `readRun` — they CANNOT be enforced. Use a journal that implements ' +
        '`readRun` (all first-party adapters do), or remove `strict` to fail open with a warning instead.',
    );
  }
  if (!limitsFailOpenWarned.has(store)) {
    limitsFailOpenWarned.add(store);
    console.warn(
      `@gnldev/durable: run limits (${disabled.join(', ')}) are configured but this journal does not implement ` +
        '`readRun` — these protections are SILENTLY NOT ENFORCED (the run is NOT capped). Use a journal that ' +
        'implements `readRun` (all first-party adapters do), or set `limits.strict: true` to fail loudly instead.',
    );
  }
}

export async function enforceStepLimits(
  reader: JournalReader,
  runId: string,
  limits: RunLimits | undefined,
  opts: RunCostOptions = {},
): Promise<void> {
  if (!limits || (limits.maxCostUsd == null && limits.maxTokens == null)) return;
  if (typeof reader.readRun !== 'function') { reportUnenforceableLimits(reader, limits); return; } // fail-open (or throw under strict)
  const store = reader as LimitsStore;

  // Resolve the price table ONCE, here, and thread it down — the ceiling is the one place a stale or
  // missing price does real damage, and it was the one place that could not be corrected without a
  // release. The unpriced-model warning below already tells operators to "supply prices via the
  // `pricing` option or the journal's __pricing__ document"; the second half of that sentence was not
  // true, because nothing read the document. Resolved once per enforcement rather than per step: this
  // runs on every model step, and the document is a single point-read.
  if (!opts.pricing) opts = { ...opts, pricing: await effectivePricingTable(reader as never) };

  const unpriced = new Set<string>();
  await ensureSeeded(reader, store, runId, opts, unpriced); // seeds with a SINGLE readRun on first encounter (no-op afterward)
  let counters = (await readCounters(store, runId)) ?? emptyCounters();
  const delta = await computeModelStepsDelta(store, runId, counters.modelStepsSeen, opts, unpriced); // O(1) targeted get — no readRun
  if (delta) {
    await incrCounters(store, runId, delta);
    counters = {
      ...counters,
      modelStepsSeen: counters.modelStepsSeen + (delta.modelStepsSeen ?? 0),
      totalTokens: counters.totalTokens + (delta.totalTokens ?? 0),
      costUsd: counters.costUsd + (delta.costUsd ?? 0),
    };
  }

  const chain = (await readChain(store, runId)) ?? emptyChain();
  const subtotal = await sumSubRuns(store, runId, chain.subRunIds, opts, new Set([runId]));
  const totalTokens = counters.totalTokens + subtotal.totalTokens;
  const costUsd = counters.costUsd + subtotal.costUsd;

  if (limits.maxTokens != null && totalTokens > limits.maxTokens) {
    throw new RunLimitExceededError(
      `@gnldev/durable: run '${runId}' exceeded the maxTokens limit (${limits.maxTokens}) with ${totalTokens} tokens`,
      { kind: 'maxTokens', value: totalTokens, limit: limits.maxTokens },
    );
  }
  // A $ ceiling over a run whose model has no price is not a ceiling. costUsd is 0 for those steps
  // because nothing could price them, so `costUsd > maxCostUsd` stays false no matter how much the
  // run actually spends -- the guard reads as green precisely when it is doing nothing. Same shape
  // as the readRun-less case above, so it takes the same route: loud under `strict`, warn otherwise.
  if (limits.maxCostUsd != null && unpriced.size > 0) {
    const names = [...unpriced].join(', ');
    if (limits.strict) {
      throw new Error(
        `@gnldev/durable: run '${runId}' sets maxCostUsd, but no pricing entry exists for ${names} — ` +
          'those steps count as $0, so the ceiling CANNOT be enforced. Supply prices via the `pricing` ' +
          'option or the journal\'s __pricing__ document, or remove `strict` to fail open with a warning.',
      );
    }
    if (!limitsFailOpenWarned.has(store)) {
      limitsFailOpenWarned.add(store);
      console.warn(
        `@gnldev/durable: maxCostUsd is set but ${names} has no pricing entry — those steps are counted ` +
          'as $0, so the ceiling is NOT capping this run. Supply prices via the `pricing` option or the ' +
          'journal\'s __pricing__ document, or set `limits.strict: true` to fail loudly instead.',
      );
    }
  }
  if (limits.maxCostUsd != null && costUsd > limits.maxCostUsd) {
    throw new RunLimitExceededError(
      `@gnldev/durable: run '${runId}' exceeded the maxCostUsd limit ($${limits.maxCostUsd}) at $${costUsd.toFixed(4)}`,
      { kind: 'maxCostUsd', value: costUsd, limit: limits.maxCostUsd },
    );
  }
}

/** `checkToolGate`'s decision — durable-tool.ts wraps 'loop'/'maxToolCalls' in the stop sentinel and
 * RETURNS it (doesn't throw); 'reflect' is NOT a stop: durable-tool.ts journals a 'reflected' terminal
 *  Record and returns the nudge to the model as the tool result (the run continues). */
export interface ToolGateBreach {
  kind: 'loop' | 'maxToolCalls' | 'reflect';
  message: string;
  detail: Record<string, unknown>;
}

/**
 * Called BEFORE a tool call TRULY RUNS (durable-tool.ts, BEFORE the atomic claim). Combines loop
 * Detection AND maxToolCalls in ONE place (both mean "this call must not run at all"): NOTHING is
 * WRITTEN to the journal → a blocked call is re-evaluated FROM SCRATCH on the NEXT attempt (if the
 * Limit is raised/on replay) (deterministic, approval NOT REQUIRED).
 *
 * Because it's PROSPECTIVE (before execute), it cannot know this call's OWN outcome — it only READS the
 * State; the state UPDATE (succeeded counter/loop chain/fan-out candidates) is done via
 * `recordToolOutcome` at the moment durable-tool.ts writes the tool's OUTCOME (see the file-top description).
 *
 * Loop: IF the chain's rolling counter MATCHES the queried `toolName`+`hash`, `consecutiveRepeats` is
 *   Used (otherwise 0) — MATHEMATICALLY IDENTICAL to counting consecutive successes backward from the
 * END of the journal's SUCCESSFUL records (see `applyToolOutcomeToChain`). Blocked if the prior
 *   Consecutive repeat count REACHED (>=) `maxRepeats`.
 * maxToolCalls: blocked if the total tool-call ATTEMPTS (own + sub-agents/fan-out) REACHED (>=)
 *   `maxToolCalls` — attempts = successful calls + FAILED SIDE-EFFECT calls (audit C3), NOT failed
 *   Read-only ones (the new call's total would exceed it).
 */
export async function checkToolGate(
  reader: JournalReader,
  runId: string,
  toolName: string,
  hash: string,
  limits: RunLimits | undefined,
): Promise<ToolGateBreach | undefined> {
  if (!limits) return undefined;
  if (typeof reader.readRun !== 'function') { reportUnenforceableLimits(reader, limits); return undefined; } // fail-open (or throw under strict)

  const maxRepeats = limits.loopDetection?.maxRepeats;
  const needsState = (maxRepeats != null && maxRepeats > 0) || limits.maxToolCalls != null;
  if (!needsState) return undefined; // if only maxTokens/maxCostUsd are set, the tool-gate does NOTHING at all (SAME as old behavior)

  const store = reader as LimitsStore;
  // Seed with the EFFECTIVE price table, not with `{}`. The counters are additive and never recomputed,
  // so whatever price is used here is the price those model steps keep forever. Seeding with empty
  // options meant DEFAULT_PRICING only — the journal's `__pricing__` document was ignored — and a model
  // priced solely by that document was recorded at $0 permanently. enforceStepLimits resolving the table
  // correctly afterwards cannot undo it, and because `unpriced` stayed empty the "no price for this
  // model" warning did not fire either. Measured: a step the document prices at $300 left a maxCostUsd
  // of $0.01 unenforced, silently.
  await ensureSeeded(reader, store, runId, { pricing: await effectivePricingTable(reader as never) });
  const chain = (await readChain(store, runId)) ?? emptyChain();

  if (maxRepeats != null && maxRepeats > 0) {
    const priorRepeats = chain.lastToolName === toolName && chain.lastArgsHash === hash ? chain.consecutiveRepeats : 0;
    if (priorRepeats >= maxRepeats) {
      // At the threshold the model first gets ONE
      // "reconsider" nudge (kind 'reflect' — the run continues); ONLY an identical repeat AFTER the nudge
      // (chain.reflected — set via recordToolOutcome/seedFromHistory) falls through to the hard block.
      // Note the reflected flag only matters while the chain MATCHES this tool+hash — a different call
      // Resets the whole chain (flag included) in applyToolOutcomeToChain.
      if (limits.loopDetection?.onRepeat === 'reflect' && !chain.reflected) {
        // MODEL-FACING text (enters the conversation as a nudge → goes to the provider): deliberately
        // NEUTRAL — no framework name/branding (user traffic shouldn't fingerprint the underlying stack).
        // Operator-facing messages (console/incident/error) can stay branded.
        return {
          kind: 'reflect',
          message:
            `'${toolName}' already ran ${priorRepeats} times in a row with identical arguments — ` +
            `this call was NOT executed; reconsider before repeating it`,
          detail: { toolName, argsHash: hash, repeats: priorRepeats, maxRepeats },
        };
      }
      const ignoredNudge = chain.reflected === true;
      return {
        kind: 'loop',
        message:
          `@gnldev/durable: '${toolName}' ran ${priorRepeats} times in a row with the same arguments ` +
          `(maxRepeats=${maxRepeats})${ignoredNudge ? ' and repeated identically even after a reconsider nudge' : ''} ` +
          `— loop detected, this call was NOT EXECUTED`,
        detail: { toolName, argsHash: hash, repeats: priorRepeats, maxRepeats, ...(ignoredNudge ? { reflected: true } : {}) },
      };
    }
  }

  if (limits.maxToolCalls != null) {
    const counters = (await readCounters(store, runId)) ?? emptyCounters();
    const subtotal = await sumSubRuns(store, runId, chain.subRunIds, {}, new Set([runId]));
    const succeededToolCalls = counters.succeededToolCalls + subtotal.succeededToolCalls;
    if (succeededToolCalls >= limits.maxToolCalls) {
      return {
        kind: 'maxToolCalls',
        message:
          `@gnldev/durable: run '${runId}' reached the maxToolCalls limit (${limits.maxToolCalls}) ` +
          `(${succeededToolCalls}) — the new tool call was NOT EXECUTED`,
        detail: { kind: 'maxToolCalls', value: succeededToolCalls, limit: limits.maxToolCalls },
      };
    }
  }
  return undefined;
}

/**
 * Durable-tool.ts's hook (see the file-top description): called at the MOMENT a tool call is RESOLVED
 * (succeeded/failed/denied/suspended) and written to the journal — updates the limit state ATOMICALLY
 * (see the FIX note at the top of the file — LOSSLESS under parallel tool calls). MUST be called IF
 * `ctx.limits` is DEFINED (regardless of which fields are set): fan-out (`subRunIds`) tracking is ALSO
 * Required FOR `enforceStepLimits`'s maxTokens/maxCostUsd, it cannot be said to be only for tool-limits.
 *
 * IF the chain key is MISSING (this run's FIRST encounter with limits), `ensureSeeded` ATTEMPTS to seed
 * Via a ONE-TIME full scan — this scan AUTOMATICALLY INCLUDES this tool record that has JUST been
 * WRITTEN to the journal (readRun runs AFTER this put); IF seeding WAS WON (`ensureSeeded` returns
 * `true`), this call's contribution is ALREADY counted → returns early (prevents DOUBLE COUNTING). IF
 * Seeding WAS LOST (another concurrent call already seeded it), falls through to the normal
 * (steady-state) increment path.
 */
export async function recordToolOutcome(
  journal: LimitsStore,
  runId: string,
  toolCallId: string,
  toolName: string,
  hash: string,
  status: ToolJournalRecord['status'],
  // Whether the tool is a SIDE EFFECT (its execute was actually invoked). A side-effect
  // Tool that ended 'failed' still counts toward maxToolCalls — the effect may have executed BEFORE the
  // Throw (chargeCard posts the charge then errors on the response). A read-only ('failed') tool does not
  // Count (it did no effect). Default `false` → direct callers that omit it keep the old success-only
  // Semantics. Ignored for non-failed statuses (a success always counts; denied/suspended/reflected never do).
  sideEffect = false,
  // C4: passed through so this enforcement point can warn/throw when limits are configured but the
  // Journal lacks `readRun` (optional — direct callers that omit it keep the old fail-open behavior).
  limits?: RunLimits,
): Promise<void> {
  if (typeof journal.get !== 'function' || typeof journal.put !== 'function') return; // cannot write → skip silently

  if ((await readChain(journal, runId)) === undefined) {
    if (typeof journal.readRun !== 'function') { if (limits) reportUnenforceableLimits(journal, limits); return; } // fail-open (or throw under strict)
    // Same reason as the tool gate above: this seeding decides the recorded cost of every earlier step.
    const won = await ensureSeeded(journal as JournalReader, journal, runId, { pricing: await effectivePricingTable(journal as never) });
    if (won) return; // seeding ALREADY included THIS call's own outcome — double counting prevented
    // We lost (another concurrent call seeded it) → fall through to the normal (steady-state) increment path
  }

  // SucceededToolCalls now counts ATTEMPTS for side-effect tools: every 'succeeded' call PLUS every
  // 'failed' SIDE-EFFECT call (an executed-then-threw effect). This can only make maxToolCalls STRICTER.
  if (status === 'succeeded' || (status === 'failed' && sideEffect)) {
    await incrCounters(journal, runId, { succeededToolCalls: 1 }); // H8a: ATOMIC — lossless under parallel calls
  }
  await writeChainCas(journal, runId, (chain) => applyToolOutcomeToChain(chain, toolCallId, toolName, hash, status));
}
