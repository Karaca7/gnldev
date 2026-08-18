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

// The approved turn must reach the conversation.
//
// runDurable appends a finished turn to memory only when `memory && threadId` are both present and the
// run did not suspend — so a suspended turn skips the append BY DESIGN, and the resume is where it is
// supposed to land. ResumeAgentConfig had no `memory` field at all, so it never did.
//
// The comment on the threadId line said as much and read it as harmless: "No memory is attached here,
// so this changes nothing else." It changed the one thing that cannot be recovered. Measured, same
// journal and same approval, one difference:
//
//   via resumeRun   -> thread ['user']
//   via runDurable  -> thread ['user','assistant','tool','assistant']
//
// A user asks for a charge, a human approves it, the charge goes through, the assistant says so — and
// the conversation remembers only the request. The next turn's model sees neither the charge nor the
// answer, which for a money-shaped tool is the setup for doing it again. This is the same class as the
// fields already listed on ResumeAgentConfig (limits, processors, lock, timeouts, schemaCompat,
// toolPolicy), each found the same way; this one lost DATA rather than protection.
describe('resume and conversation memory', () => {
  /** The smallest thing that satisfies the Memory contract's two used methods. */
  function fakeMemory() {
    const threads = new Map<string, { role: string }[]>();
    return {
      threads,
      memory: {
        getMessages: async (t: string) => threads.get(t) ?? [],
        append: async (t: string, msgs: { role: string }[]) => {
          threads.set(t, [...(threads.get(t) ?? []), ...msgs]);
        },
      },
    };
  }

  it('writes the approved turn into the thread', async () => {
    const journal = new InMemoryJournal();
    const counter = { charges: 0 };
    const { threads, memory } = fakeMemory();

    const first = await runDurable({
      runId: 'mem-1', journal, model: makeModel(), tools: makeTools(counter), guard,
      prompt: 'charge 5000', memory, threadId: 'th', stopWhen: stepCountIs(6),
    } as never);
    expect(first.interrupts).toHaveLength(1);
    // The suspended turn writes only the user's message — that half is intended.
    expect(threads.get('th')?.map((m) => m.role)).toEqual(['user']);

    await resumeRun('mem-1', {
      journal, model: makeModel(), tools: makeTools(counter), guard,
      approvals: { 'call-c': true }, memory,
    } as never);

    const roles = threads.get('th')?.map((m) => m.role) ?? [];
    expect(roles, 'the assistant\'s answer to an approved call never entered the thread').toContain('assistant');
  });

  it('a resume WITHOUT memory behaves exactly as before', async () => {
    // The forwarding is opt-in: nothing is attached that the caller did not pass, so a caller who
    // never used memory sees no new writes and no new failure mode.
    const journal = new InMemoryJournal();
    const counter = { charges: 0 };
    const { threads, memory } = fakeMemory();

    await runDurable({
      runId: 'mem-2', journal, model: makeModel(), tools: makeTools(counter), guard,
      prompt: 'charge 5000', memory, threadId: 'th', stopWhen: stepCountIs(6),
    } as never);
    await resumeRun('mem-2', {
      journal, model: makeModel(), tools: makeTools(counter), guard,
      approvals: { 'call-c': true },
    } as never);

    expect(threads.get('th')?.map((m) => m.role)).toEqual(['user']);
  });
});
