// Studio auth↔org consistency: /events is gated (?token= fallback), the audit actor is derived
// from the principal (header spoofing doesn't work when auth is on), an identity bound to an
// organization sees only itself in /organizations, and the read surface is automatically scoped
// to its own organization.
import { describe, it, expect, vi } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { roleAuth, type AuthProvider } from '@gnldev/auth';
import { createStudioApi } from '../src/server.js';
import { call } from './call.js';

// The admin here is the PLATFORM operator — unbound on purpose, working across organizations. It says
// so via the `superAdmin` class rather than by omitting `orgId`: with `org` configured, an unbound
// identity is fail-closed, and the platform scope is an explicit grant (see @gnldev/auth scope.ts).
const AUTH = () => roleAuth({
  superAdmin: { token: 'adm', user: 'ops' },
  viewer: { token: 'viw', orgId: 'acme' },
});

async function seed(journal: InMemoryJournal) {
  await journal.put('org:acme:r-acme:model:0', { content: [{ type: 'text', text: 'a' }], finishReason: 'stop' });
  await journal.put('org:globex:r-globex:model:0', { content: [{ type: 'text', text: 'g' }], finishReason: 'stop' });
}

describe('@gnldev/studio auth↔org', () => {
  it('/events is auth-gated: 401 without identity, 200 with ?token= (EventSource fallback)', async () => {
    const app = createStudioApi({ reader: new InMemoryJournal(), auth: AUTH() });
    expect((await call(app, '/events')).status).toBe(401);

    const ok = await call(app, '/events?token=viw');
    expect(ok.status).toBe(200);
    await ok.body?.cancel(); // close the infinite SSE stream
  });

  it('audit actor comes from the principal: id if basic/user exists, otherwise role:<role>; x-gnl-actor spoofing does not work', async () => {
    const journal = new InMemoryJournal();
    const app = createStudioApi({ reader: journal, auth: AUTH() });

    const put = (headers: Record<string, string>) => call(app, '/policy', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ rules: [] }),
    });

    expect((await put({ authorization: 'Bearer adm', 'x-gnl-actor': 'fake-person' })).status).toBe(200);
    const audit = await (await call(app, '/audit?action=policy.update', {
      headers: { authorization: 'Bearer adm' },
    })).json();
    expect(audit.items[0].actor).toBe('ops'); // NOT the header's 'fake-person'
  });

  it('an org-bound viewer: the read surface is automatically its own organization; a different org header returns 403', async () => {
    const journal = new InMemoryJournal();
    await seed(journal);
    const app = createStudioApi({ reader: journal, auth: AUTH(), org: {} });

    // no header: principal.orgId (acme) scopes it
    const runs = await (await call(app, '/runs', { headers: { authorization: 'Bearer viw' } })).json();
    expect(runs.map((r: any) => r.runId)).toEqual(['r-acme']);

    // requesting a different org → 403
    const res = await call(app, '/runs', {
      headers: { authorization: 'Bearer viw', 'x-gnl-org': 'globex' },
    });
    expect(res.status).toBe(403);
  });

  it('/organizations: a bound identity sees ONLY its own org; a global admin sees all of them', async () => {
    const journal = new InMemoryJournal();
    await seed(journal);
    const app = createStudioApi({ reader: journal, auth: AUTH(), org: {} });

    const all = await (await call(app, '/organizations', { headers: { authorization: 'Bearer adm' } })).json();
    expect(all.organizations.map((t: any) => t.id)).toEqual(['acme', 'globex']);

    const own = await (await call(app, '/organizations', { headers: { authorization: 'Bearer viw' } })).json();
    expect(own.organizations.map((t: any) => t.id)).toEqual(['acme']);
  });

  it('budget management: PUT /organizations/:id/budget writes to the journal (admin), GET /organizations merges it, viewer gets 403', async () => {
    const journal = new InMemoryJournal();
    await seed(journal);
    const app = createStudioApi({ reader: journal, auth: AUTH() });

    const put = (id: string, body: unknown, token: string) => call(app, `/organizations/${id}/budget`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

    expect((await put('acme', { tokenLimit: 500 }, 'viw')).status).toBe(403); // viewer can't write
    expect((await put('acme', { tokenLimit: -5 }, 'adm')).status).toBe(400); // validation
    expect((await put('acme', { tokenLimit: 500, usdLimit: 2 }, 'adm')).status).toBe(200);
    expect(await journal.get('__budget__:acme')).toEqual({ tokenLimit: 500, usdLimit: 2 });

    // GET /organizations merges the journal budget + returns defaultBudget
    expect((await put('default', { usdLimit: 1 }, 'adm')).status).toBe(200);
    const res = await (await call(app, '/organizations', { headers: { authorization: 'Bearer adm' } })).json();
    const acme = res.organizations.find((t: any) => t.id === 'acme');
    expect(acme.budget).toMatchObject({ tokenLimit: 500, usdLimit: 2 });
    const globex = res.organizations.find((t: any) => t.id === 'globex'); // no own doc → default
    expect(globex.budget).toMatchObject({ usdLimit: 1 });
    expect(res.defaultBudget).toEqual({ usdLimit: 1 });

    // landed in audit + actor comes from the principal
    const audit = await (await call(app, '/audit?action=org.budget', { headers: { authorization: 'Bearer adm' } })).json();
    expect(audit.items.length).toBe(2);
    expect(audit.items[0].actor).toBe('ops');

    // empty body → the budget is deleted
    expect((await put('acme', {}, 'adm')).status).toBe(200);
    expect(await journal.get('__budget__:acme')).toBeNull();
  });

  it('F1: an org-bound admin can only write ITS OWN budget; another org / default returns 403', async () => {
    const journal = new InMemoryJournal();
    // an admin bound to acme (write-authorized) + an unbound operator admin.
    const auth = roleAuth({
      admin: { token: 'ops', user: 'operator' },        // unbound operator
      viewer: { token: 'acme-adm', orgId: 'acme' },  // (viewer slot; a separate bound-admin auth below)
    });
    void auth;
    const boundAdmin = roleAuth({ admin: { token: 'acme-adm', orgId: 'acme' } });
    const app = createStudioApi({ reader: journal, auth: boundAdmin }); // no org → reaches the write handler

    const put = (id: string, body: unknown) => call(app, `/organizations/${id}/budget`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: 'Bearer acme-adm' },
      body: JSON.stringify(body),
    });

    expect((await put('acme', { tokenLimit: 100 })).status).toBe(200);   // its own org
    expect((await put('globex', { tokenLimit: 1 })).status).toBe(403);   // another org
    expect((await put('default', { tokenLimit: 1 })).status).toBe(403);  // can't manage the default fallback either
    expect(await journal.get('__budget__:acme')).toEqual({ tokenLimit: 100 });
    expect(await journal.get('__budget__:globex')).toBeUndefined();
  });

  it('F4: an org-bound admin (org enabled) can WRITE without a header; reads are scoped to its own org', async () => {
    const journal = new InMemoryJournal();
    await journal.put('org:acme:r-acme:model:0', { content: [{ type: 'text', text: 'a' }], finishReason: 'stop' });
    const boundAdmin = roleAuth({ admin: { token: 'acme-adm', orgId: 'acme' } });
    const app = createStudioApi({ reader: journal, auth: boundAdmin, org: {} });
    const H = { authorization: 'Bearer acme-adm' };

    // WRITE: without a header, a budget PUT targeting ITS OWN org → 200 (previously binding locked out
    // all writes). NOTE: /policy is now root-level (global) management, so a bound identity ALWAYS gets
    // 403 (Phase 0.1) — that behavior is covered separately (see 'operator required').
    const wr = await call(app, '/organizations/acme/budget', {
      method: 'PUT', headers: { 'content-type': 'application/json', ...H }, body: JSON.stringify({ tokenLimit: 10 }),
    });
    expect(wr.status).toBe(200);

    // READ: GET /runs without a header is scoped to the bound identity's org (acme only).
    const runs = await (await call(app, '/runs', { headers: H })).json();
    expect(runs.map((r: any) => r.runId)).toEqual(['r-acme']);
  });

  it('B: create/delete an organization — POST registers it (no runs yet), DELETE removes all traces + the record/budget', async () => {
    const journal = new InMemoryJournal();
    const app = createStudioApi({ reader: journal, auth: AUTH(), org: {} });
    const H = { 'content-type': 'application/json', authorization: 'Bearer adm' };

    // capabilities: orgManage is on
    expect((await (await call(app, '/capabilities')).json()).orgManage).toBe(true);

    // POST /organizations → registers it; appears in GET /organizations even without any runs
    expect((await call(app, '/organizations', { method: 'POST', headers: H, body: JSON.stringify({ id: 'acme', label: 'Acme Inc.' }) })).status).toBe(200);
    const list1 = await (await call(app, '/organizations', { headers: { authorization: 'Bearer adm' } })).json();
    expect(list1.organizations.map((t: any) => t.id)).toContain('acme');

    // Creating again → 409; 'default' is reserved → 400; viewer can't write → 403
    expect((await call(app, '/organizations', { method: 'POST', headers: H, body: JSON.stringify({ id: 'acme' }) })).status).toBe(409);
    expect((await call(app, '/organizations', { method: 'POST', headers: H, body: JSON.stringify({ id: 'default' }) })).status).toBe(400);
    expect((await call(app, '/organizations', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer viw' }, body: JSON.stringify({ id: 'x' }) })).status).toBe(403);

    // Put data + budget under the org, then DELETE → everything should be gone
    await journal.put('org:acme:r1:model:0', { content: [{ type: 'text', text: 'a' }], finishReason: 'stop' });
    await journal.put('__budget__:acme', { tokenLimit: 5 });
    const del = await call(app, '/organizations/acme', { method: 'DELETE', headers: { authorization: 'Bearer adm' } });
    expect(del.status).toBe(200);
    expect((await del.json()).deleted).toBeGreaterThan(0);
    expect(await journal.get('org:acme:r1:model:0')).toBeUndefined();
    expect(await journal.get('__org__:acme')).toBeNull();
    expect(await journal.get('__budget__:acme')).toBeNull();

    // create + delete landed in audit (new action names: org.create/org.delete — the old
    // tenant.create/tenant.delete were fully removed).
    const audit = await (await call(app, '/audit', { headers: { authorization: 'Bearer adm' } })).json();
    const actions = audit.items.map((i: any) => i.action);
    expect(actions).toContain('org.create');
    expect(actions).toContain('org.delete');
  });

  it('B2: an org-bound identity cannot create/delete an organization (403)', async () => {
    const journal = new InMemoryJournal();
    const boundAdmin = roleAuth({ admin: { token: 'acme-adm', orgId: 'acme' } });
    const app = createStudioApi({ reader: journal, auth: boundAdmin, org: {} });
    const H = { 'content-type': 'application/json', authorization: 'Bearer acme-adm' };
    expect((await call(app, '/organizations', { method: 'POST', headers: H, body: JSON.stringify({ id: 'globex' }) })).status).toBe(403);
    expect((await call(app, '/organizations/globex', { method: 'DELETE', headers: { authorization: 'Bearer acme-adm' } })).status).toBe(403);
  });

  // Fake userStore (studio contract) — the real journal-backed store is covered in the auth-ee test.
  // withRevoke=false → the optional revoke field is never given (backward-compat: old hosts don't know revoke).
  function fakeUserStore(withRevoke = true) {
    const mem = new Map<string, { id: string; email?: string; roles: string[]; orgId?: string; createdAt: number; revoked?: boolean }>();
    let seq = 0;
    return {
      mem,
      list: () => [...mem.values()],
      create: async (i: { email?: string; roles?: string[]; orgId?: string; ttlMs?: number; expiresAt?: number }) => {
        const id = i.email ?? `u${++seq}`;
        const user = { id, email: i.email, roles: i.roles ?? ['viewer'], orgId: i.orgId, createdAt: 1 };
        mem.set(id, user);
        return { user, token: 'eeu_secret_' + id };
      },
      remove: async (id: string) => { mem.delete(id); },
      ...(withRevoke ? { revoke: async (id: string) => { const u = mem.get(id); if (u) u.revoked = true; } } : {}),
    };
  }

  it('C: ORGANIZATION model — an operator adds a member to an existing organization; a ghost org returns 400; token issued once', async () => {
    const users = fakeUserStore();
    const journal = new InMemoryJournal();
    const app = createStudioApi({ reader: journal, auth: AUTH(), users, org: {} }); // AUTH admin=ops (unbound operator)
    const H = { 'content-type': 'application/json', authorization: 'Bearer adm' };

    expect((await (await call(app, '/capabilities')).json()).userManage).toBe(true);

    // First CREATE the organization, then add a member to that organization.
    await call(app, '/organizations', { method: 'POST', headers: H, body: JSON.stringify({ id: 'acme' }) });
    const cr = await (await call(app, '/users', { method: 'POST', headers: H, body: JSON.stringify({ email: 'ayse@acme.co', roles: ['admin'], orgId: 'acme' }) })).json();
    expect(cr.user.id).toBe('ayse@acme.co');
    expect(cr.token).toMatch(/^eeu_/);

    // Member of a GHOST organization → 400 (validates against an existing organization)
    expect((await call(app, '/users', { method: 'POST', headers: H, body: JSON.stringify({ email: 'x@ghost.co', orgId: 'ghost' }) })).status).toBe(400);

    // Orgless (operator) member → 200 is legitimate
    expect((await call(app, '/users', { method: 'POST', headers: H, body: JSON.stringify({ email: 'op2@platform.co', roles: ['admin'] }) })).status).toBe(200);

    // list → no secret (no token)
    const list = await (await call(app, '/users', { headers: { authorization: 'Bearer adm' } })).json();
    expect(JSON.stringify(list)).not.toContain('eeu_');
    expect(list.users.map((u: any) => u.id).sort()).toEqual(['ayse@acme.co', 'op2@platform.co']);

    // viewer can't write
    expect((await call(app, '/users', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer viw' }, body: '{}' })).status).toBe(403);

    // delete → audit
    expect((await call(app, '/users/ayse@acme.co', { method: 'DELETE', headers: { authorization: 'Bearer adm' } })).status).toBe(200);
    const audit = await (await call(app, '/audit', { headers: { authorization: 'Bearer adm' } })).json();
    const actions = audit.items.map((i: any) => i.action);
    expect(actions).toContain('user.create');
    expect(actions).toContain('user.delete');
  });

  it('C2: an ORGANIZATION-ADMIN manages its own organization\'s members — the target is forced to itself, another org returns 403', async () => {
    const users = fakeUserStore();
    // Prepare the members an org-admin sees: one in acme, one in globex.
    users.mem.set('a@acme.co', { id: 'a@acme.co', roles: ['viewer'], orgId: 'acme', createdAt: 1 });
    users.mem.set('g@globex.co', { id: 'g@globex.co', roles: ['viewer'], orgId: 'globex', createdAt: 1 });
    const journal = new InMemoryJournal();
    const boundAdmin = roleAuth({ admin: { token: 'acme-adm', orgId: 'acme' } });
    const app = createStudioApi({ reader: journal, auth: boundAdmin, users });
    const H = { 'content-type': 'application/json', authorization: 'Bearer acme-adm' };

    // list → ONLY its own organization's members
    const list = await (await call(app, '/users', { headers: { authorization: 'Bearer acme-adm' } })).json();
    expect(list.users.map((u: any) => u.id)).toEqual(['a@acme.co']);

    // create: even without orgId, it's assigned to ITS OWN organization
    const cr = await (await call(app, '/users', { method: 'POST', headers: H, body: JSON.stringify({ email: 'yeni@acme.co', roles: ['viewer'] }) })).json();
    expect(cr.user.orgId).toBe('acme');

    // create: requesting ANOTHER organization → 403
    expect((await call(app, '/users', { method: 'POST', headers: H, body: JSON.stringify({ email: 'z@globex.co', orgId: 'globex' }) })).status).toBe(403);

    // delete: its OWN member → 200, another organization's member → 403
    expect((await call(app, '/users/yeni@acme.co', { method: 'DELETE', headers: { authorization: 'Bearer acme-adm' } })).status).toBe(200);
    expect((await call(app, '/users/g@globex.co', { method: 'DELETE', headers: { authorization: 'Bearer acme-adm' } })).status).toBe(403);
    expect(users.mem.has('g@globex.co')).toBe(true); // not deleted
  });

  it('C3: /me returns the logged-in identity + the operator flag', async () => {
    const users = fakeUserStore();
    const app = createStudioApi({ reader: new InMemoryJournal(), auth: AUTH(), users });
    const op = await (await call(app, '/me', { headers: { authorization: 'Bearer adm' } })).json();
    expect(op).toMatchObject({ id: 'ops', operator: true, orgId: null });

    const boundApp = createStudioApi({ reader: new InMemoryJournal(), auth: roleAuth({ admin: { token: 't', orgId: 'acme' } }) });
    const me = await (await call(boundApp, '/me', { headers: { authorization: 'Bearer t' } })).json();
    expect(me).toMatchObject({ operator: false, orgId: 'acme' });
  });

  it('C4: if no userStore is given, userManage is off, /users is empty', async () => {
    const app = createStudioApi({ reader: new InMemoryJournal(), auth: AUTH() });
    expect((await (await call(app, '/capabilities')).json()).userManage).toBe(false);
    const list = await (await call(app, '/users', { headers: { authorization: 'Bearer adm' } })).json();
    expect(list.users).toEqual([]);
  });

  it('C5: POST /users/:id/revoke — the user is NOT deleted but is revoked; audit user.revoke; viewer can\'t write', async () => {
    const users = fakeUserStore();
    const journal = new InMemoryJournal();
    const app = createStudioApi({ reader: journal, auth: AUTH(), users, org: {} });
    const H = { 'content-type': 'application/json', authorization: 'Bearer adm' };

    await call(app, '/organizations', { method: 'POST', headers: H, body: JSON.stringify({ id: 'acme' }) });
    await call(app, '/users', { method: 'POST', headers: H, body: JSON.stringify({ email: 'r@acme.co', orgId: 'acme' }) });

    // viewer can't revoke
    expect((await call(app, '/users/r@acme.co/revoke', { method: 'POST', headers: { authorization: 'Bearer viw' } })).status).toBe(403);

    const res = await call(app, '/users/r@acme.co/revoke', { method: 'POST', headers: H });
    expect(res.status).toBe(200);
    expect(users.mem.get('r@acme.co')).toBeTruthy(); // record NOT deleted
    expect(users.mem.get('r@acme.co')?.revoked).toBe(true);

    const audit = await (await call(app, '/audit', { headers: { authorization: 'Bearer adm' } })).json();
    expect(audit.items.map((i: any) => i.action)).toContain('user.revoke');
  });

  it('C6: an org-admin can only revoke its OWN member; another organization returns 403', async () => {
    const users = fakeUserStore();
    users.mem.set('a@acme.co', { id: 'a@acme.co', roles: ['viewer'], orgId: 'acme', createdAt: 1 });
    users.mem.set('g@globex.co', { id: 'g@globex.co', roles: ['viewer'], orgId: 'globex', createdAt: 1 });
    const boundAdmin = roleAuth({ admin: { token: 'acme-adm', orgId: 'acme' } });
    const app = createStudioApi({ reader: new InMemoryJournal(), auth: boundAdmin, users });
    const H = { authorization: 'Bearer acme-adm' };

    expect((await call(app, '/users/g@globex.co/revoke', { method: 'POST', headers: H })).status).toBe(403);
    expect(users.mem.get('g@globex.co')?.revoked).toBeFalsy();
    expect((await call(app, '/users/a@acme.co/revoke', { method: 'POST', headers: H })).status).toBe(200);
    expect(users.mem.get('a@acme.co')?.revoked).toBe(true);
  });

  it('C7: returns 501 if the host doesn\'t support revoke (backward-compat)', async () => {
    const users = fakeUserStore(false); // NO revoke
    const app = createStudioApi({ reader: new InMemoryJournal(), auth: AUTH(), users });
    const H = { 'content-type': 'application/json', authorization: 'Bearer adm' };
    await call(app, '/users', { method: 'POST', headers: H, body: JSON.stringify({ email: 'x@y.co' }) });
    expect((await call(app, '/users/x@y.co/revoke', { method: 'POST', headers: H })).status).toBe(501);
  });

  it('FREE: when multi-org is off, the organization surface is HIDDEN (a single implicit organization)', async () => {
    // Free tier: no org + roleAuth (multiOrganization:false) → org flags are off, management is blocked.
    const app = createStudioApi({ reader: new InMemoryJournal(), auth: AUTH() });
    const caps = await (await call(app, '/capabilities')).json();
    expect(caps.organizations).toBe(false);       // the "Organizations" nav doesn't show up in the UI
    expect(caps.orgManage).toBe(false);
    expect(caps.budgetManage).toBe(false);

    // The endpoint is blocked too: creating an organization → 501 (single org)
    const res = await call(app, '/organizations', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer adm' }, body: JSON.stringify({ id: 'x' }),
    });
    expect(res.status).toBe(501);

    // PRO: opens up when org is enabled
    const pro = createStudioApi({ reader: new InMemoryJournal(), auth: AUTH(), org: {} });
    const proCaps = await (await call(pro, '/capabilities')).json();
    expect(proCaps.organizations).toBe(true);
    expect(proCaps.orgManage).toBe(true);
  });

  it('D: agent versions are ORGANIZATION-SCOPED — a bound admin only sees/manages its own organization\'s versions', async () => {
    const journal = new InMemoryJournal();
    const acmeAdmin = roleAuth({ admin: { token: 'acme-adm', orgId: 'acme' } });
    const opAdmin = roleAuth({ admin: { token: 'op' } }); // unbound operator

    const acmeApp = createStudioApi({ reader: journal, auth: acmeAdmin });
    const opApp = createStudioApi({ reader: journal, auth: opAdmin });
    const H = (t: string) => ({ 'content-type': 'application/json', authorization: `Bearer ${t}` });

    // the acme admin creates a version in the acme namespace
    expect((await call(acmeApp, '/managed-agents', { method: 'POST', headers: H('acme-adm'), body: JSON.stringify({ name: 'bot', model: 'm-acme' }) })).status).toBe(200);
    // the operator creates a separate version in the root namespace
    expect((await call(opApp, '/managed-agents', { method: 'POST', headers: H('op'), body: JSON.stringify({ name: 'bot', model: 'm-root' }) })).status).toBe(200);

    // ISOLATION: the acme admin sees only its own 'bot' (m-acme)
    const acmeList = await (await call(acmeApp, '/managed-agents', { headers: { authorization: 'Bearer acme-adm' } })).json();
    expect(acmeList.agents).toHaveLength(1);
    expect(acmeList.agents[0].versions[0].model).toBe('m-acme');

    // the operator sees the root 'bot' (m-root) — not acme's
    const opList = await (await call(opApp, '/managed-agents', { headers: { authorization: 'Bearer op' } })).json();
    expect(opList.agents).toHaveLength(1);
    expect(opList.agents[0].versions[0].model).toBe('m-root');

    // Separate prefixes in the journal: root __studio_agent__:bot + org t:acme:__studio_agent__:bot
    expect(await journal.get('__studio_agent__:bot')).toBeTruthy();
    expect(await journal.get('org:acme:__studio_agent__:bot')).toBeTruthy();
  });

  it('F7: x-gnl-actor is PRESERVED for a token-only cred (person trail); if a basic user exists, id wins', async () => {
    const journal = new InMemoryJournal();
    const tokenOnly = roleAuth({ admin: { token: 'adm' } }); // no user → no principal.id
    const app = createStudioApi({ reader: journal, auth: tokenOnly });

    const putPolicy = (actor?: string) => call(app, '/policy', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: 'Bearer adm', ...(actor ? { 'x-gnl-actor': actor } : {}) },
      body: JSON.stringify({ rules: [] }),
    });

    expect((await putPolicy('ayse@acme.co')).status).toBe(200);
    expect((await putPolicy()).status).toBe(200); // no header → role:admin

    const audit = await (await call(app, '/audit?action=policy.update', { headers: { authorization: 'Bearer adm' } })).json();
    const actors = audit.items.map((i: any) => i.actor).sort();
    // a write with a header lands as the person, a write without one lands as role:admin (no id since there's no user)
    expect(actors).toEqual(['ayse@acme.co', 'role:admin']);
  });

  it('0.1: an org-bound identity cannot use root-level management endpoints (policy/retention/purge) — an operator is required', async () => {
    const journal = new InMemoryJournal();
    // `:input` because a run has one — run.ts writes it before the first model call, for every run.
    // The purge route now asks for it before deleting a whole prefix (a run row can be minted by a
    // key whose middle segment is `model`/`tool`, and purging THAT deletes somebody's keyspace).
    await journal.put('r-1:input', { _v: 2, prompt: 'a' });
    await journal.put('r-1:model:0', { content: [{ type: 'text', text: 'a' }], finishReason: 'stop' });
    const boundAdmin = roleAuth({ admin: { token: 'acme-adm', orgId: 'acme' } });
    const opAdmin = roleAuth({ admin: { token: 'op' } }); // unbound operator
    const boundApp = createStudioApi({ reader: journal, auth: boundAdmin });
    const H = { 'content-type': 'application/json', authorization: 'Bearer acme-adm' };

    const policyRes = await call(boundApp, '/policy', { method: 'PUT', headers: H, body: JSON.stringify({ rules: [] }) });
    expect(policyRes.status).toBe(403);
    expect((await policyRes.json()).error).toMatch(/operator required/);

    const sweepRes = await call(boundApp, '/retention/sweep', { method: 'POST', headers: H, body: JSON.stringify({ olderThanMs: 1 }) });
    expect(sweepRes.status).toBe(403);
    expect((await sweepRes.json()).error).toMatch(/operator required/);

    const purgeRes = await call(boundApp, '/runs/r-1', { method: 'DELETE', headers: { authorization: 'Bearer acme-adm' } });
    expect(purgeRes.status).toBe(403);
    expect((await purgeRes.json()).error).toMatch(/operator required/);
    expect(await journal.get('r-1:model:0')).toBeTruthy(); // not deleted

    // An unbound operator can do all of it.
    const opApp = createStudioApi({ reader: journal, auth: opAdmin });
    const opH = { 'content-type': 'application/json', authorization: 'Bearer op' };
    expect((await call(opApp, '/policy', { method: 'PUT', headers: opH, body: JSON.stringify({ rules: [] }) })).status).toBe(200);
    expect((await call(opApp, '/retention/sweep', { method: 'POST', headers: opH, body: JSON.stringify({ olderThanMs: 999999999 }) })).status).toBe(200);
    expect((await call(opApp, '/runs/r-1', { method: 'DELETE', headers: { authorization: 'Bearer op' } })).status).toBe(200);
  });

  it('0.2: even if opts.org is NOT given, an org-bound identity\'s read surface is scoped to its own organization', async () => {
    const journal = new InMemoryJournal();
    await journal.put('org:acme:r-acme:model:0', { content: [{ type: 'text', text: 'a' }], finishReason: 'stop' });
    await journal.put('org:globex:r-globex:model:0', { content: [{ type: 'text', text: 'g' }], finishReason: 'stop' });
    const boundViewer = roleAuth({ viewer: { token: 'viw', orgId: 'acme' } });
    const app = createStudioApi({ reader: journal, auth: boundViewer }); // no org option

    const runs = await (await call(app, '/runs', { headers: { authorization: 'Bearer viw' } })).json();
    expect(runs.map((r: any) => r.runId)).toEqual(['r-acme']);
  });

  it('0.3: DELETE /organizations/:id also deletes the EE users bound to the organization (no orphaned tokens)', async () => {
    const users = fakeUserStore();
    users.mem.set('a@acme.co', { id: 'a@acme.co', roles: ['viewer'], orgId: 'acme', createdAt: 1 });
    users.mem.set('g@globex.co', { id: 'g@globex.co', roles: ['viewer'], orgId: 'globex', createdAt: 1 });
    const journal = new InMemoryJournal();
    const app = createStudioApi({ reader: journal, auth: AUTH(), users, org: {} });
    const H = { authorization: 'Bearer adm' };

    const del = await call(app, '/organizations/acme', { method: 'DELETE', headers: H });
    expect(del.status).toBe(200);
    expect((await del.json()).removedUsers).toBe(1);
    expect(users.mem.has('a@acme.co')).toBe(false);
    expect(users.mem.has('g@globex.co')).toBe(true); // another organization's member is UNTOUCHED

    const audit = await (await call(app, '/audit?action=org.delete', { headers: H })).json();
    expect(audit.items[0].detail).toMatchObject({ removedUsers: 1 });
  });

  it('3.3: the org lands on the audit record; a bound identity sees only ITS OWN organization, an operator filters with ?org=', async () => {
    const journal = new InMemoryJournal();
    const acmeAdmin = roleAuth({ admin: { token: 'acme-adm', orgId: 'acme' } });
    const globexAdmin = roleAuth({ admin: { token: 'globex-adm', orgId: 'globex' } });
    const opAdmin = roleAuth({ admin: { token: 'op' } }); // unbound operator

    const acmeApp = createStudioApi({ reader: journal, auth: acmeAdmin });
    const globexApp = createStudioApi({ reader: journal, auth: globexAdmin });
    const opApp = createStudioApi({ reader: journal, auth: opAdmin });
    const H = (t: string) => ({ 'content-type': 'application/json', authorization: `Bearer ${t}` });

    // The acme and globex bound admins each make a write in their own organization (not root-level).
    await call(acmeApp, '/organizations/acme/budget', { method: 'PUT', headers: H('acme-adm'), body: JSON.stringify({ tokenLimit: 10 }) });
    await call(globexApp, '/organizations/globex/budget', { method: 'PUT', headers: H('globex-adm'), body: JSON.stringify({ tokenLimit: 20 }) });

    // Records have the org field.
    const acmeAudit = await (await call(acmeApp, '/audit', { headers: H('acme-adm') })).json();
    expect(acmeAudit.items.every((i: any) => i.org === 'acme')).toBe(true);
    expect(acmeAudit.items.map((i: any) => i.target)).toEqual(['acme']); // globex's is ABSENT — its own context only

    const globexAudit = await (await call(globexApp, '/audit', { headers: H('globex-adm') })).json();
    expect(globexAudit.items.map((i: any) => i.target)).toEqual(['globex']);

    // An unbound operator: sees all of them unfiltered; filters with ?org= as desired.
    const opAll = await (await call(opApp, '/audit', { headers: H('op') })).json();
    expect(opAll.items).toHaveLength(2);
    const opAcme = await (await call(opApp, '/audit?org=acme', { headers: H('op') })).json();
    expect(opAcme.items.map((i: any) => i.target)).toEqual(['acme']);
  });

  it('0.4: header-based org resolution (no auth binding) scopes GET /managed-agents to the org — the root store does not leak', async () => {
    const journal = new InMemoryJournal();
    const app = createStudioApi({ reader: journal, org: {} }); // no auth → only header resolution

    await journal.put('__studio_agent__:bot', { name: 'bot', active: null, versions: [{ version: 1, model: 'm-root', createdAt: 1 }] });
    await journal.put('org:acme:__studio_agent__:bot', { name: 'bot', active: null, versions: [{ version: 1, model: 'm-acme', createdAt: 1 }] });

    const acmeView = await (await call(app, '/managed-agents', { headers: { 'x-gnl-org': 'acme' } })).json();
    expect(acmeView.agents[0].versions[0].model).toBe('m-acme'); // its own organization, NOT root

    const rootView = await (await call(app, '/managed-agents')).json();
    expect(rootView.agents[0].versions[0].model).toBe('m-root'); // an orgless request sees the root namespace
  });

  it('2.1: even if opts.org is not given, if the auth provider declares multiOrganization=true (paid license), org surfaces open up', async () => {
    // A fake "licensed" provider: uses roleAuth's behavior but capabilities() returns multiOrganization:true
    // (as the real @gnldev/auth-ee does) — the org option is never given at all.
    const base = roleAuth({ admin: { token: 'lic-adm' } })!;
    const licensedAuth: AuthProvider = {
      authenticate: (c) => base.authenticate(c),
      authorize: (p, c, ctx) => base.authorize(p, c, ctx),
      capabilities: () => ({ multiOrganization: true }),
    };
    const app = createStudioApi({ reader: new InMemoryJournal(), auth: licensedAuth }); // no org

    const caps = await (await call(app, '/capabilities', { headers: { authorization: 'Bearer lic-adm' } })).json();
    expect(caps.organizations).toBe(true);
    expect(caps.orgManage).toBe(true);
    expect(caps.budgetManage).toBe(true);
  });

  it('2.4: a ghost organization\'s IMPLICIT-DATA branch — no __org__ record, but adding a member to an org with org:<id>: data still accepts 200', async () => {
    const users = fakeUserStore();
    const journal = new InMemoryJournal();
    // 'acme' was never created via POST /organizations (no record) but has data → an implicit organization.
    await journal.put('org:acme:r-acme:model:0', { content: [{ type: 'text', text: 'a' }], finishReason: 'stop' });
    const app = createStudioApi({ reader: journal, auth: AUTH(), users, org: {} });
    const H = { 'content-type': 'application/json', authorization: 'Bearer adm' };

    expect(await journal.get('__org__:acme')).toBeUndefined(); // no explicit record

    const res = await call(app, '/users', {
      method: 'POST', headers: H, body: JSON.stringify({ email: 'x@acme.co', orgId: 'acme' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).user.orgId).toBe('acme');
  });

  it('2.5: the ?token= fallback for /events only works with a basic user/pass cred (no bearer token) → 401 otherwise', async () => {
    const basicOnly = roleAuth({ admin: { user: 'ops', pass: 'secret' } });
    const app = createStudioApi({ reader: new InMemoryJournal(), auth: basicOnly });

    // Regular endpoints open up with the basic header (auth is working).
    const authB64 = 'Basic ' + Buffer.from('ops:secret').toString('base64');
    expect((await call(app, '/runs', { headers: { authorization: authB64 } })).status).toBe(200);

    // But EventSource can't send a header → it tries ?token=; this cred has NO bearer token, so
    // no ?token= value matches (the credValues tokens set stays empty) → 401.
    expect((await call(app, '/events')).status).toBe(401);
    expect((await call(app, '/events?token=ops')).status).toBe(401);
    expect((await call(app, '/events?token=secret')).status).toBe(401);
    expect((await call(app, `/events?token=${encodeURIComponent(authB64)}`)).status).toBe(401);
  });

  // Audit #2: createStudioApi without auth in production can only be set up with allowOpenAccess: true.
  it('production + no auth → setup throws; allowOpenAccess: true for deliberate open access', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      // NOTE: this exact message is intentionally left in Turkish — it's asserted from
      // packages/auth/src/gate.ts (see the comment there: "translate both together", owned by a
      // separate workstream). Translating only the assertion here would desync it from the real
      // error the gate throws, so it is deliberately kept as-is.
      expect(() => createStudioApi({ reader: new InMemoryJournal() })).toThrowError(/auth is required in production/);
      const app = createStudioApi({ reader: new InMemoryJournal(), allowOpenAccess: true });
      expect((await call(app, '/runs')).status).toBe(200);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('@gnldev/studio B2 — an auth provider that binds no identity', () => {
  // @gnldev/server closed this at src/index.ts (the B2 guard) and Studio never got the same fix.
  //
  // The legacy {read,write} pair normalizes through fromReadWrite(), whose authenticate() returns
  // null UNCONDITIONALLY (packages/auth/src/adapter.ts) — the decision lives in the predicate, not
  // in a principal. So with `org` configured there is an authProvider but never an identity: the
  // strict fail-closed net below it tests `principal && !bound`, which null skips, and the org for
  // a GET becomes `bound ?? requested` — the raw header. A caller holding a valid READ token then
  // picks whichever organization it names, which is the whole isolation claim inverted.
  it('B2: {read,write} auth + org option → the x-gnl-org header cannot drive the org (403, fail-closed)', async () => {
    const journal = new InMemoryJournal();
    await seed(journal);
    const app = createStudioApi({
      reader: journal,
      auth: { read: () => true, write: () => true },
      org: {},
    });

    const res = await call(app, '/runs', { headers: { 'x-gnl-org': 'globex' } });
    expect(res.status).toBe(403);

    // Sanity: WITHOUT the org option the same principal-less auth is untouched — it makes no
    // isolation claim, so it keeps serving the single shared scope exactly as before.
    const noOrg = createStudioApi({ reader: journal, auth: { read: () => true, write: () => true } });
    expect((await call(noOrg, '/runs')).status).toBe(200);
  });

  it('a provider that CAN authenticate still answers a missing token with 401, not this 403', async () => {
    // The reason the guard keys on the provider rather than on `!principal`, which is what the
    // equivalent @gnldev/server guard tests. Under roleAuth a token-less request also produces a
    // null principal, but nothing is misconfigured there — the caller simply did not authenticate,
    // and flattening that into "org isolation cannot work here" would report the wrong problem and
    // tell a caller to fix its deployment when it needs to send a token.
    const journal = new InMemoryJournal();
    await seed(journal);
    const app = createStudioApi({ reader: journal, auth: AUTH(), org: {} });

    expect((await call(app, '/runs')).status).toBe(401);
    // ...and the identity-bound caller still gets its own org, so the guard did not over-reach.
    const ok = await call(app, '/runs', { headers: { authorization: 'Bearer viw' } });
    expect(ok.status).toBe(200);
    expect((await ok.json()).map((r: any) => r.runId)).toEqual(['r-acme']);
  });

  it('a HEADER-scoped caller sees only its own audit records and organizations', async () => {
    // The org can reach a request two ways: bound to the identity (Principal.orgId) or resolved into the
    // ALS by `x-gnl-org` / `opts.org.resolve`. /audit and /organizations read only the first, so the
    // second — a supported, tested setup — got EVERY organization's rows. Same leak the comment at the
    // /managed-agents resolution already warns about, two endpoints over.
    const journal = new InMemoryJournal();
    await journal.put('org:acme:r1:model:0', { content: [{ type: 'text', text: 'a' }], finishReason: 'stop' });
    await journal.put('org:globex:r2:model:0', { content: [{ type: 'text', text: 'g' }], finishReason: 'stop' });
    // Two audit rows at the ROOT, tagged by org — that is where the audit log lives.
    const app = createStudioApi({ reader: journal, org: {} });
    // Written by an UNBOUND operator (no org header): a write carrying `x-gnl-org` is refused by the
    // v1 read-only rule, and org.budget takes its audit `org` from the target anyway.
    await call(app, '/organizations/acme/budget', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tokenLimit: 10 }),
    });
    await call(app, '/organizations/globex/budget', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tokenLimit: 20 }),
    });
    // Both rows exist and are visible to an unscoped reader — otherwise the assertion below would pass
    // on an empty log rather than on a filtered one.
    const all = await (await call(app, '/audit')).json();
    expect(all.items.map((i: { target: string }) => i.target).sort()).toEqual(['acme', 'globex']);

    const acme = await (await call(app, '/audit', { headers: { 'x-gnl-org': 'acme' } })).json();
    expect(acme.items.map((i: { target: string }) => i.target), 'a header-scoped caller saw another org\'s audit')
      .toEqual(['acme']);

    const orgs = await (await call(app, '/organizations', { headers: { 'x-gnl-org': 'acme' } })).json();
    const ids = (orgs.organizations ?? orgs).map((o: { id?: string } | string) => (typeof o === 'string' ? o : o.id));
    expect(ids, 'a header-scoped caller saw another organization in the list').toEqual(['acme']);
  });
});
