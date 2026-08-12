// At the repeat threshold the model
// first gets ONE "reconsider" nudge AS THE TOOL RESULT (the call is NOT executed, the run CONTINUES)
// — it can reuse the previous result, take a different action, or make a genuinely NEW call with
// distinguishing arguments. Only an IDENTICAL repeat AFTER the nudge falls back to the existing hard
// block (warn once → then stop; insistence is never auto-trusted for a side-effecting repeat).
// Default (`onRepeat` unset) stays byte-for-byte the old behavior — covered by run-limits.test.ts.
import { describe, it, expect } from 'vitest';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { ToolLoopDetectedError } from '../src/limits.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

/** Did the conversation already carry a reflection nudge back to the model? */
const sawNudge = (prompt: any[]) => JSON.stringify(prompt ?? []).includes('__gnl_reflected');

const makeStuck = (counter: { runs: number }) =>
  tool({
    description: 'tool that always does the same work',
    inputSchema: z.object({ orderId: z.string().optional() }),
    execute: async () => {
      counter.runs++;
      return { attempt: counter.runs };
    },
  });

describe('loop reflection (onRepeat: "reflect")', () => {
  it('at the threshold the call is NOT executed — a nudge is journaled as "reflected", the run CONTINUES and the model can finish', async () => {
    const journal = new InMemoryJournal();
    const counter = { runs: 0 };
    // The model repeats identical calls UNTIL it sees the nudge — then it self-corrects (final text).
    const model = createMockModel(async ({ prompt }: any) => {
      if (sawNudge(prompt)) return finalTextResult('Recovered.');
      const done = countToolResults(prompt);
      return toolCallResult('stuck', `call-${done + 1}`, {});
    });

    const res = await runDurable({
      runId: 'refl-1', journal, model, tools: { stuck: makeStuck(counter) },
      prompt: 'loop', stopWhen: stepCountIs(20),
      limits: { loopDetection: { maxRepeats: 2, onRepeat: 'reflect' } },
    });

    expect(res.text).toBe('Recovered.'); // the run did NOT stop — the nudge steered the model out
    expect(counter.runs).toBe(2); // the 3rd call was never executed
    const rec = await journal.get<any>('refl-1:tool:call-3');
    expect(rec).toMatchObject({ status: 'reflected' });
    expect(rec.output.__gnl_reflected).toBe(true);
    // Security-sensitive wording (see durable-tool.ts): the nudge must NOT teach argument fabrication.
    expect(rec.output.guidance).toContain('Do NOT invent or alter identifiers');
  });

  it('nudge IGNORED (identical repeat after the warning) → hard block: exactly ONE nudge, then ToolLoopDetectedError', async () => {
    const journal = new InMemoryJournal();
    const counter = { runs: 0 };
    // A genuine runaway: the model repeats identically no matter what it is told.
    const model = createMockModel(async ({ prompt }: any) => {
      const done = countToolResults(prompt);
      return toolCallResult('stuck', `call-${done + 1}`, {});
    });

    try {
      await runDurable({
        runId: 'refl-2', journal, model, tools: { stuck: makeStuck(counter) },
        prompt: 'loop', stopWhen: stepCountIs(20),
        limits: { loopDetection: { maxRepeats: 2, onRepeat: 'reflect' } },
      });
      throw new Error('expected error did not throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ToolLoopDetectedError);
      // The block message is honest about the ignored nudge (and detail carries the flag).
      expect((e as ToolLoopDetectedError).message).toContain('reconsider nudge');
      expect((e as ToolLoopDetectedError).detail).toMatchObject({ toolName: 'stuck', repeats: 2, maxRepeats: 2, reflected: true });
    }
    expect(counter.runs).toBe(2); // 2 real executions; nudge (3rd) and block (4th) never executed
    expect(await journal.get('refl-2:tool:call-3')).toMatchObject({ status: 'reflected' });
    expect(await journal.get('refl-2:tool:call-4')).toBeUndefined(); // the block sentinel writes NOTHING
  });

  it('nudge respected via DIFFERENT arguments (a genuinely new action) → executes normally, chain resets', async () => {
    const journal = new InMemoryJournal();
    const counter = { runs: 0 };
    const model = createMockModel(async ({ prompt }: any) => {
      const done = countToolResults(prompt);
      // After the nudge: a NEW action with distinguishing arguments (exactly what the guidance asks for).
      if (sawNudge(prompt)) {
        if (done === 3) return toolCallResult('stuck', 'call-4', { orderId: 'B' });
        return finalTextResult('Done.');
      }
      return toolCallResult('stuck', `call-${done + 1}`, { orderId: 'A' });
    });

    const res = await runDurable({
      runId: 'refl-3', journal, model, tools: { stuck: makeStuck(counter) },
      prompt: 'loop', stopWhen: stepCountIs(20),
      limits: { loopDetection: { maxRepeats: 2, onRepeat: 'reflect' } },
    });

    expect(res.text).toBe('Done.');
    expect(counter.runs).toBe(3); // A×2 executed, A's 3rd reflected, B executed
    expect(await journal.get('refl-3:tool:call-4')).toMatchObject({ status: 'succeeded' });
  });

  it('replay determinism: re-running the SAME runId replays the nudge from the journal — nothing re-executes', async () => {
    const journal = new InMemoryJournal();
    const counter = { runs: 0 };
    const model = () => createMockModel(async ({ prompt }: any) => {
      if (sawNudge(prompt)) return finalTextResult('Recovered.');
      const done = countToolResults(prompt);
      return toolCallResult('stuck', `call-${done + 1}`, {});
    });
    const limits = { loopDetection: { maxRepeats: 2, onRepeat: 'reflect' as const } };

    const first = await runDurable({
      runId: 'refl-4', journal, model: model(), tools: { stuck: makeStuck(counter) },
      prompt: 'loop', stopWhen: stepCountIs(20), limits,
    });
    expect(first.text).toBe('Recovered.');
    expect(counter.runs).toBe(2);

    // Replay: the reflected record is served from the journal (the gate is NOT re-evaluated against
    // the since-mutated chain) → the same text, and the tool still ran exactly twice in total.
    const again = await runDurable({
      runId: 'refl-4', journal, model: model(), tools: { stuck: makeStuck(counter) },
      prompt: 'loop', stopWhen: stepCountIs(20), limits,
    });
    expect(again.text).toBe('Recovered.');
    expect(counter.runs).toBe(2); // exactly-once held across the replay
    expect(await journal.get('refl-4:tool:call-3')).toMatchObject({ status: 'reflected' });
  });
});
