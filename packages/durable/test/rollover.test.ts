// rolloverRun — epoch rollover for a long-lived run (CORE-HARDENING §7.3 mitigation).
// What's tested: that context ACTUALLY carries over to the new epoch (verified from the model prompt),
// that the old journal is left untouched, idempotency (marker + seed claims), and carry application.
import { describe, it, expect } from 'vitest';
import { stepCountIs } from 'ai';
import { InMemoryJournal, runKeys } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { rolloverRun, rolloverKey } from '../src/rollover.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

/** Runs a short epoch with 1 tool call: work tool → final text. */
async function runEpoch(journal: InMemoryJournal, runId: string, finalText: string) {
  const model = createMockModel(async ({ prompt }: any) =>
    countToolResults(prompt) === 0 ? toolCallResult('work', `c-${runId}`, { q: 1 }) : finalTextResult(finalText),
  );
  const tools = { work: { execute: async () => ({ ok: true }) } };
  return runDurable({ runId, journal, model, tools, prompt: 'initial task', stopWhen: stepCountIs(4) } as any);
}

describe('rolloverRun', () => {
  it('rollover: context REACHES the new epoch\'s model; old journal untouched; new run writes its own journal', async () => {
    const journal = new InMemoryJournal();
    await runEpoch(journal, 'agent', 'epoch-1 done');
    const oldEntries = await journal.readRun('agent');

    const r = await rolloverRun(journal, 'agent');
    expect(r.newRunId).toBe('agent@2');
    expect(r.seededMessages).toBeGreaterThan(0);

    // New epoch: the model MUST SEE the carried-over history (including epoch-1's final text) in its prompt.
    let seenPrompt = '';
    const model2 = createMockModel(async ({ prompt }: any) => {
      seenPrompt = JSON.stringify(prompt);
      return finalTextResult('epoch-2 answer');
    });
    const res2 = await runDurable({
      runId: r.newRunId, journal, model: model2, messages: r.messages, stopWhen: stepCountIs(4),
    } as any);
    expect((res2 as any).text).toBe('epoch-2 answer');
    expect(seenPrompt).toContain('epoch-1 done'); // context carried over
    expect(seenPrompt).toContain('initial task'); // initial user message carried over too

    // Old journal stands EXACTLY as before (no deletion); new run wrote its own entries.
    expect(await journal.readRun('agent')).toEqual(oldEntries);
    expect((await journal.readRun('agent@2')).length).toBeGreaterThan(0);
  });

  it('idempotent: second call returns the SAME target, does NOT OVERWRITE the seed; even a different newRunId request honors the marker', async () => {
    const journal = new InMemoryJournal();
    await runEpoch(journal, 'agent', 'done');

    const r1 = await rolloverRun(journal, 'agent');
    const seedBefore = await journal.get(runKeys.input(r1.newRunId));

    const r2 = await rolloverRun(journal, 'agent'); // repeat
    const r3 = await rolloverRun(journal, 'agent', { newRunId: 'other-target' }); // different target request
    expect(r2.newRunId).toBe(r1.newRunId);
    expect(r3.newRunId).toBe(r1.newRunId); // marker won: the same old run CANNOT be handed off to two targets
    expect(await journal.get(runKeys.input(r1.newRunId))).toEqual(seedBefore); // seed was not overwritten
    expect(await journal.get(runKeys.input('other-target'))).toBeUndefined(); // second target was never seeded
    expect(await journal.get(rolloverKey('agent'))).toMatchObject({ to: r1.newRunId });
  });

  it('carry: messages to be carried can be summarized (frozen exactly once)', async () => {
    const journal = new InMemoryJournal();
    await runEpoch(journal, 'agent', 'long epoch done');

    let carryCalls = 0;
    const r = await rolloverRun(journal, 'agent', {
      carry: (msgs) => {
        carryCalls++;
        // Example summary: carry only a single summary message (LLM-summary pattern).
        return [{ role: 'user', content: `SUMMARY: previous epoch had ${msgs.length} messages` }];
      },
    });
    expect(r.seededMessages).toBe(1);
    expect(carryCalls).toBe(1);
    await rolloverRun(journal, 'agent'); // idempotent repeat → carry does NOT RE-RUN (seed is frozen)
    expect(carryCalls).toBe(1);

    // Summary message reaches the new epoch's model.
    let seenPrompt = '';
    const model2 = createMockModel(async ({ prompt }: any) => {
      seenPrompt = JSON.stringify(prompt);
      return finalTextResult('ok');
    });
    await runDurable({ runId: r.newRunId, journal, model: model2, messages: r.messages, stopWhen: stepCountIs(2) } as any);
    expect(seenPrompt).toContain('SUMMARY: previous epoch had');
  });

  it('chained rollover: agent@2 → agent@3 (existing @N is counted); unregistered run → clear error', async () => {
    const journal = new InMemoryJournal();
    await runEpoch(journal, 'agent', 'd1');
    const r1 = await rolloverRun(journal, 'agent');
    // Run epoch 2 and roll it over too.
    let seen = '';
    const model2 = createMockModel(async ({ prompt }: any) => { seen = JSON.stringify(prompt); return finalTextResult('d2 done'); });
    await runDurable({ runId: r1.newRunId, journal, model: model2, messages: r1.messages, stopWhen: stepCountIs(2) } as any);
    const r2 = await rolloverRun(journal, r1.newRunId);
    expect(r2.newRunId).toBe('agent@3');

    await expect(rolloverRun(journal, 'no-such-run')).rejects.toThrow(/no journal record/);
  });
});
