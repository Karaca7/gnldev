// P1.6 (AUDIT-R2): GET /metrics + /metrics/runs — materialized-counter fast path vs the
// legacy full-scan fallback. Mirrors runs-paging.test.ts's seeding style (raw journal.put model/tool keys).
import { describe, it, expect, vi } from 'vitest';
import { InMemoryJournal, recordRunMetrics, metricsDayKey, METRICS_ALL_KEY } from '@gnldev/durable';
import { createStudioApi } from '../src/server.js';

async function seedRun(journal: InMemoryJournal, runId: string, tokens: number) {
  await journal.put(`${runId}:model:0`, { usage: { inputTokens: tokens / 2, outputTokens: tokens / 2, totalTokens: tokens } });
}

describe('GET /metrics', () => {
  it('source: "scan" when no materialized counters exist yet (legacy behavior preserved)', async () => {
    const journal = new InMemoryJournal();
    await seedRun(journal, 'r1', 10);
    const app = createStudioApi({ reader: journal });

    const res = await (await app.request('/metrics')).json();
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

    const res = await (await app.request('/metrics')).json();
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

    const small = await (await app.request('/metrics?days=3')).json();
    expect(small.byDay).toHaveLength(3);

    const tooBig = await (await app.request('/metrics?days=999')).json();
    expect(tooBig.byDay).toHaveLength(90);

    const tooSmall = await (await app.request('/metrics?days=0')).json();
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
    const resNoAgg = await (await createStudioApi({ reader: noAgg as any }).request('/metrics')).json();
    const callsNoAgg = listRunsSpyNoAgg.mock.calls.length;
    expect(resNoAgg.total).toBe(2);
    expect(resNoAgg.byStatus).toEqual({ completed: 1, suspended: 1 });
    expect(callsNoAgg).toBeGreaterThan(0); // confirms the fallback really did scan

    const listRunsSpyAgg = vi.spyOn(journal, 'listRuns');
    const resAgg = await (await createStudioApi({ reader: journal }).request('/metrics')).json();
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
    const res = await (await app.request('/metrics')).json();
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
    const res = await (await app.request('/metrics')).json();
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
    const res = await (await app.request('/metrics/runs')).json();

    expect(res.runs).toHaveLength(1);
    expect(res.runs[0]).toMatchObject({ runId: 'r1', status: 'completed', totalTokens: 10, modelSteps: 1 });
    expect(readRunSpy).not.toHaveBeenCalled();
  });

  it('falls back to readRun+getRunCost for a run WITHOUT a materialized row (in-flight or pre-P1.6 legacy)', async () => {
    const journal = new InMemoryJournal();
    await seedRun(journal, 'legacy', 20); // no recordRunMetrics call → no `__metrics__run:` row
    const readRunSpy = vi.spyOn(journal, 'readRun');
    const app = createStudioApi({ reader: journal });
    const res = await (await app.request('/metrics/runs')).json();

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
    const res = await (await app.request('/metrics/runs')).json();
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
    const res = await (await app.request('/metrics/runs')).json();

    expect(res.runs).toHaveLength(2);
    expect(getManySpy).toHaveBeenCalledTimes(1); // ONE batched round-trip for both rows
    expect(getSpy).not.toHaveBeenCalled(); // no per-key get loop
  });

  // P1.6b: ?limit= — clamped 1..1000, slicing the run list BEFORE fetching rows.
  it('?limit= clamps to 1..1000', async () => {
    const journal = new InMemoryJournal();
    for (let i = 0; i < 5; i++) {
      await seedRun(journal, `r${i}`, 10);
      await recordRunMetrics(journal, journal, `r${i}`);
    }
    const app = createStudioApi({ reader: journal });

    const limited = await (await app.request('/metrics/runs?limit=2')).json();
    expect(limited.runs).toHaveLength(2);

    const zero = await (await app.request('/metrics/runs?limit=0')).json();
    expect(zero.runs).toHaveLength(1); // clamped UP to 1

    const huge = await (await app.request('/metrics/runs?limit=99999')).json();
    expect(huge.runs).toHaveLength(5); // clamped down to at most 1000 — only 5 runs exist anyway

    const none = await (await app.request('/metrics/runs')).json();
    expect(none.runs).toHaveLength(5); // no ?limit= → unchanged (all runs)
  });
});
