// Architecture audit probe: cost of the subject view's per-key ownership rule.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { withSubjectJournal } from '../src/subject-view.js';

function counted(j: InMemoryJournal, latencyMs = 0) {
  const c = { gets: 0 };
  const sleep = () => (latencyMs ? new Promise((r) => setTimeout(r, latencyMs)) : Promise.resolve());
  const proxy = new Proxy(j as any, {
    get(t, p) {
      if (p === 'get') return async (k: string) => { c.gets++; await sleep(); return t.get(k); };
      if (p === 'listKeys') return async (pre: string) => { await sleep(); return t.listKeys(pre); };
      const v = Reflect.get(t, p, t); return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  return { j: proxy, c };
}

describe('keyIsMine cost', () => {
  it('get of one key: gets vs number of colons', async () => {
    const rows: string[] = [];
    for (const colons of [1, 5, 20, 80]) {
      const base = new InMemoryJournal();
      await base.put('r:input', { resourceId: 'u' });
      const key = 'r:' + Array.from({ length: colons }, (_, i) => `s${i}`).join(':');
      await base.put(key, { v: 1 });
      const { j, c } = counted(base);
      const v = withSubjectJournal(j, 'u');
      c.gets = 0; const got = await v.get(key);
      rows.push(`colons=${colons} gets=${c.gets} found=${got !== undefined}`);
    }
    console.log('[P1]', rows.join(' | '));
    expect(rows.length).toBe(4);
  });

  it('listKeys(runId:) over a run with many step keys, 1ms simulated store latency', async () => {
    const rows: string[] = [];
    for (const steps of [10, 100, 400]) {
      const base = new InMemoryJournal();
      await base.put('run-1:input', { resourceId: 'u' });
      for (let i = 0; i < steps; i++) await base.put(`run-1:tool:c${i}:args`, { i });
      const raw = counted(base, 1);
      let t = performance.now(); await raw.j.listKeys('run-1:'); const rawMs = performance.now() - t;
      const { j, c } = counted(base, 1);
      const v = withSubjectJournal(j, 'u');
      t = performance.now(); const ks = await v.listKeys!('run-1:'); const viewMs = performance.now() - t;
      rows.push(`keys=${ks.length} raw=${rawMs.toFixed(0)}ms view=${viewMs.toFixed(0)}ms gets=${c.gets}`);
    }
    console.log('[P2]', rows.join(' | '));
    expect(rows.length).toBe(3);
  });

  it('listWorkflowRuns-shaped scan: wfrun: rows over N runs, 1ms latency', async () => {
    const rows: string[] = [];
    for (const n of [10, 100, 300]) {
      const base = new InMemoryJournal();
      for (let i = 0; i < n; i++) { await base.put(`wf${i}:input`, { resourceId: i % 2 ? 'u' : 'other' }); await base.put(`wfrun:wf${i}`, { runId: `wf${i}`, status: 'completed' }); }
      const { j, c } = counted(base, 1);
      const v = withSubjectJournal(j, 'u');
      const t = performance.now();
      const ks = await v.listKeys!('wfrun:');
      for (const k of ks) await v.get(k);
      rows.push(`runs=${n} visible=${ks.length} gets=${c.gets} ms=${(performance.now() - t).toFixed(0)}`);
    }
    console.log('[P3]', rows.join(' | '));
    expect(rows.length).toBe(3);
  });
});
