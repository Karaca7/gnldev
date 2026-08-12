import { generateText, streamText, stepCountIs } from 'ai';
import { withDurableModel } from './durable-model.js';
import { durableTools } from './durable-tool.js';
import { acquireRunLock } from './run-lock.js';
import { RunBusyError, SideEffectRetryBlockedError, RetryLimitExceededError } from './errors.js';
import { createProcessorCtx, composePrepareStep, composeOnStepFinish, durableProcessorStep, ProcessorRetry, RetryExhaustedByProcessorError } from './processor.js';
import { loadReplayCache, runKeys, claim } from './journal.js';
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
import type { SchemaCompatRule } from '@gnldev/schema-compat';
import type { LanguageModelV2 } from '@ai-sdk/provider';

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
   *  each run with its agent (surfaced by listRuns, no per-run journal N+1). Optional (direct runDurable
   *  callers may omit it); the registry passes the agent key. */
  agentName?: string;
  /**
   * Replay determinism mode (M2). Default `'lenient'`.
   * HONEST BOUND (audit E2): model-step divergence detection is OFF by default — under `'lenient'` a
   * replayed model step that produces a DIFFERENT request is NOT flagged at all. Even `'strict'` only
   * `console.warn`s the divergence (it does NOT throw for the model step; the hard `DivergenceError` is for
   * tool-argument drift). Set `'strict'` if you want the model-divergence warning surfaced. (Independent of
   * this flag, a generate↔stream entry-point mismatch on the SAME runId always throws a clear error — see
   * runDurable vs streamDurable.)
   */
  replay?: 'strict' | 'lenient';
  /** Opt-in run-level lock (M4): if provided, a concurrent resume of the same runId gets `RunBusyError`. */
  lock?: { owner: string; ttlMs: number };
  /**
   * §5.3 (opt-in): model-step exclusivity. If provided, when a concurrent worker's FRESH 'running'
   * model claim is seen (startedAt newer than ttlMs ago from now; default 30_000),
   * `RunBusyError` is thrown → prevents duplicate `doGenerate` (duplicate token cost). A STALE claim
   * (crashed owner) proceeds with existing behavior — the fast crash-resume window is preserved.
   */
  exclusiveModelStep?: { ttlMs?: number };
  /** H8c (optional): replay-cache RAM threshold (bytes; default 32MB). If the journal is larger than this,
   *  bulk caching is skipped → point-read replay (same correctness, bounded memory). */
  replayCacheMaxBytes?: number;
  /** H10b (opt-in production mode): 'strict' → every tool MUST declare its side-effect intent
   *  (idempotent | sideEffect | recover). An undeclared tool causes a clear error at run start. */
  toolPolicy?: 'strict';
  /** 8.7 Processor pipeline: input/output/tool transformers (PII/moderation/tool-filter). */
  processors?: Processor[];
  /** 8.8 Provider-specific tool-schema compatibility (opt-in): true → default set; array → those rules. */
  schemaCompat?: boolean | SchemaCompatRule[];
  /** GOREV W1 (opt-in): per-run cost cap + loop detection. If not provided, no check runs. */
  limits?: RunLimits;
  /**
   * Y1/Y3 (opt-in): external call timeouts + claim TTL. `modelStepMs` applies to every model step
   * (up to the first byte in streaming), `toolMs` applies to every tool execute (tool.timeoutMs
   * overrides per-tool); on timeout, StepTimeoutError flows through the existing failed/retry paths.
   * `claimTtlMs` is the staleness threshold for a 'running' claim (default 30s) — raise it for
   * legitimate tools that run longer than 30s.
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
   *  and warn-only even under `'strict'` (see RunDurableArgs.replay for the full honest bound). */
  replay?: 'strict' | 'lenient';
  /**
   * Processor pipeline. Input/tool processors run exactly the same as in run (BEFORE the model).
   * Output processors in streaming are applied ONLY to messages being persisted (memory append) —
   * text-deltas that have already streamed cannot be retroactively transformed.
   */
  processors?: Processor[];
  /** 8.8 Provider-specific tool-schema compatibility (opt-in): true → default set; array → those rules. */
  schemaCompat?: boolean | SchemaCompatRule[];
  /** GOREV W1 (opt-in): per-run cost cap + loop detection. If not provided, no check runs. */
  limits?: RunLimits;
  /** §5.3 (opt-in): model-step exclusivity — same semantics as runDurable (see RunDurableArgs). */
  exclusiveModelStep?: { ttlMs?: number };
  /**
   * AUDIT B3(a) — opt-in run-level lock (same shape as RunDurableArgs.lock): if provided, a concurrent
   * stream/run of the same runId gets `RunBusyError` at start. The lock is acquired BEFORE streaming and
   * RELEASED when the stream finishes (the same `onFinish` lifecycle the memory-append uses; also
   * released on stream error).
   *
   * DELIBERATE LIMITATION vs runDurable: there is NO self-renewing heartbeat (runDurable's B4 renew).
   * A stream is consumed lazily by the caller AFTER streamDurable returns — its lifecycle is not bounded
   * by a function scope, so a self-renewing timer on an ABANDONED stream (created, never drained) would
   * keep renewing and hold the lock forever. Instead the lock serializes the START and is released on
   * finish; a stream that outlives `ttlMs` (or is abandoned before `onFinish`) is reclaimed at TTL —
   * pick a generous `ttlMs`. If you need the mid-run heartbeat guarantee, use `runDurable`.
   */
  lock?: { owner: string; ttlMs: number };
  /** H8c: replay-cache RAM threshold (see RunDurableArgs). */
  replayCacheMaxBytes?: number;
  /** H10b: strict tool policy (see RunDurableArgs). */
  toolPolicy?: 'strict';
  /** Y1/Y3: timeouts + claim TTL (see RunDurableArgs). */
  timeouts?: { modelStepMs?: number; toolMs?: number; claimTtlMs?: number };
  /**
   * AUDIT B3(b) — streaming block/limit VISIBILITY: invoked ONCE at stream finish when a
   * loop/maxToolCalls/duplicate/tainted block or a durable-tool block sentinel fired during the run.
   * Receives the RAW structured breach `{ kind, message, detail }` (the sentinel's own fields — no
   * invented user-facing message; the app decides what to show its users). Advisory callback: a throw
   * from it is swallowed with a console.warn and never breaks the stream or masks the typed error the
   * terminal promises reject with.
   */
  onBlocked?: (breach: StreamBreach) => void | Promise<void>;
};

/** `generateText` result + suspended tool calls (`interrupts`). */
export type DurableResult = Awaited<ReturnType<typeof generateText>> & { interrupts: Interrupt[] };

function hasSuspend(part: any): boolean {
  return part?.type === 'tool-result' && !!part.output?.__gnl_suspend;
}

// GOREV W1: the sentinel returned when durable-tool.ts's loop/maxToolCalls gate is blocked
// (see the limits.ts header — since the AI SDK swallows tool-execute errors, this sentinel is
// used instead of THROWING; the SAME mechanism as suspend, composeStopWhen stops the loop).
function hasLimitExceeded(part: any): boolean {
  return part?.type === 'tool-result' && !!part.output?.__gnl_limit_exceeded;
}

