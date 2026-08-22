// A run must not spend its tool budget on work it did not do.
//
// `seedFromHistory` states the invariant in its own comment: it "MUST match recordToolOutcome's
// live-increment rule EXACTLY so a first-encounter seed reconstructs the SAME count". The live rule
// only ever fires from `writeToolTerminal`, so a cross-run DEDUP HIT — which returns from the journal
// without writing a terminal — increments nothing.
//
// Giving the deduping run a shadow record broke that. The shadow sits under `${runId}:tool:`, the seed
// counted it, and the two paths disagreed. Measured, two runs sharing one cross-run charge under
// `maxToolCalls: 1`:
//
//   with the shadow counted : runB executed ZERO tools and threw RunLimitExceededError
//   without                 : runB completed, having run its OTHER tool
//
// and it was order-dependent — the same run with the same work got a different budget depending on
// whether the dedup hit happened to be its first tool call.
//
// The seed now skips every shadow, keying off `mirrorOf` exactly as `compensateRun` does. The executing
// run's shadow is skipped too: its call was counted LIVE when it ran, and this scan only happens when
// the chain key is absent, which means limits were not in play then either. A narrower marker that
// distinguished the two shadows was written and then removed — three attempts to build a case where the
// executor's shadow needed to count (a later resume, a fork with limits added afterwards) all came out
// identical under both rules, and a schema field justified only by an unmeasured scenario is a liability.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { gnlTool } from '../src/types.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

function fixture() {
  const state = { charges: 0, looks: 0 };
  const charge = gnlTool({
    description: 'charge', inputSchema: z.object({ orderId: z.string() }),
    idempotency: 'args', idempotencyWindow: 'cross-run',
    execute: async () => { state.charges++; return { charged: 1 }; },
  } as never);
  const look = gnlTool({
    description: 'look', inputSchema: z.object({ q: z.string() }),
    execute: async () => { state.looks++; return { found: true }; },
  } as never);
  return { state, tools: { charge, look } };
}

/** Emits the two tool calls in the given order, then finishes. */
const model = (suffix: string, order: readonly ('charge' | 'look')[]) =>
  createMockModel(async ({ prompt }: never) => {
    const n = countToolResults(prompt as never);
    if (n >= order.length) return finalTextResult('done');
    const name = order[n]!;
    const args = name === 'charge' ? { orderId: 'o' } : { q: 'x' };
    return toolCallResult(name, `${name}-${suffix}`, args);
  });

describe('a cross-run dedup hit', () => {
  it('does not spend the deduping run\'s tool budget', async () => {
    const journal = new InMemoryJournal();
    const { state, tools } = fixture();
    const limits = { maxToolCalls: 1 };

    // runA really executes the charge, and legitimately spends its budget on it.
    await runDurable({ runId: 'runA', journal, model: model('A', ['charge', 'look']), tools, limits, prompt: 'go' } as never)
      .catch(() => {});
    expect(state.charges, 'runA did not execute the charge — the fixture is wrong').toBe(1);

    // runB's charge is served from the journal. It executed nothing, so its budget is untouched and
    // its OTHER tool must still run.
    state.looks = 0;
    await runDurable({ runId: 'runB', journal, model: model('B', ['charge', 'look']), tools, limits, prompt: 'go' } as never);

    expect(state.charges, 'the shared action ran twice').toBe(1);
    expect(state.looks, 'the deduping run lost its budget to a tool it never ran').toBe(1);
  });

  it('costs the same whichever order the model asks for', async () => {
    // The shadow was counted at seed time and the dedup hit returns before the tool gate, so the same
    // work landed on a different budget depending on which call came first.
    const budgetFor = async (order: readonly ('charge' | 'look')[]) => {
      const journal = new InMemoryJournal();
      const { state, tools } = fixture();
      await runDurable({ runId: 'seed', journal, model: model('S', ['charge', 'look']), tools, prompt: 'go' } as never);
      state.charges = 0; state.looks = 0;
      await runDurable({ runId: 'r', journal, model: model('R', order), tools, limits: { maxToolCalls: 1 }, prompt: 'go' } as never)
        .catch(() => {});
      return { ...state };
    };

    expect(await budgetFor(['charge', 'look'])).toEqual(await budgetFor(['look', 'charge']));
  });

  it('does not hand the executing run its budget back either', async () => {
    // The run that really executed the charge is charged for it LIVE, and a later encounter must not
    // undo that. Starting with NO limits and adding them afterwards is the shape that reaches the seed
    // at all — limits switched on for a deployment that already has runs.
    const journal = new InMemoryJournal();
    const { state, tools } = fixture();

    // Charge only, no limits: nothing writes a chain key, so the next encounter must seed.
    await runDurable({ runId: 'runA', journal, model: model('A', ['charge']), tools, prompt: 'go' } as never);
    expect([state.charges, state.looks], 'the unlimited run did not execute exactly the charge').toEqual([1, 0]);

    // Now with a budget of 1, asking for the same charge (replayed from the journal) and then a NEW
    // tool. The charge is already spent, so the new call must be refused.
    state.charges = 0;
    await runDurable({
      runId: 'runA', journal, model: model('A', ['charge', 'look']), tools,
      limits: { maxToolCalls: 1 }, prompt: 'go',
    } as never).catch(() => {});

    expect(state.charges, 'the shared action ran again').toBe(0);
    expect(state.looks, 'the seed forgot a tool this run had already executed, handing back its budget').toBe(0);
  });
});
