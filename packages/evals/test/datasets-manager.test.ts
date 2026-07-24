// createDatasetsManager — version history + experiment records + comparison.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnl/durable';
import { createDatasetsManager, contains } from '../src/index.js';
import type { Dataset } from '../src/index.js';

const DS: Dataset = {
  id: 'sw-qa',
  cases: [
    { id: 'c1', input: 'capital?', expected: 'Ankara' },
    { id: 'c2', input: 'largest city?', expected: 'Istanbul' },
  ],
};

/** Runner that answers based on an answers map. */
const runnerOf = (answers: Record<string, string>) => async (_input: any, ctx: { caseId: string }) =>
  ({ output: answers[ctx.caseId] ?? '' });

describe('createDatasetsManager', () => {
  it('versioning: identical content does NOT open a new version, changed content does; listVersions ascending', async () => {
    const m = createDatasetsManager(new InMemoryJournal());
    const v1 = await m.saveDataset(DS, 1000);
    expect(v1.version).toBe(1);
    expect((await m.saveDataset(DS, 2000)).version).toBe(1); // same content → same version
    const v2 = await m.saveDataset({ ...DS, cases: [...DS.cases, { id: 'c3', input: 'x', expected: 'y' }] }, 3000);
    expect(v2.version).toBe(2);
    expect(await m.listVersions('sw-qa')).toEqual([
      { version: 1, at: 1000, cases: 2 },
      { version: 2, at: 3000, cases: 3 },
    ]);
    expect((await m.getDataset('sw-qa'))!.version).toBe(2); // latest
    expect((await m.getDataset('sw-qa', 1))!.dataset.cases).toHaveLength(2); // past version is readable
  });

  it('runExperiment: runs+records; same experimentId is IDEMPOTENT (does not re-run)', async () => {
    const m = createDatasetsManager(new InMemoryJournal());
    let runs = 0;
    const run = async (_i: any, ctx: { caseId: string }) => { runs++; return { output: ctx.caseId === 'c1' ? 'Ankara' : 'wrong' }; };
    const e1 = await m.runExperiment({ dataset: DS, run, scorers: [contains()], experimentId: 'exp1', label: 'v1-model', now: 1000 });
    expect(e1.result.aggregate.contains).toBe(0.5);
    expect(e1.datasetVersion).toBe(1);
    expect(runs).toBe(2);
    const again = await m.runExperiment({ dataset: DS, run, scorers: [contains()], experimentId: 'exp1', now: 9999 });
    expect(again.at).toBe(1000); // returned the saved result
    expect(runs).toBe(2); // did NOT re-run
  });

  it('compare: aggregate deltas + changed cases (worst regression first) + counters', async () => {
    const m = createDatasetsManager(new InMemoryJournal());
    await m.runExperiment({ dataset: DS, run: runnerOf({ c1: 'Ankara', c2: 'wrong' }), scorers: [contains()], experimentId: 'base', now: 1 });
    await m.runExperiment({ datasetId: 'sw-qa', run: runnerOf({ c1: 'dunno', c2: 'Istanbul' }), scorers: [contains()], experimentId: 'cand', now: 2 });

    const diff = await m.compare('sw-qa', 'base', 'cand');
    expect(diff.aggregate.contains).toEqual({ baseline: 0.5, candidate: 0.5, delta: 0 });
    expect(diff.changes).toEqual([
      { caseId: 'c1', scorer: 'contains', baseline: 1, candidate: 0, delta: -1 }, // regression first
      { caseId: 'c2', scorer: 'contains', baseline: 0, candidate: 1, delta: 1 },
    ]);
    expect(diff.regressions).toBe(1);
    expect(diff.improvements).toBe(1);

    const list = await m.listExperiments('sw-qa');
    expect(list.map((e) => e.id)).toEqual(['base', 'cand']);
  });

  it('id validation: a dataset/experiment id containing \':\' fails fast (journal key safety)', async () => {
    const m = createDatasetsManager(new InMemoryJournal());
    await expect(m.saveDataset({ id: 'bad:model', cases: [] })).rejects.toThrow(/cannot contain/);
    await expect(
      m.runExperiment({ dataset: DS, run: runnerOf({}), scorers: [], experimentId: 'e:tool' }),
    ).rejects.toThrow(/cannot contain/);
    await expect(m.compare('sw-qa', 'missing1', 'missing2')).rejects.toThrow(/not found/);
  });
});
