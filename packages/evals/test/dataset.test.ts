// Sub-batch C — evalDataset: batch eval + aggregate; resumable via journal (a completed case does not re-run).
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnl/durable';
import { evalDataset, contains, exactMatch, type Dataset } from '../src/index.js';

const dataset: Dataset = {
  id: 'greetings',
  cases: [
    { id: 'c1', input: 'hello', expected: 'echo:hello' },
    { id: 'c2', input: 'hi', expected: 'echo:hi' },
  ],
};

describe('@gnl/evals evalDataset', () => {
  it('batch eval + aggregate', async () => {
    const res = await evalDataset({
      dataset,
      run: async (input) => `echo:${input}`,
      scorers: [contains('echo'), exactMatch()],
    });
    expect(res.cases).toHaveLength(2);
    expect(res.aggregate['contains']).toBe(1); // all contain 'echo'
    expect(res.aggregate['exact-match']).toBe(1); // all equal expected
  });

  it('resumable: a case completed via the journal does not re-run', async () => {
    const journal = new InMemoryJournal();
    let runs = 0;
    const run = async (input: any) => (runs++, `echo:${input}`);

    const r1 = await evalDataset({ dataset, run, scorers: [contains('echo')], journal });
    expect(runs).toBe(2);
    expect(r1.aggregate['contains']).toBe(1);

    // second time: all cases are memoized → run is NOT called again (resumable suite).
    const r2 = await evalDataset({ dataset, run, scorers: [contains('echo')], journal });
    expect(runs).toBe(2); // unchanged
    expect(r2.aggregate['contains']).toBe(1);
  });
});
