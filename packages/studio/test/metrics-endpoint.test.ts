// P1.6 (AUDIT-R2): GET /metrics + /metrics/runs — materialized-counter fast path vs the
// legacy full-scan fallback. Mirrors runs-paging.test.ts's seeding style (raw journal.put model/tool keys).
import { describe, it, expect, vi } from 'vitest';
import {
  InMemoryJournal, recordRunMetrics, metricsDayKey, metricsRunKey, METRICS_ALL_KEY,
  recordRunOutcome, runStarted, runCanceled,
} from '@gnldev/durable';
import { createStudioApi } from '../src/server.js';
import { call } from './call.js';

async function seedRun(journal: InMemoryJournal, runId: string, tokens: number) {
  await journal.put(`${runId}:model:0`, { usage: { inputTokens: tokens / 2, outputTokens: tokens / 2, totalTokens: tokens } });
}

describe('GET /metrics', () => {
  it('source: "scan" when no materialized counters exist yet (legacy behavior preserved)', async () => {
    const journal = new InMemoryJournal();
    await seedRun(journal, 'r1', 10);
    const app = createStudioApi({ reader: journal });

    const res = await (await call(app, '/metrics')).json();
    expect(res.source).toBe('scan');
    expect(res.total).toBe(1);
    expect(res.tokens).toBe(10);
    expect(res.byStatus.completed).toBe(1);
  });

  it('source: "materialized" once the run has been recorded; byDay is present (default 14 days)', async () => {
    const journal = new InMemoryJournal();
    await seedRun(journal, 'r1', 10);
    await recordRunMetrics(journal, journal, 'r1');
    const app = createStudioApi({ reader: journal });

    const res = await (await call(app, '/metrics')).json();
    expect(res.source).toBe('materialized');
    expect(res.total).toBe(1);
    expect(res.tokens).toBe(10);
    expect(Array.isArray(res.byDay)).toBe(true);
    expect(res.byDay).toHaveLength(14);
  });

  it('?days=N controls the byDay window; out-of-range values are clamped to 1..90', async () => {
    const journal = new InMemoryJournal();
    await seedRun(journal, 'r1', 10);
    await recordRunMetrics(journal, journal, 'r1');
    const app = createStudioApi({ reader: journal });

    const small = await (await call(app, '/metrics?days=3')).json();
    expect(small.byDay).toHaveLength(3);

    const tooBig = await (await call(app, '/metrics?days=999')).json();
    expect(tooBig.byDay).toHaveLength(90);

    const tooSmall = await (await call(app, '/metrics?days=0')).json();
    expect(tooSmall.byDay).toHaveLength(1);
  });

  /** A reader wrapper WITHOUT `countRunsByStatus` (bound methods over the SAME underlying journal) —
   *  forces server.ts's legacy listRuns-scan fallback while sharing identical underlying data. */
  function withoutCountRunsByStatus(journal: InMemoryJournal) {
    return {
      get: journal.get.bind(journal),
      put: journal.put.bind(journal),
      putIfAbsent: journal.putIfAbsent.bind(journal),
      getCounters: journal.getCounters.bind(journal),
      listRuns: journal.listRuns.bind(journal),
      readRun: journal.readRun.bind(journal),
    };
  }

  // P1.6b: total/byStatus driven by the push-down countRunsByStatus aggregate instead of materializing
  // every RunSummary via listRuns() just to count them. InMemoryJournal's OWN countRunsByStatus happens
  // to derive from listRuns() internally (a cheap in-RAM convenience, not a separate indexed SQL
  // aggregate — see journal.ts) — so the guaranteed win is "server.ts's OWN explicit listRuns() call for
  // byStatus is skipped", which can only ever make the call count EQUAL OR LOWER than the no-aggregate
  // fallback, never higher.
  it('total/byStatus via countRunsByStatus: listRuns is called no more than the no-aggregate fallback', async () => {
    const journal = new InMemoryJournal();
    await seedRun(journal, 'r1', 10);
    await seedRun(journal, 'r2', 20);
    await journal.put('r2:tool:t1', { status: 'suspended', output: {} }); // r2 → suspended
    await recordRunMetrics(journal, journal, 'r1');
    await recordRunMetrics(journal, journal, 'r2');

    const noAgg = withoutCountRunsByStatus(journal);
    const listRunsSpyNoAgg = vi.spyOn(noAgg, 'listRuns');
    const resNoAgg = await (await call(createStudioApi({ reader: noAgg as any }), '/metrics')).json();
    const callsNoAgg = listRunsSpyNoAgg.mock.calls.length;
    expect(resNoAgg.total).toBe(2);
    expect(resNoAgg.byStatus).toEqual({ completed: 1, suspended: 1 });
    expect(callsNoAgg).toBeGreaterThan(0); // confirms the fallback really did scan

    const listRunsSpyAgg = vi.spyOn(journal, 'listRuns');
    const resAgg = await (await call(createStudioApi({ reader: journal }), '/metrics')).json();
    const callsAgg = listRunsSpyAgg.mock.calls.length;
    expect(resAgg.total).toBe(2);
    expect(resAgg.byStatus).toEqual({ completed: 1, suspended: 1 });

    expect(callsAgg).toBeLessThanOrEqual(callsNoAgg); // never MORE listRuns calls than the fallback baseline
  });

  it('countRunsByStatus omitted → falls back to the listRuns scan (unchanged legacy behavior)', async () => {
    const journal = new InMemoryJournal();
    await seedRun(journal, 'r1', 10);
    await recordRunMetrics(journal, journal, 'r1');
    const noAgg = withoutCountRunsByStatus(journal);
    const app = createStudioApi({ reader: noAgg as any });
    const res = await (await call(app, '/metrics')).json();
    expect(res.source).toBe('materialized');
    expect(res.total).toBe(1);
    expect(res.byStatus.completed).toBe(1);
  });

  // P2-skor (AUDIT-R2): server.ts needs NO code change for this — readMetricsSummary already
  // derives `score:<name>:avg` onto every day/all counter bundle it reads back (see withDerivedScores in
  // metrics.ts), and `byDay` is returned as-is. Seeds the score:*:sumMilli/:count fields directly (the
  // same shape recordRunScores writes, see packages/durable/test/metrics-scores.test.ts for the writer
  // side) to keep this test @gnldev/durable-package-agnostic of recordRunScores itself (not exported off
  // the package's public index — the writer is exercised from inside @gnldev/durable's own test suite).
  it('a score:<name>:avg field appears in the materialized byDay response once score counters exist', async () => {
    const journal = new InMemoryJournal();
    await seedRun(journal, 'r1', 10);
    await recordRunMetrics(journal, journal, 'r1');
    const today = new Date().toISOString().slice(0, 10);
    await journal.incrBy(metricsDayKey(today), { 'score:quality:sumMilli': 800, 'score:quality:count': 1 });
    await journal.incrBy(METRICS_ALL_KEY, { 'score:quality:sumMilli': 800, 'score:quality:count': 1 });

    const app = createStudioApi({ reader: journal });
    const res = await (await call(app, '/metrics')).json();
    expect(res.source).toBe('materialized');
    const todayBucket = res.byDay.find((d: any) => d.day === today);
    expect(todayBucket.fields['score:quality:avg']).toBeCloseTo(0.8, 10);
  });
});

