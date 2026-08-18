// Data-driven budget/quota: __budget__ keys live in the journal; checkBudget resolves the
// effective limit (journal > fallback), and exits early without computing usage if there's no limit (zero cost).
import { describe, it, expect, vi } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import {
  BUDGET_PRE, checkBudget, getOrgUsage, isBudgetExceeded, readBudget, assertBudget,
  BudgetExceededError, USAGE_KEY, usageCountedKey, recordRunUsage, createBoundedUsageCache,
  type UsageCostCache,
} from '../src/budget.js';
import { purgeRun } from '../src/retention.js';
import type { RunCost } from '../src/cost.js';

/** Write a model record with usage for an organization (the shape getRunCost reads). */
async function seedRun(j: InMemoryJournal, key: string, tokens: number) {
  await j.put(key, { usage: { inputTokens: tokens / 2, outputTokens: tokens / 2, totalTokens: tokens } });
}

describe('budget (journal-backed live quota)', () => {
  it('getOrgUsage aggregates isolated per organization; without an org it counts the root scope', async () => {
    const j = new InMemoryJournal();
    await seedRun(j, 'org:acme:r1:model:0', 100); // 'org:' storage prefix
    await seedRun(j, 'org:globex:r2:model:0', 40);
    await seedRun(j, 'r3:model:0', 7);

    expect((await getOrgUsage(j, 'acme')).tokens).toBe(100);
    expect((await getOrgUsage(j, 'globex')).tokens).toBe(40);
    // root view is the raw journal: its own run + prefixed organization keys
    expect((await getOrgUsage(j)).tokens).toBe(147);
  });

  it('readBudget: organization key > default; an empty limit object is ignored', async () => {
    const j = new InMemoryJournal();
    expect(await readBudget(j, 'acme')).toBeUndefined();

    await j.put(BUDGET_PRE + 'default', { tokenLimit: 50 });
    expect(await readBudget(j, 'acme')).toEqual({ tokenLimit: 50 });

    await j.put(BUDGET_PRE + 'acme', { tokenLimit: 200, usdLimit: 1 });
    expect(await readBudget(j, 'acme')).toEqual({ tokenLimit: 200, usdLimit: 1 });

    await j.put(BUDGET_PRE + 'acme', {}); // empty document → fall back to default
    expect(await readBudget(j, 'acme')).toEqual({ tokenLimit: 50 });
  });

  it('checkBudget: without a limit exceeded=false (usage isn\'t computed); a journal limit overrides the fallback', async () => {
    const j = new InMemoryJournal();
    await seedRun(j, 'org:acme:r1:model:0', 100);

    expect((await checkBudget(j, 'acme')).exceeded).toBe(false);

    // fallback limit (host config) is exceeded
    const viaFallback = await checkBudget(j, 'acme', { tokenLimit: 60 });
    expect(viaFallback.exceeded).toBe(true);
    expect(viaFallback.usage.tokens).toBe(100);

    // write a higher limit to the journal → overrides the fallback, no longer exceeded
    await j.put(BUDGET_PRE + 'acme', { tokenLimit: 1000 });
    expect((await checkBudget(j, 'acme', { tokenLimit: 60 })).exceeded).toBe(false);
  });

  it('isBudgetExceeded: true if EITHER the usd OR the token limit is exceeded', () => {
    const usage = { runs: 1, tokens: 100, costUsd: 0.5 };
    expect(isBudgetExceeded(usage, undefined)).toBe(false);
    expect(isBudgetExceeded(usage, { tokenLimit: 100 })).toBe(false); // equal = not exceeded
    expect(isBudgetExceeded(usage, { tokenLimit: 99 })).toBe(true);
    expect(isBudgetExceeded(usage, { usdLimit: 0.4 })).toBe(true);
    expect(isBudgetExceeded(usage, { usdLimit: 1, tokenLimit: 99 })).toBe(true);
  });

  it('F10: assertBudget is shareable across non-HTTP paths — throws BudgetExceededError when exceeded', async () => {
    const j = new InMemoryJournal();
    await seedRun(j, 'org:acme:r1:model:0', 100);

    // Under the limit → doesn't throw, returns the check.
    const ok = await assertBudget(j, { orgId: 'acme', fallback: { tokenLimit: 200 } });
    expect(ok.exceeded).toBe(false);

    // When exceeded, BudgetExceededError (with the check payload) → queue/scheduler/a2a can convert it to their own error flow.
    await expect(assertBudget(j, { orgId: 'acme', fallback: { tokenLimit: 60 } }))
      .rejects.toBeInstanceOf(BudgetExceededError);
    try {
      await assertBudget(j, { orgId: 'acme', fallback: { tokenLimit: 60 } });
    } catch (e) {
      expect((e as BudgetExceededError).check.usage.tokens).toBe(100);
      expect((e as BudgetExceededError).check.limit).toEqual({ tokenLimit: 60 });
    }

    // Without a limit it passes at zero cost.
    expect((await assertBudget(j, { orgId: 'acme' })).exceeded).toBe(false);
  });

  it('F9: costCache memoizes the cost of a completed run (no repeated readRun)', async () => {
    const j = new InMemoryJournal();
    await seedRun(j, 'r1:model:0', 30);
    const cache: UsageCostCache = new Map();

    const u1 = await getOrgUsage(j, undefined, cache);
    expect(u1.tokens).toBe(30);
    // completed run got cached (InMemoryJournal's listRuns reports status 'completed').
    expect(cache.size).toBe(1);
    const cached = [...cache.values()][0] as RunCost;
    expect(cached.totalTokens).toBe(30);

    // The second call collects the same result from the cache.
    const u2 = await getOrgUsage(j, undefined, cache);
    expect(u2.tokens).toBe(30);
  });

  // ── 1.1: incremental usage counter ──────────────────────────────────────────
  describe('1.1: incremental usage counter (__usage__)', () => {
    it('recordRunUsage exactly-once — the same runId is not counted twice; getOrgUsage reads from the counter (fast path)', async () => {
      const j = new InMemoryJournal();
      await seedRun(j, 'r1:model:0', 100);

      await recordRunUsage(j, 'r1');
      expect(await j.getCounters(USAGE_KEY)).toEqual({ runs: 1, tokens: 100, costUsd: 0 }); // H8a: in the atomic counter
      expect(await j.get(usageCountedKey('r1'))).toBe(true);

      // Second call: the marker already exists → no-op (no double counting).
      await recordRunUsage(j, 'r1');
      expect(await j.getCounters(USAGE_KEY)).toEqual({ runs: 1, tokens: 100, costUsd: 0 }); // H8a: in the atomic counter

      // getOrgUsage now reads from the counter (without touching readRun at all) — same result.
      expect(await getOrgUsage(j)).toEqual({ runs: 1, tokens: 100, costUsd: 0 });
    });

    it('getOrgUsage does a full scan when there\'s no counter AND fills the counter + markers via lazy backfill', async () => {
      const j = new InMemoryJournal();
      await seedRun(j, 'org:acme:r1:model:0', 60);
      await seedRun(j, 'org:acme:r2:model:0', 40);

      expect(await j.get('org:acme:' + USAGE_KEY)).toBeUndefined(); // no counter yet

      const u1 = await getOrgUsage(j, 'acme');
      expect(u1).toEqual({ runs: 2, tokens: 100, costUsd: 0 });

      // Backfill: the counter must be filled + every completed run must be marked.
      expect(await j.get('org:acme:' + USAGE_KEY)).toEqual({ runs: 2, tokens: 100, costUsd: 0 });
      expect(await j.get('org:acme:' + usageCountedKey('r1'))).toBe(true);
      expect(await j.get('org:acme:' + usageCountedKey('r2'))).toBe(true);

      // The second call now takes the FAST PATH (from the counter) — same result, no full scan needed again.
      const u2 = await getOrgUsage(j, 'acme');
      expect(u2).toEqual({ runs: 2, tokens: 100, costUsd: 0 });
    });

    it('with a counter present, a suspended run is computed live and added in; it is not included in the counter (no double counting)', async () => {
      const j = new InMemoryJournal();
      await seedRun(j, 'r1:model:0', 50);
      await recordRunUsage(j, 'r1'); // r1 is completed → enters the counter

      // r2 is suspended (has a suspended tool) — not yet completed.
      await j.put('r2:model:0', { usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } });
      await j.put('r2:tool:c1', { status: 'suspended', output: {} });

      const u = await getOrgUsage(j);
      expect(u).toEqual({ runs: 2, tokens: 70, costUsd: 0 }); // 50 (counter) + 20 (live, suspended)

      // r2 has NOT YET entered the counter (no marker); the counter itself still contains only r1.
      expect(await j.get(usageCountedKey('r2'))).toBeUndefined();
      expect(await j.getCounters(USAGE_KEY)).toEqual({ runs: 1, tokens: 50, costUsd: 0 }); // H8a

      // r2 ACTUALLY completes (the suspended tool is now 'succeeded' — post-resume state) →
      // recordRunUsage adds it to the counter; the total stays CORRECT (no double counting, no longer 'suspended').
      await j.put('r2:tool:c1', { status: 'succeeded', output: 1 });
      await recordRunUsage(j, 'r2');
      expect(await getOrgUsage(j)).toEqual({ runs: 2, tokens: 70, costUsd: 0 });
    });

    // ── Scale opt-out: checkBudget can skip the full scan (O(1)) when a host opts out of C2 strictness ──
    it('checkBudget: strictSuspendedCost=false (opt-out) uses the counter fast path — listRuns/listAllRuns is NEVER called (O(1))', async () => {
      const j = new InMemoryJournal();
      await seedRun(j, 'r1:model:0', 100);
      await recordRunUsage(j, 'r1'); // fill the counter

      const listRunsSpy = vi.spyOn(j, 'listRuns');

      const check = await checkBudget(j, undefined, { tokenLimit: 1000 }, undefined, false);
      expect(check.exceeded).toBe(false);
      expect(check.usage).toEqual({ runs: 1, tokens: 100, costUsd: 0 });
      expect(listRunsSpy).not.toHaveBeenCalled(); // opt-out fast path: NO full scan

      // The exceeded behavior is also correct (identical to the existing tests): compared via the counter.
      const exceeded = await checkBudget(j, undefined, { tokenLimit: 50 }, undefined, false);
      expect(exceeded.exceeded).toBe(true);
      expect(exceeded.usage).toEqual({ runs: 1, tokens: 100, costUsd: 0 });
      expect(listRunsSpy).not.toHaveBeenCalled();
    });

    it('checkBudget: default (audit C2) includes a suspended run\'s live cost; opt-out excludes it', async () => {
      const j = new InMemoryJournal();
      await seedRun(j, 'r1:model:0', 50);
      await recordRunUsage(j, 'r1'); // counter: 50 tokens
      await j.put('r2:model:0', { usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } });
      await j.put('r2:tool:c1', { status: 'suspended', output: {} }); // r2 is suspended, hasn't entered the counter

      // Default (C2): the full scan tops up the counter with suspended r2's live cost → in-flight is gated.
      const strict = await checkBudget(j, undefined, { tokenLimit: 1000 });
      expect(strict.usage).toEqual({ runs: 2, tokens: 70, costUsd: 0 });

      // Opt-out (fast path): only the completed run in the counter — suspended r2 is NOT included.
      const fast = await checkBudget(j, undefined, { tokenLimit: 1000 }, undefined, false);
      expect(fast.usage).toEqual({ runs: 1, tokens: 50, costUsd: 0 });
    });

    it('purgeRun: the cost of a deleted run is subtracted from the counter (H4: no staleness after purge)', async () => {
      const j = new InMemoryJournal();
      await seedRun(j, 'r1:model:0', 100);
      await seedRun(j, 'r2:model:0', 40);
      await recordRunUsage(j, 'r1');
      await recordRunUsage(j, 'r2');
      expect(await getOrgUsage(j)).toEqual({ runs: 2, tokens: 140, costUsd: 0 });

      await purgeRun(j, 'r1');

      const after = await getOrgUsage(j);
      expect(after).toEqual({ runs: 1, tokens: 40, costUsd: 0 }); // only r2 remains
      expect(await j.getCounters(USAGE_KEY)).toEqual({ runs: 1, tokens: 40, costUsd: 0 }); // H8a
    });

    it('purgeRun: does not mistakenly subtract a never-counted (suspended/old) run from the counter', async () => {
      const j = new InMemoryJournal();
      await seedRun(j, 'r1:model:0', 100);
      await recordRunUsage(j, 'r1');
      // r2 never saw recordRunUsage (no marker) — it must still be deletable without corrupting the counter.
      await j.put('r2:model:0', { usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } });

      await purgeRun(j, 'r2');

      expect(await j.getCounters(USAGE_KEY)).toEqual({ runs: 1, tokens: 100, costUsd: 0 }); // H8a: in the atomic counter
    });

    it('createBoundedUsageCache: LRU bound — the oldest entry is evicted once full (safety net)', () => {
      const cache = createBoundedUsageCache(2);
      const rc = (n: number): RunCost => ({
        runId: `r${n}`, inputTokens: n, outputTokens: 0, cachedTokens: 0, totalTokens: n,
        modelCalls: 1, toolCalls: 0, costUsd: 0, byModel: {},
      });
      cache.set('a', rc(1));
      cache.set('b', rc(2));
      cache.set('c', rc(3)); // 'a' should be evicted (oldest)
      expect(cache.has('a')).toBe(false);
      expect(cache.has('b')).toBe(true);
      expect(cache.has('c')).toBe(true);
      expect(cache.size).toBe(2);
    });
  });
});

