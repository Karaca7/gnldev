// Rules that must hold on EVERY way into a run, not only on the entry point where they were first
// fixed. Each case here was found by taking a fix and trying the same input through a sibling path:
//
//  - 1562c8c6 made runDurable resolve a 'provider/model' string. streamDurable, same published type,
//    still died with "Cannot create proxy with a non-object as target".
//  - 5e3ba98c refused a runId ending in ':model'/':tool' at runDurable/resumeRun/streamDurable.
//    forkRun takes a caller-supplied destination id and wrote it straight into keys — `listRuns`
//    then showed a run named 'pipeline' that nothing ever wrote.
//  - resumeRun forwarded a hand-written list of options, and agentName was not on it, so a resumed
//    run never reached the per-agent metrics. That list had already dropped `lock` and the whole
//    protection set before (40e378f6); it is now a total classification checked by the compiler.
import { it, expect } from 'vitest';
import { InMemoryStorage } from '../src/in-memory-storage.js';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable, streamDurable, resumeRun } from '../src/run.js';
import { forkRun } from '../src/time-travel.js';
import { replayRun } from '../src/regression.js';
import { registerModelProvider } from '../src/model-router.js';
import { echoModel } from '../src/mock-model.js';
import { createMockModel, finalTextResult } from './mock.js';

registerModelProvider('entry-inv', () => echoModel() as any);
const runIds = async (j: any) => { const p = await j.listRuns(); return (p.items ?? p.runs ?? p).map((r: any) => r.runId); };

it('streamDurable resolves a string model id, like runDurable', async () => {
  let text = '';
  let err: unknown;
  try {
    const s: any = await streamDurable({ runId: 'ei-s1', journal: new InMemoryJournal(), model: 'entry-inv/x', prompt: 'hi' } as any);
    for await (const p of s.fullStream) {
      if (p.type === 'text-delta') text += p.text ?? '';
      if (p.type === 'error') err = p.error;
    }
  } catch (e) { err = e; }
  expect(err, 'the stream path died on the string half of ModelInput').toBeUndefined();
  expect(text).toContain('echo');
});

it('forkRun refuses a destination id that ends in a record boundary — no phantom run', async () => {
  const j = new InMemoryStorage().runs as any;
  await runDurable({ runId: 'ei-src', journal: j, model: echoModel(), prompt: 'hi' } as any);
  await expect(forkRun(j, 'ei-src', 1, 'pipeline:model')).rejects.toThrow(/model/);
  expect(await runIds(j), 'a run nobody wrote appeared in listRuns').not.toContain('pipeline');
});

it('replayRun (reference): the same destination id is already refused through runDurable', async () => {
  const j = new InMemoryStorage().runs as any;
  await runDurable({ runId: 'ei-src2', journal: j, model: echoModel(), prompt: 'hi' } as any);
  await expect(replayRun({ journal: j, runId: 'ei-src2', newRunId: 'pipeline:tool', model: echoModel() } as any)).rejects.toThrow();
  expect(await runIds(j)).not.toContain('pipeline');
});

it('resumeRun carries the frozen agent name, so per-agent metrics are recorded', async () => {
  const j = new InMemoryJournal();
  let n = 0;
  const model = createMockModel(async () => { if (n++ === 0) throw new Error('boom'); return finalTextResult('ok'); });
  await runDurable({ runId: 'ei-r', journal: j, model, prompt: 'hi', agentName: 'billing' } as any).catch(() => {});
  await resumeRun('ei-r', { journal: j, model } as any);
  const agentRows = [...(j as any).keys()].filter((k: string) => k.includes(':agent:billing'));
  expect(agentRows, 'a resumed run was missing from the per-agent metrics').not.toHaveLength(0);
});
