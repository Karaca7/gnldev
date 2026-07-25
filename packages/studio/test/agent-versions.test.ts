// Managed agent versions: versions are immutable, promote only moves the 'active' pointer,
// rollback = promoting the older version; every change lands in the audit log.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { roleAuth } from '@gnldev/auth';
import { createStudioApi } from '../src/server.js';

const post = (app: any, path: string, body: unknown, actor = 'dev@acme.co') =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-gnl-actor': actor }, body: JSON.stringify(body) });
const del = (app: any, path: string, actor = 'dev@acme.co') =>
  app.request(path, { method: 'DELETE', headers: { 'x-gnl-actor': actor } });

describe('managed agent versions', () => {
  it('first version is AUTOMATICALLY active; later versions are drafts; promote/rollback moves the pointer; audit is complete', async () => {
    const app = createStudioApi({ reader: new InMemoryJournal() });

    // Create v1 → the FIRST version is auto-promoted to prod (active === 1); create v2 → draft, active stays (1)
    expect((await (await post(app, '/managed-agents', { name: 'writer', model: 'anthropic/claude-sonnet-5', system: 'Write briefly.' })).json())).toMatchObject({ ok: true, version: 1, active: 1 });
    expect((await (await post(app, '/managed-agents', { name: 'writer', model: 'anthropic/claude-fable-5', system: 'Write in detail.', note: 'model upgrade' })).json())).toMatchObject({ ok: true, version: 2, active: 1 });

    const list = await (await app.request('/managed-agents')).json();
    expect(list.agents).toHaveLength(1);
    expect(list.agents[0].versions.map((v: any) => v.version)).toEqual([1, 2]);
    expect(list.agents[0].active).toBe(1);

    // promote v2 → active (previous:1); rollback = promote v1 again (previous:2)
    expect(await (await post(app, '/managed-agents/writer/promote', { version: 2 })).json()).toMatchObject({ ok: true, active: 2, previous: 1 });
    expect(await (await post(app, '/managed-agents/writer/promote', { version: 1 })).json()).toMatchObject({ ok: true, active: 1, previous: 2 });

    // versions are UNCHANGED (immutable) — only the pointer moved
    const after = await (await app.request('/managed-agents')).json();
    expect(after.agents[0].versions).toHaveLength(2);
    expect(after.agents[0].versions[1].model).toBe('anthropic/claude-fable-5');
    expect(after.agents[0].active).toBe(1);

    // audit: 2 version + 3 promote (1 automatic from:null→1 + 2 manual). Order-independent verification
    // (same-ms ties may preserve at-sort insertion order → match on content without assuming position).
    const audit = await (await app.request('/audit?action=agent.promote')).json();
    expect(audit.items).toHaveLength(3);
    expect(audit.items.every((i: any) => i.actor === 'dev@acme.co' && i.target === 'writer')).toBe(true);
    const details = audit.items.map((i: any) => i.detail);
    expect(details).toContainEqual({ from: null, to: 1, auto: true }); // automatic first-promote
    expect(details).toContainEqual({ from: 1, to: 2 });
    expect(details).toContainEqual({ from: 2, to: 1 });
    const versions = await (await app.request('/audit?action=agent.version')).json();
    expect(versions.items).toHaveLength(2);
  });

  it('runtime binding: the active version becomes a run/stream override; a user override OVERRIDES it', async () => {
    const received: any[] = [];
    const app = createStudioApi({
      reader: new InMemoryJournal(),
      gnl: {
        // 'writer' + 'other' are code-defined → managed versions may govern them (see the 422 guard test below).
        listAgents: () => [
          { name: 'writer', model: 'anthropic/claude-sonnet-5', hasTools: false, maxSteps: 4 },
          { name: 'other', model: 'anthropic/claude-sonnet-5', hasTools: false, maxSteps: 4 },
        ],
        run: async (_n, o) => { received.push(o); return { text: 'ok' }; },
      },
    });
    await post(app, '/managed-agents', { name: 'writer', model: 'anthropic/claude-fable-5', system: 'V2 rules.' });
    await post(app, '/managed-agents/writer/promote', { version: 1 });

    // The active version kicks in
    await post(app, '/agents/writer/run', { runId: 'r1', prompt: 'x' });
    expect(received[0]).toMatchObject({ model: 'anthropic/claude-fable-5', system: 'V2 rules.' });

    // The playground's explicit override overrides the managed version
    await post(app, '/agents/writer/run', { runId: 'r2', prompt: 'x', model: 'openai/gpt-4o', system: 'trial' });
    expect(received[1]).toMatchObject({ model: 'openai/gpt-4o', system: 'trial' });

    // No override for an agent that was never promoted
    await post(app, '/agents/other/run', { runId: 'r3', prompt: 'x' });
    expect(received[2].model).toBeUndefined();
  });

  it('governance boundary: with a runner, versioning a name that is NOT code-defined → 422 (no orphan records)', async () => {
    // Managed versions govern CODE-defined agents; they are not a no-code agent factory. When a runner is
    // wired, creating a version for a name absent from the code registry is rejected (would never run).
    const app = createStudioApi({
      reader: new InMemoryJournal(),
      gnl: { listAgents: () => [{ name: 'writer', model: 'm/1', hasTools: false, maxSteps: 4 }], run: async () => ({ text: 'ok' }) },
    });
    // code-defined → allowed
    expect((await post(app, '/managed-agents', { name: 'writer', model: 'm/2' })).status).toBe(200);
    // NOT code-defined → 422, and no record is created
    const res = await post(app, '/managed-agents', { name: 'ghost', model: 'm/1' });
    expect(res.status).toBe(422);
    const list = await (await app.request('/managed-agents')).json();
    expect(list.agents.map((a: any) => a.name)).toEqual(['writer']);
  });

  it('validations: missing field → 400, unknown agent → 404, nonexistent version → 400; capabilities flag', async () => {
    const app = createStudioApi({ reader: new InMemoryJournal() });
    expect((await post(app, '/managed-agents', { name: 'x' })).status).toBe(400); // no model
    expect((await post(app, '/managed-agents/nope/promote', { version: 1 })).status).toBe(404);
    await post(app, '/managed-agents', { name: 'a', model: 'm/1' });
    expect((await post(app, '/managed-agents/a/promote', { version: 9 })).status).toBe(400);

    const caps = await (await app.request('/capabilities')).json();
    expect(caps.agentVersions).toBe(true);
  });
});

