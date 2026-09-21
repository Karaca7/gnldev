// H8 — scale hardening: (a) atomic counters (hot-row + lost-update death),
// (b) sweepRuns indexed fast path, (c) replay-cache RAM guardrail.
import { describe, it, expect } from 'vitest';
import { stepCountIs } from 'ai';
import { InMemoryJournal, runKeys, USAGE_KEY, recordRunUsage, getOrgUsage, purgeRun, sweepRuns } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { runDurable } from '../src/run.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';
import { RedisStorage } from '../src/redis-storage.js';
import { makeFakeRedis } from './fake-redis.js';

describe('H8a — atomic counters (incrBy)', () => {
  it.each([
    ['InMemory', () => new InMemoryJournal() as any],
    ['Sqlite', () => new SqliteStorage(':memory:').runs as any],
    ['Redis(fake)', () => new RedisStorage({ client: makeFakeRedis() }).runs as any],
  ])('%s: 50 concurrent increments → NO lost update (exact total)', async (_n, mk) => {
    const j = mk();
    await Promise.all(
      Array.from({ length: 50 }, () => j.incrBy(USAGE_KEY, { runs: 1, tokens: 10, costUsd: 0.5 })),
    );
    const c = await j.getCounters(USAGE_KEY);
    expect(c).toEqual({ runs: 50, tokens: 500, costUsd: 25 }); // if it were get→put, there would be losses
  });

  it('recordRunUsage: marker FIRST (CAS) → two racing record attempts count as ONE; read sums legacy+counter', async () => {
    const j = new InMemoryJournal();
    // Migration scenario: legacy balance left over from an old deployment.
    await j.put(USAGE_KEY, { runs: 2, tokens: 100, costUsd: 1 });
    // A run's journal (1 model entry so its cost can be read).
    await j.put(runKeys.model('r1', 0), { usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 }, response: { modelId: 'mock' } });
    await Promise.all([recordRunUsage(j, 'r1'), recordRunUsage(j, 'r1')]); // race: only one marker wins
    const u = await getOrgUsage(j as any);
    expect(u.tokens).toBe(140); // 100 legacy + 40 counter — NO DOUBLE COUNTING
    // purge → negative atomic decrement; total goes back to legacy.
    await purgeRun(j, 'r1');
    const u2 = await getOrgUsage(j as any);
    expect(u2.tokens).toBe(100);
  });
});

describe('H8b — sweepRuns indexed fast path', () => {
  it('Sqlite: listStaleRuns finds stale runs without moving entries; suspended ones are kept; result matches legacy', async () => {
    const st = new SqliteStorage(':memory:');
    const j = st.runs as any;
    const now = 1_000_000;
    // 3 runs: old-completed, old-SUSPENDED, new-completed. Write directly to control created_at.
    // Each gets its `:input`, because a run has one — run.ts writes it unconditionally before the
    // first model call. sweepRuns now asks (isRealRun) before spending a prefix delete, so a fixture
    // without it describes a row no run ever wrote, which is the shape that must survive a sweep.
    for (const r of ['old-run', 'suspended-run', 'new-run']) await j.put(`${r}:input`, { _v: 2, prompt: 'x' });
    await j.put('old-run:model:0', { x: 1 });
    await j.put('suspended-run:tool:t1', { status: 'suspended', output: {} });
    await j.put('new-run:model:0', { x: 1 });
    // Manually adjust updated_at (SqliteStorage updates gnl_runs on put → push it into the past).
    (st as any).db.prepare('UPDATE gnl_runs SET updated_at = ? WHERE run_id IN (?, ?)').run(now - 10_000, 'old-run', 'suspended-run');
    (st as any).db.prepare('UPDATE gnl_runs SET updated_at = ? WHERE run_id = ?').run(now - 10, 'new-run');

    expect(await j.listStaleRuns(now - 1000)).toEqual(['old-run']); // suspended one filtered out
    expect((await j.listStaleRuns(now - 1000, { includeSuspended: true })).sort()).toEqual(['old-run', 'suspended-run'].sort());

    const res = await sweepRuns(j, { olderThanMs: 1000, now });
    expect(res.purged).toEqual(['old-run']);
    expect(await j.readRun('old-run')).toEqual([]);
    expect((await j.readRun('suspended-run')).length).toBe(1); // pending work is kept
    expect((await j.readRun('new-run')).length).toBe(1);
  });
});

