// @gnldev/otel — converts the journal into a real OpenTelemetry trace and sends it to a SpanExporter (or an
// OTLP endpoint). Deterministic ids → idempotent; post-hoc from the journal → complete even after a crash,
// consistent across replays = exactly-once / crash-proof observability (frameworks that live-instrument cannot offer this).
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  InMemorySpanExporter,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { trace, context, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { getRunCost } from '@gnldev/durable';
import type { JournalReader, ModelPricing } from '@gnldev/durable';
import { traceIdFor, spanIdFor, QueueIdGenerator, mapEntry } from './spans.js';

export interface ExportRunOptions {
  /** A ready-made OTEL SpanExporter (InMemorySpanExporter for tests). If not given, falls back to the endpoint or the default. */
  exporter?: SpanExporter;
  /** OTLP-HTTP endpoint (e.g. 'http://localhost:4318/v1/traces'). If exporter is not given, one is built from this (lazily). */
  endpoint?: string;
  /** Price table for cost attributes (passed to getRunCost). */
  pricing?: Record<string, ModelPricing>;
  /** Default when the journal has no model id. */
  modelId?: string;
  /** service.name attribute. */
  serviceName?: string;
}

export interface ExportRunResult {
  traceId: string;
  spans: number;
  /** The exporter used (if InMemorySpanExporter, tests can call getFinishedSpans()). */
  exporter: SpanExporter;
}

async function otlpExporter(endpoint: string): Promise<SpanExporter> {
  const mod = '@opentelemetry/exporter-trace-otlp-http'; // string variable → doesn't break the optional peer build
  const { OTLPTraceExporter } = (await import(mod)) as any;
  return new OTLPTraceExporter({ url: endpoint });
}

/**
 * Exports a run from the journal as an OTEL trace: 1 root span `agent.run` + one child span per
 * model/tool entry. trace_id/span_id are deterministic (hash of runId/seq) → exporting the same run
 * twice yields the SAME trace (idempotent). Duration is derived from each entry's `ts` (created_at).
 */
export async function exportRun(
  reader: JournalReader,
  runId: string,
  opts: ExportRunOptions = {},
): Promise<ExportRunResult> {
  const entries = await reader.readRun(runId);
  const exporter = opts.exporter ?? (opts.endpoint ? await otlpExporter(opts.endpoint) : new InMemorySpanExporter());

  // Deterministic id queues: root traceId + (for the root + each entry) spanId.
  const traceId = traceIdFor(runId);
  const spanIds = ['root' as const, ...entries.map((_, i) => i)].map((s) => spanIdFor(runId, s));
  const idGenerator = new QueueIdGenerator(runId, [traceId], spanIds);

  const provider = new BasicTracerProvider({ idGenerator });
  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  const tracer = provider.getTracer('@gnldev/otel');

  const cost = await getRunCost(reader, runId, { pricing: opts.pricing, modelId: opts.modelId });

  // Timing: span start = entry.ts, end = next entry.ts (last = end of run). Falls back to now if ts is missing.
  const now = Date.now();
  const firstTs = entries.find((e) => e.ts != null)?.ts ?? now;
  const lastTs = [...entries].reverse().find((e) => e.ts != null)?.ts ?? firstTs;

  const root = tracer.startSpan('agent.run', {
    kind: SpanKind.INTERNAL,
    startTime: firstTs,
    attributes: {
      'gnl.run_id': runId,
      'gen_ai.usage.input_tokens': cost.inputTokens,
      'gen_ai.usage.output_tokens': cost.outputTokens,
      'gen_ai.usage.total_tokens': cost.totalTokens,
      'gnl.cost_usd': cost.costUsd,
      'gnl.model_calls': cost.modelCalls,
      'gnl.tool_calls': cost.toolCalls,
      ...(opts.serviceName ? { 'service.name': opts.serviceName } : {}),
    },
  });
  const parentCtx = trace.setSpan(context.active(), root);

  let anyError = false;
  let anySuspended = false;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const m = mapEntry(e);
    const start = e.ts ?? firstTs;
    const end = entries[i + 1]?.ts ?? lastTs;
    const span = tracer.startSpan(
      m.name,
      { kind: e.kind === 'model' ? SpanKind.CLIENT : SpanKind.INTERNAL, startTime: start, attributes: m.attributes },
      parentCtx,
    );
    if (m.isError) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      anyError = true;
    }
    if (m.isSuspended) anySuspended = true;
    span.end(end > start ? end : start);
  }

  root.setStatus({ code: anyError ? SpanStatusCode.ERROR : SpanStatusCode.OK });
  root.setAttribute('gnl.status', anySuspended ? 'suspended' : anyError ? 'failed' : 'completed');
  root.end(lastTs > firstTs ? lastTs : firstTs);

  // Guarantee the export via forceFlush; DO NOT call shutdown (the caller owns the exporter; on InMemory,
  // shutdown would reset the finished spans). SimpleSpanProcessor already exports synchronously on span.end.
  await provider.forceFlush();

  return { traceId, spans: entries.length + 1, exporter };
}

export { traceIdFor, spanIdFor, mapEntry } from './spans.js';

// Zero-dependency OTLP/HTTP JSON exporter (no OTel SDK, fetch only). Added alongside
// exportRun; does not change the existing API.
export { toOtlpJson, exportRunToOtlp, otlpTraceId, otlpSpanId } from './otlp.js';
export type {
  OtlpPayload,
  OtlpSpan,
  OtlpKeyValue,
  OtlpAttributeValue,
  ToOtlpJsonOptions,
  ExportRunToOtlpOptions,
  ExportRunToOtlpResult,
  OtlpRetryOptions,
} from './otlp.js';

// Named observability presets (Langfuse/Braintrust/Honeycomb/Datadog/Collector) + a generic
// API-key-authenticated OTLP/HTTP preset for any other provider.
export { otlpPresets, langfuse, apiKeyOtlp, braintrust, honeycomb, datadogAgent, collector } from './presets.js';
