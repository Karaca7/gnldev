// §5.3 OPT-IN MODEL-STEP EXCLUSIVITY — docs/CORE-HARDENING.md §3 + §5.3.
//
// FINDING (multi-worker.test.ts §3.1(c)): without a run-level lock, if two workers concurrently
// resume the same run, the model's `doGenerate` can be called TWICE (not a side effect, but a token
// cost). This file verifies the opt-in `exclusiveModelStep` gate:
//   (a) opt-in ON + two concurrent runDurable calls (NO lock) → the loser gets RunBusyError; model
//       EXACTLY 1, tool side effect EXACTLY 1 (double token cost is closed off).
//   (b) opt-in ON + a STALE 'running' marker (owner crashed) → resume continues NORMALLY —
//       the fast crash-resume window is NOT BROKEN (boundary contrast: FRESH marker → RunBusyError).
//   (c) opt-in OFF → old behavior IDENTICAL (the exact same setup as §3.1(c): modelCalls >= 2,
//       tool still EXACTLY 1) — default unchanged.
import { describe, it, expect } from 'vitest';
import { stepCountIs } from 'ai';
import { InMemoryJournal, runKeys } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { RunBusyError } from '../src/errors.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── (a) Opt-in ON: two concurrent runDurable calls → one gets RunBusyError; model 1, tool 1 ───────
describe('§5.3(a) exclusiveModelStep ON — concurrent runDurable, NO lock', () => {
  it('the losing worker gets RunBusyError; doGenerate EXACTLY 1, tool side effect EXACTLY 1', async () => {
    const journal = new InMemoryJournal(); // shared backend
    let charges = 0;
    let modelCalls = 0;
    const tools = () => ({
      charge: {
        execute: async () => {
          charges++;
          await sleep(15);
          return { charged: 20 };
        },
      },
    });
    // Model is SLOW (30ms) → the loser reaches the step while the winner's 'running' claim is still FRESH (window open).
    const model = () =>
      createMockModel(async () => {
        modelCalls++;
        await sleep(30);
        return toolCallResult('charge', 'call-c', { amount: 20 });
      });
    // stepCountIs(1): the loop stops once the tool has run → the winner's TOTAL model call count is also 1;
    // this way the "EXACTLY 1" assertion measures exclusivity itself (no noise from the final-text step).
    const opts = () => ({
      runId: 'r-excl',
      journal,
      model: model(),
      tools: tools(),
      stopWhen: stepCountIs(1),
      prompt: 'x',
      exclusiveModelStep: {}, // opt-in ON (default ttlMs=30_000)
    });

    const settled = await Promise.allSettled([runDurable(opts() as any), runDurable(opts() as any)]);

    const busy = settled.filter(
      (s) => s.status === 'rejected' && (s as PromiseRejectedResult).reason instanceof RunBusyError,
    );
    expect(busy.length).toBe(1); // EXACTLY one loser — the exclusivity gate worked
    expect(settled.filter((s) => s.status === 'fulfilled').length).toBe(1); // the winner finished normally
    expect(modelCalls).toBe(1); // the >=2 from §3.1(c) drops to 1 here: NO double token cost
    expect(charges).toBe(1); // the exactly-once tool guarantee is preserved as-is
  });
});

// ── (b) Opt-in ON: STALE 'running' marker → resume NORMAL (crash-resume window preserved) ─────────
describe('§5.3(b) exclusiveModelStep ON — stale claim', () => {
  it('STALE running marker (owner crashed) → NO RunBusyError, resume continues normally', async () => {
    const journal = new InMemoryJournal();
    const runId = 'r-stale';
    // Crash simulation: step 0's claim stayed 'running' but startedAt is OLD (older than ttl=30s).
    await journal.put(runKeys.proc(runId, '__gnl_model_claim:0'), {
      status: 'running',
      startedAt: Date.now() - 60_000,
    });
    let modelCalls = 0;
    const model = createMockModel(async () => {
      modelCalls++;
      return finalTextResult('done');
    });

    const result = await runDurable({
      runId,
      journal,
      model,
      stopWhen: stepCountIs(3),
      prompt: 'x',
      exclusiveModelStep: {}, // ON — but marker is stale → existing behavior (continue)
    } as any);

    expect(result.text).toBe('done'); // resume was not broken
    expect(modelCalls).toBe(1); // the step ran normally (the double-call risk is a deliberate trade-off)
  });

  it('BOUNDARY CONTRAST: FRESH running marker → RunBusyError (another worker is processing that step)', async () => {
    const journal = new InMemoryJournal();
    const runId = 'r-fresh';
    await journal.put(runKeys.proc(runId, '__gnl_model_claim:0'), {
      status: 'running',
      startedAt: Date.now(), // FRESH — within the ttl window
    });
    let modelCalls = 0;
    const model = createMockModel(async () => {
      modelCalls++;
      return finalTextResult('done');
    });

    await expect(
      runDurable({ runId, journal, model, prompt: 'x', exclusiveModelStep: {} } as any),
    ).rejects.toBeInstanceOf(RunBusyError);
    expect(modelCalls).toBe(0); // model was NEVER called — no token cost incurred
  });

  it('ttlMs is customizable: a marker older than the ttl counts as stale → continues', async () => {
    const journal = new InMemoryJournal();
    const runId = 'r-ttl';
    // A 5s-old marker: would be FRESH with the default ttl (30s); with ttlMs=3000 it's STALE → should continue.
    await journal.put(runKeys.proc(runId, '__gnl_model_claim:0'), {
      status: 'running',
      startedAt: Date.now() - 5_000,
    });
    const model = createMockModel(async () => finalTextResult('done'));
    const result = await runDurable({
      runId,
      journal,
      model,
      prompt: 'x',
      exclusiveModelStep: { ttlMs: 3_000 },
    } as any);
    expect(result.text).toBe('done');
  });
});

// ── (c) Opt-in OFF: old behavior IDENTICAL — the §3.1(c) setup (multi-worker.test.ts) ─────────────
describe('§5.3(c) exclusiveModelStep OFF — old behavior unchanged', () => {
  it('NO lock + NO opt-in → tool EXACTLY 1 but model can be called TWICE (modelCalls >= 2)', async () => {
    const journal = new InMemoryJournal(); // shared backend
    let charges = 0;
    let modelCalls = 0;
    const tools = () => ({
      charge: {
        execute: async () => {
          charges++;
          await sleep(15);
          return { charged: 20 };
        },
      },
    });
    const model = () =>
      createMockModel(async ({ prompt }: any) => {
        modelCalls++;
        return countToolResults(prompt) === 0 ? toolCallResult('charge', 'call-c', { amount: 20 }) : finalTextResult('done');
      });
    const opts = () => ({ runId: 'r-nolock-off', journal, model: model(), tools: tools(), stopWhen: stepCountIs(6), prompt: 'x' });

    // The SAME setup as §3.1(c) (that test was NOT changed) — this proves the default is preserved here.
    await Promise.allSettled([runDurable(opts() as any), runDurable(opts() as any)]);

    expect(charges).toBe(1); // exactly-once tool guarantee (atomic per-tool claim)
    expect(modelCalls).toBeGreaterThanOrEqual(2); // NO hard exclusion — a deliberate default (fast resume)
  });
});
