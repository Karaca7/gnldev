// #5A — .map (pure transform, journaled) + asStep nested workflow (namespaced, collision-free) + nested suspend/resume.
import { describe, it, expect } from 'vitest';
import { workflow, step, asStep, waitFor } from '../src/index.js';

// A tiny JournalLike that lets us observe journal keys via keys().
function memJournal() {
  const m = new Map<string, unknown>();
  return {
    async get<T>(k: string): Promise<T | undefined> {
      return m.has(k) ? (structuredClone(m.get(k)) as T) : undefined;
    },
    async put(k: string, v: unknown): Promise<void> {
      m.set(k, structuredClone(v));
    },
    keys: () => [...m.keys()],
  };
}

describe('@gnl/workflow — .map', () => {
  it('transforms the previous output and is journaled (does not run again on replay)', async () => {
    const journal = memJournal();
    let calls = 0;
    const wf = workflow<{ n: number }>()
      .then(step('double', async (i) => ({ n: i.n * 2 })))
      .map((o) => {
        calls++;
        return { label: `n=${o.n}` };
      });

    const out1 = await wf.run({ n: 3 }, { runId: 'r1', journal });
    expect(out1).toEqual({ label: 'n=6' });
    expect(calls).toBe(1);
    expect(journal.keys()).toContain('r1:wf:map#1'); // default id, then(0)+map(1)

    // same runId again = replay → the map function does NOT run again
    const out2 = await wf.run({ n: 3 }, { runId: 'r1', journal });
    expect(out2).toEqual({ label: 'n=6' });
    expect(calls).toBe(1);
  });
});

describe('@gnl/workflow — asStep (nested)', () => {
  it('inner steps live under namespaced keys; outer/inner with the SAME step id do not collide', async () => {
    const journal = memJournal();
    // The inner and outer workflow deliberately use the SAME step id ('process') → collision test.
    const inner = workflow<{ v: number }>()
      .then(step('process', async (i) => ({ v: i.v + 1 })))
      .then(step('finalize', async (i) => ({ v: i.v * 10 })));

    const outer = workflow<{ v: number }>()
      .then(step('process', async (i) => ({ v: i.v + 100 }))) // outer 'process'
      .then(asStep('inner', inner)); // inner 'process' → inner:process

    const out = await outer.run({ v: 1 }, { runId: 'r2', journal });
    // outer process: 1+100=101 → inner.process: 101+1=102 → inner.finalize: 102*10=1020
    expect(out).toEqual({ v: 1020 });

    const keys = journal.keys();
    expect(keys).toContain('r2:wf:process'); // outer
    expect(keys).toContain('r2:wf:inner'); // wrapper output
    expect(keys).toContain('r2:wf:inner:process'); // inner (namespaced, no collision)
    expect(keys).toContain('r2:wf:inner:finalize');
  });

  it('nested waitFor suspend → outer runResumable suspend → resume completed', async () => {
    const journal = memJournal();
    let event: { ok: boolean } | null = null;
    const inner = workflow<{ x: number }>()
      .then(step('prep', async (i) => ({ x: i.x + 1 })))
      .then(waitFor('await-evt', async () => event)) // suspended until the event arrives
      .then(step('done', async (i: any) => ({ x: i.x, done: true })));

    const outer = workflow<{ x: number }>().then(asStep('job', inner));

    const r1 = await outer.runResumable({ x: 5 }, { runId: 'r3', journal });
    expect(r1.status).toBe('suspended');
    if (r1.status === 'suspended') expect(r1.stepId).toBe('job'); // outer wrapper id

    // the inner prep step is journaled under its namespaced key (for replay)
    expect(journal.keys()).toContain('r3:wf:job:prep');

    // event arrives → resume
    event = { ok: true };
    const r2 = await outer.runResumable({ x: 5 }, { runId: 'r3', journal });
    expect(r2.status).toBe('completed');
    if (r2.status === 'completed') expect((r2.output as any).done).toBe(true);
  });
});
