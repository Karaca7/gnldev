// Governance endpoints: /approvals (approval inbox), /audit (audit log), /organizations (org counters + budget).
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnl/durable';
import { createStudioApi } from '../src/server.js';

/** Seeds a suspended run: the model produced a tool-call, the tool is waiting on the suspended sentinel. */
async function seedSuspended(journal: InMemoryJournal, runId = 'sus-1') {
  await journal.put(`${runId}:model:0`, {
    content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'chargeCard', input: '{"amount":99}' }],
    finishReason: 'tool-calls',
  });
  await journal.put(`${runId}:tool:call-1`, {
    status: 'suspended',
    output: { __gnl_suspend: { toolCallId: 'call-1', toolName: 'chargeCard', args: { amount: 99 }, reason: 'high amount' } },
  });
}

describe('governance: /approvals', () => {
  it('lists suspended runs\' pending approvals with args/reason', async () => {
    const journal = new InMemoryJournal();
    await seedSuspended(journal);
    const app = createStudioApi({ reader: journal });
    const res = await (await app.request('/approvals')).json();
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({
      runId: 'sus-1', toolCallId: 'call-1', toolName: 'chargeCard',
      args: { amount: 99 }, reason: 'high amount',
    });
  });

  it('capabilities reports the governance flags', async () => {
    const journal = new InMemoryJournal();
    const app = createStudioApi({ reader: journal, resume: async () => ({}), org: {} });
    const caps = await (await app.request('/capabilities')).json();
    expect(caps.approvals).toBe(true);
    expect(caps.audit).toBe(true);
    expect(caps.organizations).toBe(true);
  });
});

describe('governance: /audit', () => {
  it('a resume decision lands in the audit log (approve + actor header)', async () => {
    const journal = new InMemoryJournal();
    await seedSuspended(journal);
    const app = createStudioApi({ reader: journal, resume: async () => ({ text: 'continue' }) });

    const res = await app.request('/runs/sus-1/resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gnl-actor': 'ayse@acme.co' },
      body: JSON.stringify({ approvals: { 'call-1': true } }),
    });
    expect(res.status).toBe(200);

    const audit = await (await app.request('/audit')).json();
    expect(audit.items).toHaveLength(1);
    expect(audit.items[0]).toMatchObject({ actor: 'ayse@acme.co', action: 'approve', target: 'sus-1' });

    // action filter: a deny search returns empty
    const denies = await (await app.request('/audit?action=deny')).json();
    expect(denies.items).toHaveLength(0);
  });

  it('a rejection is recorded as "deny"', async () => {
    const journal = new InMemoryJournal();
    await seedSuspended(journal, 'sus-2');
    const app = createStudioApi({ reader: journal, resume: async () => ({}) });
    await app.request('/runs/sus-2/resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approvals: { 'call-1': false } }),
    });
    const audit = await (await app.request('/audit?action=deny')).json();
    expect(audit.items).toHaveLength(1);
    expect(audit.items[0].actor).toBe('anon');
  });
});

describe('governance: DELETE /runs/:id (GDPR purge)', () => {
  it('deletes all traces of the run, lands in audit; a neighboring run is left alone', async () => {
    const journal = new InMemoryJournal();
    await seedSuspended(journal, 'del-1');
    await seedSuspended(journal, 'del-10'); // a prefix neighbor — must NOT be touched
    const app = createStudioApi({ reader: journal });

    const res = await app.request('/runs/del-1', { method: 'DELETE', headers: { 'x-gnl-actor': 'dpo@acme.co' } });
    expect(res.status).toBe(200);
    expect((await res.json()).deleted).toBeGreaterThanOrEqual(2);

    const runs = await (await app.request('/runs')).json();
    const ids = runs.map((r: any) => r.runId);
    expect(ids).not.toContain('del-1');
    expect(ids).toContain('del-10');

    const audit = await (await app.request('/audit?action=run.purge')).json();
    expect(audit.items[0]).toMatchObject({ actor: 'dpo@acme.co', target: 'del-1' });
  });
});

describe('governance: /runs/:id/scores', () => {
  it('returns the memoized runtime scores (registry/scoreRun key scheme)', async () => {
    const journal = new InMemoryJournal();
    await journal.put('sc-run:proc:eval:len', { v: { score: 11 } });
    await journal.put('sc-run:proc:eval:judge', { v: { score: 0.9, reason: 'good' } });
    const app = createStudioApi({ reader: journal });
    const res = await (await app.request('/runs/sc-run/scores')).json();
    expect(res.scores.len).toEqual({ score: 11 });
    expect(res.scores.judge).toEqual({ score: 0.9, reason: 'good' });
  });
});