describe('DELETE /managed-agents/:name (PERMANENTLY delete a managed agent record)', () => {
  it('deletes it with ALL its versions (NOT a tombstone — a real delete), lands in audit, no longer appears in the GET list', async () => {
    const app = createStudioApi({ reader: new InMemoryJournal() });
    await post(app, '/managed-agents', { name: 'dd', model: 'anthropic/claude-sonnet-5' });
    await post(app, '/managed-agents', { name: 'dd', model: 'anthropic/claude-fable-5' });
    await post(app, '/managed-agents/dd/promote', { version: 1 });

    const res = await del(app, '/managed-agents/dd', 'deleter@acme.co');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, name: 'dd' });

    const list = await (await app.request('/managed-agents')).json();
    expect(list.agents).toHaveLength(0);

    const audit = await (await app.request('/audit?action=agent.delete')).json();
    expect(audit.items).toHaveLength(1);
    expect(audit.items[0]).toMatchObject({ actor: 'deleter@acme.co', target: 'dd', detail: { versions: 2, hadActive: true } });
  });

  it('unknown agent → 404', async () => {
    const app = createStudioApi({ reader: new InMemoryJournal() });
    expect((await del(app, '/managed-agents/nope')).status).toBe(404);
  });

  it('no write permission (viewer role) → 403; the record is not deleted', async () => {
    const app = createStudioApi({
      reader: new InMemoryJournal(),
      auth: roleAuth({ admin: { token: 'adm' }, viewer: { token: 'viw' } }),
    });
    await app.request('/managed-agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer adm' },
      body: JSON.stringify({ name: 'a', model: 'm/1' }),
    });
    const res = await app.request('/managed-agents/a', { method: 'DELETE', headers: { authorization: 'Bearer viw' } });
    expect(res.status).toBe(403);
    const list = await (await app.request('/managed-agents', { headers: { authorization: 'Bearer viw' } })).json();
    expect(list.agents).toHaveLength(1);
  });

  it('501 if the journal does not support deletePrefix; the record is left undeleted', async () => {
    // Simulates a host journal without deletePrefix (i.e. not Sqlite/Postgres/InMemory) — put/get/listKeys
    // exist (agentStoreEnabled is on) but deletePrefix is missing → store.delete is never defined, the endpoint returns 501.
    const inner = new InMemoryJournal();
    const reader = {
      get: inner.get.bind(inner),
      put: inner.put.bind(inner),
      listKeys: inner.listKeys.bind(inner),
      listRuns: inner.listRuns.bind(inner),
      readRun: inner.readRun.bind(inner),
    };
    const app = createStudioApi({ reader: reader as any });
    await post(app, '/managed-agents', { name: 'a', model: 'm/1' });

    const res = await del(app, '/managed-agents/a');
    expect(res.status).toBe(501);

    const list = await (await app.request('/managed-agents')).json();
    expect(list.agents).toHaveLength(1); // not deleted
  });

  it('prefix-collision safe: deleting "dd" leaves the same-prefix neighbor "dd2" UNTOUCHED', async () => {
    // AGENT_STORE_PRE + name has no trailing separator — 'dd' is an EXACT string prefix of another
    // agent's name ('dd2'). A naive deletePrefix('...:dd') would sweep the neighbor too (see the run
    // purge test against the same class of bug in governance.test.ts's 'del-1'/'del-10' case) — verified
    // here for the agent store.
    const app = createStudioApi({ reader: new InMemoryJournal() });
    await post(app, '/managed-agents', { name: 'dd', model: 'm/1' });
    await post(app, '/managed-agents', { name: 'dd2', model: 'm/2' });

    expect((await del(app, '/managed-agents/dd')).status).toBe(200);

    const list = await (await app.request('/managed-agents')).json();
    expect(list.agents.map((a: any) => a.name)).toEqual(['dd2']);
    expect(list.agents[0].versions).toHaveLength(1); // the neighbor's own data is intact
  });
});

