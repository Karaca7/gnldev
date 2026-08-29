// @gnldev/otel/metrics — the journal's materialized counters as an OTLP/HTTP JSON metrics body.
//
// Same ethos as otlp.ts: no OTel SDK, the body is built by hand and sent with `fetch`. That is not
// only about size here — it is the only way this data can be expressed. The counters hold duration
// BUCKET COUNTS, never the individual observations, and the SDK's histogram API accepts recorded
// values (`histogram.record(ms)`). Feeding pre-aggregated buckets through it would mean writing a
// custom MetricReader that emits `ResourceMetrics` directly, i.e. building the payload by hand
// anyway and paying for a dependency that contributes only transport — transport otlp.ts already
// has, with redirect refusal, per-attempt timeouts and Retry-After handling.
//
// What is exported, and what deliberately is not:
//
//   `__metrics__:all` ONLY. The day buckets are not emitted, and that is a correctness decision
//   before it is a cost one. A cumulative series whose value returns to zero every UTC midnight is
//   read by every collector as a counter reset, so daily counters shipped as cumulative sums invent
//   a spike once a day. (They are also 15x the reads: a bucket is `1 + METRICS_SHARDS` point reads,
//   so `all` is 17 and `all` + 14 days is 255 — per organization, per round.)
import { readCounter, METRICS_ALL_KEY, orgScopeOf } from '@gnldev/durable';
import type { Journal } from '@gnldev/durable';
import { toKv, nano } from './otlp.js';
import type { OtlpKeyValue } from './otlp.js';

/** OTLP AggregationTemporality: 1 = DELTA, 2 = CUMULATIVE. */
const CUMULATIVE = 2;

/**
 * The duration buckets `metrics.ts` writes, in the order OTLP wants them.
 *
 * `explicitBounds` has one fewer entry than `bucketCounts`: the last count is the implicit `+Inf`
 * bucket. The bounds must match `durationBucketField`'s thresholds exactly — a mismatch here does
 * not fail anywhere, it just relabels every latency on the dashboard.
 */
const DURATION_BOUNDS = [1_000, 5_000, 15_000, 60_000];
const DURATION_FIELDS = ['durLt1s', 'durLt5s', 'durLt15s', 'durLt60s', 'durGte60s'] as const;

export interface OtlpNumberDataPoint {
  attributes: OtlpKeyValue[];
  startTimeUnixNano: string;
  timeUnixNano: string;
  asInt?: string;
  asDouble?: number;
}
export interface OtlpHistogramDataPoint {
  attributes: OtlpKeyValue[];
  startTimeUnixNano: string;
  timeUnixNano: string;
  count: string;
  sum: number;
  bucketCounts: string[];
  explicitBounds: number[];
}
export interface OtlpMetric {
  name: string;
  unit?: string;
  sum?: { dataPoints: OtlpNumberDataPoint[]; aggregationTemporality: number; isMonotonic: boolean };
  histogram?: { dataPoints: OtlpHistogramDataPoint[]; aggregationTemporality: number };
}
export interface OtlpMetricsPayload {
  resourceMetrics: {
    resource: { attributes: OtlpKeyValue[] };
    scopeMetrics: { scope: { name: string }; metrics: OtlpMetric[] }[];
  }[];
}

export interface ToOtlpMetricsOptions {
  /** resource attribute service.name. */
  serviceName?: string;
  /**
   * The organization label, for the case where the caller scopes by some other means.
   *
   * Normally leave it unset: a journal from `withOrg` carries its organization on itself, and the
   * label is read from there. Supplying one that DISAGREES with the handle throws, because the two
   * failure modes are not symmetrical — the numbers come from the handle and the label is what the
   * dashboard believes, so a mismatch publishes one tenant's traffic under another tenant's name
   * and nothing downstream can detect it. That was the shape of this option before: two independent
   * inputs that had to agree, with nothing checking that they did.
   */
  orgId?: string;
  resourceAttributes?: Record<string, string | number | boolean>;
  /** Observation time (ms). Injectable so a test is deterministic; default `Date.now()`. */
  now?: number;
  /**
   * When this journal's counters started accumulating (ms) — see `nextEpoch`, which decides it.
   *
   * Required rather than defaulted, because every plausible default is wrong. `Date.now()` moves on
   * every export and on every process restart, and a collector reading a fresh start time on a
   * series it already knows treats it as a counter reset: the entire accumulated total gets charged
   * to one interval, as a spike that never happened.
   */
  startTime: number;
}

/** What `nextEpoch` remembers between exports. */
export interface MetricsEpoch {
  startTime: number;
  total: number;
}

/**
 * Decides the `startTimeUnixNano` for the next export, which is the whole of the reset handling.
 *
 * The rule has two halves that pull in opposite directions, and both matter:
 *
 *   grew or held  →  keep the epoch. This is the common case, and renewing it here is the bug that
 *                    puts a phantom spike on the graph after every deploy.
 *   FELL          →  move it. `rebuildMetrics` recomputes the counters from the journal and the
 *                    total legitimately drops after a purge. Keeping the epoch through that shows
 *                    a monotonic series going backwards, and the collector reconstructs a rate out
 *                    of the wraparound.
 *
 * `total` is one number on purpose: any of the counters falling means the same rebuild happened, so
 * `runs` stands in for all of them.
 */
