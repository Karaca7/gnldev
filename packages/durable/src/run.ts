import { generateText, streamText, stepCountIs } from 'ai';
import type { ToolSchemaRuleLike } from './types.js';
import type { StreamTextResult } from 'ai';
import { withDurableModel } from './durable-model.js';
import { durableTools, CLAIM_TTL_MS } from './durable-tool.js';
import { acquireRunLock } from './run-lock.js';
import { RunBusyError, runBusyMessage, SideEffectRetryBlockedError, RetryLimitExceededError, RunThreadMismatchError, RunInputMismatchError, RunActorMismatchError, RunOwnerMismatchError, RunSweptError, ThreadOwnerMismatchError, NotAnAgentRunError } from './errors.js';
import { argsHash, rawInputFingerprint, isDerivedRunId, DERIVED_RUN_ID_PREFIX, type WorkScope, type WorkScopeKind } from './hash.js';
import { recordIdemConflict } from './idem-ledger.js';
import { createProcessorCtx, composePrepareStep, composeOnStepFinish, durableProcessorStep, ProcessorRetry, RetryExhaustedByProcessorError, type StepHookFailure } from './processor.js';
import { loadReplayCache, runKeys, claim } from './journal.js';
// Statically safe: model-router imports only ./journal, and the provider packages it can reach are
// behind dynamic import(), so this costs the core bundle nothing.
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
import { runFailed, runFailedIfUnrecorded, runStarted, runSucceeded, classifyRunError, isRunFailure, readRunOutcome } from './outcome.js';

type GenerateTextOptions = Parameters<typeof generateText>[0];
type StreamTextOptions = Parameters<typeof streamText>[0];

/** `generateText` arguments + `journal` + `runId` + optional `guard`/`approvals`. */
export type RunDurableArgs = GenerateTextOptions & {
  journal: Journal;
  runId: string;
  guard?: Guard;
  approvals?: Record<string, boolean>;
  /**
   * Conversation memory: if provided, thread history is loaded + appended idempotently on completion.
   *
   * `false` means the SAME thing as absent to every branch below — it is falsy, and every memory path
   * is guarded by `memory && threadId`. What it adds is intent: it is how a caller says "no memory, on
   * purpose", which is what silences the `threadId` warning (see warnThreadIgnored). The spelling
   * mirrors `CreateGnlConfig.memory`, which has carried the same `| false` for the same reason.
   */
  memory?: Memory | false;
  threadId?: string;
  /** Phase 14: resource (user) identity — for resource-scope recall / cross-thread memory. */
  resourceId?: string;
  /** Kanal etiketi — XID origin'i ve tekrar sorularının "nereden" bilgisi (bkz. DurableCtx.channel). */
  channel?: string;
  /** The agent's registry name — frozen into the invisible `:input` entry so studio /runs can LABEL
   *  each run with its agent (surfaced by listRuns, no per-run journal N+1). Optional (direct runDurable
   *  callers may omit it); the registry passes the agent key. */
  agentName?: string;
  /**
   * THE CALLER'S NAME FOR THIS UNIT OF WORK — recorded, and ONLY recorded.
   *
   * Read the sentence twice, because this field's whole design (docs/RUNID-WORKKEY-HEYET-KARARI.md
   * §1) is that a workKey DERIVES the runId — and here it does not. On this surface the runId is
   * still the raw one you passed, the journal prefix is still that id, and nothing about routing,
   * dedup or admission consults this string. It rides into the frozen `:input` entry so the journal
   * can answer "which run was the invoice job?" (`listRunsPaged({ workKey })`) and so studio has a
   * label to show. The gate that turns a workKey into `run1_<digest>` is package #3 and does not
   * exist yet; passing this today buys visibility, not identity.
   *
   * The raw-runId surface (§7) stays raw permanently, by the way — resume and fork cannot reverse a
   * hash, so `runDurable` must always be callable with an id. What changes in #3 is who MINTS it.
   *
   * A workKey is a BUSINESS NAME (the invoice being issued, tonight's reconciliation), not a session
   * id and not a random retry token — and it is echoed in error details and shown on operator
   * screens, so keep sensitive data out of it.
   */
  workKey?: string;
  /**
   * Which address the `workKey` above is unique WITHIN — recorded alongside it, and equally inert on
   * this surface today: the engine does not validate the pair, does not check `value` against
   * `resourceId`, and does not refuse a `'resource'` scope with no owner. Those are the gate's job
   * (§6, package #3), and doing half of them here would be the worse outcome — a check that runs on
   * one door teaches callers a rule the other doors do not keep.
   */
  workScope?: WorkScope;
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
  toolPolicy?: 'strict' | 'strict-critical';
  /** FAZ-4 (critical profile): refuse a runId re-used with DIFFERENT content — the raw caller input
   *  Is fingerprinted at freeze time; a later call whose fingerprint differs gets
   *  RunInputMismatchError (409, no resumable). Exemption: approvals addressing a toolCallId whose
   *  Journal record is genuinely 'suspended' (the chat approval re-POST carries a grown history). */
  strictInput?: boolean;
  /** FAZ-4: append PII-free refusal records (`idem:conflict:*`) for busy/mismatch/swept conflicts — see idem-ledger.ts. */
  conflictLedger?: boolean;
  /** FAZ-7: 'require' makes the ledger append a PRECONDITION of the refusal — its failure propagates
   *  Instead of warning (never refuse unrecorded). Default 'best-effort'. Only meaningful with conflictLedger. */
  auditOnReject?: 'best-effort' | 'require';
  /**
   * Replay-disclosure policy. 'silent' (default): existing behavior — replayed tool results are
   * indistinguishable to the model, only the result envelope (`replayedToolCalls`) carries the fact.
   * 'explain': a TRANSIENT per-step note (never persisted, never in thread memory) tells the model —
   * strictly AFTER the call was already answered from the journal — that the result is the record of
   * earlier work, so it narrates honestly instead of announcing a fresh success. See withReplayDisclosure.
   */
  replayDisclosure?: 'explain' | 'silent';
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
  /** Conversation memory: if provided, thread history is loaded + appended idempotently when the stream
   *  ends. `false` = deliberately none — see RunDurableArgs.memory for what that buys. */
  memory?: Memory | false;
  threadId?: string;
  /** Resource (user) identity — for resource-scope recall / cross-thread memory. */
  resourceId?: string;
  /** Kanal etiketi — XID origin'i ve tekrar sorularının "nereden" bilgisi (bkz. DurableCtx.channel). */
  channel?: string;
  /** Agent registry name — frozen into the `:input` entry so studio /runs can label the run (see RunDurableArgs). */
  agentName?: string;
  /** The caller's name for this unit of work + the address it is unique within — frozen into `:input`
   *  for visibility ONLY, exactly as on runDurable (no runId derivation, no validation; see
   *  RunDurableArgs.workKey for the full bound). Carried here because parity is what keeps chat and
   *  agui, which stream, from being the surfaces where the job's name goes missing. */
  workKey?: string;
  workScope?: WorkScope;
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
  schemaCompat?: boolean | ToolSchemaRuleLike[];
  /** W1 (opt-in): per-run cost cap + loop detection. If not provided, no check runs. */
  limits?: RunLimits;
  /** §5.3 (opt-in): model-step exclusivity — same semantics as runDurable (see RunDurableArgs). */
  exclusiveModelStep?: { ttlMs?: number };
  /**
   * (a) — opt-in run-level lock (same shape as RunDurableArgs.lock): if provided, a concurrent
   * stream/run of the same runId gets `RunBusyError` at start. The lock is acquired BEFORE streaming and
   * RELEASED when the stream finishes (the same `onFinish` lifecycle the memory-append uses; also
   * released on stream error).
   *
   * FAZ-7: the streamed lock SELF-RENEWS on a ttl/2 heartbeat (parity with runDurable's B4 renew).
   * The old objection — a stream's lifecycle is not function-scoped, so an ABANDONED stream (created,
   * never drained, no abort) would renew forever — is answered with a BOUND instead of a refusal:
   * Renewal is hard-capped by `maxHoldMs` (default STREAM_LOCK_MAX_HOLD_MS = 60min); past the cap the
   * beat stops with a loud warn and TTL reclaims. `ttlMs` is therefore the crash-takeover window
   * again, not a worst-case-duration estimate. Renewal is deliberately NOT chunk-liveness-gated: a
   * long tool call emits no chunks, and pausing renewal there would hand the lock to a takeover
   * mid-run — the exact double-execution this lock prevents.
   */
  lock?: { owner: string; ttlMs: number; maxHoldMs?: number };
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
  /** FAZ-7: 'require' makes the ledger append a PRECONDITION of the refusal — its failure propagates
   *  Instead of warning (never refuse unrecorded). Default 'best-effort'. Only meaningful with conflictLedger. */
  auditOnReject?: 'best-effort' | 'require';
  /**
   * Replay-disclosure policy. 'silent' (default): existing behavior — replayed tool results are
   * indistinguishable to the model, only the result envelope (`replayedToolCalls`) carries the fact.
   * 'explain': a TRANSIENT per-step note (never persisted, never in thread memory) tells the model —
   * strictly AFTER the call was already answered from the journal — that the result is the record of
   * earlier work, so it narrates honestly instead of announcing a fresh success. See withReplayDisclosure.
   */
  replayDisclosure?: 'explain' | 'silent';
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
   * loop/maxToolCalls/duplicate/tainted block or a durable-tool block sentinel fired during the run.
   * Receives the RAW structured breach `{ kind, message, detail }` (the sentinel's own fields — no
   * invented user-facing message; the app decides what to show its users). Advisory callback: a throw
   * from it is swallowed with a console.warn and never breaks the stream or masks the typed error the
   * terminal promises reject with.
   */
  onBlocked?: (breach: StreamBreach) => void | Promise<void>;
};

/** `generateText` result + suspended tool calls (`interrupts`). */
export type DurableResult = Awaited<ReturnType<typeof generateText>> & {
  interrupts: Interrupt[];
  /** Replay-disclosure envelope (out-of-band, ALWAYS stamped when non-empty): tool calls this run
   *  answered from pre-existing journal records instead of executing. UI/adapters may surface it
   *  (badge, signed suffix); it never enters the model's context by itself — see DurableCtx.replayLog. */
  replayedToolCalls?: Array<{ toolCallId: string; toolName?: string; status: string; origin: 'self' | 'window' }>;
};

/**
 * Replay-disclosure model note (`replayDisclosure: 'explain'`): wraps the (possibly absent)
 * prepareStep so that the step FOLLOWING a consumed pre-existing record carries one TRANSIENT
 * system note — the model can then narrate honestly ("this result is the record of earlier work,
 * nothing ran now") instead of announcing a fresh success or inventing a reason.
 *
 * THE PANEL RULE STAYS INTACT, by construction: the note exists only AFTER the model already chose
 * to call the tool and the engine already answered it — it cannot influence the call decision. And
 * it is prepareStep-only (a per-step INPUT override), so it is never persisted: neither the journal
 * nor thread memory ever sees it, and later turns start clean — the model stays blind at decision
 * time, informed only while narrating.
 *
 * HONEST BOUNDS: (1) a replay consumed on the FINAL step gets no note — there is no following live
 * step to inject into; the envelope is the fallback there. (2) The note is a mid-list 'system'
 * message — the engine itself replays those (allowSystemInMessages: true), but a provider converter
 * that rejects mid-list system messages would surface it; measured fine on OpenAI-compatible.
 * (3) STREAM surface: the envelope is a LAZY property on the stream result — empty until the
 * stream is consumed, populated for finish-time readers (host onFinish). It is deliberately NOT
 * emitted on the SSE done frame: the SSE sequence is replay-deterministic (W3) and the envelope
 * differs between first run and replay.
 */
function withReplayDisclosure(prev: ((step: any) => any) | undefined, ctx: DurableCtx): (step: any) => Promise<any> {
  let announced = 0;
  return async (step: any) => {
    const base = prev ? await prev(step) : undefined;
    const log = ctx.replayLog ?? [];
    if (log.length <= announced) return base;
    const seen = log.slice(announced);
    announced = log.length;
    // Only FOREIGN, SUCCEEDED records earn the note: 'self' entries are this very request resuming
    // (saying "earlier request" would be false — denetçi K4), and a denied/reflected record must not
    // be narrated as "work already completed". Everything still reaches the envelope, labelled.
    const fresh = seen.filter((f) => f.origin === 'window' && f.status === 'succeeded');
    if (fresh.length === 0) return base;
    const names = [...new Set(fresh.map((f) => f.toolName ?? f.toolCallId))].join(', ');
    const note = {
      role: 'system',
      content:
        `[gnl] The result(s) of ${names} above were NOT produced by this request — the same work was ` +
        `already completed earlier and the recorded outcome was returned (nothing executed now). ` +
        `Tell the user this explicitly, in their language: the operation was not performed again; ` +
        `what they see is the record of the earlier one.`,
    };
    const msgs = (base as { messages?: unknown[] } | undefined)?.messages ?? step.messages;
    return { ...(base ?? {}), messages: [...msgs, note] };
  };
}

function hasSuspend(part: any): boolean {
  return part?.type === 'tool-result' && !!part.output?.__gnl_suspend;
}