// The price table is read ONCE per scan, not once per run.
//
// getRunCost resolves the `__pricing__` document itself when no `pricing` option is given — correct for
// a single call, and a per-run round trip inside a loop. Measured on the full-scan path before the fix:
//
//   20 runs  -> 41 gets,  20 of them `__pricing__`
//   200 runs -> 401 gets, 200 of them `__pricing__`   (49.9% of every read)
//
// for a document that cannot change between two iterations of the same loop. On local SQLite each get
// is 142-383 µs; on Postgres it is one network round trip per run. Reading it once is also the more
// consistent answer — one scan should price against one table rather than against whatever the
// document happened to be at each step.
//
// Asserted as a READ COUNT rather than a duration: a timing assertion on a loop this small measures
// the machine, and the thing that regressed here is a call shape, which counting sees exactly.
describe('getOrgUsage and the price table', () => {
  /** Wraps a journal so every get is counted, without changing any behaviour. */
  function counting(journal: InMemoryJournal) {
    const counts = { get: 0, pricing: 0 };
    const proxy = new Proxy(journal, {
      get(target: any, prop) {
        if (prop === 'get') {
          return async (key: string) => {
            counts.get++;
            if (String(key).includes('__pricing__')) counts.pricing++;
            return target.get(key);
          };
        }
        const v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    return { counts, proxy: proxy as unknown as InMemoryJournal };
  }

  async function seedCompleted(j: InMemoryJournal, n: number) {
    for (let i = 0; i < n; i++) {
      await j.put(`pr${i}:input`, { prompt: 'x' });
      await j.put(`pr${i}:model:0`, {
        usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 },
        response: { modelId: 'gpt-4o' }, finishReason: 'stop',
      });
      await j.put(`pr${i}:outcome`, { status: 'completed', at: 1 });
    }
  }

  it('reads __pricing__ once for a whole full scan, however many runs it covers', async () => {
    const journal = new InMemoryJournal();
    await seedCompleted(journal, 40);
    const { counts, proxy } = counting(journal);

    await getOrgUsage(proxy, undefined);

    expect(counts.pricing, 'the price document was fetched once per run').toBe(1);
    // And the saving is the bulk of the scan, not a rounding difference.
    expect(counts.get).toBeLessThan(60);
  });

  it('still reports the same usage it did before', async () => {
    // The point of reading once is that the answer does not change. 40 runs x (100 in @ $2.50/1M +
    // 100 out @ $10/1M) = 40 x $0.00125.
    const journal = new InMemoryJournal();
    await seedCompleted(journal, 40);

    const usage = await getOrgUsage(journal, undefined);
    expect(usage.runs).toBe(40);
    expect(usage.tokens).toBe(40 * 200);
    expect(usage.costUsd).toBeCloseTo(40 * 0.00125, 10);
  });

  it('the counter fast path does not read the table at all', async () => {
    // The resolve is lazy on purpose: the O(1) path returns before any loop, and making it pay for a
    // table it never uses would trade a loop cost for a cost on every single budget check.
    const journal = new InMemoryJournal();
    await journal.put(USAGE_KEY, { runs: 3, tokens: 300, costUsd: 0.5 });
    const { counts, proxy } = counting(journal);

    const usage = await getOrgUsage(proxy, undefined, undefined, false);
    expect(usage.costUsd).toBe(0.5);
    expect(counts.pricing, 'the O(1) counter path resolved a price table it never used').toBe(0);
  });
});
