// Phase 3-4 studio endpoints: datasets (Evals) + OpenAPI/Swagger. (createStudioApp + InMemoryJournal reader.)
import { describe, it, expect } from 'vitest';
import { createStudioApp } from '../../studio/src/server.js';
import type { StudioDatasets } from '../../studio/src/server.js';
import { InMemoryJournal } from '../src/journal.js';
import { call } from './call.js';

const fakeDatasets: StudioDatasets = {
  list: () => [{ id: 'sw-qa', cases: 2, description: 'demo' }],
  run: async (id) => ({
    datasetId: id,
    cases: [
      { caseId: 'c1', output: 'Tatooine', scores: { contains: { score: 1 } } },
      { caseId: 'c2', output: 'x', scores: { contains: { score: 0 } } },
    ],
    aggregate: { contains: 0.5 },
  }),
};

describe('studio evals/datasets + swagger', () => {
  it('when datasets is provided: capability + list + run', async () => {
    const app = createStudioApp({ reader: new InMemoryJournal(), datasets: fakeDatasets });

    const caps = await (await call(app, '/api/capabilities')).json();
    expect(caps.datasets).toBe(true);

    const list = (await (await call(app, '/api/datasets')).json()) as any[];
    expect(list).toEqual([{ id: 'sw-qa', cases: 2, description: 'demo' }]);

    const res = await (await call(app, '/api/datasets/sw-qa/run', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })).json();
    expect(res.datasetId).toBe('sw-qa');
    expect(res.aggregate.contains).toBe(0.5);
    expect(res.cases).toHaveLength(2);
  });

  it('when datasets is not provided: capability false + run 501', async () => {
    const app = createStudioApp({ reader: new InMemoryJournal() });
    const caps = await (await call(app, '/api/capabilities')).json();
    expect(caps.datasets).toBe(false);
    expect((await (await call(app, '/api/datasets')).json())).toEqual([]);
    const r = await call(app, '/api/datasets/x/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(501);
  });

  it('openapi.json + swagger (apiBase injected)', async () => {
    const app = createStudioApp({ reader: new InMemoryJournal(), apiBase: '/studio' });
    const spec = (await (await call(app, '/openapi.json')).json()) as any;
    expect(spec.openapi).toBe('3.0.0');
    expect(spec.servers[0].url).toBe('/studio/api');
    expect(Object.keys(spec.paths).length).toBeGreaterThan(20);
    expect(spec.paths['/datasets/{id}/run'].post).toBeTruthy();

    const sw = await call(app, '/swagger');
    expect(sw.status).toBe(200);
    const html = await sw.text();
    expect(html).toContain('swagger-ui-bundle');
    expect(html).toContain('/studio/openapi.json');
  });
});
