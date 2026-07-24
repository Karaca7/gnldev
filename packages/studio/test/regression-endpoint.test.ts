// W5 — Studio regression endpoints: POST /runs/:id/regression (re-run with replayRun + diff),
// GET /runs/:id/regression/:otherId (diff two existing runs without re-running). Unauthorized → 403.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, runDurable } from '@gnl/durable';
import { roleAuth } from '@gnl/auth';
import { createStudioApi } from '../src/server.js';

// A minimal LanguageModelV2 mock without depending on ai/test (and transitively msw) — same pattern as durable/test/mock.ts.
const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
function mockModel(text: string) {
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'mock-model',
    supportedUrls: {},
    doGenerate: async () => ({ content: [{ type: 'text', text }], finishReason: 'stop' as const, usage, warnings: [] as any[] }),
    doStream: async () => { throw new Error('mock: doStream is not supported'); },
  };
}

describe('POST /runs/:id/regression', () => {
  it('re-runs the recorded run with a new model; returns a diff report (same model → every step same)', async () => {
    const journal = new InMemoryJournal();
    await runDurable({ runId: 'base', journal, model: mockModel('Hello'), prompt: 'x' } as any);

    // regressionModel: converts body.model's spec to a mock without hitting the real provider package (test injection).
    const app = createStudioApi({ reader: journal, regressionModel: () => mockModel('Hello') });

    const res = await app.request('/runs/base/regression', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock/echo' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.baseRunId).toBe('base');
    expect(body.newRunId).not.toBe('base');
    expect(body.diff.divergentAt).toBeUndefined();
    expect(body.diff.summary).toEqual({ same: 1, changed: 0, missing: 0, added: 0 });

    // the original run's journal records are untouched (replayRun is NOT forkRun).
    expect(await journal.get('base:model:0')).toMatchObject({ content: [{ type: 'text', text: 'Hello' }] });
  });

  it('a different model → diff \'changed\' + divergentAt=0', async () => {
    const journal = new InMemoryJournal();
    await runDurable({ runId: 'base2', journal, model: mockModel('A'), prompt: 'x' } as any);
    const app = createStudioApi({ reader: journal, regressionModel: () => mockModel('B') });

    const res = await app.request('/runs/base2/regression', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock/echo', system: 'new system prompt' }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.diff.divergentAt).toBe(0);
    expect(body.diff.summary).toEqual({ same: 0, changed: 1, missing: 0, added: 0 });
  });

  it('400 if model is not given in the body', async () => {
    const journal = new InMemoryJournal();
    await runDurable({ runId: 'base3', journal, model: mockModel('A'), prompt: 'x' } as any);
    const app = createStudioApi({ reader: journal, regressionModel: () => mockModel('A') });
    const res = await app.request('/runs/base3/regression', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('unauthorized (viewer) → 403; admin → 200', async () => {
    const journal = new InMemoryJournal();
    await runDurable({ runId: 'base4', journal, model: mockModel('A'), prompt: 'x' } as any);
    const auth = () => roleAuth({ admin: { token: 'adm' }, viewer: { token: 'viw' } });
    const app = createStudioApi({ reader: journal, auth: auth(), regressionModel: () => mockModel('A') });

    const denied = await app.request('/runs/base4/regression', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer viw' },
      body: JSON.stringify({ model: 'mock/echo' }),
    });
    expect(denied.status).toBe(403);

    const allowed = await app.request('/runs/base4/regression', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer adm' },
      body: JSON.stringify({ model: 'mock/echo' }),
    });
    expect(allowed.status).toBe(200);
  });

  it('lands an audit record (run.regression)', async () => {
    const journal = new InMemoryJournal();
    await runDurable({ runId: 'base5', journal, model: mockModel('A'), prompt: 'x' } as any);
    const app = createStudioApi({ reader: journal, regressionModel: () => mockModel('A') });
    await app.request('/runs/base5/regression', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gnl-actor': 'ops@acme.co' },
      body: JSON.stringify({ model: 'mock/echo' }),
    });
    const audit = await (await app.request('/audit?action=run.regression')).json();
    expect(audit.items[0]).toMatchObject({ actor: 'ops@acme.co', target: 'base5' });
  });
});

describe('GET /runs/:id/regression/:otherId', () => {
  it('diffs two existing runs without re-running them', async () => {
    const journal = new InMemoryJournal();
    await runDurable({ runId: 'r1', journal, model: mockModel('same'), prompt: 'x' } as any);
    await runDurable({ runId: 'r2', journal, model: mockModel('same'), prompt: 'x' } as any);
    const app = createStudioApi({ reader: journal });

    const res = await app.request('/runs/r1/regression/r2');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.baseRunId).toBe('r1');
    expect(body.newRunId).toBe('r2');
    expect(body.diff.divergentAt).toBeUndefined();
  });

  it('unauthorized (no identity while auth is on) → 401', async () => {
    const journal = new InMemoryJournal();
    await runDurable({ runId: 'r3', journal, model: mockModel('a'), prompt: 'x' } as any);
    await runDurable({ runId: 'r4', journal, model: mockModel('a'), prompt: 'x' } as any);
    const app = createStudioApi({ reader: journal, auth: roleAuth({ admin: { token: 'adm' } }) });
    const res = await app.request('/runs/r3/regression/r4');
    expect(res.status).toBe(401);
  });
});
