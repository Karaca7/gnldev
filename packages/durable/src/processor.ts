// 8.7 — Processor pipeline (durability-infused). Input/output/tool transformers.
// Principle: input processors run BEFORE persistInput → the transformed input is journaled →
// It does NOT RUN AGAIN on resume (drift impossible). Non-deterministic processors journal via `ctx.step`.
import { runKeys } from './journal.js';
import type { Journal } from './journal.js';

export interface ProcessorInput {
  system?: string;
  messages?: any[];
  prompt?: unknown;
}

export interface ProcessorOutput {
  text: string;
  messages: any[];
  /** Raw generateText result (read-only; message/text fields already given above). */
  result: any;
}

export interface ProcessorCtx {
  runId: string;
  journal: Journal;
  /** Journals a non-deterministic step (model-based moderation etc.) → same decision on resume. */
  step<T>(name: string, compute: () => Promise<T> | T): Promise<T>;
  /** Run input at the processTools call (a signal like the last user message — used by toolSearch). */
  input?: ProcessorInput;
}

export interface Processor {
  /** Required, stable, unique — used as a journal key segment. */
  name: string;
  /** Transform the message/system BEFORE the model (PII redaction, normalization). */
  processInput?(input: ProcessorInput, ctx: ProcessorCtx): Promise<ProcessorInput> | ProcessorInput;
  /** Restrict the tool set the model SEES (toolFilter/toolSearch). May be async; NON-deterministic
   *  Selections (embedding-based toolSearch) must journal the decision via `ctx.step` → same tool
   *  Subset on resume. */
  processTools?(tools: Record<string, any>, ctx: ProcessorCtx): Record<string, any> | Promise<Record<string, any>>;
  /**
   * Transform the final output/messages AFTER the model (output redaction, moderation). D4-retry:
   * May also throw `ProcessorRetry` — same retry-with-feedback ladder as `processOutputStep` (see its
   * Doc below), just decided once at the end of the turn instead of after every step.
   */
  processOutput?(output: ProcessorOutput, ctx: ProcessorCtx): Promise<ProcessorOutput> | ProcessorOutput;
  /**
   * AUDIT HOOK (tool-output prompt-injection defense): called AFTER tool execute returns
   * SUCCESSFULLY, BEFORE 'succeeded' is written to the journal (durable-tool.ts). Used to mark
   * (untrustedToolContent) or redact outside-world content. The TRANSFORMED output is written to
   * The journal → SAME philosophy as processInput's "does not run again on resume": on replay this
   * Hook does NOT RUN A SECOND TIME, the transformed value in the journal is returned directly via the exactly-once gate.
   */
  processToolResult?(res: ProcessorToolResult, ctx: ProcessorCtx): Promise<{ output: unknown }> | { output: unknown };
  /**
   * P2-step called before EVERY model
   * Step INSIDE the tool loop (bridged to the AI SDK's `prepareStep`) — unlike `processInput`, which
   * Runs once per runDurable call. May override this step's messages/system/activeTools/model
   * TRANSIENTLY (overrides are NOT persisted — the journal keeps the true conversation; the model's
   * OUTPUT is journaled after, so replayed steps never re-consult this hook's effect).
   * DETERMINISM CONTRACT (same as every processor hook): on resume, FRESH steps re-run this hook — a
   * Pure function of (stepNumber, messages) is automatically safe; anything non-deterministic must
   * Journal its decision via `ctx.step` (toolSearch precedent).
   */
  processInputStep?(step: ProcessorStepInput, ctx: ProcessorCtx): Promise<ProcessorStepOverride | undefined | void> | ProcessorStepOverride | undefined | void;
  /**
   * P2-step: called after EVERY completed model step (bridged to `onStepFinish`) — return value is
   * Ignored; throwing `ProcessorTripwire` fails the run (fail-loud guardrail between steps).
   * D4-retry throwing `ProcessorRetry` instead means "this TURN's
   * Output is unacceptable" — runDurableInner's retry ladder catches it, journals the retry decision,
   * Appends the feedback as a new user message, and calls generateText again for a FRESH turn (bounded:
   * Per-processor `maxRetries` default 1, hard global cap 3/run — see run.ts). Honestly TURN-scoped: this
   * Is NOT step-level retry inside the AI SDK's own tool loop (we don't own that loop).
   * REPLAY NOTE: generateText cannot tell a replayed step from a fresh one, so this fires for
   * REPLAYED steps too (with byte-identical content — deterministic observation); side-effecting
   * Observers must go through `ctx.step`/`recordProcessorReport` (both exactly-once). A REPLAYED
   * `ProcessorRetry` is not re-decided by the ladder: it reads the feedback back from the journal
   * (`retry:<attempt>`, via `durableProcessorStep`) instead of trusting the freshly re-thrown value.
   */
  processOutputStep?(step: ProcessorStepOutput, ctx: ProcessorCtx): Promise<void> | void;
}

