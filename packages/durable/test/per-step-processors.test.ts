// P2-step (AUDIT-R2 Dalga-2): per-step processor hooks — processInputStep (AI SDK
// prepareStep bridge: per-iteration transient overrides) + processOutputStep (onStepFinish bridge:
// observe + tripwire). The gap this closes: gnl processors ran ONCE per runDurable call; other frameworks' per-step processors run
// per-iteration inside the tool loop.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { tool } from 'ai';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { ProcessorTripwire } from '../src/processor.js';
import type { Processor } from '../src/processor.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

const toolThenText = () =>
  createMockModel(async ({ prompt }: any) =>
    countToolResults(prompt) === 0 ? toolCallResult('doWork', 'call-1', {}) : finalTextResult('done'));
const tools = {
  doWork: tool({ description: 'w', inputSchema: z.object({}), execute: async () => ({ ok: true }) }),
};

describe('per-step processor hooks (P2-step)', () => {
  it('processInputStep runs on EVERY model step (not once per run) and its transient override reaches the model', async () => {
    const journal = new InMemoryJournal();
    const seenSteps: number[] = [];
    const seenSystems: string[] = [];
    const proc: Processor = {
      name: 'stepTagger',
      processInputStep: ({ stepNumber }) => {
        seenSteps.push(stepNumber);
        return { system: `step-${stepNumber}` }; // transient per-step system override
      },
    };
    const model = createMockModel(async (opts: any) => {
      // AI SDK v2 provider prompt: the system override arrives as the leading system message.
      const sys = (opts.prompt ?? []).find((m: any) => m.role === 'system');
      seenSystems.push(typeof sys?.content === 'string' ? sys.content : JSON.stringify(sys?.content));
      return countToolResults(opts.prompt) === 0 ? toolCallResult('doWork', 'call-1', {}) : finalTextResult('done');
    });
    const r: any = await runDurable({ runId: 'r-ps1', journal, model, tools, prompt: 'go', processors: [proc] });
    expect(r.text).toBe('done');
    expect(seenSteps).toEqual([0, 1]); // two model steps → hook fired per step, with the step number
    expect(seenSystems[0]).toContain('step-0');
    expect(seenSystems[1]).toContain('step-1'); // the override CHANGED between steps — per-step, not per-run
  });

  it('the override is TRANSIENT: the journal keeps the true conversation (no override leakage into replay state)', async () => {
    const journal = new InMemoryJournal();
    const proc: Processor = { name: 'sys', processInputStep: () => ({ system: 'INJECTED-TRANSIENT' }) };
    await runDurable({ runId: 'r-ps2', journal, model: toolThenText(), tools, prompt: 'go', processors: [proc] });
    // The journaled input record must NOT carry the transient system override.
    const input = await journal.get<any>('r-ps2:input');
    expect(JSON.stringify(input)).not.toContain('INJECTED-TRANSIENT');
  });

  it('processOutputStep observes every step and a ProcessorTripwire between steps fails the run loudly', async () => {
    const journal = new InMemoryJournal();
    const observed: Array<{ n: number; finish?: string }> = [];
    const guard: Processor = {
      name: 'stepGuard',
      processOutputStep: ({ stepNumber, finishReason, toolCalls }) => {
        observed.push({ n: stepNumber, finish: finishReason });
        if ((toolCalls?.length ?? 0) > 0 && stepNumber >= 0) {
          // Block after observing the FIRST tool-calling step → the follow-up model step never runs.
          throw new ProcessorTripwire('tool step blocked by per-step guard', 'stepGuard');
        }
      },
    };
    await expect(
      runDurable({ runId: 'r-ps3', journal, model: toolThenText(), tools, prompt: 'go', processors: [guard] }),
    ).rejects.toThrow(/blocked by per-step guard/);
    expect(observed.length).toBe(1); // fired once, then the tripwire stopped the loop
  });

  it('no per-step hooks → prepareStep/onStepFinish never set (zero behavior change for existing processors)', async () => {
    const journal = new InMemoryJournal();
    const legacy: Processor = { name: 'legacy', processInput: (i) => i };
    const r: any = await runDurable({ runId: 'r-ps4', journal, model: toolThenText(), tools, prompt: 'go', processors: [legacy] });
    expect(r.text).toBe('done');
  });
});
