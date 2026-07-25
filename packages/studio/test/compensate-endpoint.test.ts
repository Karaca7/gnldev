// POST /runs/:id/compensate — the operator's saga-unwind action. Host-wired (the compensate hooks
// live in code, like resume); without the option → 501. Write-gated; audited with the report summary;
// dryRun is NOT audited (nothing happened).
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { roleAuth } from '@gnldev/auth';
import { createStudioApi } from '../src/server.js';

const report = { runId: 'r1', dryRun: false, condemned: true, entries: [
  { suffix: 'call-2', toolName: 'reserve', status: 'compensated' },
  { suffix: 'call-1', toolName: 'charge', status: 'skipped-no-hook' },
] };

describe('POST /runs/:id/compensate', () => {
  it('forwards to the host compensate, audits the summary counts, reports capability', async () => {
    const calls: [string, unknown][] = [];
    const app = createStudioApi({
      reader: new InMemoryJournal(),
      compensate: async (runId, opts) => { calls.push([runId, opts]); return report; },
    });
    expect((await (await app.request('/capabilities')).json()).compensate).toBe(true);

    const res = await app.request('/runs/r1/compensate', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-gnl-actor': 'ops@acme.co' }, body: '{}',
    });
    expect(res.status).toBe(200);
    expect((await res.json()).report.entries).toHaveLength(2);
    expect(calls).toEqual([['r1', { dryRun: false }]]);

    const audit = await (await app.request('/audit?action=run.compensate')).json();
    expect(audit.items).toHaveLength(1);
    expect(audit.items[0]).toMatchObject({
      actor: 'ops@acme.co', target: 'r1',
      detail: { counts: { compensated: 1, 'skipped-no-hook': 1 } },
    });
  });

  it('dryRun forwards but does NOT audit (nothing happened)', async () => {
    const app = createStudioApi({
      reader: new InMemoryJournal(),
      compensate: async () => ({ ...report, dryRun: true, condemned: false }),
    });
    const res = await app.request('/runs/r1/compensate', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dryRun: true }),
    });
    expect(res.status).toBe(200);
    expect((await (await app.request('/audit?action=run.compensate')).json()).items).toHaveLength(0);
  });

  it('without the host option → 501 (and the capability is off); a viewer → 403', async () => {
    const bare = createStudioApi({ reader: new InMemoryJournal() });
    expect((await (await bare.request('/capabilities')).json()).compensate).toBe(false);
    expect((await bare.request('/runs/r1/compensate', { method: 'POST', body: '{}' })).status).toBe(501);

    const authed = createStudioApi({
      reader: new InMemoryJournal(),
      compensate: async () => report,
      auth: roleAuth({ admin: { token: 'adm' }, viewer: { token: 'viw' } }),
    });
    const denied = await authed.request('/runs/r1/compensate', {
      method: 'POST', headers: { authorization: 'Bearer viw' }, body: '{}',
    });
    expect(denied.status).toBe(403); // an unwind is a WRITE — viewers can look, not undo
  });
});
