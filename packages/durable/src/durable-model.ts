import { wrapLanguageModel, simulateReadableStream } from 'ai';
import type { LanguageModelV2, LanguageModelV2CallOptions, LanguageModelV2Middleware } from '@ai-sdk/provider';
import { argsHash } from './hash.js';
import { claim, ctxGet, runKeys } from './journal.js';
import { stampFormat } from './format.js';
import { enforceStepLimits } from './limits.js';
import { assertNotCanceled } from './cancel.js';
import { RunBusyError } from './errors.js';
import { withTimeout } from './timeout.js';
import type { DurableCtx } from './journal.js';
import type { JournalReader } from './journal.js';

/**
 * Wraps the model: RECORDS every LLM response into the journal keyed by (runId, stepIndex);
 * on resume, REPLAYS the same response → the agent makes the same decision (deterministic replay).
 *
 * stepIndex only advances after a SUCCESSFUL generate; on a transient error (retry) the same
 * key is reused → retries do not shift the replay key.
 */

// Model-step write-ahead claim record — SAME IDEA as durableTool's 'running'/'succeeded'/'failed'
// claim pattern, but carries a model-specific field (reqHash).
type ModelClaimRecord = { status: 'running' | 'succeeded' | 'failed'; startedAt: number; reqHash?: string };

/**
 * the core-hardening review (opt-in): model-step exclusivity. When enabled, the worker that LOSES the
 * claim race gets a `RunBusyError` if the existing record is 'running' and FRESH (startedAt newer
 * than ttlMs ago) → prevents duplicate `doGenerate` (double token cost) under concurrent multi-resume.
 * STALE 'running' (crashed owner) continues with the existing behavior — the fast crash-resume window
 * is NOT BROKEN.
 */
export type ExclusiveStepOptions = { ttlMs?: number };

/** Opt-in behavior switches for withDurableModel (default: all off = existing behavior). */
export type DurableModelOptions = {
  exclusiveStep?: ExclusiveStepOptions;
  /**
   * Y1 (opt-in): model step timeout (ms). Applied to the entire doGenerate in generate; in stream,
   * applied to the doStream call (up to the first byte) — NOT to the entire streaming flow (the
   * stream already progresses in chunks, the hang risk is in connection setup). On timeout,
   * StepTimeoutError is thrown → claim is marked 'failed', retry/resume retries the same step
   * (replay key does not shift).
   */
  stepTimeoutMs?: number;
};

// §5.3: default for the "fresh running" threshold — same order of magnitude as run-lock TTLs (seconds).
const DEFAULT_EXCLUSIVE_TTL_MS = 30_000;

// H2: use the storage's own clock if available (clock-skew-resistant TTL decision), otherwise Date.now.
async function journalNow(ctx: DurableCtx): Promise<number> {
  return ctx.journal.now ? ctx.journal.now() : Date.now();
}

/**
 * §5.3: write the model-step 'running' claim — with an optional exclusivity gate.
 *
 * exclusive OFF (default): existing behavior EXACTLY — unconditional `put` (overwrites), never throws.
 * exclusive ON: tries an atomic `claim` (putIfAbsent); if lost, checks the existing record:
 *   - 'running' + FRESH (now - startedAt < ttlMs) → `RunBusyError` (another worker is processing that step).
 *   - 'running' + STALE / 'failed' / other → existing behavior: overwrite, continue (the double-call
 *     risk is deliberately accepted — the FAST resume after a real crash happens in this window).
 * NOTE: RunBusyError is thrown WITHOUT touching the claim (the record belongs to the other worker) and
 * since it's not an APICallError, it isn't swallowed by the AI SDK's retry — it reaches the caller as-is.
 */
async function acquireModelClaim(
  ctx: DurableCtx,
  claimKey: string,
  reqHash: string | undefined,
  exclusive: ExclusiveStepOptions | undefined,
): Promise<void> {
  if (!exclusive) {
    await ctx.journal.put(claimKey, { status: 'running', startedAt: Date.now(), reqHash });
    return;
  }
  const now = await journalNow(ctx);
  const record: ModelClaimRecord = { status: 'running', startedAt: now, reqHash };
  if (await claim(ctx.journal, claimKey, record)) return; // fresh key: won atomically
  const existing = await ctx.journal.get<ModelClaimRecord>(claimKey);
  const ttlMs = exclusive.ttlMs ?? DEFAULT_EXCLUSIVE_TTL_MS;
  if (existing?.status === 'running' && now - existing.startedAt < ttlMs) {
    throw new RunBusyError(
      `model step '${claimKey}' is being processed by another worker (claim ${now - existing.startedAt}ms old, ttl ${ttlMs}ms)`,
    );
  }
  // STALE running (crash) / failed (retry) / leftover succeeded → existing behavior: overwrite, continue.
  await ctx.journal.put(claimKey, record);
}

