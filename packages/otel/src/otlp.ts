// @gnldev/otel/otlp — ZERO-dependency OTLP/HTTP JSON exporter. DOES NOT USE the OTel SDK (~8KB ethos):
// converts the journal (via toTraceSpans) by hand into an OTLP/HTTP JSON body and POSTs it with `fetch`.
// DIFFERENT from exportRun in index.ts: here there is no @opentelemetry/sdk-trace-base, just node:crypto +
// global fetch. The user sends to THEIR OWN collector/backend (Langfuse/Datadog/Jaeger/Honeycomb…) —
// NEVER to our server (see README's "no-telemetry" principle).
import { createHash } from 'node:crypto';
import { toTraceSpans } from '@gnldev/durable';
import type { JournalReader, TraceSpan } from '@gnldev/durable';

/** runId → 16-byte (32-hex) deterministic trace id — the same run yields the SAME trace on every export (idempotent). */
export function otlpTraceId(runId: string): string {
  return createHash('sha256').update(`gnl-otlp-trace:${runId}`).digest('hex').slice(0, 32);
}

/** (runId, seq|'root') → 8-byte (16-hex) deterministic span id. */
export function otlpSpanId(runId: string, seq: number | 'root'): string {
  return createHash('sha256').update(`gnl-otlp-span:${runId}:${seq}`).digest('hex').slice(0, 16);
}

// OTLP Span.kind (proto enum SpanKind) — only the ones we use.
const SPAN_KIND_INTERNAL = 1;
const SPAN_KIND_CLIENT = 3;

export type OtlpAttributeValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean };

export interface OtlpKeyValue {
  key: string;
  value: OtlpAttributeValue;
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  /** In OTLP/JSON, uint64 fields are STRINGS to avoid precision loss (protobuf JSON mapping). */
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
}

export interface OtlpPayload {
  resourceSpans: Array<{
    resource: { attributes: OtlpKeyValue[] };
    scopeSpans: Array<{
      scope: { name: string };
      spans: OtlpSpan[];
    }>;
  }>;
}

export interface ToOtlpJsonOptions {
  runId: string;
  /** resource attribute service.name. */
  serviceName?: string;
  /** Additional resource attributes (deployment.environment, etc.). */
  resourceAttributes?: Record<string, string | number | boolean>;
  /** Timestamp (ms) used when journal entries have no ts at all. Can be injected for determinism in tests; default Date.now(). */
  now?: number;
}

function attrValue(v: unknown): OtlpAttributeValue | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  return { stringValue: String(v) };
}

function toKv(attrs: Record<string, unknown>): OtlpKeyValue[] {
  const out: OtlpKeyValue[] = [];
  for (const [key, v] of Object.entries(attrs)) {
    const value = attrValue(v);
    if (value) out.push({ key, value });
  }
  return out;
}

/** ms → nanosecond string (BigInt: no precision loss). */
function nano(ms: number): string {
  return (BigInt(Math.round(ms)) * 1_000_000n).toString();
}

/** Maps TraceSpan.attributes to the subset conforming to OTLP/gen_ai semconv + adds gnl.* identity fields. */
function spanAttributes(span: TraceSpan): Record<string, unknown> {
  const src = span.attributes ?? {};
  const out: Record<string, unknown> = {
    'gnl.run.id': span.runId,
    'gnl.kind': span.kind,
  };
  if (src['gen_ai.usage.input_tokens'] != null) out['gen_ai.usage.input_tokens'] = src['gen_ai.usage.input_tokens'];
  if (src['gen_ai.usage.output_tokens'] != null) out['gen_ai.usage.output_tokens'] = src['gen_ai.usage.output_tokens'];
  // The journal only knows the responding model (gen_ai.response.model) — we carry it over to semconv's
  // request.model field (request/response model is usually the same; no harm if there's no alias).
  if (src['gen_ai.response.model'] != null) out['gen_ai.request.model'] = src['gen_ai.response.model'];
  if (src['gen_ai.response.finish_reason'] != null) out['gen_ai.response.finish_reason'] = src['gen_ai.response.finish_reason'];
  if (src['tool.status'] != null) out['gnl.tool.status'] = src['tool.status'];
  return out;
}

