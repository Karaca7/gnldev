// P0.4 (AUDIT-R2): studio's POST /workflows/:name/run forwards `resume` (both the
// code-defined and managed paths) and maps a canceled runResumable result the same way suspended/paused
// already are (mirrors @gnl/durable registry.ts's runWorkflow mapping — see registry-workflow-p04.test.ts).
// GET /workflows/runs is the new wfrun: registry query, reimplemented inline against `rw` rather than
// importing @gnl/workflow (see the route's own JSDoc in server.ts for why).
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnl/durable';
import { workflow, step, waitForResume } from '@gnl/workflow';
import { createStudioApi, type WorkflowDef } from '../src/server.js';

const post = (app: any, path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('studio: P0.4 workflow resume + canceled (code-defined workflow)', () => {
  it('forwards body.resume into gnl.runWorkflow; a canceled result surfaces in the response', async () => {
    const received: unknown[] = [];
    const responses: any[] = [
      { runId: 'r1', suspended: true, stepId: 'approval', reason: { kind: 'resume' }, steps: [] },
      { runId: 'r1', canceled: true, stepId: 'approval', reason: 'signal', suspended: false, steps: [] },
    ];
    let i = 0;
    const app = createStudioApi({
      reader: new InMemoryJournal(),
      gnl: {
        listAgents: () => [],
        run: async () => ({}),
        listWorkflows: () => [{ name: 'w', steps: [{ id: 'a' }] }],
        runWorkflow: async (_name, _input, opts) => { received.push(opts); return responses[Math.min(i++, responses.length - 1)]; },
      },
    });

    const r1 = await (await post(app, '/workflows/w/run', { input: {}, runId: 'r1' })).json();
    expect(r1.suspended).toBe(true);
    expect(received[0]).toEqual({ runId: 'r1' });

    const r2 = await (await post(app, '/workflows/w/run', { input: {}, runId: 'r1', resume: { approval: { ok: true } } })).json();
    expect(received[1]).toEqual({ runId: 'r1', resume: { approval: { ok: true } } });
    expect(r2.canceled).toBe(true);
  });
});

describe('studio: P0.4 workflow resume + canceled (managed workflow, real engine) + GET /workflows/runs', () => {
  function makeApp(journal: InMemoryJournal) {
    const defs = new Map<string, WorkflowDef>([['approvewf', { name: 'approvewf', steps: [] }]]);
    return createStudioApi({
      reader: journal,
      gnl: { listAgents: () => [], run: async () => ({ text: 'unused' }) },
      workflowStore: {
        list: () => [...defs.values()],
        get: (n) => defs.get(n),
        set: (d) => { defs.set(d.name, d); },
        delete: (n) => { defs.delete(n); },
      },
      // Ignores the compiled WorkflowDef/runAgent — returns a REAL @gnl/workflow Workflow with a
      // waitForResume step, so runManaged's suspend/resume/cancel plumbing exercises the real engine
      // (not a stub), the same spirit as workflow-p04's registry test but through the HTTP layer.
      compileWorkflow: (() => workflow<string>()
        .then(step('prepare', async (s: string) => s + '!'))
        .then(waitForResume<{ ok: boolean }>('approval'))) as any,
    });
  }

  it('suspends, resumes via body.resume, and is listed by GET /workflows/runs (moves suspended → completed)', async () => {
    const journal = new InMemoryJournal();
    const app = makeApp(journal);

    const r1 = await (await post(app, '/workflows/approvewf/run', { input: 'hi', runId: 'm-1' })).json();
    expect(r1.suspended).toBe(true);
    expect(r1.stepId).toBe('approval');

    const listed = await (await app.request('/workflows/runs?status=suspended')).json();
    expect(listed.map((r: any) => r.runId)).toContain('m-1');

    const r2 = await (await post(app, '/workflows/approvewf/run', { input: 'hi', runId: 'm-1', resume: { approval: { ok: true } } })).json();
    expect(r2.output).toEqual({ ok: true });
    expect(r2.suspended).toBe(false);

    const completedList = await (await app.request('/workflows/runs?status=completed')).json();
    expect(completedList.map((r: any) => r.runId)).toContain('m-1');
    const suspendedAfter = await (await app.request('/workflows/runs?status=suspended')).json();
    expect(suspendedAfter.find((r: any) => r.runId === 'm-1')).toBeUndefined();
  });

  it('a canceled run is reported by run() and reflected in GET /workflows/runs', async () => {
    const journal = new InMemoryJournal();
    const app = makeApp(journal);
    await post(app, '/workflows/approvewf/run', { input: 'hi', runId: 'm-2' }); // suspend

    // Durably cancel by writing the SAME flag @gnl/workflow's cancelWorkflowRun would (kept minimal —
    // avoids importing @gnl/workflow's cancelWorkflowRun into the test just for this one write).
    await journal.put('m-2:wf:_canceled', { at: Date.now() });

    const r2 = await (await post(app, '/workflows/approvewf/run', { input: 'hi', runId: 'm-2', resume: { approval: { ok: true } } })).json();
    expect(r2.canceled).toBe(true);
    expect(r2.suspended).toBe(false);

    const canceledList = await (await app.request('/workflows/runs?status=canceled')).json();
    expect(canceledList.map((r: any) => r.runId)).toContain('m-2');
  });

  it('invalid ?status= → 400; a reader without listKeys/get → 501', async () => {
    const journal = new InMemoryJournal();
    const app = makeApp(journal);
    const res = await app.request('/workflows/runs?status=bogus');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid status/);

    const noCapApp = createStudioApi({
      reader: { listRuns: async () => [], readRun: async () => [] } as any,
      gnl: { listAgents: () => [], run: async () => ({}) },
    });
    const res2 = await noCapApp.request('/workflows/runs');
    expect(res2.status).toBe(501);
  });
});
