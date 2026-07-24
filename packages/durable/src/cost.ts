import type { JournalReader } from './journal.js';
import { DEFAULT_PRICING, priceFor, costOf, type ModelPricing } from './pricing.js';

// Cost ledger & trace export — computed POST-HOC from the journal → exact, deterministic, replayable.
// (As opposed to a typical "approximate/async" cost guard: ours is derived verbatim from journaled usage.)

export interface RunCost {
  runId: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  modelCalls: number;
  toolCalls: number;
  costUsd: number;
  byModel: Record<string, { calls: number; tokens: number; costUsd: number }>;
}

export interface RunCostOptions {
  /** Default to use when the journal has no model id (e.g. mock). */
  modelId?: string;
  /** Custom pricing table. */
  pricing?: Record<string, ModelPricing>;
}

/** Usage+cost extracted from a single model-step record — factored out so `getRunCost`'s inner loop
 *  AND limits.ts's O(1) incremental counting (see limits.ts `applyModelStep`) SHARE the SAME pricing
 *  logic (single source of truth — duplicating price computation in two places would risk DRIFT). */
export interface ModelStepUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  costUsd: number;
  modelId: string;
}

/**
 * Returns `undefined` if the record has no `usage` at all (e.g. an unexpected/corrupt record) —
 * the caller should interpret this as "this step does not contribute to the count" (SAME as
 * getRunCost's existing `continue`).
 */
export function usageAndCostFromModelValue(value: unknown, opts: RunCostOptions = {}): ModelStepUsage | undefined {
  const v: any = value;
  const table = opts.pricing ?? DEFAULT_PRICING;
  // GOREV W1: a streamDurable record has the shape `{ parts, rest }` (durable-model.ts wrapStream) —
  // `usage` is NOT at the top level, it's in the 'finish' part inside `parts`. The generateText shape
  // (top-level `usage`) is tried FIRST, otherwise it's extracted from the stream shape (backward
  // compatible — the behavior of existing generateText records does NOT CHANGE).
  const usage = v?.usage ?? (Array.isArray(v?.parts) ? v.parts.find((p: any) => p?.type === 'finish')?.usage : undefined);
  if (!usage) return undefined;
  const inp = usage.inputTokens ?? 0;
  const outp = usage.outputTokens ?? 0;
  const cached = usage.cachedTokens ?? 0;
  const total = usage.totalTokens ?? inp + outp;
  const modelId = v?.response?.modelId ?? v?.rest?.response?.modelId ?? opts.modelId ?? 'unknown';
  const pricing = priceFor(modelId, table);
  const costUsd = pricing ? costOf(usage, pricing) : 0;
  return { inputTokens: inp, outputTokens: outp, cachedTokens: cached, totalTokens: total, costUsd, modelId };
}

export async function getRunCost(
  reader: JournalReader,
  runId: string,
  opts: RunCostOptions = {},
): Promise<RunCost> {
  const entries = await reader.readRun(runId);
  const out: RunCost = {
    runId, inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0,
    modelCalls: 0, toolCalls: 0, costUsd: 0, byModel: {},
  };
  for (const e of entries) {
    if (e.kind === 'tool') {
      out.toolCalls++;
      continue;
    }
    const u = usageAndCostFromModelValue(e.value, opts);
    if (!u) continue;
    out.modelCalls++;
    out.inputTokens += u.inputTokens;
    out.outputTokens += u.outputTokens;
    out.cachedTokens += u.cachedTokens;
    out.totalTokens += u.totalTokens;
    out.costUsd += u.costUsd;
    const bm = out.byModel[u.modelId] ?? { calls: 0, tokens: 0, costUsd: 0 };
    bm.calls++;
    bm.tokens += u.totalTokens;
    bm.costUsd += u.costUsd;
    out.byModel[u.modelId] = bm;
  }
  return out;
}

export interface TraceSpan {
  name: string;
  kind: 'model' | 'tool';
  runId: string;
  seq: number;
  attributes: Record<string, unknown>;
  /** Entry write time (created_at) — for OTLP exporter timing (undefined if absent; backward-compatible extra field). */
  ts?: number;
}

/** Converts the journal into an OpenTelemetry gen_ai semantic-convention-compatible span list (can be fed to an OTel exporter). */
export async function toTraceSpans(reader: JournalReader, runId: string): Promise<TraceSpan[]> {
  const entries = await reader.readRun(runId);
  return entries.map((e) => {
    const v: any = e.value;
    if (e.kind === 'model') {
      return {
        name: 'llm.generate',
        kind: 'model' as const,
        runId,
        seq: e.seq,
        ts: e.ts,
        attributes: {
          'gen_ai.response.finish_reason': v?.finishReason,
          'gen_ai.usage.input_tokens': v?.usage?.inputTokens,
          'gen_ai.usage.output_tokens': v?.usage?.outputTokens,
          'gen_ai.response.model': v?.response?.modelId,
        },
      };
    }
    return {
      name: 'tool.execute',
      kind: 'tool' as const,
      runId,
      seq: e.seq,
      ts: e.ts,
      attributes: { 'tool.status': v?.status },
    };
  });
}
