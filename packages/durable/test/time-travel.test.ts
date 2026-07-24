// M3 — reconstructState (step-by-step state) + forkRun (prefix copy + LIVE from step N).
import { describe, it, expect } from 'vitest';
import { stepCountIs } from 'ai';
import { InMemoryJournal } from '../src/journal.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { runDurable, resumeRun } from '../src/run.js';
import { reconstructState, forkRun } from '../src/time-travel.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

describe('M3 reconstructState', () => {
  it('step-by-step message + pending; seed is prepended', async () => {
    const j = new InMemoryJournal();
    await j.put('r:model:0', { content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'pay', input: '{}' }], finishReason: 'tool-calls' });
    await j.put('r:tool:c1', { status: 'succeeded', output: { paid: true } });
    await j.put('r:model:1', { content: [{ type: 'text', text: 'done' }], finishReason: 'stop' });
    const entries = await j.readRun('r');

    const s1 = reconstructState(entries, 1);
    expect(s1.messages).toHaveLength(1);
    expect(s1.messages[0].role).toBe('assistant');
    expect(s1.pending).toEqual([{ toolCallId: 'c1', toolName: 'pay' }]); // tool has not resolved yet

    const s2 = reconstructState(entries, 2);
    expect(s2.messages).toHaveLength(2);
    expect(s2.messages[1].role).toBe('tool');
    expect(s2.pending).toHaveLength(0); // tool-result arrived → pending cleared

    const s3 = reconstructState(entries, 3, { prompt: 'pay' });
    expect(s3.messages[0]).toEqual({ role: 'user', content: 'pay' }); // seed at the front
    expect(s3.messages).toHaveLength(4); // user + assistant(tool-call) + tool + assistant(text)
  });
});

describe.each([
  ['InMemory', () => new InMemoryJournal()],
  ['Sqlite', () => new SqliteStorage(':memory:').runs],
])('M3 forkRun — %s', (_name, make) => {
  it('prefix is copied; runs LIVE from step N; prefix side-effect replay (no re-charge)', async () => {
    const journal = make() as any;
    const charges = { n: 0 };
    const tools = () => ({ charge: { execute: async () => ({ charged: (charges.n++, 20) }) } });
    const srcModel = () =>
      createMockModel(async ({ prompt }: any) =>
        countToolResults(prompt) === 0 ? toolCallResult('charge', 'call-c', { amount: 20 }) : finalTextResult('SRC-final'),
      );

    await runDurable({ runId: 'r', journal, model: srcModel(), tools: tools(), stopWhen: stepCountIs(6), prompt: 'x' });
    expect(charges.n).toBe(1);

    // Fork at step 1: model:0 + tool are copied, model:1 is NOT copied.
    const fork = await forkRun(journal, 'r', 1, 'fork1');
    expect(fork).toMatchObject({ newRunId: 'fork1', copiedModel: 1, copiedTool: 1 });
    expect(await journal.get('fork1:model:0')).toBeDefined();
    expect(await journal.get('fork1:tool:call-c')).toBeDefined();
    expect(await journal.get('fork1:model:1')).toBeUndefined();
    expect(await journal.get('fork1:input')).toBeDefined();

    // Resume the fork with DIFFERENT step-1 logic → tail runs live (FORK, not SRC), charge replay (no increase).
    const forkModel = () =>
      createMockModel(async ({ prompt }: any) =>
        countToolResults(prompt) === 0 ? toolCallResult('charge', 'call-c', { amount: 20 }) : finalTextResult('FORK-final'),
      );
    const r2 = await resumeRun('fork1', { journal, model: forkModel(), tools: tools(), stopWhen: stepCountIs(6) });
    expect(r2.text).toBe('FORK-final'); // step 1 ran LIVE (different from source)
    expect(charges.n).toBe(1); // step 0 (charge) replayed from the journal → did not run again
  });
});
