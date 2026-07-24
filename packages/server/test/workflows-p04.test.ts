// P0.4 (AUDIT-R2): GET /workflows/runs (wfrun: registry query, ?status= filter, org-scoped)
// and POST /workflows/runs/:id/cancel (durable cross-process cancel, write-gated, audited to the ROOT
// journal) — see runs-cancel.test.ts (P0.3) for the sibling agent-run cancel this mirrors.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, listLog } from '@gnl/durable';
import { workflow, step, waitForResume } from '@gnl/workflow';
import { createRestApi } from '../src/index.js';

/** A tiny suspend-on-first-call workflow: 'prepare' runs once, 'approval' waits for a typed resume payload. */
function makeWf() {
  return workflow<string>()
    .then(step('prepare', async (s: string) => s + '!'))
    .then(waitForResume<{ ok: boolean }>('approval'));
}

const runWf = (api: any, runId: string, org: string, extra: Record<string, unknown> = {}) =>
  api.request('/workflows/wf/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gnl-org': org },
    body: JSON.stringify({ runId, input: 'hi', ...extra }),
  });

describe('@gnl/server GET /workflows/runs (P0.4)', () => {
  it('?status= filters; org-scoped — org A does not see org B\'s workflow runs', async () => {
    const journal = new InMemoryJournal();
    const api = createRestApi({ journal, workflows: { wf: makeWf() } }, { org: {} });

    const r1 = await runWf(api, 'wf-acme-1', 'acme');
    expect(r1.status).toBe(200);
    expect((await r1.json()).suspended).toBe(true);
    const r2 = await runWf(api, 'wf-globex-1', 'globex');
    expect((await r2.json()).suspended).toBe(true);

    const acmeRuns = await (await api.request('/workflows/runs', { headers: { 'x-gnl-org': 'acme' } })).json();
    expect(acmeRuns.map((r: any) => r.runId)).toEqual(['wf-acme-1']);
    expect(acmeRuns[0]).toMatchObject({ status: 'suspended', stepId: 'approval', waitId: 'approval' });

    const globexRuns = await (await api.request('/workflows/runs', { headers: { 'x-gnl-org': 'globex' } })).json();
    expect(globexRuns.map((r: any) => r.runId)).toEqual(['wf-globex-1']);

    // ?status=suspended matches both (from their own org's perspective); ?status=completed matches neither yet.
    const acmeSuspended = await (await api.request('/workflows/runs?status=suspended', { headers: { 'x-gnl-org': 'acme' } })).json();
    expect(acmeSuspended.map((r: any) => r.runId)).toEqual(['wf-acme-1']);
    const acmeCompleted = await (await api.request('/workflows/runs?status=completed', { headers: { 'x-gnl-org': 'acme' } })).json();
    expect(acmeCompleted).toEqual([]);

    // resume acme's run to completion → it moves from suspended to completed, globex is unaffected.
    const resumed = await runWf(api, 'wf-acme-1', 'acme', { resume: { approval: { ok: true } } });
    expect((await resumed.json()).output).toEqual({ ok: true });
    const acmeCompletedAfter = await (await api.request('/workflows/runs?status=completed', { headers: { 'x-gnl-org': 'acme' } })).json();
    expect(acmeCompletedAfter.map((r: any) => r.runId)).toEqual(['wf-acme-1']);
    const globexStillSuspended = await (await api.request('/workflows/runs?status=suspended', { headers: { 'x-gnl-org': 'globex' } })).json();
    expect(globexStillSuspended.map((r: any) => r.runId)).toEqual(['wf-globex-1']);
  });

  it('invalid ?status= → 400', async () => {
    const journal = new InMemoryJournal();
    const api = createRestApi({ journal, workflows: { wf: makeWf() } });
    const res = await api.request('/workflows/runs?status=bogus');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid status/);
  });
});

describe('@gnl/server POST /workflows/runs/:id/cancel (P0.4)', () => {
  it('cancels a suspended run — a later resume attempt with the SAME runId reports canceled; audit lands in the ROOT journal', async () => {
    const journal = new InMemoryJournal();
    const api = createRestApi({ journal, workflows: { wf: makeWf() } }, { org: {} });
    await runWf(api, 'wf-acme-2', 'acme');

    const cancelRes = await api.request('/workflows/runs/wf-acme-2/cancel', { method: 'POST', headers: { 'x-gnl-org': 'acme' } });
    expect(cancelRes.status).toBe(200);
    const cancelBody = await cancelRes.json();
    expect(cancelBody).toMatchObject({ ok: true, cancelled: true });

    // subsequent run with the SAME runId (a resume attempt) reports canceled, not completed.
    const after = await runWf(api, 'wf-acme-2', 'acme', { resume: { approval: { ok: true } } });
    expect(after.status).toBe(200);
    const afterBody = await after.json();
    expect(afterBody.canceled).toBe(true);
    expect(afterBody.suspended).toBe(false);

    // idempotent: canceling again is still 200 (cancelWorkflowRun is idempotent while non-completed).
    const again = await api.request('/workflows/runs/wf-acme-2/cancel', { method: 'POST', headers: { 'x-gnl-org': 'acme' } });
    expect(again.status).toBe(200);

    // audit: the 'workflow.cancel' record is in the ROOT journal's __audit__ namespace (not org-prefixed).
    const auditItems = await listLog(journal, '__audit__');
    const entry = auditItems.find((it: any) => it.payload.action === 'workflow.cancel' && it.payload.target === 'wf-acme-2');
    expect(entry).toBeDefined();
    expect((entry!.payload as any).org).toBe('acme');
  });

  it('unknown run id / a run belonging to a different organization → 404 (no existence leak)', async () => {
    const journal = new InMemoryJournal();
    const api = createRestApi({ journal, workflows: { wf: makeWf() } }, { org: {} });
    await runWf(api, 'wf-acme-3', 'acme');

    const unknown = await api.request('/workflows/runs/does-not-exist/cancel', { method: 'POST', headers: { 'x-gnl-org': 'acme' } });
    expect(unknown.status).toBe(404);

    // globex cannot see/cancel acme's run — same 404, no existence leak.
    const crossOrg = await api.request('/workflows/runs/wf-acme-3/cancel', { method: 'POST', headers: { 'x-gnl-org': 'globex' } });
    expect(crossOrg.status).toBe(404);

    // acme itself can cancel its own run.
    const ownScope = await api.request('/workflows/runs/wf-acme-3/cancel', { method: 'POST', headers: { 'x-gnl-org': 'acme' } });
    expect(ownScope.status).toBe(200);
  });
});
