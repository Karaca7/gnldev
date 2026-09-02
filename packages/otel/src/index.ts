// @gnldev/otel — converts the journal into a real OpenTelemetry trace and sends it to a SpanExporter (or an
// OTLP endpoint). Deterministic ids → idempotent; post-hoc from the journal → complete even after a crash,
// Consistent across replays = exactly-once / crash-proof observability (frameworks that live-instrument cannot offer this).
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
  /**
   * Applied to every free-text attribute this exporter emits. Today that is exactly one value — a
   * failed run's `outcome.error`, which reaches both the `gnl.error` attribute and the root span's
   * status message. Everything else emitted here is a model id, a finish reason, a token count or a
   * tool status; `mapEntry` never reads prompt, response or tool-result text.
   *
   * It exists because a processor chain does NOT cover this path. `piiRedactor` runs in
   * `processInput`/`processOutput`/`processToolResult`, while the run's verdict is written from a
   * different place entirely (`recordRunOutcome` in @gnldev/durable), which no processor sees.
   * Measured with the redactor installed: a provider that echoes the offending input back in its
   * refusal — `Invalid request: message contained disallowed content: "<address>"` — still put that
   * address into the span raw, and from there into whatever collector `endpoint` names, which is
   * commonly a third party's.
   *
   * Off by default rather than redacting unconditionally: the message is the main debugging value a
   * trace carries, and this package cannot know whether the endpoint is the host's own collector.
   * One line to turn on, sharing `piiRedactor`'s defaults:
   *
   *   import { piiTextRedactor } from '@gnldev/processors';
   *   await exportRun(journal, runId, { endpoint, redact: piiTextRedactor() });
   *
   * A redactor that throws or returns a non-string DROPS the message rather than falling back to the
   * raw text — the raw text is the exact value it was installed to keep out.
   */
  redact?: (text: string) => string;
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
 * Model/tool entry. trace_id/span_id are deterministic (hash of runId/seq) → exporting the same run
 * Twice yields the SAME trace (idempotent). Duration is derived from each entry's `ts` (created_at).
 */
export async function exportRun(
  reader: JournalReader,
  runId: string,
  opts: ExportRunOptions = {},
): Promise<ExportRunResult> {
  const entries = await reader.readRun(runId);
  // The run's recorded outcome. Without it, a run that DIED — a 401 on the first call, a cost ceiling —
  // Produced no error-bearing entry and was therefore exported as OK with $0 of cost: the single most
  // Misleading signal this exporter could send. `get` is optional on a bare JournalReader, so this
  // Degrades to the old derivation rather than throwing.
  const outcome = typeof (reader as { get?: unknown }).get === 'function'
    ? await (reader as unknown as { get<T>(k: string): Promise<T | undefined> })
        .get<{ status?: string; error?: string }>(`${runId}:outcome`).catch(() => undefined)
    : undefined;
  const runFailed = outcome?.status === 'failed';
  const runCanceled = outcome?.status === 'canceled';
  // The one free-text value that leaves this exporter — see `redact` on the options for why the
  // Processor chain never touched it. Computed once so the status message and the attribute cannot
  // Disagree about what was masked.
  const errorText = ((): string | undefined => {
    const raw = outcome?.error;
    if (!raw || !opts.redact) return raw;
    try {
      const out = opts.redact(raw);
      return typeof out === 'string' ? out : undefined;
    } catch {
      return undefined; // fail CLOSED: a broken redactor must not resurrect the raw text
    }
  })();
  const exporter = opts.exporter ?? (opts.endpoint ? await otlpExporter(opts.endpoint) : new InMemorySpanExporter());

  // Deterministic id queues: root traceId + (for the root + each entry) spanId.
  const traceId = traceIdFor(runId);
  const spanIds = ['root' as const, ...entries.map((_, i) => i)].map((s) => spanIdFor(runId, s));
  const idGenerator = new QueueIdGenerator(runId, [traceId], spanIds);

  // OpenTelemetry JS 2.x removed `provider.addSpanProcessor()`: a processor can no longer be
  // attached after construction, it is declared with the provider. Passed via `spanProcessors`.
  const provider = new BasicTracerProvider({ idGenerator, spanProcessors: [new SimpleSpanProcessor(exporter)] });
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

  // A cancel is an OPERATOR ACTION, not a system fault, so it decides the run's ending outright — the
  // outcome record is the authority on HOW a run ended, and an errored entry earlier in a run someone
  // then chose to stop does not make the stopping a failure. The child span that errored keeps its own
  // ERROR status, so nothing is hidden; it simply stops being the root's verdict.
  const failed = !runCanceled && (anyError || runFailed);
  const stillRunning = !failed && !runCanceled && outcome?.status === 'running';
  // A run whose write-ahead has no terminal yet is UNSET, not OK: OTel's OK means "ended fine", and
  // this run has not ended — exporting mid-flight (or after a crash) must not report a success.
  // A canceled run is UNSET for the mirror-image reason: it ended, but not WELL enough for OK and not
  // BADLY enough for ERROR. OTel's semantic conventions reserve ERROR for unexpected endings, and
  // paging an on-call because an operator cancelled a run is exactly the false alarm that trains
  // people to ignore the signal. `gnl.status` carries the fact for anyone filtering on it.
  root.setStatus(failed
    ? { code: SpanStatusCode.ERROR, ...(errorText ? { message: errorText } : {}) }
    : stillRunning || runCanceled ? { code: SpanStatusCode.UNSET } : { code: SpanStatusCode.OK });
  // Same precedence as deriveRunStatus in @gnldev/durable: canceled is terminal and wins over even
  // suspended (a canceled run's pending approval can never be applied), then suspended is a live state.
  root.setAttribute('gnl.status', runCanceled ? 'canceled' : anySuspended ? 'suspended' : failed ? 'failed' : stillRunning ? 'running' : 'completed');
  if (runFailed && errorText) root.setAttribute('gnl.error', errorText);
  root.end(lastTs > firstTs ? lastTs : firstTs);

  // Guarantee the export via forceFlush; DO NOT call shutdown (the caller owns the exporter; on InMemory,
  // Shutdown would reset the finished spans). SimpleSpanProcessor already exports synchronously on span.end.
  await provider.forceFlush();

  return { traceId, spans: entries.length + 1, exporter };
}

export { traceIdFor, spanIdFor, mapEntry } from './spans.js';

// Zero-dependency OTLP/HTTP JSON exporter (no OTel SDK, fetch only). Added alongside
// ExportRun; does not change the existing API.
export { toOtlpJson, exportRunToOtlp, otlpTraceId, otlpSpanId } from './otlp.js';
// Counters → OTLP metrics. Also reachable as `@gnldev/otel/metrics`, which is the leaner route:
// this entry point statically imports the OTel trace SDK, and the metrics path needs none of it.
export { toOtlpMetricsJson, nextEpoch } from './metrics.js';
export type { ToOtlpMetricsOptions, MetricsEpoch, OtlpMetricsPayload, OtlpMetric } from './metrics.js';
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
