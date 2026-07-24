// Studio workflows: live run-stream (SSE) + run state (/workflows/run/:runId). (InMemoryJournal reader.)
import { describe, it, expect } from 'vitest';
import { workflow, step, waitFor } from '../../workflow/src/workflow.js';
import { createStudioApp } from '../../studio/src/server.js';
import { createStudioRunner } from '../../studio/src/runner.js';
import { createGnl } from '../src/registry.js';
import { InMemoryJournal } from '../src/journal.js';

function setup() {
  const wf = workflow<{ n?: number }>()
    .then(step('a', async (i: any) => ({ a: (i?.n ?? 0) + 1 })))
    .then(step('b', async (i: any) => ({ ...i, b: 2 })));
  const journal = new InMemoryJournal();
  const config = { journal, workflows: { demo: wf } };
  const gnl = createGnl(config);
  const app = createStudioApp({ reader: journal, gnl: createStudioRunner(gnl, config) });
  return { app };
}

describe('studio workflows live + run state', () => {
  it('run-stream: emits step + done events (SSE)', async () => {
    const { app } = setup();
    const res = await app.request('/api/workflows/demo/run-stream', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: { n: 5 } }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('event: start');
    expect(text).toContain('event: step');
    expect(text).toContain('event: done');
    expect(text).toContain('"stepId":"a"');
    expect(text).toContain('"stepId":"b"');
  });

  it('GET /workflows/run/:runId — step outputs from the journal', async () => {
    const { app } = setup();
    const run = await (await app.request('/api/workflows/demo/run', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: { n: 5 }, runId: 'wf-demo-x' }),
    })).json();
    expect(run.runId).toBe('wf-demo-x');

    const state = (await (await app.request('/api/workflows/run/wf-demo-x')).json()) as any;
    expect(state.runId).toBe('wf-demo-x');
    expect(state.suspended).toBe(false);
    const ids = state.steps.map((s: any) => s.stepId).sort();
    expect(ids).toContain('a');
    expect(ids).toContain('b');
  });

  it('GET /workflows/:name/runs — persistent run history (listKeys, startedAt desc)', async () => {
    const { app } = setup();
    const post = (runId: string, n: number) =>
      app.request('/api/workflows/demo/run', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: { n }, runId }),
      });
    await post('wf-demo-1700000000000', 1);
    await post('wf-demo-1700000001000', 2);

    const runs = (await (await app.request('/api/workflows/demo/runs')).json()) as any[];
    expect(runs.length).toBe(2);
    expect(runs[0].runId).toBe('wf-demo-1700000001000'); // newest first (startedAt desc)
    expect(runs.every((r) => r.status === 'completed' && !r.suspended)).toBe(true);
    expect(runs.find((r) => r.runId === 'wf-demo-1700000000000').steps).toBe(2); // a + b
  });

  it('runs: a suspended run shows suspended; completed after resume (sticky _suspend is handled)', async () => {
    let tick = 0;
    const wf = workflow<{ x?: number }>()
      .then(step('p', async (i: any) => ({ ...i, p: 1 })))
      .then(waitFor('await', async () => (++tick % 2 === 0 ? { ok: true } : null)))
      .then(step('f', async (i: any) => ({ ...i, f: 1 })));
    const journal = new InMemoryJournal();
    const config = { journal, workflows: { flow: wf } };
    const gnl = createGnl(config);
    const app = createStudioApp({ reader: journal, gnl: createStudioRunner(gnl, config) });
    const rid = 'wf-flow-1700000000000';
    const run = () => app.request('/api/workflows/flow/run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: { x: 1 }, runId: rid }),
    });

    await run(); // tick=1 → suspend at the 'await' step
    let runs = (await (await app.request('/api/workflows/flow/runs')).json()) as any[];
    expect(runs[0].status).toBe('suspended');
    expect(runs[0].suspended).toBe(true);

    await run(); // resume: tick=2 → 'await' passes, 'f' runs → completes
    runs = (await (await app.request('/api/workflows/flow/runs')).json()) as any[];
    expect(runs[0].status).toBe('completed'); // _suspend is still there but 'await' produced output
    expect(runs[0].suspended).toBe(false);
  });
});
