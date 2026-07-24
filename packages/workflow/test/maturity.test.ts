// Phase 13B — workflow maturity: foreach/loop (control flow, journaled) + sleep (scheduled) +
// waitFor (evented) suspend/resume. (waitFor's `check` in real usage hooks into @gnl/events.)
import { describe, it, expect } from 'vitest';
import { workflow, sleep, waitFor } from '../src/index.js';

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

describe('@gnl/workflow maturity', () => {
  it('foreach: journaled per item → completed ones do not run again on resume', async () => {
    const journal = memJournal();
    const seen: number[] = [];
    const wf = workflow<number[]>().foreach(
      (input) => input,
      async (item: number) => {
        seen.push(item);
        return item * 2;
      },
      'double',
    );
    const out = await wf.run([1, 2, 3], { runId: 'f1', journal });
    expect(out).toEqual([2, 4, 6]);
    expect(seen).toEqual([1, 2, 3]);

    // resume (same runId): all journaled → none of them run again.
    const out2 = await wf.run([1, 2, 3], { runId: 'f1', journal });
    expect(out2).toEqual([2, 4, 6]);
    expect(seen).toEqual([1, 2, 3]); // unchanged
  });

  it('loop: repeats until the condition is satisfied', async () => {
    const journal = memJournal();
    const wf = workflow<number>().loop(
      async (n: number) => n + 1,
      (out) => out < 3,
      { id: 'inc' },
    );
    expect(await wf.run(0, { runId: 'l1', journal })).toBe(3);
  });

  it('sleep: suspends before time elapses → resumes completed once time elapses', async () => {
    const journal = memJournal();
    const until = Date.now() + 40;
    const wf = workflow<{ ok: boolean }>().then(sleep('wait', until) as any);

    const r1 = await wf.runResumable({ ok: true }, { runId: 's1', journal });
    expect(r1.status).toBe('suspended');

    await new Promise((r) => setTimeout(r, 55));
    const r2 = await wf.runResumable({ ok: true }, { runId: 's1', journal });
    expect(r2.status).toBe('completed');
  });

  it('waitFor: suspends while no event, resumes completed once the event arrives (events synergy)', async () => {
    const journal = memJournal();
    const bus = { approved: false }; // in reality @gnl/events listLog/consume
    const wf = workflow<{ id: string }>()
      .then({ id: 'prepare', run: async (i: any) => i })
      .then(waitFor('approval', async () => (bus.approved ? { ok: true } : null)) as any);

    const r1 = await wf.runResumable({ id: 'x' }, { runId: 'w1', journal });
    expect(r1.status).toBe('suspended');
    expect((r1 as any).stepId).toBe('approval');

    bus.approved = true; // the event arrived (e.g. an approval was published)
    const r2 = await wf.runResumable({ id: 'x' }, { runId: 'w1', journal });
    expect(r2.status).toBe('completed');
    expect((r2 as any).output).toEqual({ ok: true });
  });
});
