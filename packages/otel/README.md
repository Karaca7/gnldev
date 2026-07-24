# @gnl/otel

Converts the journal into a real **OpenTelemetry trace** and sends it to a SpanExporter (or an OTLP endpoint). Deterministic span ids → **idempotent**; since it's produced post-hoc from the journal, it stays complete even after a crash and consistent across replays = **crash-proof / exactly-once observability** (live-instrumenting frameworks cannot offer this).

```bash
npm i @gnl/otel   # peer: @gnl/durable, (optional) @opentelemetry/exporter-trace-otlp-http
```

```ts
import { exportRun } from '@gnl/otel';

// Send a run to an OTLP collector (Jaeger/Tempo/Honeycomb…).
const { traceId, spans } = await exportRun(journal, 'order-123', {
  endpoint: 'http://localhost:4318/v1/traces',
  serviceName: 'support-desk',
});

// Test: pass a ready-made InMemorySpanExporter → getFinishedSpans().
```

## API
- `exportRun(journal, runId, opts?) → { traceId, spans, exporter }`
  - `opts`: `exporter?` (ready-made SpanExporter) · `endpoint?` (OTLP-HTTP, set up lazily) · `serviceName?` · `pricing?` · `modelId?`

## How it works
Each model/tool journal entry maps to a span; trace/span ids are derived from runId+seq (deterministic) → exporting the same run again produces the same trace. Cost/token span attributes are added via `getRunCost`.

## Zero-dependency OTLP/HTTP JSON exporter (`exportRunToOtlp` / `toOtlpJson`)

The `exportRun` above uses `@opentelemetry/sdk-trace-base` (peer dep). Alongside it there is also a smaller alternative that **doesn't need any OTel SDK** — it manually converts `packages/durable`'s `toTraceSpans` output into an OTLP/HTTP JSON body and POSTs it with plain `fetch` (~8KB footprint: just `node:crypto` + the global `fetch`).

```ts
import { exportRunToOtlp, toOtlpJson } from '@gnl/otel';
import { toTraceSpans } from '@gnl/durable';

// Send a run directly to an OTLP/HTTP collector.
const { traceId, spans, ok, status } = await exportRunToOtlp(journal, 'order-123', {
  endpoint: process.env.OTLP_ENDPOINT!, // e.g. 'http://localhost:4318/v1/traces'
  headers: process.env.OTLP_HEADERS ? JSON.parse(process.env.OTLP_HEADERS) : undefined,
  serviceName: 'support-desk',
});

// Network-free testing / custom delivery: a PURE function.
const spans2 = await toTraceSpans(journal, 'order-123');
const payload = toOtlpJson(spans2, { runId: 'order-123', serviceName: 'support-desk' });
```

### API
- `toOtlpJson(spans: TraceSpan[], opts) → OtlpPayload` — PURE, no network. `opts`: `runId` (required) · `serviceName?` · `resourceAttributes?` · `now?` (fallback timestamp for entries without a `ts`, for test determinism).
- `exportRunToOtlp(journal, runId, opts) → { traceId, spans, ok, status }` — `toTraceSpans` + `toOtlpJson` + `fetch(POST)`. `opts`: `endpoint` (required) · `headers?` · `serviceName?` · `resourceAttributes?` · `now?`.
- `otlpTraceId(runId)` / `otlpSpanId(runId, seq | 'root')` — deterministic id generators (idempotent export).

### Connecting to your own endpoint (Langfuse / Datadog / Jaeger / Honeycomb …)

This package **never sends to a server of ours** — the `endpoint` is always supplied by the caller, opt-in. How this relates to the "no telemetry" principle: gnl sends data nowhere by default; the OTLP exporter only runs when `endpoint` is explicitly given, and that data always goes to the CALLER's own chosen collector/backend.

```bash
# Local OTel Collector / Jaeger (OTLP/HTTP ingest, usually port 4318)
OTLP_ENDPOINT=http://localhost:4318/v1/traces

# Langfuse (OTLP ingest endpoint; project public/secret key in the Basic Auth header)
OTLP_ENDPOINT=https://cloud.langfuse.com/api/public/otel/v1/traces
OTLP_HEADERS='{"authorization":"Basic <base64(public_key:secret_key)>"}'

# Datadog Agent (if the OTLP receiver is enabled, usually 4318)
OTLP_ENDPOINT=http://localhost:4318/v1/traces
OTLP_HEADERS='{"dd-api-key":"<DATADOG_API_KEY>"}'

# Honeycomb
OTLP_ENDPOINT=https://api.honeycomb.io/v1/traces
OTLP_HEADERS='{"x-honeycomb-team":"<HONEYCOMB_API_KEY>"}'
```

Spans carry `gen_ai.*` semantic convention fields (`gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.request.model`) — most LLM-observability backends recognize these automatically.
