// GOREV (audit C5 — budget fails OPEN on a journal without `listRuns`): getOrgUsage returns zero usage
// when it can't list runs, so isBudgetExceeded is always false — a configured budget silently never fires.
// Mirror of C4: checkBudget now emits a LOUD one-time warn (once per store) naming the disabled cap.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { checkBudget, budgetsEnforceable, recordRunUsage } from '../src/budget.js';
import { InMemoryJournal, runKeys } from '../src/journal.js';
import type { Journal } from '../src/journal.js';

afterEach(() => vi.restoreAllMocks());

/** get/put only — deliberately NO `listRuns` (usage cannot be computed). */
class NoListRunsJournal implements Journal {
  private m = new Map<string, unknown>();
  async get<T = unknown>(key: string): Promise<T | undefined> { return this.m.get(key) as T | undefined; }
  async put(key: string, value: unknown): Promise<void> { this.m.set(key, value); }
  async putIfAbsent(key: string, value: unknown): Promise<boolean> {
    if (this.m.has(key)) return false;
    this.m.set(key, value);
    return true;
  }
}

const unenforceableWarns = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.filter((c) => String(c[0]).includes('does not implement `listRuns`'));

describe('C5 — budget on a journal without listRuns', () => {
  it('budgetsEnforceable is false and checkBudget WARNS while failing open (exceeded=false)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const j = new NoListRunsJournal();
    expect(budgetsEnforceable(j)).toBe(false);

    const check = await checkBudget(j, 'acme', { usdLimit: 1 });
    expect(check.exceeded).toBe(false); // fail-open: unchanged behavior
    expect(unenforceableWarns(warn)).toHaveLength(1); // but LOUD now
    expect(String(unenforceableWarns(warn)[0][0])).toContain('NOT ENFORCED');
  });

  it('does NOT warn when no budget is configured (zero-cost early exit, nothing to enforce)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const j = new NoListRunsJournal();
    const check = await checkBudget(j, 'acme'); // no journal budget, no fallback
    expect(check.exceeded).toBe(false);
    expect(unenforceableWarns(warn)).toHaveLength(0);
  });

  it('warns ONCE per store across multiple checks (once-per-store WeakSet)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const j = new NoListRunsJournal();
    await checkBudget(j, 'acme', { usdLimit: 1 });
    await checkBudget(j, 'acme', { usdLimit: 1 });
    expect(unenforceableWarns(warn)).toHaveLength(1);
  });
});

/** InMemoryJournal with `incrBy`/`getCounters` hidden → addUsage takes the non-atomic get→put fallback. */
function noIncrByJournal(inner: InMemoryJournal): any {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'incrBy' || prop === 'getCounters') return undefined;
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
    has(target, prop) {
      if (prop === 'incrBy' || prop === 'getCounters') return false;
      return Reflect.has(target, prop);
    },
  });
}

const casFallbackWarns = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.filter((c) => String(c[0]).includes('does not implement `incrBy`'));

describe('E3 — usage counter get→put fallback (no incrBy)', () => {
  it('recordRunUsage WARNS once when the journal lacks incrBy (non-atomic under-count risk)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const inner = new InMemoryJournal();
    await inner.put(runKeys.model('r1', 0), { usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 }, response: { modelId: 'mock' } });
    await inner.put(runKeys.model('r2', 0), { usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 }, response: { modelId: 'mock' } });
    const j = noIncrByJournal(inner);

    await recordRunUsage(j, 'r1');
    await recordRunUsage(j, 'r2');
    expect(casFallbackWarns(warn)).toHaveLength(1); // loud, once per store
    expect(String(casFallbackWarns(warn)[0][0])).toContain('UNDER-count');
  });
});
