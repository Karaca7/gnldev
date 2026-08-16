// @gnldev/otel/live — LIVE (real-time) observability. Unlike the post-hoc exportRun, it emits live OTEL
// Spans + cost WHILE model/tool calls are ACTUALLY running. The wrappers compose BELOW durable → they
// Never run on replay (journal cache hit) → the live layer NEVER TOUCHES THE JOURNAL, does not break determinism.
// It carries real wall-clock time/latency (non-det) — that's why it goes only to the exporter, never the journal.
import { createRequire } from 'node:module';
import { wrapLanguageModel } from 'ai';
import type { LanguageModelV4, LanguageModelV4Middleware } from '@ai-sdk/provider';
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  InMemorySpanExporter,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { trace, context, SpanKind, SpanStatusCode, type Span, type Context } from '@opentelemetry/api';
import { priceFor, costOf, DEFAULT_PRICING } from '@gnldev/durable';
import type { ModelPricing } from '@gnldev/durable';
import { flattenUsage } from '@gnldev/durable';

export interface LiveCost {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  modelCalls: number;
  toolCalls: number;
  costUsd: number;
}

export interface LiveObservabilityOptions {
  /** A ready-made OTEL SpanExporter (InMemorySpanExporter for tests). If not given, falls back to the endpoint or InMemory. */
  exporter?: SpanExporter;
  /** OTLP-HTTP endpoint (e.g. 'http://localhost:4318/v1/traces'). If exporter is not given, one is built from this (lazily). */
  endpoint?: string;
  /** Price table for cost calculation (default DEFAULT_PRICING). */
  pricing?: Record<string, ModelPricing>;
  /** service.name span attribute. */
  serviceName?: string;
  /** Sampling rate 0..1 (default 1 = all). instrument() kicks in with this probability. */
  sampleRate?: number;
  /** Called with the current running total cost after every model call (live budget alarm). */
  onCost?: (cost: LiveCost) => void;
  /**
   * FINDING (roots leak guard): the `roots` Map holds one root span per new runId; normally this is
   * Cleared by `flush(runId)` (or plain `flush()` if never closed). If the caller forgets to do this
   * (e.g. a long-lived multi-run server), the Map grows unbounded. This is the last-resort guardrail
   * For that case: once the Map exceeds this size, the OLDEST (insertion-order) root is forcibly ended
   * And removed. If not given, the guardrail is OFF (default behavior unchanged) — only opted-in callers
   * Get it. Kept simple: no TTL, just a size limit.
   */
  maxPendingRuns?: number;
}

export interface LiveInstrumentArgs {
  runId: string;
  model: unknown;
  tools?: Record<string, any>;
  [k: string]: unknown;
}

export interface LiveObservability {
  /** Wraps runDurable/streamDurable args to inject live tracing (model + tool). Returns the same type. */
  instrument<T extends LiveInstrumentArgs>(args: T): T;
  /** Total cost/tokens accumulated so far (live). */
  cost(): LiveCost;
  /**
   * If `runId` is given, closes ONLY that run's root span + removes it from the `roots` Map (does not
   * Touch other concurrent runs) — this is the cleanup point that must be called as each run finishes
   * In a multi-run scenario. If `runId` is omitted (old behavior, UNCHANGED), closes ALL open root spans
   * + clears the Map entirely. In both cases forces a flush to the exporter.
   */
  flush(runId?: string): Promise<void>;
  /** Shut down the provider (exporter shutdown). */
  shutdown(): Promise<void>;
  /** The exporter used (if InMemorySpanExporter, tests can call getFinishedSpans()). */
  exporter: SpanExporter;
  /** Number of runs currently held in the `roots` Map (not yet closed via `flush(runId)`) — for leak monitoring. */
  pendingRuns(): number;
}