/**
 * Converts the FIRST sentinel found via `hasLimitExceeded` into a real error (see runDurableInner).
 * Decision #2: @gnldev/server sse.ts also uses this at the end of the stream — the sentinel does not
 * leak to the client, the breach is converted into an SSE `error` event ({code, detail}). This is
 * why it is EXPORTED.
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
// swallows tool-execute throws, it is NOT thrown, a sentinel is returned instead (see durable-tool blockedOrThrow).
function hasBlocked(part: any): boolean {
  return part?.type === 'tool-result' && !!part.output?.__gnl_blocked;
}

/**
 * K1: return the FIRST `__gnl_blocked` sentinel — SAME contract as limitBreachFromSteps:
 * @gnldev/server sse.ts / @gnldev/agui use this at the end of the stream (the sentinel does not leak
 * to the client, it is converted into an error event). This is why it is EXPORTED.
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
  // GOREV (saga, mid-flight condemnation): a worker already inside the loop when the operator
  // condemned the run — durable-tool refuses the NEW side effect via this sentinel (see the gate there).
  if (b.code === 'CompensatedRunError') return new CompensatedRunError(b.detail?.runId ?? 'unknown');
  return new RunBusyError(b.message);
}

/**
 * K1/GOREV W1 (B): converts the FIRST blocked/limit sentinel in the `steps` array into a real
 * typed error. runDurableInner uses this; it is also EXPORTED for code that consumes streamDurable
 * DIRECTLY (manually reading fullStream, not @gnldev/server sse.ts / @gnldev/agui) — pass it onFinish's
 * `ev.steps`: if a sentinel exists, it returns the TYPED error, otherwise `undefined` (the sentinel
 * itself never leaks outward). Uses the SAME scan order as blockedFromSteps/limitBreachFromSteps —
 * the conversion logic lives in ONE place (no duplication): runDurableInner also calls this function.
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
 * AUDIT B3(b): the normalized breach handed to `StreamDurableArgs.onBlocked`. ONE shape for both
 * sentinel families, REUSING the existing kinds: a limit sentinel keeps its `kind`
 * ('loop' | 'maxToolCalls' | 'duplicateSideEffect' | 'taintedSideEffect'); a durable-tool block
 * sentinel uses its error `code` as the kind ('SideEffectRetryBlockedError' | 'RetryLimitExceededError' |
 * 'CompensatedRunError' | 'RunBusyError'). `message`/`detail` are the sentinel's RAW fields — nothing
 * user-facing is invented here.
 */
export interface StreamBreach {
  kind: 'loop' | 'maxToolCalls' | 'duplicateSideEffect' | 'taintedSideEffect' | (string & {});
  message: string;
  detail?: unknown;
}

// AUDIT B3(b): normalize the FIRST sentinel (same scan order as streamFinishError — blocked first)
// into the StreamBreach shape for the onBlocked callback. For a blocked sentinel without `detail`,
// fall back to `{ toolCallId, toolName }` so the app can still identify the blocked call.
function streamBreachFromSteps(steps: any[]): StreamBreach | undefined {
  const blocked = blockedFromSteps(steps);
  if (blocked) return { kind: blocked.code, message: blocked.message, detail: blocked.detail ?? { toolCallId: blocked.toolCallId, toolName: blocked.toolName } };
  const limitBreach = limitBreachFromSteps(steps);
  if (limitBreach) return { kind: limitBreach.kind, message: limitBreach.message, detail: limitBreach.detail };
  return undefined;
}

// AUDIT B3(b) — terminal-promise reject: the awaited-result promises a happy-path consumer reads
// (`result.text` first among them) must REJECT with the typed `streamFinishError(steps)` error when a
// block/limit sentinel fired, mirroring runDurable's throw. DELIBERATELY EXCLUDED (they keep the
// sentinel contract): `steps` (@gnldev/server sse.ts, @gnldev/agui and @gnldev/studio `await result.steps`
// WITHOUT a catch and post-scan it — rejecting it would replace their structured terminal error with a
// generic one), `finishReason`/`usage` (@gnldev/studio's pipe awaits them even on the breach path — a
// reject would blank its `done` event), `request`/`warnings` (resolve BEFORE stream finish — gating
// them on `steps` would delay them), and the streams themselves (`fullStream`/`textStream`).
const STREAM_BREACH_REJECT_PROPS = new Set([
  'text', 'reasoningText', 'reasoning', 'sources', 'files', 'content',
  'toolCalls', 'staticToolCalls', 'dynamicToolCalls',
  'toolResults', 'staticToolResults', 'dynamicToolResults',
  'totalUsage', 'response', 'providerMetadata',
]);