/** P2-step: what a per-step input hook sees (the AI SDK prepareStep options, loosely typed). */
export interface ProcessorStepInput {
  stepNumber: number;
  /** The message list the model would receive for THIS step (grows with tool results as the loop runs). */
  messages: any[];
  /** Completed steps so far (AI SDK StepResult[]). */
  steps: unknown[];
}

/** P2-step: transient per-step overrides (all optional; an omitted field keeps the outer setting). */
export interface ProcessorStepOverride {
  messages?: any[];
  system?: string;
  /** Restrict which of the (already-resolved) tools the model may use THIS step (AI SDK activeTools). */
  activeTools?: string[];
  model?: unknown;
}

/** P2-step: what a per-step output hook sees (the AI SDK onStepFinish StepResult, loosely typed). */
export interface ProcessorStepOutput {
  stepNumber: number;
  text?: string;
  toolCalls?: unknown[];
  toolResults?: unknown[];
  finishReason?: string;
  usage?: unknown;
}

/**
 * P2-step: composes the processors' `processInputStep` hooks into ONE AI SDK `prepareStep` function —
 * Sequential merge: each processor sees the EFFECTIVE (already-overridden) messages, later processors
 * Win on field conflicts (same order semantics as the processInput chain). Returns undefined when no
 * Processor implements the hook → the caller leaves prepareStep unset (zero behavior change).
 */
export function composePrepareStep(
  processors: Processor[],
  ctx: ProcessorCtx,
): ((opts: { stepNumber: number; messages: any[]; steps: unknown[] }) => Promise<Record<string, unknown> | undefined>) | undefined {
  const hooked = processors.filter((p) => typeof p.processInputStep === 'function');
  if (!hooked.length) return undefined;
  return async ({ stepNumber, messages, steps }) => {
    const merged: Record<string, unknown> = {};
    let effMessages = messages;
    for (const p of hooked) {
      const o = await p.processInputStep!({ stepNumber, messages: effMessages, steps }, ctx);
      if (!o) continue;
      if (o.messages) { effMessages = o.messages; merged.messages = o.messages; }
      if (o.system !== undefined) merged.system = o.system;
      if (o.activeTools) merged.activeTools = o.activeTools;
      if (o.model !== undefined) merged.model = o.model;
    }
    return Object.keys(merged).length ? merged : undefined;
  };
}

/**
 * P2-step: composes `processOutputStep` hooks into ONE `onStepFinish` callback. A ProcessorTripwire
 * (or any throw) propagates — generateText rejects, the run fails loudly (v1 contract; see the hook's JSDoc).
 */
/** Where a swallowed per-step error is parked so the caller can rethrow it. See composeOnStepFinish. */
export interface StepHookFailure { error?: unknown }

