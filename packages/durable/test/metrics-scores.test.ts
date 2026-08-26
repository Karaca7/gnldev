// P2-skor (AUDIT-R2): "score trends into materialized metrics counters" — a SECOND,
// ADDITIVE incrBy pass (recordRunScores) onto the SAME day/agent/all counter keys recordRunMetrics
// writes to, fed by registry.ts's C4 scorer block (scores aren't available at recordRunMetrics's own
// call site — see recordRunScores's JSDoc in metrics.ts). Mirrors metrics.test.ts's style (InMemoryJournal
// + a stripped applyBatch-less stub for the sequential-fallback path) and registry-scorer-sampling.test.ts's
// mkGnl helper for the sampled-in/sampled-out integration coverage.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import type { Journal, JournalReader } from '../src/journal.js';
import { createGnl } from '../src/registry.js';
import { createMockModel, finalTextResult } from './mock.js';
import {
  recordRunScores, readMetricsSummary, metricsScoresDoneKey,
  METRICS_ALL_KEY, metricsDayKey, metricsAgentDayKey,
  recordRunMetrics, rebuildMetrics,
  readCounter,
} from '../src/metrics.js';
import { runKeys } from '../src/journal.js';

describe('metrics.ts — recordRunScores', () => {
  it('writes score:<name>:sumMilli/count/bucket onto the all-time counter on the first call; a second call is a no-op (no double count)', async () => {
    const journal = new InMemoryJournal();
    const first = await recordRunScores(journal, 'r1', 'support', { quality: { score: 0.8 } });
    expect(first).toBe(true);

    const all = await readCounter(journal, METRICS_ALL_KEY);
    expect(all?.['score:quality:sumMilli']).toBe(800);
    expect(all?.['score:quality:count']).toBe(1);
    expect(all?.['score:quality:gte75']).toBe(1);
    expect(all?.['score:quality:lt75'] ?? 0).toBe(0);

    const second = await recordRunScores(journal, 'r1', 'support', { quality: { score: 0.8 } });
    expect(second).toBe(false); // claim already held — no-op

    const allAfter = await readCounter(journal, METRICS_ALL_KEY);
    expect(allAfter?.['score:quality:sumMilli']).toBe(800); // unchanged — NOT double-counted
    expect(allAfter?.['score:quality:count']).toBe(1);
  });

  it('accepts a bare numeric score (not just { score }) — same field shape either way', async () => {
    const journal = new InMemoryJournal();
    await recordRunScores(journal, 'r-bare', undefined, { relevancy: 0.4 });
    const all = await readCounter(journal, METRICS_ALL_KEY);
    expect(all?.['score:relevancy:sumMilli']).toBe(400);
    expect(all?.['score:relevancy:count']).toBe(1);
    expect(all?.['score:relevancy:lt50']).toBe(1);
  });

  it('writes to day + per-agent-day counters too (same key schema as recordRunMetrics)', async () => {
    const journal = new InMemoryJournal();
    (journal as unknown as { now: () => Promise<number> }).now = async () => Date.UTC(2026, 0, 10);
    await recordRunScores(journal, 'r1', 'billing', { quality: { score: 0.9 } });

    const day = await readCounter(journal, metricsDayKey('2026-01-10'));
    expect(day?.['score:quality:sumMilli']).toBe(900);
    const agentDay = await readCounter(journal, metricsAgentDayKey('billing', '2026-01-10'));
    expect(agentDay?.['score:quality:count']).toBe(1);
  });

  it('scorer names are sanitized (":" -> "_") — same defensive posture as agent names', async () => {
    const journal = new InMemoryJournal();
    await recordRunScores(journal, 'r1', undefined, { 'weird:name': { score: 0.5 } });
    const all = await readCounter(journal, METRICS_ALL_KEY);
    expect(all?.['score:weird_name:count']).toBe(1);
  });

  it('non-numeric/NaN scores are silently skipped per-name; other scorers in the same call still record', async () => {
    const journal = new InMemoryJournal();
    const ok = await recordRunScores(journal, 'r1', undefined, {
      good: { score: 0.6 },
      bad: { score: NaN } as any,
      alsoBad: 'not-a-number' as any,
      missing: {} as any,
    });
    expect(ok).toBe(true); // the claim still lands — best-effort per-scorer skip, not a batch failure
    const all = await readCounter(journal, METRICS_ALL_KEY);
    expect(all?.['score:good:count']).toBe(1);
    expect(all?.['score:bad:count']).toBeUndefined();
    expect(all?.['score:alsoBad:count']).toBeUndefined();
    expect(all?.['score:missing:count']).toBeUndefined();
  });

  it('histogram buckets: exactly one of lt25/lt50/lt75/gte75 per (run, scorer)', async () => {
    const journal = new InMemoryJournal();
    await recordRunScores(journal, 'r-a', undefined, { s: { score: 0.1 } });
    await recordRunScores(journal, 'r-b', undefined, { s: { score: 0.3 } });
    await recordRunScores(journal, 'r-c', undefined, { s: { score: 0.6 } });
    await recordRunScores(journal, 'r-d', undefined, { s: { score: 0.99 } });

    const all = await readCounter(journal, METRICS_ALL_KEY);
    expect(all?.['score:s:lt25']).toBe(1);
    expect(all?.['score:s:lt50']).toBe(1);
    expect(all?.['score:s:lt75']).toBe(1);
    expect(all?.['score:s:gte75']).toBe(1);
    expect(all?.['score:s:count']).toBe(4);
  });

  it('exactly-once claim uses ITS OWN marker (metricsScoresDoneKey), distinct from recordRunMetrics\'s marker', async () => {
    const journal = new InMemoryJournal();
    await recordRunScores(journal, 'r1', undefined, { s: { score: 0.5 } });
    expect(await journal.get(metricsScoresDoneKey('r1'))).toBeDefined();
  });

  it('milli-integer accumulation across runs with DIFFERENT scorer sets: avg only reflects the runs that scored that name', async () => {
    const journal = new InMemoryJournal();
    await recordRunScores(journal, 'r1', undefined, { quality: { score: 0.8 }, relevancy: { score: 0.4 } });
    await recordRunScores(journal, 'r2', undefined, { quality: { score: 0.6 } }); // no relevancy this run

    const all = await readCounter(journal, METRICS_ALL_KEY);
    expect(all?.['score:quality:sumMilli']).toBe(1400); // 800 + 600
    expect(all?.['score:quality:count']).toBe(2);
    expect(all?.['score:relevancy:sumMilli']).toBe(400);
    expect(all?.['score:relevancy:count']).toBe(1); // only r1 contributed

    const summary = await readMetricsSummary(journal);
    expect(summary.all?.['score:quality:avg']).toBeCloseTo(0.7, 10); // 1.4/2
    expect(summary.all?.['score:relevancy:avg']).toBeCloseTo(0.4, 10); // 0.4/1
  });

  it('fallback: a journal without incrBy/putIfAbsent returns false and writes nothing', async () => {
    const bare: Journal = { get: async () => undefined, put: async () => {} };
    const ok = await recordRunScores(bare, 'r1', undefined, { s: { score: 0.5 } });
    expect(ok).toBe(false);
  });

  // applyBatch path: same "must not touch incrBy/putIfAbsent" style stub as metrics.test.ts's atomicity test.
  it('atomicity: recordRunScores uses applyBatch exclusively when available (never touches incrBy/putIfAbsent)', async () => {
    const real = new InMemoryJournal();
    const stub = {
      get: (k: string) => real.get(k),
      put: (k: string, v: unknown) => real.put(k, v),
      applyBatch: (b: Parameters<typeof real.applyBatch>[0]) => real.applyBatch(b),
      incrBy: async () => { throw new Error('sequential path must not be used when applyBatch exists'); },
      putIfAbsent: async () => { throw new Error('sequential path must not be used when applyBatch exists'); },
    } as unknown as Journal;

    const ok = await recordRunScores(stub, 'r1', undefined, { s: { score: 0.75 } });
    expect(ok).toBe(true);
    const all = await readCounter(real, METRICS_ALL_KEY);
    expect(all?.['score:s:count']).toBe(1);
    expect(all?.['score:s:gte75']).toBe(1);
  });

  // Sequential fallback (no applyBatch): a journal that implements incrBy/putIfAbsent but not applyBatch —
  // same claim-first ordering contract as recordRunMetrics's sequential path.
  it('sequential fallback (no applyBatch): claims then increments, and never double-claims on retry', async () => {
    const real = new InMemoryJournal();
    let incrByCalls = 0;
    const stub = {
      get: (k: string) => real.get(k),
      put: (k: string, v: unknown) => real.put(k, v),
      putIfAbsent: (k: string, v: unknown) => real.putIfAbsent(k, v),
      incrBy: async (k: string, fields: Record<string, number>) => { incrByCalls++; return real.incrBy(k, fields); },
    } as unknown as Journal;

    const ok = await recordRunScores(stub, 'r1', undefined, { s: { score: 0.5 } });
    expect(ok).toBe(true);
    expect(incrByCalls).toBe(2); // no agentName → 2 incrs entries (all + day), one incrBy call each
    const all = await readCounter(real, METRICS_ALL_KEY);
    expect(all?.['score:s:count']).toBe(1);

    const second = await recordRunScores(stub, 'r1', undefined, { s: { score: 0.5 } });
    expect(second).toBe(false); // already claimed — no-op, no double-claim
  });
});