describe('DELETE /managed-agents/:name/versions/:version (delete a single version)', () => {
  it('deletes a version that is NOT active; active stays unchanged; lands in audit', async () => {
    const app = createStudioApi({ reader: new InMemoryJournal() });
    await post(app, '/managed-agents', { name: 'a', model: 'm/1' }); // v1 → auto-active
    await post(app, '/managed-agents', { name: 'a', model: 'm/2' }); // v2 draft

    const res = await del(app, '/managed-agents/a/versions/2', 'deleter@acme.co');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, name: 'a', version: 2, active: 1, remaining: 1 });

    const list = await (await app.request('/managed-agents')).json();
    expect(list.agents[0].versions.map((v: any) => v.version)).toEqual([1]);
    expect(list.agents[0].active).toBe(1);

    const audit = await (await app.request('/audit?action=agent.version-delete')).json();
    expect(audit.items[0]).toMatchObject({ actor: 'deleter@acme.co', target: 'a', detail: { version: 2, remaining: 1 } });
  });

  it('the ACTIVE (prod) version cannot be deleted → 409; the record is unchanged', async () => {
    const app = createStudioApi({ reader: new InMemoryJournal() });
    await post(app, '/managed-agents', { name: 'a', model: 'm/1' }); // v1 active
    await post(app, '/managed-agents', { name: 'a', model: 'm/2' });

    const res = await del(app, '/managed-agents/a/versions/1');
    expect(res.status).toBe(409);

    const list = await (await app.request('/managed-agents')).json();
    expect(list.agents[0].versions).toHaveLength(2); // not deleted
  });

  it('nonexistent version → 400; unknown agent → 404', async () => {
    const app = createStudioApi({ reader: new InMemoryJournal() });
    await post(app, '/managed-agents', { name: 'a', model: 'm/1' });
    expect((await del(app, '/managed-agents/a/versions/9')).status).toBe(400);
    expect((await del(app, '/managed-agents/nope/versions/1')).status).toBe(404);
  });

  it('deleting the last (only) version removes the agent record entirely', async () => {
    // No evalGate, but a single active version → promoting another one is required first to delete it.
    // Here: a two-drafts scenario — eval gate on → neither auto-activates, both stay drafts; delete one, then the other.
    const app = createStudioApi({ reader: new InMemoryJournal(), evalGate: { datasetId: 'd' }, datasets: { run: async () => ({ aggregate: {} }) } as any });
    await post(app, '/managed-agents', { name: 'a', model: 'm/1' }); // draft (gate on → not active)
    await post(app, '/managed-agents', { name: 'a', model: 'm/2' }); // draft

    expect((await del(app, '/managed-agents/a/versions/1')).status).toBe(200);
    const r2 = await del(app, '/managed-agents/a/versions/2');
    expect(r2.status).toBe(200);
    expect(await r2.json()).toMatchObject({ remaining: 0 });

    const list = await (await app.request('/managed-agents')).json();
    expect(list.agents).toHaveLength(0); // the record is completely gone
  });
});