// DETERMINISTIC components of the model request: messages/tool schema/sampling parameters.
// DELIBERATELY EXCLUDED fields (nondeterministic/opaque → should not produce false positives):
// abortSignal (a fresh object on every call), headers (may carry trace/request-id),
// providerOptions (some providers may inject a timestamp/nonce).
const DETERMINISTIC_PARAM_KEYS = [
  'prompt',
  'maxOutputTokens',
  'temperature',
  'stopSequences',
  'topP',
  'topK',
  'presencePenalty',
  'frequencyPenalty',
  'responseFormat',
  'seed',
  'tools',
  'toolChoice',
] as const;

/**
 * Hash of the model request's determining input (parity with argsHash — the same
 * stableStringify+sha256 pattern). If a field is not serializable (e.g. a circular reference),
 * SILENTLY returns `undefined` → the check is SKIPPED, the run is never BROKEN because of this
 * (PROTECTIVE).
 */
function safeRequestHash(params: LanguageModelV2CallOptions): string | undefined {
  try {
    const picked: Record<string, unknown> = {};
    for (const k of DETERMINISTIC_PARAM_KEYS) {
      const v = (params as Record<string, unknown>)[k];
      if (v !== undefined) picked[k] = v;
    }
    return argsHash(picked);
  } catch {
    return undefined;
  }
}

/**
 * Replay divergence check: DELIBERATELY soft.
 *
 * Observation (discovered while making this change, by running the full test suite): in flows using
 * memory/input-processor, when the caller calls `runDurable` again with the SAME raw arguments
 * (not resumeRun — a common pattern in tests/real usage), the input already written to the journal by
 * `persistInput` is NOT READ BACK; the input processor/memory injection does NOT RUN AGAIN on resume
 * due to idempotency. Result: the `params` the model SEES in this second call may differ from the
 * first run — but this is HARMLESS because that step is already REPLAYED from the journal (the live
 * model is never called). This produces a FALSE POSITIVE for a hard error (an existing, working usage
 * pattern). Therefore: (1) only produce a CHECK/WARNING when `replay:'strict'` (opt-in visibility — no
 * noise for the default user), (2) NEVER THROW a DivergenceError (only console.warn) — the model
 * request is a much broader/noisier surface than a tool argument; a hard error risks breaking a
 * legitimate resume.
 */
async function warnOnModelDivergence(
  ctx: DurableCtx,
  claimKey: string,
  key: string,
  reqHash: string | undefined,
  label: string,
): Promise<void> {
  if (ctx.replay !== 'strict' || reqHash === undefined) return;
  const claimed = await ctxGet<ModelClaimRecord>(ctx, claimKey);
  if (claimed?.reqHash !== undefined && claimed.reqHash !== reqHash) {
    console.warn(`@gnldev/durable: divergence — ${label} (${key}) produced a different request on replay (informational; run not stopped)`);
  }
}

/**
 * AUDIT E2 (entry-point switch breaks replay silently): a model step is journaled in one of TWO shapes —
 * `wrapGenerate` writes the raw doGenerate result (has `content`, NO `.parts`); `wrapStream` writes
 * `{ parts, rest }` (has a `parts` array). If a run created on one path is resumed on the OTHER, the
 * replayed record is the wrong shape: a generate record fed to `simulateReadableStream({ chunks: hit.parts })`
 * has `hit.parts === undefined` → a broken/empty stream; a stream record returned as a generate result is
 * missing `content`. Both used to fail cryptically (or silently). This throws a CLEAR error naming the
 * mismatch so the caller resumes through the same entry point (or starts a fresh runId).
 */
function assertReplayEntryPoint(hit: unknown, expected: 'generate' | 'stream', key: string): void {
  const isStreamRecord = hit != null && typeof hit === 'object' && Array.isArray((hit as { parts?: unknown }).parts);
  if (expected === 'stream' && !isStreamRecord) {
    throw new Error(
      `@gnldev/durable: replay entry-point mismatch at '${key}' — this model step was journaled by the ` +
        'NON-streaming path (runDurable/generateText) but is being replayed through the STREAMING path ' +
        '(streamDurable/streamText). Resume the run through the SAME entry point it was created with ' +
        '(here: runDurable), or start a fresh runId for the streaming path.',
    );
  }
  if (expected === 'generate' && isStreamRecord) {
    throw new Error(
      `@gnldev/durable: replay entry-point mismatch at '${key}' — this model step was journaled by the ` +
        'STREAMING path (streamDurable/streamText) but is being replayed through the NON-streaming path ' +
        '(runDurable/generateText). Resume the run through the SAME entry point it was created with ' +
        '(here: streamDurable), or start a fresh runId for the non-streaming path.',
    );
  }
}

