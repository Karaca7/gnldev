// KILLER DEMO: a payment tool + a crash mid-turn + resume → the card is charged ONLY ONCE.
// Contrast: the same scenario with plain generateText → the card is charged twice (the problem we solve).

import { describe, it, expect } from 'vitest';
import { generateText, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { countToolResults, toolCallResult, finalTextResult, createMockModel } from './mock.js';

// Model that decides based on conversation state: 0 tool results → call chargeCard; then final text.
// While `crash.active` is true, it crashes on the first turn after the charge (process-kill simulation).
function makeModel(crash: { active: boolean }) {
  return createMockModel(async ({ prompt }: any) => {
    const done = countToolResults(prompt);
    if (done === 0) return toolCallResult('chargeCard', 'call-charge', { amount: 20 });
    if (crash.active && done === 1) throw new Error('CRASH'); // crash AFTER the charge is MADE
    return finalTextResult('Charged $20.');
  });
}

function makeChargeTool(counter: { charges: number }) {
  return tool({
    description: 'Charge the customer\'s card',
    inputSchema: z.object({ amount: z.number() }),
    execute: async ({ amount }) => {
      counter.charges++;
      return { charged: amount };
    },
  });
}

describe('killer demo: NO double-charge after resume', () => {
  it('runDurable: crash → resume → exactly 1 charge', async () => {
    const journal = new InMemoryJournal();
    const counter = { charges: 0 };

    // Run 1 — the charge is made, then it crashes
    const crash = { active: true };
    await expect(
      runDurable({
        runId: 'order-1',
        journal,
        model: makeModel(crash),
        tools: { chargeCard: makeChargeTool(counter) },
        stopWhen: stepCountIs(6),
        prompt: 'charge $20',
      }),
    ).rejects.toThrow('CRASH');
    expect(counter.charges).toBe(1);

    // Run 2 — resume with the same runId + journal (no crash)
    crash.active = false;
    const res = await runDurable({
      runId: 'order-1',
      journal,
      model: makeModel(crash),
      tools: { chargeCard: makeChargeTool(counter) },
      stopWhen: stepCountIs(6),
      prompt: 'charge $20',
    });

    expect(counter.charges).toBe(1); // EXACTLY-ONCE: a single charge despite the crash+resume
    expect(res.text).toContain('Charged');
  });

  it('contrast: plain generateText double-charges', async () => {
    const counter = { charges: 0 };

    const crash = { active: true };
    await expect(
      generateText({
        model: makeModel(crash),
        tools: { chargeCard: makeChargeTool(counter) },
        stopWhen: stepCountIs(6),
        prompt: 'charge $20',
      }),
    ).rejects.toThrow('CRASH');

    crash.active = false;
    await generateText({
      model: makeModel(crash),
      tools: { chargeCard: makeChargeTool(counter) },
      stopWhen: stepCountIs(6),
      prompt: 'charge $20',
    });

    expect(counter.charges).toBe(2); // the problem we solve: resuming from scratch = double-charge
  });
});
