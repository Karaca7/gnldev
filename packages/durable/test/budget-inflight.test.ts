// C2: the tenant/org budget gate must account for IN-FLIGHT / SUSPENDED cost, otherwise many
// concurrent runs each pass the check (completed total = $0) and collectively blow past the cap
// before any of them completes. The counter (`__usage__`) accrues ONLY on completion, so once a
// counter exists the old fast-path default skipped the run scan and never saw in-flight cost.
import { describe, it, expect, vi } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { checkBudget, assertBudget, recordRunUsage, BudgetExceededError } from '../src/budget.js';

/** Write a model record with usage for a run (the shape getRunCost reads). */
async function seedRun(j: InMemoryJournal, key: string, tokens: number) {
  await j.put(key, { usage: { inputTokens: tokens / 2, outputTokens: tokens / 2, totalTokens: tokens } });
}

/** Make a run that has started + accrued cost but SUSPENDED (never completed → not in the counter). */
async function seedSuspended(j: InMemoryJournal, runId: string, tokens: number) {
  await seedRun(j, `${runId}:model:0`, tokens);
  await j.put(`${runId}:tool:c1`, { status: 'suspended', output: {} });
}

describe('C2: budget gate accounts for in-flight/suspended runs (no concurrent bypass)', () => {
  it('checkBudget rejects when in-flight cost pushes total over the cap, even though completed total is under it', async () => {
    const j = new InMemoryJournal();
    // A counter EXISTS (a prior completed run) → this is the state that triggered the fast-path hole.
    await seedRun(j, 'done:model:0', 10);
    await recordRunUsage(j, 'done'); // counter: 1 run, 10 tokens

    // Five runs start concurrently and SUSPEND — 20 tokens each = 100 in-flight tokens, none completed.
    for (let i = 0; i < 5; i++) await seedSuspended(j, `sus${i}`, 20);

    // Cap = 60 tokens. Completed total is only 10 (< 60) → the OLD fast path passed here.
    // Real live usage is 10 + 100 = 110 (> 60) → the gate MUST reject.
    const check = await checkBudget(j, undefined, { tokenLimit: 60 });
    expect(check.usage.tokens).toBe(110);
    expect(check.exceeded).toBe(true);
  });

  it('assertBudget throws BudgetExceededError once concurrent in-flight runs exceed the cap', async () => {
    const j = new InMemoryJournal();
    await seedRun(j, 'done:model:0', 10);
    await recordRunUsage(j, 'done');
    for (let i = 0; i < 5; i++) await seedSuspended(j, `sus${i}`, 20);

    await expect(assertBudget(j, { fallback: { tokenLimit: 60 } }))
      .rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('opt-out: strictSuspendedCost=false keeps the O(1) fast path (in-flight cost ignored, no run scan)', async () => {
    const j = new InMemoryJournal();
    await seedRun(j, 'done:model:0', 10);
    await recordRunUsage(j, 'done');
    for (let i = 0; i < 5; i++) await seedSuspended(j, `sus${i}`, 20);

    const listRunsSpy = vi.spyOn(j, 'listRuns');
    const check = await checkBudget(j, undefined, { tokenLimit: 60 }, undefined, false);
    expect(check.usage.tokens).toBe(10); // only the completed counter total
    expect(check.exceeded).toBe(false);
    expect(listRunsSpy).not.toHaveBeenCalled(); // fast path: no full scan
  });
});
