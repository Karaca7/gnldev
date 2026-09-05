import { generateText, streamText, stepCountIs } from 'ai';
import type { ToolSchemaRuleLike } from './types.js';
import type { StreamTextResult } from 'ai';
import { withDurableModel } from './durable-model.js';
import { durableTools } from './durable-tool.js';
import { acquireRunLock } from './run-lock.js';
import { RunBusyError, SideEffectRetryBlockedError, RetryLimitExceededError, RunThreadMismatchError, RunInputMismatchError, RunActorMismatchError, RunSweptError } from './errors.js';
import { argsHash } from './hash.js';
import { recordIdemConflict } from './idem-ledger.js';
import { createProcessorCtx, composePrepareStep, composeOnStepFinish, durableProcessorStep, ProcessorRetry, RetryExhaustedByProcessorError, type StepHookFailure } from './processor.js';
import { loadReplayCache, runKeys, claim } from './journal.js';
// Statically safe: model-router imports only ./journal, and the provider packages it can reach are
// Behind dynamic import(), so this costs the core bundle nothing.
import { resolveModel, setChainToolShaper } from './model-router.js';
import { stampFormat, upgradeFormat } from './format.js';
import { recordRunUsage } from './budget.js';
import { recordRunMetrics } from './metrics.js';
import type { Journal, JournalReader, DurableCtx } from './journal.js';
import type { Guard, Interrupt } from './guard.js';
import { PROVENANCE_RECENT_CAP, messagePreview } from './memory.js';
import type { Memory, MemoryContextProvenance } from './memory.js';
import type { Processor, ProcessorCtx, ProcessorInput, ProcessorOutput } from './processor.js';
import type { ModelInput, ToolSet } from './types.js';
import { DuplicateSideEffectError, RunLimitExceededError, TaintedSideEffectError, ToolLoopDetectedError } from './limits.js';
import { assertNotCompensated, CompensatedRunError } from './compensation.js';
import { assertNotCanceled } from './cancel.js';
import { markRunTainted, readThreadTaint, readDirectRunTaint, recordTaintProvenance, isThreadTaintExpired } from './taint.js';
import type { RunLimits } from './limits.js';

import type { LanguageModelV4 } from '@ai-sdk/provider';
import { systemText, finishReasonText, producedMessages, type InstructionsLike } from './sdk-compat.js';
import { runFailed, runFailedIfUnrecorded, runStarted, runSucceeded, classifyRunError, isRunFailure } from './outcome.js';

type GenerateTextOptions = Parameters<typeof generateText>[0];
type StreamTextOptions = Parameters<typeof streamText>[0];

/** `generateText` arguments + `journal` + `runId` + optional `guard`/`approvals`. */
export type RunDurableArgs = GenerateTextOptions & {
  journal: Journal;
  runId: string;
  guard?: Guard;
  approvals?: Record<string, boolean>;
  /** Conversation memory: if provided, thread history is loaded + appended idempotently on completion. */
  memory?: Memory;
  threadId?: string;
  /** Phase 14: resource (user) identity — for resource-scope recall / cross-thread memory. */
  resourceId?: string;
  /** The agent's registry name — frozen into the invisible `:input` entry so studio /runs can LABEL
   *  Each run with its agent (surfaced by listRuns, no per-run journal N+1). Optional (direct runDurable
   *  Callers may omit it); the registry passes the agent key. */
  agentName?: string;
  /**
   * Replay determinism mode (M2). Default `'lenient'`.
   * HONEST BOUND (audit E2): model-step divergence detection is OFF by default — under `'lenient'` a
   * Replayed model step that produces a DIFFERENT request is NOT flagged at all. Even `'strict'` only
   * `console.warn`s the divergence (it does NOT throw for the model step; the hard `DivergenceError` is for
   * Tool-argument drift). Set `'strict'` if you want the model-divergence warning surfaced. (Independent of
   * This flag, a generate↔stream entry-point mismatch on the SAME runId always throws a clear error — see
   * RunDurable vs streamDurable.)
   */
  replay?: 'strict' | 'lenient';
  /** Opt-in run-level lock (M4): if provided, a concurrent resume of the same runId gets `RunBusyError`. */
  lock?: { owner: string; ttlMs: number };
  /**
   * §5.3 (opt-in): model-step exclusivity. If provided, when a concurrent worker's FRESH 'running'
   * Model claim is seen (startedAt newer than ttlMs ago from now; default 30_000),
   * `RunBusyError` is thrown → prevents duplicate `doGenerate` (duplicate token cost). A STALE claim
   * (crashed owner) proceeds with existing behavior — the fast crash-resume window is preserved.
   */
  exclusiveModelStep?: { ttlMs?: number };
  /** H8c (optional): replay-cache RAM threshold (bytes; default 32MB). If the journal is larger than this,
   *  Bulk caching is skipped → point-read replay (same correctness, bounded memory). */
  replayCacheMaxBytes?: number;
  /** H10b (opt-in production mode): 'strict' → every tool MUST declare its side-effect intent
   *  (idempotent | sideEffect | recover). An undeclared tool causes a clear error at run start. */
  toolPolicy?: 'strict' | 'strict-critical';
  /** FAZ-4 (critical profile): refuse a runId re-used with DIFFERENT content — the raw caller input
   *  Is fingerprinted at freeze time; a later call whose fingerprint differs gets
   *  RunInputMismatchError (409, no resumable). Exemption: approvals addressing a toolCallId whose
   *  Journal record is genuinely 'suspended' (the chat approval re-POST carries a grown history). */
  strictInput?: boolean;
  /** FAZ-4: append PII-free refusal records (`idem:conflict:*`) for busy/mismatch/swept conflicts — see idem-ledger.ts. */
  conflictLedger?: boolean;
  /** FAZ-4: what a retention-swept runId's late retry does — 'ignore' (default, re-runs: today's
   *  Behavior) or 'reject' (RunSweptError; the critical profile's choice). */
  tombstonePolicy?: 'ignore' | 'reject';
  /** FAZ-4: opaque caller identity, bound into the frozen input FIRST-WINS — a different actor
   *  Re-driving the runId gets RunActorMismatchError. Absent on either side = no check (auth-less
   *  Profile has no protection here — documented, not silent). */
  actor?: string;
  /** 8.7 Processor pipeline: input/output/tool transformers (PII/moderation/tool-filter). */
  processors?: Processor[];
  /** 8.8 Provider-specific tool-schema compatibility (opt-in): true → default set; array → those rules. */
  schemaCompat?: boolean | ToolSchemaRuleLike[];
  /** W1 (opt-in): per-run cost cap + loop detection. If not provided, no check runs. */
  limits?: RunLimits;
  /**
   * Y1/Y3 (opt-in): external call timeouts + claim TTL. `modelStepMs` applies to every model step
   * (up to the first byte in streaming), `toolMs` applies to every tool execute (tool.timeoutMs
   * Overrides per-tool); on timeout, StepTimeoutError flows through the existing failed/retry paths.
   * `claimTtlMs` is the staleness threshold for a 'running' claim (default 30s) — raise it for
   * Legitimate tools that run longer than 30s.
   */
  timeouts?: { modelStepMs?: number; toolMs?: number; claimTtlMs?: number };
};

/** `streamText` arguments + durable fields (same scope as runDurable). */
export type StreamDurableArgs = StreamTextOptions & {
  journal: Journal;
  runId: string;
  guard?: Guard;
  approvals?: Record<string, boolean>;
  /** Conversation memory: if provided, thread history is loaded + appended idempotently when the stream ends. */
  memory?: Memory;
  threadId?: string;
  /** Resource (user) identity — for resource-scope recall / cross-thread memory. */
  resourceId?: string;
  /** Agent registry name — frozen into the `:input` entry so studio /runs can label the run (see RunDurableArgs). */
  agentName?: string;
  /** Replay determinism mode (M2). Default `'lenient'` — model-step divergence detection is OFF by default
   *  And warn-only even under `'strict'` (see RunDurableArgs.replay for the full honest bound). */
  replay?: 'strict' | 'lenient';
  /**
   * Processor pipeline. Input/tool processors run exactly the same as in run (BEFORE the model).
   * Output processors in streaming are applied ONLY to messages being persisted (memory append) —
   * Text-deltas that have already streamed cannot be retroactively transformed.
   */
  processors?: Processor[];
  /** 8.8 Provider-specific tool-schema compatibility (opt-in): true → default set; array → those rules. */
  schemaCompat?: boolean | ToolSchemaRuleLike[];
  /** W1 (opt-in): per-run cost cap + loop detection. If not provided, no check runs. */
  limits?: RunLimits;
  /** §5.3 (opt-in): model-step exclusivity — same semantics as runDurable (see RunDurableArgs). */
  exclusiveModelStep?: { ttlMs?: number };
  /**
   * (a) — opt-in run-level lock (same shape as RunDurableArgs.lock): if provided, a concurrent
   * Stream/run of the same runId gets `RunBusyError` at start. The lock is acquired BEFORE streaming and
   * RELEASED when the stream finishes (the same `onFinish` lifecycle the memory-append uses; also
   * Released on stream error).
   *
   * DELIBERATE LIMITATION vs runDurable: there is NO self-renewing heartbeat (runDurable's B4 renew).
   * A stream is consumed lazily by the caller AFTER streamDurable returns — its lifecycle is not bounded
   * By a function scope, so a self-renewing timer on an ABANDONED stream (created, never drained) would
   * Keep renewing and hold the lock forever. Instead the lock serializes the START and is released on
   * Finish; a stream that outlives `ttlMs` (or is abandoned before `onFinish`) is reclaimed at TTL —
   * Pick a generous `ttlMs`. If you need the mid-run heartbeat guarantee, use `runDurable`.
   */
  lock?: { owner: string; ttlMs: number };
  /** H8c: replay-cache RAM threshold (see RunDurableArgs). */
  replayCacheMaxBytes?: number;
  /** H10b: strict tool policy (see RunDurableArgs). */
  toolPolicy?: 'strict' | 'strict-critical';
  /** FAZ-4 (critical profile): refuse a runId re-used with DIFFERENT content — the raw caller input
   *  Is fingerprinted at freeze time; a later call whose fingerprint differs gets
   *  RunInputMismatchError (409, no resumable). Exemption: approvals addressing a toolCallId whose
   *  Journal record is genuinely 'suspended' (the chat approval re-POST carries a grown history). */
  strictInput?: boolean;
  /** FAZ-4: append PII-free refusal records (`idem:conflict:*`) for busy/mismatch/swept conflicts — see idem-ledger.ts. */
  conflictLedger?: boolean;
  /** FAZ-4: what a retention-swept runId's late retry does — 'ignore' (default, re-runs: today's
   *  Behavior) or 'reject' (RunSweptError; the critical profile's choice). */
  tombstonePolicy?: 'ignore' | 'reject';
  /** FAZ-4: opaque caller identity, bound into the frozen input FIRST-WINS — a different actor
   *  Re-driving the runId gets RunActorMismatchError. Absent on either side = no check (auth-less
   *  Profile has no protection here — documented, not silent). */
  actor?: string;
  /** Y1/Y3: timeouts + claim TTL (see RunDurableArgs). */
  timeouts?: { modelStepMs?: number; toolMs?: number; claimTtlMs?: number };
  /**
   * (b) — streaming block/limit VISIBILITY: invoked ONCE at stream finish when a
   * Loop/maxToolCalls/duplicate/tainted block or a durable-tool block sentinel fired during the run.
   * Receives the RAW structured breach `{ kind, message, detail }` (the sentinel's own fields — no
   * Invented user-facing message; the app decides what to show its users). Advisory callback: a throw
   * From it is swallowed with a console.warn and never breaks the stream or masks the typed error the
   * Terminal promises reject with.
   */
  onBlocked?: (breach: StreamBreach) => void | Promise<void>;
};

/** `generateText` result + suspended tool calls (`interrupts`). */
export type DurableResult = Awaited<ReturnType<typeof generateText>> & { interrupts: Interrupt[] };

function hasSuspend(part: any): boolean {
  return part?.type === 'tool-result' && !!part.output?.__gnl_suspend;
}

// The sentinel returned when durable-tool.ts's loop/maxToolCalls gate is blocked
// (see the limits.ts header — since the AI SDK swallows tool-execute errors, this sentinel is
// Used instead of THROWING; the SAME mechanism as suspend, composeStopWhen stops the loop).
function hasLimitExceeded(part: any): boolean {
  return part?.type === 'tool-result' && !!part.output?.__gnl_limit_exceeded;
}

/**
 * Converts the FIRST sentinel found via `hasLimitExceeded` into a real error (see runDurableInner).
 * Decision #2: @gnldev/server sse.ts also uses this at the end of the stream — the sentinel does not
 * Leak to the client, the breach is converted into an SSE `error` event ({code, detail}). This is
 * Why it is EXPORTED.
 */
export function limitBreachFromSteps(steps: any[]): { kind: 'loop' | 'maxToolCalls' | 'duplicateSideEffect' | 'taintedSideEffect'; message: string; detail: any } | undefined {
  for (const step of steps ?? []) {
    for (const part of step.content ?? []) {
      if (hasLimitExceeded(part)) return part.output.__gnl_limit_exceeded;
    }
  }
  return undefined;
}

// K1: durable-tool's block sentinel (SideEffectRetryBlocked/RetryLimit/RunBusy) — since the AI SDK
// Swallows tool-execute throws, it is NOT thrown, a sentinel is returned instead (see durable-tool blockedOrThrow).
function hasBlocked(part: any): boolean {
  return part?.type === 'tool-result' && !!part.output?.__gnl_blocked;
}

/**
 * K1: return the FIRST `__gnl_blocked` sentinel — SAME contract as limitBreachFromSteps:
 * @gnldev/server sse.ts / @gnldev/agui use this at the end of the stream (the sentinel does not leak
 * To the client, it is converted into an error event). This is why it is EXPORTED.
 */
export function blockedFromSteps(steps: any[]): { toolCallId: string; toolName: string; code: string; message: string; detail?: any } | undefined {
  for (const step of steps ?? []) {
    for (const part of step.content ?? []) {
      if (hasBlocked(part)) return part.output.__gnl_blocked;
    }
  }
  return undefined;
}

// K1: sentinel's code → the original typed error (whatever durable-tool would have thrown outside the loop).
function errorFromBlocked(b: { code: string; message: string; detail?: any }): Error {
  if (b.code === 'SideEffectRetryBlockedError') return new SideEffectRetryBlockedError(b.message, b.detail);
  if (b.code === 'RetryLimitExceededError') return new RetryLimitExceededError(b.message, b.detail);
  // A worker already inside the loop when the operator
  // Condemned the run — durable-tool refuses the NEW side effect via this sentinel (see the gate there).
  if (b.code === 'CompensatedRunError') return new CompensatedRunError(b.detail?.runId ?? 'unknown');
  return new RunBusyError(b.message);
}

/**
 * K1/W1 (B): converts the FIRST blocked/limit sentinel in the `steps` array into a real
 * Typed error. runDurableInner uses this; it is also EXPORTED for code that consumes streamDurable
 * DIRECTLY (manually reading fullStream, not @gnldev/server sse.ts / @gnldev/agui) — pass it onFinish's
 * `ev.steps`: if a sentinel exists, it returns the TYPED error, otherwise `undefined` (the sentinel
 * Itself never leaks outward). Uses the SAME scan order as blockedFromSteps/limitBreachFromSteps —
 * The conversion logic lives in ONE place (no duplication): runDurableInner also calls this function.
 */
export function streamFinishError(steps: any[]): Error | undefined {
  const blocked = blockedFromSteps(steps);
  if (blocked) return errorFromBlocked(blocked);
  const limitBreach = limitBreachFromSteps(steps);
  if (limitBreach) {
    return limitBreach.kind === 'loop'
      ? new ToolLoopDetectedError(limitBreach.message, limitBreach.detail as any)
      : limitBreach.kind === 'duplicateSideEffect'
        ? new DuplicateSideEffectError(limitBreach.message, limitBreach.detail as any)
        : limitBreach.kind === 'taintedSideEffect'
          ? new TaintedSideEffectError(limitBreach.message, limitBreach.detail as any)
          : new RunLimitExceededError(limitBreach.message, limitBreach.detail as any);
  }
  return undefined;
}

/**
 * (b): the normalized breach handed to `StreamDurableArgs.onBlocked`. ONE shape for both
 * Sentinel families, REUSING the existing kinds: a limit sentinel keeps its `kind`
 * ('loop' | 'maxToolCalls' | 'duplicateSideEffect' | 'taintedSideEffect'); a durable-tool block
 * Sentinel uses its error `code` as the kind ('SideEffectRetryBlockedError' | 'RetryLimitExceededError' |
 * 'CompensatedRunError' | 'RunBusyError'). `message`/`detail` are the sentinel's RAW fields — nothing
 * User-facing is invented here.
 */
export interface StreamBreach {
  kind: 'loop' | 'maxToolCalls' | 'duplicateSideEffect' | 'taintedSideEffect' | (string & {});
  message: string;
  detail?: unknown;
}

// (b): normalize the FIRST sentinel (same scan order as streamFinishError — blocked first)
// Into the StreamBreach shape for the onBlocked callback. For a blocked sentinel without `detail`,
// Fall back to `{ toolCallId, toolName }` so the app can still identify the blocked call.
function streamBreachFromSteps(steps: any[]): StreamBreach | undefined {
  const blocked = blockedFromSteps(steps);
  if (blocked) return { kind: blocked.code, message: blocked.message, detail: blocked.detail ?? { toolCallId: blocked.toolCallId, toolName: blocked.toolName } };
  const limitBreach = limitBreachFromSteps(steps);
  if (limitBreach) return { kind: limitBreach.kind, message: limitBreach.message, detail: limitBreach.detail };
  return undefined;
}

// (b) — terminal-promise reject: the awaited-result promises a happy-path consumer reads
// (`result.text` first among them) must REJECT with the typed `streamFinishError(steps)` error when a
// Block/limit sentinel fired, mirroring runDurable's throw. DELIBERATELY EXCLUDED (they keep the
// Sentinel contract): `steps` (@gnldev/server sse.ts, @gnldev/agui and @gnldev/studio `await result.steps`
// WITHOUT a catch and post-scan it — rejecting it would replace their structured terminal error with a
// Generic one), `finishReason`/`usage` (@gnldev/studio's pipe awaits them even on the breach path — a
// Reject would blank its `done` event), `request`/`warnings` (resolve BEFORE stream finish — gating
// Them on `steps` would delay them), and the streams themselves (`fullStream`/`textStream`).
const STREAM_BREACH_REJECT_PROPS = new Set([
  'text', 'reasoningText', 'reasoning', 'sources', 'files', 'content',
  'toolCalls', 'staticToolCalls', 'dynamicToolCalls',
  'toolResults', 'staticToolResults', 'dynamicToolResults',
  'totalUsage', 'response', 'providerMetadata',
]);

/**
 * Second job of the same Proxy (see guardStreamTerminalPromises): hand the OUTPUT-PROCESSED value to
 * The caller instead of the model's raw one, for the two properties the processor contract actually
 * Covers. Receives the already-resolved raw value plus the run's steps; returns what the getter
 * Resolves with. Must never reject — a masking failure falls back to the raw value (the processor
 * Chain's own errors are reported by streamDurable's onFinish, which owns them).
 */
type TerminalMask = (prop: string, value: unknown, steps: any[]) => Promise<unknown>;