/**
 * SORUYU SORANIN KİMLİĞİ YÜZEYE ÇIKAR.
 *
 * Bir alt ajan insan kapısına çarptığında ebeveynin kaydı da askıya giriyor (agent-tool.ts'in
 * `kind:'nested'` sentinel'i). O sentinel ZORUNLU olarak EBEVEYNİN çağrı id'siyle anahtarlanır —
 * askı kaydı, replay ve `consumeExistingRecord` hep o id üzerinden çalışır. Ama o id bir VEKİLDİR:
 * ortada onunla cevaplanabilecek bir soru yok.
 *
 * Vekil id'yi yüzeye çıkarmak ölçülen bir tuzaktı. Standart istemci sözleşmesi
 * `approvals[interrupt.toolCallId] = true` göndermek; onu yapan istemci sessiz bir no-op döngüsüne
 * giriyordu — ebeveyn askı kolunu geçiyor, çocuk `{ebeveynId:true}` ile yeniden koşuyor, çocuğun
 * confirm'ü kendi id'sini bulamıyor, yine askı; her turda da sahte bir insan-onayı izi. `false`
 * verildiğinde daha sessiz: ebeveyn 'denied' yazılıyor, çocuk koşumu sonsuza dek yetim kalıyor.
 *
 * Bu yüzden yüzeye ÇOCUĞUN interrupt'ları çıkar: kendi toolCallId'leri, kendi reason'ları, alt-ajan
 * bağlamı reason'a eklenmiş hâlde. Genişletme BURADA — koşumun interrupt'larının toplandığı tek
 * noktada — yapılıyor, sentinel üretiminde değil: journal'daki kayıt (ve onu okuyan askı merdiveni)
 * olduğu gibi kalıyor, değişen yalnız çağırana DÖNEN liste. Çok kademeli devirde de kendiliğinden
 * çalışır: çocuğun `res.interrupts`'i de aynı noktadan geçtiği için torunun kimliği yukarı taşınır.
 *
 * EXPORTED, ve sebebi ölçülmüş bir arızadır: bu dosya koşumun interrupt'larını doğru topluyordu ama
 * ÜÇ yüzey (server/sse.ts + studio/sse.ts `interruptsFromSteps`, studio'nun onay gelen kutusu)
 * interrupt'ı motordan değil kendi başına türetiyordu — step part'larından ya da journal'daki askılı
 * tool kaydından ham `__gnl_suspend` sentinel'ini çekerek. O sentinel ZORUNLU olarak vekilin
 * id'siyle anahtarlıdır (askı kaydı, replay ve `consumeExistingRecord` hep o id üzerinden çalışır),
 * yani o yüzeylerden onaylayan insan tam da durable-tool'un bilinçle yok saydığı kimliği
 * gönderiyordu: sessiz no-op. Dönüşüm ÜÇ yerde kopyalanmaz — ham sentinel'i alıp yüzeye çıkacak
 * listeyi döndüren tek fonksiyon budur. `limitBreachFromSteps`/`blockedFromSteps`'in ihraç
 * edilmesiyle aynı sözleşme: motorun bildiğini yüzeyler yeniden keşfetmesin.
 */
export function surfacedInterrupts(sus: any): Interrupt[] {
  const nested = sus?.kind === 'nested' ? sus.nested : undefined;
  const inner: any[] = nested?.interrupts ?? [];
  if (!inner.length) return [sus as Interrupt];
  return inner.map((i) => ({
    toolCallId: i.toolCallId,
    toolName: i.toolName,
    args: i.args,
    reason:
      `A delegated sub-agent (nested run '${nested.runId}') stopped for a human: ` +
      `${i.reason ?? 'approval required'}`,
    ...(i.semPair ? { semPair: i.semPair } : {}),
  }));
}

// The sentinel returned when durable-tool.ts's loop/maxToolCalls gate is blocked
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
  // A worker already inside the loop when the operator
  // condemned the run — durable-tool refuses the NEW side effect via this sentinel (see the gate there).
  if (b.code === 'CompensatedRunError') return new CompensatedRunError(b.detail?.runId ?? 'unknown');
  return new RunBusyError(b.message);
}

/**
 * K1/W1 (B): converts the FIRST blocked/limit sentinel in the `steps` array into a real
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
 * (b): the normalized breach handed to `StreamDurableArgs.onBlocked`. ONE shape for both
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

// (b): normalize the FIRST sentinel (same scan order as streamFinishError — blocked first)
// into the StreamBreach shape for the onBlocked callback. For a blocked sentinel without `detail`,
// fall back to `{ toolCallId, toolName }` so the app can still identify the blocked call.
function streamBreachFromSteps(steps: any[]): StreamBreach | undefined {
  const blocked = blockedFromSteps(steps);
  if (blocked) return { kind: blocked.code, message: blocked.message, detail: blocked.detail ?? { toolCallId: blocked.toolCallId, toolName: blocked.toolName } };
  const limitBreach = limitBreachFromSteps(steps);
  if (limitBreach) return { kind: limitBreach.kind, message: limitBreach.message, detail: limitBreach.detail };
  return undefined;
}

// (b) — terminal-promise reject: the awaited-result promises a happy-path consumer reads
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

/**
 * Second job of the same Proxy (see guardStreamTerminalPromises): hand the OUTPUT-PROCESSED value to
 * the caller instead of the model's raw one, for the two properties the processor contract actually
 * covers. Receives the already-resolved raw value plus the run's steps; returns what the getter
 * resolves with. Must never reject — a masking failure falls back to the raw value (the processor
 * chain's own errors are reported by streamDurable's onFinish, which owns them).
 */
type TerminalMask = (prop: string, value: unknown, steps: any[]) => Promise<unknown>;

// Wraps the streamText result in a Proxy: the listed promise getters are gated on `steps` (which
// resolves at the same finish point — no dependence on our own callbacks firing, so no new hang path)
// and reject with the typed error if a sentinel is present. Everything else passes through untouched
// (methods bound to the raw result so private state keeps working). Each wrapped promise gets a no-op
// catch attached so merely ACCESSING a property on a breached run never becomes an unhandled rejection.
//
// `mask` (only passed when output processors exist) runs AFTER the breach gate: a breached run keeps
// rejecting with the typed error, and only a clean run's value is transformed.
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
/**
 * The journal shape of one human answer.
 *
 * WHY IT IS NO LONGER A BARE BOOLEAN. `true` is a decision with no author, no time and no state, and
 * all three were load-bearing:
 *   - WHO: the audit trail could not attribute an approval, and `precision@suspend` counted an
 *     operator's click and the requester's click in the same bucket.
 *   - WHEN: an answer and a leftover row were indistinguishable.
 *   - STATE: first-decision-wins made a not-yet-executed `true` unbeatable, so a later "Deny" lost.
 *     MEASURED: approve → the turn crashed → deny → the card was charged. No attacker involved;
 *     an operator's own two clicks and one ordinary crash.
 *
 * READ COMPATIBILITY IS PART OF THE SHAPE, not an afterthought: journals in the field hold bare
 * booleans and the `attempt`-scope spent sentinel. Both keep their meaning (see `decisionOf`), so
 * this is additive — no migration, no reader that has to know which era a row came from.
 */
export interface ApprovalRecord {
  v: 1;
  decision: boolean;
  at: number;
  /** WHO answered, when the surface knows (see registry's sealed identity / Studio's actorOf). */
  actor?: string;
}

/** A spent slot (`approvalScope: 'attempt'`) — a consumed answer, not an answer. */
const isSpent = (raw: unknown): boolean =>
  typeof raw === 'object' && raw !== null && (raw as { __gnl_approval_spent?: boolean }).__gnl_approval_spent === true;

/**
 * The decision inside a row, whichever era wrote it. `undefined` = "no answer yet" (missing row,
 * spent slot, or anything unrecognised — an unreadable row must never read as approval).
 */
export function decisionOf(raw: unknown): boolean | undefined {
  if (typeof raw === 'boolean') return raw; // legacy row, still a decision
  if (typeof raw === 'object' && raw !== null && (raw as ApprovalRecord).v === 1) {
    const d = (raw as ApprovalRecord).decision;
    return typeof d === 'boolean' ? d : undefined;
  }
  return undefined;
}

