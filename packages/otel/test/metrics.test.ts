// @gnldev/otel/metrics — the journal's materialized counters as an OTLP/HTTP JSON metrics body.
//
// Written before the implementation, from a review round whose job was to find how a metrics
// exporter is silently wrong. Every case below corresponds to a specific way the numbers can look
// plausible and be false, and the comment on each says which.
//
// Two rules the fixtures obey, because breaking either makes the whole file decorative:
//
//   1. NEVER run these with `GNL_METRICS_SHARDS=1`. At one shard `shardSuffix` returns '' and
//      `sumShards` reads no shard keys, so a correct implementation and one that calls
//      `getCounters` directly produce byte-identical output. The shard bug is invisible at that
//      setting, and the setting is read once at module load (counter-shard.ts), so `vi.stubEnv`
//      cannot change it either.
//   2. Never assert on a SINGLE run. With 16 shards a single run lands on one shard, and a broken
//      reader that happens to look at that shard gets the right answer 1 time in 16.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, recordRunMetrics, rebuildMetrics, withOrg, METRICS_ALL_KEY, readCounter } from '@gnldev/durable';
import type { Journal } from '@gnldev/durable';
import { toOtlpMetricsJson, nextEpoch } from '../src/metrics.js';

/** A completed run with known usage, seeded straight into the journal (no `ai` import — see otel.test.ts). */
async function seedRun(journal: Journal, runId: string, opts: { tokens: number; durationMs?: number; agent?: string } = { tokens: 10 }) {
  const start = 1_700_000_000_000;
  await journal.put(`${runId}:model:0`, {
    usage: { inputTokens: opts.tokens / 2, outputTokens: opts.tokens / 2, totalTokens: opts.tokens },
    ts: start,
  });
  await journal.put(`${runId}:tool:c0`, { status: 'succeeded', output: {}, ts: start + (opts.durationMs ?? 100) });
  await recordRunMetrics(journal, journal as never, runId, opts.agent ? { agentName: opts.agent } : undefined);
}

/** Metrics are keyed by name in the payload; this is how every assertion below reaches one. */
function metricByName(payload: any, name: string) {
  const metrics = payload?.resourceMetrics?.[0]?.scopeMetrics?.[0]?.metrics ?? [];
  return metrics.find((m: any) => m.name === name);
}
function resourceAttrs(payload: any): Record<string, any> {
  return Object.fromEntries((payload?.resourceMetrics?.[0]?.resource?.attributes ?? []).map((a: any) => [a.key, a.value]));
}

const EPOCH = 1_700_000_000_000;
const T1 = EPOCH + 60_000;
const T2 = EPOCH + 120_000;

describe('toOtlpMetricsJson — counter semantics', () => {
  /**
   * The shard trap, and the reason the fixture uses 32 runs rather than one.
   *
   * A logical counter is spread over `METRICS_SHARDS` physical rows; `getCounters(key)` answers for
   * ONE of them. Reading it directly reports roughly a sixteenth of the traffic — low, but not
   * absurd, which is exactly why nobody would question the dashboard.
   */
  it('sums every shard — a direct getCounters read would report a fraction', async () => {
    const journal = new InMemoryJournal();
    for (let i = 0; i < 32; i++) await seedRun(journal, `r${i}`, { tokens: 10 });

    const payload = await toOtlpMetricsJson(journal, { startTime: EPOCH, now: T1 });
    expect(metricByName(payload, 'gnl.runs').sum.dataPoints[0].asInt).toBe('32');

    // The same read done wrong, pinned so the difference is visible rather than argued: one shard
    // holds a fraction of 32, never all of it.
    const oneShard = await journal.getCounters!(METRICS_ALL_KEY);
    expect(oneShard?.runs ?? 0).toBeLessThan(32);
  });

  /**
   * Cumulative, monotonic, and — the part that actually breaks dashboards — a start time that does
   * not move. A collector reading a new `startTimeUnixNano` on the same series treats it as a
   * counter reset and charges the entire accumulated total to one interval: a spike that never
   * happened, every time the process restarts.
   */
  it('is cumulative, and the start time is identical across exports', async () => {
    const journal = new InMemoryJournal();
    for (let i = 0; i < 20; i++) await seedRun(journal, `r${i}`, { tokens: 5 });

    const first = await toOtlpMetricsJson(journal, { startTime: EPOCH, now: T1 });
    for (let i = 20; i < 23; i++) await seedRun(journal, `r${i}`, { tokens: 5 });
    const second = await toOtlpMetricsJson(journal, { startTime: EPOCH, now: T2 });

    const a = metricByName(first, 'gnl.runs').sum;
    const b = metricByName(second, 'gnl.runs').sum;

    expect(a.aggregationTemporality).toBe(2); // CUMULATIVE — delta would double-count on every round
    expect(a.isMonotonic).toBe(true);
    expect(a.dataPoints[0].asInt).toBe('20');
    expect(b.dataPoints[0].asInt).toBe('23'); // the running total, not the 3 that happened since

    expect(b.dataPoints[0].startTimeUnixNano).toBe(a.dataPoints[0].startTimeUnixNano);
    expect(b.dataPoints[0].timeUnixNano).not.toBe(a.dataPoints[0].timeUnixNano);
  });

  /**
   * uint64 fields are strings in OTLP/JSON (the protobuf JSON mapping), and `otlp.ts` already
   * treats that as a contract. Emitting them as numbers survives every small fixture and silently
   * corrupts token totals past 2^53 — the one place this would ever matter is a real deployment.
   */
  it('encodes integer points as strings, not numbers', async () => {
    const journal = new InMemoryJournal();
    for (let i = 0; i < 4; i++) await seedRun(journal, `r${i}`, { tokens: 10 });

    const payload = await toOtlpMetricsJson(journal, { startTime: EPOCH, now: T1 });
    for (const name of ['gnl.runs', 'gnl.tokens', 'gnl.model_steps', 'gnl.tool_calls']) {
      const dp = metricByName(payload, name).sum.dataPoints[0];
      expect(typeof dp.asInt, `${name} must carry a string asInt`).toBe('string');
      expect(dp).not.toHaveProperty('asDouble');
    }
  });
});

