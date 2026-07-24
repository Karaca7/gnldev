// D4-retry (AUDIT-R2 follow-up): TURN-level retry-with-feedback ladder. A processor's
// processOutput/processOutputStep may throw ProcessorRetry to mean "this turn's output is unacceptable —
// give the model my feedback and try the WHOLE turn again" (runGenerateWithRetryLadder in run.ts).
// Honestly scoped: this is NOT step-level retry inside the AI SDK's own tool loop — see the doc there.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, runKeys } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { ProcessorRetry, RetryExhaustedByProcessorError } from '../src/processor.js';
import type { Processor } from '../src/processor.js';
import type { Memory } from '../src/memory.js';
import { createMockModel, finalTextResult } from './mock.js';

// A model that returns 'bad' on its first call, 'good' on every call after — captures every call's
// provider prompt so a test can assert the retry feedback actually reached the model.
function makeStrictnessModel() {
  let calls = 0;
  const prompts: any[][] = [];
  const model = createMockModel(async ({ prompt }: any) => {
    prompts.push(prompt);
    calls++;
    return calls === 1 ? finalTextResult('bad') : finalTextResult('good');
  });
  return { model, prompts: () => prompts, calls: () => calls };
}

const strictnessProcessor = (name = 'strictness', opts?: { maxRetries?: number }): Processor => ({
  name,
  processOutput: (output) => {
    if (output.text !== 'good') throw new ProcessorRetry('answer with exactly "good"', name, opts);
    return output;
  },
});

describe('retry-with-feedback ladder (D4-retry)', () => {
  it('retry appends feedback + the model sees it on attempt 2; the final output is attempt-2\'s', async () => {
    const journal = new InMemoryJournal();
    const { model, prompts, calls } = makeStrictnessModel();
    const r: any = await runDurable({
      runId: 'r-retry1', journal, model, prompt: 'go', processors: [strictnessProcessor()],
    });
    expect(r.text).toBe('good');
    expect(calls()).toBe(2);
    const secondPrompt = prompts()[1];
    const feedbackVisible = (secondPrompt ?? []).some((m: any) => {
      if (m?.role !== 'user') return false;
      const content = m.content;
      if (typeof content === 'string') return content.includes('answer with exactly');
      if (Array.isArray(content)) return content.some((p: any) => typeof p?.text === 'string' && p.text.includes('answer with exactly'));
      return false;
    });
    expect(feedbackVisible).toBe(true);
    // The journal keeps a record of the retry decision (exactly-once, replay-deterministic).
    const decision = await journal.get<any>(runKeys.proc('r-retry1', 'retry:0'));
    expect(decision?.v?.feedback).toBe('answer with exactly "good"');
    expect(decision?.v?.processor).toBe('strictness');
  });

  it('maxRetries exhaustion -> typed RetryExhaustedByProcessorError; memory is NOT appended', async () => {
    const journal = new InMemoryJournal();
    let calls = 0;
    const model = createMockModel(async () => { calls++; return finalTextResult('bad'); });
    const appended: any[] = [];
    const memory: Memory = {
      async getMessages() { return []; },
      async append(_threadId: string, messages: any[]) { appended.push(...messages); },
    };
    await expect(
      runDurable({
        runId: 'r-retry2', journal, model, prompt: 'go',
        processors: [strictnessProcessor('neverSatisfied')],
        memory, threadId: 'th-retry2',
      }),
    ).rejects.toThrow(RetryExhaustedByProcessorError);
    // default maxRetries=1: attempt 0 throws (retried once), attempt 1 throws again (exhausted) → 2 model calls.
    expect(calls).toBe(2);
    expect(appended.length).toBe(0);
  });

  it('replay determinism: re-running the SAME runId reproduces the retry sequence from the journal without re-calling the model', async () => {
    const journal = new InMemoryJournal();
    const { model, calls } = makeStrictnessModel();
    const proc = strictnessProcessor('strictness2');

    const r1: any = await runDurable({ runId: 'r-retry3', journal, model, prompt: 'go', processors: [proc] });
    expect(r1.text).toBe('good');
    expect(calls()).toBe(2);

    // "Resume": a second runDurable call with the SAME runId + journal + args (same idiom as
    // structured-output.test.ts's replay-determinism test) — every model step + the retry decision
    // replay from the journal; the live model is never called again.
    const r2: any = await runDurable({ runId: 'r-retry3', journal, model, prompt: 'go', processors: [proc] });
    expect(r2.text).toBe('good');
    expect(calls()).toBe(2); // unchanged — zero NEW model calls on replay
  });

  it('a run with no ProcessorRetry-throwing processor produces the SAME key set (modulo runId) as a run with no processors at all — zero new journal keys from the retry ladder', async () => {
    const journal = new InMemoryJournal();
    const baselineId = 'r-retry4-base';
    const withProcId = 'r-retry4-proc';
    await runDurable({ runId: baselineId, journal, model: createMockModel(async () => finalTextResult('ok')), prompt: 'go' });
    const legacy: Processor = { name: 'legacy', processInput: (i) => i, processOutput: (o) => o };
    await runDurable({
      runId: withProcId, journal, model: createMockModel(async () => finalTextResult('ok')), prompt: 'go',
      processors: [legacy],
    });

    const baseKeys = (await journal.listKeys!(`${baselineId}:`)).map((k) => k.slice(baselineId.length)).sort();
    const procKeys = (await journal.listKeys!(`${withProcId}:`)).map((k) => k.slice(withProcId.length)).sort();
    expect(procKeys).toEqual(baseKeys);
    expect(procKeys.some((k) => k.includes(':proc:retry:'))).toBe(false);
  });

  it('the hard global cap (3 retries/run) is enforced even when a processor declares a higher maxRetries', async () => {
    const journal = new InMemoryJournal();
    let calls = 0;
    const model = createMockModel(async () => { calls++; return finalTextResult('bad'); });
    const greedy = strictnessProcessor('greedy', { maxRetries: 10 });
    await expect(
      runDurable({ runId: 'r-retry5', journal, model, prompt: 'go', processors: [greedy] }),
    ).rejects.toThrow(RetryExhaustedByProcessorError);
    // 3 retries allowed by the global cap + the exhausting 4th attempt = 4 model calls.
    expect(calls).toBe(4);
    // Exactly 3 retry decisions were journaled (retry:0, retry:1, retry:2) — the 4th attempt never
    // gets a journaled decision because the global cap throws before durableProcessorStep is called.
    const r0 = await journal.get(runKeys.proc('r-retry5', 'retry:0'));
    const r1 = await journal.get(runKeys.proc('r-retry5', 'retry:1'));
    const r2 = await journal.get(runKeys.proc('r-retry5', 'retry:2'));
    const r3 = await journal.get(runKeys.proc('r-retry5', 'retry:3'));
    expect(r0).toBeDefined();
    expect(r1).toBeDefined();
    expect(r2).toBeDefined();
    expect(r3).toBeUndefined();
  });
});