// Wraps the streamText result in a Proxy: the listed promise getters are gated on `steps` (which
// Resolves at the same finish point — no dependence on our own callbacks firing, so no new hang path)
// And reject with the typed error if a sentinel is present. Everything else passes through untouched
// (methods bound to the raw result so private state keeps working). Each wrapped promise gets a no-op
// Catch attached so merely ACCESSING a property on a breached run never becomes an unhandled rejection.
//
// `mask` (only passed when output processors exist) runs AFTER the breach gate: a breached run keeps
// Rejecting with the typed error, and only a clean run's value is transformed.
function guardStreamTerminalPromises<T extends object>(raw: T, mask?: TerminalMask): T {
  const cache = new Map<string, Promise<unknown>>();
  return new Proxy(raw, {
    get(target: any, prop, _receiver) {
      if (typeof prop === 'string' && STREAM_BREACH_REJECT_PROPS.has(prop)) {
        let gated = cache.get(prop);
        if (!gated) {
          gated = (async () => {
            const [value, steps] = await Promise.all([Reflect.get(target, prop, target), target.steps]);
            const err = streamFinishError(steps ?? []);
            if (err) throw err;
            return mask ? await mask(prop, value, steps ?? []) : value;
          })();
          gated.catch(() => { /* pre-handled — the rejection is delivered to whoever awaits the getter */ });
          cache.set(prop, gated);
        }
        return gated;
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as T;
}

// Query for semantic recall: the text of the most recent user message (string content or text parts).
function lastUserText(messages: any[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      const t = m.content.filter((p: any) => typeof p?.text === 'string').map((p: any) => p.text).join(' ');
      if (t) return t;
    }
  }
  return undefined;
}

// Combine stopWhen with the suspend detector: when a tool is suspended, the loop stops.
function composeStopWhen(stopWhen: any, stepHookFailure?: StepHookFailure): any[] {
  const base = stopWhen ?? stepCountIs(12);
  const suspendStop = ({ steps }: any) => {
    const last = steps[steps.length - 1];
    return Array.isArray(last?.content) && last.content.some((p: any) => hasSuspend(p) || hasLimitExceeded(p) || hasBlocked(p));
  };
  // A per-step hook that threw must end the loop even though the SDK swallowed the throw — without
  // this the run keeps stepping and finishes successfully, which is the opposite of what a blocking
  // processor asked for.
  const hookStop = () => stepHookFailure?.error !== undefined;
  return [...(Array.isArray(base) ? base : [base]), suspendStop, hookStop];
}

/**
 * AUDIT (approval first-class): the approval decision was not first-class in the journal —
 * `approvals` was passed as an EXTERNAL parameter on every call; in the 'approved but crashed before
 * The tool ran' scenario (approved, but the process died before execute completed), the decision was
 * Not PERSISTED anywhere → resume would require the `approvals` parameter again, forcing the caller
 * To maintain its own decision history.
 *
 * This function is called at the START of runDurableInner/streamDurable (BEFORE ctx is set up), in
 * Two steps:
 *  (a) writes EVERY decision that comes in via the parameter to the journal with `claim` — idempotent:
 *      `claim` only writes if the key is EMPTY, so the FIRST decision in the journal always wins
 *      (the exactly-once spirit — it NEVER overwrites with a DIFFERENT parameter that arrives later).
 *  (b) if `journal.listKeys` is supported (an optional adapter capability), reads ALL recorded
 *      Approvals for this run and MERGES them with the parameter — on conflict, the (FIRST) decision
 *      In the journal wins and is surfaced via `console.warn`. If `listKeys` is UNAVAILABLE (adapter
 *      Doesn't support it): only (a) is written, the merge stays LIMITED to the parameter — no WORSE
 *      Than today's behavior, it just skips enrichment from the journal (documented fallback).
 *
 * Read cost: a SINGLE enumeration call via `listKeys` + one `get` per approval record actually FOUND
 * (not for every possible tool/toolCallId — only for approval records that ACTUALLY exist).
 */
async function resolveApprovals(
  journal: Journal,
  runId: string,
  approvals: Record<string, boolean> | undefined,
): Promise<Record<string, boolean> | undefined> {
  // (a) claim every decision from the parameter into the journal (idempotent — first decision wins).
  // A SPENT slot (approvalScope:'attempt' consumed the previous answer before executing) is not a
  // decision: the human's fresh answer takes it over by CAS. Without this, the claim silently lost to
  // the leftover row and the new decision lived only in-process — a crash after this point forgot it.
  if (approvals) {
    for (const [toolCallId, decision] of Object.entries(approvals)) {
      const key = runKeys.approval(runId, toolCallId);
      const won = await claim(journal, key, decision);
      if (!won) {
        const raw = await journal.get(key);
        if (typeof raw === 'object' && raw !== null && (raw as { __gnl_approval_spent?: boolean }).__gnl_approval_spent) {
          if (journal.putIfMatch) await journal.putIfMatch(key, raw, decision);
          else await journal.put(key, decision); // single-process fallback, same bound as claim()
        }
      }
    }
  }

  // If listKeys is unavailable: enrichment is skipped, the merge stays limited to the parameter (fallback).
  if (!journal.listKeys) return approvals;

  // (b) read all approval records in the journal + merge with the parameter (the journal's FIRST decision wins).
  const prefix = runKeys.approval(runId, '');
  const keys = await journal.listKeys(prefix);
  if (keys.length === 0) return approvals;

  const merged: Record<string, boolean> = { ...approvals };
  for (const key of keys) {
    const toolCallId = key.slice(prefix.length);
    const journalDecision = await journal.get<boolean>(key);
    // Only a boolean is a decision — a spent sentinel (or anything else) reads as "no answer yet".
    if (typeof journalDecision !== 'boolean') continue;
    const paramDecision = approvals?.[toolCallId];
    if (paramDecision !== undefined && paramDecision !== journalDecision) {
      console.warn(
        `@gnldev/durable: '${runId}' approval conflict — for toolCallId '${toolCallId}' the parameter approval ` +
          `(${paramDecision}) differs from the RECORDED decision in the journal (${journalDecision}); ` +
          `the journal's FIRST decision wins (in the spirit of exactly-once).`,
      );
    }
    merged[toolCallId] = journalDecision; // the journal's FIRST decision wins
  }
  return merged;
}

// Write the run input (prompt/messages/system) to the journal on the first call → resume becomes self-contained.
/**
 * Freeze the `:memctx` provenance next to `:input` — ONCE, first attempt wins (same semantics: it
 * Describes the attempt whose input was frozen). Best-effort read-model: a failure to read it later
 * Degrades a debugging panel, never the run — but the WRITE is on the run path and not try/caught,
 * Matching persistInput (a journal that can't write is a failed run anyway).
 */
async function persistMemoryContext(journal: Journal, runId: string, prov?: MemoryContextRecord): Promise<void> {
  if (!prov) return;
  const key = runKeys.memoryContext(runId);
  if ((await journal.get(key)) !== undefined) return;
  await journal.put(key, prov);
}

async function persistInput(
  journal: Journal,
  runId: string,
  input: { prompt?: unknown; messages?: unknown; system?: unknown },
  alreadyFrozen: boolean,
  threadId?: string,
  agentName?: string,
  resourceId?: string,
  // FAZ-4: the RAW caller input's fingerprint (computed BEFORE memory prep mutates `input.messages` —
  // Post-prep content grows with the thread, so a post-prep hash would 409 every legitimate resume)
  // And the opaque actor identity. Both first-wins with the rest of the entry.
  rawInputHash?: string,
  actor?: string,
): Promise<void> {
  const key = runKeys.input(runId); // ':input' doesn't match parseJournalKey → invisible in the reader
  // `alreadyFrozen` is the SAME read, done once by the caller because the frozen-input adoption needs
  // it too (see applyInputProcessors) — first-wins is unchanged, and so is the round-trip count.
  if (alreadyFrozen) return;
  // `resourceId` — WHOSE run this is — rides along for the same reason threadId does, and answers a
  // question the journal previously could not: `ThreadRecord.resourceId` is a REQUIRED field and the
  // memory layer keys working memory by it (`res:<id>`), so the subject was already first-class for
  // CONVERSATIONS while runs stayed anonymous. A caller could group a user's threads and not their
  // runs. Frozen with the input rather than added as a column because that is where `threadId`/`agent`
  // already live: one write, no schema migration, and every adapter surfaces it through the read it
  // already does.
  //
  // FIRST-WINS, like the rest of this entry: the early return above means a resume never rewrites the
  // owner. A run belongs to whoever started it.
  //
  // We freeze threadId + the agent NAME together with the input (both optional): studio /runs reads
  // This to group runs by thread and to LABEL each run with its agent (no per-run journal N+1). It
  // Sits in the invisible `:input` entry → doesn't leak into reader/time-travel, doesn't affect step counting.
  // `at` = the run's TRUE start (this write precedes the first model call). recordRunMetrics needs it
  // Because the visible entries can't carry it: a streamed step's `model:N` row is written when the
  // Step FINISHES — a single-step streamed run has exactly one visible row, at the very end, so a
  // Ts-span duration read 0ms (live repro: a 27s stream recorded as 0ms). Additive field; readers of
  // The input blob ignore unknown fields.
  await journal.put(key, stampFormat({ at: Date.now(), prompt: input.prompt, messages: input.messages, system: input.system, ...(threadId ? { threadId } : {}), ...(agentName ? { agent: agentName } : {}), ...(resourceId ? { resourceId } : {}), ...(rawInputHash ? { hash: rawInputHash } : {}), ...(actor ? { actor } : {}) })); // H13
}

/** FAZ-6: `limits` is FROZEN to the journal and must stay serializable — the semantic block's
 * `embed` closure cannot ride along (structuredClone rejects functions, and a resumed run could not
 * Recover a closure from disk anyway). The frozen copy keeps the DECLARATIVE half (embedModelId,
 * Thresholds) so introspection stays honest; a resume that recovers limits from the journal runs with
 * The semantic gate INACTIVE (double opt-in unmet: no embed) unless the caller re-supplies it —
 * Fail-open, same posture as an unreachable embedder. */
function serializableLimits(limits: RunLimits): RunLimits {
  const dup = limits.sideEffectDuplicates;
  if (!dup || typeof dup !== 'object' || !dup.semantic) return limits;
  const { embed: _embed, ...semRest } = dup.semantic;
  // `embedStripped` marks the round-trip copy: the validator treats it as "declaratively present,
  // Functionally inactive" instead of throwing on the missing closure — WITHOUT the mark, a user who
  // Simply forgot `embed` would get silent inactivity (false confidence), so the bare-missing case
  // Still throws (denetçi blokeri: the unmarked strip killed EVERY resume of a semantic-active run,
  // Including approving the gate's own question).
  return { ...limits, sideEffectDuplicates: { ...dup, semantic: { ...semRest, embedStripped: true } as unknown as typeof dup.semantic } };
}

/** FAZ-4 admissibility gate — runs right after assertThreadOwnership in BOTH entry points, BEFORE
 * RunStarted (a refused attempt must not flip outcome state, same K2/K3 posture as the thread
 * Guard). Order: tombstone → actor → input fingerprint. Every refusal optionally lands in the
 * Idem-conflict ledger (PII-free) before it is thrown. */
async function assertRunAdmissible(
  journal: Journal,
  runId: string,
  frozen: FrozenInput | undefined,
  rawInputHash: string,
  opts: { strictInput?: boolean; conflictLedger?: boolean; tombstonePolicy?: 'ignore' | 'reject'; actor?: string; approvals?: Record<string, boolean> },
): Promise<void> {
  const refuse = async (err: Error, code: string, detail: Record<string, string | number>): Promise<never> => {
    if (opts.conflictLedger) await recordIdemConflict(journal, { runId, code, ...(opts.actor ? { actor: opts.actor } : {}), detail });
    throw err;
  };
  if (opts.tombstonePolicy === 'reject') {
    const tomb = await journal.get<{ at?: number }>(`${runId}:swept`);
    if (tomb !== undefined) {
      await refuse(
        new RunSweptError(
          `@gnldev/durable: run '${runId}' was retention-swept — its dedup window died with it, and a late retry must not silently re-run the side effects (tombstonePolicy 'reject'). Use a fresh runId, or verify the external system first.`,
          { runId, ...(tomb.at !== undefined ? { sweptAt: tomb.at } : {}) },
        ),
        'run_swept',
        tomb.at !== undefined ? { sweptAt: tomb.at } : {},
      );
    }
  }
  if (frozen?.actor && opts.actor && frozen.actor !== opts.actor) {
    await refuse(
      new RunActorMismatchError(
        `@gnldev/durable: run '${runId}' belongs to actor '${frozen.actor}' — '${opts.actor}' may not re-drive it.`,
        { runId, ownerActor: frozen.actor, requestedActor: opts.actor },
      ),
      'run_actor_mismatch',
      { ownerActor: frozen.actor, requestedActor: opts.actor },
    );
  }
  if (opts.strictInput && frozen?.hash !== undefined && frozen.hash !== rawInputHash) {
    // ESCAPE 1 — driving the run with the frozen record's OWN stored content is by definition a
    // Replay, not new content: resumeRun feeds `:input` back verbatim, and its messages are the
    // POST-prep view while `hash` fingerprints the PRE-prep raw input (see persistInput) — without
    // This, forwarding strictInput through resume would self-409 every memory-backed crash-resume.
    // One extra hash, computed only on the mismatch path.
    if (rawInputHash === argsHash({ prompt: frozen.prompt, messages: frozen.messages, system: frozen.system })) return;
    // ESCAPE 2 — bound to the JOURNAL's approval trace (heyet İhtilaf B), NOT to the mere presence
    // Of an approvals field: the addressed toolCallId must have a RECORD in this run. Any status, on
    // Purpose: after the approval lands the record moves suspended→succeeded/denied, and the SAME
    // Re-POST retried by an at-least-once client must replay — answering a request that deserves
    // Idempotent replay with "use a fresh runId" would be the contract lying (denetçi K18 bulgusu).
    // An approval naming a toolCallId this run never journaled still earns nothing.
    for (const toolCallId of Object.keys(opts.approvals ?? {})) {
      const rec = await journal.get<{ status?: string }>(runKeys.tool(runId, toolCallId));
      if (rec !== undefined) return;
    }
    await refuse(
      new RunInputMismatchError(
        `@gnldev/durable: run '${runId}' was started with DIFFERENT input (fingerprint ${frozen.hash} != ${rawInputHash}) — one runId carries one request; use a fresh runId for new content.`,
        { runId, expectedHash: frozen.hash, actualHash: rawInputHash },
      ),
      'run_input_mismatch',
      { expectedHash: frozen.hash, actualHash: rawInputHash },
    );
  }
}

/**
 * (memory-recall half, opt-in `limits.taintScope: 'thread'`): inherit thread taint at RUN
 * START — before any tool executes. Memory recall injects prior-thread messages into a NEW runId with
 * A clean per-run taint slate; if a prior turn on this thread was tainted (thread key claimed by
 * MarkRunTainted under the same opt-in), mark THIS run tainted now so the `taintedSideEffects` ladder
 * Fires for its side effects. Provenance: the ORIGINAL source tool/call is carried, `source` becomes
 * `'inherited'`, and `reason` names the thread. First-wins/idempotent (a resumed run that is already
 * Tainted keeps its original mark). No opt-in or no threadId → zero reads, byte-for-byte old behavior.
 * The SINGLE shared hook for runDurable and streamDurable — parity must not be broken.
 *
 * TAINT PHASE 3 (opt-in `limits.taintLifetime: 'content-window'`): before inheriting, check whether
 * The tainting content is STILL VISIBLE to the model this run — present in the messages actually
 * Loaded (recent + recalled: `visible.messages` is `rest.messages` AFTER memory/processor prep, which
 * Is exactly what goes to the model) or in working memory (lazy read via the attached Memory). Absent
 * Everywhere → the thread taint is EXPIRED for this run: do NOT inherit. The thread key is kept
 * LATENT (not cleared) on purpose — a later run whose semantic recall re-surfaces the poisoned
 * Message sees it visible again and the taint REVIVES. Every uncertain case keeps the inherit (see
 * IsThreadTaintExpired in taint.ts). A RESUMED tainted run is unaffected by expiry: its own run-taint
 * Key was already claimed on the original execution, so skipping the inherit changes nothing.
 */
async function inheritThreadTaint(
  journal: Journal,
  runId: string,
  threadId: string | undefined,
  limits: RunLimits | undefined,
  visible?: { messages?: any[]; memory?: Memory },
): Promise<void> {
  if (limits?.taintScope !== 'thread' || !threadId) return;
  const threadTaint = await readThreadTaint(journal, threadId);
  if (!threadTaint) return;
  if (limits.taintLifetime === 'content-window') {
    const wm = visible?.memory?.getWorkingMemory;
    const expired = await isThreadTaintExpired(
      journal, threadId, visible?.messages ?? [],
      wm ? () => wm.call(visible!.memory, threadId) : undefined,
    );
    if (expired) return; // poison no longer visible anywhere this run → do not inherit (taint stays latent)
  }
  await markRunTainted(journal, runId, {
    toolCallId: threadTaint.toolCallId,
    toolName: threadTaint.toolName,
    source: 'inherited',
    reason:
      `inherited from prior tainted turn in thread '${threadId}'` +
      (threadTaint.reason ? ` (${threadTaint.reason})` : ''),
  });
}

// Common fields for runDurable/streamDurable (the slice used in memory/processor preparation).
type PreparedInput = { prompt?: unknown; messages?: any[]; system?: InstructionsLike };

/**
 * Load the memory context: thread history + working memory (+ the OM/recall/WM tool on the rich path).
 * Updates `rest` in place; called BEFORE persistInput → the entire context freezes into `:input` = replayable.
 * The SINGLE shared path for runDurable and streamDurable — parity must not be broken.
 */
/**
 * WRITE-AHEAD dedupe input: does the tail of the loaded history already END with exactly the
 * Incoming message(s)? True on a retry of a turn whose write-ahead append (see writeAheadIncoming)
 * Already stored them — SAME runId (crash between append and completion) or a NEW runId re-sending
 * The identical text (studio playground's retry generates a fresh runId per attempt).
 * Compared by JSON shape: both sides come from the same construction (the caller's message object,
 * Roundtripped through the store), so key order is stable. Best-effort on purpose — a false NEGATIVE
 * Merely reproduces the pre-write-ahead behavior for that turn (a duplicate row), never worse.
 */
function historyEndsWithIncoming(history: any[], incoming: any[]): boolean {
  if (incoming.length === 0 || history.length < incoming.length) return false;
  const tail = history.slice(-incoming.length);
  for (let i = 0; i < incoming.length; i++) {
    if (JSON.stringify(tail[i]) !== JSON.stringify(incoming[i])) return false;
  }
  return true;
}

/**
 * F1 — durability review: server-owned-history contract, enforced at the core. useChat-style
 * Clients POST their ENTIRE message history every turn (see @gnldev/chat-adapter chat-route.ts — the
 * Client's UIMessage[] is converted wholesale); with memory+threadId that whole history became
 * `incoming`, so every turn re-persisted and re-prompted the echoed early turns — compounding
 * Duplication. Exact-equality dedupe can't catch it: the client's echo of an assistant turn
 * (UIMessage→ModelMessage) is structurally different from the `response.messages` shape memory
 * Stored, so JSON comparison never matches.
 *
 * The rule instead keys off ROLES: once a thread HAS stored history, any assistant/tool message
 * Inside `incoming` can only be an echo of a previous server turn (in a server-memory conversation
 * The client is not a source of assistant output) — so the genuinely NEW input is the block after
 * The LAST non-user message. A first turn (empty history) is left untouched on purpose: seeding a
 * New thread with a few-shot transcript is legitimate and still persists wholesale.
 *
 * WITH ONE EXCEPTION, measured: an ASSISTANT PREFILL. Ending a turn with a partial assistant message
 * ("Cevap:", a `{` to force JSON) is an ordinary provider-supported pattern, and the role rule read it
 * As an echo of everything — the anchor was the turn's own LAST message, so the slice came out EMPTY
 * and the question vanished with `incomingCount: 0`, no loss stamp and no warning (a thread holding an
 * answer to a question it does not contain). So a TRAILING block of assistant/tool messages is
 * skipped when looking for the echo anchor, which also keeps the full-history + prefill combination
 * right: the anchor is found before the prefill, and the slice carries the question AND the prefill.
 *
 * AND THE EXCEPTION NEEDS EVIDENCE OF ITS OWN, measured after the skip shipped and before it did any
 * harm. "An echoing client never ends its POST with an assistant row" is FALSE for the two things a
 * useChat client does most after asking a question: REGENERATE and "continue generating" re-POST the
 * whole conversation and add NOTHING. The role scan then walked past the trailing assistant row as if
 * it were a prefill, anchored on the PREVIOUS assistant, and read the already-stored last turn as
 * brand new: thread 4 rows → 7, the model shown "ikinci soru" and its answer TWICE, `:memctx`
 * reporting `incomingCount: 2, echoTrimmed: 2` with no warning. A client-side tool result resent on
 * its own has the same shape. The two cases are structurally IDENTICAL —
 * `[…echo, user, assistant]` either way — so no rule about roles or positions can separate them; the
 * only thing that can is whether those rows are ALREADY IN THE THREAD.
 *
 * So the skip is taken only when the rows it would hand over contain something the loaded history
 * does not already hold. Compared by JSON shape, and the comparison is a good deal more reliable here
 * than `historyEndsWithIncoming`'s: the rows being checked are the CLIENT'S OWN user messages, and
 * memory stores those verbatim (writeAheadIncoming appends what the caller sent), so a client
 * re-POSTing its own message matches its stored copy exactly. Assistant rows — the ones that come
 * back from the provider in a different shape than the client renders — are never the evidence.
 *
 * When the POST does NOT end in an assistant/tool block the function is byte-for-byte what it was
 * before the prefill exception existed.
 *
 * THE INPUT CHAIN USED TO BREAK THIS, and the comparison is where it broke. The thread holds what the
 * chain PRODUCED (masked) while the client re-POSTs its own transcript (RAW), and the chain has not
 * run at this point — it cannot, because the boundary computed here is what the chain is then tracked
 * across. So `stored.has(JSON.stringify(row))` never matched, every regenerate under a redactor read
 * as new, and the thread grew. Measured, one regenerate per turn:
 *
 *   no processors : 2 → 3 → 4 → 5 → 6    (+1 each — the new assistant reply, which is the real answer)
 *   redactor      : 2 → 5 → 9 → 14 → 20  (+3, +4, +5, +6)  ← before `compare`
 *
 * The cost GREW per turn, because each unmatched turn left more unmatched history for the next one to
 * re-append — quadratic in the thread store, and more history sent to the model every turn. An earlier
 * note called this "a duplicate row" and left it as a residual; it was neither one row nor bounded.
 *
 * `compare` closes it without moving the chain: the caller passes the rows AS THE CHAIN WILL RENDER
 * THEM (see `makeEchoView`), used for membership only, while the slice returned is still built from
 * `incoming`. Both sides are then the chain's output and match. With no processors `compare` IS
 * `incoming`, so that path is byte-for-byte unchanged. `historyEndsWithIncoming` has the same
 * limitation for the same reason and is NOT covered by this — it compares after the chain has run on
 * a different array, and no measurement here says anything about it.
 */
function dropEchoedHistory(history: any[], incoming: any[], compare: any[] = incoming): any[] {
  if (history.length === 0) return incoming;
  const isEchoable = (m: any) => m?.role === 'assistant' || m?.role === 'tool';
  /** Last assistant/tool index below `limit` — the echo anchor; -1 when the POST is all new. */
  const anchorBelow = (limit: number): number => {
    for (let i = limit - 1; i >= 0; i--) if (isEchoable(incoming[i])) return i;
    return -1;
  };
  let end = incoming.length; // one past the last message that may serve as the echo anchor
  while (end > 0 && isEchoable(incoming[end - 1])) end--;
  if (end === incoming.length) return incoming.slice(anchorBelow(end) + 1); // no trailing block
  // A trailing assistant/tool block is a PREFILL only if the rows in front of it are genuinely new.
  // Compared through `compare` — the same rows as the input chain will render them — because `history`
  // holds what the chain PRODUCED and `incoming` is what the client SENT. `compare` is index-parallel
  // to `incoming` and defaults to it, so a deployment with no input processors compares exactly what
  // it did before.
  // AN ECHO IS A SUFFIX, not a set of rows that each appear somewhere. This was a `Set` over the whole
  // history, so a row counted as "already sent" if it matched ANY stored row at ANY position — and
  // redaction exists to collapse distinct texts onto one token, which makes such a collision ordinary
  // rather than exotic. Measured: turn 1 stored `soru [MASKED_EMAIL]` (from `a@x.com`); turn 2 sent a
  // genuinely new `soru b@y.com` plus a client-side tool round; the new question masked to the same
  // string, matched turn 1's row, and the whole turn was dropped — the model was never shown the
  // question and the thread ended with two assistant rows under one user row. Silent, and worse than
  // the growth the comparison was fixed to stop.
  //
  // Position-by-position against the TAIL is what "the client re-sent what it already has" actually
  // means, and it is strictly narrower: a genuine regenerate still matches, while a new turn that only
  // RESEMBLES an old row no longer does.
  // Compared as role + text rather than by JSON: a stored assistant row holds a parts array while a
  // client posts a plain string, so the two are never JSON-equal. The old check dodged that by looking
  // only at the rows in FRONT of the trailing block — which is what made the collision invisible, since
  // those rows alone cannot tell "the client re-sent the thread and added a tool round" from "the
  // client asked something new that happens to mask identically". The trailing rows are the only thing
  // that distinguishes them, so they have to be comparable, so they are normalised.
  const norm = (m: any): string => {
    const c = m?.content;
    const text = typeof c === 'string' ? c
      : Array.isArray(c) ? c.map((p: any) => (typeof p?.text === 'string' ? p.text : JSON.stringify(p))).join('')
      : JSON.stringify(c);
    return `${m?.role}\u0000${text}`;
  };
  // Where in the thread this POST starts. A client re-POSTs a SUFFIX of the conversation (often all of
  // it), so every incoming row that lands inside `history` must match at ITS OWN position, and the rows
  // past the end are the new part. An offset only counts if the claimed rows are covered by history —
  // a claimed row beyond the end was never stored, whatever it resembles.
  let isEcho = false;
  for (let o = 0; o <= history.length && !isEcho; o++) {
    let ok = true;
    let matched = 0;
    for (let i = 0; ok && i < incoming.length && o + i < history.length; i++) {
      if (norm(compare[i]) !== norm(history[o + i])) ok = false; else matched++;
    }
    for (let i = anchorBelow(end) + 1; ok && i < end; i++) if (o + i >= history.length) ok = false;
    // AT LEAST ONE ROW HAS TO HAVE ACTUALLY MATCHED. At `o === history.length` the inner loop never
    // runs, so `ok` stayed true and the POST was declared an echo without a single comparison — which
    // any all-echoable `incoming` reaches, because the coverage loop below it is empty too. Measured: a
    // client sending one tool result on its own, for a NEW `toolCallId` whose text matched an older
    // result (`ok`, `true`, `success` — ordinary tool output), had it dropped silently: neither shown
    // to the model nor written to the thread. Vacuous truth is not evidence of an echo.
    isEcho = ok && matched > 0;
  }
  if (!isEcho) return incoming.slice(anchorBelow(end) + 1);
  return incoming.slice(anchorBelow(incoming.length) + 1); // regenerate/continue: nothing is new
}

/**
 * Why a turn could not be re-read out of the post-processor context (see reportIncomingLoss).
 * `messages-dropped` — the chain returned no `messages` array at all (flattened into `prompt`, or a
 * partial ProcessorInput). `boundary-lost` — the chain rebuilt everything, so nothing anchors the
 * history/incoming split. `turn-dropped` — the split is known and the chain removed the turn from it.
 */
export type IncomingLossReason = 'messages-dropped' | 'boundary-lost' | 'turn-dropped';

/** The `:memctx` journal record — MemoryContextProvenance plus the run-side counts (see runKeys.memoryContext). */
export interface MemoryContextRecord extends MemoryContextProvenance {
  v: 1;
  threadId: string;
  /**
   * New message(s) this turn actually contributed (after echo-trim), counted against the FROZEN
   * `:input` — so when input processors changed the count, this is the POST-chain number
   * (see reconcileProcessedIncoming). regression.ts's `stripMemoryContext` slices exactly this many
   * trailing messages off the frozen input, which is only sound if the two agree.
   * FROZEN-INPUT RELATIVE, deliberately: when the chain appended its own rows BEHIND the turn they
   * are part of this trailing block (they were sent to the model) but are NOT persisted to the
   * thread — `chainAppended` says how many, so "what memory holds" is `incomingCount - chainAppended`.
   */
  incomingCount: number;
  /**
   * How many of the trailing `incomingCount` rows were located as INPUT-PROCESSOR OUTPUT sitting
   * behind the turn (a policy reminder, a "[trimmed]" marker) and therefore kept out of thread
   * memory — see trackTurnEnd. Absent when the chain appended nothing (every run without processors,
   * and every processor that only rewrites what it is given).
   */
  chainAppended?: number;
  /**
   * How many of the persisted rows sat INSIDE the turn without the caller having sent them — a
   * just-in-time hint dropped between two of its messages, or an appended note whose own processor
   * rewrote the turn as well and so left nothing for trackTurnEnd to locate. Unlike `chainAppended`
   * these ARE written to the thread; there is no evidence that separates them from caller content
   * (see trackTurnEnd's REJECTED count-as-locator), so they are counted instead of guessed at, and
   * "how much of this turn the caller actually wrote" stays answerable months later. Absent when the
   * chain contributed nothing inside the turn — every run without processors, and every processor
   * that only rewrites what it is given.
   */
  chainInserted?: number;
  /** Client-echoed messages dropEchoedHistory stripped from the request (0 = delta-only client). */
  echoTrimmed: number;
  /**
   * Set when the input-processor chain left NO recoverable copy of this turn, so the thread was
   * stored with an answer and no question (see reportIncomingLoss). Absent on every healthy run.
   */
  incomingUnrecoverable?: IncomingLossReason;
  /**
   * Set when this turn was dropped as a duplicate on the POST-processor shapes only — the raw texts
   * may well have differed and been collapsed by redaction (see reconcileProcessedIncoming's
   * residual note). Absent when the dedupe did not fire.
   */
  incomingDedupedByShape?: true;
}

/**
 * What the input chain WILL make of these rows, for comparison only — never for what is sent or stored.
 *
 * `dropEchoedHistory` asks "did the client just echo back what is already in the thread". The thread
 * holds the chain's OUTPUT (masked), the client re-POSTs its own transcript (raw), and the chain has
 * not run yet at that point — it cannot, because the boundary this function feeds is what the chain is
 * then tracked across. So the two sides were never comparable, every regenerate under a redactor read
 * as new, and the thread grew: measured 2 → 5 → 9 → 14 → 20 rows over four regenerates, against
 * 2 → 3 → 4 → 5 → 6 with no processors. The cost grew per turn because each unmatched turn left more
 * unmatched history for the next one to re-append.
 *
 * Running the chain a second time here is safe for the transform (`processInput` is a pure, repeatable
 * mapping — that is what lets a resumed run reuse the frozen `:input`), but NOT for its journal
 * writes: `recordProcessorReport` is first-wins, so a dry run over the incoming rows ALONE would win
 * the key and report a smaller count than the real pass over history + incoming. It is therefore given
 * a ctx whose journal swallows both halves of that read-then-write.
 *
 * Bails out to the raw rows — i.e. exactly today's behaviour — whenever the answer cannot be trusted:
 * a processor that throws, one that returns no `messages`, or one that changes their COUNT (a
 * summariser legally returns fewer), since the result must stay index-parallel to `incoming`.
 */
function makeEchoView(
  processors: Processor[] | undefined,
  journal: Journal,
  runId: string,
): ((rows: any[], system?: unknown) => Promise<any[]>) | undefined {
  const chain = (processors ?? []).filter((p) => typeof p.processInput === 'function');
  if (chain.length === 0) return undefined;
  // A PROXY, not `{...journal}`: a Journal is a class instance, so a spread copies its own fields and
  // leaves every prototype method behind. Measured on `InMemoryJournal` — the spread kept `get`/`put`
  // (the two written here) and dropped `putIfAbsent`, `putIfMatch` and `incrBy`. The way in is
  // `ctx.journal`, which is public API a processor may call anything on: such a call throws on the
  // missing method, the catch below swallows it, and the view silently falls back to the raw rows —
  // present, costing a chain run, doing nothing. NOT `ctx.step`, which an earlier version of this
  // comment blamed: it is a get+put memoize and works either way, and the mutation said so. Everything
  // except the two swallowed calls is delegated to the real journal, bound to it so private state
  // still resolves.
  const silent = new Proxy(journal, {
    get (target, prop, receiver) {
      if (prop === 'get') return async () => undefined;
      if (prop === 'put') return async () => {};
      const v = Reflect.get(target, prop, receiver === undefined ? target : target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as Journal;
  // `ctx.step` REFUSES here, rather than running. It exists for decisions that are expensive or not
  // deterministic — the doc names model-based moderation — and journals them so a resume reuses the
  // one answer. A dry run cannot journal (its writes are swallowed, which is the point), so a stepping
  // processor would COMPUTE TWICE per turn: measured, `computeCalls` went 1 → 2. Doubling a moderation
  // call to save a duplicated row is the wrong trade, so the throw lands in the catch below and the
  // view falls back to the raw rows — such a deployment keeps the growth this fix removes, and keeps
  // its one model call. Everything else on `ctx.journal` still works.
  const ctx: ProcessorCtx = {
    ...createProcessorCtx(silent, runId),
    step: () => { throw new Error('gnl: echo view is a dry run — ctx.step is not available here'); },
  };
  return async (rows: any[], system?: unknown): Promise<any[]> => {
    try {
      let msgs = rows;
      for (const p of chain) {
        // `system` rides along because a processor may READ it and decide differently — measured, one
        // that labelled messages from `i.system` produced a different masked shape in the dry run than
        // in the real pass, the comparison stopped matching, and the growth came back. Passed, not
        // used: whatever the chain returns for `system` is discarded.
        const out = await p.processInput!({ messages: msgs, ...(system !== undefined ? { system } : {}) } as never, ctx);
        if (!Array.isArray(out?.messages) || out.messages.length !== rows.length) return rows;
        msgs = out.messages;
      }
      // ONLY the rows the INPUT chain is what stored them. A user row reaches the thread through
      // `processInput`, so the masked copy is what to compare against. A model's own reply does NOT: it
      // is stored through `processOutput`, or raw when the processor only defines an input hook — which
      // is exactly what `on: 'input'` means. Masking those here made the comparison miss whenever the
      // MODEL's text contained something the input hook would transform, and the growth came back:
      // measured with an input-only redactor and a reply containing an address, 2 → 5 → 9 → 14. The
      // client holds whatever it was served, so an echoed assistant row already matches the stored one
      // as sent — with `on: 'both'` both sides are masked, with `on: 'input'` both are raw.
      return rows.map((m, i) => (m?.role === 'assistant' || m?.role === 'tool' ? m : msgs[i]));
    } catch {
      return rows; // a processor that cannot answer is not evidence about the echo
    }
  };
}

async function prepareMemoryContext(
  memory: Memory,
  threadId: string,
  resourceId: string | undefined,
  rest: PreparedInput,
  echoView?: (rows: any[], system?: unknown) => Promise<any[]>,
): Promise<{ incoming: any[]; wmTool?: Record<string, any>; alreadyStored: boolean; provenance?: MemoryContextRecord; historyCount: number }> {
  const rawIncoming: any[] = rest.messages ?? (rest.prompt != null ? [{ role: 'user', content: rest.prompt }] : []);
  delete rest.prompt;
  const echoSystem = rest.system;
  const echoCompare = echoView ? await echoView(rawIncoming, echoSystem) : rawIncoming;
  const rid = resourceId ?? (memory.getThreadResource ? await memory.getThreadResource(threadId) : undefined);

  if (typeof memory.loadContext === 'function') {
    // Rich path (Phase 14 AgentMemory): composes recall + WM + OM + tool in a single pass.
    const mc = await memory.loadContext(threadId, { query: lastUserText(rawIncoming), resourceId: rid, incoming: rawIncoming });
    const history = mc.messages ?? [];
    // F1: strip client-echoed history first (full-history POSTing clients), THEN the retry dedupe.
    const incoming = dropEchoedHistory(history, rawIncoming, echoCompare);
    // Retry dedupe (see historyEndsWithIncoming): when the loaded history already ends with this
    // Turn's incoming (a prior attempt write-ahead-appended it), do NOT concat it again — the model
    // Would see the user message twice and writeAheadIncoming would store it twice.
    const alreadyStored = historyEndsWithIncoming(history, incoming);
    rest.messages = alreadyStored ? [...history] : [...history, ...incoming];
    if (mc.system) rest.system = [systemText(rest.system), mc.system].filter(Boolean).join('\n\n');
    const provenance: MemoryContextRecord = {
      v: 1, threadId,
      recalled: mc.provenance?.recalled ?? [],
      recentCount: mc.provenance?.recentCount ?? history.length,
      ...(mc.provenance?.recent !== undefined ? { recent: mc.provenance.recent } : {}),
      ...(mc.provenance?.observationCount !== undefined ? { observationCount: mc.provenance.observationCount } : {}),
      ...(mc.provenance?.workingMemoryChars !== undefined ? { workingMemoryChars: mc.provenance.workingMemoryChars } : {}),
      incomingCount: incoming.length,
      echoTrimmed: rawIncoming.length - incoming.length,
    };
    // `historyCount` is the history/incoming BOUNDARY inside `rest.messages` — see
    // reconcileProcessedIncoming for why the split has to be recoverable after the input processors ran.
    return { incoming, wmTool: mc.tools, alreadyStored, provenance, historyCount: history.length };
  }
  // Legacy path (BasicMemory / SemanticMemory) — provenance is the limited truth this path can see:
  // Everything loaded counts as the recent window (no recall refs, no OM).
  const history = await memory.getMessages(threadId, { query: lastUserText(rawIncoming), resourceId: rid });
  const incoming = dropEchoedHistory(history, rawIncoming, echoCompare);
  const alreadyStored = historyEndsWithIncoming(history, incoming);
  rest.messages = alreadyStored ? [...history] : [...history, ...incoming];
  let wmChars: number | undefined;
  if (memory.getWorkingMemory) {
    const wm = await memory.getWorkingMemory(threadId);
    if (wm) {
      rest.system = [systemText(rest.system), `# Working Memory\n${wm}`].filter(Boolean).join('\n\n');
      wmChars = String(wm).length;
    }
  }
  // Legacy refs: plain message objects (no store seq) — seq is the array index; preview via the
  // SHARED messagePreview (memory.ts) so tool-call/tool-result rows read structurally, not as "—".
  const provenance: MemoryContextRecord = {
    v: 1, threadId, recalled: [], recentCount: history.length,
    recent: history.slice(-PROVENANCE_RECENT_CAP).map((m: any, i: number) => ({
      threadId, seq: Math.max(0, history.length - PROVENANCE_RECENT_CAP) + i, role: String(m?.role ?? '?'), preview: messagePreview(m),
    })),
    ...(wmChars !== undefined ? { workingMemoryChars: wmChars } : {}),
    incomingCount: incoming.length,
    echoTrimmed: rawIncoming.length - incoming.length,
  };
  return { incoming, alreadyStored, provenance, historyCount: history.length };
}

/**
 * Carry the history/incoming boundary across ONE processor's transform.
 *
 * Needed because a processor is PURE: it returns a new array of new objects, so the `incoming`
 * reference the memory path captured before the chain ran still points at the caller's RAW messages.
 * Persisting that reference is how raw PII reached thread memory while the journal, the prompt and the
 * caller's result were all correctly masked (measured — see processor-memory-redaction.test.ts).
 * The boundary is what lets the memory path re-read this turn's messages out of the array the model
 * actually receives, instead of trusting a stale reference.
 *
 * The signals below are tried STRONGEST FIRST. Each one is EVIDENCE (a surviving object identity, a
 * surviving shape, an unchanged layout) — none of them is a guess about where the boundary
 * "probably" is. The two POSITIONAL signals (unchanged count, boundary 0) are the weakest of the
 * set, because they are true about the array's LENGTH while saying nothing about its indices:
 *
 *   1. LAYOUT UNCHANGED — same count AND the same role at every index. This is the pure text
 *      transform (piiRedactor, safety, moderation), the case the leak was actually reported for, and
 *      it is checked first because it is the hot path: an O(n) role scan, no allocation, and it ends
 *      the search for every processor that rewrites content in place. The role check is what makes
 *      it EVIDENCE rather than a length coincidence — see the counter-example below. COST, re-measured
 *      per processor per turn against the code as it actually ships (Node 22, 200k iterations after
 *      warmup, two runs): ~30-60ns on an empty thread, ~130-250ns at 20 history messages, ~730ns-1µs
 *      at 100, and ~2.9-4.1µs at 400. An earlier version of this note said "1µs at 400", which was
 *      about three times optimistic — 1µs is what ONE HUNDRED history messages costs, not four
 *      hundred. Two things it left out: the scan is O(history), so the number grows with the thread
 *      and not with the turn; and it runs TWICE per processor, once here and once as trackTurnEnd's
 *      E1 (the two scans are 85-95% of the whole span-tracking cost above — the ladders below are
 *      almost free by comparison, because on this path they never run). Still four orders of magnitude
 *      under the model call it rides along with, and end-to-end over the shipped chain (piiRedactor +
 *      moderation + tokenLimit, 100 turns) the difference is noise — but "four orders" is the honest
 *      claim at a realistic thread size, not five.
 *   2. The EARLIEST of the turn's own messages to survive, BY IDENTITY. A processor that removes
 *      messages is written as a filter (tokenLimiter's trim-oldest: `messages.filter(...)`), and a
 *      filter keeps its survivors' object identity, so the boundary is simply where the first of them
 *      ended up — including when the row that did NOT survive is the turn's opening one, which is
 *      exactly what a tight token budget trims. This also absorbs a processor that INSERTS ahead of
 *      the new turn — the insertion lands on the HISTORY side, which is what a just-in-time retrieval
 *      artifact is (regenerated next turn; persisting it compounds).
 *   3. The HISTORY side, by identity: the last loaded-history message that survived — everything
 *      after it is this turn. Covers a chain that rebuilt the new turn but left history alone, and a
 *      chain that summarized/trimmed history down to messages it did not rewrite. It is also a FLOOR
 *      under signal 2 rather than a fallback for it: a caller row hoisted in FRONT of the history
 *      must not drag the boundary back over rows the thread already holds.
 *   4. BOUNDARY 0 → the thread had no history, so whatever the chain produced is entirely this turn.
 *      Below the identity signals on purpose: on an empty thread an INJECTOR's prepended context is
 *      the only other thing in the array, and identity can still tell the two apart. Above the shape
 *      signals on purpose: a first turn is allowed to be a seeded few-shot transcript, where the same
 *      shape may legitimately appear more than once and "all of it is the turn" is the documented rule.
 *   5. The first incoming message BY SHAPE, searched from the END (so a message duplicated earlier in
 *      history cannot win over the live turn). Covers the common summarizer — rewrite the history,
 *      carry the new question through verbatim.
 *   6. The HISTORY side BY SHAPE, likewise searched from the END: the last loaded-history message
 *      that still appears anywhere in the result. Covers the chain that rebuilds every object AND
 *      rewrites the new turn (redact) while leaving some history row textually intact — the net-zero
 *      trim-and-annotate, where signal 1's length is unchanged but nothing is where it was.
 * REMOVED — signal 7, "COUNT UNCHANGED, unguarded" (signal 1's premise without the role evidence),
 * which used to sit at the bottom of this ladder and return the old index. It was kept on the theory
 * that it could never do WORSE than the pure-count rule it replaced; measured, it is a coin flip with
 * counter-examples in BOTH directions, which by this file's own standard is not a rule. Same
 * processor (rewrite every message, same count, one role changed so signal 1 does not apply), two
 * permutations, one thread of [Q1, A1] plus the turn Q2:
 *   rotate LEFT  → [<A1>, <Q1>, <Q2>]: index 2 still holds the turn, so it happened to be right.
 *   rotate RIGHT → [<Q2>, <Q1>, <A1>]: index 2 holds a rewritten ASSISTANT message from the history,
 *                  and the thread stored it as the user's turn — `incomingCount: 1`, no stamp, no
 *                  warning, and the real question nowhere. A silent, wrong-content write.
 * Nothing in the suite exercised it (measured: mutating it to BOUNDARY_LOST left all 1467 durable
 * tests green), and losing the question loudly is this file's documented preference over writing
 * someone else's message quietly. Those shapes now report BOUNDARY_LOST — see reportIncomingLoss.
 *
 * When none of them hold — the chain dropped messages AND rebuilt every survivor, so nothing from
 * before is recognizable after — the boundary is REPORTED LOST (`BOUNDARY_LOST`) instead of being
 * clamped into range. The old clamp was biased to the end of the array: on a shortened array it
 * collapsed onto `msgs.length`, the split came out empty, and the turn was silently NOT persisted —
 * measured on summarizer-shaped chains, a thread holding an answer with no question. Losing the
 * question is not a smaller failure than persisting the wrong message, so neither is chosen silently:
 * see reportIncomingLoss.
 *
 * REJECTED — the original order, with the two positional signals FIRST. Measured: a processor that
 * redacts, drops the oldest message and appends a "[trimmed]" marker changes the count by NET ZERO,
 * so the pure-count rule returned the old index unchanged and the split landed on the marker. The
 * thread stored the processor's own note as the user's turn, the question was gone, and `:memctx`
 * still read `incomingCount: 1` with no loss stamp — a silent, wrong-content write. The identity and
 * shape signals had the right answer available the whole time; they just never ran (pinned in
 * processor-memory-redaction.test.ts, "the history/incoming boundary survives processors that MOVE
 * the turn"). Same defect for `boundary === 0` and an injector on an empty thread.
 *
 * What this function must never do is hand back the PRE-chain array — that is the leak itself. Every
 * value it returns indexes into the POST-chain array, and the lost case returns no index at all.
 *
 * REJECTED — clamping to the tail instead (`after.length - (before.length - boundary)`, "the turn is
 * however many messages it was, counted from the end"): it fixes the summarizer but breaks the chain
 * that DROPS the new turn, where the tail is a history assistant message and persisting it as this
 * turn's incoming corrupts the thread. Measured on both; a rule with counter-examples in both
 * directions is not a rule.
 *
 * REJECTED — letting the processors mutate `incoming` in place (the "just make it the same object"
 * fix): pii.ts is deliberately pure/deterministic, which is what makes "same masking on resume" true
 * and what regression.ts's frozen-input replay assumes; mutation would also silently rewrite the
 * caller's own message array.
 */
const BOUNDARY_LOST = -1;

/**
 * The turn is the frozen `prompt`, not a slice of a `messages` array — the one case where a
 * non-array frozen input still has a recoverable turn (see adoptFrozenInput).
 */
const PROMPT_IS_TURN = -2;

/** What `persistInput` froze under `:input` (plus the format stamp, which readers ignore). */
type FrozenInput = { prompt?: unknown; messages?: unknown; system?: unknown; threadId?: string; hash?: string; actor?: string };

/**
 * The turn's span inside the message array: `[start, end)`. `start` is the history/incoming boundary
 * (see trackIncomingBoundary); `end` is one past the turn's LAST message, which is `messages.length`
 * unless the chain put something BEHIND the turn (see trackTurnEnd).
 */
interface IncomingSpan {
  start: number;
  end: number;
}

/** Last index >= `min` whose JSON shape equals `want`, or -1. */
function lastIndexByShape(after: any[], want: string, min = 0): number {
  for (let i = after.length - 1; i >= min; i--) {
    if (JSON.stringify(after[i]) === want) return i;
  }
  return -1;
}

/** Last index >= `min` holding `want` BY OBJECT IDENTITY, or -1. */
function lastIndexByIdentity(after: any[], want: unknown, min = 0): number {
  for (let i = after.length - 1; i >= min; i--) if (after[i] === want) return i;
  return -1;
}

function trackIncomingBoundary(before: any[], after: any[], span: IncomingSpan): number {
  const boundary = span.start;
  if (boundary < 0) return boundary; // already lost — stays lost for the rest of the chain
  const sameCount = after.length === before.length;
  // 1 — layout unchanged (count AND roles): the pure-transform hot path, ended here as before.
  if (sameCount && before.every((m, i) => m?.role === after[i]?.role)) return boundary;
  // 2 — IDENTITY, over the WHOLE turn and not only its first message. `before[boundary]` alone is
  // the weaker half of the same evidence: a chain that DROPS the turn's opening rows keeps the rest
  // by identity (every `filter`-shaped processor does — tokenLimiter's trim-oldest is one, and under
  // a budget tight enough to cut into the turn it drops exactly that first row), and looking only at
  // the row that did not survive threw the surviving ones away. Measured with the shipped
  // tokenLimiter at `maxInputTokens: 20`: `modelRows=1 QUESTION_STORED=false incomingCount=0
  // lost=boundary-lost`, while the turn's own last message sat in `after[0]` under its original
  // identity — the very evidence trackTurnEnd's E2 was already using on the other side of the turn.
  // The EARLIEST survivor is the boundary (a filter preserves order, so nothing of the caller's can
  // precede it), and the search is over the turn only, so its cost is the turn's width — 1-3 rows —
  // not the thread's.
  let firstCaller = -1;
  for (let i = boundary; i < span.end; i++) {
    if (before[i] === undefined) continue; // never let a hole match a hole
    const at = after.indexOf(before[i]);
    if (at >= 0 && (firstCaller < 0 || at < firstCaller)) firstCaller = at;
  }
  let histFloor = -1;
  for (let j = boundary - 1; j >= 0; j--) {
    const at = after.indexOf(before[j]); // 3
    if (at >= 0) { histFloor = at + 1; break; }
  }
  // The history side is a FLOOR under the identity signal, never overridden by it: a chain that
  // hoists a caller row in FRONT of the loaded history (a "system messages first" normalizer) would
  // otherwise pull the boundary to 0 and persist the entire thread as this turn.
  if (firstCaller >= 0) return Math.max(firstCaller, histFloor);
  if (histFloor >= 0) return histFloor;
  if (boundary === 0) return 0; // 4
  const firstIncoming = before[boundary];
  if (firstIncoming !== undefined) {
    const at = lastIndexByShape(after, JSON.stringify(firstIncoming)); // 5
    if (at >= 0) return at;
  }
  for (let j = boundary - 1; j >= 0; j--) {
    const at = lastIndexByShape(after, JSON.stringify(before[j])); // 6
    if (at >= 0) return at + 1;
  }
  return BOUNDARY_LOST;
}

/**
 * Carry the turn's END across ONE processor's transform — the mirror of trackIncomingBoundary, for
 * the other side of the turn.
 *
 * WHY IT EXISTS. The boundary alone says where the turn STARTS; everything after it was taken to be
 * the turn. A processor that appends BEHIND the turn — a compliance/policy reminder, a "[trimmed]"
 * marker — therefore had its own note persisted into the thread as part of the user's turn. Measured
 * with a policy-reminder processor over 10 turns (a `{role:'system'}` row appended every turn):
 * memory grew to 30 rows of which 10 were the processor's note (33% of rows, +83% of characters
 * against the same thread without it), and because the note is stored it is RELOADED as history and
 * a fresh one is appended on top — the model saw the reminder ONCE on turn 1 and TEN TIMES on turn
 * 10, when the processor's intent was "once per turn". `tokenLimiter` makes that worse rather than
 * better: `keepSystem` protects `role:'system'` rows from trimming, so the accumulated notes are the
 * LAST thing evicted while real conversation goes first.
 *
 * WHY IT IS EVIDENCE AND NOT A GUESS. Content that sits AFTER the caller's last message cannot be
 * the caller's, because the caller's contribution ends with the caller's last message. So locating
 * that one message post-chain is enough — no rule about what a note "looks like" is needed:
 *
 *   E1. LAYOUT UNCHANGED (same count AND the same role at every index) — the pure text transform;
 *       the end is where it was. Same hot-path check, and the same evidence, as boundary signal 1.
 *   E2. The turn's LAST message BY IDENTITY, searched from the END and only at indices >= the
 *       (already tracked) start. Identity survives every processor that spreads/filters instead of
 *       rebuilding — which is what an appending processor does, and what a MULTI-processor chain
 *       leaves the appender to work with even when an earlier link rewrote every message (each link
 *       is tracked separately, so redact-then-append is fully covered).
 *   E3. …the same message BY SHAPE, likewise from the END and bounded below by the start. Covers a
 *       chain that rebuilds objects without changing their content.
 *
 * Searched from the END (and never below `start`) for the same reason the boundary's shape signals
 * are: a message repeated earlier in the thread must not win over the live one, and the turn's last
 * message can never sit inside the history.
 *
 * THE COUNT IS A VETO, NEVER A LOCATOR. `span.end - span.start` is how many messages the caller
 * actually contributed — a NUMBER, so using it leaks nothing (unlike the pre-chain messages
 * themselves, which are the unmasked originals and are never read back). It is used ONLY to REFUSE
 * evidence: a narrowed span may never come out SHORTER than the caller's own message count. That
 * kills the one counter-example the identity signal has — a processor that REORDERS the turn (moving
 * a trailing `system` row to the front, say) leaves the caller's "last" message somewhere in the
 * middle, and cutting there would drop genuine caller content. Refusing is safe: the fallback is the
 * old behavior (the turn runs to the end of the array), which over-persists rather than losing anything.
 *
 * REJECTED — using the count as a LOCATOR (`next.slice(0, callerCount)`, "the turn is however many
 * messages the caller sent, counted from the boundary"). Measured counter-example: a processor that
 * inserts a row BETWEEN two messages of a two-message turn. The head-clamp then keeps
 * `[msg1, note]` and DROPS `msg2` — caller content silently replaced by processor output, which is
 * the exact failure class the boundary work removed. Its tail-anchored twin (`next.slice(-count)`)
 * fails symmetrically on an insertion in FRONT of the turn. Counter-examples in both directions, so
 * it is not a rule; as a veto the same number has no counter-example at all.
 *
 * REJECTED — the role heuristic ("a `system` row after a user turn cannot be the user's"). It is a
 * rule about shapes, not evidence about this turn: a caller may legitimately send a trailing
 * per-turn `system` instruction, and an assistant prefill is an ordinary trailing message too.
 * Dropping either would lose caller content in exchange for a case E2 already covers.
 *
 * RESIDUAL, unfixed and measured: when ONE processor both REWRITES every message and appends behind
 * the turn, identity is gone and the shape changed, so nothing locates the turn's last message. What
 * follows from that depends on whether the thread has history, and the two outcomes are NOT the same:
 *
 *   FIRST TURN (empty thread) — the boundary is 0 by signal 4, the end ladder finds nothing and falls
 *   back to the array end, so the note IS persisted with the turn: `["«ilk soru»", "[note]"]`. Linear,
 *   one row per turn, and now stamped `chainInserted: 1` so a reader can tell whose row it is.
 *
 *   THREAD WITH HISTORY — the same processor destroys the boundary's evidence too, not just the end's,
 *   so the turn is not written AT ALL. Measured on turn 2 of such a thread: `boundary-lost`,
 *   `incomingCount: 0`, one `console.warn`, thread `["«ilk soru»","[note 1]","bir","iki"]` — an answer
 *   whose question is missing, reported rather than silent. (With a note whose text repeats every turn
 *   the earlier stored copy matches by shape and it comes out `turn-dropped` instead; same outcome,
 *   different reason.) An older version of this paragraph claimed the first-turn behavior for both
 *   cases, which is what the history case looks like from the boundary's side only.
 *
 * The evidence is genuinely destroyed in that shape; splitting the same work across two processors
 * (redact, then append) is fully tracked, and is the fix to recommend to anyone who hits it.
 */
function trackTurnEnd(before: any[], after: any[], span: IncomingSpan, start: number): number {
  if (after.length === before.length && before.every((m, i) => m?.role === after[i]?.role)) {
    return Math.min(span.end, after.length); // E1
  }
  const lastIncoming = before[span.end - 1];
  if (lastIncoming === undefined) return after.length;
  let at = lastIndexByIdentity(after, lastIncoming, start); // E2
  if (at < 0) at = lastIndexByShape(after, JSON.stringify(lastIncoming), start); // E3
  if (at < 0) return after.length;
  // VETO: the span may not shrink below the number of messages the caller contributed.
  return at + 1 - start < span.end - span.start ? after.length : at + 1;
}

/**
 * The turn's span BEFORE the chain runs: it starts where the loaded history ends and runs to the end
 * of the array (prepareMemoryContext concatenated `[...history, ...incoming]`), so its width is
 * exactly how many messages the caller contributed — the number trackTurnEnd vetoes with.
 */
function incomingSpan(rest: PreparedInput, historyCount: number): IncomingSpan {
  return { start: historyCount, end: Array.isArray(rest.messages) ? rest.messages.length : historyCount };
}

/**
 * Carries the whole turn span across one processor: the boundary ladder, then the end ladder, then
 * the WIDTH VETO that guards both ends at once.
 *
 * WHY THE VETO IS NEEDED ON THIS SIDE TOO. trackTurnEnd already refuses evidence that would pull the
 * turn's END back past the caller's own message count — but only the end. Nothing stopped the START
 * from moving FORWARD, and a span narrowed from the left loses caller content just as thoroughly.
 * Measured with the very processor this file already pins as the reorder counter-example
 * (`instruction-before-question`, which moves a trailing per-turn `system` row ahead of the final
 * user message), on a TWO-message turn instead of three:
 *   3-message turn: everything stored ✓ (the pinned test)
 *   2-message turn: "kısa cevapla" in memory? FALSE — `:memctx {incomingCount: 1}`, warnings: 0.
 * Signal 2 located the caller's FIRST message at index 3 (the swap put it last), so the start jumped
 * the caller's other row onto the HISTORY side and it was silently dropped. The end veto could not
 * see it: from a start of 3 the span [3,4) is a full one message wide.
 *
 * THE VETO, stated once for both ends: a LOCATED, NON-EMPTY span may never come out narrower than the
 * number of messages the caller contributed — UNLESS the shortfall is accounted for. An EMPTY span is
 * exempt on purpose — `end === start` is not a narrowed turn, it is the chain having removed the turn
 * outright, which reconcileProcessedIncoming reports as `turn-dropped` rather than papering over.
 *
 * "UNLESS ACCOUNTED FOR" IS THE CORRECTION, and it is the difference between refusing a bad cut and
 * refusing a good one. The count on its own cannot tell a span that LOST caller rows from a turn the
 * chain legitimately made SHORTER, and shortening is what the ordinary processor does. Four
 * realistic ones, all measured coming out `boundary-lost` with `incomingCount: 0` and the question
 * written nowhere while the model had answered it:
 *
 *   a summarizer merging three question rows into one (3→1), on a thread with history AND on a
 *   first turn; a normalizer hoisting a trailing per-turn `system` row into the `system` FIELD (2→1);
 *   a filter dropping a blank row (2→1); and the SHIPPED tokenLimiter under a budget tight enough to
 *   trim inside the turn (`maxInputTokens: 20` → `modelRows=1 QUESTION_STORED=false`).
 *
 * In every one of them `start` and `end` had been located correctly and the veto threw them away.
 * What separates those from the reorder case below is EVIDENCE, not arithmetic: a caller row that
 * SURVIVED the chain and now sits OUTSIDE the located span is proof the split lost content; a caller
 * row that is simply gone (merged, hoisted, filtered, trimmed) proves nothing, and refusing on its
 * account destroys a turn the chain took care to preserve. Identity is the primary witness; a SHAPE
 * counts only when EVERY copy of it lies outside the span, so a row that also appears inside can
 * never trigger the refusal.
 *
 * WHAT REFUSING FALLS BACK TO. When the count is unchanged, the pre-chain indices are still the only
 * positional statement available and `[span.start, after.length)` is exactly the whole-tail behavior
 * that predates the end ladder: it over-persists (the reordered rows ride along, in the chain's order)
 * rather than losing any of them, which is the same trade trackTurnEnd's veto already makes. When the
 * count CHANGED, that fallback is meaningless — a stale index into an array of a different length —
 * so the boundary is REPORTED LOST instead of guessed.
 *
 * AND THE FALLBACK ITSELF IS CHECKED, for the one thing "over-persist rather than lose" must never
 * mean: persisting the THREAD'S OWN HISTORY back into the thread. `[span.start, after.length)` is
 * only the turn's tail if the chain left the history where it was; a normalizer that hoists a
 * per-turn `system` row to the FRONT of the array (ahead of the loaded history, rather than into the
 * `system` field) shifts everything, and the range then opens on a history row. Measured: the caller's
 * hoisted row dropped, a history message re-persisted as part of turn 2, `incomingCount` reporting
 * success. So the fallback is taken only when no loaded-history message SURVIVES INSIDE it, by
 * identity; otherwise the boundary is reported lost, which is this file's standing preference over a
 * quiet wrong-content write.
 */
/**
 * Did a message the CALLER sent survive the chain and land outside the located `[start, end)`? The
 * only shape in which a narrowed span provably loses caller content — see trackIncomingSpan.
 */
function callerRowOutsideSpan(before: any[], after: any[], span: IncomingSpan, start: number, end: number): boolean {
  for (let i = span.start; i < span.end; i++) {
    const row = before[i];
    if (row === undefined) continue;
    const at = after.indexOf(row);
    if (at >= 0) {
      if (at < start || at >= end) return true;
      continue;
    }
    const want = JSON.stringify(row);
    let seen = false;
    for (let k = 0; k < after.length; k++) {
      if (JSON.stringify(after[k]) !== want) continue;
      if (k >= start && k < end) { seen = false; break; } // a copy INSIDE the span: no evidence of loss
      seen = true;
    }
    if (seen) return true;
  }
  return false;
}

function trackIncomingSpan(before: any[], after: any[], span: IncomingSpan): IncomingSpan {
  const start = trackIncomingBoundary(before, after, span);
  if (start < 0) return { start, end: start }; // lost — stays lost for the rest of the chain
  const end = trackTurnEnd(before, after, span, start);
  const width = span.end - span.start; // how many messages the caller contributed — a veto, never a locator
  if (end === start || end - start >= width) return { start, end };
  // NARROWED — accept it unless a surviving caller row is visibly on the wrong side of the split.
  if (!callerRowOutsideSpan(before, after, span, start, end)) return { start, end };
  if (after.length === before.length && after.length - span.start >= width && !historyInside(before, after, span)) {
    return { start: span.start, end: after.length };
  }
  return { start: BOUNDARY_LOST, end: BOUNDARY_LOST };
}

/** Does a loaded-history message survive INSIDE the whole-tail fallback `[span.start, after.length)`? */
function historyInside(before: any[], after: any[], span: IncomingSpan): boolean {
  for (let j = 0; j < span.start; j++) {
    if (before[j] === undefined) continue; // never let a hole match a hole
    if (after.indexOf(before[j]) >= span.start) return true;
  }
  return false;
}

/**
 * The input is already frozen, so the chain does not run again — therefore `rest` must become the
 * FROZEN input rather than staying the caller's raw one.
 *
 * THE BUG THIS CLOSES, and it is the worst one this file has had. Skipping the chain was always
 * correct (running a processor twice is what `:input` exists to prevent); what was missing is that
 * `rest` had just been REBUILT from the caller's arguments — `prepareMemoryContext` concatenated
 * `[...loaded history, ...raw incoming]` moments earlier — so on any same-runId re-entry with an
 * input-processor chain the run proceeded on UNPROCESSED messages. Not a memory-only leak: that array
 * is what the model is called with. Measured with the shipped `piiRedactor` shape, attempt 1 dying at
 * the provider and attempt 2 retrying the same runId:
 *   attempt 2 prompt: [{"content":"SORU [MASKED_EMAIL]"},{"content":"SORU gizli@ornek.com"}]
 * — the masked copy from the thread AND the raw address, sent to the provider, on a run whose journal,
 * whose `:input` and whose caller-visible result were all correctly masked. With the write-ahead not
 * yet landed (the run died in the window between `persistInput` and `writeAheadIncoming`) the raw copy
 * reached thread MEMORY as well: `RAW PII IN MEMORY? true · MODEL SAW RAW? true`. `resumeRun` was
 * never affected — it reads the masked `:input` back out of the journal and passes THAT in, which is
 * precisely what this function now does for the direct-call path.
 *
 * LOCATING THE TURN INSIDE THE FROZEN ARRAY. The evidence ladders cannot help: they carry a boundary
 * across ONE transform, and here the transform (the whole chain, on a possibly different history) ran
 * in another process, another day. `:memctx` is the record of exactly that — written next to `:input`,
 * first-attempt-wins for the same reason, and defined as "`incomingCount` trailing rows of the frozen
 * input are this turn, `chainAppended` of them are the chain's". That is a promise the frozen input
 * already makes to regression.ts's `stripMemoryContext`; reading it here is using it, not extending it.
 *
 * When it is absent or already says the turn was unrecoverable, the honest answer is BOUNDARY_LOST —
 * stamped and warned by reportIncomingLoss — and NOT the caller's raw array. That window is narrow by
 * construction (`persistInput` then `persistMemoryContext`, back to back), and deliberately not closed
 * by writing `:memctx` first: `:memctx` would then be able to outlive an `:input` that never landed,
 * and describe a memory context the frozen input does not have.
 *
 * THE FROZEN INPUT BELONGS TO ONE THREAD, and that has to be checked rather than assumed — this
 * function hands the model a whole conversation, so getting it wrong is a cross-conversation leak
 * and not a bookkeeping error. Measured with one runId reused across two threads (same worker, same
 * journal, different `threadId`):
 *   model saw thread A's private history : LEAK      thread B's own question : stored NOWHERE
 *   thread B: [{"role":"assistant","content":"c"}]   — an answer, no question
 * `persistInput` has frozen `threadId` all along and `MemoryContextRecord` carries its own, so the
 * check costs one comparison each. The collision is REFUSED rather than worked around (see
 * applyInputProcessors), because there is no version of it this engine can serve: not adopting was
 * measured too, and it merely trades the leak for the second half of the same failure — the
 * write-ahead marker `mem-user-appended:<runId>` was already claimed by the first thread, so thread B
 * got its answer appended and its question dropped, which is exactly the shape this whole file exists
 * to prevent.
 *
 * A MISSING `threadId` on EITHER side is not a mismatch. A run frozen without memory has no thread to
 * conflict with (its `prompt`/`messages` are the caller's own), and a retry that simply has no memory
 * attached this time is still the same run of the same conversation — both adopt as before.
 */
async function adoptFrozenInput(
  journal: Journal,
  runId: string,
  frozen: FrozenInput,
  threadId: string | undefined,
  rest: PreparedInput,
  span?: IncomingSpan,
): Promise<IncomingSpan | undefined> {
  rest.system = frozen.system as PreparedInput['system'];
  rest.messages = frozen.messages as PreparedInput['messages'];
  rest.prompt = frozen.prompt as PreparedInput['prompt'];
  if (span === undefined) return undefined; // no memory, or this turn is already stored → nothing to locate
  const rec = await journal.get<MemoryContextRecord>(runKeys.memoryContext(runId));
  // Same identity rule one layer down: a record describing another thread cannot locate this turn.
  // `:input`'s own check (see applyInputProcessors) already covers the common case; this covers a
  // `:memctx` that is stale or miskeyed on its own, where believing `incomingCount` would slice
  // HISTORY rows in as the caller's turn.
  if (rec !== undefined && rec.threadId !== threadId) return { start: BOUNDARY_LOST, end: BOUNDARY_LOST };
  if (!Array.isArray(rest.messages)) {
    // No `messages` array in the frozen input. With a `:memctx` present the attempt that froze it had
    // memory and a chain flattened the turn into `prompt`, which reconcileProcessedIncoming reports as
    // `messages-dropped` exactly as that attempt did. WITHOUT one, the frozen attempt simply ran with
    // no memory attached — and then `prompt` IS the turn, whole and POST-chain (masked), because that
    // is the very thing prepareMemoryContext turns into `[{role:'user', content: prompt}]`. Reporting
    // a loss there stored an answer with no question while a usable copy sat in the frozen input.
    return rec === undefined && rest.prompt != null ? { start: PROMPT_IS_TURN, end: PROMPT_IS_TURN } : span;
  }
  const len = rest.messages.length;
  const count = rec && !rec.incomingUnrecoverable ? rec.incomingCount : 0;
  const appended = rec?.chainAppended ?? 0;
  if (!(count > appended) || count > len) return { start: BOUNDARY_LOST, end: BOUNDARY_LOST };
  return { start: len - count, end: len - appended };
}

/**
 * A runId owns one conversation: refuse a runId re-used for a DIFFERENT thread than the one its
 * frozen `:input` was written for. Called BEFORE `runStarted`/`resolveApprovals` — deliberately, and
 * not merely for tidiness:
 *
 *   - runStarted writes a WRITE-AHEAD 'running' outcome, which recordRunOutcome then treats as the
 *     current verdict; if the mismatch were caught only afterward (as it used to be, inside
 *     applyInputProcessors — AFTER both writes), the throw reaches runDurable's outer catch, which
 *     stamps 'failed' with `Date.now()` — a STRICTLY NEWER timestamp than whatever the runId's PRIOR,
 *     correctly-scoped attempt recorded. Measured: a runId that had already completed successfully
 *     read 'failed' after a later mismatched call, because recordRunOutcome is monotonic-by-time, not
 *     "don't touch a terminal verdict" — the mismatch is the caller's mistake and must leave the run's
 *     own history alone.
 *
 *     Moving the check here does NOT by itself close that, and an earlier draft of this comment
 *     claimed it did, calling outcome.ts's classification a second belt. Measured by reverting ONE
 *     line at a time: with `RunThreadMismatchError` removed from outcome.ts's NOT_A_RUN_FAILURE and
 *     this ordering left intact, the completed run reads 'failed' again. The throw still reaches the
 *     outer catch — being early only means nothing was written BEFORE it, not that nothing is written
 *     after. So the classification is the load-bearing half for the verdict; this ordering is what
 *     keeps `approvals` (below) out of the journal. Two fixes for two defects, not one with a spare.
 *   - resolveApprovals claims every `approvals[toolCallId]` into the journal — checking the mismatch
 *     first means a rejected call's approvals parameter is never written at all, instead of being
 *     journaled as a decision for a call that was refused before any tool of this attempt ran.
 *
 * `frozen` is the SAME `:input` read the caller needs for persistInput/applyInputProcessors right
 * after — one journal read, shared.
 */
function assertThreadOwnership(frozen: FrozenInput | undefined, runId: string, threadId: string | undefined): void {
  if (frozen?.threadId !== undefined && threadId !== undefined && frozen.threadId !== threadId) {
    throw new RunThreadMismatchError(
      `@gnldev/durable: runId "${runId}" was started for thread "${frozen.threadId}" and is now being run ` +
        `for thread "${threadId}". A runId owns one conversation: its recorded input, its model steps and ` +
        `its memory-append markers all belong to the first thread, so this run can neither adopt that input ` +
        `(it would send the other thread's history to the model) nor write this turn (the append was already ` +
        `claimed). Give each turn its own runId.`,
      { runId, startedForThread: frozen.threadId, requestedThread: threadId },
    );
  }
}

/**
 * 8.7 Input processors: BEFORE persistInput, only if the input hasn't been journaled yet.
 * → the transformed input gets journaled; on resume this block is skipped → the processor does NOT run again.
 *
 * `span` (memory path only) is where this turn's new messages sit inside `rest.messages` — `start` is
 * the end of the loaded thread history, `end` is one past the turn's last message; the tracked value
 * is returned so the caller can recover the masked/transformed incoming block. `undefined` = nothing
 * to track (no memory, or the turn's incoming was already stored) → zero extra work and byte-for-byte
 * the old behavior.
 *
 * `frozen` is read ONCE by the caller and passed down, because persistInput needs the same answer and
 * because the ADOPTION is not conditional on there being a chain (see below) — one journal read on a
 * path that previously did two. The runId/thread OWNERSHIP check itself no longer lives here — see
 * `assertThreadOwnership`, called by the caller before this function (before runStarted/resolveApprovals
 * too) — so by the time `frozen` reaches this function a mismatch is already impossible.
 *
 * ADOPTION IS INDEPENDENT OF THE CHAIN. `:input` exists → the run has an input, and it is the one to
 * use, whether or not THIS process happens to be configured with processors. Measured with attempt 1
 * on a worker that had `piiRedactor` and attempt 2 on one that did not, same runId:
 *   model saw: [user "soru [MASKED_EMAIL]", user "soru gizli@ornek.com"]  ← RAW PII to the provider
 * — the masked copy loaded from the thread AND the caller's raw arguments, because the adoption lived
 * behind the `procCtx` gate. A worker's local processor configuration is not what decides what a
 * frozen run is allowed to send.
 */
async function applyInputProcessors(
  processors: Processor[],
  procCtx: ProcessorCtx | undefined,
  journal: Journal,
  runId: string,
  frozen: FrozenInput | undefined,
  threadId: string | undefined,
  rest: PreparedInput,
  span?: IncomingSpan,
): Promise<IncomingSpan | undefined> {
  if (frozen !== undefined) {
    return adoptFrozenInput(journal, runId, frozen, threadId, rest, span);
  }
  if (procCtx === undefined) return span; // nothing frozen to adopt and no chain to run
  let pin: ProcessorInput = { system: systemText(rest.system) || undefined, messages: rest.messages, prompt: rest.prompt };
  let tracked = span;
  for (const p of processors) {
    if (!p.processInput) continue;
    const before = pin.messages;
    pin = await p.processInput(pin, procCtx);
    if (tracked !== undefined && Array.isArray(before) && Array.isArray(pin.messages)) {
      tracked = trackIncomingSpan(before, pin.messages, tracked);
    }
  }
  rest.system = pin.system;
  rest.messages = pin.messages;
  rest.prompt = pin.prompt;
  return tracked;
}

/**
 * Re-read this turn's new messages out of the context the model will ACTUALLY see, after the input
 * processors ran — the memory half of the redaction fix (see trackIncomingBoundary for the leak).
 *
 * Also re-runs the write-ahead tail-dedupe on the POST-processor shapes, and that half is not
 * optional: once memory stores the MASKED question, `historyEndsWithIncoming`'s comparison of loaded
 * history against a RAW incoming can never match again, so the playground's fresh-runId retry of the
 * same text would store the question twice. Deduping on the shapes that are actually persisted keeps
 * that guarantee intact (pinned in processor-memory-redaction.test.ts).
 *
 * Only called when input processors exist AND the incoming was not already stored: with no processors
 * the slice is the very array prepareMemoryContext concatenated, so skipping it keeps that path
 * untouched rather than merely equivalent.
 *
 * `loadedHistory` is what MEMORY returned this turn — the second half of the dedupe's evidence, and
 * the reason the dedupe cannot be run against the post-chain array alone (see the branch below).
 */
function reconcileProcessedIncoming(
  rest: PreparedInput,
  span: IncomingSpan,
  incoming: any[],
  loadedHistory: any[],
): { incoming: any[]; trailing: number; alreadyStored: boolean; lost?: IncomingLossReason; dedupedByShape?: true; chainAppended?: number; chainInserted?: number } {
  if (incoming.length === 0) return { incoming, trailing: 0, alreadyStored: false }; // nothing was contributed this turn
  const msgs = rest.messages;
  // The chain took `messages` out of the array shape: it flattened this turn into `prompt`, or it
  // returned a PARTIAL ProcessorInput (all three fields are optional, so this is a legal processor).
  // There is then no post-chain copy of the turn at all — and returning the PRE-chain `incoming` here
  // is precisely the leak this function exists to close. Measured before this branch existed: raw PII
  // in thread memory while the journal, the prompt and the caller's result were all masked.
  if (!Array.isArray(msgs)) {
    // …unless the frozen input's `prompt` IS the turn (adoptFrozenInput's PROMPT_IS_TURN): a run
    // frozen without memory, re-entered with memory attached. `prompt` is post-chain (masked) and is
    // a whole turn by construction — the same `[{role:'user', content: prompt}]` prepareMemoryContext
    // builds — so it is stored rather than reported lost.
    if (span.start === PROMPT_IS_TURN) {
      return { incoming: [{ role: 'user', content: rest.prompt }], trailing: 1, alreadyStored: false };
    }
    return { incoming: [], trailing: 0, alreadyStored: false, lost: 'messages-dropped' };
  }
  // Nothing recognizable survived the chain (see trackIncomingBoundary): same rule, for the same
  // reason. ANY negative start, not just BOUNDARY_LOST: PROMPT_IS_TURN is handled above and cannot
  // reach here with an array, and a sentinel that slipped through would otherwise be clamped to 0 and
  // persist the whole loaded history as the turn — the worst answer available.
  if (span.start < 0) return { incoming: [], trailing: 0, alreadyStored: false, lost: 'boundary-lost' };
  const at = Math.min(Math.max(span.start, 0), msgs.length);
  // `end` bounds the turn on the right: rows BEHIND it were located as chain product (see
  // trackTurnEnd) and are shown to the model but never persisted as the user's turn. Absent
  // evidence it is `msgs.length`, i.e. exactly the old "the turn runs to the end" behavior.
  const endAt = Math.min(Math.max(span.end, at), msgs.length);
  const history = msgs.slice(0, at);
  const next = msgs.slice(at, endAt);
  // `trailing` is measured against the FROZEN INPUT (everything after the history boundary,
  // chain-appended rows included) because that is what `:memctx.incomingCount` promises and what
  // regression.ts's `stripMemoryContext` slices off the frozen input — see MemoryContextRecord.
  const trailing = msgs.length - at;
  const chainAppended = msgs.length - endAt;
  // Rows INSIDE the persisted turn that the caller did not send — a just-in-time hint dropped between
  // two of its messages, or the appended note of a chain whose own rewrite destroyed the evidence
  // trackTurnEnd needs (the residual documented there). Both were already being written into the
  // thread; what was missing is that `:memctx` said nothing about it, so an operator reading a
  // months-old thread could not tell the caller's rows from the chain's. A COUNT, like `chainAppended`
  // and for the same reason: it audits, it never locates.
  const chainInserted = next.length - incoming.length;
  const marks = { ...(chainAppended ? { chainAppended } : {}), ...(chainInserted > 0 ? { chainInserted } : {}) };
  // The chain dropped this turn outright (a trim that could not protect it): there is nothing new to
  // persist. Writing the pre-chain copy instead is exactly the leak.
  if (next.length === 0) return { incoming: next, trailing, alreadyStored: false, lost: 'turn-dropped' };
  // THE DEDUPE NEEDS TWO WITNESSES, not one. `history` here is only "whatever sits before the span in
  // the POST-chain array", which a processor is free to have written itself — so on its own it cannot
  // establish that memory ALREADY HOLDS this turn, which is the entire premise of dropping it.
  // Measured with a chain that rebuilds every object and RESTATES the turn's last message at the end
  // (the "repeat the request last" prompt pattern, in its shape-only form): the boundary landed on the
  // restated copy, the row in front of it was the chain's own first copy, `historyEndsWithIncoming`
  // matched THAT, and the turn was dropped as a retry — thread: ["ilk soru","ilk soru","bir","iki"],
  // i.e. turn 2 answered and its question nowhere, stamped `incomingDedupedByShape: true` which reads
  // as "duplicate", not as "lost". Requiring the LOADED history to end with it as well is the missing
  // witness: it is the only array here that memory actually returned. A false negative costs a
  // duplicate row (historyEndsWithIncoming's own documented safe side); a false positive costs the
  // question.
  if (historyEndsWithIncoming(history, next) && historyEndsWithIncoming(loadedHistory, next)) {
    // RESIDUAL, recorded rather than hidden (`incomingDedupedByShape`): the comparison necessarily
    // runs on the MASKED shapes, so two genuinely different raw questions that redact to the same
    // string are indistinguishable here and the second one is dropped as a retry. Nothing in reach
    // can tell them apart — memory holds only the masked copy, and the earlier attempt's raw text was
    // deliberately never persisted; the model likewise sees one identical string either way, so what
    // is lost is the turn COUNT, not content. Deduping the other way (raw shapes) cannot work at all
    // once memory stores masked text, and NOT deduping brings back the duplicated question the
    // playground's fresh-runId retry produces.
    // Chain-appended rows ride along on the drop: they are regenerated by the same chain next turn
    // (the argument the boundary's insertion case already rests on), so keeping them would show the
    // note twice — the compounding this whole path exists to stop.
    rest.messages = history; // stored copy IS this turn → drop the re-concat (same rule as prepareMemoryContext)
    // `trailing` is re-measured HERE, against the array that was just truncated, and not reused from
    // above: `:memctx.incomingCount` is a promise about the FROZEN INPUT, and the frozen input on this
    // branch is `history` — the chain-appended rows went out with the re-concat. Measured with
    // redact + a policy-note appender on a deduped retry: the stale count was 2 against a 3-row frozen
    // input, so regression.ts's `stripMemoryContext` sliced [assistant "bir", the question] and
    // replayed a message from an EARLIER TURN as part of this one — the exact thing it exists to
    // refuse. On this branch the stored copy IS the tail of `history` (that is what was just proven
    // twice over), so the turn is its last `next.length` rows and nothing else.
    return { incoming: next, trailing: next.length, alreadyStored: true, dedupedByShape: true, ...(chainInserted > 0 ? { chainInserted } : {}) };
  }
  return { incoming: next, trailing, alreadyStored: false, ...marks };
}

/**
 * The three ways an input-processor chain can leave a turn with NO post-chain copy to persist. All
 * three used to be SILENT, and two of them (`messages-dropped`, `boundary-lost`) used to persist the
 * RAW pre-chain messages instead — the leak. They now persist nothing, which is the only safe answer,
 * and say so: a durability engine storing an answer whose question is missing has to be visible.
 *
 * Reported twice on purpose. `console.warn` is what a developer wiring up a new processor sees
 * immediately; the `:memctx` stamp is what an operator reading a months-old thread sees, and it is
 * also what tells regression.ts's `stripMemoryContext` that this run's frozen input has no isolatable
 * turn (`incomingCount: 0` → it refuses instead of replaying a slice of someone else's history).
 */
function reportIncomingLoss(
  runId: string,
  threadId: string,
  memCtx: MemoryContextRecord | undefined,
  lost: IncomingLossReason,
): void {
  if (memCtx) {
    memCtx.incomingUnrecoverable = lost;
    memCtx.incomingCount = 0;
  }
  console.warn(
    `@gnldev/durable: the input processors left no recoverable copy of this turn (${lost}) — run "${runId}" ` +
      `will store its answer in thread "${threadId}" with NO question. The pre-processor messages are ` +
      `deliberately not used as a fallback (they are unmasked). Keep the new turn in \`messages\` as an array ` +
      `to fix this.`,
  );
}

/** 8.7 Tool processors (toolFilter/toolSearch): restrict the tool set the model sees.
 *  `input` is added to the ctx (toolSearch uses the last user message as a signal); async
 *  Processors are supported — a non-deterministic selection is journaled via ctx.step (resume gets the same subset). */
async function applyToolProcessors(
  processors: Processor[],
  procCtx: ProcessorCtx,
  tools: Record<string, any>,
  input?: PreparedInput,
): Promise<Record<string, any>> {
  // Same reasoning as applyInputProcessors: a tool processor reading `input.system` as a signal
  // wants text, not a union it has to unwrap.
  const ctx: ProcessorCtx = { ...procCtx, input: input && { ...input, system: systemText(input.system) || undefined } };
  let out = tools;
  for (const p of processors) {
    if (p.processTools) out = await p.processTools(out, ctx);
  }
  return out;
}

// Review finding A (see task note): previously claiming the marker with boolean `true`/absent meant
// That when append threw a TRANSIENT error, the marker was left PERMANENTLY 'claimed' — a legitimate
// Retry with the same runId ALWAYS lost the claim, so append was skipped FOREVER (permanent loss of
// Conversation history; the old get→put was at least self-healing). Fix: a two-phase marker —
// `{status:'pending', startedAt}` (append has NOT finished yet, only CLAIMED) → promoted to `true`
// (DONE) once append SUCCEEDS.
const MEM_APPEND_TTL_MS = 60_000; // staleness threshold for a 'pending' record — same order of magnitude as the H7/§5.3 claim TTLs.

type MemAppendMarker = true | { status: 'pending'; startedAt: number };

/**
 * Claim the memory-append marker. Three outcomes:
 * Returns `undefined` → SKIP the append: the marker is `true` (finished) or another worker has a
 * FRESH (< MEM_APPEND_TTL_MS) pending claim (in-flight, no self-heal needed).
 * Returns an object → YOU do the append: either you won a fresh `claim` on an empty key, or you
 *    Took over a STALE pending claim (crash/transient-error self-heal — see task note finding A). When
 *    Done, promote it to `true` with `markMemoryAppendDone(journal, marker, the-returned-object)`.
 * Takeover is atomic if putIfMatch(CAS) is available: even if two workers see the same stale pending
 * Claim, only ONE takes it over. Otherwise falls back to a best-effort put — the SAME narrow window
 * As the old get→put (documented, the core-hardening review).
 */
async function claimMemoryAppend(
  journal: Journal,
  marker: string,
): Promise<{ status: 'pending'; startedAt: number } | undefined> {
  const mine = { status: 'pending' as const, startedAt: Date.now() };
  if (await claim(journal, marker, mine)) return mine; // empty key → won a fresh claim

  const cur = await journal.get<MemAppendMarker>(marker);
  if (cur === true || cur === undefined) return undefined; // finished, or someone else just finished it
  if (Date.now() - cur.startedAt < MEM_APPEND_TTL_MS) return undefined; // FRESH pending → another worker is in-flight

  // STALE pending: the owner likely crashed / threw a transient error → take it over (self-heal).
  const takeover = { status: 'pending' as const, startedAt: Date.now() };
  if (journal.putIfMatch) {
    return (await journal.putIfMatch(marker, cur, takeover)) ? takeover : undefined; // CAS lost → someone else just took it over
  }
  await journal.put(marker, takeover);
  return takeover;
}

/**
 * Promotes the pending record returned by `claimMemoryAppend` to `true` AFTER the append SUCCEEDS.
 * If putIfMatch is available, uses CAS (writes only if the record is still OUR pending claim — if a
 * Takeover happened, it's a no-op, harmless: the new owner will already do/have done its own append).
 * NARROW WINDOW (documented, the SAME window as the old get→put): if append succeeds but a crash
 * Happens BEFORE this call starts, the marker stays 'pending' → the NEXT retry takes it over after
 * The TTL and tries the append ONE MORE TIME (double-append) — the safer side compared to a missing
 * Message (old behavior: lost forever), and the window is very narrow (about the width of one put call).
 *
 * WHAT "THE SAFER SIDE" COSTS, stated plainly, because the sentence above undersells it. The repeated
 * append writes the WHOLE turn again, and the assistant message it carries holds the same
 * `toolCallId` as the first copy. The AI SDK does not object; Anthropic and OpenAI reject a duplicate
 * `tool_use` id, so the thread can end up failing at the provider on every later turn — the same
 * unrecoverable shape as a missing tool result, arrived at from the opposite direction. Safer than
 * silent loss, yes. Harmless, no.
 *
 * This window is not only a crash window. Measured with no process ever dying: a worker holding the
 * per-thread append lock on a connection that vanished without closing (TCP blackhole) parks every
 * other append on that thread; 60 seconds later this marker is stale, a retry takes it over, the lock
 * is finally released, and both writes land. `appendMessages` bounds that wait with `lock_timeout`
 * well under MEM_APPEND_TTL_MS precisely so the queued writer fails instead of outliving the TTL.
 *
 * The real fix is to write this marker in the SAME transaction as the messages, which needs the
 * marker to live beside them rather than in the journal. Deferred deliberately: it moves an
 * established key out of the journal and needs a read-fallback or a backfill for markers already
 * written there, plus cascade deletes in `deleteThread`/`deleteMessagesAfter` and the org adoption
 * key lists. See the durability risk audit.
 */
async function markMemoryAppendDone(
  journal: Journal,
  marker: string,
  pending: { status: 'pending'; startedAt: number },
): Promise<void> {
  if (journal.putIfMatch) {
    await journal.putIfMatch(marker, pending, true);
    return;
  }
  await journal.put(marker, true);
}

/**
 * WRITE-AHEAD user-message append: persist this turn's `incoming` message(s) to memory BEFORE the
 * First model call. The thread ROW was already write-ahead (AgentMemory.loadContext →
 * EnsureThreadIndexed creates it, titled from the first user message, before any token arrives) —
 * But the MESSAGES only landed at completion, so a run that died before its first token left a
 * Titled-but-EMPTY thread: the user's own message was gone from every read surface even though the
 * Journal's `:input` still held it. Appending `incoming` here closes that asymmetry; the
 * Completion-time append (both call sites below) then persists only the PRODUCED messages.
 *
 * Idempotency is two-layered, mirroring the completion marker:
 * `alreadyStored` (prepareMemoryContext's tail-dedupe) — covers retries across DIFFERENT runIds
 *    Re-sending the identical text (the playground mints a fresh runId per attempt).
 * the `memUserAppended` two-phase marker — covers SAME-runId retries racing concurrently, where
 *    The tail check can't see the other worker's in-flight append.
 *
 * DELIBERATELY NOT try/caught: this runs pre-model, so failing the run here is cheap (no tokens
 * Spent) and honest — completing a turn whose user message could not be persisted would produce a
 * Transcript with an answer but no question.
 */
async function writeAheadIncoming(
  journal: Journal,
  memory: Memory,
  threadId: string,
  runId: string,
  incoming: any[],
  alreadyStored: boolean,
  limits: RunLimits | undefined,
): Promise<void> {
  if (alreadyStored || incoming.length === 0) return;
  const wrote = await appendBatchOnce(memory, journal, runId, threadId, runKeys.memUserAppended(runId), incoming);
  // PHASE 3: provenance stamp for the incoming half — the completion append stamps only `produced`.
  if (wrote) await recordAppendedTaintProvenance(journal, runId, threadId, limits, incoming);
}

/**
 * F4 — durability review: a SAME-runId re-entry (resume after suspension, retry) whose
 * Write-ahead already landed, but where OTHER turns were appended to the thread in between — the
 * Tail-dedupe no longer matches (this run's incoming isn't the thread tail anymore), so the prompt
 * Would carry the question twice: once inside the loaded history, once re-concatenated at the end.
 * Memory itself was never at risk (the memUserAppended marker blocks the re-append); this is purely
 * A prompt-fidelity fix. Keyed off the marker being DONE plus an explicit containment check — if
 * Compaction/windowing dropped the stored copy out of the loaded context, the re-concatenated one is
 * KEPT (prompt correctness beats deduplication when the two conflict). Returns the updated
 * `alreadyStored`.
 */
async function dropIncomingIfAppendedEarlier(
  journal: Journal,
  runId: string,
  rest: PreparedInput,
  incoming: any[],
  alreadyStored: boolean,
): Promise<boolean> {
  if (alreadyStored || incoming.length === 0 || !rest.messages) return alreadyStored;
  if ((await journal.get(runKeys.memUserAppended(runId))) !== true) return alreadyStored;
  const history = rest.messages.slice(0, rest.messages.length - incoming.length);
  const needle = incoming.map((m) => JSON.stringify(m));
  outer: for (let i = 0; i + needle.length <= history.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (JSON.stringify(history[i + j]) !== needle[j]) continue outer;
    }
    rest.messages = history; // stored copy is visible in the loaded context → drop the re-concat
    return true;
  }
  return alreadyStored;
}

/**
 * Append a batch at most once, preferring the store's own identity when it has one.
 *
 * Two mechanisms exist and this picks between them. `memory.appendOnce` writes the batch identity in
 * the SAME transaction as the rows, so "appended but not marked" is not a reachable state. The older
 * marker below is two writes to two stores, and the gap between them is real: a process that dies
 * there leaves the marker unset and the retry appends the whole turn again — measured, 25 rows became
 * 50, with the same `toolCallId` twice, which real providers reject.
 *
 * READ THE OLD MARKER FIRST, ALWAYS. This is the migration, and without it the upgrade is a data
 * hazard rather than an improvement: every batch marked in the journal BEFORE the new path existed is
 * invisible to a store that only consults its own table, so any resume or retry of those runs would
 * apply them a second time. The window is not "the deploy" — it is every run still reachable by a
 * retry. One extra journal read on a path that already does several is a small price for not needing
 * a backfill migration at all.
 */
/**
 * The completion append, which has to be two different shapes for two different mechanisms.
 *
 * With per-batch identity the question and the answer are independent batches: each carries its own
 * key, each returns false if it already landed, and the per-thread lock keeps them in order. That is
 * the design F7 wanted, and the stale-claim takeover it used to need disappears with it.
 *
 * Without it, the old shape is preserved EXACTLY — one claim on the answer's marker gating a single
 * merged write. Not for compatibility's sake: the merge is what made the old path safe. Splitting it
 * into two writes there would change when each half lands and how many times `append` is called, and
 * the tests pinning that path are pinning a real guarantee, not an implementation detail.
 */
async function appendCompletion(
  memory: Memory,
  journal: Journal,
  runId: string,
  threadId: string,
  marker: string,
  incoming: any[],
  incomingStored: boolean,
  produced: any[],
  limits: RunLimits | undefined,
): Promise<void> {
  const needIncoming = !incomingStored && incoming.length > 0;
  if (memory.appendOnce) {
    if (needIncoming) {
      const w = await appendBatchOnce(memory, journal, runId, threadId, runKeys.memUserAppended(runId), incoming);
      if (w) await recordAppendedTaintProvenance(journal, runId, threadId, limits, incoming);
    }
    const wrote = await appendBatchOnce(memory, journal, runId, threadId, marker, produced);
    if (wrote) await recordAppendedTaintProvenance(journal, runId, threadId, limits, produced);
    return;
  }
  const pending = await claimMemoryAppend(journal, marker);
  if (!pending) return;
  // F5: a write-ahead skipped over ANOTHER worker's pending claim, since gone stale — take it over so
  // the question rides along with the answer instead of being lost. A still-FRESH claim keeps the
  // safe-side skip; that sub-TTL window is the documented residual of this path.
  const userPending = needIncoming ? await claimMemoryAppend(journal, runKeys.memUserAppended(runId)) : undefined;
  const appended = userPending ? [...incoming, ...produced] : produced;
  await memory.append(threadId, appended);
  await recordAppendedTaintProvenance(journal, runId, threadId, limits, appended);
  if (userPending) await markMemoryAppendDone(journal, runKeys.memUserAppended(runId), userPending);
  await markMemoryAppendDone(journal, marker, pending);
}

async function appendBatchOnce(
  memory: Memory,
  journal: Journal,
  runId: string,
  threadId: string,
  marker: string,
  messages: any[],
): Promise<boolean> {
  if (messages.length === 0) return false;
  if (memory.appendOnce) {
    // Written by the pre-upgrade path for this very batch → it is already in the thread.
    if ((await journal.get(marker)) === true) return false;
    return memory.appendOnce(threadId, messages, marker);
  }
  const pending = await claimMemoryAppend(journal, marker);
  if (!pending) return false;
  await memory.append(threadId, messages);
  await markMemoryAppendDone(journal, marker, pending);
  return true;
}

/**
 * TAINT PHASE 3 (opt-in `taintLifetime: 'content-window'`): after a successful memory append, stamp
 * The appended messages' content hashes into the thread's provenance record IF untrusted content
 * DIRECTLY entered this run (source 'tool'/'processor' — `readDirectRunTaint`; runs that only
 * INHERITED taint are deliberately NOT stamped, see taint.ts directTaintKey). ALL of the run's
 * Appended messages are stamped, not just the untrusted tool result — conservative over-stamping (the
 * Model's same-turn output may quote the poison), safe direction. The SINGLE shared hook for the
 * RunDurable and streamDurable append sites — parity must not be broken. Runs inside the append
 * Marker's `pending` window → written once per run; a crash between append and this write leaves NO
 * Provenance, which the expiry check treats as "cannot prove absence" (keeps taint — fail-safe), and
 * The marker-takeover retry re-appends AND re-stamps. Never throws (recordTaintProvenance discipline).
 */
async function recordAppendedTaintProvenance(
  journal: Journal,
  runId: string,
  threadId: string,
  limits: RunLimits | undefined,
  appended: any[],
): Promise<void> {
  if (limits?.taintScope !== 'thread' || limits.taintLifetime !== 'content-window') return;
  if (!(await readDirectRunTaint(journal, runId))) return;
  await recordTaintProvenance(journal, threadId, appended);
}

/**
 * Shadow the AI SDK result's getter-only fields (text/response) with an own data property.
 * If the own field turns out to be non-configurable (an AI SDK version change), defineProperties
 * Throws → fall back to a prototype-chained copy: returns a shadow copy without touching the original object.
 */
function shadowProps<T extends object>(obj: T, props: Record<string, unknown>): T {
  const descriptors: PropertyDescriptorMap = {};
  for (const [k, v] of Object.entries(props)) {
    descriptors[k] = { value: v, enumerable: true, configurable: true, writable: true };
  }
  try {
    return Object.defineProperties(obj, descriptors);
  } catch {
    return Object.create(obj, descriptors) as T;
  }
}

// D4-retry bounded TURN-level retry-with-feedback ladder for
// RunDurableInner ONLY (see StreamDurableArgs.processors doc / streamDurable body for the honest stream
// Bound — a stream that already flushed to the client cannot be retried, that's a different contract).
// A processor's processOutputStep/processOutput may throw ProcessorRetry to mean "this turn's output is
// Unacceptable — give the model my feedback and try the WHOLE turn again." We do NOT retry a single
// Step inside generateText's own tool loop (we don't own that loop): we catch the throw/rejection,
// Append the feedback as a NEW user message to the SAME options.messages the turn started with (the
// Rejected attempt's own output is deliberately NOT re-shown — a processor just deemed it unacceptable,
// Re-injecting it back into context would undercut the point), and call generateText(options) again.
// `options.model`/`options.tools`/`options.onStepFinish` are built ONCE by the caller and REUSED across
// Attempts on purpose: withDurableModel's step counter lives in that one closure, so the retry's model
// Steps continue from where the prior attempt left off onto FRESH journal keys — no collision (see
// Durable-model.ts). A run with no ProcessorRetry-throwing processor never takes the catch branch below
// → byte-identical to pre-D4-retry behavior, zero new journal keys.
const RETRY_LADDER_GLOBAL_CAP = 3;

function appendRetryFeedback(options: any, feedback: string): void {
  const prior: any[] = Array.isArray(options.messages)
    ? options.messages
    : typeof options.prompt === 'string'
      ? [{ role: 'user', content: options.prompt }]
      : Array.isArray(options.prompt) ? options.prompt : [];
  options.messages = [...prior, { role: 'user', content: [{ type: 'text', text: feedback }] }];
  delete options.prompt;
}

async function runGenerateWithRetryLadder(
  options: any,
  processors: Processor[] | undefined,
  procCtx: ProcessorCtx | undefined,
  journal: Journal,
  runId: string,
  /** Carries an error a per-step hook threw and the SDK swallowed — see composeOnStepFinish. */
  stepHookFailure: StepHookFailure = {},
): Promise<{ result: any; interrupts: Interrupt[]; produced?: any[] }> {
  const usedByProcessor: Record<string, number> = {};
  let attempt = 0;

  const honorRetry = async (err: ProcessorRetry): Promise<void> => {
    const usedForProc = usedByProcessor[err.processor] ?? 0;
    const maxForProc = err.opts?.maxRetries ?? 1;
    if (attempt >= RETRY_LADDER_GLOBAL_CAP || usedForProc >= maxForProc) {
      throw new RetryExhaustedByProcessorError(
        `@gnldev/durable: '${runId}' retry ladder exhausted for processor '${err.processor}' (attempt ` +
          `${attempt}/${RETRY_LADDER_GLOBAL_CAP} global, ${usedForProc}/${maxForProc} for this processor) — last feedback: ${err.feedback}`,
        err.processor, err.feedback,
      );
    }
    // Exactly-once + replay-deterministic (durableProcessorStep's memoize): on resume this returns the
    // SAME feedback from the journal instead of trusting the freshly re-thrown value — a replayed step
    // Re-runs the processor too (see processOutputStep's REPLAY NOTE), but the decision acted on here is
    // The journaled one, not a fresh re-consultation.
    const decision = await durableProcessorStep(journal, runId, `retry:${attempt}`, () => ({
      feedback: err.feedback, processor: err.processor,
    }));
    usedByProcessor[err.processor] = usedForProc + 1;
    attempt++;
    appendRetryFeedback(options, decision.feedback);
  };

  for (;;) {
    let result: any;
    try {
      result = await generateText(options);
    } catch (err) {
      if (err instanceof ProcessorRetry) { await honorRetry(err); continue; }
      throw err;
    }

    // A per-step processor threw and the SDK swallowed it (see composeOnStepFinish). Raise it here,
    // BEFORE the sentinel checks: the hook asked for the run to stop, and it is the caller's own
    // error type — reporting anything else would mislabel a deliberate block.
    if (stepHookFailure.error !== undefined) throw stepHookFailure.error;

    // K1 + A block sentinel OR a tool-step limit stopped the composeStopWhen loop → convert
    // To a real typed error and throw (unrelated to the retry ladder — never retried).
    const finishError = streamFinishError((result as any).steps ?? []);
    if (finishError) throw finishError;

    const interrupts: Interrupt[] = [];
    for (const step of (result as any).steps ?? []) {
      for (const part of step.content ?? []) {
        if (hasSuspend(part)) interrupts.push(part.output.__gnl_suspend);
      }
    }

    // 8.7 Output processors: run ONLY on a completed run (not suspended) — same as before D4-retry,
    // Now with a catch for ProcessorRetry.
    if (procCtx && interrupts.length === 0) {
      let pout: ProcessorOutput = {
        text: (result as any).text,
        messages: producedMessages(result),
        result,
      };
      try {
        for (const p of processors as Processor[]) {
          if (p.processOutput) pout = await p.processOutput(pout, procCtx);
        }
      } catch (err) {
        if (err instanceof ProcessorRetry) { await honorRetry(err); continue; }
        throw err;
      }
      // Result.text/response may be getter-only → shadow with an own data property (assign would blow up).
      result = shadowProps(result, {
        text: pout.text,
        response: { ...(result as any).response, messages: pout.messages },
      });
      // …and hand the processed messages back EXPLICITLY, because the shadow above cannot carry them
      // to the memory append. `producedMessages` reads `result.steps[].response.messages` FIRST (AI SDK
      // 7 narrowed `response.messages` to the final step, so tool-call/tool-result rows only exist on
      // the steps), and steps are not shadowed — a flat processed list cannot be redistributed back
      // across them. So re-deriving the messages at the append site silently re-read the UNPROCESSED
      // ones: masked reply to the caller, RAW reply in thread memory (measured). The stream path
      // already carries `pout.messages` forward this way; this makes the two paths agree.
      // KNOWN RESIDUAL, stated rather than hidden: `result.steps` still holds the model's raw output,
      // and so does `result.content` (measured — only `text` and `response` are shadowed above).
      // Nothing PERSISTED reads either one, so this is a caller-visible residual, not a storage leak.
      //
      // It is not an oversight, and it is NOT closable without changing what a processor is. The hook
      // is `processOutput({text, messages}) -> {text, messages}`, called ONCE with the whole turn, and
      // its output arity is unconstrained: a redactor returns N messages for N, a summariser returns
      // one, a filter returns zero (all three are legal and all three exist in the test suite). So
      // there is no total function mapping the returned list back onto `steps[i].response.messages`,
      // and `content`/`steps[].content` are a different structure again — tool-call, tool-result,
      // reasoning, file and source parts that a message-level transform never describes.
      // The two escapes both fail on measurement rather than on taste:
      //   · Distribute by index when the arity happens to match — works for a pure character-wise
      //     redactor, silently does nothing for a summariser. That is a masking ILLUSION, which is
      //     worse than a documented raw field: the caller stops checking.
      //   · Call the hook once per step instead of once per turn — changes the input the hook is
      //     contracted to see, and `ctx.step` memoises on `${runId}:proc:${name}` with NO step
      //     segment (journal.ts runKeys.proc), so every step after the first would silently replay
      //     step 0's decision. A journalled moderation/LLM-judge processor would return the wrong
      //     verdict, not merely an unmasked one.
      // Closing this properly needs a hook that owns step/content records — a processor-contract
      // change, not a patch here. Until then the honest statement belongs where the user reads it:
      // the processor's own docs (@gnldev/processors piiRedactor).
      return { result, interrupts, produced: pout.messages };
    }

    return { result, interrupts };
  }
}

/**
 * Drop-in `generateText`: runs the model + tools through durable wrappers.
 * `resume` = call again with the same `runId` + `journal` (+ `approvals`) → replay from the journal.
 */
export async function runDurable(args: RunDurableArgs): Promise<DurableResult> {
  // The failure half of the run's outcome record. The success half is written at the completion choke
  // Point inside runDurableInner, where "did it actually finish" is already established (a suspended
  // Run returns normally with interrupts and must NOT be recorded as completed).
  try {
    return await runDurableGuarded(args);
  } catch (err) {
    const kind = classifyRunError(err);
    if (kind === 'failure') await runFailed(args.journal, args.runId, err, Date.now());
    // Fenced out MID-FLIGHT: this worker got in and lost to a concurrent executor. Fill-only, so the
    // survivor's verdict — earlier or later — always stands; recording nothing left the run reading
    // 'completed' while it was neither.
    else if (kind === 'contended') await runFailedIfUnrecorded(args.journal, args.runId, err, Date.now());
    throw err;
  }
}

async function runDurableGuarded(args: RunDurableArgs): Promise<DurableResult> {
  // A COMPENSATED (unwound) run refuses to run/resume — replaying memoized successes
  // On top of an already-reverted world would silently "complete" a transaction that was undone.
  await assertNotCompensated(args.journal, args.runId);
  // P2-cancel: same terminal-refusal contract as compensation — a durably-canceled run never
  // (re)starts or resumes (the per-step mid-flight gate lives in durable-model.ts).
  await assertNotCanceled(args.journal, args.runId);
  const lock = (args as any).lock;
  if (lock) {
    const handle = await acquireRunLock(args.journal, args.runId, lock.owner, lock.ttlMs);
    if (!handle) {
      if ((args as any).conflictLedger) await recordIdemConflict(args.journal, { runId: args.runId, code: 'run_busy', ...((args as any).actor ? { actor: (args as any).actor } : {}) });
      throw Object.assign(new RunBusyError(`run '${args.runId}' is locked by another process`), { atLockAcquisition: true });
    }
    // B4 (heartbeat): the lock was acquired ONCE and never renewed — a run that legitimately outlives
    // `ttlMs` let a second worker take over mid-run (two live runs of the same runId). Renew on a beat
    // Shorter than the TTL (ttlMs/2, min 1ms) so the lock stays held for as long as the body runs.
    // Best-effort: a failed renew is swallowed (the next beat retries; a genuine takeover fences it out).
    // The timer is unref'd (never keeps the process alive) and cleared in `finally`; any in-flight renew
    // Is awaited BEFORE release so a late renew can't revive the just-released lock.
    let inflight: Promise<unknown> = Promise.resolve();
    const beat = Math.max(1, Math.floor(lock.ttlMs / 2));
    const heartbeat = setInterval(() => { inflight = handle.renew(lock.ttlMs).catch(() => false); }, beat);
    (heartbeat as any).unref?.();
    try {
      return await runDurableInner(args);
    } finally {
      clearInterval(heartbeat);
      await inflight;
      await handle.release();
    }
  }
  return runDurableInner(args);
}

async function runDurableInner(args: RunDurableArgs): Promise<DurableResult> {
  const { journal, runId, guard, approvals, memory, threadId, resourceId, agentName, replay, lock: _lock, processors, schemaCompat, limits, exclusiveModelStep, replayCacheMaxBytes, toolPolicy, timeouts, strictInput, conflictLedger, tombstonePolicy, actor, model: modelInput, tools, stopWhen, ...rest } =
    args as RunDurableArgs & Record<string, any>;
  // `ModelInput` is `LanguageModelV4 | string`, and until now only createGnl honoured the string
  // Half: passing 'nvidia/…' straight to runDurable type-checked and then died inside the AI SDK
  // With "model.doGenerate is not a function", which tells a newcomer nothing about what they did
  // Wrong. Resolve it here so the published type is true wherever it appears.
  const model = typeof modelInput === 'string' ? await resolveModel(modelInput) : modelInput;
  // ONE read of `:input`, shared by the ownership check, the adoption and persistInput below (see
  // applyInputProcessors). Read + asserted BEFORE runStarted/resolveApprovals — see
  // assertThreadOwnership's own doc for why the order matters (K2/K3 hardening).
  const frozenInput = await journal.get<FrozenInput>(runKeys.input(runId));
  try {
    assertThreadOwnership(frozenInput, runId, threadId);
  } catch (e) {
    // FAZ-4 ledger: the flagship conflict leaves a trace too (best-effort, PII-free).
    if (conflictLedger && e instanceof RunThreadMismatchError) await recordIdemConflict(journal, { runId, code: 'run_thread_mismatch', ...(actor ? { actor } : {}) });
    throw e;
  }
  // FAZ-4: fingerprint the RAW caller input BEFORE memory prep mutates rest.messages (post-prep
  // Content grows with the thread — hashing it would 409 every legitimate resume).
  const rawInputHash = argsHash({ prompt: rest.prompt, messages: rest.messages, system: rest.system });
  await assertRunAdmissible(journal, runId, frozenInput, rawInputHash, { strictInput, conflictLedger, tombstonePolicy, actor, approvals });
  // WRITE-AHEAD outcome: this attempt has STARTED. A run SIGKILLed anywhere past this line reads
  // 'running' — never 'completed', which is what the absence of any record used to mean. Sits after
  // the lock (the guarded path acquires before calling here), so a caller that never got in never
  // touches the live run's record. Best-effort like every outcome write.
  await runStarted(journal, runId, Date.now());
  // AUDIT (approval first-class): BEFORE ctx is set up — claim the parameter's approvals into the
  // Journal + merge with the journal's existing approvals (see the resolveApprovals header).
  const resolvedApprovals = await resolveApprovals(journal, runId, approvals);
  // C2: on resume, fetch model/tool entries in a single query → hot replay reads take 1 round-trip instead of N.
  // On the first run there are no entries → undefined (no cache). Consume-once: see ctxGet.
  const ctx: DurableCtx = { journal, runId, threadId, guard, approvals: resolvedApprovals, replay, limits, toolPolicy, blockedAsSentinel: true, toolTimeoutMs: timeouts?.toolMs, claimTtlMs: timeouts?.claimTtlMs, toolResultProcessors: processors, replayCache: await loadReplayCache(journal, runId, { maxBytes: replayCacheMaxBytes }) };
  const procCtx = processors?.length ? createProcessorCtx(journal, runId) : undefined;

  // Memory: load thread history (prepend to messages) + inject working memory into the system prompt.
  let incoming: any[] = [];
  let wmTool: Record<string, any> | undefined; // Phase 14: rich memory's updateWorkingMemory tool
  let incomingStored = false; // retry dedupe — see prepareMemoryContext/writeAheadIncoming
  let memCtx: MemoryContextRecord | undefined; // ':memctx' provenance — frozen next to ':input' below
  let historyCount = 0; // where the loaded history ends inside rest.messages — see reconcileProcessedIncoming
  let loadedHistory: any[] = []; // what MEMORY returned this turn — the dedupe's second witness
  if (memory && threadId) {
    ({ incoming, wmTool, alreadyStored: incomingStored, provenance: memCtx, historyCount } = await prepareMemoryContext(memory, threadId, resourceId, rest, makeEchoView(processors, journal, runId)));
    loadedHistory = Array.isArray(rest.messages) ? rest.messages.slice(0, historyCount) : [];
    // F4: same-runId re-entry with interleaved turns — drop the re-concat if the stored copy is visible.
    incomingStored = await dropIncomingIfAppendedEarlier(journal, runId, rest, incoming, incomingStored);
  }

  // REDACTION: what goes to memory must be what the model saw, so the incoming block is re-read from
  // `rest.messages` AFTER the chain ran (see trackIncomingBoundary/reconcileProcessedIncoming).
  const trackIncoming = memory && threadId && !incomingStored ? incomingSpan(rest, historyCount) : undefined;
  // `frozenInput` was already read (and its thread ownership asserted) above, before runStarted.
  const span = procCtx || frozenInput !== undefined
    ? await applyInputProcessors(processors ?? [], procCtx, journal, runId, frozenInput, threadId, rest, trackIncoming)
    : trackIncoming;
  if ((procCtx || frozenInput !== undefined) && span !== undefined) {
    // `span !== undefined` already implies memory && threadId && !incomingStored (see trackIncoming).
    const rec = reconcileProcessedIncoming(rest, span, incoming, loadedHistory);
    incoming = rec.incoming;
    incomingStored = rec.alreadyStored;
    if (rec.lost) reportIncomingLoss(runId, threadId!, memCtx, rec.lost);
    else if (memCtx) {
      memCtx.incomingCount = rec.trailing; // the chain may have changed the count — keep `:memctx` true to `:input`
      if (rec.chainAppended) memCtx.chainAppended = rec.chainAppended;
      if (rec.chainInserted) memCtx.chainInserted = rec.chainInserted;
      if (rec.dedupedByShape) memCtx.incomingDedupedByShape = true;
    }
  }

  await persistInput(journal, runId, rest, frozenInput !== undefined, threadId, agentName, resourceId, rawInputHash, actor);
  await persistMemoryContext(journal, runId, memCtx);
  // Freeze `limits` into the journal on the first run (idempotent via `claim` — the FIRST
  // Run's limits win, a later resume never overwrites them). resumeRun reads this back when the caller
  // Doesn't re-supply `limits`, so a resumed run keeps its cost cap / loop / duplicate / taint gates.
  if (limits) await claim(journal, runKeys.cfgLimits(runId), serializableLimits(limits));
  // WRITE-AHEAD user message (see writeAheadIncoming): journal `:input` first (the WAL), then memory —
  // A run that fails before its first token keeps the user's message visible in the thread.
  if (memory && threadId) await writeAheadIncoming(journal, memory, threadId, runId, incoming, incomingStored, limits);
  // (opt-in `taintScope: 'thread'`): if a prior turn on this thread was tainted, mark THIS
  // Run tainted BEFORE the agent loop — the taint gate then fires for this run's side effects.
  // PHASE 3: `rest.messages` here is the FINAL visible context (memory + processors already applied)
  // exactly what the model sees, which is what content-window expiry must be judged against.
  await inheritThreadTaint(journal, runId, threadId, limits, { messages: rest.messages, memory });

  // Phase 14: also merge in rich memory's updateWorkingMemory tool → durableTools wraps it (journaled).
  let effectiveTools = wmTool ? { ...tools, ...wmTool } : tools;
  if (procCtx && effectiveTools) effectiveTools = await applyToolProcessors(processors!, procCtx, effectiveTools, rest);

  // 8.8 Tool-schema compat (opt-in): provider-specific tool-schema transformation. PURE + BEFORE the model
  // Call + BEFORE durableTools wraps it → doesn't touch the journal, argsHash/toolCallId/replay unaffected.
  // Lazy import: if unused, @gnldev/tool-schema is never loaded (keeps the durable core thin).
  if (schemaCompat && effectiveTools) {
    const { applyToolCompat, defaultRules, detectModel } = await import('@gnldev/tool-schema');
    const rules = schemaCompat === true ? defaultRules : schemaCompat;
    // A fallback chain shapes per CANDIDATE, at the moment one is chosen, rather than once here for
    // whichever model the proxy claims to be. Transforming here for a chain would bake in one
    // provider's rules and hand them to whoever actually answers — and the providers genuinely
    // disagree (OpenAI's strict mode requires `additionalProperties: false`; Gemini rejects the
    // keyword), so no single shape serves them all. See setChainToolShaper.
    if (!setChainToolShaper(model, (toolsJson: any[], candidate: unknown) => shapeJsonTools(toolsJson, candidate, rules as any[], detectModel))) {
      effectiveTools = applyToolCompat(effectiveTools, model, rules);
    }
  }

  const stepHookFailure: StepHookFailure = {};
  const options: any = {
    // AI SDK 7 defaults `allowSystemInMessages` to false and throws AI_InvalidPromptError when a
    // system message appears inside `messages`. Sensible for hand-written calls; wrong here. This
    // engine REPLAYS what happened: thread history loaded from memory, and any journalled message
    // list, is a record. Refusing to send back a system message we ourselves stored turns a faithful
    // replay into a hard failure. `...rest` follows, so a caller can still override this.
    allowSystemInMessages: true,
    ...rest,
    // §5.3 + Y1: exclusiveModelStep/stepTimeoutMs flow into withDurableModel as opt-in (identical to before if not provided).
    model: withDurableModel(model as LanguageModelV4, ctx,
      (exclusiveModelStep || timeouts?.modelStepMs) ? { exclusiveStep: exclusiveModelStep, stepTimeoutMs: timeouts?.modelStepMs } : undefined),
    stopWhen: composeStopWhen(stopWhen, stepHookFailure),
  };
  if (effectiveTools) options.tools = durableTools(effectiveTools, ctx);
  // P2-step: per-step processor hooks (common per-step-processor parity, v1) — bridged to the AI SDK's own per-iteration
  // Callbacks. Only set when a processor implements the hook (undefined = zero behavior change).
  if (procCtx && processors?.length) {
    const prep = composePrepareStep(processors as Processor[], procCtx);
    if (prep) options.prepareStep = prep;
    // The holder is read by the stop condition below: AI SDK 7 swallows a throw from onStepFinish,
    // so a processor that blocks a run only takes effect if WE notice and stop.
    const onStep = composeOnStepFinish(processors as Processor[], procCtx, stepHookFailure);
    if (onStep) options.onStepFinish = onStep;
  }

  // D4-retry: generateText + finishError/suspend handling + the output-processor gate, wrapped in the
  // Bounded retry-with-feedback ladder (see runGenerateWithRetryLadder above for the full contract —
  // Includes the K1/W1 sentinel-to-error conversion and the 8.7 output-processor pass, byte-for-
  // Byte unchanged for a run with no ProcessorRetry-throwing processor).
  const { result: ladderResult, interrupts, produced: processedProduced } = await runGenerateWithRetryLadder(options, processors, procCtx, journal, runId, stepHookFailure);
  let result = ladderResult;

  // Memory: idempotent append on completion (not suspended) — resume/retry does NOT double-write.
  // TWO-PHASE MARKER (review finding A — see claimMemoryAppend/markMemoryAppendDone): if the pending
  // Claim is STALE (crash/transient-error), the NEXT retry SELF-HEALS — with the old boolean-claim,
  // If append threw an error the marker stayed permanently 'claimed' and history was lost FOREVER.
  // DELIBERATELY NOT WRAPPED in try/catch: let the error propagate to the CALLER (runDurable rejects)
  // thanks to the pending marker, a legitimate retry with the SAME runId retries the append (see the
  // Memory self-heal tests).
  if (memory && threadId && interrupts.length === 0) {
    // PRODUCED only — `incoming` was already persisted pre-model by writeAheadIncoming (or was found
    // already stored by the tail-dedupe); re-appending it here would duplicate the turn.
    // F3 note (deliberate): under CONCURRENT turns on one thread, messages land in SEND order and
    // answers in COMPLETION order — the transcript reflects what actually happened, rather than the
    // old atomic-pair append that reordered reality into adjacent Q/A pairs.
    // The claim lives INSIDE appendCompletion now; claiming here as well made the inner one lose and
    // skip the append entirely — measured as 2 stored messages where 4 were expected.
    // The output processors' own messages when they ran (redaction/rewrite must reach the thread —
    // see the note at the end of the ladder), otherwise the SDK's, exactly as before.
    const produced = processedProduced ?? producedMessages(result);
    await appendCompletion(memory, journal, runId, threadId, runKeys.memAppended(runId), incoming, incomingStored, produced, limits);
  }

  // 1.1: IF the run COMPLETED (not suspended), increment the organization usage counter —
  // CheckBudget/getOrgUsage reads this in O(1) (instead of a full-run-scan). Best-effort: if something
  // Goes wrong, it does NOT affect the run.
  if (interrupts.length === 0) {
    try { await recordRunUsage(journal, runId); } catch { /* counter is optional — must not affect the run */ }
    // P1.6b: materialized metrics at the SAME choke point — this covers run()/resume/bare runDurable in
    // One place (the registry-level hook was removed for exactly this reason: single source, and the
    // Stream path below gets the same call in its onFinish). Best-effort like the usage counter; the
    // Claim/applyBatch inside recordRunMetrics makes an accidental double call a no-op.
    try {
      await recordRunMetrics(journal, journal as unknown as JournalReader, runId, agentName ? { agentName } : {});
    } catch { /* advisory aggregate — must not affect the run */ }
    // Overwrites any 'failed' from an earlier attempt: a run that was fixed and resumed to success is
    // Not a failed run. Inside the `interrupts.length === 0` branch, so a suspended run — which returns
    // Normally, awaiting a human — is not mislabelled as finished.
    await runSucceeded(journal, runId, Date.now());
  }

  return Object.assign(result, { interrupts });
}

/** An agent configuration (model/tools/guard) — for resumeRun and studio embed. */
export interface ResumeAgentConfig {
  model: ModelInput;
  tools?: ToolSet;
  guard?: Guard;
  stopWhen?: unknown;
  replay?: 'strict' | 'lenient';
  /**
   * ResumeRun used to FORWARD
   * ONLY model/tools/guard/approvals — a resumed run silently LOST its entire protection config
   * (maxCostUsd/maxTokens ceilings, loopDetection, sideEffectDuplicates, taintedSideEffects all
   * Reverted to defaults). The most dangerous shape of that hole: an approvals resume of a SUSPENDED
   * Run — the human approves ONE call, and the continuation runs unguarded. Pass the SAME limits the
   * Original run used.
   *
   * `limits` alone was not enough — resume also silently dropped `processors` (prompt-injection
   * Tool-result redaction/flagging), `lock`, `timeouts`, `exclusiveModelStep`, `schemaCompat`, and
   * `toolPolicy`. The whole protection set must survive resume; pass the SAME config the original run used.
   */
  limits?: RunLimits;
  processors?: Processor[];
  /**
   * `memory` was the next field in that same list, and it was the one that loses DATA rather than
   * protection. runDurable appends the finished turn only when `memory && threadId` are both present
   * and the run did not suspend, so a suspended turn skips the append by design — and a resume with no
   * memory attached never appends it either. The assistant's reply to an approved call is then gone
   * from the thread for good.
   *
   * Measured, same journal, same approval, one difference:
   *
   *   via resumeRun   → thread ['user']                                  the answer vanished
   *   via runDurable  → thread ['user','assistant','tool','assistant']   the turn is there
   *
   * The user asked for a charge, a human approved it, the charge went through, the assistant said so —
   * and the conversation remembers only the request. The next turn's model sees no charge and no
   * answer, which for a money-shaped tool is the setup for doing it again.
   *
   * `threadId` is recovered from `:input` below, so passing `memory` is enough; pass `resourceId` too
   * if the original run used resource-scope recall.
   */
  memory?: Memory;
  resourceId?: string;
  lock?: { owner: string; ttlMs: number };
  timeouts?: { modelStepMs?: number; toolMs?: number; claimTtlMs?: number };
  exclusiveModelStep?: { ttlMs?: number };
  schemaCompat?: boolean | ToolSchemaRuleLike[];
  toolPolicy?: 'strict' | 'strict-critical';
  /** FAZ-4 (critical profile): refuse a runId re-used with DIFFERENT content — the raw caller input
   *  Is fingerprinted at freeze time; a later call whose fingerprint differs gets
   *  RunInputMismatchError (409, no resumable). Exemption: approvals addressing a toolCallId whose
   *  Journal record is genuinely 'suspended' (the chat approval re-POST carries a grown history). */
  strictInput?: boolean;
  /** FAZ-4: append PII-free refusal records (`idem:conflict:*`) for busy/mismatch/swept conflicts — see idem-ledger.ts. */
  conflictLedger?: boolean;
  /** FAZ-4: what a retention-swept runId's late retry does — 'ignore' (default, re-runs: today's
   *  Behavior) or 'reject' (RunSweptError; the critical profile's choice). */
  tombstonePolicy?: 'ignore' | 'reject';
  /** FAZ-4: opaque caller identity, bound into the frozen input FIRST-WINS — a different actor
   *  Re-driving the runId gets RunActorMismatchError. Absent on either side = no check (auth-less
   *  Profile has no protection here — documented, not silent). */
  actor?: string;
}

/**
 * Self-contained resume: reads the input (prompt/messages/system) from the journal, calls `runDurable`.
 * No need to pass the prompt again — only `runId` + agent config + approvals.
 */
export async function resumeRun(
  runId: string,
  opts: ResumeAgentConfig & { journal: Journal; approvals?: Record<string, boolean> },
): Promise<DurableResult> {
  const input = upgradeFormat(
    await opts.journal.get<{ prompt?: unknown; messages?: unknown; system?: unknown; threadId?: string }>(runKeys.input(runId)),
    runKeys.input(runId),
  ); // H13: legacy-format input is upgraded to the current shape on resume
  if (!input) {
    throw new Error(`@gnldev/durable: no recorded input for runId "${runId}" — cannot resume.`);
  }
  // `limits` is a runtime value the CLI/embed callers can't re-supply (it isn't part of
  // AgentConfig). If the caller passes `limits`, it wins (explicit override); otherwise recover the
  // Limits frozen at run start from the journal so the resumed run keeps its cost cap / loop /
  // Duplicate / taint gates instead of silently reverting to no-limits.
  const limits = opts.limits ?? (await opts.journal.get<RunLimits>(runKeys.cfgLimits(runId)));
  return runDurable({
    runId,
    journal: opts.journal,
    model: opts.model,
    tools: opts.tools,
    guard: opts.guard,
    approvals: opts.approvals,
    stopWhen: opts.stopWhen,
    replay: opts.replay,
    limits,
    // Forward the FULL protection set (not just limits) — processors especially, so
    // Tool-result redaction runs on the approved call during resume.
    ...(opts.processors ? { processors: opts.processors } : {}),
    ...(opts.memory ? { memory: opts.memory } : {}),
    ...(opts.resourceId ? { resourceId: opts.resourceId } : {}),
    ...(opts.lock ? { lock: opts.lock } : {}),
    ...(opts.timeouts ? { timeouts: opts.timeouts } : {}),
    ...(opts.exclusiveModelStep ? { exclusiveModelStep: opts.exclusiveModelStep } : {}),
    ...(opts.schemaCompat !== undefined ? { schemaCompat: opts.schemaCompat } : {}),
    ...(opts.toolPolicy ? { toolPolicy: opts.toolPolicy } : {}),
    // FAZ-4 K5: fields added to ResumeAgentConfig MUST land in this selective forward list too — an
    // Interface field missing here is born dead and silently drops the protection the caller asked for.
    ...(opts.strictInput !== undefined ? { strictInput: opts.strictInput } : {}),
    ...(opts.conflictLedger !== undefined ? { conflictLedger: opts.conflictLedger } : {}),
    ...(opts.tombstonePolicy ? { tombstonePolicy: opts.tombstonePolicy } : {}),
    ...(opts.actor ? { actor: opts.actor } : {}),
    ...(input.messages ? { messages: input.messages } : {}),
    ...(input.prompt ? { prompt: input.prompt } : {}),
    ...(input.system ? { system: input.system } : {}),
    // Recover the threadId frozen into `:input` — a resumed run under `taintScope: 'thread'`
    // Must keep the thread carry (inherit at start + write the thread key on a NEW post-resume
    // Untrusted call). It is ALSO the half that makes an attached `memory` work: the append is
    // conditioned on `memory && threadId`, so recovering the id here and forwarding memory above are
    // one fix, not two. (This comment used to say no memory is attached "so this changes nothing
    // else" — true, and the reason the resumed turn never reached the thread.)
    ...(input.threadId ? { threadId: input.threadId } : {}),
  } as any);
}

/**
 * Applies the schemaCompat rules to the AI SDK's already-converted tool list, for ONE candidate.
 *
 * By the time a fallback picks a model the tools have been converted, which is why the transform
 * appeared to be un-redoable. It is not: what the SDK hands `doGenerate` is
 * `[{ type, name, description, inputSchema }]` with `inputSchema` a plain JSON Schema — the exact
 * shape these rules take and return. So each candidate gets a schema built for it instead of one
 * built for whichever candidate happened to be first.
 *
 * Copied before transforming: the rules mutate in place, and the caller's array is reused across
 * attempts, so transforming it directly would leave the second candidate reading the first's result.
 */
function shapeJsonTools(
  tools: any[],
  candidate: unknown,
  rules: any[],
  detectModel: (m: unknown) => any,
): any[] {
  const info = detectModel(candidate);
  const active = rules.filter((r) => { try { return r.shouldApply(info); } catch { return false; } });
  if (active.length === 0) return tools;
  return tools.map((t) => {
    if (!t?.inputSchema || typeof t.inputSchema !== 'object') return t;
    let schema = structuredClone(t.inputSchema);
    for (const r of active) {
      try { schema = r.transform(schema) ?? schema; } catch { /* a broken rule must not break the call */ }
    }
    return { ...t, inputSchema: schema };
  });
}

/**
 * The durable counterpart of `streamText` — model/tools are wrapped, input is journaled.
 * Memory + processor scope goes through the SAME helpers as runDurable (parity must not be broken);
 * The only difference: output processors are applied only to messages being persisted (streamed
 * Deltas cannot be transformed).
 *
 * K1/W1 NOTE (B) — (b), READ THIS IF YOU CONSUME `fullStream` DIRECTLY: a
 * Loop/maxToolCalls/duplicate/tainted BLOCK does NOT throw from the stream — the blocked/limit/suspend
 * SENTINEL (`__gnl_blocked`/`__gnl_limit_exceeded`) leaks into `fullStream` as an internal tool-result
 * Part. This is DELIBERATE: @gnldev/server sse.ts / @gnldev/agui rely on it — they skip the sentinel part in
 * `fullStream` and, AFTER the stream ends, scan `steps` (`limitBreachFromSteps`/`blockedFromSteps`) to
 * Emit ONE terminal `error` event. Surfacing the breach as a `{type:'error'}` fullStream part instead
 * Would make those consumers emit a DOUBLE error event (the injected part + their post-scan), so it is
 * NOT done. (Asymmetry: maxCost/maxTokens DO throw from the stream flush — durable-model — so only the
 * Tool-gate blocks are sentinel-only in `fullStream`.) As a DIRECT consumer you catch the breach in one
 * Of THREE ways (recommended first):
 *   1. `await result.text` (or any other terminal result promise — content/response/toolCalls/…)
 * REJECTS with the TYPED error when a block/limit fired, mirroring runDurable's throw — a
 *      Happy-path consumer cannot silently miss it. EXCEPTIONS that deliberately keep the sentinel
 *      Contract and NEVER reject for a breach: `steps`, `finishReason`, `usage`, `request`, `warnings`
 *      And the streams (`fullStream`/`textStream`) — sse.ts/agui/studio post-scan `steps` and must not
 *      Get a reject (see guardStreamTerminalPromises).
 *   2. Pass `onBlocked` (StreamDurableArgs / registry RunOptions): invoked once at stream finish with
 *      The RAW structured breach `{ kind, message, detail }` — ideal when you only read `fullStream`
 *      And never await a terminal promise.
 *   3. Manually call `streamFinishError(steps)` (exported here) with onFinish's `ev.steps` (or your
 *      Accumulated step list) — returns the TYPED error to throw, `undefined` otherwise. This is what
 *      Sse.ts/agui effectively do via `limitBreachFromSteps`/`blockedFromSteps`.
 * Prefer `runDurable` if you don't want to own any of this.
 */
// Declared, not inferred — same reason as createAgentTool: inference names a pnpm-internal
// provider-utils path in the emitted .d.ts (TS2742). `StreamTextResult` comes from `ai`, the peer we
// already require, so the published surface stays describable in terms we actually depend on.
export async function streamDurable(args: StreamDurableArgs): Promise<StreamTextResult<any, any, any>> {
  // Same refusal as runDurable — a compensated run never streams either.
  await assertNotCompensated(args.journal, args.runId);
  // P2-cancel: same terminal-refusal contract as compensation — a durably-canceled run never
  // (re)starts or resumes (the per-step mid-flight gate lives in durable-model.ts).
  await assertNotCanceled(args.journal, args.runId);
  const { journal, runId, guard, approvals, memory, threadId, resourceId, agentName, replay, lock, processors, schemaCompat, limits, exclusiveModelStep, replayCacheMaxBytes, toolPolicy, timeouts, strictInput, conflictLedger, tombstonePolicy, actor, model, tools, stopWhen, onBlocked, ...rest } =
    args as StreamDurableArgs & Record<string, any>;
  // (a): opt-in run-lock — acquire BEFORE the setup work (reject a concurrent stream/run of the
  // Same runId with RunBusyError). Released on stream finish/error (see the onFinish/onError wrappers).
  // No heartbeat by design (see StreamDurableArgs.lock) — a streamed lock relies on ttlMs for takeover.
  const lockHandle = lock ? await acquireRunLock(journal, runId, lock.owner, lock.ttlMs) : null;
  if (lock && !lockHandle) {
    if (conflictLedger) await recordIdemConflict(journal, { runId, code: 'run_busy', ...(actor ? { actor } : {}) });
    throw Object.assign(new RunBusyError(`run '${runId}' is locked by another process`), { atLockAcquisition: true });
  }
  // (a): EVERYTHING after a successful acquire runs under a release-on-throw guard. The setup awaits
  // Below (thread-ownership assert, runStarted, approvals, memory prep, persistInput...) can all
  // Throw or reject, and each used to strand the just-acquired lock until TTL: a thread-mismatch
  // Told the caller to fix the id with a 409 while run_busy blocked the CORRECT retry for the whole
  // TTL. TTL is the crash insurance, not the wiring for a known exit.
  try {
    return await afterAcquire();
  } catch (err) {
    if (lockHandle) { try { await lockHandle.release(); } catch { /* best-effort; TTL reclaims */ } }
    throw err;
  }

  async function afterAcquire(): Promise<StreamTextResult<any, any, any>> {
  // ONE read of `:input`, shared with persistInput below — parity with runDurableInner. Read + asserted
  // BEFORE runStarted/resolveApprovals — see assertThreadOwnership's own doc (K2/K3 hardening).
  const frozenInput = await journal.get<FrozenInput>(runKeys.input(runId));
  try {
    assertThreadOwnership(frozenInput, runId, threadId);
  } catch (e) {
    // FAZ-4 ledger: the flagship conflict leaves a trace too (best-effort, PII-free).
    if (conflictLedger && e instanceof RunThreadMismatchError) await recordIdemConflict(journal, { runId, code: 'run_thread_mismatch', ...(actor ? { actor } : {}) });
    throw e;
  }
  // FAZ-4: fingerprint the RAW caller input BEFORE memory prep mutates rest.messages (post-prep
  // Content grows with the thread — hashing it would 409 every legitimate resume).
  const rawInputHash = argsHash({ prompt: rest.prompt, messages: rest.messages, system: rest.system });
  await assertRunAdmissible(journal, runId, frozenInput, rawInputHash, { strictInput, conflictLedger, tombstonePolicy, actor, approvals });
  // WRITE-AHEAD outcome — the stream twin of runDurableInner's. A stream abandoned mid-flight (the
  // process died, neither onFinish nor onError ran) reads 'running' instead of 'completed'.
  await runStarted(journal, runId, Date.now());
  // AUDIT (approval first-class): SAME as runDurableInner — BEFORE ctx is set up (see resolveApprovals).
  const resolvedApprovals = await resolveApprovals(journal, runId, approvals);
  // C2: on resume, load the replay snapshot (same as runDurableInner).
  const ctx: DurableCtx = { journal, runId, threadId, guard, approvals: resolvedApprovals, replay, limits, toolPolicy, blockedAsSentinel: true, toolTimeoutMs: timeouts?.toolMs, claimTtlMs: timeouts?.claimTtlMs, toolResultProcessors: processors, replayCache: await loadReplayCache(journal, runId, { maxBytes: replayCacheMaxBytes }) };
  const procCtx = processors?.length ? createProcessorCtx(journal, runId) : undefined;

  // Memory: load thread history + inject into system (BEFORE persistInput → replayable).
  let incoming: any[] = [];
  let wmTool: Record<string, any> | undefined;
  let incomingStored = false; // retry dedupe — see prepareMemoryContext/writeAheadIncoming
  let memCtx: MemoryContextRecord | undefined; // ':memctx' provenance — parity with runDurableInner
  let historyCount = 0;
  let loadedHistory: any[] = []; // parity with runDurableInner — the dedupe's second witness
  if (memory && threadId) {
    ({ incoming, wmTool, alreadyStored: incomingStored, provenance: memCtx, historyCount } = await prepareMemoryContext(memory, threadId, resourceId, rest, makeEchoView(processors, journal, runId)));
    loadedHistory = Array.isArray(rest.messages) ? rest.messages.slice(0, historyCount) : [];
    // F4: same-runId re-entry with interleaved turns — parity with runDurableInner.
    incomingStored = await dropIncomingIfAppendedEarlier(journal, runId, rest, incoming, incomingStored);
  }

  // REDACTION: post-processor incoming — parity with runDurableInner (see trackIncomingBoundary).
  const trackIncoming = memory && threadId && !incomingStored ? incomingSpan(rest, historyCount) : undefined;
  // `frozenInput` was already read (and its thread ownership asserted) above, before runStarted.
  const span = procCtx || frozenInput !== undefined
    ? await applyInputProcessors(processors ?? [], procCtx, journal, runId, frozenInput, threadId, rest, trackIncoming)
    : trackIncoming;
  if ((procCtx || frozenInput !== undefined) && span !== undefined) {
    // Parity with runDurableInner, loss reporting included — a silent question loss must not depend
    // on which entry point the caller happened to use.
    const rec = reconcileProcessedIncoming(rest, span, incoming, loadedHistory);
    incoming = rec.incoming;
    incomingStored = rec.alreadyStored;
    if (rec.lost) reportIncomingLoss(runId, threadId!, memCtx, rec.lost);
    else if (memCtx) {
      memCtx.incomingCount = rec.trailing;
      if (rec.chainAppended) memCtx.chainAppended = rec.chainAppended;
      if (rec.chainInserted) memCtx.chainInserted = rec.chainInserted;
      if (rec.dedupedByShape) memCtx.incomingDedupedByShape = true;
    }
  }

  await persistInput(journal, runId, rest, frozenInput !== undefined, threadId, agentName, resourceId, rawInputHash, actor);
  await persistMemoryContext(journal, runId, memCtx);
  // Freeze `limits` on the first run (parity with runDurableInner) — idempotent via `claim`.
  if (limits) await claim(journal, runKeys.cfgLimits(runId), serializableLimits(limits));
  // WRITE-AHEAD user message (parity with runDurableInner — see writeAheadIncoming). Pre-model, so a
  // Memory failure rejects gnl.stream() itself (a clean JSON error) instead of surfacing mid-SSE.
  if (memory && threadId) await writeAheadIncoming(journal, memory, threadId, runId, incoming, incomingStored, limits);
  // Same run-start thread-taint inheritance as runDurableInner (opt-in; parity).
  // PHASE 3: same content-window visibility input as runDurableInner (parity).
  await inheritThreadTaint(journal, runId, threadId, limits, { messages: rest.messages, memory });

  let effectiveTools = wmTool ? { ...tools, ...wmTool } : tools;
  if (procCtx && effectiveTools) effectiveTools = await applyToolProcessors(processors!, procCtx, effectiveTools, rest);

  // 8.8 Tool-schema compat (opt-in): see runDurableInner — pure, before the model call + before durableTools.
  if (schemaCompat && effectiveTools) {
    const { applyToolCompat, defaultRules, detectModel } = await import('@gnldev/tool-schema');
    const rules = schemaCompat === true ? defaultRules : schemaCompat;
    // A fallback chain shapes per CANDIDATE, at the moment one is chosen, rather than once here for
    // whichever model the proxy claims to be. Transforming here for a chain would bake in one
    // provider's rules and hand them to whoever actually answers — and the providers genuinely
    // disagree (OpenAI's strict mode requires `additionalProperties: false`; Gemini rejects the
    // keyword), so no single shape serves them all. See setChainToolShaper.
    if (!setChainToolShaper(model, (toolsJson: any[], candidate: unknown) => shapeJsonTools(toolsJson, candidate, rules as any[], detectModel))) {
      effectiveTools = applyToolCompat(effectiveTools, model, rules);
    }
  }

  const stepHookFailure: StepHookFailure = {};
  const options: any = {
    // Same reason as runDurableInner: a replay must be able to send back what it recorded.
    allowSystemInMessages: true,
    ...rest,
    // §5.3 + Y1: SAME opt-in flow as runDurableInner (see the note there).
    model: withDurableModel(model as LanguageModelV4, ctx,
      (exclusiveModelStep || timeouts?.modelStepMs) ? { exclusiveStep: exclusiveModelStep, stepTimeoutMs: timeouts?.modelStepMs } : undefined),
    stopWhen: composeStopWhen(stopWhen, stepHookFailure),
  };
  if (effectiveTools) options.tools = durableTools(effectiveTools, ctx);
  // P2-step: SAME per-step hook bridging as runDurableInner (parity contract — see the note there).
  // StreamText supports the same prepareStep/onStepFinish surface; onFinish wrapping below is untouched.
  if (procCtx && processors?.length) {
    const prep = composePrepareStep(processors as Processor[], procCtx);
    if (prep) options.prepareStep = prep;
    // The holder is read by the stop condition below: AI SDK 7 swallows a throw from onStepFinish,
    // so a processor that blocks a run only takes effect if WE notice and stop.
    const onStep = composeOnStepFinish(processors as Processor[], procCtx, stepHookFailure);
    if (onStep) options.onStepFinish = onStep;
  }
  // Stream finish: output processors (only messages being persisted) + idempotent memory append
  // (marker; stream/non-stream do not double-write, replay-safe). ProcessorTripwire blocks the append
  // But cannot retroactively stop the stream — use an input processor for moderation in streaming.
  // SUSPEND PARITY (audit): IF the run IS SUSPENDED (suspend/limit/block sentinel), completion side
  // Effects are NOT processed — same principle as runDurableInner. The old behavior wrote the half
  // Conversation to memory and locked the marker → once resume completed, the FINAL answer never made
  // It into memory at all.
  // ONE processOutput pass per turn, shared by the two things that need it: the memory append (in
  // OnFinish) and the caller-facing terminal promises (`result.text` / `result.response`, masked in
  // The Proxy below). Memoised SYNCHRONOUSLY on first call, so whichever arrives first computes and
  // The other awaits the same promise — the hook keeps its once-per-turn contract either way.
  //
  // WHY the caller-facing half cannot simply read a value onFinish left behind: measured, the SDK
  // Resolves `steps`/`text`/`response` BEFORE our onFinish body finishes (an async processor is still
  // Running when they settle). A getter that read a variable set at the end of onFinish would see
  // `undefined` and fall back to raw — non-deterministically. And a getter that WAITED for onFinish
  // Would add exactly the "dependence on our own callbacks firing" hang path guardStreamTerminalPromises
  // Was written to avoid. The lazy view here is the way out: if onFinish never runs, the getter
  // Computes the pass itself from the result's own promises.
  let outputPass: Promise<ProcessorOutput | undefined> | undefined;
  const outputProcessed = (view: () => Promise<any>): Promise<ProcessorOutput | undefined> => {
    outputPass ??= (async () => {
      if (!procCtx) return undefined;
      const ev = await view();
      // SUSPEND PARITY with runDurableInner: a suspended/blocked turn is not a finished output, so
      // The chain does not run on it (and the caller gets the raw value, as it does today).
      const stepsArr: any[] = ev?.steps ?? [];
      if (stepsArr.some((s: any) => Array.isArray(s?.content) && s.content.some((p: any) => hasSuspend(p) || hasLimitExceeded(p) || hasBlocked(p)))) return undefined;
      let pout: ProcessorOutput = { text: ev?.text ?? '', messages: producedMessages(ev), result: ev };
      for (const p of processors as Processor[]) {
        if (p.processOutput) pout = await p.processOutput(pout, procCtx);
      }
      return pout;
    })();
    outputPass.catch(() => { /* pre-handled — both awaiters have their own catch (warn / raw fallback) */ });
    return outputPass;
  };

  {
    // Set by the onError wrapper below; also derived from the finish event itself, because some
    // Providers surface a mid-stream failure only as finishReason:'error' without an error part.
    let streamFailed = false;
    const prevOnFinish = options.onFinish;
    options.onFinish = async (ev: any) => {
      const stepsArr: any[] = ev?.steps ?? [];
      // (b): visibility callback — a block/limit sentinel at stream finish → hand the caller
      // The RAW structured breach. Advisory: a throw is swallowed with a console.warn (same policy as
      // The memory-finalization warn below) — it must never break the stream or mask the typed error
      // The terminal promises reject with.
      if (onBlocked) {
        const breach = streamBreachFromSteps(stepsArr);
        if (breach) {
          try { await onBlocked(breach); } catch (err) {
            console.warn(`@gnldev/durable: '${runId}' onBlocked callback threw — swallowed (advisory callback):`, err);
          }
        }
      }
      const pending = stepsArr.some((s: any) =>
        Array.isArray(s?.content) && s.content.some((p: any) => hasSuspend(p) || hasLimitExceeded(p) || hasBlocked(p)));
      if (!pending) {
        try {
          let produced: any[] = producedMessages(ev);
          if (procCtx) {
            // NOTE (deliberate limitation): a ProcessorRetry thrown here is NOT retried — unlike
            // RunDurableInner's retry ladder, this fires AFTER the stream has already flushed to the
            // Client, so "let the model try again" would mean re-streaming a turn the caller already
            // Saw — a different contract we deliberately do not contort this into. It is caught by the
            // Catch below like any other processOutput throw (console.warn, stream itself not broken).
            // Use runDurable/generateText for a processor that needs retry-with-feedback.
            const pout = await outputProcessed(async () => ev);
            if (pout) produced = pout.messages;
          }
          if (memory && threadId) {
            // TWO-PHASE MARKER — SAME pattern/parity as runDurableInner (see claimMemoryAppend).
            // Here INSIDE a try/catch (below) → if append throws, the marker stays 'pending': the
            // NEXT resume/retry (SAME runId) self-heals after the TTL; on this turn the error is
            // Made VISIBLE via console.warn but the stream is NOT BROKEN (streamText's own contract).
            // PRODUCED only — `incoming` went in pre-model via writeAheadIncoming. Shared with
            // runDurableInner so the two paths cannot drift.
            await appendCompletion(memory, journal, runId, threadId, runKeys.memAppended(runId), incoming, incomingStored, produced, limits);
          }
        } catch (err) {
          // NO silent swallowing (audit): history could not be written for this run — surface it, don't break the stream.
          console.warn(`@gnldev/durable: '${runId}' stream memory/processor finalization failed — conversation history may be incomplete:`, err);
        }
        // 1.1: usage counter only on a COMPLETED run (parity with runDurableInner; not counted while suspended).
        try { await recordRunUsage(journal, runId); } catch { /* counter is optional — must not affect the stream */ }
        // P1.6b: materialized metrics — PARITY with runDurableInner's completion hook (this closes the
        // Former registry TODO: streamed runs no longer depend on a manual backfill to be counted).
        try {
          await recordRunMetrics(journal, journal as unknown as JournalReader, runId, agentName ? { agentName } : {});
        } catch { /* advisory aggregate — must not affect the stream */ }
        // Parity with runDurableInner: inside the completed branch only, so a suspended stream is not
        // Recorded as finished. NOT on an errored stream: onFinish fires after onError, and the
        // Success write here was measured OVERWRITING the failure the error path had just recorded —
        // ["failed","completed"], final record completed — on the SSE/chat path of all places.
        // finishReasonText, NOT ===: AI SDK 7 made finishReason an object ({unified, raw}), so the
        // string comparison is permanently false and a failed stream is journaled as a SUCCESS —
        // the worst possible lie for a durability engine to tell.
        const endedInError = streamFailed || finishReasonText(ev?.finishReason) === 'error'
          || stepsArr.some((st: any) => finishReasonText(st?.finishReason) === 'error');
        if (!endedInError) await runSucceeded(journal, runId, Date.now());
        else await runFailed(journal, runId, new Error(String(ev?.finishReason ?? 'stream error')), Date.now());
      }
      // (a): the stream has finished (completed OR suspended) → release the run-lock so a resume
      // Can proceed. Token-fenced + idempotent: a no-op if the lock was already taken over/released.
      if (lockHandle) { try { await lockHandle.release(); } catch { /* release is best-effort; TTL reclaims */ } }
      if (prevOnFinish) await prevOnFinish(ev);
    };
    // (a): also release on a stream error (onFinish may not fire on the error path). release()
    // Is idempotent, so a later onFinish release is harmless. On abandonment (neither fires), TTL reclaims.
    // Previously wrapped ONLY when a lock existed, so an unlocked stream that failed recorded nothing
    // And read back as 'completed'. Now always wrapped; the release stays conditional.
    const prevOnError = options.onError;
    options.onError = async (ev: any) => {
      const err = (ev as { error?: unknown })?.error ?? ev;
      streamFailed = true; // onFinish still fires after an error — it must not record a success over this
      if (isRunFailure(err)) await runFailed(journal, runId, err, Date.now());
      if (lockHandle) { try { await lockHandle.release(); } catch { /* best-effort; TTL reclaims */ } }
      if (prevOnError) await prevOnError(ev);
    };
    // (a): release on ABORT too — AI SDK 7 fires `onAbort` (NOT onFinish/onError) when the caller's
    // AbortSignal trips mid-stream, so "TTL reclaims on abandonment" was covering a path that is not
    // Abandonment at all. With the chat route's default lock + forwarded request signal, "user hit
    // Stop / closed the tab" was the COMMON path that stranded the lock: the very next regenerate
    // Derives the SAME runId and ate 409 run_busy until the TTL expired.
    const prevOnAbort = (options as any).onAbort;
    (options as any).onAbort = async (ev: any) => {
      if (lockHandle) { try { await lockHandle.release(); } catch { /* best-effort; TTL reclaims */ } }
      if (prevOnAbort) await prevOnAbort(ev);
    };
  }
  let rawStream: any;
  // OUTPUT-PROCESSOR PARITY WITH runDurable. Measured before this existed, with the same redactor
  // Installed on both entry points:
  //     runDurable    → result.text  'cevap: [MASKED_EMAIL]'
  //     streamDurable → result.text  'cevap: gizli@ornek.com'     ← RAW
  // Only the messages heading for MEMORY were processed here; everything handed back to the caller
  // Was the model's own output. So the caller who uses the stream for its durability and then reads
  // `await result.text` (log it, store it, return it from an HTTP handler) received exactly what an
  // Output processor exists to prevent — and the same code under runDurable did not. That asymmetry
  // Is the leak; this closes it.
  //
  // SCOPE, stated plainly: `text` and `response.messages` are the `{text, messages}` VIEW the
  // ProcessOutput contract is written in, and they are all that is masked — same line runDurable
  // Draws (see the KNOWN RESIDUAL note there). `textStream`/`fullStream` are NOT masked and cannot
  // Be: the deltas were already flushed to the client before the turn ended, and a chunk-wise
  // Transform is not derivable from a whole-turn hook (a value can straddle two deltas; a
  // Summarising processor has no per-chunk meaning at all). So on the stream path an output
  // Processor governs what is PERSISTED and what the terminal promises return — not what the client
  // Already saw byte-by-byte. Use an INPUT processor, or runDurable, if the delta stream itself must
  // never carry it.
  const maskTerminal: TerminalMask = async (prop, value, steps) => {
    if (prop !== 'text' && prop !== 'response') return value;
    let pout: ProcessorOutput | undefined;
    try {
      pout = await outputProcessed(async () => ({
        text: await Promise.resolve(Reflect.get(rawStream, 'text', rawStream)).catch(() => ''),
        steps,
        response: await Promise.resolve(Reflect.get(rawStream, 'response', rawStream)).catch(() => undefined),
      }));
    } catch {
      // The chain threw (tripwire/retry/bug). onFinish reports it; here the ONLY other option is to
      // Reject a promise that has never rejected for this reason, so the raw value is returned —
      // Identical to the behaviour before masking existed, never worse.
      return value;
    }
    if (!pout) return value; // no processors, or a suspended/blocked turn — unchanged
    if (prop === 'text') return typeof pout.text === 'string' ? pout.text : value;
    return value && typeof value === 'object' ? { ...(value as any), messages: pout.messages } : value;
  };

  // (b): wrap the result so the terminal promises (result.text & friends) REJECT with the
  // Typed streamFinishError when a block/limit sentinel fired — see guardStreamTerminalPromises.
  // A synchronous streamText throw is released by afterAcquire's caller-side catch above.
  rawStream = streamText(options);
  return guardStreamTerminalPromises(rawStream, procCtx ? maskTerminal : undefined);
  } // afterAcquire — post-acquire body under the release-on-throw guard
}