describe('toOtlpMetricsJson — money', () => {
  /**
   * Cost accumulates as integer micro-USD on purpose (metrics.ts refuses to accumulate a float).
   * The export has to divide exactly once, on the way out.
   *
   * The fixture uses a fractional, non-unit cost deliberately: at exactly 1 USD, micros are
   * 1,000,000 and a loose `toBeCloseTo` cannot tell a correct export from one that forgot to divide.
   */
  it('sends derived USD once, and does not also send raw micros', async () => {
    const journal = new InMemoryJournal();
    // 4 runs whose combined cost is a fraction of a cent, written straight to the counter so the
    // amount is exact rather than whatever a pricing table happens to produce.
    await journal.incrBy!(METRICS_ALL_KEY, { runs: 4, costUsdMicros: 123, tokens: 40 });

    const payload = await toOtlpMetricsJson(journal, { startTime: EPOCH, now: T1 });
    const usd = metricByName(payload, 'gnl.cost.usd');
    expect(usd.sum.dataPoints[0].asDouble).toBeCloseTo(0.000123, 9);
    expect(usd.unit).toBe('USD');

    // Both would be worse than either: a dashboard summing "everything named cost" adds micros to
    // dollars and reports 123.000123 — two units in one dimension, and no single number is wrong.
    expect(metricByName(payload, 'gnl.cost.usd_micros')).toBeUndefined();

    // Regression lock on WHERE the derivation happens: `readCounter` sums shards but does not
    // derive, and the deriving helper is not exported. An exporter that trusted `readCounter` to
    // hand it `costUsd` would send nothing at all.
    expect((await readCounter(journal, METRICS_ALL_KEY))?.costUsd).toBeUndefined();
  });
});

describe('toOtlpMetricsJson — duration', () => {
  /**
   * The counters hold bucket COUNTS, never individual observations — which is why this is written
   * by hand rather than through the OTel SDK, whose histogram API only accepts recorded values.
   */
  it('builds one histogram from the bucket counts, not five separate counters', async () => {
    const journal = new InMemoryJournal();
    await journal.incrBy!(METRICS_ALL_KEY, {
      runs: 10, durMs: 23_400,
      durLt1s: 4, durLt5s: 3, durLt15s: 2, durLt60s: 1, durGte60s: 0,
    });

    const payload = await toOtlpMetricsJson(journal, { startTime: EPOCH, now: T1 });
    const h = metricByName(payload, 'gnl.run.duration');
    expect(h.histogram.aggregationTemporality).toBe(2);
    const dp = h.histogram.dataPoints[0];

    expect(dp.explicitBounds).toEqual([1000, 5000, 15000, 60000]);
    // One more bucket than bounds — the `+Inf` bucket is implicit and must be present.
    expect(dp.bucketCounts).toHaveLength(dp.explicitBounds.length + 1);
    expect(dp.bucketCounts).toEqual(['4', '3', '2', '1', '0']);
    // The three have to agree, or the dashboard's average latency is invented.
    expect(dp.count).toBe('10');
    expect(dp.sum).toBe(23_400);
    expect(dp.bucketCounts.reduce((s: number, c: string) => s + Number(c), 0)).toBe(Number(dp.count));

    // The buckets must not ALSO appear as their own counters — that is the shape the raw fields
    // would take if they were mapped mechanically, and it double-reports every run.
    expect(metricByName(payload, 'gnl.durLt1s')).toBeUndefined();
  });
});