describe('H8c — replay-cache RAM guardrail (readRunStats)', () => {
  /** Run with K tools; each tool output is `pad` length long → ledger size can be controlled. */
  async function runFat(j: any, runId: string, k: number, pad: number, counters: { model: number; tool: number }, maxBytes?: number) {
    const tools = { work: { idempotent: true, execute: async () => { counters.tool++; return { blob: 'x'.repeat(pad) }; } } };
    const model = createMockModel(async ({ prompt }: any) => {
      counters.model++;
      const done = countToolResults(prompt);
      return done < k ? toolCallResult('work', `c${done}`, { i: done }) : finalTextResult('done');
    });
    return runDurable({ runId, journal: j, model, tools, prompt: 'x', stopWhen: stepCountIs(k + 2), replayCacheMaxBytes: maxBytes } as any);
  }

  it('ledger ABOVE the threshold: bulk readRun is SKIPPED, replay is still correct via point-reads (LLM/tool does not run)', async () => {
    const inner = new InMemoryJournal();
    const stats = { readRun: 0, get: 0 };
    const j: any = {
      get: (k: string) => (stats.get++, inner.get(k)),
      put: (k: string, v: unknown) => inner.put(k, v),
      putIfAbsent: (k: string, v: unknown) => inner.putIfAbsent(k, v),
      listKeys: (p: string) => inner.listKeys(p),
      readRun: (r: string) => (stats.readRun++, inner.readRun(r)),
      readRunStats: (r: string) => inner.readRunStats(r),
      listRuns: () => inner.listRuns(),
    };
    const c = { model: 0, tool: 0 };
    await runFat(j, 'r', 4, 50_000, c); // ~200KB ledger

    stats.readRun = 0; stats.get = 0; c.model = 0; c.tool = 0;
    const res = await runFat(j, 'r', 4, 50_000, c, 100_000); // threshold 100KB < ledger
    expect((res as any).text).toBe('done');
    expect(stats.readRun).toBe(0); // 🔑 the giant ledger was NOT pulled into RAM in bulk
    expect(stats.get).toBeGreaterThan(4); // progressed via point-reads
    expect(c.model).toBe(0); // replay: the LLM was not invoked
    expect(c.tool).toBe(0); // side effect was not repeated
  });

  it('ledger BELOW the threshold: existing behavior unchanged (single bulk readRun)', async () => {
    const inner = new InMemoryJournal();
    const stats = { readRun: 0 };
    const j: any = {
      get: (k: string) => inner.get(k),
      put: (k: string, v: unknown) => inner.put(k, v),
      putIfAbsent: (k: string, v: unknown) => inner.putIfAbsent(k, v),
      listKeys: (p: string) => inner.listKeys(p),
      readRun: (r: string) => (stats.readRun++, inner.readRun(r)),
      readRunStats: (r: string) => inner.readRunStats(r),
      listRuns: () => inner.listRuns(),
    };
    const c = { model: 0, tool: 0 };
    await runFat(j, 'r', 3, 10, c);
    stats.readRun = 0; c.model = 0; c.tool = 0;
    await runFat(j, 'r', 3, 10, c);
    expect(stats.readRun).toBe(1); // small ledger: fast bulk path preserved
    expect(c.model).toBe(0);
  });

  it('Sqlite readRunStats: COUNT + SUM(LENGTH) measures correctly without moving data', async () => {
    const j = new SqliteStorage(':memory:').runs as any;
    await j.put('r:model:0', { blob: 'x'.repeat(1000) });
    await j.put('r:tool:t1', { status: 'succeeded', output: 'y'.repeat(500) });
    const st = await j.readRunStats('r');
    expect(st.entries).toBe(2);
    expect(st.bytes).toBeGreaterThan(1500); // including serialization overhead ≥ raw content
  });
});
