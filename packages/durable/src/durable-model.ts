import { wrapLanguageModel, simulateReadableStream } from 'ai';
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Middleware } from '@ai-sdk/provider';
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
 * On resume, REPLAYS the same response → the agent makes the same decision (deterministic replay).
 *
 * StepIndex only advances after a SUCCESSFUL generate; on a transient error (retry) the same
 * Key is reused → retries do not shift the replay key.
 */

// Model-step write-ahead claim record — SAME IDEA as durableTool's 'running'/'succeeded'/'failed'
// Claim pattern, but carries a model-specific field (reqHash).
type ModelClaimRecord = { status: 'running' | 'succeeded' | 'failed'; startedAt: number; reqHash?: string };

/**
 * The core-hardening review (opt-in): model-step exclusivity. When enabled, the worker that LOSES the
 * Claim race gets a `RunBusyError` if the existing record is 'running' and FRESH (startedAt newer
 * Than ttlMs ago) → prevents duplicate `doGenerate` (double token cost) under concurrent multi-resume.
 * STALE 'running' (crashed owner) continues with the existing behavior — the fast crash-resume window
 * Is NOT BROKEN.
 */
export type ExclusiveStepOptions = { ttlMs?: number };

/** Opt-in behavior switches for withDurableModel (default: all off = existing behavior). */
export type DurableModelOptions = {
  exclusiveStep?: ExclusiveStepOptions;
  /**
   * Y1 (opt-in): model step timeout (ms). Applied to the entire doGenerate in generate; in stream,
   * Applied to the doStream call (up to the first byte) — NOT to the entire streaming flow (the
   * Stream already progresses in chunks, the hang risk is in connection setup). On timeout,
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
 * Exclusive OFF (default): existing behavior EXACTLY — unconditional `put` (overwrites), never throws.
 * Exclusive ON: tries an atomic `claim` (putIfAbsent); if lost, checks the existing record:
 * 'running' + FRESH (now - startedAt < ttlMs) → `RunBusyError` (another worker is processing that step).
 * 'running' + STALE / 'failed' / other → existing behavior: overwrite, continue (the double-call
 *     Risk is deliberately accepted — the FAST resume after a real crash happens in this window).
 * NOTE: RunBusyError is thrown WITHOUT touching the claim (the record belongs to the other worker) and
 * Since it's not an APICallError, it isn't swallowed by the AI SDK's retry — it reaches the caller as-is.
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
// AbortSignal (a fresh object on every call), headers (may carry trace/request-id),
// ProviderOptions (some providers may inject a timestamp/nonce).
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
 * StableStringify+sha256 pattern). If a field is not serializable (e.g. a circular reference),
 * SILENTLY returns `undefined` → the check is SKIPPED, the run is never BROKEN because of this
 * (PROTECTIVE).
 */
function safeRequestHash(params: LanguageModelV4CallOptions): string | undefined {
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
 * Memory/input-processor, when the caller calls `runDurable` again with the SAME raw arguments
 * (not resumeRun — a common pattern in tests/real usage), the input already written to the journal by
 * `persistInput` is NOT READ BACK; the input processor/memory injection does NOT RUN AGAIN on resume
 * Due to idempotency. Result: the `params` the model SEES in this second call may differ from the
 * First run — but this is HARMLESS because that step is already REPLAYED from the journal (the live
 * Model is never called). This produces a FALSE POSITIVE for a hard error (an existing, working usage
 * Pattern). Therefore: (1) only produce a CHECK/WARNING when `replay:'strict'` (opt-in visibility — no
 * Noise for the default user), (2) NEVER THROW a DivergenceError (only console.warn) — the model
 * Request is a much broader/noisier surface than a tool argument; a hard error risks breaking a
 * Legitimate resume.
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
 * A truncated (write-ahead) record, made replayable.
 *
 * The write-ahead copy is cut off at the tool-call chunk, so it has no `finish` part. AI SDK 5
 * executed a tool the moment its call arrived, so replaying those chunks was enough to carry the
 * recorded work forward. AI SDK 7 defers tool execution to the END of a step — measured against
 * ai@7.0.66 — so a stream that never says it finished completes no tools at all: the resume of a
 * crashed run produces silence, which is the exact opposite of what the checkpoint was written for.
 *
 * Appending the missing terminator is honest rather than inventive. The record already tells us what
 * the model produced; the only thing absent is the marker saying it stopped, and the run DID stop —
 * that is why the record is partial. `finishReason` is derived from the recorded content, and usage
 * is zeroed because the truncated record genuinely never carried it (billing a guess would be worse
 * than billing nothing). warnOnPartialReplay has already told the operator this record is partial.
 *
 * Exactly-once is unaffected: the tool calls this lets through are still gated per toolCallId by
 * durableTool, so a tool that already ran replays from its own record instead of running again.
 */
function completeIfTruncated(hit: StreamStepRecord): unknown[] {
  const parts = hit.parts ?? [];
  if (hit.partial !== true) return parts as unknown[];
  if (parts.some((p: any) => p?.type === 'finish')) return parts as unknown[];
  const hasToolCall = parts.some((p: any) => p?.type === 'tool-call');
  return [
    ...parts,
    {
      type: 'finish',
      finishReason: { unified: hasToolCall ? 'tool-calls' : 'stop', raw: 'gnl:partial-replay' },
      usage: {
        inputTokens: { total: 0, noCache: 0, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 0, text: 0, reasoning: undefined },
      },
    },
  ];
}

/** The journaled shape of a streaming step; `partial: true` is only ever set by the write-ahead copy. */
type StreamStepRecord = { parts?: unknown[]; rest?: Record<string, unknown>; partial?: boolean };

/**
 * Memo for the partial-replay warning, keyed on the journal object so it cannot outlive it (same
 * shape as the fallback warnings in journal.ts/limits.ts). The inner set only grows with genuinely
 * partial replays — one entry per crashed step — not per run.
 */
const partialReplayWarned = new WeakMap<object, Set<string>>();

/**
 * A replayed step can be a TRUNCATED one, and nothing used to say so.
 *
 * The streaming recorder below writes a write-ahead copy of the step the moment a tool call arrives
 * (`{ parts, rest, partial: true }`, cut off at that chunk — see stream-crash-window.test.ts). That
 * copy is what a crash-resume reads, and replaying it is the RIGHT call: it is precisely what stops
 * the resume from re-planning and running the side effect a second time. But it is NOT what the model
 * finished saying. Everything streamed after the tool call was never journaled, so the resumed
 * assistant turn ends at the tool call — no closing text, no finish reason, no usage.
 *
 * Serving that as truth without a word is how an operator ends up staring at an assistant turn with
 * its tail missing and nothing anywhere explaining why. So: replay it, and SAY SO — once per
 * (runId, step), naming what the record concretely lacks rather than a generic 'partial data' line.
 */
function warnOnPartialReplay(ctx: DurableCtx, hit: StreamStepRecord, key: string, step: number): void {
  if (hit?.partial !== true) return;
  let seen = partialReplayWarned.get(ctx.journal);
  if (!seen) {
    seen = new Set<string>();
    partialReplayWarned.set(ctx.journal, seen);
  }
  if (seen.has(key)) return;
  seen.add(key);

  const parts = Array.isArray(hit.parts) ? (hit.parts as Array<{ type?: string }>) : [];
  const count = (type: string) => parts.filter((p) => p?.type === type).length;
  // Name what a flushed record would have carried and this one does not — the tail of a stream is
  // exactly the `finish` part plus whatever blocks were still open when the write-ahead fired.
  const missing: string[] = [];
  if (count('finish') === 0) missing.push('the `finish` part (finishReason + usage for this step)');
  const openText = count('text-start') - count('text-end');
  if (openText > 0) missing.push(`the end of ${openText} text block(s) still open at the cut`);
  const openReasoning = count('reasoning-start') - count('reasoning-end');
  if (openReasoning > 0) missing.push(`the end of ${openReasoning} reasoning block(s) still open at the cut`);

  console.warn(
    `@gnldev/durable: replaying a PARTIAL model step — '${key}' (run '${ctx.runId}', step ${step}) was journaled ` +
      'mid-stream by the write-ahead checkpoint on its tool call, not at stream end: the record carries ' +
      `\`partial: true\` and ${parts.length} chunk(s). Absent from it: ` +
      `${missing.length > 0 ? missing.join(', ') : 'whatever followed the tool call'}. ` +
      'Whatever the model streamed AFTER its tool call was never journaled, so this resumed turn ends at the ' +
      'tool call. The tool calls it DID make are recorded — which is why this record is replayed instead of ' +
      're-planned (re-planning would re-run the side effect). Start a fresh runId if you need a complete turn.',
  );
}

/**
 * (entry-point switch breaks replay silently): a model step is journaled in one of TWO shapes —
 * `wrapGenerate` writes the raw doGenerate result (has `content`, NO `.parts`); `wrapStream` writes
 * `{ parts, rest }` (has a `parts` array). If a run created on one path is resumed on the OTHER, the
 * Replayed record is the wrong shape: a generate record fed to `simulateReadableStream({ chunks: hit.parts })`
 * Has `hit.parts === undefined` → a broken/empty stream; a stream record returned as a generate result is
 * Missing `content`. Both used to fail cryptically (or silently). This throws a CLEAR error naming the
 * Mismatch so the caller resumes through the same entry point (or starts a fresh runId).
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

export function withDurableModel(model: LanguageModelV4, ctx: DurableCtx, opts?: DurableModelOptions): LanguageModelV4 {
  let step = 0;
  const middleware: LanguageModelV4Middleware = {
    specificationVersion: 'v4',
    wrapGenerate: async ({ doGenerate, params }) => {
      const key = runKeys.model(ctx.runId, step);
      // Invisible to parseJournalKey (runKeys.proc) → does NOT AFFECT reader/time-travel/forkRun;
      // Only this middleware's write-ahead ledger.
      const claimKey = runKeys.proc(ctx.runId, `__gnl_model_claim:${step}`);
      const reqHash = safeRequestHash(params);
      const hit = await ctxGet(ctx, key);

      if (hit !== undefined) {
        // Reject a stream-shaped record replayed through the generate path (clear error, not a
        // Silent missing-content result).
        assertReplayEntryPoint(hit, 'generate', key);
        // Replay divergence — see warnOnModelDivergence documentation (opt-in, soft).
        await warnOnModelDivergence(ctx, claimKey, key, reqHash, 'model step');
        step++;
        // Check on REPLAY too (not just on a fresh call) — if the same runId is called
        // Repeatedly without the limit CHANGING, it re-throws IMMEDIATELY at the SAME step (progress
        // Does NOT LEAK); deterministic (same result) since the journal did NOT CHANGE. If the limit
        // Is raised, this point is passed through.
        if (ctx.limits) await enforceStepLimits(ctx.journal as unknown as JournalReader, ctx.runId, ctx.limits);
        return hit as Awaited<ReturnType<typeof doGenerate>>;
      }

      // Write-ahead 'running' claim BEFORE the model call. Purpose: the crash window
      // BETWEEN the model response and journaling it becomes VISIBLE on resume (studio/time-travel can
      // Read this record and say "this step was left half-done") + reqHash is FIXED here (the
      // Divergence check above uses it). DELIBERATELY: unlike durableTool, there is NO TTL-based
      // RunBusyError here — the FAST resume after a real crash (see process-kill.test.ts) happens
      // Exactly in this window; a hard lock would break a legitimate exactly-once resume. Protection
      // Against concurrent multi-resume is already provided by the opt-in run-level `lock` (see
      // `acquireRunLock` in run.ts).
      // §5.3: if opts.exclusiveStep is given, an ADDITIONAL opt-in gate kicks in (see acquireModelClaim).
      // P2-cancel: durable cross-worker cancel gate — checked ONLY on the FRESH path (a replayed step
      // Above returns untouched: replay reconstructs work that already happened, cancel stops NEW
      // Spend). A run canceled from anywhere (server ?durable=true, cancelAgentRun) stops here at its
      // Next model-step boundary regardless of which worker is executing it.
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
        // Immediately — the existing "retry does not shift the replay key" behavior is PRESERVED (step did not advance).
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
      const reqHash = safeRequestHash(params);
      const hit = await ctxGet<{ parts: any[]; rest: Record<string, unknown>; partial?: boolean }>(ctx, key);
      if (hit !== undefined) {
        // Reject a generate-shaped record (no `.parts`) replayed through the stream path —
        // Otherwise simulateReadableStream chokes on `undefined` chunks (silent/cryptic broken stream).
        assertReplayEntryPoint(hit, 'stream', key);
        // A write-ahead (truncated) record is still replayed — but never in silence (see warnOnPartialReplay).
        warnOnPartialReplay(ctx, hit, key, step);
        // SAME divergence check as generate (see warnOnModelDivergence).
        await warnOnModelDivergence(ctx, claimKey, key, reqHash, 'model stream step');
        step++;
        // SAME replay-recheck as generate (see wrapGenerate) — does not leak progress.
        if (ctx.limits) await enforceStepLimits(ctx.journal as unknown as JournalReader, ctx.runId, ctx.limits);
        return {
          stream: simulateReadableStream({ chunks: completeIfTruncated(hit), initialDelayInMs: 0, chunkDelayInMs: 0 }),
          ...hit.rest,
        } as any;
      }
      // SAME write-ahead claim as generate (see above — rationale there).
      // §5.3: SAME opt-in exclusivity gate as generate (see acquireModelClaim).
      // P2-cancel: durable cross-worker cancel gate — checked ONLY on the FRESH path (a replayed step
      // Above returns untouched: replay reconstructs work that already happened, cancel stops NEW
      // Spend). A run canceled from anywhere (server ?durable=true, cancelAgentRun) stops here at its
      // Next model-step boundary regardless of which worker is executing it.
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
      const checkpointKey = runKeys.proc(ctx.runId, `__gnl_stream_checkpoint:${step}`);
      const myStep = step;
      step++;
      const parts: any[] = [];
      // Journal the step AS SOON AS IT CONTAINS A TOOL CALL, not only at flush.
      //
      // This is the difference between the two paths, and it decided how wide their crash windows
      // were. wrapGenerate writes the step the moment doGenerate() returns — before any tool in it
      // can run. The streaming path wrote it in flush(), after the stream had been fully consumed,
      // while the AI SDK executes tool calls as they ARRIVE. So a crash between "the tool ran" and
      // "the stream ended" left the tool record present and model:N absent; the resume re-called the
      // model, it re-planned, and a real provider mints a fresh toolCallId every completion — so the
      // per-toolCallId gate never matched and the side effect ran again.
      //
      // Writing on the tool-call part closes exactly that window: whatever the stream does
      // afterwards, the ids that were about to execute are recoverable. flush() still writes the
      // complete record over it, so a run that finishes normally journals precisely what it did
      // before. A partial record is only ever read by a resume that would otherwise have re-planned,
      // which is strictly the better of the two.
      //
      // The periodic checkpoint below stays as it was: it preserves partial progress on a long TEXT
      // stream, which nothing reads today but which is the only trace a crash leaves. The tool-call
      // write is additive, not a replacement — the two answer different questions.
      const CHECKPOINT_EVERY = 10;
      // A write-ahead put that fails silently reopens the exact window this checkpoint was added to
      // close — the caller's stream keeps flowing and nothing anywhere records that the step is no
      // longer recoverable. Warn once per STREAM, not per chunk: a step can carry many tool calls,
      // and a journal that is down is down for all of them (one line per chunk is noise, not signal).
      let writeAheadFailureWarned = false;
      const recorder = new TransformStream<any, any>({
        async transform(chunk, controller) {
          parts.push(chunk);
          if (chunk?.type === 'tool-call') {
            try {
              await ctx.journal.put(runKeys.model(ctx.runId, myStep), stampFormat({ parts: parts.slice(), rest, partial: true }));
            } catch (err) {
              // Best-effort stays best-effort: a journal hiccup must not stop the stream the caller
              // is reading. But it is said out loud.
              if (!writeAheadFailureWarned) {
                writeAheadFailureWarned = true;
                console.warn(
                  `@gnldev/durable: the mid-stream write-ahead checkpoint FAILED for run '${ctx.runId}' step ${myStep} ` +
                    `('${runKeys.model(ctx.runId, myStep)}'). The stream is NOT broken (this write is best-effort), but until ` +
                    'flush() lands the complete record, a crash after a tool call in this step leaves it unjournaled — the ' +
                    'resume re-plans, the provider mints a fresh toolCallId, and a side effect can run a SECOND time. ' +
                    'Further failures on this stream are not repeated. Cause:',
                  err,
                );
              }
            }
          } else if (parts.length % CHECKPOINT_EVERY === 0) {
            // Idempotent: the SAME key is overwritten with all chunks so far (overwrite, not append),
            // so a half-finished write cannot break replay — only the forensic copy goes stale.
            try {
              await ctx.journal.put(checkpointKey, { parts: parts.slice(), rest, partial: true });
            } catch {
              /* checkpoint is best-effort — must never stop the stream */
            }
          }
          controller.enqueue(chunk);
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
