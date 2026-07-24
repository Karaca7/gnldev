import { describe, it, expect } from 'vitest';
import { workflow, step } from '../src/index.js';

// A tiny JournalLike with no package dependency (in reality, @gnl/durable's journal is provided).
function memJournal() {
  const m = new Map<string, unknown>();
  return {
    async get<T>(k: string): Promise<T | undefined> {
      return m.has(k) ? (structuredClone(m.get(k)) as T) : undefined;
    },
    async put(k: string, v: unknown): Promise<void> {
      m.set(k, structuredClone(v));
    },
  };
}

describe('@gnl/workflow — durable steps', () => {
  it('sequential: a completed step does not run again after a crash (exactly-once)', async () => {
    const journal = memJournal();
    const fx: string[] = [];
    const crash = { active: true };
    const s1 = step<number, number>('s1', async (x) => {
      fx.push('s1');
      return x + 1;
    });
    const s2 = step<number, number>('s2', async (x) => {
      fx.push('s2');
      if (crash.active) throw new Error('CRASH');
      return x * 2;
    });
    const wf = workflow<number>().then(s1).then(s2);

    await expect(wf.run(1, { runId: 'w1', journal })).rejects.toThrow('CRASH');
    expect(fx).toEqual(['s1', 's2']);

    crash.active = false;
    const out = await wf.run(1, { runId: 'w1', journal });

    expect(out).toBe(4); // (1+1)*2
    expect(fx).toEqual(['s1', 's2', 's2']); // s1 EXACTLY once; s2 (fail→ok) twice
  });

  it('parallel: each sub-step is journaled separately, does not run again on replay', async () => {
    const journal = memJournal();
    const calls: string[] = [];
    const a = step<number, number>('a', async (x) => {
      calls.push('a');
      return x + 1;
    });
    const b = step<number, number>('b', async (x) => {
      calls.push('b');
      return x + 2;
    });
    const wf = workflow<number>().parallel([a, b]);

    const out = await wf.run(10, { runId: 'p1', journal });
    expect(out).toEqual({ a: 11, b: 12 });

    await wf.run(10, { runId: 'p1', journal }); // re-run → cached
    expect(calls).toEqual(['a', 'b']); // each EXACTLY once
  });

  it('branch: branches based on the condition', async () => {
    const journal = memJournal();
    const big = step<number, string>('big', async () => 'BIG');
    const small = step<number, string>('small', async () => 'small');
    const wf = workflow<number>().branch((x) => x > 10, big, small);
    expect(await wf.run(20, { runId: 'b1', journal })).toBe('BIG');
    expect(await wf.run(5, { runId: 'b2', journal })).toBe('small');
  });
});