export async function resolveApprovals(
  journal: Journal,
  runId: string,
  approvals: Record<string, boolean> | undefined,
  opts?: { actor?: string; hasRun?: (toolCallId: string) => Promise<boolean> },
): Promise<Record<string, boolean> | undefined> {
  // (a) claim every decision from the parameter into the journal (idempotent — first decision wins).
  // A SPENT slot (approvalScope:'attempt' consumed the previous answer before executing) is not a
  // decision: the human's fresh answer takes it over by CAS. Without this, the claim silently lost to
  // the leftover row and the new decision lived only in-process — a crash after this point forgot it.
  if (approvals) {
    for (const [toolCallId, decision] of Object.entries(approvals)) {
      const key = runKeys.approval(runId, toolCallId);
      const record: ApprovalRecord = { v: 1, decision, at: Date.now(), ...(opts?.actor ? { actor: opts.actor } : {}) };
      const won = await claim(journal, key, record);
      if (won) continue;
      const raw = await journal.get(key);
      // A spent slot is not a decision — the human's fresh answer takes it over (unchanged).
      if (isSpent(raw)) {
        if (journal.putIfMatch) await journal.putIfMatch(key, raw, record);
        else await journal.put(key, record); // single-process fallback, same bound as claim()
        continue;
      }
      // CHANGING ONE'S MIND, while it is still possible to change anything.
      //
      // first-decision-wins exists so a crash cannot lose an answer, and that stays. What it must NOT
      // mean is that an answer becomes unbeatable BEFORE the work it answers for has happened: an
      // approve whose turn then died left a live `true`, and the operator's follow-up "Deny" lost to
      // it silently — the row stayed `suspended`, so the inbox invited exactly that second click.
      //
      // The line drawn here is the EFFECT, not the clock: a differing answer may replace a decision
      // only while the tool call has not reached a terminal record. Once it has, the decision is
      // spent history and mutating it would rewrite an outcome rather than direct one. Ownership of
      // "may THIS caller answer" is a separate question and is not decided here.
      const previous = decisionOf(raw);
      if (previous === undefined || previous === decision) continue;
      const ran = opts?.hasRun ? await opts.hasRun(toolCallId).catch(() => true) : true; // unknown → treat as run (safe direction)
      if (ran) {
        // "Has finished" was the whole story while only terminal records closed the window; now a
        // LIVE claim closes it too, and an operator told "it has finished" about a charge still in
        // flight would go looking for a completion that isn't there yet.
        console.warn(
          `@gnldev/durable: '${runId}' approval conflict — '${toolCallId}' already has a decision (${previous}) ` +
            `whose tool call is no longer open to a change of mind (it has finished, or is executing right now); ` +
            `the new answer (${decision}) is ignored.`,
        );
        continue;
      }
      if (journal.putIfMatch) await journal.putIfMatch(key, raw, record);
      else await journal.put(key, record);
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
    const journalDecision = decisionOf(await journal.get(key));
    // No answer yet: missing, spent, or unrecognised. An unreadable row must never read as approval.
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

/**
 * The answer to resolveApprovals' "has the work happened?", read from the journal. ONE copy, because
 * the question is asked from FOUR call sites now — runDurableInner, streamDurable, batch.ts's
 * mini-runner and Studio's resume endpoint — and two copies of a rule this subtle is two rules a
 * release apart. EXPORTED for exactly that reason: the two outside callers were passing no probe at
 * all, and `undefined` means "assume it ran", so a human's second answer was silently dropped on the
 * two surfaces where a human is the one answering.
 *
 * "Bu çağrı çalıştı mı" sorusunun cevabı zaten journalda: araç kaydına bakılır. Ayrı bir 'consumed'
 * bayrağı EKLEMEDİM — ikinci bir gerçeklik kaynağı, ikinci bir senkron sorunu demek.
 *
 * TERMİNAL sözlüğü: succeeded | denied | reflected. `!== 'suspended'` yazmak yanlıştı — `failed` ve
 * BAYAT `running` kayıtları da terminal değil, devralınıp yeniden koşuluyor (durable-tool.ts'in
 * recover/reclaim merdiveni). Yani yamanın kapatmak istediği hikâyenin ana kolu — "onayla → araç
 * çöktü → reddet → yine çekildi" — açık kalıyordu: ölçüldü, iki çekim.
 *
 * TAZE bir 'running' de "karar uygulanıyor" sayılır, ve bu satır ölçülmüş bir DENETİM İZİ
 * çelişkisini kapatıyor: onay verildi, execute başladı, execute SÜRERKEN ikinci bir çağrı ret
 * getirdi. Kayıt terminal olmadığı için ret onayın YERİNE yazılıyor, araç ise yan etkisini bitirip
 * 'succeeded' yazıyordu. Journal'ın nihai hali "reddedildi ama çalıştı" diyordu. Koşuma zarar yok —
 * zarar denetim izine, ki bu gate'in var oluş sebebi tam olarak odur. Yarışı kaybetmiş bir cevap
 * kararı değiştirmez.
 *
 * BAYAT 'running' (çökmüş bir çağrı) false kalır, ve bu bilinçli: yarım kalmış bir yan etki hakkında
 * insan fikir DEĞİŞTİREBİLMELİ — mevcut davranış, korunuyor. Tazelik eşiği durable-tool'un claim
 * eşiğiyle AYNI (`CLAIM_TTL_MS`, `timeouts.claimTtlMs` ile aynı şekilde geçersiz kılınır): aynı kaydı
 * "canlı" sayan iki farklı eşik, kapatılan çelişkiyi kenarından geri açardı. Saat de aynı sebeple
 * PAYLAŞILAN saat (run-lock ve durable-tool emsali) — `startedAt`'i yazan işçi başka bir makinede
 * olabilir ve bayatlığı yerel saatle ölçmek onu saat kaymasının fonksiyonu yapardı.
 */
export function hasRunProbe(journal: Journal, runId: string, claimTtlMs?: number): (toolCallId: string) => Promise<boolean> {
  return async (toolCallId) => {
    const rec = await journal.get<{ status?: string; startedAt?: number }>(runKeys.tool(runId, toolCallId));
    if (rec?.status === 'succeeded' || rec?.status === 'denied' || rec?.status === 'reflected') return true;
    if (rec?.status !== 'running') return false;
    const nowTs = journal.now ? await journal.now() : Date.now();
    // A 'running' with no `startedAt` cannot be dated, so it reads as stale — the SAME verdict
    // durable-tool's reclaim ladder gives it. The two must agree: a record the ladder will take over
    // and re-run is a record a human may still re-answer.
    return typeof rec.startedAt === 'number' && nowTs - rec.startedAt <= (claimTtlMs ?? CLAIM_TTL_MS);
  };
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
  alreadyFrozen: boolean,
  threadId?: string,
  agentName?: string,
  resourceId?: string,
  // FAZ-4: the RAW caller input's fingerprint (computed BEFORE memory prep mutates `input.messages` —
  // post-prep content grows with the thread, so a post-prep hash would 409 every legitimate resume)
  // and the opaque actor identity. Both first-wins with the rest of the entry.
  rawInputHash?: string,
  actor?: string,
  // Package #2: the caller's DECLARED name for this work, and the address it is unique within. Passed
  // as one object rather than two more positionals because they are one fact in two halves (see
  // WorkScope) — and because this parameter list has already learned that a long tail of optional
  // strings is how the wrong value ends up in the right slot.
  //
  // RECORDED, NOT OBEYED. This function does not derive `runId` from `work.workKey`, does not compare
  // `work.workScope.value` with `resourceId`, and does not refuse anything: the id it writes under is
  // the one the caller already chose. That derivation is the registry gate (package #3); until then
  // the only thing the journal gains is the ABILITY to answer "which run was that job?" — which is
  // what §1 means by the declared name staying a first-class, queryable field.
  work?: { workKey?: string; workScope?: WorkScope },
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
  // this to group runs by thread and to LABEL each run with its agent (no per-run journal N+1). It
  // sits in the invisible `:input` entry → doesn't leak into reader/time-travel, doesn't affect step counting.
  // `at` = the run's TRUE start (this write precedes the first model call). recordRunMetrics needs it
  // because the visible entries can't carry it: a streamed step's `model:N` row is written when the
  // step FINISHES — a single-step streamed run has exactly one visible row, at the very end, so a
  // ts-span duration read 0ms (live repro: a 27s stream recorded as 0ms). Additive field; readers of
  // the input blob ignore unknown fields.
  //
  // The workKey joins the SAME first-wins entry, which is the point: a run's name is fixed by
  // whoever started it, so a later call cannot rename work that is already under way (or already
  // answered). The `...(x ? {x} : {})` spelling is not cosmetic either — every reader here asks
  // `'workKey' in record`, and an explicit `undefined` would turn "this caller never declared a
  // name" into "this caller declared nothing", which are different facts.
  await journal.put(key, stampFormat({ at: Date.now(), prompt: input.prompt, messages: input.messages, system: input.system, ...(threadId ? { threadId } : {}), ...(agentName ? { agent: agentName } : {}), ...(resourceId ? { resourceId } : {}), ...(rawInputHash ? { hash: rawInputHash } : {}), ...(actor ? { actor } : {}), ...(work?.workKey ? { workKey: work.workKey } : {}), ...(work?.workScope ? { workScope: work.workScope } : {}) })); // H13
}

/** FAZ-6: `limits` is FROZEN to the journal and must stay serializable — the semantic block's
 * `embed` closure cannot ride along (structuredClone rejects functions, and a resumed run could not
 * recover a closure from disk anyway). The frozen copy keeps the DECLARATIVE half (embedModelId,
 * thresholds) so introspection stays honest; a resume that recovers limits from the journal runs with
 * the semantic gate INACTIVE (double opt-in unmet: no embed) unless the caller re-supplies it —
 * fail-open, same posture as an unreachable embedder. */
function serializableLimits(limits: RunLimits): RunLimits {
  const dup = limits.sideEffectDuplicates;
  if (!dup || typeof dup !== 'object' || !dup.semantic) return limits;
  // FAZ-7: `judge.complete` is a closure too, and it sits one level deeper — leaving it in place
  // would throw on EVERY frozen write of a judge-enabled run (structuredClone rejects functions), so
  // the judge is stripped down to its declarative half by the same rule as `embed`. What stays is
  // pure data (`rules`, `qualification`, model id): a resumed run's introspection still shows which
  // ladder and which certificate were in force, while the gate itself is inactive until the caller
  // re-supplies the closures.
  const { embed: _embed, judge, ...semRest } = dup.semantic;
  const semStripped = judge
    ? { ...semRest, judge: { ...(({ complete: _complete, ...j }) => j)(judge) } as unknown as typeof judge }
    : semRest;
  // `embedStripped` marks the round-trip copy: the validator treats it as "declaratively present,
  // functionally inactive" instead of throwing on the missing closure — WITHOUT the mark, a user who
  // simply forgot `embed` would get silent inactivity (false confidence), so the bare-missing case
  // still throws (denetçi blokeri: the unmarked strip killed EVERY resume of a semantic-active run,
  // including approving the gate's own question).
  return { ...limits, sideEffectDuplicates: { ...dup, semantic: { ...semStripped, embedStripped: true } as unknown as typeof dup.semantic } };
}

/**
 * The child toolCallIds this run has SURFACED to a human — read back off the parent's own records.
 *
 * A nested suspend writes the parent a `suspended` tool record whose sentinel is `kind: 'nested'` and
 * whose `nested.interrupts[]` carries the child's questions verbatim (agent-tool.ts). `run.ts`'s
 * `surfacedInterrupts` turns exactly that list into what the caller sees, so this function reads the
 * same field from the other direction: given a parent, which ids did we ask about?
 *
 * COLD PATH ONLY — called from the input-fingerprint mismatch branch, after escape 1 has already
 * failed, and at most once per admissibility check (the caller memoises it). Scoped to
 * `${runId}:tool:`, so a neighbour run whose id EXTENDS this one is not read (its keys sit under
 * `${runId}:<rest>:tool:`), and capped: a run with thousands of tool records is not worth an
 * unbounded scan to answer a question about a handful of pending approvals.
 *
 * Degrades to "found nothing" without `listKeys` — the same fail-shut direction the escape already
 * had, since an unrecognised id simply falls through to the 409 it would have gotten anyway.
 */
async function nestedSurfacedToolCallIds(journal: Journal, runId: string, max = 500): Promise<Set<string>> {
  const out = new Set<string>();
  const lk = journal.listKeys;
  if (typeof lk !== 'function') return out;
  const keys = await lk.call(journal, runKeys.tool(runId, ''));
  for (const key of keys.slice(0, max)) {
    const rec = await journal.get<{
      status?: string;
      output?: { __gnl_suspend?: { kind?: string; nested?: { interrupts?: Array<{ toolCallId?: string }> } } };
    }>(key);
    if (rec?.status !== 'suspended') continue;
    const sus = rec.output?.__gnl_suspend;
    if (sus?.kind !== 'nested') continue;
    for (const i of sus.nested?.interrupts ?? []) if (i?.toolCallId) out.add(i.toolCallId);
  }
  return out;
}

/** FAZ-4 admissibility gate — runs right after assertThreadOwnership in BOTH entry points, BEFORE
 * runStarted (a refused attempt must not flip outcome state, same K2/K3 posture as the thread
 * guard). Order: tombstone → actor → owner → input fingerprint. Every refusal optionally lands in the
 * idem-conflict ledger (PII-free) before it is thrown.
 *
 * PACKAGE #3 added the last two rows of that order, and both of them are conditional on ONE thing:
 * whether the runId is one the engine minted from a workKey (`isDerivedRunId`). Inside `run1_` the id
 * is a hash of (agent, scope kind, scope value, workKey), which changes what an id MEANS — it stops
 * being a name the caller invented and becomes a claim about whose work this is and what the work is.
 * Two checks follow from that, and neither one is a flag:
 *
 *   OWNER (§6, condition 2b) — the subject frozen at birth must match the subject asking now.
 *   INPUT (§5, condition 4)  — the fingerprint is verified with or without `strictInput`.
 *
 * Outside `run1_` nothing here changed by a byte: a raw runId is the caller's own name for their own
 * key, `strictInput` stays opt-in, and re-driving one from a different subject stays legal (hosts hand
 * runs between workers under their own rules). The asymmetry is the point — the engine only enforces
 * the promises it made itself. */
async function assertRunAdmissible(
  journal: Journal,
  runId: string,
  frozen: FrozenInput | undefined,
  rawInputHash: string,
  opts: { strictInput?: boolean; conflictLedger?: boolean; auditOnReject?: 'best-effort' | 'require'; tombstonePolicy?: 'ignore' | 'reject'; actor?: string; resourceId?: string; approvals?: Record<string, boolean> },
): Promise<void> {
  // Computed once: three decisions below read it, and it is a regex over a short string either way.
  const derived = isDerivedRunId(runId);
  const refuse = async (err: Error, code: string, detail: Record<string, string | number>): Promise<never> => {
    if (opts.conflictLedger) await recordIdemConflict(journal, { runId, code, ...(opts.actor ? { actor: opts.actor } : {}), detail }, opts.auditOnReject ?? 'best-effort');
    throw err;
  };
  // Derived ids don't wait for a profile: the caller never chose `run1_...` and cannot choose a
  // different one, so a swept-and-silently-rerun outcome would be invisible to them. Same reasoning
  // as the workflow gate (assertWorkflowAdmissible), where the check is unconditional too.
  if (opts.tombstonePolicy === 'reject' || derived) {
    const tomb = await journal.get<{ at?: number; workKeyHash?: string; workScope?: WorkScopeKind }>(`${runId}:swept`);
    if (tomb !== undefined) {
      // What the marker knows about the dead run travels with the refusal (see RunSweptError.detail
      // and retention.ts's `tombstoneFor`): a hash and a scope kind, never a workKey. The ledger gets
      // the same two — it is the "codes, hashes, never content" record, and a hash is what it is for.
      const swept = {
        ...(tomb.at !== undefined ? { sweptAt: tomb.at } : {}),
        ...(tomb.workKeyHash ? { workKeyHash: tomb.workKeyHash } : {}),
        ...(tomb.workScope ? { workScope: tomb.workScope } : {}),
      };
      await refuse(
        new RunSweptError(
          derived
            ? `@gnldev/durable: the run this workKey names was retention-swept — its dedup window died with it, and a late retry must not silently re-run the side effects. Name the work differently (a new workKey means a new job), or verify the external system first.`
            : `@gnldev/durable: run '${runId}' was retention-swept — its dedup window died with it, and a late retry must not silently re-run the side effects (tombstonePolicy 'reject'). Use a fresh runId, or verify the external system first.`,
          { runId, ...swept },
        ),
        'run_swept',
        swept,
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
  // THE OWNER OF A DERIVED RUN. `resourceId` was already frozen at birth (persistInput, first-wins);
  // what was missing was anybody comparing it. §6 puts the comparison HERE rather than at the HTTP
  // edge for two reasons the decision measured: the edge's `ownershipDenied` is not unconditional,
  // and an embedded deployment has no edge at all.
  //
  // BOTH SIDES MUST BE PRESENT, exactly like the actor row above. A call with no subject is the
  // operator/org case the whole ownership rule exempts, and a run with no frozen subject never
  // claimed one — refusing either would be inventing an owner in order to enforce ownership. The
  // honest bound of that choice: on the RAW `runDurable` surface a caller may hand a derived id with
  // no resourceId and pass; the surfaces that MINT derived ids (the registry gate, package #3) refuse
  // a scope with no address before they ever get here, which is where fail-closed belongs.
  if (derived && frozen?.resourceId && opts.resourceId && frozen.resourceId !== opts.resourceId) {
    await refuse(
      new RunOwnerMismatchError(
        `@gnldev/durable: run '${runId}' belongs to a different subject — this call names '${opts.resourceId}'. ` +
          'An engine-derived id is a hash of a scope and a workKey, so two callers can compute the same id; ' +
          "the run itself is still one person's. If this work really is shared, declare it in an org workScope " +
          'and give the callers a scope they both belong to.',
        { runId, owner: frozen.resourceId, requested: opts.resourceId },
      ),
      'run_owner_mismatch',
      { owner: frozen.resourceId, requested: opts.resourceId },
    );
  }
  if ((opts.strictInput || derived) && frozen?.hash !== undefined && frozen.hash !== rawInputHash) {
    // ESCAPE 1 — driving the run with the frozen record's OWN stored content is by definition a
    // replay, not new content: resumeRun feeds `:input` back verbatim, and its messages are the
    // POST-prep view while `hash` fingerprints the PRE-prep raw input (see persistInput) — without
    // this, forwarding strictInput through resume would self-409 every memory-backed crash-resume.
    // One extra hash, computed only on the mismatch path.
    if (rawInputHash === argsHash({ prompt: frozen.prompt, messages: frozen.messages, system: frozen.system })) return;
    // ESCAPE 2 — bound to the JOURNAL's approval trace (heyet İhtilaf B), NOT to the mere presence
    // of an approvals field: the addressed toolCallId must have a RECORD in this run. Any status, on
    // purpose: after the approval lands the record moves suspended→succeeded/denied, and the SAME
    // re-POST retried by an at-least-once client must replay — answering a request that deserves
    // idempotent replay with "use a fresh runId" would be the contract lying (denetçi K18 bulgusu).
    // An approval naming a toolCallId this run never journaled still earns nothing.
    //
    // "IN THIS RUN" HAD TO GROW ONE FRAME. A nested suspend surfaces the CHILD's toolCallId — that is
    // the whole point of `surfacedInterrupts`, and nested-suspend-visibility.test.ts pins it: the
    // human must answer with the id they were shown, because the parent's proxy record can stand for
    // several child questions at once. But that id lives in the CHILD's journal, so the lookup above
    // missed every one of them, and a client following the documented contract got a 409 the moment
    // its body grew by a turn — which is exactly what a chat surface's approval round looks like.
    // The escape now also recognises the ids this run PUT ON SCREEN (`nestedSurfacedToolCallIds`),
    // read from the parent's own suspended records. A made-up id still earns nothing.
    let surfaced: Set<string> | undefined;
    for (const toolCallId of Object.keys(opts.approvals ?? {})) {
      const rec = await journal.get<{ status?: string }>(runKeys.tool(runId, toolCallId));
      if (rec !== undefined) return;
      surfaced ??= await nestedSurfacedToolCallIds(journal, runId);
      if (surfaced.has(toolCallId)) return;
    }
    // TWO SENTENCES FOR ONE REFUSAL, because the caller of a derived run did not choose this id and
    // cannot "use a fresh" one — the advice would name a thing they never touched. Inside `run1_` the
    // id came from THEIR workKey, so the remedy is stated in the vocabulary they actually hold: a new
    // job needs a new name. (§5's last line asks for exactly this; the hashes stay in `detail` either
    // way, which is what a log correlates on.)
    await refuse(
      new RunInputMismatchError(
        derived
          ? `@gnldev/durable: this workKey already names DIFFERENT work (fingerprint ${frozen.hash} != ${rawInputHash}) — ` +
              'one workKey is one job, and reusing it means "retry that job", never "here is a new one". ' +
              'A new job needs a new workKey; retrying the old one means sending the same content again.'
          : `@gnldev/durable: run '${runId}' was started with DIFFERENT input (fingerprint ${frozen.hash} != ${rawInputHash}) — one runId carries one request; use a fresh runId for new content.`,
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

/**
 * Has anyone already been told that this process throws `threadId`s away? One flag for the lifetime of
 * the module, which is the lifetime of the process.
 *
 * A wiring mistake is worth exactly one sentence. Repeating it per request would put a line in the log
 * for every turn of every conversation, and a warning that appears ten thousand times is one people
 * learn to filter — which leaves the project back where it started, except noisier.
 */
let warnedThreadIgnored = false;

/**
 * A `threadId` arrived and there is no memory to put it in.
 *
 * WHY THIS IS NOT AN ERROR. Every memory branch here is guarded by `memory && threadId`, so the run
 * itself is fine: it does the work, returns the answer, and journals it. What it does not do is
 * remember — and until this sentence existed, nothing anywhere said so. The id was accepted, frozen
 * into `:input`, surfaced on `RunSummary.threadId`, and used by Studio to group runs into a
 * conversation that had no history behind it. Every one of those is a reason to believe threads work.
 *
 * WHY IT IS NOT SILENCEABLE BY ACCIDENT. `memory: false` is the opt-out, and it is a DIFFERENT value
 * from "absent" on purpose: a project that knows it wants no memory writes one word and never sees
 * this again, while a project that simply forgot keeps the sentence. Collapsing the two would have
 * made the warning unsilenceable for the correct case, which is how warnings get turned off wholesale.
 *
 * Shaped as error → note → help: what already happened, what it costs, and a line to copy.
 */
function warnThreadIgnored(threadId: string, memory: Memory | false | undefined): void {
  if (memory !== undefined || warnedThreadIgnored) return;
  warnedThreadIgnored = true;
  console.warn(
    `@gnldev/durable: threadId '${threadId}' was accepted and then ignored — no memory is attached to this run.\n` +
    '  note: the run still works; it just does not remember. Thread history is neither loaded into the\n' +
    '        prompt nor appended when the turn ends, so the second message in this conversation starts\n' +
    '        from nothing — and the id still shows up on the run summary and in Studio, which is why\n' +
    '        this reads as working until someone asks a follow-up question.\n' +
    '  help: `gnl add memory` writes src/memory.ts, then set `memoryFactory` in gnl.config.ts.\n' +
    '        Meant to run without it? Pass `memory: false` (or set it in the config) and this stops.',
  );
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
 * F1 — durability review: server-owned-history contract, enforced at the core. useChat-style
 * clients POST their ENTIRE message history every turn (see @gnldev/chat-adapter chat-route.ts — the
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
 *
 * WITH ONE EXCEPTION, measured: an ASSISTANT PREFILL. Ending a turn with a partial assistant message
 * ("Cevap:", a `{` to force JSON) is an ordinary provider-supported pattern, and the role rule read it
 * as an echo of everything — the anchor was the turn's own LAST message, so the slice came out EMPTY
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
): Promise<{ incoming: any[]; wmTool?: Record<string, any>; alreadyStored: boolean; provenance?: MemoryContextRecord; historyCount: number; adoptedResourceId?: string }> {
  const rawIncoming: any[] = rest.messages ?? (rest.prompt != null ? [{ role: 'user', content: rest.prompt }] : []);
  delete rest.prompt;
  const echoSystem = rest.system;
  const echoCompare = echoView ? await echoView(rawIncoming, echoSystem) : rawIncoming;
  // Özne beyan edilmemişse thread'in sahibi BENİMSENİR (ve `:input`'a o yazılır — persistInput).
  // Uyuşmazlık KONTROLÜ burada DEĞİL: hiçbir şey yazılmadan önce, çağıranın erken kapısında
  // (runDurableInner/streamDurableInner). İki yerde kontrol iki gerçeklik demek olurdu; burada
  // yapılan tek şey, sahibi bilinen bir thread'de sahibi ADINI vermeyen çağırana onu vermek.
  // Kısa devre korunuyor: özne beyan edilmişse depoya hiç gidilmez.
  //
  // OKUMA HATASI YAYILIR (`.catch` yok, bilerek — registry.ts'teki iş akışı/ağ kapılarıyla aynı
  // karar). Yutulan hata burada "sahibi yok" diye okunuyordu ve `:input` ilk yazan kazandığı için
  // sonucu KALICI: depo bir an arızalandı diye koşum sonsuza dek sahipsiz doğuyor, `ownershipDenied`
  // `!owner` dalında sessizce geçiyor ve `purgeResource` o koşumu hiç bulamıyor.
  const rid = resourceId ?? (memory.getThreadResource ? await memory.getThreadResource(threadId) : undefined);

  if (typeof memory.loadContext === 'function') {
    // Rich path (Phase 14 AgentMemory): composes recall + WM + OM + tool in a single pass.
    const mc = await memory.loadContext(threadId, { query: lastUserText(rawIncoming), resourceId: rid, incoming: rawIncoming });
    const history = mc.messages ?? [];
    // F1: strip client-echoed history first (full-history POSTing clients), THEN the retry dedupe.
    const incoming = dropEchoedHistory(history, rawIncoming, echoCompare);
    // Retry dedupe (see historyEndsWithIncoming): when the loaded history already ends with this
    // turn's incoming (a prior attempt write-ahead-appended it), do NOT concat it again — the model
    // would see the user message twice and writeAheadIncoming would store it twice.
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
    return { incoming, wmTool: mc.tools, alreadyStored, provenance, historyCount: history.length, ...(rid ? { adoptedResourceId: rid } : {}) };
  }
  // Legacy path (BasicMemory / SemanticMemory) — provenance is the limited truth this path can see:
  // everything loaded counts as the recent window (no recall refs, no OM).
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
  return { incoming, alreadyStored, provenance, historyCount: history.length, ...(rid ? { adoptedResourceId: rid } : {}) };
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

/** What `persistInput` froze under `:input` (plus the format stamp, which readers ignore).
 *  `resourceId` was always WRITTEN here (see persistInput) and simply never listed — the type
 *  described the fields the replay path read. The derived-run ownership gate reads it, so it is spelled
 *  out now rather than reached for through a cast. */
type FrozenInput = { prompt?: unknown; messages?: unknown; system?: unknown; threadId?: string; resourceId?: string; hash?: string; actor?: string; workKey?: string; workScope?: WorkScope };

/**
 * NOT EVERY `:input` IS A FROZEN AGENT INPUT.
 *
 * The key does two jobs now. On the agent path it holds the frozen request (persistInput). On the
 * workflow (registry.ts), NETWORK (registry.ts) and batch-item (batch.ts) paths it holds an IDENTITY
 * record and nothing else — `{at, resourceId?, actor?, threadId?, workflow|network|batch}` — written
 * there because the ownership gate, `listRunsPaged({resourceId})` and `purgeResource` all read THAT
 * key and nowhere else. Putting the owner anywhere else would have meant rewriting three surfaces.
 *
 * The agent path, meanwhile, decides "this input is already frozen" from the key's TRUTHINESS. So an
 * identity record read as a frozen input, and `adoptFrozenInput` then assigned its (absent)
 * prompt/messages/system onto `rest` — i.e. UNDEFINED. Measured on a workflow runId handed to
 * `runDurable`: an empty request went to the model, and the agent's model/tool rows landed under a
 * runId that already belongs to a workflow. batch.ts's own header had written the invariant down —
 * "resumeRun'la RESUME EDİLMEZ (frozen :input yok)" — and the identity write is what made it false.
 *
 * BOTH HALVES OF THE TEST ARE LOAD-BEARING. The record NAMES ITSELF (`workflow`/`network`/`batch`),
 * and it carries none of prompt/messages/system. Either half alone over-reaches: a run started with
 * `messages` and no `prompt` is a perfectly ordinary frozen input, and a future identity field on a
 * real agent run must not disqualify it. A genuine persistInput record always has one of the three
 * (an agent run with no request at all is not a thing this engine produces).
 *
 * ONE helper, three call sites (runDurable / streamDurable / resumeRun) — a second copy of this
 * predicate is a second definition of what "frozen" means.
 *
 * EXPORTED because retention asks the same question: an identity record leaves NO readable entry
 * behind, so the sweep could not date it and kept it forever (see sweepRuns). "Is this a frozen
 * agent input or a name tag?" must have one answer, not one per module.
 */
export function identityOnlyInput(frozen: FrozenInput | undefined): { kind: 'workflow' | 'network' | 'batch'; name?: string } | undefined {
  if (!frozen || typeof frozen !== 'object') return undefined;
  const f = frozen as FrozenInput & { workflow?: unknown; network?: unknown; batch?: unknown };
  // A LIST rather than a chain of ternaries: this predicate has already lagged the vocabulary once —
  // the network path started writing identity records and the ternary chain didn't know the word, so
  // a network runId walked into the agent door exactly the way a workflow runId used to.
  const KINDS = ['workflow', 'network', 'batch'] as const;
  const kind = KINDS.find((k) => typeof (f as Record<string, unknown>)[k] === 'string');
  if (kind === undefined) return undefined;
  if (f.prompt !== undefined || f.messages !== undefined || f.system !== undefined) return undefined;
  const name = (f as Record<string, unknown>)[kind] as string;
  return { kind, ...(name ? { name } : {}) };
}

/**
 * The refusal, ADDRESSED. The repo's refusal style is that the error names the remedy — and the
 * remedy here is not "retry", it is "you are holding the wrong kind of id". Dropping through
 * silently was the measured failure: the agent path proceeded, wrote its own rows under a workflow's
 * runId, and the `:input` claim (first-wins) meant the identity record could not even be overwritten
 * — two kinds of record racing for one key.
 */
function refuseIdentityOnlyInput(runId: string, id: { kind: 'workflow' | 'network' | 'batch'; name?: string }): NotAnAgentRunError {
  const n = id.name ?? '?';
  // The remedy is per-DOOR, because "you are holding the wrong kind of id" is only half an answer —
  // the other half is which door this id opens.
  const REMEDY: Record<typeof id.kind, string> = {
    workflow: `Drive it with runWorkflow('${n}', …, { runId }) — or use a fresh runId for an agent run.`,
    network: `Drive it with runNetwork('${n}', { runId, task }) — or use a fresh runId for an agent run.`,
    batch: `Answer a batch item through the batch's own run() with \`approvals\` — or use a fresh runId for an agent run.`,
  };
  return new NotAnAgentRunError(
    `@gnldev/durable: runId "${runId}" belongs to the ${id.kind} '${n}', not to an agent run — its ':input' entry is an ` +
      `IDENTITY record (owner/thread/actor), not a frozen request, so there is no prompt to resume with. ` +
      REMEDY[id.kind],
    { runId, kind: id.kind, ...(id.name ? { name: id.name } : {}) },
  );
}

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
/**
 * The RESUME half of the input chain: re-enter every `processInput` with its RETURN VALUE DISCARDED,
 * so a policy gate still fires on the turn that does the work while a transform cannot double-apply.
 *
 * The gap this closes: `processInput` runs before `persistInput`, its output is frozen into `:input`,
 * and a resume adopted that frozen copy without calling the chain at all. Correct for a redactor,
 * silently wrong for a tripwire — and a suspended run's REAL turn is the resume: the human approves,
 * the tool runs, the money moves. Measured with a moderation processor and a user blocked between the
 * two turns: no throw, and the payment went through. That is a governance hook failing open, the same
 * failure `composeOnStepFinish` exists to prevent one layer down.
 *
 * Each gate is handed the SAME effective input rather than the previous gate's output. Chaining would
 * be re-running the transform — precisely what is being avoided — and the frozen text already IS the
 * whole chain's output from attempt 1, so it is what every gate should be judging.
 *
 * The ctx is the REAL one, not the silenced proxy `makeEchoView` uses, and that is the point: a
 * moderation processor routing its decision through `ctx.step` replays attempt 1's verdict from the
 * journal instead of paying for a second model call, and `recordProcessorReport` is first-wins so the
 * report is not written twice. Closing the gate does not cost a judge call per resume.
 *
 * NOT on a run that already ENDED. The gate exists to protect the turn that does fresh work; a
 * re-entry of a 'completed' (or 'canceled') run replays from the journal — no model call, no side
 * effect — so a throw there protects nothing and does real damage: it reaches runDurable's outer
 * catch, and recordRunOutcome is monotonic-by-time, so the victim's 'completed' verdict is
 * overwritten by 'failed' with a strictly newer stamp. Measured: an at-least-once redelivery of a
 * finished run, plus a blocklist change in between, flipped the run's ledger entry to
 * failed:"blocked" while its output sat right there in the timeline — the same corruption class
 * assertThreadOwnership was moved before runStarted to prevent. The caller decides (`gateResume`)
 * because the verdict must be read BEFORE runStarted stamps 'running' over it; by the time this
 * function runs, the prior outcome is already gone.
 */
async function runResumeGates(
  processors: Processor[],
  procCtx: ProcessorCtx | undefined,
  rest: PreparedInput,
): Promise<void> {
  if (procCtx === undefined) return; // no processors configured on this worker
  const gates = processors.filter((p) => typeof p.processInput === 'function' && p.resumeGate !== false);
  if (gates.length === 0) return;
  const gateCtx: ProcessorCtx = { ...procCtx, resume: true };
  // A SHALLOW COPY of `messages`, not the live array. Dropping the return value stops a gate from
  // REPLACING the input; it does not stop one from EDITING it, and `rest.messages` is the very array
  // that goes to the model. A third-party processor written as `input.messages.push(...)` — a
  // perfectly ordinary shape for an attempt-1 transform — therefore appended to the FROZEN thread
  // once per resume, and the text went to the provider: the back door of "the transform is not
  // applied a second time".
  // The copy is deliberately SHALLOW: mutating an element in place is still the processor's own
  // responsibility. A deep copy would mean cloning the entire thread on every resume — a real cost
  // on a long conversation, paid to defend against a narrower mistake than the one measured here.
  const pin: ProcessorInput = {
    system: systemText(rest.system) || undefined,
    messages: Array.isArray(rest.messages) ? [...rest.messages] : rest.messages,
    prompt: rest.prompt,
  };
  // Return value dropped on purpose — `rest` is NOT touched here. A throw (ProcessorTripwire, or any
  // other) propagates to runDurable's outer catch and stamps the run 'failed', which is exactly what
  // the same throw does on attempt 1.
  for (const p of gates) await p.processInput!(pin, gateCtx);
}

async function applyInputProcessors(
  processors: Processor[],
  procCtx: ProcessorCtx | undefined,
  journal: Journal,
  runId: string,
  frozen: FrozenInput | undefined,
  threadId: string | undefined,
  rest: PreparedInput,
  span?: IncomingSpan,
  /** False when the run's prior outcome is already an ending — see runResumeGates' "NOT on a run that already ENDED". */
  gateResume = true,
): Promise<IncomingSpan | undefined> {
  if (frozen !== undefined) {
    const adopted = await adoptFrozenInput(journal, runId, frozen, threadId, rest, span);
    // AFTER adoption, deliberately: the gate must judge what the model will ACTUALLY be sent this
    // turn, which on a resume is the frozen input — not the caller's raw body, which was just
    // discarded. A gate reading the body would be vetting a text nobody sends.
    if (gateResume) await runResumeGates(processors, procCtx, rest);
    return adopted;
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
 *  processors are supported — a non-deterministic selection is journaled via ctx.step (resume gets the same subset). */
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
 * Returns `undefined` → SKIP the append: the marker is `true` (finished) or another worker has a
 * FRESH (< MEM_APPEND_TTL_MS) pending claim (in-flight, no self-heal needed).
 * Returns an object → YOU do the append: either you won a fresh `claim` on an empty key, or you
 *    took over a STALE pending claim (crash/transient-error self-heal — see task note finding A). When
 *    done, promote it to `true` with `markMemoryAppendDone(journal, marker, the-returned-object)`.
 * Takeover is atomic if putIfMatch(CAS) is available: even if two workers see the same stale pending
 * claim, only ONE takes it over. Otherwise falls back to a best-effort put — the SAME narrow window
 * as the old get→put (documented, the core-hardening review).
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
 * first model call. The thread ROW was already write-ahead (AgentMemory.loadContext →
 * ensureThreadIndexed creates it, titled from the first user message, before any token arrives) —
 * but the MESSAGES only landed at completion, so a run that died before its first token left a
 * titled-but-EMPTY thread: the user's own message was gone from every read surface even though the
 * journal's `:input` still held it. Appending `incoming` here closes that asymmetry; the
 * completion-time append (both call sites below) then persists only the PRODUCED messages.
 *
 * Idempotency is two-layered, mirroring the completion marker:
 * `alreadyStored` (prepareMemoryContext's tail-dedupe) — covers retries across DIFFERENT runIds
 *    re-sending the identical text (the playground mints a fresh runId per attempt).
 * the `memUserAppended` two-phase marker — covers SAME-runId retries racing concurrently, where
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
  const wrote = await appendBatchOnce(memory, journal, runId, threadId, runKeys.memUserAppended(runId), incoming);
  // PHASE 3: provenance stamp for the incoming half — the completion append stamps only `produced`.
  if (wrote) await recordAppendedTaintProvenance(journal, runId, threadId, limits, incoming);
}

/**
 * F4 — durability review: a SAME-runId re-entry (resume after suspension, retry) whose
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

// D4-retry bounded TURN-level retry-with-feedback ladder for
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

    // A per-step processor threw and the SDK swallowed it (see composeOnStepFinish). Raise it here,
    // BEFORE the sentinel checks: the hook asked for the run to stop, and it is the caller's own
    // error type — reporting anything else would mislabel a deliberate block.
    if (stepHookFailure.error !== undefined) throw stepHookFailure.error;

    // K1 + A block sentinel OR a tool-step limit stopped the composeStopWhen loop → convert
    // to a real typed error and throw (unrelated to the retry ladder — never retried).
    const finishError = streamFinishError((result as any).steps ?? []);
    if (finishError) throw finishError;

    const interrupts: Interrupt[] = [];
    for (const step of (result as any).steps ?? []) {
      for (const part of step.content ?? []) {
        if (hasSuspend(part)) interrupts.push(...surfacedInterrupts(part.output.__gnl_suspend));
      }
    }

    // 8.7 Output processors: run ONLY on a completed run (not suspended) — same as before D4-retry,
    // now with a catch for ProcessorRetry.
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
      // result.text/response may be getter-only → shadow with an own data property (assign would blow up).
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
/**
 * Key families the journal OWNS. A runId is not just an identifier — it is a key PREFIX
 * (`<runId>:model:0`, `<runId>:tool:<id>`, `<runId>:input`), and `purgeRun` deletes by that prefix
 * (`retention.ts`, `del(`${runId}:`)`). So a caller who chooses `runId: 'mem'` is not naming a run;
 * they are naming the memory keyspace, and the next retention sweep deletes it. MEASURED: a run
 * created with that id, then swept, removed a victim thread's messages.
 *
 * runId was the ONLY unvalidated identifier on the write path — `resourceId`, `batchId`, `itemKey`
 * and `orgId` all have checks. This closes it in the ENGINE rather than at each HTTP surface,
 * because the surfaces are exactly what keeps being forgotten: chat-adapter, agui, batch, the CLI
 * and every host route reach `runDurable` directly.
 *
 * NOT a charset whitelist. Existing deployments run UUIDs, `chat-<ms>-<n>`, `sim-...` and hand-made
 * ids; a strict pattern would refuse work that is already journalled. The rule is narrower and aimed
 * at the actual damage: a runId may not CLAIM a family the journal already owns. The engine's own
 * composite ids (`batch:`, `sched:`, `net:`, `agent:`, `wfrun:`) are deliberately absent from this
 * list — they are constructed by the engine and their prefixes really are theirs.
 */
const RESERVED_KEY_ROOTS = ['mem', 'xthr', 'xid', 'xrun', 'om', 'thread', 'lesson', 'sugg', 'suggstats', 'org', 'res'];

/**
 * Every `#` in this id sits inside a VALID embedded derived id — i.e. the engine put it there.
 *
 * THE BUG THIS EXISTS FOR, measured end to end before the line was written. A run that has been
 * rolled over, forked or replayed is called `run1_<digest>#2` (`#fork-1`, `#replay-0`). When such a
 * run delegates, the ENGINE builds the child's id: `nestedAgentRunId` returns
 * `agent:run1_<digest>#2:<toolCallId>`, and `net:`/`wf:` produce the same shape. That string does not
 * START with `run1_`, so it fell past the first branch and landed on the blanket `#` refusal below —
 * the engine refusing an id the engine had just minted. Not an edge: a long-lived agent's FIRST
 * delegation after a period handoff died there, permanently, with no id the caller could choose
 * instead.
 *
 * THE FIX IS ON THE FILTER SIDE, deliberately. `nestedAgentRunId` stays a pure function of
 * (parentRunId, toolCallId) — limits.ts (`sumSubRuns`) and retention.ts (the purge cascade) never
 * observe a child being created, they RE-DERIVE its id from the parent's tool entries, so any
 * escaping or rewriting there would make a purge miss a sub-agent's output.
 *
 * THE RULE IS THE SHAPE, NOT A PREFIX WHITELIST. Split on ':' — the separator the engine composes
 * with — and require every segment that contains a '#' to be a whole derived id (`isDerivedRunId`,
 * anchored). So `agent:run1_<32hex>#2:tc` passes and `benim#işim`, `order-1#2`,
 * `agent:run1_zzz#2:tc`, `agent:run1_<hex>#2x:tc` and `agent:run1_<hex>#2#3:tc` all still throw.
 * Listing `agent`/`wf`/`net` instead would bless the prefix rather than the spelling, and the next
 * composite prefix would arrive with the same bug.
 *
 * The bare `run1_<digest>#2` never reaches here — it is judged by the first branch, unchanged.
 */
function onlyEmbeddedDerivedHashes(runId: string): boolean {
  for (const segment of runId.split(':')) {
    if (segment.includes('#') && !isDerivedRunId(segment)) return false;
  }
  return true;
}

/** Throws when a runId would claim (or corrupt) a key family that is not its own. */
export function assertRunIdSafe(runId: unknown): asserts runId is string {
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new Error("@gnldev/durable: runId must be a non-empty string — it becomes the prefix of this run's journal keys.");
  }
  if (runId.length > 512) {
    throw new Error(`@gnldev/durable: runId is too long (${runId.length} > 512).`);
  }
  // Control characters and whitespace do not survive key round-trips intact across the four adapters
  // (and make a key impossible to read in a log or a purge confirmation).
  if (/[\u0000-\u001f\u007f\s]/.test(runId)) {
    throw new Error("@gnldev/durable: runId must not contain whitespace or control characters — it becomes a journal key.");
  }
  // The engine's OWN namespace, and the one family on this list that the caller is allowed to spell
  // — as long as they spell it exactly.
  //
  // `runDurable`/`resumeRun`/`forkRun` take a RAW runId and always will: a hash cannot be reversed,
  // so a caller resuming derived work has nothing to hand back except the derived id itself (§7).
  // That makes "refuse everything starting with run1_" the wrong rule; the rule is "refuse everything
  // that WEARS the namespace without being minted by it". `run1_<32 lowercase hex>` with at most one
  // execution suffix passes; `run1_deadbeef`, uppercase hex, and `run1_<hex>:child` do not.
  //
  // Why this is a reservation at all: inside run1_ the digest IS the ownership statement (§5 makes
  // strictInput unconditional there, with no opt-out). An id that is shaped like a derived id but was
  // typed by hand carries no such statement, and every gate downstream would read it as if it did.
  //
  // '#' is refused everywhere else because the execution axis is the engine's alphabet, not the
  // caller's (§4). `run1_<hex>#2` means "the second deliberate execution of this exact work"; if
  // `order-1#2` were also legal the character would mean one thing in one namespace and nothing in
  // another, and the mapping back from id to workKey — which spans the suffix — would stop being a
  // function. MEASURED before writing this: no code path in the repo mints a runId containing '#'.
  //
  // PACKAGE #4 CLOSED THE OTHER HALF, and the measurement is worth keeping: the three rerun paths
  // used to paste text onto a runId (`time-travel.ts` `${src}:fork:${Date.now()}`, `rollover.ts`
  // `${base}@${n}`, `regression.ts` `:replay:${Date.now()}:${seq}`). Given a DERIVED source, the first
  // and the third produced strings that wear this prefix without the shape — i.e. they threw right
  // here, from inside the engine, on a call the user made correctly. All three now branch on
  // `parseDerivedRunId`: a derived source gets `#fork-<n>` / `#<n>` / `#replay-<seq>`, a raw source
  // keeps its old spelling byte for byte. Two regimes on purpose — `#` stays unspellable outside
  // `run1_`, and no journal written before today has to move.
  if (runId.startsWith(DERIVED_RUN_ID_PREFIX)) {
    if (!isDerivedRunId(runId)) {
      throw new Error(
        `@gnldev/durable: runId '${runId.slice(0, 60)}' uses '${DERIVED_RUN_ID_PREFIX}', which is reserved for ` +
          'engine-derived ids — the engine mints them from a workKey as ' +
          `'${DERIVED_RUN_ID_PREFIX}<32 lowercase hex>' with an optional '#<n≥2>', '#replay-<seq>' or ` +
          "'#fork-<n>' suffix, and an id that only looks derived would be trusted like one. " +
          'Choose an id outside this prefix.',
      );
    }
  } else if (runId.includes('#') && !onlyEmbeddedDerivedHashes(runId)) {
    throw new Error(
      `@gnldev/durable: runId '${runId.slice(0, 60)}' contains '#', which the engine reserves for its ` +
        "execution axis ('<derived id>#2' is the second deliberate run of the same work). Pick another separator.",
    );
  }
  const root = runId.split(':', 1)[0]!;
  if (RESERVED_KEY_ROOTS.includes(root) || root.startsWith('__')) {
    throw new Error(
      `@gnldev/durable: runId '${runId.slice(0, 60)}' starts with the reserved key family '${root}:' — ` +
      "runIds are journal key PREFIXES, and a retention sweep of this run would delete that family. Choose another id.",
    );
  }
  // The other half of the same rule, and the one the family list cannot express: the two RECORD
  // separators. `parseJournalKey` reads a key with `^(.*):(model|tool):.+$` — GREEDY, so the split
  // lands at the LAST occurrence. A run called `pipeline:tool:x` writes `pipeline:tool:x:model:0`,
  // which parses back as run `pipeline:tool:x` (fine) — but it also writes `pipeline:tool:x:input`,
  // and every key it owns sits inside the namespace `parseJournalKey` reads as run `pipeline`,
  // kind `tool`. Two runs then answer for one set of records: `readRun('pipeline')` returns this
  // run's entries as if they were its own tool records, and `reconstructState` replays them.
  //
  // Reachable from OUTSIDE, which is why it is refused here rather than documented. @gnldev/chat-adapter
  // derives its runId as `${body.id}:${lastMessage.id}` from a client-supplied conversation id, so a
  // caller who names a conversation `x:tool` picks the separator itself. The rule stays as narrow as
  // the damage: a bare colon is still legal (that derivation depends on it) — only the two segments
  // the journal reads as "a record of this kind starts here" are refused.
  //
  // The TRAILING form belongs to the same rule and was missing. A run called `pipeline:model` writes
  // `pipeline:model:input`, which `parseJournalKey` reads as run `pipeline`, kind `model` — so the
  // run index grows a row named `pipeline` that no run ever wrote. Measured: the sweep and the
  // operator surfaces refuse to delete it (isRealRun holds, `gnl doctor` names it), so nothing is
  // lost — but `listRuns` reports a run that does not exist, and the cheapest place to stop that is
  // where the id is accepted.
  //
  // The run gate stays NARROWER than `assertThreadId`, on purpose, and the difference is not an
  // oversight to be tidied away later. `assertThreadId` is `/(^|:)(model|tool)(:|$)/` — anchored at
  // the start too, because a threadId lands in the MIDDLE of a key (`mem:<id>:…`), so a leading
  // segment of it can start somebody else's record. A runId is always a key PREFIX, so only its
  // TAIL can. Measured: `model:pipeline:input` parses to null and `model:pipeline:model:0` parses
  // back to `model:pipeline` — itself, correctly. Refusing the leading form here would reject ids
  // that work, for a harm that does not exist on this side.
  if (/:(?:model|tool)(?::|$)/.test(runId)) {
    const which = /:model(?::|$)/.test(runId) ? ':model' : ':tool';
    throw new Error(
      `@gnldev/durable: runId '${runId.slice(0, 60)}' contains the journal's record separator '${which}' — ` +
      'that is how a key says "a model/tool record starts here", so this run\'s keys would be read back ' +
      'as records of a DIFFERENT run. Colons are fine; these two segments are not. ' +
      'If a run with this id is ALREADY in your journal (it was accepted before this version), it can ' +
      'no longer be resumed or re-run, but `purgeRun(journal, id)` still deletes it — that call is not ' +
      'gated by this check. Give the work a new id.',
    );
  }
}

/**
 * What every agent entry point does to its arguments before the run starts. One function, so a rule
 * added here reaches runDurable AND streamDurable — the two used to carry their own copy, and a fix
 * to one never reached the other.
 *
 * The rule it holds today: `ModelInput` is `LanguageModelV4 | string`. Passing 'nvidia/…' straight
 * to runDurable used to type-check and then die inside the AI SDK with "model.doGenerate is not a
 * function"; 1562c8c6 resolved the string in runDurableInner only, so streamDurable kept dying
 * ("Cannot create proxy with a non-object as target") on the same published type.
 */
async function normalizeEntryArgs<T extends { model?: unknown }>(args: T): Promise<T> {
  return typeof args.model === 'string' ? { ...args, model: await resolveModel(args.model) } : args;
}

export async function runDurable(args: RunDurableArgs): Promise<DurableResult> {
  // The failure half of the run's outcome record. The success half is written at the completion choke
  // point inside runDurableInner, where "did it actually finish" is already established (a suspended
  // run returns normally with interrupts and must NOT be recorded as completed).
  // BEFORE the try: a bad runId must reject the CALL, not be recorded as this run's failure —
  // `runFailed(journal, args.runId, ...)` would itself write under the very prefix being refused.
  assertRunIdSafe(args.runId);
  try {
    return await runDurableGuarded(await normalizeEntryArgs(args));
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
  // on top of an already-reverted world would silently "complete" a transaction that was undone.
  await assertNotCompensated(args.journal, args.runId);
  // P2-cancel: same terminal-refusal contract as compensation — a durably-canceled run never
  // (re)starts or resumes (the per-step mid-flight gate lives in durable-model.ts).
  await assertNotCanceled(args.journal, args.runId);
  const lock = (args as any).lock;
  if (lock) {
    const handle = await acquireRunLock(args.journal, args.runId, lock.owner, lock.ttlMs);
    if (!handle) {
      if ((args as any).conflictLedger) await recordIdemConflict(args.journal, { runId: args.runId, code: 'run_busy', ...((args as any).actor ? { actor: (args as any).actor } : {}) }, (args as any).auditOnReject ?? 'best-effort');
      throw Object.assign(new RunBusyError(runBusyMessage(`run '${args.runId}' is already running — it is locked by another process`)), { atLockAcquisition: true });
    }
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
  // `workKey`/`workScope` are pulled OUT of `rest` deliberately: `rest` is both the frozen input and
  // the option bag handed to `generateText`, so a declared name left in it would travel to the
  // provider as an unknown request field and land in `:input` twice under two different meanings.
  const { journal, runId, guard, approvals, memory, threadId, resourceId, channel, agentName, workKey, workScope, replay, lock: _lock, processors, schemaCompat, limits, exclusiveModelStep, replayCacheMaxBytes, toolPolicy, timeouts, strictInput, conflictLedger, tombstonePolicy, actor, auditOnReject, replayDisclosure, model, tools, stopWhen, ...rest } =
    args as RunDurableArgs & Record<string, any>;
  // `model` is already a model object here — string ids are resolved in normalizeEntryArgs.
  // ONE read of `:input`, shared by the ownership check, the adoption and persistInput below (see
  // applyInputProcessors). Read + asserted BEFORE runStarted/resolveApprovals — see
  // assertThreadOwnership's own doc for why the order matters (K2/K3 hardening).
  const frozenInput = await journal.get<FrozenInput>(runKeys.input(runId));
  // WHOSE runId IS THIS — asked before the ownership check, because a workflow/batch identity record
  // is not a frozen agent input at all (see identityOnlyInput). Refused on the SAME read, and before
  // anything is written: an agent attempt against a workflow's runId used to proceed on an empty
  // request and leave its rows under that workflow's prefix.
  const identityOnly = identityOnlyInput(frozenInput);
  if (identityOnly) throw refuseIdentityOnlyInput(runId, identityOnly);
  try {
    assertThreadOwnership(frozenInput, runId, threadId);
  } catch (e) {
    // FAZ-4 ledger: the flagship conflict leaves a trace too (best-effort, PII-free).
    if (conflictLedger && e instanceof RunThreadMismatchError) await recordIdemConflict(journal, { runId, code: 'run_thread_mismatch', ...(actor ? { actor } : {}) }, auditOnReject ?? 'best-effort');
    throw e;
  }
  // ÖZNE↔THREAD, HİÇBİR ŞEY YAZILMADAN ÖNCE. İlk yazışta bu kontrol prepareMemoryContext'in
  // içindeydi — yani `runStarted` ve `resolveApprovals`'tan SONRA. Sonucu ölçüldü: reddedilen
  // çağıran, kurbanın TAMAMLANMIŞ koşumunun outcome'unu 'failed'a çeviriyor ve journal'a kalıcı bir
  // onay kararı bırakıyordu. Bir yetki reddi, reddettiği kişinin geçmişine yazamaz.
  // Kardeş hata (RunThreadMismatchError) için aynı gerekçe outcome.ts:33-38'de kelimesi kelimesine
  // yazılı ve çözümü iki yarımlı: erken fırlat (burası) + outcome'da "koşum başarısızlığı sayma"
  // listesine gir (NOT_A_RUN_FAILURE).
  //
  // BİLİNMEYEN sahip geçer, OKUNAMAYAN sahip DÜŞÜRÜR. Burada `.catch(() => undefined)` vardı ve o
  // satır iki farklı şeyi tek cevaba indiriyordu: "bu thread'in henüz sahibi yok" ile "sahibinin kim
  // olduğunu okuyamadım". İkincisi yutulunca kapı tam da deposu arızalıyken devre dışı kalıyor —
  // yani en çok gerektiği anda. Aynı gerekçe registry.ts'teki iş akışı ve ağ kapılarında da yazılı.
  if (memory && threadId && resourceId && typeof memory.getThreadResource === 'function') {
    const owner = await memory.getThreadResource(threadId);
    if (owner && owner !== resourceId) {
      throw new ThreadOwnerMismatchError(
        `@gnldev/durable: thread "${threadId}" belongs to a different resourceId — this run names "${resourceId}".`,
        { threadId, owner, requested: resourceId },
      );
    }
  }
  // FAZ-4: fingerprint the RAW caller input BEFORE memory prep mutates rest.messages (post-prep
  // content grows with the thread — hashing it would 409 every legitimate resume).
  const rawInputHash = rawInputFingerprint(rest);
  await assertRunAdmissible(journal, runId, frozenInput, rawInputHash, { strictInput, conflictLedger, auditOnReject, tombstonePolicy, actor, resourceId, approvals });
  // RESUME-GATE probe, BEFORE runStarted buries the verdict under 'running': a re-entry of a run
  // that already ENDED replays from the journal and must not be judged by the input gates — a throw
  // there overwrites the ending with 'failed' (see runResumeGates). 'failed' is NOT an ending here:
  // its retry does fresh work. Fresh runs (no frozen input) skip the read entirely.
  const priorOutcome = frozenInput !== undefined ? await readRunOutcome(journal, runId) : undefined;
  const gateResume = priorOutcome?.status !== 'completed' && priorOutcome?.status !== 'canceled';
  // WRITE-AHEAD outcome: this attempt has STARTED. A run SIGKILLed anywhere past this line reads
  // 'running' — never 'completed', which is what the absence of any record used to mean. Sits after
  // the lock (the guarded path acquires before calling here), so a caller that never got in never
  // touches the live run's record. Best-effort like every outcome write.
  await runStarted(journal, runId, Date.now());
  // AUDIT (approval first-class): BEFORE ctx is set up — claim the parameter's approvals into the
  // journal + merge with the journal's existing approvals (see the resolveApprovals header).
  const resolvedApprovals = await resolveApprovals(journal, runId, approvals, {
    ...(actor ? { actor } : {}),
    // Askıdaki (ve bayat/çökmüş) kayıt terminal DEĞİLDİR, yani fikir değiştirmeye açıktır; taze bir
    // 'running' ise kararın UYGULANDIĞI andır. Tek yardımcı, iki koşum yolu — bkz. hasRunProbe.
    hasRun: hasRunProbe(journal, runId, timeouts?.claimTtlMs),
  });
  // C2: on resume, fetch model/tool entries in a single query → hot replay reads take 1 round-trip instead of N.
  // On the first run there are no entries → undefined (no cache). Consume-once: see ctxGet.
  const ctx: DurableCtx = { journal, runId, threadId, resourceId, channel, guard, approvals: resolvedApprovals, replay, limits, toolPolicy, blockedAsSentinel: true, toolTimeoutMs: timeouts?.toolMs, claimTtlMs: timeouts?.claimTtlMs, toolResultProcessors: processors, replayCache: await loadReplayCache(journal, runId, { maxBytes: replayCacheMaxBytes }), replayLog: [] };
  const procCtx = processors?.length ? createProcessorCtx(journal, runId) : undefined;

  // Memory: load thread history (prepend to messages) + inject working memory into the system prompt.
  let incoming: any[] = [];
  let wmTool: Record<string, any> | undefined; // Phase 14: rich memory's updateWorkingMemory tool
  let incomingStored = false; // retry dedupe — see prepareMemoryContext/writeAheadIncoming
  let memCtx: MemoryContextRecord | undefined; // ':memctx' provenance — frozen next to ':input' below
  let historyCount = 0; // where the loaded history ends inside rest.messages — see reconcileProcessedIncoming
  // Özne beyan edilmediğinde belleğin BENİMSEDİĞİ thread sahibi — `:input`'a o yazılır (aşağıya bak).
  let adoptedResourceId: string | undefined;
  let loadedHistory: any[] = []; // what MEMORY returned this turn — the dedupe's second witness
  // Said HERE rather than at the entry point, because here is where the id is actually dropped — the
  // condition below IS the drop, and a warning that sits next to the branch it describes cannot drift
  // away from it.
  if (threadId) warnThreadIgnored(threadId, memory);
  if (memory && threadId) {
    ({ incoming, wmTool, alreadyStored: incomingStored, provenance: memCtx, historyCount, adoptedResourceId } = await prepareMemoryContext(memory, threadId, resourceId, rest, makeEchoView(processors, journal, runId)));
    loadedHistory = Array.isArray(rest.messages) ? rest.messages.slice(0, historyCount) : [];
    // F4: same-runId re-entry with interleaved turns — drop the re-concat if the stored copy is visible.
    incomingStored = await dropIncomingIfAppendedEarlier(journal, runId, rest, incoming, incomingStored);
  }

  // REDACTION: what goes to memory must be what the model saw, so the incoming block is re-read from
  // `rest.messages` AFTER the chain ran (see trackIncomingBoundary/reconcileProcessedIncoming).
  const trackIncoming = memory && threadId && !incomingStored ? incomingSpan(rest, historyCount) : undefined;
  // `frozenInput` was already read (and its thread ownership asserted) above, before runStarted.
  const span = procCtx || frozenInput !== undefined
    ? await applyInputProcessors(processors ?? [], procCtx, journal, runId, frozenInput, threadId, rest, trackIncoming, gateResume)
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

  // SAHİP: beyan edilen ya da BENİMSENEN. Özne verilmediğinde bellek zaten thread'in sahibini
  // benimsiyor (prepareMemoryContext) — ama `:input`'a ham değer yazılıyordu, yani koşum bellekte
  // Ayşe'nin, journal'da SAHİPSİZ oluyordu. Sahipsizlik kalıcıdır (`:input` ilk yazan kazanır) ve
  // sahipsiz bir koşumda `ownershipDenied` sessiz geçer: sonradan gelen bir çağrı kendi öznesini
  // beyan edip cevabı kurbanın thread'ine yazdırabiliyordu. Belleğin okuduğu sahiple journal'ın
  // yazdığı sahip AYNI olmalı, yoksa iki farklı gerçeklik olur ve kapı yanlış olanı okur.
  await persistInput(journal, runId, rest, frozenInput !== undefined, threadId, agentName, resourceId ?? adoptedResourceId, rawInputHash, actor, { ...(workKey ? { workKey } : {}), ...(workScope ? { workScope } : {}) });
  await persistMemoryContext(journal, runId, memCtx);
  // Freeze `limits` into the journal on the first run (idempotent via `claim` — the FIRST
  // run's limits win, a later resume never overwrites them). resumeRun reads this back when the caller
  // doesn't re-supply `limits`, so a resumed run keeps its cost cap / loop / duplicate / taint gates.
  if (limits) await claim(journal, runKeys.cfgLimits(runId), serializableLimits(limits));
  // WRITE-AHEAD user message (see writeAheadIncoming): journal `:input` first (the WAL), then memory —
  // a run that fails before its first token keeps the user's message visible in the thread.
  if (memory && threadId) await writeAheadIncoming(journal, memory, threadId, runId, incoming, incomingStored, limits);
  // (opt-in `taintScope: 'thread'`): if a prior turn on this thread was tainted, mark THIS
  // run tainted BEFORE the agent loop — the taint gate then fires for this run's side effects.
  // PHASE 3: `rest.messages` here is the FINAL visible context (memory + processors already applied)
  // exactly what the model sees, which is what content-window expiry must be judged against.
  await inheritThreadTaint(journal, runId, threadId, limits, { messages: rest.messages, memory: memory || undefined });

  // Phase 14: also merge in rich memory's updateWorkingMemory tool → durableTools wraps it (journaled).
  let effectiveTools = wmTool ? { ...tools, ...wmTool } : tools;
  if (procCtx && effectiveTools) effectiveTools = await applyToolProcessors(processors!, procCtx, effectiveTools, rest);

  // 8.8 Tool-schema compat (opt-in): provider-specific tool-schema transformation. PURE + BEFORE the model
  // call + BEFORE durableTools wraps it → doesn't touch the journal, argsHash/toolCallId/replay unaffected.
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
  // callbacks. Only set when a processor implements the hook (undefined = zero behavior change).
  if (procCtx && processors?.length) {
    const prep = composePrepareStep(processors as Processor[], procCtx);
    if (prep) options.prepareStep = prep;
    // The holder is read by the stop condition below: AI SDK 7 swallows a throw from onStepFinish,
    // so a processor that blocks a run only takes effect if WE notice and stop.
    const onStep = composeOnStepFinish(processors as Processor[], procCtx, stepHookFailure);
    if (onStep) options.onStepFinish = onStep;
  }
  // Replay-disclosure (opt-in): the wrapper composes over whatever prepareStep exists (or none).
  if (replayDisclosure === 'explain') {
    options.prepareStep = withReplayDisclosure(options.prepareStep, ctx);
  }

  // D4-retry: generateText + finishError/suspend handling + the output-processor gate, wrapped in the
  // bounded retry-with-feedback ladder (see runGenerateWithRetryLadder above for the full contract —
  // includes the K1/W1 sentinel-to-error conversion and the 8.7 output-processor pass, byte-for-
  // byte unchanged for a run with no ProcessorRetry-throwing processor).
  const { result: ladderResult, interrupts, produced: processedProduced } = await runGenerateWithRetryLadder(options, processors, procCtx, journal, runId, stepHookFailure);
  let result = ladderResult;

  // Memory: idempotent append on completion (not suspended) — resume/retry does NOT double-write.
  // TWO-PHASE MARKER (review finding A — see claimMemoryAppend/markMemoryAppendDone): if the pending
  // claim is STALE (crash/transient-error), the NEXT retry SELF-HEALS — with the old boolean-claim,
  // if append threw an error the marker stayed permanently 'claimed' and history was lost FOREVER.
  // DELIBERATELY NOT WRAPPED in try/catch: let the error propagate to the CALLER (runDurable rejects)
  // thanks to the pending marker, a legitimate retry with the SAME runId retries the append (see the
  // memory self-heal tests).
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
    // Overwrites any 'failed' from an earlier attempt: a run that was fixed and resumed to success is
    // not a failed run. Inside the `interrupts.length === 0` branch, so a suspended run — which returns
    // normally, awaiting a human — is not mislabelled as finished.
    await runSucceeded(journal, runId, Date.now());
  }

  return Object.assign(result, { interrupts, ...(ctx.replayLog?.length ? { replayedToolCalls: ctx.replayLog } : {}) });
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
   * reverted to defaults). The most dangerous shape of that hole: an approvals resume of a SUSPENDED
   * run — the human approves ONE call, and the continuation runs unguarded. Pass the SAME limits the
   * original run used.
   *
   * `limits` alone was not enough — resume also silently dropped `processors` (prompt-injection
   * tool-result redaction/flagging), `lock`, `timeouts`, `exclusiveModelStep`, `schemaCompat`, and
   * `toolPolicy`. The whole protection set must survive resume; pass the SAME config the original run used.
   */
  limits?: RunLimits;
  /** K5: resume must not silently drop the disclosure policy the original run used. */
  replayDisclosure?: 'explain' | 'silent';
  /** K5: kanal etiketi de resume'da düşmez (XID origin tutarlılığı). */
  channel?: string;
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
  /** FAZ-7: 'require' makes the ledger append a PRECONDITION of the refusal — its failure propagates
   *  Instead of warning (never refuse unrecorded). Default 'best-effort'. Only meaningful with conflictLedger. */
  auditOnReject?: 'best-effort' | 'require';
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
/**
 * How resumeRun treats each of gnl's own run options. `satisfies Record<DurableOwnKey, …>` makes this
 * TOTAL: a new option added to RunDurableArgs does not compile until someone decides here whether a
 * resume carries it. The hand-written forward list this replaces dropped options silently three times
 * (lock, the protection set, agentName).
 */
type DurableOwnKey = Exclude<keyof RunDurableArgs, keyof GenerateTextOptions>;
const RESUME_POLICY = {
  journal: 'set', runId: 'set', approvals: 'set', limits: 'set',
  threadId: 'from-input', resourceId: 'from-input', agentName: 'from-input',
  workKey: 'from-input', workScope: 'from-input', // frozen in `:input`; the gates read them from there
  guard: 'forward', memory: 'forward', channel: 'forward', replay: 'forward', lock: 'forward',
  processors: 'forward', schemaCompat: 'forward', exclusiveModelStep: 'forward', toolPolicy: 'forward',
  timeouts: 'forward', strictInput: 'forward', conflictLedger: 'forward', tombstonePolicy: 'forward',
  actor: 'forward', auditOnReject: 'forward', replayDisclosure: 'forward', replayCacheMaxBytes: 'forward',
} as const satisfies Record<DurableOwnKey, 'set' | 'forward' | 'from-input'>;

export async function resumeRun(
  runId: string,
  opts: ResumeAgentConfig & { journal: Journal; approvals?: Record<string, boolean> },
): Promise<DurableResult> {
  assertRunIdSafe(runId); // journal I/O'dan ÖNCE: rezerve bir aile adıyla okuma bile yapılmasın
  const input = upgradeFormat(
    await opts.journal.get<{ prompt?: unknown; messages?: unknown; system?: unknown; threadId?: string; resourceId?: string; agent?: string }>(runKeys.input(runId)),
    runKeys.input(runId),
  ); // H13: legacy-format input is upgraded to the current shape on resume
  if (!input) {
    throw new Error(`@gnldev/durable: no recorded input for runId "${runId}" — cannot resume.`);
  }
  // …and the sibling of that refusal, which used to fall through it: the entry EXISTS but is a
  // workflow/batch IDENTITY record, so there is still no recorded input. Addressed rather than
  // silent — the refusal above says what is missing, this one says what the id actually is and
  // which door drives it (see identityOnlyInput).
  const identityOnly = identityOnlyInput(input as FrozenInput);
  if (identityOnly) throw refuseIdentityOnlyInput(runId, identityOnly);
  // `limits` is a runtime value the CLI/embed callers can't re-supply (it isn't part of
  // AgentConfig). If the caller passes `limits`, it wins (explicit override); otherwise recover the
  // limits frozen at run start from the journal so the resumed run keeps its cost cap / loop /
  // duplicate / taint gates instead of silently reverting to no-limits.
  const limits = opts.limits ?? (await opts.journal.get<RunLimits>(runKeys.cfgLimits(runId)));
  const given = opts as unknown as Record<string, unknown>;
  const forwarded: Record<string, unknown> = {};
  for (const [k, how] of Object.entries(RESUME_POLICY)) {
    if (how === 'forward' && given[k] !== undefined) forwarded[k] = given[k];
  }
  return runDurable({
    ...forwarded,
    runId,
    journal: opts.journal,
    model: opts.model,
    tools: opts.tools,
    approvals: opts.approvals,
    stopWhen: opts.stopWhen,
    limits,
    ...(input.messages ? { messages: input.messages } : {}),
    ...(input.prompt ? { prompt: input.prompt } : {}),
    ...(input.system ? { system: input.system } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(input.agent ? { agentName: input.agent } : {}),
    ...((opts as { resourceId?: string }).resourceId ?? input.resourceId ? { resourceId: (opts as { resourceId?: string }).resourceId ?? input.resourceId } : {}),
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
 * the only difference: output processors are applied only to messages being persisted (streamed
 * deltas cannot be transformed).
 *
 * K1/W1 NOTE (B) — (b), READ THIS IF YOU CONSUME `fullStream` DIRECTLY: a
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
 * REJECTS with the TYPED error when a block/limit fired, mirroring runDurable's throw — a
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
// Declared, not inferred — same reason as createAgentTool: inference names a pnpm-internal
// provider-utils path in the emitted .d.ts (TS2742). `StreamTextResult` comes from `ai`, the peer we
// already require, so the published surface stays describable in terms we actually depend on.
/** FAZ-7: how long a streamed lock keeps self-renewing before TTL is allowed to reclaim it — the
 *  Abandonment bound (a dropped, never-drained stream holds the lock at most this long). */
const STREAM_LOCK_MAX_HOLD_MS = 60 * 60_000;

export async function streamDurable(args: StreamDurableArgs): Promise<StreamTextResult<any, any, any>> {
  // R4: bu fonksiyon kapsam DIŞINDA kalmıştı — ve tam da korunması gereken kanal burası.
  // chat-adapter ve agui `gnl.stream` üzerinden buraya iniyor, runId doğrudan istemciden geliyor.
  // Doğrulamayı yalnız runDurable/resumeRun'a koymak, yorumun kendi vaadini ("unutulan hep
  // yüzeyler") tam da unutulan yüzeyde tutmamak demekti.
  assertRunIdSafe(args.runId);
  args = await normalizeEntryArgs(args);
  // Same refusal as runDurable — a compensated run never streams either.
  await assertNotCompensated(args.journal, args.runId);
  // P2-cancel: same terminal-refusal contract as compensation — a durably-canceled run never
  // (re)starts or resumes (the per-step mid-flight gate lives in durable-model.ts).
  await assertNotCanceled(args.journal, args.runId);
  // Same reason as runDurableInner: the declared name leaves `rest` before `rest` becomes both the
  // frozen input and the `streamText` option bag.
  const { journal, runId, guard, approvals, memory, threadId, resourceId, channel, agentName, workKey, workScope, replay, lock, processors, schemaCompat, limits, exclusiveModelStep, replayCacheMaxBytes, toolPolicy, timeouts, strictInput, conflictLedger, tombstonePolicy, actor, auditOnReject, replayDisclosure, model, tools, stopWhen, onBlocked, ...rest } =
    args as StreamDurableArgs & Record<string, any>;
  // (a): opt-in run-lock — acquire BEFORE the setup work (reject a concurrent stream/run of the
  // same runId with RunBusyError). Released on stream finish/error (see the onFinish/onError wrappers).
  // FAZ-7: heartbeat parity with run() — see StreamDurableArgs.lock for the maxHoldMs bound.
  const lockHandle = lock ? await acquireRunLock(journal, runId, lock.owner, lock.ttlMs) : null;
  // FAZ-7 (backlog kapanışı): the streamed lock now SELF-RENEWS — with the bound the OLD design
  // refused it over: an ABANDONED stream (never drained, no abort — no exit callback ever fires)
  // would renew forever. The renewal is therefore HARD-CAPPED (STREAM_LOCK_MAX_HOLD_MS): past the
  // cap the beat stops and TTL reclaims, so abandonment costs a bounded hold, not eternity.
  // Deliberately NOT chunk-liveness-gated: a long tool call emits no chunks, and pausing renewal
  // there would hand the lock to a takeover MID-RUN — the exact double-execution this lock prevents.
  // Same discipline as runDurableGuarded's beat otherwise: ttl/2 interval, unref'd, in-flight renew
  // AWAITED before release. Every exit path releases through ONE function — K8 made structural.
  let hbInflight: Promise<unknown> = Promise.resolve();
  const hbStartedAt = Date.now();
  const hbMaxHold = (lock as { maxHoldMs?: number } | undefined)?.maxHoldMs ?? STREAM_LOCK_MAX_HOLD_MS;
  const hbTimer = lockHandle && lock
    ? setInterval(() => {
        if (Date.now() - hbStartedAt > hbMaxHold) {
          clearInterval(hbTimer!);
          // LOUD (K23): a legitimate stream outliving the cap loses renewal SILENTLY otherwise — the
          // later TTL takeover would then read as an unexplained double-execution.
          console.warn(
            `@gnldev/durable: stream lock for '${runId}' hit its renewal cap (${hbMaxHold}ms) — renewals stopped; ` +
            `TTL (${lock.ttlMs}ms) can now reclaim it. A stream legitimately running this long should raise lock.maxHoldMs.`,
          );
          return;
        }
        hbInflight = lockHandle.renew(lock.ttlMs).catch(() => false);
      }, Math.max(1, Math.floor(lock.ttlMs / 2)))
    : undefined;
  (hbTimer as { unref?: () => void } | undefined)?.unref?.();
  const releaseStreamLock = async (): Promise<void> => {
    if (!lockHandle) return;
    if (hbTimer) clearInterval(hbTimer);
    try { await hbInflight; } catch { /* a failed renew changes nothing about release */ }
    try { await lockHandle.release(); } catch { /* best-effort; TTL reclaims */ }
  };
  if (lock && !lockHandle) {
    if (conflictLedger) await recordIdemConflict(journal, { runId, code: 'run_busy', ...(actor ? { actor } : {}) }, auditOnReject ?? 'best-effort');
    throw Object.assign(new RunBusyError(runBusyMessage(`run '${runId}' is already streaming — it is locked by another process`)), { atLockAcquisition: true });
  }
  // (a): EVERYTHING after a successful acquire runs under a release-on-throw guard. The setup awaits
  // below (thread-ownership assert, runStarted, approvals, memory prep, persistInput...) can all
  // throw or reject, and each used to strand the just-acquired lock until TTL: a thread-mismatch
  // told the caller to fix the id with a 409 while run_busy blocked the CORRECT retry for the whole
  // TTL. TTL is the crash insurance, not the wiring for a known exit.
  try {
    return await afterAcquire();
  } catch (err) {
    await releaseStreamLock();
    throw err;
  }

  async function afterAcquire(): Promise<StreamTextResult<any, any, any>> {
  // ONE read of `:input`, shared with persistInput below — parity with runDurableInner. Read + asserted
  // BEFORE runStarted/resolveApprovals — see assertThreadOwnership's own doc (K2/K3 hardening).
  const frozenInput = await journal.get<FrozenInput>(runKeys.input(runId));
  // Parity with runDurableInner — "unutulan hep yüzeyler": chat-adapter and agui reach the engine
  // through THIS function, so a client-supplied workflow/batch runId arrives here first.
  const identityOnly = identityOnlyInput(frozenInput);
  if (identityOnly) throw refuseIdentityOnlyInput(runId, identityOnly);
  try {
    assertThreadOwnership(frozenInput, runId, threadId);
  } catch (e) {
    // FAZ-4 ledger: the flagship conflict leaves a trace too (best-effort, PII-free).
    if (conflictLedger && e instanceof RunThreadMismatchError) await recordIdemConflict(journal, { runId, code: 'run_thread_mismatch', ...(actor ? { actor } : {}) }, auditOnReject ?? 'best-effort');
    throw e;
  }
  // ÖZNE↔THREAD, HİÇBİR ŞEY YAZILMADAN ÖNCE. İlk yazışta bu kontrol prepareMemoryContext'in
  // içindeydi — yani `runStarted` ve `resolveApprovals`'tan SONRA. Sonucu ölçüldü: reddedilen
  // çağıran, kurbanın TAMAMLANMIŞ koşumunun outcome'unu 'failed'a çeviriyor ve journal'a kalıcı bir
  // onay kararı bırakıyordu. Bir yetki reddi, reddettiği kişinin geçmişine yazamaz.
  // Kardeş hata (RunThreadMismatchError) için aynı gerekçe outcome.ts:33-38'de kelimesi kelimesine
  // yazılı ve çözümü iki yarımlı: erken fırlat (burası) + outcome'da "koşum başarısızlığı sayma"
  // listesine gir (NOT_A_RUN_FAILURE).
  //
  // OKUNAMAYAN sahip DÜŞÜRÜR — runDurableInner'daki kardeş kapının aynısı, aynı gerekçeyle. Bu
  // yüzeyde daha da önemli: chat/agui motora BURADAN giriyor, yani yutulan bir okuma hatasının
  // bedeli en çok kullanılan yolda ödeniyordu.
  if (memory && threadId && resourceId && typeof memory.getThreadResource === 'function') {
    const owner = await memory.getThreadResource(threadId);
    if (owner && owner !== resourceId) {
      throw new ThreadOwnerMismatchError(
        `@gnldev/durable: thread "${threadId}" belongs to a different resourceId — this run names "${resourceId}".`,
        { threadId, owner, requested: resourceId },
      );
    }
  }
  // FAZ-4: fingerprint the RAW caller input BEFORE memory prep mutates rest.messages (post-prep
  // content grows with the thread — hashing it would 409 every legitimate resume).
  const rawInputHash = rawInputFingerprint(rest);
  await assertRunAdmissible(journal, runId, frozenInput, rawInputHash, { strictInput, conflictLedger, auditOnReject, tombstonePolicy, actor, resourceId, approvals });
  // RESUME-GATE probe — the stream twin of runDurableInner's, and it matters MORE here: this is the
  // path chat/agui use, so an at-least-once redelivery of a finished turn arrives on this line.
  // Read BEFORE runStarted buries the verdict (see runResumeGates' "NOT on a run that already ENDED").
  const priorOutcome = frozenInput !== undefined ? await readRunOutcome(journal, runId) : undefined;
  const gateResume = priorOutcome?.status !== 'completed' && priorOutcome?.status !== 'canceled';
  // WRITE-AHEAD outcome — the stream twin of runDurableInner's. A stream abandoned mid-flight (the
  // process died, neither onFinish nor onError ran) reads 'running' instead of 'completed'.
  await runStarted(journal, runId, Date.now());
  // AUDIT (approval first-class): SAME as runDurableInner — BEFORE ctx is set up (see resolveApprovals).
  const resolvedApprovals = await resolveApprovals(journal, runId, approvals, {
    ...(actor ? { actor } : {}),
    // SAME probe as runDurableInner's, from the same helper — the mind-change rule cannot mean one
    // thing on the generate path and another on the path chat/agui actually use (bkz. hasRunProbe).
    hasRun: hasRunProbe(journal, runId, timeouts?.claimTtlMs),
  });
  // C2: on resume, load the replay snapshot (same as runDurableInner).
  const ctx: DurableCtx = { journal, runId, threadId, resourceId, channel, guard, approvals: resolvedApprovals, replay, limits, toolPolicy, blockedAsSentinel: true, toolTimeoutMs: timeouts?.toolMs, claimTtlMs: timeouts?.claimTtlMs, toolResultProcessors: processors, replayCache: await loadReplayCache(journal, runId, { maxBytes: replayCacheMaxBytes }), replayLog: [] };
  const procCtx = processors?.length ? createProcessorCtx(journal, runId) : undefined;

  // Memory: load thread history + inject into system (BEFORE persistInput → replayable).
  let incoming: any[] = [];
  let wmTool: Record<string, any> | undefined;
  let incomingStored = false; // retry dedupe — see prepareMemoryContext/writeAheadIncoming
  let memCtx: MemoryContextRecord | undefined; // ':memctx' provenance — parity with runDurableInner
  let historyCount = 0;
  // runDurableInner ile parite: benimsenen thread sahibi `:input`'a yazılır.
  let adoptedResourceId: string | undefined;
  let loadedHistory: any[] = []; // parity with runDurableInner — the dedupe's second witness
  if (threadId) warnThreadIgnored(threadId, memory); // parity with runDurableInner
  if (memory && threadId) {
    ({ incoming, wmTool, alreadyStored: incomingStored, provenance: memCtx, historyCount, adoptedResourceId } = await prepareMemoryContext(memory, threadId, resourceId, rest, makeEchoView(processors, journal, runId)));
    loadedHistory = Array.isArray(rest.messages) ? rest.messages.slice(0, historyCount) : [];
    // F4: same-runId re-entry with interleaved turns — parity with runDurableInner.
    incomingStored = await dropIncomingIfAppendedEarlier(journal, runId, rest, incoming, incomingStored);
  }

  // REDACTION: post-processor incoming — parity with runDurableInner (see trackIncomingBoundary).
  const trackIncoming = memory && threadId && !incomingStored ? incomingSpan(rest, historyCount) : undefined;
  // `frozenInput` was already read (and its thread ownership asserted) above, before runStarted.
  const span = procCtx || frozenInput !== undefined
    ? await applyInputProcessors(processors ?? [], procCtx, journal, runId, frozenInput, threadId, rest, trackIncoming, gateResume)
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

  // SAHİP: beyan edilen ya da BENİMSENEN. Özne verilmediğinde bellek zaten thread'in sahibini
  // benimsiyor (prepareMemoryContext) — ama `:input`'a ham değer yazılıyordu, yani koşum bellekte
  // Ayşe'nin, journal'da SAHİPSİZ oluyordu. Sahipsizlik kalıcıdır (`:input` ilk yazan kazanır) ve
  // sahipsiz bir koşumda `ownershipDenied` sessiz geçer: sonradan gelen bir çağrı kendi öznesini
  // beyan edip cevabı kurbanın thread'ine yazdırabiliyordu. Belleğin okuduğu sahiple journal'ın
  // yazdığı sahip AYNI olmalı, yoksa iki farklı gerçeklik olur ve kapı yanlış olanı okur.
  await persistInput(journal, runId, rest, frozenInput !== undefined, threadId, agentName, resourceId ?? adoptedResourceId, rawInputHash, actor, { ...(workKey ? { workKey } : {}), ...(workScope ? { workScope } : {}) });
  await persistMemoryContext(journal, runId, memCtx);
  // Freeze `limits` on the first run (parity with runDurableInner) — idempotent via `claim`.
  if (limits) await claim(journal, runKeys.cfgLimits(runId), serializableLimits(limits));
  // WRITE-AHEAD user message (parity with runDurableInner — see writeAheadIncoming). Pre-model, so a
  // memory failure rejects gnl.stream() itself (a clean JSON error) instead of surfacing mid-SSE.
  if (memory && threadId) await writeAheadIncoming(journal, memory, threadId, runId, incoming, incomingStored, limits);
  // Same run-start thread-taint inheritance as runDurableInner (opt-in; parity).
  // PHASE 3: same content-window visibility input as runDurableInner (parity).
  await inheritThreadTaint(journal, runId, threadId, limits, { messages: rest.messages, memory: memory || undefined });

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
  // streamText supports the same prepareStep/onStepFinish surface; onFinish wrapping below is untouched.
  if (procCtx && processors?.length) {
    const prep = composePrepareStep(processors as Processor[], procCtx);
    if (prep) options.prepareStep = prep;
    // The holder is read by the stop condition below: AI SDK 7 swallows a throw from onStepFinish,
    // so a processor that blocks a run only takes effect if WE notice and stop.
    const onStep = composeOnStepFinish(processors as Processor[], procCtx, stepHookFailure);
    if (onStep) options.onStepFinish = onStep;
  }
  // Replay-disclosure (opt-in): the wrapper composes over whatever prepareStep exists (or none).
  if (replayDisclosure === 'explain') {
    options.prepareStep = withReplayDisclosure(options.prepareStep, ctx);
  }
  // Stream finish: output processors (only messages being persisted) + idempotent memory append
  // (marker; stream/non-stream do not double-write, replay-safe). ProcessorTripwire blocks the append
  // but cannot retroactively stop the stream — use an input processor for moderation in streaming.
  // SUSPEND PARITY (audit): IF the run IS SUSPENDED (suspend/limit/block sentinel), completion side
  // effects are NOT processed — same principle as runDurableInner. The old behavior wrote the half
  // conversation to memory and locked the marker → once resume completed, the FINAL answer never made
  // it into memory at all.
  // ONE processOutput pass per turn, shared by the two things that need it: the memory append (in
  // onFinish) and the caller-facing terminal promises (`result.text` / `result.response`, masked in
  // the Proxy below). Memoised SYNCHRONOUSLY on first call, so whichever arrives first computes and
  // the other awaits the same promise — the hook keeps its once-per-turn contract either way.
  //
  // WHY the caller-facing half cannot simply read a value onFinish left behind: measured, the SDK
  // resolves `steps`/`text`/`response` BEFORE our onFinish body finishes (an async processor is still
  // running when they settle). A getter that read a variable set at the end of onFinish would see
  // `undefined` and fall back to raw — non-deterministically. And a getter that WAITED for onFinish
  // would add exactly the "dependence on our own callbacks firing" hang path guardStreamTerminalPromises
  // was written to avoid. The lazy view here is the way out: if onFinish never runs, the getter
  // computes the pass itself from the result's own promises.
  let outputPass: Promise<ProcessorOutput | undefined> | undefined;
  const outputProcessed = (view: () => Promise<any>): Promise<ProcessorOutput | undefined> => {
    outputPass ??= (async () => {
      if (!procCtx) return undefined;
      const ev = await view();
      // SUSPEND PARITY with runDurableInner: a suspended/blocked turn is not a finished output, so
      // the chain does not run on it (and the caller gets the raw value, as it does today).
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
    // providers surface a mid-stream failure only as finishReason:'error' without an error part.
    let streamFailed = false;
    const prevOnFinish = options.onFinish;
    options.onFinish = async (ev: any) => {
      const stepsArr: any[] = ev?.steps ?? [];
      // (b): visibility callback — a block/limit sentinel at stream finish → hand the caller
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
          let produced: any[] = producedMessages(ev);
          if (procCtx) {
            // NOTE (deliberate limitation): a ProcessorRetry thrown here is NOT retried — unlike
            // runDurableInner's retry ladder, this fires AFTER the stream has already flushed to the
            // client, so "let the model try again" would mean re-streaming a turn the caller already
            // saw — a different contract we deliberately do not contort this into. It is caught by the
            // catch below like any other processOutput throw (console.warn, stream itself not broken).
            // Use runDurable/generateText for a processor that needs retry-with-feedback.
            const pout = await outputProcessed(async () => ev);
            if (pout) produced = pout.messages;
          }
          if (memory && threadId) {
            // TWO-PHASE MARKER — SAME pattern/parity as runDurableInner (see claimMemoryAppend).
            // Here INSIDE a try/catch (below) → if append throws, the marker stays 'pending': the
            // NEXT resume/retry (SAME runId) self-heals after the TTL; on this turn the error is
            // made VISIBLE via console.warn but the stream is NOT BROKEN (streamText's own contract).
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
        // former registry TODO: streamed runs no longer depend on a manual backfill to be counted).
        try {
          await recordRunMetrics(journal, journal as unknown as JournalReader, runId, agentName ? { agentName } : {});
        } catch { /* advisory aggregate — must not affect the stream */ }
        // Parity with runDurableInner: inside the completed branch only, so a suspended stream is not
        // recorded as finished. NOT on an errored stream: onFinish fires after onError, and the
        // success write here was measured OVERWRITING the failure the error path had just recorded —
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
      // can proceed. Token-fenced + idempotent: a no-op if the lock was already taken over/released.
      await releaseStreamLock();
      if (prevOnFinish) await prevOnFinish(ev);
    };
    // (a): also release on a stream error (onFinish may not fire on the error path). release()
    // is idempotent, so a later onFinish release is harmless. On abandonment (neither fires), TTL reclaims.
    // Previously wrapped ONLY when a lock existed, so an unlocked stream that failed recorded nothing
    // and read back as 'completed'. Now always wrapped; the release stays conditional.
    const prevOnError = options.onError;
    options.onError = async (ev: any) => {
      const err = (ev as { error?: unknown })?.error ?? ev;
      streamFailed = true; // onFinish still fires after an error — it must not record a success over this
      if (isRunFailure(err)) await runFailed(journal, runId, err, Date.now());
      await releaseStreamLock();
      if (prevOnError) await prevOnError(ev);
    };
    // (a): release on ABORT too — AI SDK 7 fires `onAbort` (NOT onFinish/onError) when the caller's
    // AbortSignal trips mid-stream, so "TTL reclaims on abandonment" was covering a path that is not
    // abandonment at all. With the chat route's default lock + forwarded request signal, "user hit
    // stop / closed the tab" was the COMMON path that stranded the lock: the very next regenerate
    // derives the SAME runId and ate 409 run_busy until the TTL expired.
    const prevOnAbort = (options as any).onAbort;
    (options as any).onAbort = async (ev: any) => {
      await releaseStreamLock();
      if (prevOnAbort) await prevOnAbort(ev);
    };
  }
  let rawStream: any;
  // OUTPUT-PROCESSOR PARITY WITH runDurable. Measured before this existed, with the same redactor
  // installed on both entry points:
  //     runDurable    → result.text  'cevap: [MASKED_EMAIL]'
  //     streamDurable → result.text  'cevap: gizli@ornek.com'     ← RAW
  // Only the messages heading for MEMORY were processed here; everything handed back to the caller
  // was the model's own output. So the caller who uses the stream for its durability and then reads
  // `await result.text` (log it, store it, return it from an HTTP handler) received exactly what an
  // output processor exists to prevent — and the same code under runDurable did not. That asymmetry
  // is the leak; this closes it.
  //
  // SCOPE, stated plainly: `text` and `response.messages` are the `{text, messages}` VIEW the
  // processOutput contract is written in, and they are all that is masked — same line runDurable
  // draws (see the KNOWN RESIDUAL note there). `textStream`/`fullStream` are NOT masked and cannot
  // be: the deltas were already flushed to the client before the turn ended, and a chunk-wise
  // transform is not derivable from a whole-turn hook (a value can straddle two deltas; a
  // summarising processor has no per-chunk meaning at all). So on the stream path an output
  // processor governs what is PERSISTED and what the terminal promises return — not what the client
  // already saw byte-by-byte. Use an INPUT processor, or runDurable, if the delta stream itself must
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
      // reject a promise that has never rejected for this reason, so the raw value is returned —
      // identical to the behaviour before masking existed, never worse.
      return value;
    }
    if (!pout) return value; // no processors, or a suspended/blocked turn — unchanged
    if (prop === 'text') return typeof pout.text === 'string' ? pout.text : value;
    return value && typeof value === 'object' ? { ...(value as any), messages: pout.messages } : value;
  };

  // (b): wrap the result so the terminal promises (result.text & friends) REJECT with the
  // typed streamFinishError when a block/limit sentinel fired — see guardStreamTerminalPromises.
  // A synchronous streamText throw is released by afterAcquire's caller-side catch above.
  rawStream = streamText(options);
  const guarded = guardStreamTerminalPromises(rawStream, procCtx ? maskTerminal : undefined);
  // FAZ-7: the replay signal HTTP layers asked for (X-Gnl-Idempotency-Status) — true when this runId
  // had frozen input before this call (a resume/replay), false on a fresh run. A plain property on
  // the result; the proxy forwards reads/writes to the target.
  (guarded as unknown as { __gnlPriorRun?: boolean }).__gnlPriorRun = frozenInput !== undefined;
  // K28 kapanışı: zarf STREAM yüzeyinde de çıkar. LAZY getter — tool replay'leri stream TÜKETİLİRKEN
  // olur, dönüş anında liste boştur; finish'ten sonra okuyan (server'ın done-frame'i, onFinish
  // tüketicileri) dolu listeyi görür. Proxy get'i hedefe iletir; own-property getter önce gelir.
  Object.defineProperty(guarded, 'replayedToolCalls', {
    get: () => (ctx.replayLog?.length ? ctx.replayLog : undefined),
    enumerable: false, configurable: true,
  });
  return guarded;
  } // afterAcquire — post-acquire body under the release-on-throw guard
}