export function nextEpoch(prev: MetricsEpoch | undefined, total: number, now: number): MetricsEpoch {
  if (!prev) return { startTime: now, total };
  if (total < prev.total) return { startTime: now, total }; // a rebuild: the series starts again
  return { startTime: prev.startTime, total };
}

function intPoint(value: number, startTimeUnixNano: string, timeUnixNano: string): OtlpNumberDataPoint {
  // `asInt` is a STRING: OTLP/JSON maps uint64 that way (see otlp.ts), and a number would silently
  // lose precision on token totals past 2^53 — the one deployment size where it would ever matter.
  return { attributes: [], startTimeUnixNano, timeUnixNano, asInt: String(Math.round(value)) };
}

function sumMetric(name: string, unit: string, value: number, start: string, time: string): OtlpMetric {
  return {
    name,
    unit,
    sum: { dataPoints: [intPoint(value, start, time)], aggregationTemporality: CUMULATIVE, isMonotonic: true },
  };
}

/**
 * Reads the running totals and returns an OTLP/HTTP metrics body.
 *
 * Always returns a payload, even for a journal that has never run anything: absent and zero look
 * identical on a graph and mean opposite things. A series that only appears once it is non-zero
 * makes its first value read as a jump from nothing, and "no data" can never be alerted on.
 */
export async function toOtlpMetricsJson(journal: Journal, opts: ToOtlpMetricsOptions): Promise<OtlpMetricsPayload> {
  // The label is DERIVED from the handle, not accepted alongside it. `withOrg` marks the journal it
  // returns and `orgScopeOf` reads that mark back, so the numbers and the name they are published
  // under come from one source and cannot drift apart. An explicit `orgId` is still allowed for a
  // caller that scopes some other way, but one that contradicts the handle is a programming error
  // loud enough to stop on: it would put this tenant's traffic on another tenant's graph.
  const scoped = orgScopeOf(journal);
  if (scoped && opts.orgId && opts.orgId !== scoped) {
    throw new Error(
      `@gnldev/otel: the journal is scoped to organization '${scoped}' but orgId '${opts.orgId}' was given. `
      + `The counters would be ${scoped}'s and the metrics would be labelled ${opts.orgId} — pass the journal `
      + `for the organization you mean, and leave orgId unset.`,
    );
  }
  const orgId = scoped ?? opts.orgId;

  const now = opts.now ?? Date.now();
  const time = nano(now);
  const start = nano(opts.startTime);

  // `readCounter`, never `getCounters`: a logical counter is spread over `METRICS_SHARDS` physical
  // rows and a direct read answers for ONE of them — roughly a sixteenth of the traffic at the
  // default, which is low enough to look like a quiet week rather than a bug.
  const fields = (await readCounter(journal, METRICS_ALL_KEY)) ?? {};
  const n = (k: string) => Number(fields[k] ?? 0);

  const metrics: OtlpMetric[] = [
    sumMetric('gnl.runs', '{run}', n('runs'), start, time),
    sumMetric('gnl.tokens', '{token}', n('tokens'), start, time),
    sumMetric('gnl.model_steps', '{step}', n('modelSteps'), start, time),
    sumMetric('gnl.tool_calls', '{call}', n('toolCalls'), start, time),
    {
      // Divided exactly once, here. Money accumulates as integer micro-USD because a float counter
      // drifts; the dashboard wants dollars. Emitting the raw micros ALONGSIDE this would be worse
      // than either alone — a panel summing everything that looks like a cost adds micros to
      // dollars, and no individual number in it is wrong.
      name: 'gnl.cost.usd',
      unit: 'USD',
      sum: {
        dataPoints: [{ attributes: [], startTimeUnixNano: start, timeUnixNano: time, asDouble: n('costUsdMicros') / 1_000_000 }],
        aggregationTemporality: CUMULATIVE,
        isMonotonic: true,
      },
    },
    {
      name: 'gnl.run.duration',
      unit: 'ms',
      histogram: {
        dataPoints: [{
          attributes: [],
          startTimeUnixNano: start,
          timeUnixNano: time,
          count: String(Math.round(n('runs'))),
          sum: n('durMs'),
          bucketCounts: DURATION_FIELDS.map((f) => String(Math.round(n(f)))),
          explicitBounds: DURATION_BOUNDS,
        }],
        aggregationTemporality: CUMULATIVE,
      },
    },
  ];

  return {
    resourceMetrics: [{
      resource: {
        // Organization identifies the whole stream, so it sits on the resource rather than on every
        // data point — where it would be repeated per metric and would invite someone to put two
        // organizations in one export. Nothing unbounded goes anywhere near a label: `runId` is the
        // one that would ruin a backend, and it is right there in the per-run rows the Studio reads.
        attributes: toKv({
          'service.name': opts.serviceName ?? 'gnl',
          ...(orgId ? { 'gnl.org.id': orgId } : {}),
          ...(opts.resourceAttributes ?? {}),
        }),
      },
      scopeMetrics: [{ scope: { name: '@gnldev/otel' }, metrics }],
    }],
  };
}
