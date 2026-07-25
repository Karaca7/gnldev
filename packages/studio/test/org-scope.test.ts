// Studio org scope (v1 read-only audit): x-gnl-org → the read surface is scoped to the org;
// writes in an org context return 403; an orgless request runs in the shared space (existing behavior).
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createStudioApi } from '../src/server.js';

async function seed(journal: InMemoryJournal) {
  await journal.put('org:acme:r-acme:model:0', { content: [{ type: 'text', text: 'acme' }], finishReason: 'stop' });
  await journal.put('r-shared:model:0', { content: [{ type: 'text', text: 'shared' }], finishReason: 'stop' });
}

describe('@gnldev/studio org scope (read-only)', () => {
  it('GET /runs is isolated to the org; an orgless request sees the shared space', async () => {
    const journal = new InMemoryJournal();
    await seed(journal);
    const app = createStudioApi({ reader: journal, org: {} });

    const acme = await (await app.request('/runs', { headers: { 'x-gnl-org': 'acme' } })).json();
    expect(acme.map((r: any) => r.runId)).toEqual(['r-acme']);

    const shared = await (await app.request('/runs')).json();
    // The shared view is the raw journal: the acme-prefixed key also shows up as runId 'org:acme:r-acme'
    expect(shared.map((r: any) => r.runId)).toContain('r-shared');
  });

  it('API-01: GET /runs?limit= in an org context does not crash and stays isolated (countRunsByStatus is not bridged per-org)', async () => {
    // InMemoryJournal offers BOTH listRunsPaged and countRunsByStatus, so the org-scoped reader here
    // hits the listRunsPaged push-down branch (see server.ts GET /runs) — but under an active org the
    // countRunsByStatus bridge resolves to `undefined` SYNCHRONOUSLY (organization.ts deliberately
    // doesn't bridge it per-org), which must be handled without throwing (regression guard for the
    // `.catch()`-on-undefined crash).
    const journal = new InMemoryJournal();
    await seed(journal);
    const app = createStudioApi({ reader: journal, org: {} });

    const res = await app.request('/runs?limit=10', { headers: { 'x-gnl-org': 'acme' } });
    expect(res.status).toBe(200);
    const page = await res.json();
    expect(page.items.map((r: any) => r.runId)).toEqual(['r-acme']);
    expect(page.total).toBe(1);
  });

  it('a write (POST) in an org context returns 403; orgless write behavior is unchanged', async () => {
    const journal = new InMemoryJournal();
    await seed(journal);
    const app = createStudioApi({ reader: journal, org: {} });

    const res = await app.request('/runs/r-acme/fork', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gnl-org': 'acme' },
      body: JSON.stringify({ step: 0 }),
    });
    expect(res.status).toBe(403);

    // An orgless POST doesn't hit the middleware (fork isn't configured with resume → 501, NOT 403)
    const res2 = await app.request('/runs/r-shared/fork', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ step: 0 }),
    });
    expect(res2.status).toBe(501);
  });

  it('header-based org resolution: x-gnl-org', async () => {
    const journal = new InMemoryJournal();
    await seed(journal);
    const app = createStudioApi({ reader: journal, org: {} });

    const viaOrgHeader = await (await app.request('/runs', { headers: { 'x-gnl-org': 'acme' } })).json();
    expect(viaOrgHeader.map((r: any) => r.runId)).toEqual(['r-acme']);
  });

  it('capabilities reports the org flag; full backward-compat if org is not given', async () => {
    const journal = new InMemoryJournal();
    const withT = createStudioApi({ reader: journal, org: {} });
    expect((await (await withT.request('/capabilities')).json()).org).toBe(true);

    const without = createStudioApi({ reader: journal });
    const caps = await (await without.request('/capabilities')).json();
    expect(caps.org).toBe(false);
    // even if the header is sent, it has no effect while org scoping is off (regression guard)
    const runs = await (await without.request('/runs', { headers: { 'x-gnl-org': 'acme' } })).json();
    expect(Array.isArray(runs)).toBe(true);
  });
});
