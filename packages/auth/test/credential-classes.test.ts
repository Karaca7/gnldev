// The four credential CLASSES: superAdmin / admin / client / viewer.
//
// Two measurements motivated splitting `admin`, and both are pinned here.
//
// (1) An application's routine work — running an agent — required the SAME token that cancels runs,
//     reads the whole organization's history and reads `/usage`. A customer's backend therefore held
//     the deployment's management key to send a prompt. `client` is that credential, and it is a
//     WHITELIST: a write whose permission this file does not name is refused, so a route added later
//     without a permission name costs a visible 403 rather than silently widening every deployed
//     application credential.
//
// (2) The operator who runs the PLATFORM belongs to no organization by construction, so the
//     org-isolation fail-closed rule denied it alongside the accidental unbound admin it exists to
//     stop. `superAdmin` is that operator DECLARING itself — scope.ts refuses to infer the platform
//     scope from a missing `orgId`, because then forgetting an orgId mints a super-admin.
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { roleAuth, makeGate, isPlatformAdmin, CLIENT_WRITES, type Cred } from '../src/index.js';

type Cfg = { superAdmin?: Cred; admin?: Cred; client?: Cred; viewer?: Cred };

/** A gate exposing one read, one NAMED write (`agents:run`) and one write with no permission name. */
function appWith(cfg: Cfg): Hono {
  const { allow, allowP, deny } = makeGate(roleAuth(cfg));
  const app = new Hono();
  app.get('/read', async (c) => ((await allow(c.req.raw, 'read')) ? c.json({ ok: true }) : deny(c.req.raw, 'read')));
  app.post('/run', async (c) => ((await allowP(c.req.raw, 'agents:run')) ? c.json({ ok: true }) : deny(c.req.raw, 'write')));
  app.post('/manage', async (c) => ((await allowP(c.req.raw, 'users:write')) ? c.json({ ok: true }) : deny(c.req.raw, 'write')));
  app.post('/unnamed', async (c) => ((await allow(c.req.raw, 'write')) ? c.json({ ok: true }) : deny(c.req.raw, 'write')));
  return app;
}

const CFG: Cfg = {
  superAdmin: { token: 'super' },
  admin: { token: 'adm', orgId: 'acme' },
  client: { token: 'cli', orgId: 'acme' },
  viewer: { token: 'viw', orgId: 'acme' },
};
const as = (t: string) => ({ authorization: `Bearer ${t}` });
const post = (app: Hono, path: string, t: string) => app.request(path, { method: 'POST', headers: as(t) });

describe('credential classes', () => {
  it('client runs agents but cannot manage — the split the class exists for', async () => {
    const app = appWith(CFG);
    expect((await post(app, '/run', 'cli')).status).toBe(200);
    expect((await post(app, '/manage', 'cli')).status).toBe(403);
    // …while the admin it used to have to borrow can do both.
    expect((await post(app, '/run', 'adm')).status).toBe(200);
    expect((await post(app, '/manage', 'adm')).status).toBe(200);
  });

  it('client is a whitelist: an UNNAMED write is refused, not inherited', async () => {
    const app = appWith(CFG);
    // The distinguishing case. A "client = admin minus a few things" implementation passes every
    // assertion above and fails this one: `allow(req,'write')` carries no permission, so a blacklist
    // has nothing to match and lets it through. That is precisely how a route added later without a
    // name would widen every deployed client credential in silence.
    expect((await post(app, '/unnamed', 'cli')).status).toBe(403);
    expect((await post(app, '/unnamed', 'adm')).status).toBe(200);
  });

  it('client reads (it needs its own runs) and viewer still cannot write', async () => {
    const app = appWith(CFG);
    expect((await app.request('/read', { headers: as('cli') })).status).toBe(200);
    expect((await app.request('/read', { headers: as('viw') })).status).toBe(200);
    expect((await post(app, '/run', 'viw')).status).toBe(403);
  });

  it('every permission on the client whitelist is actually reachable by a client', async () => {
    // Guards the whitelist against drift: renaming a route's permission without updating the set here
    // would silently take a capability away from every application credential.
    const { allowP } = makeGate(roleAuth(CFG));
    for (const permission of CLIENT_WRITES) {
      const req = new Request('http://x/p', { method: 'POST', headers: as('cli') });
      expect(await allowP(req, permission), `client denied whitelisted '${permission}'`).toBe(true);
    }
  });

  it('superAdmin carries the platform grant; a plain admin never does', () => {
    const auth = roleAuth(CFG)!;
    expect(isPlatformAdmin(auth.authenticate(new Request('http://x', { headers: as('super') })) as never)).toBe(true);
    expect(isPlatformAdmin(auth.authenticate(new Request('http://x', { headers: as('adm') })) as never)).toBe(false);
    expect(isPlatformAdmin(auth.authenticate(new Request('http://x', { headers: as('cli') })) as never)).toBe(false);
  });

  it('superAdmin also carries `admin`, so existing role checks keep working', () => {
    const auth = roleAuth(CFG)!;
    const p = auth.authenticate(new Request('http://x', { headers: as('super') })) as { roles: string[] };
    expect(p.roles).toContain('admin');
  });

  it('an unbound plain admin is NOT promoted — the platform scope is declared, never inferred', () => {
    // The fail-open this whole split guards: if a missing `orgId` implied the platform scope, then
    // forgetting one line of config would mint a cross-org super-admin.
    const auth = roleAuth({ admin: { token: 'adm' } })!;
    const p = auth.authenticate(new Request('http://x', { headers: as('adm') }));
    expect(isPlatformAdmin(p)).toBe(false);
    expect(p?.orgId).toBeUndefined();
  });

  it('{ admin, viewer } alone behaves exactly as it did before the new classes existed', async () => {
    const app = appWith({ admin: { token: 'adm' }, viewer: { token: 'viw' } });
    expect((await app.request('/read', { headers: as('viw') })).status).toBe(200);
    expect((await post(app, '/unnamed', 'viw')).status).toBe(403);
    expect((await post(app, '/unnamed', 'adm')).status).toBe(200);
    expect((await post(app, '/run', 'adm')).status).toBe(200);
  });

  it('configuring only a client is still opt-in (and only a superAdmin is too)', () => {
    expect(roleAuth({})).toBeUndefined();
    expect(roleAuth({ client: { token: 'c' } })).toBeDefined();
    expect(roleAuth({ superAdmin: { token: 's' } })).toBeDefined();
  });

  it('a token configured for two classes resolves to the stronger one', async () => {
    // Under-authorizing a credential the host declared as an operator is the worse failure: it breaks
    // a deployment loudly at best, and at worst invites widening something else to compensate.
    const app = appWith({ superAdmin: { token: 'same' }, client: { token: 'same' } });
    expect((await post(app, '/manage', 'same')).status).toBe(200);
  });
});
