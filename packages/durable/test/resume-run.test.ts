import { describe, it, expect } from 'vitest';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable, resumeRun } from '../src/run.js';
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
const guard: Guard = ({ toolName, args }) =>
  toolName === 'chargeCard' && (args as any).amount > 1000 ? { action: 'require-approval' } : { action: 'allow' };

describe('resumeRun — self-contained (prompt from the journal)', () => {
  it('suspend → resumeRun(runId, {agent, approvals}) continues without a prompt', async () => {
    const journal = new InMemoryJournal();
    const counter = { charges: 0 };

    const r1 = await runDurable({
      runId: 'o1', journal, model: makeModel(), tools: makeTools(counter), guard,
      prompt: 'charge 5000', stopWhen: stepCountIs(6),
    });
    expect(counter.charges).toBe(0);
    expect(r1.interrupts.length).toBe(1);

    // the prompt is NOT given again — it's read from the journal
    const r2 = await resumeRun('o1', {
      journal, model: makeModel(), tools: makeTools(counter), guard,
      approvals: { 'call-c': true }, stopWhen: stepCountIs(6),
    });
    expect(counter.charges).toBe(1);
    expect(r2.text).toContain('Done');
  });

  it('meaningful error when there is no recorded input', async () => {
    const journal = new InMemoryJournal();
    await expect(resumeRun('none', { journal, model: makeModel() })).rejects.toThrow(/no recorded input/);
  });
});
