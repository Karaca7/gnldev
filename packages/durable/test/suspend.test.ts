import { describe, it, expect } from 'vitest';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';
import type { Guard } from '../src/guard.js';

function makeModel() {
  return createMockModel(async ({ prompt }: any) => {
    const done = countToolResults(prompt);
    if (done === 0) return toolCallResult('chargeCard', 'call-c', { amount: 5000 });
    return finalTextResult('Done.');
  });
}

function makeTools(counter: { charges: number }) {
  return {
    chargeCard: tool({
      description: 'charge',
      inputSchema: z.object({ amount: z.number() }),
      execute: async ({ amount }) => {
        counter.charges++;
        return { charged: amount };
      },
    }),
  };
}

// Charges above 1000 require human approval (inside a dedicated policy guard).
const bigChargeGuard: Guard = ({ toolName, args }) =>
  toolName === 'chargeCard' && (args as any).amount > 1000
    ? { action: 'require-approval', reason: 'large amount' }
    : { action: 'allow' };

describe('suspend/resume — human approval', () => {
  it('require-approval → suspend (charge=0) → approve → resume (charge=1)', async () => {
    const journal = new InMemoryJournal();
    const counter = { charges: 0 };

    // Run 1 — no approval → suspended
    const r1 = await runDurable({
      runId: 'o1',
      journal,
      model: makeModel(),
      tools: makeTools(counter),
      guard: bigChargeGuard,
      prompt: 'charge 5000',
      stopWhen: stepCountIs(6),
    });
    expect(counter.charges).toBe(0); // the tool did NOT run
    expect(r1.interrupts.length).toBe(1);
    expect(r1.interrupts[0].toolName).toBe('chargeCard');
    expect(r1.interrupts[0].toolCallId).toBe('call-c');

    // Resume — approved
    const r2 = await runDurable({
      runId: 'o1',
      journal,
      model: makeModel(),
      tools: makeTools(counter),
      guard: bigChargeGuard,
      approvals: { 'call-c': true },
      prompt: 'charge 5000',
      stopWhen: stepCountIs(6),
    });
    expect(counter.charges).toBe(1); // EXACTLY once after approval
    expect(r2.interrupts.length).toBe(0);
    expect(r2.text).toContain('Done');
  });

  it('if approval is denied (approvals=false) the tool does not run, the model sees the denial and continues', async () => {
    const journal = new InMemoryJournal();
    const counter = { charges: 0 };

    const r = await runDurable({
      runId: 'o2',
      journal,
      model: makeModel(),
      tools: makeTools(counter),
      guard: bigChargeGuard,
      approvals: { 'call-c': false },
      prompt: 'charge 5000',
      stopWhen: stepCountIs(6),
    });

    expect(counter.charges).toBe(0);
    expect(r.interrupts.length).toBe(0);
    expect(r.text).toContain('Done');
  });
});