/**
 * PURE function (NO network, NO OTel SDK): converts `toTraceSpans` output into an OTLP/HTTP JSON body.
 * 1 root span (`agent.run`) + 1 child span per journal entry; trace/span ids are derived deterministically
 * from runId+seq → converting the same run twice yields the SAME ids (idempotent, replay-consistent).
 */
export function toOtlpJson(spans: TraceSpan[], opts: ToOtlpJsonOptions): OtlpPayload {
  const { runId } = opts;
  const traceId = otlpTraceId(runId);
  const rootSpanId = otlpSpanId(runId, 'root');
  const now = opts.now ?? Date.now();
  const withTs = spans.filter((s) => s.ts != null);
  const firstTs = withTs[0]?.ts ?? now;
  const lastTs = withTs[withTs.length - 1]?.ts ?? firstTs;

  const otlpSpans: OtlpSpan[] = [
    {
      traceId,
      spanId: rootSpanId,
      name: 'agent.run',
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: nano(firstTs),
      endTimeUnixNano: nano(Math.max(lastTs, firstTs)),
      attributes: toKv({ 'gnl.run.id': runId }),
    },
  ];

  for (let i = 0; i < spans.length; i++) {
    const s = spans[i]!;
    const start = s.ts ?? firstTs;
    const end = spans[i + 1]?.ts ?? lastTs;
    otlpSpans.push({
      traceId,
      spanId: otlpSpanId(runId, s.seq),
      parentSpanId: rootSpanId,
      name: s.name,
      kind: s.kind === 'model' ? SPAN_KIND_CLIENT : SPAN_KIND_INTERNAL,
      startTimeUnixNano: nano(start),
      endTimeUnixNano: nano(Math.max(end, start)),
      attributes: toKv(spanAttributes(s)),
    });
  }

  const resourceAttrs: Record<string, unknown> = { ...(opts.resourceAttributes ?? {}) };
  if (opts.serviceName) resourceAttrs['service.name'] = opts.serviceName;

  return {
    resourceSpans: [
      {
        resource: { attributes: toKv(resourceAttrs) },
        scopeSpans: [{ scope: { name: '@gnldev/otel' }, spans: otlpSpans }],
      },
    ],
  };
}

// P2 (AUDIT-R2): opt-in retry/backoff for the POST above. known limitation: a 5xx or network
// blip on the fetch call silently loses the export (no OTel SDK behind this to retry/batch for us —
// that's the whole point of the zero-dep ~8KB path). Hand-rolled (no new dependency): a plain loop +
// `setTimeout`. ZERO behavior change when `retry` is not given — exactly one fetch call, same as before.
const DEFAULT_RETRY_ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 30_000;

export interface OtlpRetryOptions {
  /** Total attempts including the first try (not "extra retries"). Default 3. */
  attempts?: number;
  /** Delay before the NEXT retry — fixed ms, or a function of the retry index (0 = delay before the
   *  2nd attempt, 1 = before the 3rd, ...). Default exponential: `500 * 2^n`. Ignored on a 429 that
   *  carries a `Retry-After` header (see below). */
  backoffMs?: number | ((attempt: number) => number);
  /**
   * Decide whether a failure should be retried. Called with the HTTP status code for a non-throwing
   * response, or the thrown `Error` for a network failure. Default: network errors + 408/429/5xx
   * (a 4xx like 400/401/403 is a permanent rejection — retrying it would just waste attempts).
   */
  retryOn?: (result: number | Error) => boolean;
}

function defaultRetryOn(result: number | Error): boolean {
  if (result instanceof Error) return true; // network error (DNS/connection/timeout) — worth a retry
  return result === 408 || result === 429 || (result >= 500 && result < 600);
}

