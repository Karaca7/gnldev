// Eval gate: promote can't happen without clearing the dataset suite — an "the prompt changed,
// prod broke" safety net. The gate decision (passed/failed + aggregate) always lands in audit;
// a blocked promote returns 412, active stays unchanged.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createStudioApi } from '../src/server.js';

const post = (app: any, path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-gnl-actor': 'ops@acme.co' }, body: JSON.stringify(body) });

function makeApp(suite: { aggregate: Record<string, number> }) {
  return createStudioApi({
    reader: new InMemoryJournal(),
    datasets: {
      list: () => [{ id: 'basic', cases: 3 }],
      run: () => ({ datasetId: 'basic', cases: [], aggregate: suite.aggregate }),
    },
    evalGate: { datasetId: 'basic', minAvg: 0.8 },
  });
}

describe('eval gate (promote gate)', () => {
  it('suite below threshold → promote returns 412 + active is UNCHANGED; promote succeeds once the suite passes; every decision is in audit', async () => {
    const suite = { aggregate: { accuracy: 0.6, style: 0.9 } }; // accuracy is below the 0.8 threshold
    const app = makeApp(suite);
    await post(app, '/managed-agents', { name: 'writer', model: 'm/1' });

    const blocked = await post(app, '/managed-agents/writer/promote', { version: 1 });
    expect(blocked.status).toBe(412);
    const bBody = await blocked.json();
    expect(bBody.error).toContain('accuracy=0.60<0.8');
    // active is unchanged
    const list1 = await (await app.request('/managed-agents')).json();
    expect(list1.agents[0].active).toBeNull();

    // suite improved → promote passes
    suite.aggregate = { accuracy: 0.85, style: 0.9 };
    expect(await (await post(app, '/managed-agents/writer/promote', { version: 1 })).json()).toMatchObject({ ok: true, active: 1 });

    // audit: two gate decisions (failed + passed) — newest first
    const gate = await (await app.request('/audit?action=agent.gate')).json();
    expect(gate.items).toHaveLength(2);
    expect(gate.items[0].detail).toMatchObject({ passed: true, datasetId: 'basic' });
    expect(gate.items[1].detail).toMatchObject({ passed: false, minAvg: 0.8 });
  });

  it('evalGate is set but datasets is missing → 501; behavior is unchanged for a gateless setup; capabilities flag', async () => {
    const broken = createStudioApi({ reader: new InMemoryJournal(), evalGate: { datasetId: 'x' } });
    await post(broken, '/managed-agents', { name: 'a', model: 'm/1' });
    expect((await post(broken, '/managed-agents/a/promote', { version: 1 })).status).toBe(501);

    const plain = createStudioApi({ reader: new InMemoryJournal() });
    await post(plain, '/managed-agents', { name: 'a', model: 'm/1' });
    expect((await post(plain, '/managed-agents/a/promote', { version: 1 })).status).toBe(200); // no gate → old behavior

    const caps = await (await makeApp({ aggregate: {} }).request('/capabilities')).json();
    expect(caps.evalGate).toBe(true);
  });
});
