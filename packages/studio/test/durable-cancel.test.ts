// D3-A (AUDIT-R2 yüzey): studio's durable-flag-only cancel affordances — the studio-side
// counterparts of @gnl/server's POST /runs/:id/cancel (P0.3/P2-cancel) and POST /workflows/runs/:id/cancel
// (P0.4). Studio keeps no in-process AbortController registry (see server.ts's own JSDoc on both routes),
// so both endpoints are the durable-flag path only: cancelAgentRun's cross-worker flag for agent runs,
// and the same `${runId}:wf:_canceled` + `wfrun:<runId>` write @gnl/workflow's cancelWorkflowRun performs
// for workflow runs (see workflow-p04.test.ts's comment on this exact key shape).
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnl/durable';
import { createStudioApi } from '../src/server.js';

const post = (app: any, path: string, body: unknown = {}) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('POST /runs/:id/cancel (durable-flag only)', () => {
  it('writes the cancelAgentRun flag, audits, reports capability — idempotent', async () => {
    const journal = new InMemoryJournal();
    await journal.put('r1:input', { prompt: 'hi', _v: 1 });
    const app = createStudioApi({ reader: journal });

    expect((await (await app.request('/capabilities')).json()).runCancel).toBe(true);

    const res = await post(app, '/runs/r1/cancel');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, durable: true });

    // Key shape is an implementation detail of @gnl/durable's cancel.ts — assert via its own public reader.
    const { agentRunCanceled } = await import('@gnl/durable');
    expect(await agentRunCanceled(journal, 'r1')).toMatchObject({ reason: 'studio-cancel' });

    const audit = await (await app.request('/audit?action=run.cancel')).json();
    expect(audit.items).toHaveLength(1);
    expect(audit.items[0]).toMatchObject({ target: 'r1', detail: { durable: true } });

    // idempotent: canceling again never errors.
    const again = await post(app, '/runs/r1/cancel');
    expect(again.status).toBe(200);
  });

  it('unknown run id → 404 (no existence leak); without a writable journal → 501', async () => {
    const journal = new InMemoryJournal();
    const app = createStudioApi({ reader: journal });
    const res = await post(app, '/runs/does-not-exist/cancel');
    expect(res.status).toBe(404);

    const readOnlyApp = createStudioApi({
      reader: { listRuns: async () => [], readRun: async () => [] } as any,
    });
    const res2 = await post(readOnlyApp, '/runs/r1/cancel');
    expect(res2.status).toBe(501);
  });
});

describe('POST /workflows/runs/:id/cancel (durable-flag only, mirrors @gnl/server P0.4)', () => {
  it('cancels a suspended workflow run: writes _canceled + moves the registry record to canceled', async () => {
    const journal = new InMemoryJournal();
    await journal.put('wf-1:wf:step-a', 'ok');
    await journal.put('wf-1:wf:_suspend', { stepId: 'step-b' });
    await journal.put('wfrun:wf-1', { runId: 'wf-1', status: 'suspended', stepId: 'step-b', waitId: 'step-b', updatedAt: 1 });
    const app = createStudioApi({ reader: journal });

    expect((await (await app.request('/capabilities')).json()).workflowRunCancel).toBe(true);

    const res = await post(app, '/workflows/runs/wf-1/cancel');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cancelled: true });

    expect(await journal.get('wf-1:wf:_canceled')).toBeTruthy();
    const reg = (await journal.get('wfrun:wf-1')) as any;
    expect(reg.status).toBe('canceled');
    expect(reg.stepId).toBe('step-b');
    expect(reg.waitId).toBe('step-b');

    const listed = await (await app.request('/workflows/runs?status=canceled')).json();
    expect(listed.map((r: any) => r.runId)).toContain('wf-1');

    const audit = await (await app.request('/audit?action=workflow.cancel')).json();
    expect(audit.items[0]).toMatchObject({ target: 'wf-1', detail: { cancelled: true } });
  });

  it('a run whose registry record is already completed → no-op (cancelled:false)', async () => {
    const journal = new InMemoryJournal();
    await journal.put('wfrun:wf-done', { runId: 'wf-done', status: 'completed', updatedAt: 1 });
    const app = createStudioApi({ reader: journal });
    const res = await post(app, '/workflows/runs/wf-done/cancel');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cancelled: false, note: 'run already completed' });
  });

  it('unknown/never-suspended run id → 404 (no existence leak); no writable journal → 501', async () => {
    const journal = new InMemoryJournal();
    const app = createStudioApi({ reader: journal });
    const res = await post(app, '/workflows/runs/does-not-exist/cancel');
    expect(res.status).toBe(404);

    const noCapApp = createStudioApi({ reader: { listRuns: async () => [], readRun: async () => [] } as any });
    const res2 = await post(noCapApp, '/workflows/runs/wf-x/cancel');
    expect(res2.status).toBe(501);
  });
});