function clean(attrs: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

function otlpExporterSync(endpoint: string): SpanExporter {
  const mod = '@opentelemetry/exporter-trace-otlp-http'; // string variable → doesn't break the optional peer build
  const { OTLPTraceExporter } = createRequire(import.meta.url)(mod) as any;
  return new OTLPTraceExporter({ url: endpoint });
}

interface ModelEmit {
  start: number;
  end: number;
  usage?: any;
  finishReason?: string;
  modelId?: string;
}
interface ToolEmit {
  start: number;
  end: number;
  name: string;
  status: 'succeeded' | 'failed';
}

export function liveObservability(opts: LiveObservabilityOptions = {}): LiveObservability {
  const pricing = opts.pricing ?? DEFAULT_PRICING;
  const sampleRate = opts.sampleRate ?? 1;
  const exporter = opts.exporter ?? (opts.endpoint ? otlpExporterSync(opts.endpoint) : new InMemorySpanExporter());
  const provider = new BasicTracerProvider();
  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  const tracer = provider.getTracer('@gnldev/otel/live');

  const roots = new Map<string, { span: Span; ctx: Context }>();
  const total: LiveCost = {
    inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, modelCalls: 0, toolCalls: 0, costUsd: 0,
  };

  function ensureRoot(runId: string, startTime: number): { span: Span; ctx: Context } {
    let r = roots.get(runId);
    if (!r) {
      // FINDING (roots leak guardrail): the caller may have forgotten to clean up via `flush(runId)`
      // (a multi-run/long-lived server scenario). If the limit is exceeded, the oldest (first in
      // Insertion order) root is forcibly ended and removed so the Map doesn't grow unbounded.
      // If maxPendingRuns is not given (default), this is disabled — existing behavior is unchanged.
      if (opts.maxPendingRuns !== undefined && roots.size >= opts.maxPendingRuns) {
        const oldestId = roots.keys().next().value as string | undefined;
        if (oldestId !== undefined) {
          const oldest = roots.get(oldestId)!;
          oldest.span.end(startTime);
          roots.delete(oldestId);
        }
      }
      const span = tracer.startSpan('agent.run', {
        kind: SpanKind.INTERNAL,
        startTime,
        attributes: clean({ 'gnl.run_id': runId, 'service.name': opts.serviceName }),
      });
      r = { span, ctx: trace.setSpan(context.active(), span) };
      roots.set(runId, r);
    }
    return r;
  }

  function recordModel(runId: string, e: ModelEmit): void {
    const r = ensureRoot(runId, e.start);
    total.modelCalls++;
    // Same shared reader the journal path uses: AI SDK 7 nests the counts, so reading the flat
    // fields yields undefined → `?? 0` → a live cost feed that reports zero forever, and an
    // onCost budget alarm that therefore never fires. `cachedTokens` was never an SDK field at all.
    const u = flattenUsage(e.usage);
    const { inputTokens: inp, outputTokens: outp, cachedTokens: cached, totalTokens: tot } = u;
    total.inputTokens += inp;
    total.outputTokens += outp;
    total.cachedTokens += cached;
    total.totalTokens += tot;
    const p = e.modelId ? priceFor(e.modelId, pricing) : undefined;
    // costOf reads FLAT fields — hand it the flattened object, not the raw record.
    const cost = p ? costOf(u, p) : 0;
    total.costUsd += cost;
    const span = tracer.startSpan(
      'llm.generate',
      {
        kind: SpanKind.CLIENT,
        startTime: e.start,
        attributes: clean({
          'gen_ai.operation.name': 'generate',
          'gen_ai.response.model': e.modelId,
          'gen_ai.response.finish_reason': e.finishReason,
          'gen_ai.usage.input_tokens': inp,
          'gen_ai.usage.output_tokens': outp,
          'gen_ai.usage.total_tokens': tot,
          'gnl.cost_usd': cost,
        }),
      },
      r.ctx,
    );
    span.end(e.end > e.start ? e.end : e.start);
    opts.onCost?.({ ...total });
  }

  function recordTool(runId: string, e: ToolEmit): void {
    const r = ensureRoot(runId, e.start);
    total.toolCalls++;
    const span = tracer.startSpan(
      'tool.execute',
      { kind: SpanKind.INTERNAL, startTime: e.start, attributes: clean({ 'gnl.tool.name': e.name, 'gnl.tool.status': e.status }) },
      r.ctx,
    );
    if (e.status === 'failed') span.setStatus({ code: SpanStatusCode.ERROR });
    span.end(e.end > e.start ? e.end : e.start);
  }

  function liveMiddleware(runId: string): LanguageModelV4Middleware {
    return {
      specificationVersion: 'v4',
      wrapGenerate: async ({ doGenerate }) => {
        const start = Date.now();
        const result = await doGenerate();
        const r: any = result;
        recordModel(runId, { start, end: Date.now(), usage: r?.usage, finishReason: r?.finishReason, modelId: r?.response?.modelId });
        return result;
      },
      wrapStream: async ({ doStream }) => {
        const start = Date.now();
        const { stream, ...rest } = await doStream();
        let usage: any;
        let finishReason: string | undefined;
        let modelId: string | undefined;
        const recorder = new TransformStream<any, any>({
          transform(chunk, controller) {
            if (chunk?.type === 'finish') {
              usage = chunk.usage;
              finishReason = chunk.finishReason;
            }
            if (chunk?.response?.modelId) modelId = chunk.response.modelId;
            controller.enqueue(chunk);
          },
          flush: () => recordModel(runId, { start, end: Date.now(), usage, finishReason, modelId }),
        });
        return { stream: (stream as any).pipeThrough(recorder), ...rest } as any;
      },
    };
  }

  function liveTool(t: any, name: string, runId: string): any {
    if (!t || typeof t.execute !== 'function') return t;
    const original = t.execute;
    return {
      ...t,
      execute: async (input: any, options: any) => {
        const start = Date.now();
        try {
          const output = await original(input, options);
          recordTool(runId, { start, end: Date.now(), name, status: 'succeeded' });
          return output;
        } catch (e) {
          recordTool(runId, { start, end: Date.now(), name, status: 'failed' });
          throw e;
        }
      },
    };
  }

  function instrument<T extends LiveInstrumentArgs>(args: T): T {
    // Sampling: if this run won't be traced, return args unchanged (zero cost).
    if (sampleRate < 1 && Math.random() >= sampleRate) return args;
    const runId = args.runId;
    const model = args.model ? wrapLanguageModel({ model: args.model as LanguageModelV4, middleware: liveMiddleware(runId) }) : args.model;
    let tools = args.tools;
    if (args.tools) {
      tools = {};
      for (const [name, t] of Object.entries(args.tools)) tools[name] = liveTool(t, name, runId);
    }
    return { ...args, model, tools };
  }

  return {
    instrument,
    cost: () => ({ ...total }),
    async flush(runId?: string) {
      const end = Date.now();
      if (runId !== undefined) {
        // CLEANUP POINT: when a run finishes (or is exported), close ONLY that run's root + remove it
        // From the Map. Does not touch other concurrent runs' roots — this is the actual fix for the roots leak.
        const r = roots.get(runId);
        if (r) {
          r.span.end(end);
          roots.delete(runId);
        }
      } else {
        for (const { span } of roots.values()) span.end(end);
        roots.clear();
      }
      await provider.forceFlush();
    },
    async shutdown() {
      await provider.shutdown();
    },
    exporter,
    pendingRuns: () => roots.size,
  };
}