describe('metrics.ts — score counters survive rebuildMetrics (P2-skor repair path, review finding)', () => {
  it('rebuildMetrics restores score aggregates from the journaled proc:eval records (exact values, no double count)', async () => {
    const journal = new InMemoryJournal();
    // Seed a completed run the way the engine does: a model record (so listRuns sees it) + the C4
    // memoization records durableProcessorStep writes ({v} shape under <runId>:proc:eval:<name>).
    await journal.put(runKeys.model('r-rb', 0), { content: [] });
    await journal.put(`r-rb:proc:eval:quality`, { v: { score: 0.8 } });
    await journal.put(`r-rb:proc:eval:tone`, { v: { score: 0.3 } });
    await recordRunMetrics(journal, journal, 'r-rb', { agentName: 'support' });
    await recordRunScores(journal, 'r-rb', 'support', { quality: { score: 0.8 }, tone: { score: 0.3 } });

    const before = await readCounter(journal, METRICS_ALL_KEY);
    expect(before?.['score:quality:sumMilli']).toBe(800);

    // Tamper + rebuild: the wipe removes the score fields (same counter keys) AND the scores claim —
    // backfill then re-derives them from the proc:eval journal records. Exact convergence, not additive drift.
    await journal.incrBy!(METRICS_ALL_KEY, { 'score:quality:sumMilli': 999_999 });
    const res = await rebuildMetrics(journal, journal);
    expect(res.scoresRestored).toBe(1);

    const after = await readCounter(journal, METRICS_ALL_KEY);
    expect(after?.['score:quality:sumMilli']).toBe(800); // tamper gone, exact value back
    expect(after?.['score:quality:count']).toBe(1);
    expect(after?.['score:tone:sumMilli']).toBe(300);
    expect(after?.['score:tone:lt50']).toBe(1);
    // A second rebuild converges to the same values (claims wiped+re-claimed, never double-added).
    await rebuildMetrics(journal, journal);
    const again = await readCounter(journal, METRICS_ALL_KEY);
    expect(again?.['score:quality:sumMilli']).toBe(800);
    expect(again?.['score:quality:count']).toBe(1);
  });

  it('backfillMetrics without listKeys support skips score restoration (base metrics still land)', async () => {
    const journal = new InMemoryJournal();
    await journal.put(runKeys.model('r-nl', 0), { content: [] });
    await journal.put(`r-nl:proc:eval:quality`, { v: { score: 0.5 } });
    // Strip listKeys: structural journal without the prefix-scan capability.
    const stripped: any = {
      get: journal.get.bind(journal), put: journal.put.bind(journal),
      putIfAbsent: journal.putIfAbsent.bind(journal), incrBy: journal.incrBy.bind(journal),
      getCounters: journal.getCounters.bind(journal), applyBatch: journal.applyBatch.bind(journal),
      listRuns: journal.listRuns.bind(journal), readRun: journal.readRun.bind(journal),
    };
    const { backfillMetrics } = await import('../src/metrics.js');
    const res = await backfillMetrics(stripped, stripped);
    expect(res.recorded).toBe(1); // base metrics landed
    expect(res.scoresRestored).toBe(0); // scores skipped — no listKeys, documented behavior
    const all = await readCounter(journal, METRICS_ALL_KEY);
    expect(all?.runs).toBe(1);
    expect(all?.['score:quality:sumMilli']).toBeUndefined();
  });
});

