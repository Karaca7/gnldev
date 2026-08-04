// Studio v2 ops endpoints: cost + trace (waterfall) + metrics + per-step diff + bearerAuth helper.
import { describe, it, expect } from 'vitest';
import { stepCountIs } from 'ai';
import { createStudioApi } from '../../studio/src/server.js';
import { bearerAuth } from '../../studio/src/auth.js';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';
import { call } from './call.js';

async function seed() {
  const journal = new InMemoryJournal();
  const model = () => createMockModel(async ({ prompt }: any) =>
    countToolResults(prompt) === 0 ? toolCallResult('pay', 'c', { amount: 5 }) : finalTextResult('done'),
  );
  await runDurable({ runId: 'r1', journal, model: model(), tools: { pay: { execute: async () => ({ ok: true }) } }, prompt: 'x', stopWhen: stepCountIs(6) });
  return journal;
}
const get = (api: any, p: string, h?: any) => call(api, p, h ? { headers: h } : undefined).then((r: any) => r.json());

describe('studio v2 ops endpoints', () => {
  it('/runs/:id/cost + /trace (timed span) + /metrics', async () => {
    const api = createStudioApi({ reader: await seed() });
    const cost = await get(api, '/runs/r1/cost');
    expect(cost.modelCalls).toBe(2);
    expect(cost.toolCalls).toBe(1);

    const trace = await get(api, '/runs/r1/trace');
    expect(trace.spans.length).toBe(3); // model, tool, model
    expect(trace.spans[0].name).toBe('llm.generate');
    expect(typeof trace.spans[0].durationMs).toBe('number');

    const m = await get(api, '/metrics');
    expect(m.total).toBe(1);
    expect(m.byStatus.completed).toBe(1);
  });

  it('/runs/:id/diff: messages added at step N', async () => {
    const api = createStudioApi({ reader: await seed() });
    const d1 = await get(api, '/runs/r1/diff?step=1');
    expect(d1.added.length).toBeGreaterThanOrEqual(1); // first model step was added
    expect(d1.step).toBe(1);
  });

  it('bearerAuth: no token → 401, correct token → 200', async () => {
    const api = createStudioApi({ reader: await seed(), auth: { read: bearerAuth('s3cret') } });
    expect((await call(api, '/runs')).status).toBe(401);
    expect((await call(api, '/runs', { headers: { authorization: 'Bearer s3cret' } })).status).toBe(200);
    expect((await call(api, '/runs', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
  });
});