function defaultBackoffMs(attempt: number): number {
  return 500 * 2 ** attempt;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry-After (RFC 9110): either delta-seconds or an HTTP-date. Capped at MAX_RETRY_AFTER_MS so a
 *  misbehaving/huge value from an untrusted-ish collector can't stall the caller for a long time. */
function retryAfterMs(res: Response): number | undefined {
  const header = res.headers?.get?.('retry-after');
  if (!header) return undefined;
  const asSeconds = Number(header);
  if (!Number.isNaN(asSeconds)) return Math.max(0, Math.min(asSeconds * 1000, MAX_RETRY_AFTER_MS));
  const asDate = Date.parse(header);
  if (!Number.isNaN(asDate)) return Math.max(0, Math.min(asDate - Date.now(), MAX_RETRY_AFTER_MS));
  return undefined;
}

function delayFor(retry: OtlpRetryOptions, attempt: number, res?: Response): number {
  if (res?.status === 429) {
    const fromHeader = retryAfterMs(res);
    if (fromHeader !== undefined) return fromHeader;
  }
  const backoff = retry.backoffMs ?? defaultBackoffMs;
  return typeof backoff === 'function' ? backoff(attempt) : backoff;
}

/** Runs `doFetch` up to `retry.attempts` times, retrying on `retry.retryOn`-eligible failures. Returns
 *  the last response (even if not ok — SAME "don't throw on 4xx/5xx" contract as the no-retry path) or
 *  rethrows the last network error once attempts are exhausted (SAME as the no-retry path, which never
 *  caught fetch's own throw either). */
async function fetchWithRetry(doFetch: () => Promise<Response>, retry: OtlpRetryOptions): Promise<Response> {
  const attempts = retry.attempts ?? DEFAULT_RETRY_ATTEMPTS;
  const retryOn = retry.retryOn ?? defaultRetryOn;
  for (let i = 0; i < attempts; i++) {
    const isLast = i === attempts - 1;
    try {
      const res = await doFetch();
      if (res.ok || isLast || !retryOn(res.status)) return res;
      await sleep(delayFor(retry, i, res));
    } catch (err) {
      if (isLast || !retryOn(err as Error)) throw err;
      await sleep(delayFor(retry, i));
    }
  }
  /* c8 ignore next */
  throw new Error('unreachable'); // attempts >= 1 guaranteed by callers; loop always returns/throws above
}

export interface ExportRunToOtlpOptions {
  /** OTLP/HTTP JSON traces endpoint — e.g. 'http://localhost:4318/v1/traces' (Jaeger/Tempo/Collector) or
   * the user's own Langfuse/Datadog/Honeycomb OTLP proxy. We never send to a default endpoint ourselves. */
  endpoint: string;
  /** Additional HTTP headers (e.g. Authorization, x-honeycomb-team). */
  headers?: Record<string, string>;
  serviceName?: string;
  resourceAttributes?: Record<string, string | number | boolean>;
  now?: number;
  /** Opt-in retry/backoff for the POST (default: none — exactly one attempt, unchanged behavior). */
  retry?: OtlpRetryOptions;
}

export interface ExportRunToOtlpResult {
  traceId: string;
  spans: number;
  ok: boolean;
  status: number;
}

/**
 * Converts a run from the journal into OTLP/HTTP JSON and POSTs it to the given endpoint. DOES NOT USE
 * the OTel SDK — only `fetch` (Node ≥18 global). The user sends to THEIR OWN backend; for tests use
 * `toOtlpJson` without the network, or mock global `fetch` (see test/otlp.test.ts).
 */
export async function exportRunToOtlp(
  reader: JournalReader,
  runId: string,
  opts: ExportRunToOtlpOptions,
): Promise<ExportRunToOtlpResult> {
  const spans = await toTraceSpans(reader, runId);
  const payload = toOtlpJson(spans, {
    runId,
    serviceName: opts.serviceName,
    resourceAttributes: opts.resourceAttributes,
    now: opts.now,
  });
  const doFetch = () =>
    fetch(opts.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
      body: JSON.stringify(payload),
    });
  const res = opts.retry ? await fetchWithRetry(doFetch, opts.retry) : await doFetch();
  return {
    traceId: otlpTraceId(runId),
    spans: payload.resourceSpans[0]!.scopeSpans[0]!.spans.length,
    ok: res.ok,
    status: res.status,
  };
}
