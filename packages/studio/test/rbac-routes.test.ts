// Route-level fine-grained enforcement (allowP) in Studio: the member tier can RUN agents but not manage;
// PATCH /users/:id assigns catalog permissions/roles and takes effect; the permission catalog is a
// read-only, code-defined list. Uses an inline RBAC-style provider (honours ctx.permission, capabilities
// rbac:true) backed by the SAME user store PATCH mutates — so a role change is observable end-to-end.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { roleAuth, type AuthProvider } from '@gnldev/auth';
import { createStudioApi, type StudioUserStore, type StudioUser } from '../src/server.js';
import { call } from './call.js';

const GRANTS: Record<string, string[]> = {
  viewer: ['*:read'],
  member: ['*:read', 'agents:run'],
  admin: ['*'],
  'platform-admin': ['*'],
};
const match = (g: string, req: string): boolean => {
  if (g === '*' || g === req) return true;
  const [gr, ga] = g.split(':');
  const [rr, ra] = req.split(':');
  return (gr === '*' || gr === rr) && (ga === '*' || ga === ra);
};

// A user store that ALSO serves as the auth source (token → principal), so PATCH updates are reflected on
// the next authenticate — mirroring @gnldev/auth-ee createJournalUserStore + createEnterpriseAuth.
function makeStore() {
  const byId = new Map<string, StudioUser>();
  const byToken = new Map<string, string>();
  const store: StudioUserStore & { principalFor(t: string): any } = {
    list: () => [...byId.values()],
    create: async (input) => {
      const id = input.email!;
      const u: StudioUser = { id, roles: input.roles?.length ? input.roles : ['viewer'], ...(input.permissions?.length ? { permissions: input.permissions } : {}), ...(input.orgId ? { orgId: input.orgId } : {}) };
      byId.set(id, u);
      const token = 'tok_' + id;
      byToken.set(token, id);
      return { user: u, token };
    },
    remove: async (id) => { byId.delete(id); },
    update: async (id, patch) => {
      const u = byId.get(id);
      if (!u) throw new Error(`user '${id}' not found`);
      const n: StudioUser = { ...u };
      if (patch.roles?.length) n.roles = patch.roles;
      if (patch.permissions !== undefined) { if (patch.permissions.length) n.permissions = patch.permissions; else delete n.permissions; }
      byId.set(id, n);
      return n;
    },
    principalFor: (t) => {
      const id = byToken.get(t);
      if (!id) return null;
      const u = byId.get(id);
      return u ? { id: u.id, roles: u.roles, ...(u.permissions ? { permissions: u.permissions } : {}), ...(u.orgId ? { orgId: u.orgId } : {}) } : null;
    },
  };
  return store;
}

function rbacAuth(store: ReturnType<typeof makeStore>): AuthProvider {
  return {
    authenticate: (c) => {
      const h = c.req.header('authorization');
      const t = h?.startsWith('Bearer ') ? h.slice(7) : c.req.query('token');
      return t ? store.principalFor(t) : null;
    },
    authorize: (p, _c, ctx) => {
      if (!p) return { allow: false, status: 401, reason: 'unauthenticated' };
      const required = ctx.permission ?? `${ctx.resource ?? 'x'}:${ctx.action}`;
      const eff: string[] = p.permissions?.length ? p.permissions : p.roles.flatMap((r: string) => GRANTS[r] ?? []);
      return eff.some((g) => match(g, required)) ? { allow: true } : { allow: false, status: 403, reason: `denied: ${required}` };
    },
    capabilities: () => ({ rbac: true }),
  };
}

async function setup() {
  const journal = new InMemoryJournal();
  const store = makeStore();
  const viewer = (await store.create({ email: 'v@a.co', roles: ['viewer'] })).token;
  const member = (await store.create({ email: 'm@a.co', roles: ['member'] })).token;
  const admin = (await store.create({ email: 'ad@a.co', roles: ['admin'] })).token;
  const app = createStudioApi({
    reader: journal,
    auth: rbacAuth(store),
    users: store,
    gnl: { listAgents: () => [{ name: 'echo' }], run: async () => ({ text: 'ok', interrupts: [] }) },
  });
  return { app, store, viewer, member, admin };
}

const H = (t: string) => ({ authorization: `Bearer ${t}` });
const JH = (t: string) => ({ 'content-type': 'application/json', authorization: `Bearer ${t}` });
const runReq = (app: any, t: string) => call(app, '/agents/echo/run', { method: 'POST', headers: JH(t), body: JSON.stringify({ runId: 'r-' + t, prompt: 'hi' }) });