export function withDurableModel(model: LanguageModelV2, ctx: DurableCtx, opts?: DurableModelOptions): LanguageModelV2 {
  let step = 0;
  const middleware: LanguageModelV2Middleware = {
    wrapGenerate: async ({ doGenerate, params }) => {
      const key = runKeys.model(ctx.runId, step);
      // Invisible to parseJournalKey (runKeys.proc) → does NOT AFFECT reader/time-travel/forkRun;
      // only this middleware's write-ahead ledger.
      const claimKey = runKeys.proc(ctx.runId, `__gnl_model_claim:${step}`);
      const reqHash = safeRequestHash(params);
      const hit = await ctxGet(ctx, key);

      if (hit !== undefined) {
        // AUDIT E2: reject a stream-shaped record replayed through the generate path (clear error, not a
        // silent missing-content result).
        assertReplayEntryPoint(hit, 'generate', key);
        // Replay divergence — see warnOnModelDivergence documentation (opt-in, soft).
        await warnOnModelDivergence(ctx, claimKey, key, reqHash, 'model step');
        step++;
        // Check on REPLAY too (not just on a fresh call) — if the same runId is called
        // repeatedly without the limit CHANGING, it re-throws IMMEDIATELY at the SAME step (progress
        // does NOT LEAK); deterministic (same result) since the journal did NOT CHANGE. If the limit
        // is raised, this point is passed through.
        if (ctx.limits) await enforceStepLimits(ctx.journal as unknown as JournalReader, ctx.runId, ctx.limits);
        return hit as Awaited<ReturnType<typeof doGenerate>>;
      }

      // Write-ahead 'running' claim BEFORE the model call. Purpose: the crash window
      // BETWEEN the model response and journaling it becomes VISIBLE on resume (studio/time-travel can
      // read this record and say "this step was left half-done") + reqHash is FIXED here (the
      // divergence check above uses it). DELIBERATELY: unlike durableTool, there is NO TTL-based
      // RunBusyError here — the FAST resume after a real crash (see process-kill.test.ts) happens
      // exactly in this window; a hard lock would break a legitimate exactly-once resume. Protection
      // against concurrent multi-resume is already provided by the opt-in run-level `lock` (see
      // `acquireRunLock` in run.ts).
      // §5.3: if opts.exclusiveStep is given, an ADDITIONAL opt-in gate kicks in (see acquireModelClaim).
      // P2-cancel: durable cross-worker cancel gate — checked ONLY on the FRESH path (a replayed step
      // above returns untouched: replay reconstructs work that already happened, cancel stops NEW
      // spend). A run canceled from anywhere (server ?durable=true, cancelAgentRun) stops here at its
      // next model-step boundary regardless of which worker is executing it.
      await assertNotCanceled(ctx.journal, ctx.runId);
      await acquireModelClaim(ctx, claimKey, reqHash, opts?.exclusiveStep);
      let result: Awaited<ReturnType<typeof doGenerate>>;
      try {
        // Y1: opt-in step timeout — a timeout falls into the catch, claim becomes 'failed' (retry key does not shift).
        result = opts?.stepTimeoutMs
          ? await withTimeout(doGenerate(), opts.stepTimeoutMs, `model step ${step}`)
          : await doGenerate();
        await ctx.journal.put(key, stampFormat(result as object)); // H13: format stamp (a copy — _v does not leak into result)
        await ctx.journal.put(claimKey, { status: 'succeeded', startedAt: Date.now(), reqHash });
      } catch (error) {
        // Transient error: mark the claim as 'failed' → the NEXT attempt (retry/resume) continues
        // immediately — the existing "retry does not shift the replay key" behavior is PRESERVED (step did not advance).
        await ctx.journal.put(claimKey, { status: 'failed', startedAt: Date.now(), reqHash });
        throw error;
      }
      step++;
      // Checked AFTER the step is SUCCESSFULLY journaled (journal is already consistent) —
      // RunLimitExceededError is thrown from here on breach; since it's OUTSIDE the try/catch, it does
      // NOT MARK the claim as 'failed' (the step genuinely succeeded, only the run's CONTINUATION is being stopped).
      if (ctx.limits) await enforceStepLimits(ctx.journal as unknown as JournalReader, ctx.runId, ctx.limits);
      return result;
    },
    // Streaming: record/replay stream chunks (reconstruct with simulateReadableStream).
    wrapStream: async ({ doStream, params }) => {
      const key = runKeys.model(ctx.runId, step);
      const claimKey = runKeys.proc(ctx.runId, `__gnl_model_claim:${step}`);
      const checkpointKey = runKeys.proc(ctx.runId, `__gnl_stream_checkpoint:${step}`);
      const reqHash = safeRequestHash(params);
      const hit = await ctxGet<{ parts: any[]; rest: Record<string, unknown> }>(ctx, key);
      if (hit !== undefined) {
        // AUDIT E2: reject a generate-shaped record (no `.parts`) replayed through the stream path —
        // otherwise simulateReadableStream chokes on `undefined` chunks (silent/cryptic broken stream).
        assertReplayEntryPoint(hit, 'stream', key);
        // SAME divergence check as generate (see warnOnModelDivergence).
        await warnOnModelDivergence(ctx, claimKey, key, reqHash, 'model stream step');
        step++;
        // SAME replay-recheck as generate (see wrapGenerate) — does not leak progress.
        if (ctx.limits) await enforceStepLimits(ctx.journal as unknown as JournalReader, ctx.runId, ctx.limits);
        return {
          stream: simulateReadableStream({ chunks: hit.parts, initialDelayInMs: 0, chunkDelayInMs: 0 }),
          ...hit.rest,
        } as any;
      }
      // SAME write-ahead claim as generate (see above — rationale there).
      // §5.3: SAME opt-in exclusivity gate as generate (see acquireModelClaim).
      // P2-cancel: durable cross-worker cancel gate — checked ONLY on the FRESH path (a replayed step
      // above returns untouched: replay reconstructs work that already happened, cancel stops NEW
      // spend). A run canceled from anywhere (server ?durable=true, cancelAgentRun) stops here at its
      // next model-step boundary regardless of which worker is executing it.
      await assertNotCanceled(ctx.journal, ctx.runId);
      await acquireModelClaim(ctx, claimKey, reqHash, opts?.exclusiveStep);
      let result: Awaited<ReturnType<typeof doStream>>;
      try {
        // Y1: in stream, the timeout is applied to the doStream call (up to the first byte) — see DurableModelOptions.
        result = opts?.stepTimeoutMs
          ? await withTimeout(doStream(), opts.stepTimeoutMs, `model stream step ${step}`)
          : await doStream();
      } catch (error) {
        await ctx.journal.put(claimKey, { status: 'failed', startedAt: Date.now(), reqHash });
        throw error;
      }
      const { stream, ...rest } = result;
      const myStep = step;
      step++;
      const parts: any[] = [];
      // Periodic PARTIAL checkpoint so a crash in long streams doesn't lose the WHOLE step.
      // The happy-path (flush) RESULT stays EXACTLY THE SAME — the checkpoint is only an ADDITIONAL
      // write for observability/forward-recovery purposes; it does NOT CHANGE the CONTENT of the final
      // `key` or the MOMENT it is written.
      const CHECKPOINT_EVERY = 10;
      const recorder = new TransformStream<any, any>({
        async transform(chunk, controller) {
          parts.push(chunk);
          controller.enqueue(chunk);
          if (parts.length % CHECKPOINT_EVERY === 0) {
            // Idempotent: each time, the SAME checkpointKey is overwritten with ALL chunks so far
            // (overwrite, not append) → a half-finished write does NOT BREAK replay (only the
            // forensic/recovery data stays incomplete/stale, the stream itself is unaffected).
            try {
              await ctx.journal.put(checkpointKey, { parts: parts.slice(), rest, partial: true });
            } catch {
              /* checkpoint is best-effort — must never stop the stream */
            }
          }
        },
        flush: async () => {
          // Happy path: EXACTLY the same as the behavior so far — the final record is written with the full `parts`.
          await ctx.journal.put(runKeys.model(ctx.runId, myStep), stampFormat({ parts, rest })); // H13
          await ctx.journal.put(claimKey, { status: 'succeeded', startedAt: Date.now(), reqHash });
          // SAME post-hoc check as generate (see wrapGenerate) — the step is already journaled.
          if (ctx.limits) await enforceStepLimits(ctx.journal as unknown as JournalReader, ctx.runId, ctx.limits);
        },
      });
      return { stream: (stream as any).pipeThrough(recorder), ...rest } as any;
    },
  };
  return wrapLanguageModel({ model, middleware });
}