describe('toOtlpMetricsJson — scope and cardinality', () => {
  /**
   * Every label multiplies the series a backend has to keep. `runId` is the catastrophic one: it is
   * unbounded, and it is right there in the per-run rows the Studio reads, so mapping "whatever is
   * in the record" would ship it.
   */
  it('carries no unbounded label — a run id must never reach a metric', async () => {
    const journal = new InMemoryJournal();
    for (let i = 0; i < 30; i++) await seedRun(journal, `run-${i}`, { tokens: 10, agent: i % 3 === 0 ? 'a' : 'b' });

    const payload = await toOtlpMetricsJson(journal, { startTime: EPOCH, now: T1, orgId: 'acme' });
    const body = JSON.stringify(payload);
    expect(body).not.toMatch(/run-\d/);
    expect(body).not.toMatch(/#\d/); // shard suffixes are physical, never a dimension

    // Org identifies the whole stream, so it belongs on the resource — not on every data point,
    // where it would be repeated per metric and invite per-org series inside one export.
    expect(resourceAttrs(payload)['gnl.org.id']).toEqual({ stringValue: 'acme' });

    for (const m of payload.resourceMetrics[0].scopeMetrics[0].metrics) {
      const points = m.sum?.dataPoints ?? m.histogram?.dataPoints ?? [];
      for (const dp of points) expect(dp.attributes ?? []).toEqual([]);
    }
  });

  it('names the emitting scope so a collector can tell where the series came from', async () => {
    const journal = new InMemoryJournal();
    for (let i = 0; i < 3; i++) await seedRun(journal, `r${i}`, { tokens: 1 });
    const payload = await toOtlpMetricsJson(journal, { startTime: EPOCH, now: T1, serviceName: 'checkout' });
    expect(payload.resourceMetrics[0].scopeMetrics[0].scope.name).toBe('@gnldev/otel');
    expect(resourceAttrs(payload)['service.name']).toEqual({ stringValue: 'checkout' });
  });
});

describe('toOtlpMetricsJson — organizations', () => {
  /**
   * Counters live under the journal handle's prefix, so which journal you hand this decides whose
   * numbers you send. Both ways of getting it wrong are silent: the root handle reads a key nobody
   * writes and reports zero, and an engine-level scan over the counter table sums every tenant.
   *
   * `organization.ts` already refuses to bridge `countRunsByStatus` for this exact reason.
   */
  it('reports one organization s counters, not the sum of all of them', async () => {
    const journal = new InMemoryJournal();
    const a = withOrg(journal, 'a') as unknown as Journal;
    const b = withOrg(journal, 'b') as unknown as Journal;
    for (let i = 0; i < 5; i++) await seedRun(a, `ra${i}`, { tokens: 10 });
    for (let i = 0; i < 40; i++) await seedRun(b, `rb${i}`, { tokens: 10 });

    // Every key the export asks for, captured at the ROOT — which is where the prefix is either
    // present or missing. Asserting only the total would be a tripwire and nothing more: an
    // in-memory journal matches counters by exact key, so it cannot reproduce the leak an
    // engine-level scan over the counter table produces, and this test would then pass no matter
    // what the implementation read. Checking the keys catches the reachable half — reading the
    // BARE `__metrics__:all` from an org handle, which returns zero and looks like a quiet tenant.
    const asked: string[] = [];
    const rootGet = journal.getCounters!.bind(journal);
    (journal as unknown as { getCounters: (k: string) => unknown }).getCounters = (k: string) => {
      asked.push(k);
      return rootGet(k);
    };
    const scoped = withOrg(journal, 'a') as unknown as Journal;

    const payload = await toOtlpMetricsJson(scoped, { startTime: EPOCH, now: T1, orgId: 'a' });
    expect(metricByName(payload, 'gnl.runs').sum.dataPoints[0].asInt).toBe('5'); // not 45

    expect(asked.length).toBeGreaterThan(0);
    for (const k of asked) expect(k, 'a counter read escaped the organization prefix').toMatch(/^org:a:/);
  });

  /**
   * The label comes from the handle, so there is nothing left to keep in sync.
   *
   * The numbers are decided by which journal you pass and the label is what the dashboard believes.
   * As two separate inputs they could disagree, and the result would be one tenant's traffic drawn
   * under another tenant's name — a wrong answer no consumer could detect, because both halves are
   * internally consistent.
   */
  it('takes the organization from the journal itself, not from a second argument', async () => {
    const journal = new InMemoryJournal();
    const acme = withOrg(journal, 'acme') as unknown as Journal;
    for (let i = 0; i < 6; i++) await seedRun(acme, `r${i}`, { tokens: 10 });

    const payload = await toOtlpMetricsJson(acme, { startTime: EPOCH, now: T1 }); // no orgId given
    expect(resourceAttrs(payload)['gnl.org.id']).toEqual({ stringValue: 'acme' });
  });

  it('refuses a label that contradicts the journal it was handed', async () => {
    const journal = new InMemoryJournal();
    const acme = withOrg(journal, 'acme') as unknown as Journal;
    for (let i = 0; i < 3; i++) await seedRun(acme, `r${i}`, { tokens: 10 });

    await expect(toOtlpMetricsJson(acme, { startTime: EPOCH, now: T1, orgId: 'globex' }))
      .rejects.toThrow(/scoped to organization 'acme'.*'globex'/s);
  });
});

describe('toOtlpMetricsJson — empty and reset', () => {
  /**
   * A journal with no runs must still produce a zero, not nothing. "No data" and "0 runs" look the
   * same on a graph and mean opposite things: a rate() over a series that starts at its first
   * non-zero value reads that first value as a jump, and an alert on absence can never be written.
   */
  it('reports zero rather than silence when nothing has run yet', async () => {
    const journal = new InMemoryJournal();
    const payload = await toOtlpMetricsJson(journal, { startTime: EPOCH, now: T1 });
    expect(metricByName(payload, 'gnl.runs').sum.dataPoints[0].asInt).toBe('0');
  });

  /**
   * The mirror of the stability rule, and the reason it is a separate function.
   *
   * `toOtlpMetricsJson` is a pure transform: it is told the start time, it does not decide one.
   * Deciding requires memory of the previous export, which belongs to whoever is running the loop —
   * so the rule lives in `nextEpoch`, where it can be tested without a journal at all.
   *
   * The rule has two halves and they pull in opposite directions. A total that grew, or held, must
   * keep the same start time: renewing it tells the collector the counter reset and it charges the
   * whole accumulated value to one interval. A total that FELL really is a reset — `rebuildMetrics`
   * recomputes from the journal and the number can legitimately drop after a purge — and there the
   * start time has to move, or the collector sees a monotonic series go backwards and invents a
   * rate out of the wraparound.
   */
  it('keeps the epoch while the total grows, and moves it when the total falls', () => {
    const first = nextEpoch(undefined, 10, EPOCH);
    expect(first.startTime).toBe(EPOCH);

    const grew = nextEpoch(first, 23, T1);
    expect(grew.startTime).toBe(EPOCH); // unchanged — this is the common case and the dangerous one
    const held = nextEpoch(grew, 23, T2);
    expect(held.startTime).toBe(EPOCH);

    const fell = nextEpoch(held, 5, T2);
    expect(fell.startTime).toBe(T2); // a rebuild happened; the series starts again here
    expect(nextEpoch(fell, 6, T2 + 1_000).startTime).toBe(T2); // and then holds again
  });

  /** The same rule, driven by a real rebuild rather than by hand-picked numbers. */
  it('a rebuild that lowers the total is a reset', async () => {
    const journal = new InMemoryJournal();
    for (let i = 0; i < 10; i++) await seedRun(journal, `r${i}`, { tokens: 10 });

    let epoch = nextEpoch(undefined, Number((await readCounter(journal, METRICS_ALL_KEY))?.runs ?? 0), EPOCH);
    const before = await toOtlpMetricsJson(journal, { startTime: epoch.startTime, now: T1 });
    expect(metricByName(before, 'gnl.runs').sum.dataPoints[0].asInt).toBe('10');

    // Half the runs are purged, then the counters are rebuilt from what is left.
    for (let i = 0; i < 5; i++) await journal.deletePrefix!(`r${i}:`);
    await rebuildMetrics(journal, journal as never);

    epoch = nextEpoch(epoch, Number((await readCounter(journal, METRICS_ALL_KEY))?.runs ?? 0), T2);
    const after = await toOtlpMetricsJson(journal, { startTime: epoch.startTime, now: T2 });
    const dp = metricByName(after, 'gnl.runs').sum.dataPoints[0];
    expect(Number(dp.asInt)).toBeLessThan(10);
    expect(dp.startTimeUnixNano).not.toBe(metricByName(before, 'gnl.runs').sum.dataPoints[0].startTimeUnixNano);
  });
});