describe('@gnldev/studio fine-grained routes (RBAC)', () => {
  it('member: runs agents (200) but cannot manage users/budget (403); reads OK', async () => {
    const { app, member } = await setup();
    expect((await runReq(app, member)).status).toBe(200);
    expect((await call(app, '/users', { method: 'POST', headers: JH(member), body: JSON.stringify({ email: 'x@a.co' }) })).status).toBe(403);
    expect((await call(app, '/organizations/acme/budget', { method: 'PUT', headers: JH(member), body: JSON.stringify({ tokenLimit: 5 }) })).status).toBe(403);
    expect((await call(app, '/runs', { headers: H(member) })).status).toBe(200);
  });

  it('viewer: cannot run agents (403); reads OK', async () => {
    const { app, viewer } = await setup();
    expect((await runReq(app, viewer)).status).toBe(403);
    expect((await call(app, '/runs', { headers: H(viewer) })).status).toBe(200);
  });

  it('admin: management succeeds (users 200, budget 200)', async () => {
    const { app, admin } = await setup();
    expect((await call(app, '/users', { method: 'POST', headers: JH(admin), body: JSON.stringify({ email: 'new@a.co', roles: ['member'] }) })).status).toBe(200);
    expect((await call(app, '/organizations/acme/budget', { method: 'PUT', headers: JH(admin), body: JSON.stringify({ tokenLimit: 5 }) })).status).toBe(200);
  });

  it('explicit permissions override the role (member-like perms cannot manage budget; [*] can)', async () => {
    const { app, store } = await setup();
    const like = (await store.create({ email: 'p1@a.co', roles: ['viewer'], permissions: ['*:read', 'agents:run'] })).token;
    const full = (await store.create({ email: 'p2@a.co', roles: ['viewer'], permissions: ['*'] })).token;
    expect((await runReq(app, like)).status).toBe(200);
    expect((await call(app, '/organizations/acme/budget', { method: 'PUT', headers: JH(like), body: JSON.stringify({ tokenLimit: 5 }) })).status).toBe(403);
    expect((await call(app, '/organizations/acme/budget', { method: 'PUT', headers: JH(full), body: JSON.stringify({ tokenLimit: 5 }) })).status).toBe(200);
  });

  it('PATCH /users/:id viewer→member: the SAME token can now run agents', async () => {
    const { app, admin, store } = await setup();
    const { user, token } = await store.create({ email: 'up@a.co', roles: ['viewer'] });
    expect((await runReq(app, token)).status).toBe(403); // viewer cannot run
    const patch = await call(app, `/users/${user.id}`, { method: 'PATCH', headers: JH(admin), body: JSON.stringify({ roles: ['member'] }) });
    expect(patch.status).toBe(200);
    expect((await runReq(app, token)).status).toBe(200); // change took effect, token unchanged
  });

  it('PATCH assigns explicit permissions; a member cannot PATCH users (403)', async () => {
    const { app, admin, member, store } = await setup();
    const { user } = await store.create({ email: 'pe@a.co', roles: ['viewer'] });
    // member lacks users:write → PATCH forbidden
    expect((await call(app, `/users/${user.id}`, { method: 'PATCH', headers: JH(member), body: JSON.stringify({ permissions: ['*'] }) })).status).toBe(403);
    // admin can assign explicit permissions
    const r = await call(app, `/users/${user.id}`, { method: 'PATCH', headers: JH(admin), body: JSON.stringify({ permissions: ['*:read', 'agents:run'] }) });
    expect(r.status).toBe(200);
    expect((await r.json()).user.permissions).toEqual(['*:read', 'agents:run']);
  });

  it('GET /permissions/catalog: code-defined list + role presets (RBAC on)', async () => {
    const { app, admin } = await setup();
    const cat = await (await call(app, '/permissions/catalog', { headers: H(admin) })).json();
    expect(cat.enabled).toBe(true);
    expect(cat.permissions.map((p: any) => p.id)).toContain('agents:run');
    expect(cat.permissions.map((p: any) => p.id)).toContain('users:write');
    expect(cat.rolePresets).toMatchObject({ viewer: ['*:read'], member: ['*:read', 'agents:run'], admin: ['*'] });
    // it is read-only: there is no POST/PATCH/DELETE surface (POST returns 404 — route not registered)
    expect((await call(app, '/permissions/catalog', { method: 'POST', headers: JH(admin), body: '{}' })).status).toBe(404);
  });

  it('GET /permissions/catalog: FREE tier (no RBAC) → disabled/empty', async () => {
    const app = createStudioApi({ reader: new InMemoryJournal(), auth: roleAuth({ admin: { token: 'op' } }) });
    const cat = await (await call(app, '/permissions/catalog', { headers: H('op') })).json();
    expect(cat).toMatchObject({ enabled: false, permissions: [], rolePresets: {} });
  });
});
