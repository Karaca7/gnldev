// Free roleAuth: opt-in, bearer+basic, viewer(read)/admin(write), ?token= SSE fallback.
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { roleAuth, makeGate, principalOf, type Cred } from '../src/index.js';

function appWith(cfg: { admin?: Cred; viewer?: Cred }): Hono {
  const { allow, deny } = makeGate(roleAuth(cfg));
  const app = new Hono();
  app.get('/read', async (c) => ((await allow(c.req.raw, 'read')) ? c.json({ ok: true }) : deny(c.req.raw, 'read')));
  app.post('/write', async (c) => ((await allow(c.req.raw, 'write')) ? c.json({ ok: true }) : deny(c.req.raw, 'write')));
  return app;
}

describe('roleAuth (free default)', () => {
  it('no role at all → undefined (opt-in: gate not set up)', () => {
    expect(roleAuth({})).toBeUndefined();
  });

  it('admin writes via bearer & basic; viewer only reads', async () => {
    const app = appWith({ admin: { token: 'adm', user: 'au', pass: 'ap' }, viewer: { token: 'viw' } });

    // no header → read 401, write 403
    expect((await app.request('/read')).status).toBe(401);
    expect((await app.request('/write', { method: 'POST' })).status).toBe(403);

    // viewer → reads but can't write
    expect((await app.request('/read', { headers: { authorization: 'Bearer viw' } })).status).toBe(200);
    expect((await app.request('/write', { method: 'POST', headers: { authorization: 'Bearer viw' } })).status).toBe(403);

    // admin bearer → reads + writes
    expect((await app.request('/read', { headers: { authorization: 'Bearer adm' } })).status).toBe(200);
    expect((await app.request('/write', { method: 'POST', headers: { authorization: 'Bearer adm' } })).status).toBe(200);

    // admin basic → writes
    const basic = 'Basic ' + Buffer.from('au:ap').toString('base64');
    expect((await app.request('/write', { method: 'POST', headers: { authorization: basic } })).status).toBe(200);
  });

  it('?token= read fallback (EventSource cannot send headers)', async () => {
    const app = appWith({ viewer: { token: 'viw' } });
    expect((await app.request('/read?token=viw')).status).toBe(200);
    expect((await app.request('/read?token=wrong')).status).toBe(401);
  });

  it('Cred.orgId + user → principal is bound to identity; readable via principalOf after allow()', async () => {
    const { allow, deny } = makeGate(roleAuth({
      admin: { token: 'adm', user: 'ops' },
      viewer: { token: 'viw', orgId: 'acme' },
    }));
    const app = new Hono();
    app.get('/who', async (c) => ((await allow(c.req.raw, 'read')) ? c.json(principalOf(c.req.raw)) : deny(c.req.raw, 'read')));

    const v = await (await app.request('/who', { headers: { authorization: 'Bearer viw' } })).json();
    expect(v).toEqual({ roles: ['viewer'], orgId: 'acme' });

    const a = await (await app.request('/who', { headers: { authorization: 'Bearer adm' } })).json();
    expect(a).toEqual({ roles: ['admin'], id: 'ops' }); // no organization = global operator

    // no principal without calling allow() / on an unauthenticated request
    const anon = new Hono();
    anon.get('/p', (c) => c.json({ p: principalOf(c.req.raw) }));
    expect((await (await anon.request('/p')).json()).p).toBeNull();
  });
});