export function composeOnStepFinish(
  processors: Processor[],
  ctx: ProcessorCtx,
  /** Receives the first error a hook throws; the caller stops the loop and rethrows it. */
  failure?: StepHookFailure,
): ((step: any) => Promise<void>) | undefined {
  const hooked = processors.filter((p) => typeof p.processOutputStep === 'function');
  if (!hooked.length) return undefined;
  let stepNumber = 0;
  return async (step: any) => {
    const n = stepNumber++;
    try {
      for (const p of hooked) {
        await p.processOutputStep!(
          { stepNumber: n, text: step?.text, toolCalls: step?.toolCalls, toolResults: step?.toolResults, finishReason: step?.finishReason, usage: step?.usage },
          ctx,
        );
      }
    } catch (err) {
      // AI SDK 7 SWALLOWS anything thrown from onStepFinish — verified against ai@7.0.66; under v5
      // it propagated. A processor that throws to stop a run (ProcessorTripwire, a policy gate)
      // therefore did nothing at all: the loop continued and the run reported success. A governance
      // hook that fails open is worse than no hook, so the error is parked here and the caller —
      // which owns the loop's stop condition — raises it. Same shape as the tool sentinel: the SDK
      // cannot be relied on to carry our control flow, so we carry it ourselves.
      if (failure && failure.error === undefined) failure.error = err;
      throw err; // still thrown, in case a future SDK propagates again — first-wins keeps it idempotent
    }
  };
}

/** Tool-result context passed to processToolResult. */
export interface ProcessorToolResult {
  toolName: string;
  toolCallId: string;
  input: unknown;
  output: unknown;
}

/** Thrown when a processor blocks content (moderation block) → the run stops. */
export class ProcessorTripwire extends Error {
  constructor(
    message: string,
    public readonly processor: string,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ProcessorTripwire';
  }
}

/**
 * D4-retry thrown from `processOutputStep` OR `processOutput` to mean
 * "this TURN's output is unacceptable — append my feedback and let the model try again." Honestly
 * TURN-scoped (see run.ts's retry ladder): a fresh `generateText` call, NOT a retry of a single step
 * Inside the AI SDK's own tool loop (we don't own that loop). `opts.maxRetries` (default 1, enforced by
 * The ladder) bounds how many times THIS processor's retry is honored; a separate hard global cap
 * (3/run) bounds the TOTAL retries regardless of which processor asked (see RetryExhaustedByProcessorError).
 */
export class ProcessorRetry extends Error {
  constructor(
    public readonly feedback: string,
    public readonly processor: string,
    public readonly opts?: { maxRetries?: number },
  ) {
    super(`retry requested by processor '${processor}': ${feedback}`);
    this.name = 'ProcessorRetry';
  }
}

/**
 * D4-retry: thrown by run.ts's retry ladder when a `ProcessorRetry` can no longer be honored — either
 * This processor's own `maxRetries` bound or the hard global cap (3 retries/run) was hit. Carries the
 * LAST feedback so the caller can surface why the run gave up. Deliberately a DISTINCT type from
 * `ProcessorTripwire`: a tripwire is "content blocked" (moderation decision made once); this is "we tried
 * To satisfy the processor and ran out of attempts" — a different failure mode worth telling apart.
 */
export class RetryExhaustedByProcessorError extends Error {
  constructor(
    message: string,
    public readonly processor: string,
    public readonly feedback: string,
  ) {
    super(message);
    this.name = 'RetryExhaustedByProcessorError';
  }
}

/**
 * Journals a non-deterministic processor step: `${runId}:proc:${name}` (invisible to
 * ParseJournalKey). Replays if a record exists → same decision on resume, no duplicate LLM-judge
 * Call. The `{ v }` wrapper also makes `undefined` results distinguishable.
 * NOTE: this get+put is a memoize (sufficient for single-process resume); for places that need two
 * Concurrent workers to not be able to write different results to the same key, use the CAS variant: journal.ts's `frozenGet`.
 */
