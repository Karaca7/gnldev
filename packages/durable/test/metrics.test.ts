// P1.6 (AUDIT-R2): materialized metrics layer — incremental per-day/per-agent counters +
// a per-run fast-path row, written once at completion (see metrics.ts). Mirrors budget.ts's H8a
// incrBy/getCounters test style (budget-inflight.test.ts) and organization.test.ts's withOrg isolation style.
import { describe, it, expect, vi } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import type { Journal, JournalReader } from '../src/journal.js';
import { withOrg } from '../src/organization.js';
import { recordRunOutcome, runStarted } from '../src/outcome.js';
import {
  recordRunMetrics, backfillMetrics, rebuildMetrics, readMetricsSummary,
  metricsRunKey, metricsDoneKey, METRICS_ALL_KEY,
} from '../src/metrics.js';

/** A model-step record with the given total token usage (the shape getRunCost/usageAndCostFromModelValue reads). */
function modelUsage(totalTokens: number) {
  return { usage: { inputTokens: totalTokens / 2, outputTokens: totalTokens / 2, totalTokens } };
}

describe('metrics.ts — recordRunMetrics', () => {
  it('writes counters + a run row on the first call; a second call is a no-op (no double count)', async () => {
    const journal = new InMemoryJournal();
    await journal.put('r1:model:0', modelUsage(1500));
    await journal.put('r1:tool:c1', { status: 'succeeded', output: {} });

    const first = await recordRunMetrics(journal, journal, 'r1', { agentName: 'support' });
    expect(first).toBe(true);

    const all = await journal.getCounters(METRICS_ALL_KEY);
    expect(all?.runs).toBe(1);
    expect(all?.tokens).toBe(1500);
    expect(all?.modelSteps).toBe(1);
    expect(all?.toolCalls).toBe(1);

    const row = await journal.get(metricsRunKey('r1'));
    expect(row).toMatchObject({ runId: 'r1', agentName: 'support', status: 'completed', totalTokens: 1500, modelSteps: 1, toolCalls: 1 });

    const second = await recordRunMetrics(journal, journal, 'r1', { agentName: 'support' });
    expect(second).toBe(false); // claim already held — no-op

    const allAfter = await journal.getCounters(METRICS_ALL_KEY);
    expect(allAfter?.runs).toBe(1); // unchanged — NOT double-counted
    expect(allAfter?.tokens).toBe(1500);
  });

  it('day bucketing: two runs recorded on different (stubbed) days land in different day-key counters', async () => {
    const journal = new InMemoryJournal();
    await journal.put('run-a:model:0', modelUsage(10));
    (journal as unknown as { now: () => Promise<number> }).now = async () => Date.UTC(2026, 0, 1); // 2026-01-01
    await recordRunMetrics(journal, journal, 'run-a');

    await journal.put('run-b:model:0', modelUsage(20));
    (journal as unknown as { now: () => Promise<number> }).now = async () => Date.UTC(2026, 0, 2); // 2026-01-02
    await recordRunMetrics(journal, journal, 'run-b');

    const day1 = await journal.getCounters('__metrics__:d:2026-01-01');
    const day2 = await journal.getCounters('__metrics__:d:2026-01-02');
    expect(day1).toEqual(expect.objectContaining({ runs: 1, tokens: 10 }));
    expect(day2).toEqual(expect.objectContaining({ runs: 1, tokens: 20 }));

    const all = await journal.getCounters(METRICS_ALL_KEY);
    expect(all?.runs).toBe(2);
    expect(all?.tokens).toBe(30);
  });

  it('duration histogram: exactly one bucket incremented per run (a 3s run lands in durLt5s)', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const journal = new InMemoryJournal();
      await journal.put('r1:model:0', modelUsage(10));
      vi.setSystemTime(3_000); // 3s later
      await journal.put('r1:tool:c1', { status: 'succeeded', output: {} });

      await recordRunMetrics(journal, journal, 'r1');
      const all = await journal.getCounters(METRICS_ALL_KEY);
      expect(all?.durLt5s).toBe(1);
      expect(all?.durLt1s ?? 0).toBe(0);
      expect(all?.durLt15s ?? 0).toBe(0);
      expect(all?.durLt60s ?? 0).toBe(0);
      expect(all?.durGte60s ?? 0).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('per-agent per-day counter is written only when agentName is given; agentName with \':\' is sanitized', async () => {
    const journal = new InMemoryJournal();
    await journal.put('r1:model:0', modelUsage(10));
    (journal as unknown as { now: () => Promise<number> }).now = async () => Date.UTC(2026, 0, 5);
    await recordRunMetrics(journal, journal, 'r1', { agentName: 'billing:v2' });

    const agentDay = await journal.getCounters('__metrics__:agent:billing_v2:d:2026-01-05');
    expect(agentDay?.runs).toBe(1);

    await journal.put('r2:model:0', modelUsage(5));
    await recordRunMetrics(journal, journal, 'r2'); // no agentName → no per-agent counter
    // (no assertion needed beyond "doesn't throw" — there is no agent-scoped key to check for r2)
  });

  // D5: the row's `status` is the verdict its settled cost belongs to — a finalize-time record, never
  // the run's live status. It was typed `RunStatus` (five values) while the producer could only ever
  // write two of them, and Studio's /metrics/runs read it as if it were live: a run that succeeded and
  // was later re-run into failure showed 'failed' on GET /runs and 'completed' on GET /metrics/runs.
  it('the row records the FINALIZE-TIME verdict only — a later outcome never rewrites it', async () => {
    const journal = new InMemoryJournal();
    await journal.put('r1:model:0', modelUsage(10));
    // The write-ahead 'running' that is genuinely there when recordRunMetrics runs: run.ts calls it
    // BEFORE runSucceeded at both completion choke points (measured — a successful run's outcome still
    // reads {status:'running'} at this instant). Feeding this record into summarizeRun would therefore
    // label a succeeded run 'running'; the row stays outcome-blind on purpose.
    await runStarted(journal, 'r1', Date.now());
    await recordRunMetrics(journal, journal, 'r1');
    expect(await journal.get(metricsRunKey('r1'))).toMatchObject({ status: 'completed' });

    // The run is re-run and fails. The row is claimed exactly-once, so it does NOT move — which is why
    // status has to be served from the journal (deriveRunStatus over the outcome), not from here.
    await recordRunOutcome(journal, 'r1', { status: 'failed', at: Date.now(), error: 'boom' });
    expect(await recordRunMetrics(journal, journal, 'r1')).toBe(false);
    expect(await journal.get(metricsRunKey('r1'))).toMatchObject({ status: 'completed' });
    expect((await journal.listRuns()).find((r) => r.runId === 'r1')?.status).toBe('failed');
  });

  it('a suspended run\'s row records \'suspended\' — the other value the finalize-time verdict can take', async () => {
    const journal = new InMemoryJournal();
    await journal.put('r1:model:0', modelUsage(10));
    await journal.put('r1:tool:c1', { status: 'suspended', output: {} });
    await recordRunMetrics(journal, journal, 'r1');
    expect(await journal.get(metricsRunKey('r1'))).toMatchObject({ status: 'suspended' });
  });

  it('fallback: a journal without incrBy/putIfAbsent returns false and writes nothing', async () => {
    const putSpy = vi.fn(async () => {});
    const bare: Journal = { get: async () => undefined, put: putSpy };
    const reader: JournalReader = { listRuns: async () => [], readRun: async () => [] };

    const ok = await recordRunMetrics(bare, reader, 'r1');
    expect(ok).toBe(false);
    expect(putSpy).not.toHaveBeenCalled();
  });

  // P1.6b: money is accumulated as INTEGER micro-USD (costUsdMicros); readMetricsSummary derives the
  // float `costUsd` back — including folding in a legacy float `costUsd` field (pre-P1.6b data).
  it('costUsdMicros is an integer counter; readMetricsSummary derives costUsd back (incl. legacy costUsd fold)', async () => {
    const journal = new InMemoryJournal();
    // A model record with a real modelId (DEFAULT_PRICING has an exact match) → a KNOWN, non-zero cost:
    // 1000 input + 1000 output tokens @ claude-sonnet-4 ($3/$15 per 1M) = 0.003 + 0.015 = 0.018 USD.
    await journal.put('r1:model:0', {
      usage: { inputTokens: 1000, outputTokens: 1000, totalTokens: 2000 },
      response: { modelId: 'claude-sonnet-4' },
    });
    await recordRunMetrics(journal, journal, 'r1');

    const all = await journal.getCounters(METRICS_ALL_KEY);
    expect(all?.costUsdMicros).toBe(18000); // Math.round(0.018 * 1e6) — an INTEGER, not a float
    expect(Number.isInteger(all!.costUsdMicros)).toBe(true);

    const summary = await readMetricsSummary(journal);
    expect(summary.all?.costUsd).toBeCloseTo(0.018, 10);

    // Legacy fold: a pre-P1.6b counter written as a plain float `costUsd` field (no `costUsdMicros`)
    // still contributes correctly when it coexists with a costUsdMicros counter (mixed data adds up).
    await journal.incrBy(METRICS_ALL_KEY, { costUsd: 0.5 }); // simulates old (pre-switch) data
    const summary2 = await readMetricsSummary(journal);
    expect(summary2.all?.costUsd).toBeCloseTo(0.518, 10); // 0.5 legacy + 0.018 micros-derived
  });

  // P1.6b atomicity: with a journal exposing applyBatch, recordRunMetrics MUST use the atomic batch path
  // exclusively — never falling back to the sequential incrBy/putIfAbsent calls (which this stub makes
  // throw, so any accidental use of the sequential path would fail the test loudly).
  it('atomicity: recordRunMetrics uses applyBatch exclusively when available (never touches incrBy/putIfAbsent)', async () => {
    const real = new InMemoryJournal();
    await real.put('r1:model:0', modelUsage(10));
    const stub = {
      get: (k: string) => real.get(k),
      put: (k: string, v: unknown) => real.put(k, v),
      applyBatch: (b: Parameters<typeof real.applyBatch>[0]) => real.applyBatch(b),
      incrBy: async () => { throw new Error('sequential path must not be used when applyBatch exists'); },
      putIfAbsent: async () => { throw new Error('sequential path must not be used when applyBatch exists'); },
    } as unknown as Journal;
    const reader: JournalReader = { listRuns: () => real.listRuns(), readRun: (id: string) => real.readRun(id) };

    const ok = await recordRunMetrics(stub, reader, 'r1');
    expect(ok).toBe(true);
    const all = await real.getCounters(METRICS_ALL_KEY);
    expect(all?.runs).toBe(1);
    expect(all?.tokens).toBe(10);
  });

  // P1.6b — the DOCUMENTED sequential-path undercount window (see recordRunMetrics's JSDoc): a journal
  // WITHOUT applyBatch claims FIRST (putIfAbsent), then incrBy. A crash/throw between the two loses that
  // run's contribution FOREVER (the claim marker already landed) — but crucially does NOT double-claim
  // on a retry (no double-count risk either), and does not retry the failed incrBy indefinitely.
  it('sequential fallback (no applyBatch): a crash AFTER the claim permanently loses the contribution but never double-claims on retry', async () => {
    const real = new InMemoryJournal();
    await real.put('r1:model:0', modelUsage(10));
    let incrByCalls = 0;
    const stub = {
      get: (k: string) => real.get(k),
      put: (k: string, v: unknown) => real.put(k, v),
      putIfAbsent: (k: string, v: unknown) => real.putIfAbsent(k, v),
      incrBy: async () => { incrByCalls++; throw new Error('simulated crash after claim'); },
    } as unknown as Journal;
    const reader: JournalReader = { listRuns: () => real.listRuns(), readRun: (id: string) => real.readRun(id) };

    await expect(recordRunMetrics(stub, reader, 'r1')).rejects.toThrow('simulated crash after claim');
    expect(incrByCalls).toBe(1);
    expect(await real.get(metricsDoneKey('r1'))).toBeDefined(); // claim marker DID land (claim-first)

    // A second call sees the claim already held → false, WITHOUT retrying incrBy (no double-claim, no
    // repeated attempt either) — the run's contribution stays permanently lost until rebuildMetrics repairs it.
    const second = await recordRunMetrics(stub, reader, 'r1');
    expect(second).toBe(false);
    expect(incrByCalls).toBe(1); // not retried
  });
});

describe('metrics.ts — backfillMetrics', () => {
  it('records every completed run exactly once, skips suspended runs; re-running skips everything', async () => {
    const journal = new InMemoryJournal();
    await journal.put('done-1:model:0', modelUsage(10));
    await journal.put('done-2:model:0', modelUsage(20));
    await journal.put('susp-1:model:0', modelUsage(5));
    await journal.put('susp-1:tool:c1', { status: 'suspended', output: {} });

    const first = await backfillMetrics(journal, journal);
    expect(first).toEqual({ recorded: 2, skipped: 1, scoresRestored: 0 });

    const all = await journal.getCounters(METRICS_ALL_KEY);
    expect(all?.runs).toBe(2);
    expect(all?.tokens).toBe(30);

    const second = await backfillMetrics(journal, journal);
    expect(second).toEqual({ recorded: 0, skipped: 3, scoresRestored: 0 }); // 2 already-claimed + 1 still-suspended

    const allAfter = await journal.getCounters(METRICS_ALL_KEY);
    expect(allAfter?.runs).toBe(2); // unchanged
  });
});

describe('metrics.ts — rebuildMetrics', () => {
  it('restores exact counter values after tampering', async () => {
    const journal = new InMemoryJournal();
    await journal.put('r1:model:0', modelUsage(10));
    await journal.put('r2:model:0', modelUsage(20));
    await backfillMetrics(journal, journal);
    const before = await journal.getCounters(METRICS_ALL_KEY);
    expect(before?.runs).toBe(2);

    // Tamper directly with the counter (simulates drift/corruption).
    await journal.incrBy(METRICS_ALL_KEY, { runs: 999, tokens: -12345 });
    const tampered = await journal.getCounters(METRICS_ALL_KEY);
    expect(tampered?.runs).not.toBe(before?.runs);

    const result = await rebuildMetrics(journal, journal);
    expect(result).toEqual({ recorded: 2, skipped: 0, scoresRestored: 0 });

    const after = await journal.getCounters(METRICS_ALL_KEY);
    expect(after).toEqual(before);
  });

  it('throws a clear error when the journal does not implement deletePrefix', async () => {
    const bare = {
      get: async () => undefined,
      put: async () => {},
      putIfAbsent: async () => true,
      incrBy: async () => {},
      getCounters: async () => undefined,
    } as unknown as Journal;
    const reader: JournalReader = { listRuns: async () => [], readRun: async () => [] };
    await expect(rebuildMetrics(bare, reader)).rejects.toThrow(/deletePrefix/);
  });
});

describe('metrics.ts — org isolation', () => {
  it('withOrg-wrapped writes land under the org prefix; another org reads nothing', async () => {
    const shared = new InMemoryJournal();
    const acme = withOrg(shared, 'acme') as unknown as Journal & JournalReader;
    const globex = withOrg(shared, 'globex') as unknown as Journal & JournalReader;

    await acme.put('r1:model:0', modelUsage(10));
    await recordRunMetrics(acme, acme, 'r1');

    const acmeAll = await acme.getCounters!(METRICS_ALL_KEY);
    expect(acmeAll?.runs).toBe(1);
    const globexAll = await globex.getCounters!(METRICS_ALL_KEY);
    expect(globexAll).toBeUndefined(); // isolation — globex sees nothing

    // The physical key really is org-prefixed in the shared store (the mechanism behind isolation).
    expect(shared.keys().some((k) => k.startsWith('org:acme:__metrics__:'))).toBe(true);
    expect(shared.keys().some((k) => k.startsWith('org:globex:__metrics__:'))).toBe(false);
  });
});

describe('metrics.ts — readMetricsSummary', () => {
  it('returns undefined/empty when the journal has no getCounters', async () => {
    const bare = { get: async () => undefined, put: async () => {} } as unknown as Journal;
    const summary = await readMetricsSummary(bare);
    expect(summary.all).toBeUndefined();
    expect(summary.byDay).toEqual([]);
  });

  it('returns all-time totals + N day buckets (default 14, clamped 1..90)', async () => {
    const journal = new InMemoryJournal();
    await journal.put('r1:model:0', modelUsage(10));
    await backfillMetrics(journal, journal);

    const summary = await readMetricsSummary(journal);
    expect(summary.all?.runs).toBe(1);
    expect(summary.byDay).toHaveLength(14);
    // Today's bucket (last entry, oldest-first order) should carry the run just recorded.
    expect(summary.byDay.at(-1)?.fields?.runs).toBe(1);

    const clampedLow = await readMetricsSummary(journal, { days: 0 });
    expect(clampedLow.byDay).toHaveLength(1);
    const clampedHigh = await readMetricsSummary(journal, { days: 1000 });
    expect(clampedHigh.byDay).toHaveLength(90);
  });
});