describe('metrics.ts — recordRunScores integration with registry.ts C4 scoring (sampling bias)', () => {
  function mkGnl(journal: InMemoryJournal, rate: number) {
    return createGnl({
      journal,
      agents: {
        a: {
          model: createMockModel(async () => finalTextResult('final answer')),
          scorers: [{ name: 'len', score: ({ output }) => ({ score: output.length > 0 ? 0.9 : 0 }) }],
          scorerSampling: { rate },
        },
      },
    });
  }

  it('sampled-out (rate=0): no scorers run, and recordRunScores contributes NOTHING to the counters', async () => {
    const journal = new InMemoryJournal();
    const gnl = mkGnl(journal, 0);
    const r: any = await gnl.run('a', { runId: 'sampled-out-1', prompt: 'x' });
    expect(r.scores).toBeUndefined();

    // Give any (incorrectly) fire-and-forget recordRunScores call a tick to land, then assert nothing did.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const all = await readCounter(journal, METRICS_ALL_KEY);
    expect(all?.['score:len:count'] ?? 0).toBe(0);
  });

  it('sampled-in (rate=1): scorers run and recordRunScores materializes the score:len:* counters', async () => {
    const journal = new InMemoryJournal();
    const gnl = mkGnl(journal, 1);
    const r: any = await gnl.run('a', { runId: 'sampled-in-1', prompt: 'x' });
    expect(r.scores.len.score).toBe(0.9);

    // recordRunScores is fired best-effort (`.catch(() => {})`, not awaited by run()) — give it a tick.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const all = await readCounter(journal, METRICS_ALL_KEY);
    expect(all?.['score:len:count']).toBe(1);
    expect(all?.['score:len:sumMilli']).toBe(900);
    expect(all?.['score:len:gte75']).toBe(1);

    const summary = await readMetricsSummary(journal);
    expect(summary.all?.['score:len:avg']).toBeCloseTo(0.9, 10);
  });

  it('per-agent counter carries the agent name ("a") for the sampled-in run', async () => {
    const journal = new InMemoryJournal();
    const gnl = mkGnl(journal, 1);
    await gnl.run('a', { runId: 'sampled-in-agent', prompt: 'x' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const today = new Date().toISOString().slice(0, 10);
    const agentDay = await readCounter(journal, metricsAgentDayKey('a', today));
    expect(agentDay?.['score:len:count']).toBe(1);
  });
});

describe('metrics.ts — readMetricsSummary score derivation edge cases', () => {
  it('no score:* fields present → no score:*:avg fields appear (no phantom scorers)', async () => {
    const journal = new InMemoryJournal();
    await journal.incrBy(METRICS_ALL_KEY, { runs: 1 });
    const summary = await readMetricsSummary(journal);
    expect(Object.keys(summary.all ?? {}).some((k) => k.endsWith(':avg'))).toBe(false);
  });

  it('a sumMilli field with count=0 (should not happen via recordRunScores) is not divided by zero', async () => {
    const journal = new InMemoryJournal();
    await journal.incrBy(METRICS_ALL_KEY, { 'score:orphan:sumMilli': 500 }); // no matching :count
    const summary = await readMetricsSummary(journal);
    expect(summary.all?.['score:orphan:avg']).toBeUndefined();
  });
});
