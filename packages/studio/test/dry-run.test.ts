// Dry-run: runs a managed workflow with a stub agent + a TEMPORARY journal — the real agent is
// never called, no trace is left in the persistent journal; validates flow/template wiring end-to-end.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createStudioApi, type WorkflowDef } from '../src/server.js';
import { compileManagedWorkflow } from '../src/managed-workflow.js';
import { call } from './call.js';

function makeApp(journal: InMemoryJournal, realRuns: { n: number }) {
  const defs = new Map<string, WorkflowDef>([
    ['m1', { name: 'm1', steps: [
      { id: 's1', agentName: 'writer', prompt: 'Topic: {{input}}' },
      { id: 's2', agentName: 'editor', prompt: 'Fix: {{prev}}' },
    ] }],
  ]);
  return createStudioApi({
    reader: journal,
    gnl: {
      listAgents: () => [],
      run: async () => { realRuns.n++; return { text: 'REAL RESPONSE' }; },
      listWorkflows: () => [{ name: 'codewf', steps: [{ id: 'x' }] }],
      runWorkflow: async (_n, _i, o) => ({ runId: o?.runId ?? 'r', steps: [] }),
    },
    compileWorkflow: compileManagedWorkflow,
    workflowStore: {
      list: () => [...defs.values()],
      get: (n) => defs.get(n),
      set: (d) => { defs.set(d.name, d); },
      delete: (n) => { defs.delete(n); },
    },
  });
}

const post = (app: any, name: string, body: unknown) =>
  call(app, `/workflows/${name}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('workflow dry-run', () => {
  it('the real agent is never called, stub outputs flow through, the persistent journal stays clean', async () => {
    const journal = new InMemoryJournal();
    const realRuns = { n: 0 };
    const app = makeApp(journal, realRuns);

    const res = await (await post(app, 'm1', { input: 'space', dryRun: true, runId: 'dry-1' })).json();
    expect(res.ok).toBe(true);
    expect(res.dryRun).toBe(true);
    expect(realRuns.n).toBe(0); // no real agent ran
    expect(String(res.steps.find((s: any) => s.id === 's1')?.output)).toContain('[dry-run] writer');
    expect(String(res.steps.find((s: any) => s.id === 's2')?.output)).toContain('[dry-run] editor');
    // Template wiring verified: s2's prompt saw s1's output ({{prev}})
    expect(String(res.steps.find((s: any) => s.id === 's2')?.output)).toContain('Fix:');
    // NO trace in the persistent journal
    expect(journal.keys().filter((k) => k.includes(':wf:'))).toHaveLength(0);
  });

  it('real-run behavior is unchanged; code workflow + dryRun → 501', async () => {
    const journal = new InMemoryJournal();
    const realRuns = { n: 0 };
    const app = makeApp(journal, realRuns);

    const real = await (await post(app, 'm1', { input: 'space', runId: 'r-1' })).json();
    expect(real.ok).toBe(true);
    expect(real.dryRun).toBeUndefined();
    expect(realRuns.n).toBe(2); // two steps = two real agent calls
    expect(journal.keys().filter((k) => k.includes(':wf:'))).toHaveLength(2); // persistent trace exists

    expect((await post(app, 'codewf', { dryRun: true })).status).toBe(501);
  });
});