export async function durableProcessorStep<T>(
  journal: Journal,
  runId: string,
  name: string,
  compute: () => Promise<T> | T,
): Promise<T> {
  const key = runKeys.proc(runId, name);
  const hit = await journal.get<{ v: T }>(key);
  if (hit !== undefined) return hit.v;
  const v = await compute();
  await journal.put(key, { v });
  return v;
}

/** Builds a ProcessorCtx (binds journal + runId; wraps step with the memoize helper). */
export function createProcessorCtx(journal: Journal, runId: string): ProcessorCtx {
  return {
    runId,
    journal,
    step: (name, compute) => durableProcessorStep(journal, runId, name, compute),
  };
}

// ── AUDIT (compliance) reports ─────────────────────────────────────────
// PURPOSE: make "was PII masked / was injection detected / what did moderation flag in this run"
// VISIBLE in the journal. Until now, plain processors (pii/moderation/injection) only reflected
// Their decisions in content transformation (redaction) or a tripwire — "what was found" was NOT
// STORED as a separate record. This helper is additive: it does not touch the hot path
// (applyInputProcessors/durableTool/generateText), it only provides a side-record that processors call BY THEIR OWN CHOICE.

/** An audit finding a processor produces in a run (PII redaction, injection detection, etc.). */
export interface ProcessorReport {
  name: string;
  phase: 'input' | 'output' | 'tool';
  findings: unknown;
  ts?: number;
}

/**
 * Records a processor finding into the journal: `${runId}:procreport:${name}:${phase}`. Because
 * This key pattern does NOT CONTAIN `:model:`/`:tool:`, it is INVISIBLE to `parseJournalKey` (same
 * Principle as proc/cfgModel/input — does not leak into reader/time-travel).
 *
 * OVERWRITE-SAFE: SAME get-first pattern as `durableProcessorStep` — returns WITHOUT WRITING
 * ANYTHING if the key already exists. In the scenario where processOutput/processToolResult CAN BE
 * CALLED AGAIN on resume (runDurableInner re-runs generateText on replay, replaying the steps
 * Already recorded in the journal), this guarantees the report is written EXACTLY ONCE — the caller
 * Can freely call recordProcessorReport on EVERY processOutput/processToolResult call, trusting
 * That findings are deterministic (same input → same finding).
 *
 * BEST-EFFORT: even if the journal is missing/broken (e.g. a minimal fake ctx in tests), the error
 * Is SWALLOWED — this is an audit/observability side-record and must NEVER break the main processor
 * Flow (redaction/tripwire) (same best-effort principle as `recordRunUsage` in run.ts).
 */
export async function recordProcessorReport(
  ctx: ProcessorCtx,
  name: string,
  phase: 'input' | 'output' | 'tool',
  findings: unknown,
): Promise<void> {
  try {
    const key = `${ctx.runId}:procreport:${name}:${phase}`;
    if ((await ctx.journal.get(key)) !== undefined) return;
    await ctx.journal.put(key, { v: { name, phase, findings, ts: Date.now() } satisfies ProcessorReport });
  } catch {
    // Audit reports are optional observability — if journal/ctx is missing, it does NOT AFFECT the main flow.
  }
}

/**
 * Reads ALL processor reports recorded for a run (if the journal supports `listKeys`).
 * Returns an empty array if `listKeys` is absent (the adapter doesn't support it) — the SAME
 * "optional capability" fallback pattern as the audit/scores read APIs.
 */
export async function readProcessorReports(journal: Journal, runId: string): Promise<ProcessorReport[]> {
  if (typeof journal.listKeys !== 'function') return [];
  const prefix = `${runId}:procreport:`;
  const keys = await journal.listKeys(prefix);
  const out: ProcessorReport[] = [];
  for (const key of keys) {
    const hit = await journal.get<{ v: ProcessorReport }>(key);
    if (hit && typeof hit === 'object' && 'v' in hit) out.push(hit.v);
  }
  out.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0) || a.name.localeCompare(b.name) || a.phase.localeCompare(b.phase));
  return out;
}
