// Eval gate: promote can't happen without clearing the dataset suite — an "the prompt changed,
// prod broke" safety net. The gate decision (passed/failed + aggregate) always lands in audit;
// a blocked promote returns 412, active stays unchanged.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createStudioApi } from '../src/server.js';
import { call } from './call.js';

const post = (app: any, path: string, body: unknown) =>
  call(app, path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-gnl-actor': 'ops@acme.co' }, body: JSON.stringify(body) });

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
    const list1 = await (await call(app, '/managed-agents')).json();
    expect(list1.agents[0].active).toBeNull();

    // suite improved → promote passes
    suite.aggregate = { accuracy: 0.85, style: 0.9 };
    expect(await (await post(app, '/managed-agents/writer/promote', { version: 1 })).json()).toMatchObject({ ok: true, active: 1 });

    // audit: two gate decisions (failed + passed) — newest first
    const gate = await (await call(app, '/audit?action=agent.gate')).json();
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

    const caps = await (await call(makeApp({ aggregate: {} }), '/capabilities')).json();
    expect(caps.evalGate).toBe(true);
  });
});

/**
 * A gate that measured nothing has not passed.
 *
 * The decision was `Object.entries(aggregate).filter(([, v]) => v < minAvg)` and `passed` meant "the
 * filter found nothing". Two degenerate answers therefore promoted: an EMPTY aggregate, which a
 * dataset run with no scorers attached produces (`evalDataset` builds `{}`), and a NON-FINITE average,
 * because `NaN < minAvg` is false. Neither is reachable from a shipped caller today — but that is a
 * property of today's callers, and the gate is the thing standing between a bad version and
 * production.
 */
describe('the gate refuses to decide on a degenerate measurement', () => {
  it('an EMPTY aggregate blocks the promote instead of allowing it', async () => {
    const app = makeApp({ aggregate: {} });
    await post(app, '/managed-agents', { name: 'writer', model: 'm/1' });

    const res = await post(app, '/managed-agents/writer/promote', { version: 1 });
    expect(res.status, 'a suite that scored nothing was read as a pass').toBe(412);
    expect((await res.json()).error).toContain('no scores');

    // The version really did not go live — the status code alone would not prove that.
    const list = await (await call(app, '/managed-agents')).json();
    expect(list.agents[0].active, 'the promote went through anyway').toBeNull();
  });

  it('a NaN average blocks the promote — `NaN < minAvg` is false, which is not the same as passing', async () => {
    const app = makeApp({ aggregate: { accuracy: NaN, style: 0.9 } });
    await post(app, '/managed-agents', { name: 'writer', model: 'm/1' });

    const res = await post(app, '/managed-agents/writer/promote', { version: 1 });
    expect(res.status, 'an unmeasurable scorer was read as a pass').toBe(412);
    expect((await res.json()).error).toContain('accuracy');

    const list = await (await call(app, '/managed-agents')).json();
    expect(list.agents[0].active).toBeNull();
  });

  it('a healthy suite still promotes — the guard did not close the door on everyone', async () => {
    const app = makeApp({ aggregate: { accuracy: 0.9, style: 0.95 } });
    await post(app, '/managed-agents', { name: 'writer', model: 'm/1' });
    expect(await (await post(app, '/managed-agents/writer/promote', { version: 1 })).json())
      .toMatchObject({ ok: true, active: 1 });
  });
});
