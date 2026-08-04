// Studio /workflows/:name/run: body.maxSteps is passed to the runner; a paused response surfaces.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createStudioApi } from '../src/server.js';
import { call } from './call.js';

describe('studio: workflow step-through API', () => {
  it('maxSteps is passed into gnl.runWorkflow opts; paused/stepId are in the response', async () => {
    const received: unknown[] = [];
    const app = createStudioApi({
      reader: new InMemoryJournal(),
      gnl: {
        listAgents: () => [],
        run: async () => ({}),
        listWorkflows: () => [{ name: 'w', steps: [{ id: 'a' }, { id: 'b' }] }],
        runWorkflow: async (_name, _input, opts) => {
          received.push(opts);
          return { runId: opts?.runId ?? 'r', paused: true, stepId: 'b', steps: [{ id: 'a', kind: 'step', output: 1 }, { id: 'b', kind: 'step', output: undefined }] };
        },
      },
    });

    const res = await call(app, '/workflows/w/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: {}, runId: 'st-1', maxSteps: 1 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(received[0]).toMatchObject({ runId: 'st-1', maxSteps: 1 });
    expect(body).toMatchObject({ ok: true, paused: true, stepId: 'b' });
  });
});
