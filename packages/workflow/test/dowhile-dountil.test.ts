// C3 — common workflow-DSL parity: .dowhile / .dountil. Each round is journaled → after a crash, completed
// rounds do NOT run again on resume (exactly-once); only the remaining rounds run.
import { describe, it, expect } from 'vitest';
import { workflow } from '../src/workflow.js';

function memJournal() {
  const m = new Map<string, unknown>();
  return {
    m,
    async get<T = unknown>(k: string): Promise<T | undefined> { return m.get(k) as T | undefined; },
    async put(k: string, v: unknown): Promise<void> { m.set(k, v); },
  };
}

describe('workflow dowhile/dountil', () => {
  it('dowhile: repeats while cond stays true (at least one round)', async () => {
    const journal = memJournal();
    let runs = 0;
    const wf = workflow<{ n: number }>().dowhile(
      async (inp) => { runs++; return { n: inp.n + 1 }; },
      (out) => out.n < 3,
    );
    const res = await wf.run({ n: 0 }, { runId: 'dw-1', journal });
    expect(res).toEqual({ n: 3 });
    expect(runs).toBe(3);
  });

  it('dountil: repeats UNTIL cond becomes true', async () => {
    const journal = memJournal();
    const wf = workflow<{ n: number }>().dountil(
      async (inp) => ({ n: inp.n + 1 }),
      (out) => out.n >= 2,
    );
    const res = await wf.run({ n: 0 }, { runId: 'du-1', journal });
    expect(res).toEqual({ n: 2 });
  });

  it('resume: completed rounds replay from the journal, they do not run again', async () => {
    const journal = memJournal();
    let runs = 0;
    let crashed = false;
    const wf = workflow<{ n: number }>().dowhile(
      async (inp, iter) => {
        runs++;
        if (!crashed && iter === 1) { crashed = true; throw new Error('boom'); } // crashes on round 2
        return { n: inp.n + 1 };
      },
      (out) => out.n < 3,
    );
    await expect(wf.run({ n: 0 }, { runId: 'dw-2', journal })).rejects.toThrow('boom');
    expect(runs).toBe(2); // round0 completed + round1 blew up

    const res = await wf.run({ n: 0 }, { runId: 'dw-2', journal }); // resume
    expect(res).toEqual({ n: 3 });
    // round0 replayed (didn't run) + round1 and round2 ran → 4 real runs total
    expect(runs).toBe(4);
    // The combinator's own default id now carries its POSITION (`dowhile#0` = first step), so a round
    // key is `<combinator>#<iter>`. Before, every `.dowhile` in a workflow was called `dowhile` and a
    // second one silently replayed the first — see test/combinator-ids.test.ts.
    expect(journal.m.has('dw-2:wf:dowhile#0#0')).toBe(true);
    expect(journal.m.has('dw-2:wf:dowhile#0#2')).toBe(true);
  });
});
