// Audit #2 — silent fail-open closed: in production, a providerless makeGate throws at SETUP time;
// allowOpenAccess: true is deliberate open access; outside production it warns once on the first request.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import { makeGate, roleAuth, type AuthProvider } from '../src/index.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('makeGate (fail-open audit)', () => {
  it('production + no provider → clear error at setup', () => {
    vi.stubEnv('NODE_ENV', 'production');
    // Asserted verbatim by packages/studio/test — keep the two in sync.
    expect(() => makeGate()).toThrowError(/auth is required in production.*allowOpenAccess: true/);
  });

  it('production + allowOpenAccess: true → gate is set up, endpoints are deliberately open', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { allow, deny } = makeGate(undefined, { allowOpenAccess: true });
    const app = new Hono();
    app.get('/read', async (c) => ((await allow(c.req.raw, 'read')) ? c.json({ ok: true }) : deny(c.req.raw, 'read')));
    expect((await app.request('/read')).status).toBe(200);
  });

  it('non-production + no provider → endpoints open, console.warn once on the FIRST request', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { allow, deny } = makeGate();
    const app = new Hono();
    app.get('/read', async (c) => ((await allow(c.req.raw, 'read')) ? c.json({ ok: true }) : deny(c.req.raw, 'read')));
    expect((await app.request('/read')).status).toBe(200);
    expect((await app.request('/read')).status).toBe(200); // second request does NOT repeat the warning
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('allowOpenAccess');
  });

  // The warning above TELLS the reader to set allowOpenAccess. Following that instruction has to
  // silence it, or the flag reads as inert and the next auth warning gets ignored too.
  it('non-production + allowOpenAccess: true → open, and does NOT repeat the instruction it followed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { allow, deny } = makeGate(undefined, { allowOpenAccess: true });
    const app = new Hono();
    app.get('/read', async (c) => ((await allow(c.req.raw, 'read')) ? c.json({ ok: true }) : deny(c.req.raw, 'read')));
    expect((await app.request('/read')).status).toBe(200);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('ALL endpoints are open'))).toHaveLength(0);
  });
});

// An RBAC-style provider that honours ctx.permission (like @gnldev/auth-ee): the exact permission is matched
// against a fixed grant set with wildcard support. capabilities().rbac = true (fine-grained mode).
function rbacFake(grants: string[]): AuthProvider {
  const match = (g: string, req: string): boolean => {
    if (g === '*' || g === req) return true;
    const [gr, ga] = g.split(':');
    const [rr, ra] = req.split(':');
    return (gr === '*' || gr === rr) && (ga === '*' || ga === ra);
  };
  return {
    authenticate: () => ({ roles: ['x'], permissions: grants }),
    authorize: (_p, _c, ctx) => {
      const required = ctx.permission ?? `${ctx.resource ?? 'x'}:${ctx.action}`;
      return grants.some((g) => match(g, required)) ? { allow: true } : { allow: false, status: 403, reason: `denied: ${required}` };
    },
    capabilities: () => ({ rbac: true }),
  };
}

describe('gate.allowP (fine-grained enforcement)', () => {
  const H = (t: string) => ({ authorization: `Bearer ${t}` });

  it('auth OFF (no provider) → allowP always true', async () => {
    const { allowP, deny } = makeGate(undefined, { allowOpenAccess: true });
    const app = new Hono();
    app.post('/x', async (c) => ((await allowP(c.req.raw, 'users:write')) ? c.json({ ok: true }) : deny(c.req.raw, 'write')));
    expect((await app.request('/x', { method: 'POST' })).status).toBe(200);
  });

  it('EE/RBAC mode: the EXACT permission is matched against the principal grants (member-like)', async () => {
    // member-like grants: can run agents + read, cannot manage.
    const { allowP, deny } = makeGate(rbacFake(['*:read', 'agents:run']));
    const app = new Hono();
    app.post('/run', async (c) => ((await allowP(c.req.raw, 'agents:run')) ? c.json({ ok: true }) : deny(c.req.raw, 'write')));
    app.post('/users', async (c) => ((await allowP(c.req.raw, 'users:write')) ? c.json({ ok: true }) : deny(c.req.raw, 'write')));
    app.get('/read', async (c) => ((await allowP(c.req.raw, '*:read')) ? c.json({ ok: true }) : deny(c.req.raw, 'read')));

    expect((await app.request('/run', { method: 'POST' })).status).toBe(200); // agents:run granted
    expect((await app.request('/users', { method: 'POST' })).status).toBe(403); // users:write NOT granted
    expect((await app.request('/read')).status).toBe(200); // *:read granted
  });

  it('EE/RBAC mode: full grant (*) allows everything', async () => {
    const { allowP, deny } = makeGate(rbacFake(['*']));
    const app = new Hono();
    app.post('/users', async (c) => ((await allowP(c.req.raw, 'users:write')) ? c.json({ ok: true }) : deny(c.req.raw, 'write')));
    expect((await app.request('/users', { method: 'POST' })).status).toBe(200);
  });

  it('FREE mode: allowP reduces to read/write (agents:run → write → admin only, viewer denied)', async () => {
    const provider = roleAuth({ admin: { token: 'adm' }, viewer: { token: 'viw' } })!;
    const { allowP, deny } = makeGate(provider);
    const app = new Hono();
    app.post('/run', async (c) => ((await allowP(c.req.raw, 'agents:run')) ? c.json({ ok: true }) : deny(c.req.raw, 'write')));
    app.get('/read', async (c) => ((await allowP(c.req.raw, '*:read')) ? c.json({ ok: true }) : deny(c.req.raw, 'read')));

    // agents:run reduces to 'write' → admin 200, viewer 403
    expect((await app.request('/run', { method: 'POST', headers: H('adm') })).status).toBe(200);
    expect((await app.request('/run', { method: 'POST', headers: H('viw') })).status).toBe(403);
    // *:read reduces to 'read' → viewer 200
    expect((await app.request('/read', { headers: H('viw') })).status).toBe(200);
  });

  it('FREE mode regression: allowP(X:write) ≡ allow(write) and allowP(*:read) ≡ allow(read)', async () => {
    const provider = roleAuth({ admin: { token: 'adm' }, viewer: { token: 'viw' } })!;
    const { allow, allowP, deny } = makeGate(provider);
    const app = new Hono();
    app.post('/coarse', async (c) => ((await allow(c.req.raw, 'write')) ? c.json({ ok: true }) : deny(c.req.raw, 'write')));
    app.post('/fine', async (c) => ((await allowP(c.req.raw, 'budget:write')) ? c.json({ ok: true }) : deny(c.req.raw, 'write')));
    for (const t of ['adm', 'viw']) {
      const coarse = (await app.request('/coarse', { method: 'POST', headers: H(t) })).status;
      const fine = (await app.request('/fine', { method: 'POST', headers: H(t) })).status;
      expect(fine).toBe(coarse); // identical decision in the free tier → no regression
    }
  });
});