// Wraps the streamText result in a Proxy: the listed promise getters are gated on `steps` (which
// resolves at the same finish point — no dependence on our own callbacks firing, so no new hang path)
// and reject with the typed error if a sentinel is present. Everything else passes through untouched
// (methods bound to the raw result so private state keeps working). Each wrapped promise gets a no-op
// catch attached so merely ACCESSING a property on a breached run never becomes an unhandled rejection.
function guardStreamTerminalPromises<T extends object>(raw: T): T {
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
            return value;
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
function composeStopWhen(stopWhen: any): any[] {
  const base = stopWhen ?? stepCountIs(12);
  const suspendStop = ({ steps }: any) => {
    const last = steps[steps.length - 1];
    return Array.isArray(last?.content) && last.content.some((p: any) => hasSuspend(p) || hasLimitExceeded(p) || hasBlocked(p));
  };
  return [...(Array.isArray(base) ? base : [base]), suspendStop];
}

/**
 * AUDIT (approval first-class): the approval decision was not first-class in the journal —
 * `approvals` was passed as an EXTERNAL parameter on every call; in the 'approved but crashed before
 * the tool ran' scenario (approved, but the process died before execute completed), the decision was
 * not PERSISTED anywhere → resume would require the `approvals` parameter again, forcing the caller
 * to maintain its own decision history.
 *
 * This function is called at the START of runDurableInner/streamDurable (BEFORE ctx is set up), in
 * two steps:
 *  (a) writes EVERY decision that comes in via the parameter to the journal with `claim` — idempotent:
 *      `claim` only writes if the key is EMPTY, so the FIRST decision in the journal always wins
 *      (the exactly-once spirit — it NEVER overwrites with a DIFFERENT parameter that arrives later).
 *  (b) if `journal.listKeys` is supported (an optional adapter capability), reads ALL recorded
 *      approvals for this run and MERGES them with the parameter — on conflict, the (FIRST) decision
 *      in the journal wins and is surfaced via `console.warn`. If `listKeys` is UNAVAILABLE (adapter
 *      doesn't support it): only (a) is written, the merge stays LIMITED to the parameter — no WORSE
 *      than today's behavior, it just skips enrichment from the journal (documented fallback).
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
  if (approvals) {
    for (const [toolCallId, decision] of Object.entries(approvals)) {
      await claim(journal, runKeys.approval(runId, toolCallId), decision);
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
    if (journalDecision === undefined) continue;
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
 * describes the attempt whose input was frozen). Best-effort read-model: a failure to read it later
 * degrades a debugging panel, never the run — but the WRITE is on the run path and not try/caught,
 * matching persistInput (a journal that can't write is a failed run anyway).
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
  threadId?: string,
  agentName?: string,
): Promise<void> {
  const key = runKeys.input(runId); // ':input' doesn't match parseJournalKey → invisible in the reader
  if ((await journal.get(key)) !== undefined) return;
  // We freeze threadId + the agent NAME together with the input (both optional): studio /runs reads
  // this to group runs by thread and to LABEL each run with its agent (no per-run journal N+1). It
  // sits in the invisible `:input` entry → doesn't leak into reader/time-travel, doesn't affect step counting.
  // `at` = the run's TRUE start (this write precedes the first model call). recordRunMetrics needs it
  // because the visible entries can't carry it: a streamed step's `model:N` row is written when the
  // step FINISHES — a single-step streamed run has exactly one visible row, at the very end, so a
  // ts-span duration read 0ms (live repro: a 27s stream recorded as 0ms). Additive field; readers of
  // the input blob ignore unknown fields.
  await journal.put(key, stampFormat({ at: Date.now(), prompt: input.prompt, messages: input.messages, system: input.system, ...(threadId ? { threadId } : {}), ...(agentName ? { agent: agentName } : {}) })); // H13
}

/**
 * AUDIT A4 (memory-recall half, opt-in `limits.taintScope: 'thread'`): inherit thread taint at RUN
 * START — before any tool executes. Memory recall injects prior-thread messages into a NEW runId with
 * a clean per-run taint slate; if a prior turn on this thread was tainted (thread key claimed by
 * markRunTainted under the same opt-in), mark THIS run tainted now so the `taintedSideEffects` ladder
 * fires for its side effects. Provenance: the ORIGINAL source tool/call is carried, `source` becomes
 * `'inherited'`, and `reason` names the thread. First-wins/idempotent (a resumed run that is already
 * tainted keeps its original mark). No opt-in or no threadId → zero reads, byte-for-byte old behavior.
 * The SINGLE shared hook for runDurable and streamDurable — parity must not be broken.
 *
 * TAINT PHASE 3 (opt-in `limits.taintLifetime: 'content-window'`): before inheriting, check whether
 * the tainting content is STILL VISIBLE to the model this run — present in the messages actually
 * loaded (recent + recalled: `visible.messages` is `rest.messages` AFTER memory/processor prep, which
 * is exactly what goes to the model) or in working memory (lazy read via the attached Memory). Absent
 * everywhere → the thread taint is EXPIRED for this run: do NOT inherit. The thread key is kept
 * LATENT (not cleared) on purpose — a later run whose semantic recall re-surfaces the poisoned
 * message sees it visible again and the taint REVIVES. Every uncertain case keeps the inherit (see
 * isThreadTaintExpired in taint.ts). A RESUMED tainted run is unaffected by expiry: its own run-taint
 * key was already claimed on the original execution, so skipping the inherit changes nothing.
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
type PreparedInput = { prompt?: unknown; messages?: any[]; system?: string };

/**
 * Load the memory context: thread history + working memory (+ the OM/recall/WM tool on the rich path).
 * Updates `rest` in place; called BEFORE persistInput → the entire context freezes into `:input` = replayable.
 * The SINGLE shared path for runDurable and streamDurable — parity must not be broken.
 */
/**
 * WRITE-AHEAD dedupe input: does the tail of the loaded history already END with exactly the
 * incoming message(s)? True on a retry of a turn whose write-ahead append (see writeAheadIncoming)
 * already stored them — SAME runId (crash between append and completion) or a NEW runId re-sending
 * the identical text (studio playground's retry generates a fresh runId per attempt).
 * Compared by JSON shape: both sides come from the same construction (the caller's message object,
 * roundtripped through the store), so key order is stable. Best-effort on purpose — a false NEGATIVE
 * merely reproduces the pre-write-ahead behavior for that turn (a duplicate row), never worse.
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
 * F1 (RISK-AUDIT-DURABILITY): server-owned-history contract, enforced at the core. useChat-style
 * clients POST their ENTIRE message history every turn (see @gnldev/ai-sdk chat-route.ts — the
 * client's UIMessage[] is converted wholesale); with memory+threadId that whole history became
 * `incoming`, so every turn re-persisted and re-prompted the echoed early turns — compounding
 * duplication. Exact-equality dedupe can't catch it: the client's echo of an assistant turn
 * (UIMessage→ModelMessage) is structurally different from the `response.messages` shape memory
 * stored, so JSON comparison never matches.
 *
 * The rule instead keys off ROLES: once a thread HAS stored history, any assistant/tool message
 * inside `incoming` can only be an echo of a previous server turn (in a server-memory conversation
 * the client is not a source of assistant output) — so the genuinely NEW input is the block after
 * the LAST non-user message. A first turn (empty history) is left untouched on purpose: seeding a
 * new thread with a few-shot transcript is legitimate and still persists wholesale.
 */
function dropEchoedHistory(history: any[], incoming: any[]): any[] {
  if (history.length === 0) return incoming;
  for (let i = incoming.length - 1; i >= 0; i--) {
    const role = incoming[i]?.role;
    if (role === 'assistant' || role === 'tool') return incoming.slice(i + 1);
  }
  return incoming;
}

/** The `:memctx` journal record — MemoryContextProvenance plus the run-side counts (see runKeys.memoryContext). */
export interface MemoryContextRecord extends MemoryContextProvenance {
  v: 1;
  threadId: string;
  /** New message(s) this turn actually contributed (after echo-trim). */
  incomingCount: number;
  /** Client-echoed messages dropEchoedHistory stripped from the request (0 = delta-only client). */
  echoTrimmed: number;
}

async function prepareMemoryContext(
  memory: Memory,
  threadId: string,
  resourceId: string | undefined,
  rest: PreparedInput,
): Promise<{ incoming: any[]; wmTool?: Record<string, any>; alreadyStored: boolean; provenance?: MemoryContextRecord }> {
  const rawIncoming: any[] = rest.messages ?? (rest.prompt != null ? [{ role: 'user', content: rest.prompt }] : []);
  delete rest.prompt;
  const rid = resourceId ?? (memory.getThreadResource ? await memory.getThreadResource(threadId) : undefined);

  if (typeof memory.loadContext === 'function') {
    // Rich path (Phase 14 AgentMemory): composes recall + WM + OM + tool in a single pass.
    const mc = await memory.loadContext(threadId, { query: lastUserText(rawIncoming), resourceId: rid, incoming: rawIncoming });
    const history = mc.messages ?? [];
    // F1: strip client-echoed history first (full-history POSTing clients), THEN the retry dedupe.
    const incoming = dropEchoedHistory(history, rawIncoming);
    // Retry dedupe (see historyEndsWithIncoming): when the loaded history already ends with this
    // turn's incoming (a prior attempt write-ahead-appended it), do NOT concat it again — the model
    // would see the user message twice and writeAheadIncoming would store it twice.
    const alreadyStored = historyEndsWithIncoming(history, incoming);
    rest.messages = alreadyStored ? [...history] : [...history, ...incoming];
    if (mc.system) rest.system = [rest.system, mc.system].filter(Boolean).join('\n\n');
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
    return { incoming, wmTool: mc.tools, alreadyStored, provenance };
  }
  // Legacy path (BasicMemory / SemanticMemory) — provenance is the limited truth this path can see:
  // everything loaded counts as the recent window (no recall refs, no OM).
  const history = await memory.getMessages(threadId, { query: lastUserText(rawIncoming), resourceId: rid });
  const incoming = dropEchoedHistory(history, rawIncoming);
  const alreadyStored = historyEndsWithIncoming(history, incoming);
  rest.messages = alreadyStored ? [...history] : [...history, ...incoming];
  let wmChars: number | undefined;
  if (memory.getWorkingMemory) {
    const wm = await memory.getWorkingMemory(threadId);
    if (wm) {
      rest.system = [rest.system, `# Working Memory\n${wm}`].filter(Boolean).join('\n\n');
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
  return { incoming, alreadyStored, provenance };
}

/**
 * 8.7 Input processors: BEFORE persistInput, only if the input hasn't been journaled yet.
 * → the transformed input gets journaled; on resume this block is skipped → the processor does NOT run again.
 */
async function applyInputProcessors(
  processors: Processor[],
  procCtx: ProcessorCtx,
  journal: Journal,
  runId: string,
  rest: PreparedInput,
): Promise<void> {
  if ((await journal.get(runKeys.input(runId))) !== undefined) return;
  let pin: ProcessorInput = { system: rest.system, messages: rest.messages, prompt: rest.prompt };
  for (const p of processors) {
    if (p.processInput) pin = await p.processInput(pin, procCtx);
  }
  rest.system = pin.system;
  rest.messages = pin.messages;
  rest.prompt = pin.prompt;
}

/** 8.7 Tool processors (toolFilter/toolSearch): restrict the tool set the model sees.
 *  `input` is added to the ctx (toolSearch uses the last user message as a signal); async
 *  processors are supported — a non-deterministic selection is journaled via ctx.step (resume gets the same subset). */
async function applyToolProcessors(
  processors: Processor[],
  procCtx: ProcessorCtx,
  tools: Record<string, any>,
  input?: { system?: string; messages?: any[]; prompt?: unknown },
): Promise<Record<string, any>> {
  const ctx: ProcessorCtx = { ...procCtx, input };
  let out = tools;
  for (const p of processors) {
    if (p.processTools) out = await p.processTools(out, ctx);
  }
  return out;
}

// review finding A (see task note): previously claiming the marker with boolean `true`/absent meant
// that when append threw a TRANSIENT error, the marker was left PERMANENTLY 'claimed' — a legitimate
// retry with the same runId ALWAYS lost the claim, so append was skipped FOREVER (permanent loss of
// conversation history; the old get→put was at least self-healing). Fix: a two-phase marker —
// `{status:'pending', startedAt}` (append has NOT finished yet, only CLAIMED) → promoted to `true`
// (DONE) once append SUCCEEDS.
const MEM_APPEND_TTL_MS = 60_000; // staleness threshold for a 'pending' record — same order of magnitude as the H7/§5.3 claim TTLs.

type MemAppendMarker = true | { status: 'pending'; startedAt: number };

/**
 * Claim the memory-append marker. Three outcomes:
 *  - Returns `undefined` → SKIP the append: the marker is `true` (finished) or another worker has a
 *    FRESH (< MEM_APPEND_TTL_MS) pending claim (in-flight, no self-heal needed).
 *  - Returns an object → YOU do the append: either you won a fresh `claim` on an empty key, or you
 *    took over a STALE pending claim (crash/transient-error self-heal — see task note finding A). When
 *    done, promote it to `true` with `markMemoryAppendDone(journal, marker, the-returned-object)`.
 * Takeover is atomic if putIfMatch(CAS) is available: even if two workers see the same stale pending
 * claim, only ONE takes it over. Otherwise falls back to a best-effort put — the SAME narrow window
 * as the old get→put (documented, CORE-HARDENING §2.2).
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
 * takeover happened, it's a no-op, harmless: the new owner will already do/have done its own append).
 * NARROW WINDOW (documented, the SAME window as the old get→put): if append succeeds but a crash
 * happens BEFORE this call starts, the marker stays 'pending' → the NEXT retry takes it over after
 * the TTL and tries the append ONE MORE TIME (double-append) — the safer side compared to a missing
 * message (old behavior: lost forever), and the window is very narrow (about the width of one put call).
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
 * first model call. The thread ROW was already write-ahead (AgentMemory.loadContext →
 * ensureThreadIndexed creates it, titled from the first user message, before any token arrives) —
 * but the MESSAGES only landed at completion, so a run that died before its first token left a
 * titled-but-EMPTY thread: the user's own message was gone from every read surface even though the
 * journal's `:input` still held it. Appending `incoming` here closes that asymmetry; the
 * completion-time append (both call sites below) then persists only the PRODUCED messages.
 *
 * Idempotency is two-layered, mirroring the completion marker:
 *  - `alreadyStored` (prepareMemoryContext's tail-dedupe) — covers retries across DIFFERENT runIds
 *    re-sending the identical text (the playground mints a fresh runId per attempt).
 *  - the `memUserAppended` two-phase marker — covers SAME-runId retries racing concurrently, where
 *    the tail check can't see the other worker's in-flight append.
 *
 * DELIBERATELY NOT try/caught: this runs pre-model, so failing the run here is cheap (no tokens
 * spent) and honest — completing a turn whose user message could not be persisted would produce a
 * transcript with an answer but no question.
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
  const marker = runKeys.memUserAppended(runId);
  const pending = await claimMemoryAppend(journal, marker);
  if (!pending) return;
  await memory.append(threadId, incoming);
  // PHASE 3: provenance stamp for the incoming half — the completion append stamps only `produced`.
  await recordAppendedTaintProvenance(journal, runId, threadId, limits, incoming);
  await markMemoryAppendDone(journal, marker, pending);
}

/**
 * F4 (RISK-AUDIT-DURABILITY): a SAME-runId re-entry (resume after suspension, retry) whose
 * write-ahead already landed, but where OTHER turns were appended to the thread in between — the
 * tail-dedupe no longer matches (this run's incoming isn't the thread tail anymore), so the prompt
 * would carry the question twice: once inside the loaded history, once re-concatenated at the end.
 * Memory itself was never at risk (the memUserAppended marker blocks the re-append); this is purely
 * a prompt-fidelity fix. Keyed off the marker being DONE plus an explicit containment check — if
 * compaction/windowing dropped the stored copy out of the loaded context, the re-concatenated one is
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
 * TAINT PHASE 3 (opt-in `taintLifetime: 'content-window'`): after a successful memory append, stamp
 * the appended messages' content hashes into the thread's provenance record IF untrusted content
 * DIRECTLY entered this run (source 'tool'/'processor' — `readDirectRunTaint`; runs that only
 * INHERITED taint are deliberately NOT stamped, see taint.ts directTaintKey). ALL of the run's
 * appended messages are stamped, not just the untrusted tool result — conservative over-stamping (the
 * model's same-turn output may quote the poison), safe direction. The SINGLE shared hook for the
 * runDurable and streamDurable append sites — parity must not be broken. Runs inside the append
 * marker's `pending` window → written once per run; a crash between append and this write leaves NO
 * provenance, which the expiry check treats as "cannot prove absence" (keeps taint — fail-safe), and
 * the marker-takeover retry re-appends AND re-stamps. Never throws (recordTaintProvenance discipline).
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
 * throws → fall back to a prototype-chained copy: returns a shadow copy without touching the original object.
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

// D4-retry (AUDIT-R2 follow-up): bounded TURN-level retry-with-feedback ladder for
// runDurableInner ONLY (see StreamDurableArgs.processors doc / streamDurable body for the honest stream
// bound — a stream that already flushed to the client cannot be retried, that's a different contract).
// A processor's processOutputStep/processOutput may throw ProcessorRetry to mean "this turn's output is
// unacceptable — give the model my feedback and try the WHOLE turn again." We do NOT retry a single
// step inside generateText's own tool loop (we don't own that loop): we catch the throw/rejection,
// append the feedback as a NEW user message to the SAME options.messages the turn started with (the
// rejected attempt's own output is deliberately NOT re-shown — a processor just deemed it unacceptable,
// re-injecting it back into context would undercut the point), and call generateText(options) again.
// `options.model`/`options.tools`/`options.onStepFinish` are built ONCE by the caller and REUSED across
// attempts on purpose: withDurableModel's step counter lives in that one closure, so the retry's model
// steps continue from where the prior attempt left off onto FRESH journal keys — no collision (see
// durable-model.ts). A run with no ProcessorRetry-throwing processor never takes the catch branch below
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
): Promise<{ result: any; interrupts: Interrupt[] }> {
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
    // re-runs the processor too (see processOutputStep's REPLAY NOTE), but the decision acted on here is
    // the journaled one, not a fresh re-consultation.
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

    // K1 + GOREV W1: a block sentinel OR a tool-step limit stopped the composeStopWhen loop → convert
    // to a real typed error and throw (unrelated to the retry ladder — never retried).
    const finishError = streamFinishError((result as any).steps ?? []);
    if (finishError) throw finishError;

    const interrupts: Interrupt[] = [];
    for (const step of (result as any).steps ?? []) {
      for (const part of step.content ?? []) {
        if (hasSuspend(part)) interrupts.push(part.output.__gnl_suspend);
      }
    }

    // 8.7 Output processors: run ONLY on a completed run (not suspended) — same as before D4-retry,
    // now with a catch for ProcessorRetry.
    if (procCtx && interrupts.length === 0) {
      let pout: ProcessorOutput = {
        text: (result as any).text,
        messages: (result as any).response?.messages ?? [],
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
      // result.text/response may be getter-only → shadow with an own data property (assign would blow up).
      result = shadowProps(result, {
        text: pout.text,
        response: { ...(result as any).response, messages: pout.messages },
      });
    }

    return { result, interrupts };
  }
}

/**
 * Drop-in `generateText`: runs the model + tools through durable wrappers.
 * `resume` = call again with the same `runId` + `journal` (+ `approvals`) → replay from the journal.
 */
export async function runDurable(args: RunDurableArgs): Promise<DurableResult> {
  // GOREV (saga): a COMPENSATED (unwound) run refuses to run/resume — replaying memoized successes
  // on top of an already-reverted world would silently "complete" a transaction that was undone.
  await assertNotCompensated(args.journal, args.runId);
  // P2-cancel: same terminal-refusal contract as compensation — a durably-canceled run never
  // (re)starts or resumes (the per-step mid-flight gate lives in durable-model.ts).
  await assertNotCanceled(args.journal, args.runId);
  const lock = (args as any).lock;
  if (lock) {
    const handle = await acquireRunLock(args.journal, args.runId, lock.owner, lock.ttlMs);
    if (!handle) throw new RunBusyError(`run '${args.runId}' is locked by another process`);
    // B4 (heartbeat): the lock was acquired ONCE and never renewed — a run that legitimately outlives
    // `ttlMs` let a second worker take over mid-run (two live runs of the same runId). Renew on a beat
    // shorter than the TTL (ttlMs/2, min 1ms) so the lock stays held for as long as the body runs.
    // Best-effort: a failed renew is swallowed (the next beat retries; a genuine takeover fences it out).
    // The timer is unref'd (never keeps the process alive) and cleared in `finally`; any in-flight renew
    // is awaited BEFORE release so a late renew can't revive the just-released lock.
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
  const { journal, runId, guard, approvals, memory, threadId, resourceId, agentName, replay, lock: _lock, processors, schemaCompat, limits, exclusiveModelStep, replayCacheMaxBytes, toolPolicy, timeouts, model, tools, stopWhen, ...rest } =
    args as RunDurableArgs & Record<string, any>;
  // AUDIT (approval first-class): BEFORE ctx is set up — claim the parameter's approvals into the
  // journal + merge with the journal's existing approvals (see the resolveApprovals header).
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
  if (memory && threadId) {
    ({ incoming, wmTool, alreadyStored: incomingStored, provenance: memCtx } = await prepareMemoryContext(memory, threadId, resourceId, rest));
    // F4: same-runId re-entry with interleaved turns — drop the re-concat if the stored copy is visible.
    incomingStored = await dropIncomingIfAppendedEarlier(journal, runId, rest, incoming, incomingStored);
  }

  if (procCtx) await applyInputProcessors(processors!, procCtx, journal, runId, rest);

  await persistInput(journal, runId, rest, threadId, agentName);
  await persistMemoryContext(journal, runId, memCtx);
  // AUDIT B2: freeze `limits` into the journal on the first run (idempotent via `claim` — the FIRST
  // run's limits win, a later resume never overwrites them). resumeRun reads this back when the caller
  // doesn't re-supply `limits`, so a resumed run keeps its cost cap / loop / duplicate / taint gates.
  if (limits) await claim(journal, runKeys.cfgLimits(runId), limits);
  // WRITE-AHEAD user message (see writeAheadIncoming): journal `:input` first (the WAL), then memory —
  // a run that fails before its first token keeps the user's message visible in the thread.
  if (memory && threadId) await writeAheadIncoming(journal, memory, threadId, runId, incoming, incomingStored, limits);
  // AUDIT A4 (opt-in `taintScope: 'thread'`): if a prior turn on this thread was tainted, mark THIS
  // run tainted BEFORE the agent loop — the taint gate then fires for this run's side effects.
  // PHASE 3: `rest.messages` here is the FINAL visible context (memory + processors already applied)
  // — exactly what the model sees, which is what content-window expiry must be judged against.
  await inheritThreadTaint(journal, runId, threadId, limits, { messages: rest.messages, memory });

  // Phase 14: also merge in rich memory's updateWorkingMemory tool → durableTools wraps it (journaled).
  let effectiveTools = wmTool ? { ...tools, ...wmTool } : tools;
  if (procCtx && effectiveTools) effectiveTools = await applyToolProcessors(processors!, procCtx, effectiveTools, rest);

  // 8.8 Schema-compat (opt-in): provider-specific tool-schema transformation. PURE + BEFORE the model
  // call + BEFORE durableTools wraps it → doesn't touch the journal, argsHash/toolCallId/replay unaffected.
  // Lazy import: if unused, @gnldev/schema-compat is never loaded (keeps the durable core thin).
  if (schemaCompat && effectiveTools) {
    const { applyToolCompat, defaultRules } = await import('@gnldev/schema-compat');
    const rules = schemaCompat === true ? defaultRules : schemaCompat;
    effectiveTools = applyToolCompat(effectiveTools, model, rules);
  }

  const options: any = {
    ...rest,
    // §5.3 + Y1: exclusiveModelStep/stepTimeoutMs flow into withDurableModel as opt-in (identical to before if not provided).
    model: withDurableModel(model as LanguageModelV2, ctx,
      (exclusiveModelStep || timeouts?.modelStepMs) ? { exclusiveStep: exclusiveModelStep, stepTimeoutMs: timeouts?.modelStepMs } : undefined),
    stopWhen: composeStopWhen(stopWhen),
  };
  if (effectiveTools) options.tools = durableTools(effectiveTools, ctx);
  // P2-step: per-step processor hooks (common per-step-processor parity, v1) — bridged to the AI SDK's own per-iteration
  // callbacks. Only set when a processor implements the hook (undefined = zero behavior change).
  if (procCtx && processors?.length) {
    const prep = composePrepareStep(processors as Processor[], procCtx);
    if (prep) options.prepareStep = prep;
    const onStep = composeOnStepFinish(processors as Processor[], procCtx);
    if (onStep) options.onStepFinish = onStep;
  }

  // D4-retry: generateText + finishError/suspend handling + the output-processor gate, wrapped in the
  // bounded retry-with-feedback ladder (see runGenerateWithRetryLadder above for the full contract —
  // includes the K1/GOREV W1 sentinel-to-error conversion and the 8.7 output-processor pass, byte-for-
  // byte unchanged for a run with no ProcessorRetry-throwing processor).
  const { result: ladderResult, interrupts } = await runGenerateWithRetryLadder(options, processors, procCtx, journal, runId);
  let result = ladderResult;

  // Memory: idempotent append on completion (not suspended) — resume/retry does NOT double-write.
  // TWO-PHASE MARKER (review finding A — see claimMemoryAppend/markMemoryAppendDone): if the pending
  // claim is STALE (crash/transient-error), the NEXT retry SELF-HEALS — with the old boolean-claim,
  // if append threw an error the marker stayed permanently 'claimed' and history was lost FOREVER.
  // DELIBERATELY NOT WRAPPED in try/catch: let the error propagate to the CALLER (runDurable rejects)
  // — thanks to the pending marker, a legitimate retry with the SAME runId retries the append (see the
  // memory self-heal tests).
  if (memory && threadId && interrupts.length === 0) {
    const marker = runKeys.memAppended(runId);
    const pending = await claimMemoryAppend(journal, marker);
    if (pending) {
      // PRODUCED only — `incoming` was already persisted pre-model by writeAheadIncoming (or was
      // found already stored by the tail-dedupe); re-appending it here would duplicate the turn.
      // F3 note (deliberate): under CONCURRENT turns on one thread, messages land in SEND order and
      // answers in COMPLETION order — the transcript reflects what actually happened, rather than the
      // old atomic-pair append that reordered reality into adjacent Q/A pairs.
      const produced = (result as any).response?.messages ?? [];
      // F5: if this run's write-ahead was skipped over ANOTHER worker's pending claim and that claim
      // has since gone STALE (crashed before appending), take it over now — the question rides along
      // with the answer instead of being lost. A still-FRESH claim keeps the safe-side skip (the
      // owner may yet land it); that sub-TTL window is the documented residual.
      let userPending: { status: 'pending'; startedAt: number } | undefined;
      if (!incomingStored && incoming.length > 0) {
        userPending = await claimMemoryAppend(journal, runKeys.memUserAppended(runId));
      }
      const appended = userPending ? [...incoming, ...produced] : produced;
      await memory.append(threadId, appended);
      // PHASE 3: stamp content provenance for directly-tainted runs (content-window expiry input).
      await recordAppendedTaintProvenance(journal, runId, threadId, limits, appended);
      if (userPending) await markMemoryAppendDone(journal, runKeys.memUserAppended(runId), userPending);
      await markMemoryAppendDone(journal, marker, pending);
    }
  }

  // 1.1: IF the run COMPLETED (not suspended), increment the organization usage counter —
  // checkBudget/getOrgUsage reads this in O(1) (instead of a full-run-scan). Best-effort: if something
  // goes wrong, it does NOT affect the run.
  if (interrupts.length === 0) {
    try { await recordRunUsage(journal, runId); } catch { /* counter is optional — must not affect the run */ }
    // P1.6b: materialized metrics at the SAME choke point — this covers run()/resume/bare runDurable in
    // one place (the registry-level hook was removed for exactly this reason: single source, and the
    // stream path below gets the same call in its onFinish). Best-effort like the usage counter; the
    // claim/applyBatch inside recordRunMetrics makes an accidental double call a no-op.
    try {
      await recordRunMetrics(journal, journal as unknown as JournalReader, runId, agentName ? { agentName } : {});
    } catch { /* advisory aggregate — must not affect the run */ }
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
   * GOREV (safety-config parity on resume — caught by taint-guard.test.ts): resumeRun used to FORWARD
   * ONLY model/tools/guard/approvals — a resumed run silently LOST its entire protection config
   * (maxCostUsd/maxTokens ceilings, loopDetection, sideEffectDuplicates, taintedSideEffects all
   * reverted to defaults). The most dangerous shape of that hole: an approvals resume of a SUSPENDED
   * run — the human approves ONE call, and the continuation runs unguarded. Pass the SAME limits the
   * original run used.
   *
   * AUDIT B1: `limits` alone was not enough — resume also silently dropped `processors` (prompt-injection
   * tool-result redaction/flagging), `lock`, `timeouts`, `exclusiveModelStep`, `schemaCompat`, and
   * `toolPolicy`. The whole protection set must survive resume; pass the SAME config the original run used.
   */
  limits?: RunLimits;
  processors?: Processor[];
  lock?: { owner: string; ttlMs: number };
  timeouts?: { modelStepMs?: number; toolMs?: number; claimTtlMs?: number };
  exclusiveModelStep?: { ttlMs?: number };
  schemaCompat?: boolean | SchemaCompatRule[];
  toolPolicy?: 'strict';
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
  // AUDIT B2: `limits` is a runtime value the CLI/embed callers can't re-supply (it isn't part of
  // AgentConfig). If the caller passes `limits`, it wins (explicit override); otherwise recover the
  // limits frozen at run start from the journal so the resumed run keeps its cost cap / loop /
  // duplicate / taint gates instead of silently reverting to no-limits.
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
    // AUDIT B1: forward the FULL protection set (not just limits) — processors especially, so
    // tool-result redaction runs on the approved call during resume.
    ...(opts.processors ? { processors: opts.processors } : {}),
    ...(opts.lock ? { lock: opts.lock } : {}),
    ...(opts.timeouts ? { timeouts: opts.timeouts } : {}),
    ...(opts.exclusiveModelStep ? { exclusiveModelStep: opts.exclusiveModelStep } : {}),
    ...(opts.schemaCompat !== undefined ? { schemaCompat: opts.schemaCompat } : {}),
    ...(opts.toolPolicy ? { toolPolicy: opts.toolPolicy } : {}),
    ...(input.messages ? { messages: input.messages } : {}),
    ...(input.prompt ? { prompt: input.prompt } : {}),
    ...(input.system ? { system: input.system } : {}),
    // AUDIT A4: recover the threadId frozen into `:input` — a resumed run under `taintScope: 'thread'`
    // must keep the thread carry (inherit at start + write the thread key on a NEW post-resume
    // untrusted call). No memory is attached here, so this changes nothing else (memory recall needs
    // `memory && threadId`).
    ...(input.threadId ? { threadId: input.threadId } : {}),
  } as any);
}

/**
 * The durable counterpart of `streamText` — model/tools are wrapped, input is journaled.
 * Memory + processor scope goes through the SAME helpers as runDurable (parity must not be broken);
 * the only difference: output processors are applied only to messages being persisted (streamed
 * deltas cannot be transformed).
 *
 * K1/GOREV W1 NOTE (B) — AUDIT B3(b), READ THIS IF YOU CONSUME `fullStream` DIRECTLY: a
 * loop/maxToolCalls/duplicate/tainted BLOCK does NOT throw from the stream — the blocked/limit/suspend
 * SENTINEL (`__gnl_blocked`/`__gnl_limit_exceeded`) leaks into `fullStream` as an internal tool-result
 * part. This is DELIBERATE: @gnldev/server sse.ts / @gnldev/agui rely on it — they skip the sentinel part in
 * `fullStream` and, AFTER the stream ends, scan `steps` (`limitBreachFromSteps`/`blockedFromSteps`) to
 * emit ONE terminal `error` event. Surfacing the breach as a `{type:'error'}` fullStream part instead
 * would make those consumers emit a DOUBLE error event (the injected part + their post-scan), so it is
 * NOT done. (Asymmetry: maxCost/maxTokens DO throw from the stream flush — durable-model — so only the
 * tool-gate blocks are sentinel-only in `fullStream`.) As a DIRECT consumer you catch the breach in one
 * of THREE ways (recommended first):
 *   1. `await result.text` (or any other terminal result promise — content/response/toolCalls/…)
 *      REJECTS with the TYPED error when a block/limit fired, mirroring runDurable's throw — a
 *      happy-path consumer cannot silently miss it. EXCEPTIONS that deliberately keep the sentinel
 *      contract and NEVER reject for a breach: `steps`, `finishReason`, `usage`, `request`, `warnings`
 *      and the streams (`fullStream`/`textStream`) — sse.ts/agui/studio post-scan `steps` and must not
 *      get a reject (see guardStreamTerminalPromises).
 *   2. Pass `onBlocked` (StreamDurableArgs / registry RunOptions): invoked once at stream finish with
 *      the RAW structured breach `{ kind, message, detail }` — ideal when you only read `fullStream`
 *      and never await a terminal promise.
 *   3. Manually call `streamFinishError(steps)` (exported here) with onFinish's `ev.steps` (or your
 *      accumulated step list) — returns the TYPED error to throw, `undefined` otherwise. This is what
 *      sse.ts/agui effectively do via `limitBreachFromSteps`/`blockedFromSteps`.
 * Prefer `runDurable` if you don't want to own any of this.
 */
export async function streamDurable(args: StreamDurableArgs) {
  // GOREV (saga): same refusal as runDurable — a compensated run never streams either.
  await assertNotCompensated(args.journal, args.runId);
  // P2-cancel: same terminal-refusal contract as compensation — a durably-canceled run never
  // (re)starts or resumes (the per-step mid-flight gate lives in durable-model.ts).
  await assertNotCanceled(args.journal, args.runId);
  const { journal, runId, guard, approvals, memory, threadId, resourceId, agentName, replay, lock, processors, schemaCompat, limits, exclusiveModelStep, replayCacheMaxBytes, toolPolicy, timeouts, model, tools, stopWhen, onBlocked, ...rest } =
    args as StreamDurableArgs & Record<string, any>;
  // AUDIT B3(a): opt-in run-lock — acquire BEFORE the setup work (reject a concurrent stream/run of the
  // same runId with RunBusyError). Released on stream finish/error (see the onFinish/onError wrappers).
  // No heartbeat by design (see StreamDurableArgs.lock) — a streamed lock relies on ttlMs for takeover.
  const lockHandle = lock ? await acquireRunLock(journal, runId, lock.owner, lock.ttlMs) : null;
  if (lock && !lockHandle) throw new RunBusyError(`run '${runId}' is locked by another process`);
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
  if (memory && threadId) {
    ({ incoming, wmTool, alreadyStored: incomingStored, provenance: memCtx } = await prepareMemoryContext(memory, threadId, resourceId, rest));
    // F4: same-runId re-entry with interleaved turns — parity with runDurableInner.
    incomingStored = await dropIncomingIfAppendedEarlier(journal, runId, rest, incoming, incomingStored);
  }

  if (procCtx) await applyInputProcessors(processors!, procCtx, journal, runId, rest);

  await persistInput(journal, runId, rest, threadId, agentName);
  await persistMemoryContext(journal, runId, memCtx);
  // AUDIT B2: freeze `limits` on the first run (parity with runDurableInner) — idempotent via `claim`.
  if (limits) await claim(journal, runKeys.cfgLimits(runId), limits);
  // WRITE-AHEAD user message (parity with runDurableInner — see writeAheadIncoming). Pre-model, so a
  // memory failure rejects gnl.stream() itself (a clean JSON error) instead of surfacing mid-SSE.
  if (memory && threadId) await writeAheadIncoming(journal, memory, threadId, runId, incoming, incomingStored, limits);
  // AUDIT A4: same run-start thread-taint inheritance as runDurableInner (opt-in; parity).
  // PHASE 3: same content-window visibility input as runDurableInner (parity).
  await inheritThreadTaint(journal, runId, threadId, limits, { messages: rest.messages, memory });

  let effectiveTools = wmTool ? { ...tools, ...wmTool } : tools;
  if (procCtx && effectiveTools) effectiveTools = await applyToolProcessors(processors!, procCtx, effectiveTools, rest);

  // 8.8 Schema-compat (opt-in): see runDurableInner — pure, before the model call + before durableTools.
  if (schemaCompat && effectiveTools) {
    const { applyToolCompat, defaultRules } = await import('@gnldev/schema-compat');
    const rules = schemaCompat === true ? defaultRules : schemaCompat;
    effectiveTools = applyToolCompat(effectiveTools, model, rules);
  }

  const options: any = {
    ...rest,
    // §5.3 + Y1: SAME opt-in flow as runDurableInner (see the note there).
    model: withDurableModel(model as LanguageModelV2, ctx,
      (exclusiveModelStep || timeouts?.modelStepMs) ? { exclusiveStep: exclusiveModelStep, stepTimeoutMs: timeouts?.modelStepMs } : undefined),
    stopWhen: composeStopWhen(stopWhen),
  };
  if (effectiveTools) options.tools = durableTools(effectiveTools, ctx);
  // P2-step: SAME per-step hook bridging as runDurableInner (parity contract — see the note there).
  // streamText supports the same prepareStep/onStepFinish surface; onFinish wrapping below is untouched.
  if (procCtx && processors?.length) {
    const prep = composePrepareStep(processors as Processor[], procCtx);
    if (prep) options.prepareStep = prep;
    const onStep = composeOnStepFinish(processors as Processor[], procCtx);
    if (onStep) options.onStepFinish = onStep;
  }
  // Stream finish: output processors (only messages being persisted) + idempotent memory append
  // (marker; stream/non-stream do not double-write, replay-safe). ProcessorTripwire blocks the append
  // but cannot retroactively stop the stream — use an input processor for moderation in streaming.
  // SUSPEND PARITY (audit): IF the run IS SUSPENDED (suspend/limit/block sentinel), completion side
  // effects are NOT processed — same principle as runDurableInner. The old behavior wrote the half
  // conversation to memory and locked the marker → once resume completed, the FINAL answer never made
  // it into memory at all.
  {
    const prevOnFinish = options.onFinish;
    options.onFinish = async (ev: any) => {
      const stepsArr: any[] = ev?.steps ?? [];
      // AUDIT B3(b): visibility callback — a block/limit sentinel at stream finish → hand the caller
      // the RAW structured breach. Advisory: a throw is swallowed with a console.warn (same policy as
      // the memory-finalization warn below) — it must never break the stream or mask the typed error
      // the terminal promises reject with.
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
          let produced: any[] = ev?.response?.messages ?? [];
          if (procCtx) {
            let pout: ProcessorOutput = { text: ev?.text ?? '', messages: produced, result: ev };
            // NOTE (deliberate limitation): a ProcessorRetry thrown here is NOT retried — unlike
            // runDurableInner's retry ladder, this fires AFTER the stream has already flushed to the
            // client, so "let the model try again" would mean re-streaming a turn the caller already
            // saw — a different contract we deliberately do not contort this into. It is caught by the
            // catch below like any other processOutput throw (console.warn, stream itself not broken).
            // Use runDurable/generateText for a processor that needs retry-with-feedback.
            for (const p of processors as Processor[]) {
              if (p.processOutput) pout = await p.processOutput(pout, procCtx);
            }
            produced = pout.messages;
          }
          if (memory && threadId) {
            // TWO-PHASE MARKER — SAME pattern/parity as runDurableInner (see claimMemoryAppend).
            // Here INSIDE a try/catch (below) → if append throws, the marker stays 'pending': the
            // NEXT resume/retry (SAME runId) self-heals after the TTL; on this turn the error is
            // made VISIBLE via console.warn but the stream is NOT BROKEN (streamText's own contract).
            const marker = runKeys.memAppended(runId);
            const pending = await claimMemoryAppend(journal, marker);
            if (pending) {
              // PRODUCED only — `incoming` went in pre-model via writeAheadIncoming (parity with
              // runDurableInner's completion append above, including the F3/F5 notes there).
              let userPending: { status: 'pending'; startedAt: number } | undefined;
              if (!incomingStored && incoming.length > 0) {
                userPending = await claimMemoryAppend(journal, runKeys.memUserAppended(runId));
              }
              const appended = userPending ? [...incoming, ...produced] : produced;
              await memory.append(threadId, appended);
              // PHASE 3: provenance stamp — parity with runDurableInner (shared helper).
              await recordAppendedTaintProvenance(journal, runId, threadId, limits, appended);
              if (userPending) await markMemoryAppendDone(journal, runKeys.memUserAppended(runId), userPending);
              await markMemoryAppendDone(journal, marker, pending);
            }
          }
        } catch (err) {
          // NO silent swallowing (audit): history could not be written for this run — surface it, don't break the stream.
          console.warn(`@gnldev/durable: '${runId}' stream memory/processor finalization failed — conversation history may be incomplete:`, err);
        }
        // 1.1: usage counter only on a COMPLETED run (parity with runDurableInner; not counted while suspended).
        try { await recordRunUsage(journal, runId); } catch { /* counter is optional — must not affect the stream */ }
        // P1.6b: materialized metrics — PARITY with runDurableInner's completion hook (this closes the
        // former registry TODO: streamed runs no longer depend on a manual backfill to be counted).
        try {
          await recordRunMetrics(journal, journal as unknown as JournalReader, runId, agentName ? { agentName } : {});
        } catch { /* advisory aggregate — must not affect the stream */ }
      }
      // AUDIT B3(a): the stream has finished (completed OR suspended) → release the run-lock so a resume
      // can proceed. Token-fenced + idempotent: a no-op if the lock was already taken over/released.
      if (lockHandle) { try { await lockHandle.release(); } catch { /* release is best-effort; TTL reclaims */ } }
      if (prevOnFinish) await prevOnFinish(ev);
    };
    // AUDIT B3(a): also release on a stream error (onFinish may not fire on the error path). release()
    // is idempotent, so a later onFinish release is harmless. On abandonment (neither fires), TTL reclaims.
    if (lockHandle) {
      const prevOnError = options.onError;
      options.onError = async (ev: any) => {
        try { await lockHandle.release(); } catch { /* best-effort; TTL reclaims */ }
        if (prevOnError) await prevOnError(ev);
      };
    }
  }
  try {
    // AUDIT B3(b): wrap the result so the terminal promises (result.text & friends) REJECT with the
    // typed streamFinishError when a block/limit sentinel fired — see guardStreamTerminalPromises.
    return guardStreamTerminalPromises(streamText(options));
  } catch (err) {
    // streamText threw synchronously during setup → release the lock we just acquired (onFinish/onError
    // will never fire for this call).
    if (lockHandle) { try { await lockHandle.release(); } catch { /* best-effort */ } }
    throw err;
  }
}