describe('governance: /runs/:id/processors (compliance reports)', () => {
  it('returns findings written via recordProcessorReport (@gnl/durable procreport key scheme)', async () => {
    const journal = new InMemoryJournal();
    await journal.put('proc-run:procreport:pii-redactor:input', { v: { name: 'pii-redactor', phase: 'input', findings: { redactedCount: 2, types: ['email'] }, ts: 1 } });
    await journal.put('proc-run:procreport:prompt-injection:input', { v: { name: 'prompt-injection', phase: 'input', findings: { matched: ['ignore previous'] }, ts: 2 } });
    const app = createStudioApi({ reader: journal });
    const res = await (await app.request('/runs/proc-run/processors')).json();
    expect(res.reports).toHaveLength(2);
    expect(res.reports.map((r: any) => r.name).sort()).toEqual(['pii-redactor', 'prompt-injection']);
  });

  it('an empty list if there is no record (not 500)', async () => {
    const app = createStudioApi({ reader: new InMemoryJournal() });
    const res = await (await app.request('/runs/no-such-run/processors')).json();
    expect(res.reports).toEqual([]);
  });

  it('returns an empty list if the journal is not writable/listKeys (same pattern as scores/scheduler)', async () => {
    const bareReader = { listRuns: async () => [], readRun: async () => undefined };
    const app = createStudioApi({ reader: bareReader as any });
    const res = await (await app.request('/runs/x/processors')).json();
    expect(res.reports).toEqual([]);
  });

  it('capabilities.processors is on for a writable+listKeys journal', async () => {
    const app = createStudioApi({ reader: new InMemoryJournal() });
    const caps = await (await app.request('/capabilities')).json();
    expect(caps.processors).toBe(true);
  });
});

