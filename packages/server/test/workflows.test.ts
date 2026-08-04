// #4 auto-REST expansion: workflows are also exposed over REST (GET /workflows, POST /workflows/:name/run)
// + the OpenAPI spec includes the workflow paths. createGnl goes durable via listWorkflows/runWorkflow.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createRestApi } from '../src/index.js';
import { call } from './call.js';

// Minimal structural WorkflowLike (satisfies the registry's structural type): 2 steps, writes to the journal.
function makeWorkflow() {
  return {
    build: () => [{ id: 'fetch' }, { id: 'summarize' }],
    run: async (input: any, ctx: { runId: string; journal: any }) => {
      await ctx.journal.put(`${ctx.runId}:wf:fetch`, { fetched: input?.q });
      await ctx.journal.put(`${ctx.runId}:wf:summarize`, { summary: `summary: ${input?.q}` });
      return { done: true, echo: input };
    },
  };
}

describe('#4 auto-REST — workflows', () => {
  it('GET /workflows + POST /workflows/:name/run (durable) + OpenAPI workflow path', async () => {
    const journal = new InMemoryJournal();
    const api = createRestApi({ journal, workflows: { research: makeWorkflow() } });
    const json = (r: Response) => r.json() as any;

    // GET /workflows → metadata (name + steps)
    const wfs = await json(await call(api, '/workflows'));
    expect(wfs).toEqual([{ name: 'research', steps: [{ id: 'fetch', kind: 'step' }, { id: 'summarize', kind: 'step' }] }]);

    // POST /workflows/research/run → durable execution, step outputs collected from the journal
    const res = await json(
      await call(api, '/workflows/research/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId: 'w1', input: { q: 'gnl' } }),
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.runId).toBe('w1');
    expect(res.output).toEqual({ done: true, echo: { q: 'gnl' } });
    expect(res.steps.map((s: any) => s.id)).toEqual(['fetch', 'summarize']);
    expect(res.steps[0].output).toEqual({ fetched: 'gnl' });

    // OpenAPI includes the workflow paths
    const spec = await json(await call(api, '/openapi.json'));
    expect(spec.paths['/workflows']).toBeDefined();
    expect(spec.paths['/workflows/research/run']).toBeDefined();

    // unregistered workflow → 404
    const missing = await call(api, '/workflows/nope/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: {} }),
    });
    expect(missing.status).toBe(404);
  });

  it('does not generate an OpenAPI workflow path when there are no workflows', async () => {
    const journal = new InMemoryJournal();
    const api = createRestApi({ journal, agents: {} });
    const spec = (await (await call(api, '/openapi.json')).json()) as any;
    expect(spec.paths['/workflows']).toBeUndefined();
  });
});