describe('GET /metrics/runs', () => {
  it('reads the materialized row for a finalized run — does NOT call readRun for it', async () => {
    const journal = new InMemoryJournal();
    await seedRun(journal, 'r1', 10);
    await recordRunMetrics(journal, journal, 'r1', { agentName: 'support' });

    const readRunSpy = vi.spyOn(journal, 'readRun');
    const app = createStudioApi({ reader: journal });
    const res = await (await call(app, '/metrics/runs')).json();

    expect(res.runs).toHaveLength(1);
    expect(res.runs[0]).toMatchObject({ runId: 'r1', status: 'completed', totalTokens: 10, modelSteps: 1 });
    expect(readRunSpy).not.toHaveBeenCalled();
  });

  it('falls back to readRun+getRunCost for a run WITHOUT a materialized row (in-flight or pre-P1.6 legacy)', async () => {
    const journal = new InMemoryJournal();
    await seedRun(journal, 'legacy', 20); // no recordRunMetrics call → no `__metrics__run:` row
    const readRunSpy = vi.spyOn(journal, 'readRun');
    const app = createStudioApi({ reader: journal });
    const res = await (await call(app, '/metrics/runs')).json();

    expect(res.runs).toHaveLength(1);
    expect(res.runs[0]).toMatchObject({ runId: 'legacy', totalTokens: 20 });
    expect(readRunSpy).toHaveBeenCalled();
  });

  it('response shape is backward-compatible: mixes fast-path and scan rows in the same call', async () => {
    const journal = new InMemoryJournal();
    await seedRun(journal, 'fast', 10);
    await recordRunMetrics(journal, journal, 'fast');
    await seedRun(journal, 'slow', 5); // no row → scan fallback

    const app = createStudioApi({ reader: journal });
    const res = await (await call(app, '/metrics/runs')).json();
    const byId = Object.fromEntries(res.runs.map((r: any) => [r.runId, r]));
    expect(byId.fast.totalTokens).toBe(10);
    expect(byId.slow.totalTokens).toBe(5);
    for (const row of res.runs) {
      expect(row).toHaveProperty('runId');
      expect(row).toHaveProperty('status');
      expect(row).toHaveProperty('modelSteps');
      expect(row).toHaveProperty('toolCalls');
      expect(row).toHaveProperty('startTs');
      expect(row).toHaveProperty('durationMs');
      expect(row).toHaveProperty('costUsd');
      expect(row).toHaveProperty('totalTokens');
    }
  });

  // P1.6b: ONE getMany round-trip for every fast-path row instead of a per-run rw.get loop.
  it('getMany batches every fast-path row in ONE call — per-key get is not used when getMany exists', async () => {
    const journal = new InMemoryJournal();
    await seedRun(journal, 'r1', 10);
    await seedRun(journal, 'r2', 20);
    await recordRunMetrics(journal, journal, 'r1');
    await recordRunMetrics(journal, journal, 'r2');

    const getSpy = vi.spyOn(journal, 'get');
    const getManySpy = vi.spyOn(journal, 'getMany');
    const app = createStudioApi({ reader: journal });
    const res = await (await call(app, '/metrics/runs')).json();

    expect(res.runs).toHaveLength(2);
    expect(getManySpy).toHaveBeenCalledTimes(1); // ONE batched round-trip for both rows
    expect(getSpy).not.toHaveBeenCalled(); // no per-key get loop
  });

  // D5: the two endpoints Observability shows on ONE screen — the runs list and the metrics table —
  // disagreed about the same run. The `__metrics__run:` row is written once, the first time a run
  // finishes successfully (exactly-once claim per runId), so a later verdict never reaches it.
  it('a run re-run into FAILURE reads failed on /metrics/runs, not the stale row\'s completed', async () => {
    const journal = new InMemoryJournal();
    await seedRun(journal, 'r1', 10);
    await recordRunMetrics(journal, journal, 'r1'); // first attempt succeeded → row written
    expect(await journal.get(metricsRunKey('r1'))).toMatchObject({ status: 'completed' }); // the row itself stays at its finalize-time verdict
    // The re-run fails. recordRunMetrics is a no-op (claim already held) — only the journal learns.
    await recordRunOutcome(journal, 'r1', { status: 'failed', at: Date.now(), error: '401 invalid api key' });
    expect(await recordRunMetrics(journal, journal, 'r1')).toBe(false);

    const app = createStudioApi({ reader: journal });
    const runs = await (await call(app, '/runs')).json();
    const metricsRuns = (await (await call(app, '/metrics/runs')).json()).runs;

    expect(runs.find((r: any) => r.runId === 'r1').status).toBe('failed');
    expect(metricsRuns.find((r: any) => r.runId === 'r1').status).toBe('failed'); // the aggregate agrees with the list
    expect(metricsRuns[0].totalTokens).toBe(10); // cost/tokens still come off the materialized row
  });

  // The vocabulary grew ('canceled', 'running') AFTER this fast path was written — a run in either state
  // must not be flattened into the row's finalize-time verdict on day one.
  it('canceled and running runs keep their live status through the fast-row path', async () => {
    const journal = new InMemoryJournal();
    await seedRun(journal, 'gone', 10);
    await recordRunMetrics(journal, journal, 'gone');
    await seedRun(journal, 'live', 20);
    await recordRunMetrics(journal, journal, 'live');
    await runCanceled(journal, 'gone', Date.now()); // operator canceled it after that first finish
    await runStarted(journal, 'live', Date.now()); // re-run in flight — write-ahead, no ending recorded

    const app = createStudioApi({ reader: journal });
    const runs = await (await call(app, '/runs')).json();
    const byIdRuns = Object.fromEntries(runs.map((r: any) => [r.runId, r.status]));
    const metricsRuns = (await (await call(app, '/metrics/runs')).json()).runs;
    const byIdMetrics = Object.fromEntries(metricsRuns.map((r: any) => [r.runId, r.status]));

    expect(byIdRuns).toMatchObject({ gone: 'canceled', live: 'running' });
    expect(byIdMetrics).toEqual(byIdRuns); // same journal, same answer — on every status in the vocabulary
  });

  // P1.6b: ?limit= — clamped 1..1000, slicing the run list BEFORE fetching rows.
  it('?limit= clamps to 1..1000', async () => {
    const journal = new InMemoryJournal();
    for (let i = 0; i < 5; i++) {
      await seedRun(journal, `r${i}`, 10);
      await recordRunMetrics(journal, journal, `r${i}`);
    }
    const app = createStudioApi({ reader: journal });

    const limited = await (await call(app, '/metrics/runs?limit=2')).json();
    expect(limited.runs).toHaveLength(2);

    const zero = await (await call(app, '/metrics/runs?limit=0')).json();
    expect(zero.runs).toHaveLength(1); // clamped UP to 1

    const huge = await (await call(app, '/metrics/runs?limit=99999')).json();
    expect(huge.runs).toHaveLength(5); // clamped down to at most 1000 — only 5 runs exist anyway

    const none = await (await call(app, '/metrics/runs')).json();
    expect(none.runs).toHaveLength(5); // no ?limit= → unchanged (all runs)
  });
});