describe('governance: /organizations (counters + budget)', () => {
  async function seedOrgRun(journal: InMemoryJournal, org: string, runId: string) {
    await journal.put(`org:${org}:${runId}:model:0`, {
      content: [{ type: 'text', text: 'ok' }],
      finishReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    });
  }

  it('lists organizations with usage counters; computes budget overrun + webhook fires ONCE', async () => {
    const journal = new InMemoryJournal();
    await seedOrgRun(journal, 'acme', 'r1');
    await seedOrgRun(journal, 'acme', 'r2');
    await seedOrgRun(journal, 'globex', 'r1');
    const hooks: any[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: any, init: any) => { hooks.push(JSON.parse(init.body)); return { ok: true }; }) as any;
    try {
      const app = createStudioApi({
        reader: journal,
        budgets: { default: { tokenLimit: 200 } }, // acme: 300 tokens → exceeds; globex: 150 → doesn't
        alerts: { webhook: 'http://alarm.local/hook' },
      });
      const res = await (await app.request('/organizations')).json();
      const acme = res.organizations.find((o: any) => o.id === 'acme');
      const globex = res.organizations.find((o: any) => o.id === 'globex');
      expect(acme).toMatchObject({ runs: 2, tokens: 300 });
      expect(acme.budget.exceeded).toBe(true);
      expect(globex.budget.exceeded).toBe(false);
      expect(hooks).toHaveLength(1); // only acme, once
      expect(hooks[0]).toMatchObject({ type: 'budget-exceeded', org: 'acme' });

      await app.request('/organizations'); // second call → the marker means the webhook is NOT fired again
      expect(hooks).toHaveLength(1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('a label saved via POST /organizations is returned in the GET /organizations response (bug: it used to never be read)', async () => {
    const journal = new InMemoryJournal();
    await seedOrgRun(journal, 'acme', 'r1');
    const app = createStudioApi({ reader: journal, org: {} }); // POST /organizations requires multi-org
    const create = await app.request('/organizations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'acme', label: 'Acme Inc.' }),
    });
    expect(create.status).toBe(200);

    const res = await (await app.request('/organizations')).json();
    const acme = res.organizations.find((o: any) => o.id === 'acme');
    expect(acme.label).toBe('Acme Inc.');

    // An unlabeled (only discovered, never POSTed) organization has no label field.
    await seedOrgRun(journal, 'globex', 'r1');
    const res2 = await (await app.request('/organizations')).json();
    const globex = res2.organizations.find((o: any) => o.id === 'globex');
    expect(globex.label).toBeUndefined();
  });

  it('budget.inherited: true if the organization has no own __budget__ doc (inherited from default); false if it has its own doc', async () => {
    const journal = new InMemoryJournal();
    await seedOrgRun(journal, 'acme', 'r1');
    await seedOrgRun(journal, 'globex', 'r1');
    await journal.put('__budget__:default', { tokenLimit: 1000 });
    await journal.put('__budget__:acme', { tokenLimit: 500 }); // acme manages its own budget
    const app = createStudioApi({ reader: journal });

    const res = await (await app.request('/organizations')).json();
    const acme = res.organizations.find((o: any) => o.id === 'acme');
    const globex = res.organizations.find((o: any) => o.id === 'globex');
    expect(acme.budget).toMatchObject({ tokenLimit: 500, inherited: false });
    expect(globex.budget).toMatchObject({ tokenLimit: 1000, inherited: true }); // no own doc → default
  });
});

describe('governance: /organizations (CRUD + audit)', () => {
  async function seedOrgRun(journal: InMemoryJournal, org: string, runId: string) {
    await journal.put(`org:${org}:${runId}:model:0`, {
      content: [{ type: 'text', text: 'ok' }],
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
  }

  it('POST /organizations registers it; GET /organizations sees the same record', async () => {
    const journal = new InMemoryJournal();
    const app = createStudioApi({ reader: journal, org: {} });
    const H = { 'content-type': 'application/json' };

    const created = await (await app.request('/organizations', { method: 'POST', headers: H, body: JSON.stringify({ id: 'acme' }) })).json();
    expect(created).toMatchObject({ ok: true, organization: { id: 'acme' } });
    const viaGet = await (await app.request('/organizations')).json();
    expect(viaGet.organizations.map((o: any) => o.id)).toContain('acme');
  });

  it('DELETE /organizations/:id and PUT /organizations/:id/budget write/delete; org.* actions land in audit', async () => {
    const journal = new InMemoryJournal();
    await seedOrgRun(journal, 'acme', 'r1');
    const app = createStudioApi({ reader: journal, org: {} }); // DELETE requires multi-org

    const put = await app.request('/organizations/acme/budget', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tokenLimit: 50 }),
    });
    expect(put.status).toBe(200);
    expect(await journal.get('__budget__:acme')).toMatchObject({ tokenLimit: 50 });

    const del = await app.request('/organizations/acme', { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(await journal.get('org:acme:r1:model:0')).toBeUndefined();
    expect(await journal.get('__budget__:acme')).toBeNull();

    // org.* action names land in audit.
    const audit = await (await app.request('/audit')).json();
    const actions = audit.items.map((i: any) => i.action);
    expect(actions).toContain('org.budget');
    expect(actions).toContain('org.delete');
  });

  it('an operator org-management audit record fills the "org" field from the target (the column doesn\'t stay empty)', async () => {
    // Regression: an operator actor has no orgId → the audit "org" column always looked empty.
    // For org.create/org.delete/org.budget, the relevant org IS the target → org=target should hold.
    const journal = new InMemoryJournal();
    const app = createStudioApi({ reader: journal, org: {} });

    await app.request('/organizations', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'blk1' }),
    });
    await app.request('/organizations/blk1/budget', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tokenLimit: 50 }),
    });
    await app.request('/organizations/blk1', { method: 'DELETE' });

    const audit = await (await app.request('/audit')).json();
    const byAction = Object.fromEntries(audit.items.map((i: any) => [i.action, i]));
    expect(byAction['org.create'].org).toBe('blk1');
    expect(byAction['org.budget'].org).toBe('blk1');
    expect(byAction['org.delete'].org).toBe('blk1');
  });

  it('a deleted organization (no runs, only registered) does NOT remain in the GET /organizations list (tombstone filter)', async () => {
    // Regression: "0 records deleted but it stays on screen". Delete writes null to __org__:id (tombstone),
    // but the old GET still listed it via listKeys → the org came back.
    const journal = new InMemoryJournal();
    const app = createStudioApi({ reader: journal, org: {} });

    const create = await app.request('/organizations', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'blk1' }),
    });
    expect(create.status).toBe(200);
    const before = await (await app.request('/organizations')).json();
    expect(before.organizations.map((o: any) => o.id)).toContain('blk1');

    const del = await app.request('/organizations/blk1', { method: 'DELETE' });
    expect(del.status).toBe(200);

    const after = await (await app.request('/organizations')).json();
    expect(after.organizations.map((o: any) => o.id)).not.toContain('blk1');
  });

  it('capabilities: organizations/orgManage flag names (old tenants/tenantManage REMOVED)', async () => {
    const journal = new InMemoryJournal();
    const app = createStudioApi({ reader: journal, org: {} });
    const caps = await (await app.request('/capabilities')).json();
    expect(caps.organizations).toBe(true);
    expect(caps.orgManage).toBe(true);
    expect(caps.tenants).toBeUndefined();
    expect(caps.tenantManage).toBeUndefined();
  });
});
