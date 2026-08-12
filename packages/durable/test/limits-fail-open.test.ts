// MaxCost/maxTokens/maxToolCalls/
// loopDetection can only be enforced on a store that implements `readRun` (JournalReader). A hand-written
// `Journal` with only get/put/putIfAbsent used to SILENTLY skip enforcement — the user thinks the run is
// capped, it is not. The fix: (a) a LOUD one-time console.warn naming exactly which protections are
// disabled; (b) an opt-in `limits.strict` that THROWS at the enforcement point instead of failing open.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { runDurable } from '../src/run.js';
import { createMockModel, finalTextResult } from './mock.js';
import type { Journal } from '../src/journal.js';

afterEach(() => vi.restoreAllMocks());

/** A minimal, VALID Journal: get/put/putIfAbsent only — deliberately NO `readRun` (that lives on the
 *  optional JournalReader). This is the "I brought my own journal" shape that limits cannot enforce. */
class NoReaderJournal implements Journal {
  private m = new Map<string, unknown>();
  async get<T = unknown>(key: string): Promise<T | undefined> { return this.m.get(key) as T | undefined; }
  async put(key: string, value: unknown): Promise<void> { this.m.set(key, value); }
  async putIfAbsent(key: string, value: unknown): Promise<boolean> {
    if (this.m.has(key)) return false;
    this.m.set(key, value);
    return true;
  }
}

const model = () => createMockModel(async () => finalTextResult('done'));
const opts = (journal: Journal, limits: any) => ({
  runId: 'r-c4', journal, model: model(), prompt: 'x', limits,
});

describe('C4 — limits on a journal without readRun', () => {
  it('default: run COMPLETES but a LOUD warn names the disabled protection (fail-open, unchanged behavior)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const journal = new NoReaderJournal();

    const res = await runDurable(opts(journal, { maxCostUsd: 5 }) as any);
    expect(res.text).toContain('done'); // did NOT break the run

    const hit = warn.mock.calls.find((c) => String(c[0]).includes('does not implement') && String(c[0]).includes('readRun'));
    expect(hit).toBeTruthy(); // the fail-open was LOUD
    expect(String(hit![0])).toContain('maxCostUsd'); // named exactly what is disabled
    expect(String(hit![0])).toContain('NOT ENFORCED');
  });

  it('strict: the SAME configuration THROWS at the enforcement point instead of silently allowing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const journal = new NoReaderJournal();

    await expect(runDurable(opts(journal, { maxCostUsd: 5, strict: true }) as any)).rejects.toThrow(/readRun/);
  });

  it('warns ONCE per store even across multiple runs (once-per-store WeakSet)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const journal = new NoReaderJournal();

    await runDurable({ runId: 'r-a', journal, model: model(), prompt: 'x', limits: { maxTokens: 100 } } as any);
    await runDurable({ runId: 'r-b', journal, model: model(), prompt: 'x', limits: { maxTokens: 100 } } as any);

    const hits = warn.mock.calls.filter((c) => String(c[0]).includes('does not implement') && String(c[0]).includes('readRun'));
    expect(hits.length).toBe(1); // exactly one warning for this store, not per-run/per-step spam
  });
});