/**
 * How many counter reads a page costs, pinned — because the waste here was invisible.
 *
 * Every logical counter is spread over `METRICS_SHARDS` physical rows plus the unsuffixed key, so
 * reading one bucket is 17 point reads at the default. `readMetricsSummary` builds `all` plus 14
 * daily buckets: 255 reads. `GET /organizations` wanted two fields out of `all` and discarded the
 * other 238 — per organization, on every load. Fifty organizations came to 12,750 reads against the
 * caller's own database to render one page.
 *
 * The count is the assertion because nothing else notices: the response was correct either way, the
 * endpoint was never slow enough locally to look wrong, and the cost only shows up on a real
 * database under a real number of organizations. A read budget is the only thing that fails when
 * somebody reintroduces the full summary.
 */
describe('GET /organizations — counter read budget', () => {
  it('reads the running totals only, not fourteen daily buckets nobody asked for', async () => {
    const journal = new InMemoryJournal();
    await seedRun(journal, 'r1', 10);
    await recordRunMetrics(journal, 'r1', { agent: 'a', tokens: 10, costUsdMicros: 5, ms: 1 } as never).catch(() => {});
    await journal.put('org:acme:r-x:model:0', { usage: { totalTokens: 4 } });
    await journal.put('__org__:acme', { id: 'acme' });

    const counterReads = vi.fn(journal.getCounters!.bind(journal));
    const spied = new Proxy(journal, {
      get: (t, p, r) => (p === 'getCounters' ? counterReads : Reflect.get(t, p, r)),
    }) as InMemoryJournal;

    const app = createStudioApi({ reader: spied, org: {} });
    const res = await (await call(app, '/organizations')).json();
    expect(res.organizations.length).toBeGreaterThan(0);

    // One logical bucket per organization. The bound is deliberately loose — it is a budget, not a
    // fingerprint of the shard count — but 255-per-org cannot hide under it.
    const perOrg = counterReads.mock.calls.length / res.organizations.length;
    expect(perOrg, `${counterReads.mock.calls.length} counter reads for ${res.organizations.length} org(s)`).toBeLessThanOrEqual(40);
  });
});
