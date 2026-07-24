// Step-through debug: runResumable({maxSteps}) — position-based pausing.
// On Continue (maxSteps+1), earlier steps REPLAY from the journal: real run counts don't increase.
import { describe, it, expect } from 'vitest';
import { workflow, step, waitFor } from '../src/workflow.js';

function memJournal() {
  const m = new Map<string, unknown>();
  return {
    async get<T = unknown>(k: string): Promise<T | undefined> { return m.get(k) as T | undefined; },
    async put(k: string, v: unknown): Promise<void> { m.set(k, v); },
  };
}

describe('workflow step-through (maxSteps)', () => {
  it('step by step: each Continue runs only the NEXT step, earlier ones replay', async () => {
    const journal = memJournal();
    const runs = { a: 0, b: 0, c: 0 };
    const wf = workflow<number>()
      .then(step('a', async (n: number) => { runs.a++; return n + 1; }))
      .then(step('b', async (n: number) => { runs.b++; return n * 10; }))
      .then(step('c', async (n: number) => { runs.c++; return n - 3; }));
    const ctx = { runId: 'st-1', journal };

    const r1 = await wf.runResumable(0, ctx, { maxSteps: 1 });
    expect(r1).toEqual({ status: 'paused', stepId: 'b', partial: 1 }); // next = b, output so far = 1
    expect(runs).toEqual({ a: 1, b: 0, c: 0 });

    const r2 = await wf.runResumable(0, ctx, { maxSteps: 2 });
    expect(r2).toEqual({ status: 'paused', stepId: 'c', partial: 10 });
    expect(runs).toEqual({ a: 1, b: 1, c: 0 }); // a REPLAYED — did not run again

    const r3 = await wf.runResumable(0, ctx, { maxSteps: 3 });
    expect(r3).toEqual({ status: 'completed', output: 7 });
    expect(runs).toEqual({ a: 1, b: 1, c: 1 }); // exactly-once preserved
  });

  it('when maxSteps is omitted, behavior is unchanged (backward compatible); an in-range suspend returns suspended, not paused', async () => {
    const journal = memJournal();
    let eventReady = false;
    const wf = workflow<string>()
      .then(step('prepare', async (s: string) => s + '!'))
      .then(waitFor('approval', () => (eventReady ? 'approved' : undefined)));
    const ctx = { runId: 'st-2', journal };

    // Within the limit (2), waitFor suspends → 'suspended' (not confused with paused)
    const r1 = await wf.runResumable('hey', ctx, { maxSteps: 2 });
    expect(r1.status).toBe('suspended');

    eventReady = true;
    const r2 = await wf.runResumable('hey', ctx); // no opts → old behavior: run to completion
    expect(r2).toEqual({ status: 'completed', output: 'approved' });
  });
});
