// W2 — Replay-based regression core: diffRuns (decision-point alignment) + replayRun
// (independent fresh run) + regressionReport (thin wrapper). Using InMemoryJournal.
import { describe, it, expect } from 'vitest';
import { stepCountIs } from 'ai';
import { InMemoryJournal, runKeys } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { diffRuns, replayRun, regressionReport } from '../src/regression.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

function makeModel(amount: number, finalText: string) {
  return createMockModel(async ({ prompt }: any) =>
    countToolResults(prompt) === 0 ? toolCallResult('charge', 'call-c', { amount }) : finalTextResult(finalText),
  );
}

function makeTools(counter: { n: number }) {
  return { charge: { execute: async ({ amount }: any) => ({ charged: (counter.n++, amount) }) } };
}

describe('W2 regression — replayRun', () => {
  it('throws a meaningful error when there is no recorded input', async () => {
    const journal = new InMemoryJournal();
    await expect(
      replayRun({ journal, runId: 'missing-run', model: makeModel(20, 'x') }),
    ).rejects.toThrow(/no recorded input/);
  });

  it('does not touch the original run\'s journal records; performs an independent fresh run', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    await runDurable({
      runId: 'base', journal, model: makeModel(20, 'Done A'), tools: makeTools(counter),
      stopWhen: stepCountIs(6), prompt: 'x',
    });
    expect(counter.n).toBe(1);
    const baseModel0Before = await journal.get(runKeys.model('base', 0));

    const { newRunId, result } = await replayRun({
      journal, runId: 'base', model: makeModel(20, 'Done A'), tools: makeTools(counter), stopWhen: stepCountIs(6),
    });

    expect(newRunId).not.toBe('base');
    expect(result.text).toBe('Done A');
    expect(counter.n).toBe(2); // independent run → tool ACTUALLY ran again (not replay/skip)
    expect(await journal.get(runKeys.model('base', 0))).toEqual(baseModel0Before); // original untouched
    expect(await journal.get(runKeys.model(newRunId, 0))).toBeDefined(); // written under the new runId
  });
});

describe('W2 regression — diffRuns', () => {
  it('replay with the same mock model -> diff is all same, no divergentAt', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    await runDurable({
      runId: 'base', journal, model: makeModel(20, 'Done A'), tools: makeTools(counter),
      stopWhen: stepCountIs(6), prompt: 'x',
    });

    const { newRunId } = await replayRun({
      journal, runId: 'base', model: makeModel(20, 'Done A'), tools: makeTools(counter), stopWhen: stepCountIs(6),
    });

    const diff = await diffRuns(journal, 'base', newRunId);
    expect(diff.divergentAt).toBeUndefined();
    expect(diff.summary).toEqual({ same: 3, changed: 0, missing: 0, added: 0 }); // model:0(tool-call) + tool:0 + model:1(final)
    expect(diff.steps.every((s) => s.durum === 'same')).toBe(true);
    expect(diff.steps.map((s) => s.kind)).toEqual(['model', 'tool', 'model']);
  });

  it('modified mock model (different tool args + different text) -> divergentAt correct, all steps changed', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    await runDurable({
      runId: 'base2', journal, model: makeModel(20, 'Done A'), tools: makeTools(counter),
      stopWhen: stepCountIs(6), prompt: 'x',
    });

    const { newRunId } = await replayRun({
      journal, runId: 'base2', model: makeModel(30, 'Done B'), tools: makeTools(counter), stopWhen: stepCountIs(6),
    });

    const diff = await diffRuns(journal, 'base2', newRunId);
    expect(diff.divergentAt).toBe(0); // at the first decision point (model:0's tool-call argument) divergence
    expect(diff.summary).toEqual({ same: 0, changed: 3, missing: 0, added: 0 });

    const [modelStep, toolStep, finalStep] = diff.steps;
    expect(modelStep!.kind).toBe('model');
    expect(modelStep!.detay?.toolCallsA?.[0]?.argsHash).not.toBe(modelStep!.detay?.toolCallsB?.[0]?.argsHash);

    expect(toolStep!.kind).toBe('tool');
    expect(toolStep!.detay?.outputA).toEqual({ charged: 20 });
    expect(toolStep!.detay?.outputB).toEqual({ charged: 30 });

    expect(finalStep!.kind).toBe('model');
    expect(finalStep!.detay?.textA).toBe('Done A');
    expect(finalStep!.detay?.textB).toBe('Done B');
  });

  it('missing scenario: A is longer -> extra steps are missing', async () => {
    const journal = new InMemoryJournal();
    // Common prefix is IDENTICAL: model:0 (tool-call) + tool:0 (succeeded). 'long' has one extra step.
    await journal.put(runKeys.model('long', 0), toolCallResult('charge', 'call-c', { amount: 20 }));
    await journal.put(runKeys.tool('long', 'call-c'), { status: 'succeeded', output: { charged: 20 }, argsHash: 'h1' });
    await journal.put(runKeys.model('long', 1), finalTextResult('Done'));

    await journal.put(runKeys.model('short', 0), toolCallResult('charge', 'call-c', { amount: 20 }));
    await journal.put(runKeys.tool('short', 'call-c'), { status: 'succeeded', output: { charged: 20 }, argsHash: 'h1' });

    const diff = await diffRuns(journal, 'long', 'short');
    expect(diff.summary).toEqual({ same: 2, changed: 0, missing: 1, added: 0 });
    expect(diff.divergentAt).toBe(2);
    expect(diff.steps[2]).toMatchObject({ kind: 'model', durum: 'missing' });
  });

  it('added scenario: diff in the reverse direction with the same data -> extra step is added', async () => {
    const journal = new InMemoryJournal();
    await journal.put(runKeys.model('long2', 0), toolCallResult('charge', 'call-c', { amount: 20 }));
    await journal.put(runKeys.tool('long2', 'call-c'), { status: 'succeeded', output: { charged: 20 }, argsHash: 'h1' });
    await journal.put(runKeys.model('long2', 1), finalTextResult('Done'));

    await journal.put(runKeys.model('short2', 0), toolCallResult('charge', 'call-c', { amount: 20 }));
    await journal.put(runKeys.tool('short2', 'call-c'), { status: 'succeeded', output: { charged: 20 }, argsHash: 'h1' });

    const diff = await diffRuns(journal, 'short2', 'long2'); // base short, new long → extra step is 'added'
    expect(diff.summary).toEqual({ same: 2, changed: 0, missing: 0, added: 1 });
    expect(diff.divergentAt).toBe(2);
    expect(diff.steps[2]).toMatchObject({ kind: 'model', durum: 'added' });
  });
});

describe('W2 regression — regressionReport', () => {
  it('wraps diffRuns; optional scorer runs on the diff', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    await runDurable({
      runId: 'base3', journal, model: makeModel(20, 'Done A'), tools: makeTools(counter),
      stopWhen: stepCountIs(6), prompt: 'x',
    });
    const { newRunId } = await replayRun({
      journal, runId: 'base3', model: makeModel(20, 'Done A'), tools: makeTools(counter), stopWhen: stepCountIs(6),
    });

    const withoutScorer = await regressionReport(journal, 'base3', newRunId);
    expect(withoutScorer.score).toBeUndefined();
    expect(withoutScorer.diff.divergentAt).toBeUndefined();

    const withScorer = await regressionReport(journal, 'base3', newRunId, {
      scorer: (d) => d.summary.changed + d.summary.missing + d.summary.added,
    });
    expect(withScorer.score).toBe(0);
    expect(withScorer.baseRunId).toBe('base3');
    expect(withScorer.newRunId).toBe(newRunId);
  });
});
