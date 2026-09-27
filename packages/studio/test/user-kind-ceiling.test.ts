/**
 * Who may create a caller that acts on other people's data.
 *
 * `kind` (see @gnldev/auth `Principal.kind`) is the grant that decides whose data a caller reaches:
 * its own (subject), a user it names (application), or anyone's in its scope (operator). Studio's
 * user management is where people ASK for that grant. Two walls stand in front of it: Studio admits
 * staff only (`staff-only.test.ts`), so an end user or an application never reaches `/users`; and
 * @gnldev/auth `assertAssignablePrivileges` (unit-tested there) refuses the grant to anyone who is not
 * staff. This file pins the first wall on these routes, and the store contract behind it.
 */
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createStudioApi } from '../src/server.js';

type User = { id: string; email?: string; roles: string[]; orgId?: string; kind?: string };

const auth = {
  authenticate: (req: Request) => {
    const t = req.headers.get('authorization')?.replace('Bearer ', '');
    if (t === 'ops') return { kind: 'operator', roles: ['admin'], orgId: 'acme' };
    if (t === 'app') return { kind: 'application', roles: ['admin'], orgId: 'acme' };
    // Same roles and org as `ops`. Only the kind differs, so only the kind can explain a refusal.
    if (t === 'ayse') return { kind: 'subject', id: 'u-ayse', roles: ['admin'], orgId: 'acme' };
    return null;
  },
  authorize: () => ({ allow: true }),
  capabilities: () => ({ sso: false, rbac: false, audit: false, multiOrganization: true, users: true }),
};

function makeApp() {
  const mem = new Map<string, User>();
  const creates: unknown[] = [];
  const updates: unknown[] = [];
  let seq = 0;
  const store = {
    list: async () => [...mem.values()],
    create: async (u: Omit<User, 'id'>) => {
      creates.push(u);
      const user: User = { ...u, id: `u${++seq}`, roles: u.roles ?? [] };
      mem.set(user.id, user);
      return { user, token: `tok-${user.id}` };
    },
    update: async (id: string, patch: Partial<User>) => {
      updates.push(patch);
      const u = { ...mem.get(id)!, ...patch };
      mem.set(id, u);
      return u;
    },
    remove: async () => {},
  };
  mem.set('u-ayse', { id: 'u-ayse', roles: ['admin'], orgId: 'acme', kind: 'subject' });
  const api = createStudioApi({ reader: new InMemoryJournal(), auth: auth as never, org: {}, users: store as never });
  const send = async (method: string, path: string, body: unknown, token: string) => {
    const res = await api(new Request(`http://x${path}`, {
      method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body),
    }));
    return { status: res.status, json: (await res.json().catch(() => ({}))) as { error?: string; user?: User } };
  };
  return { send, creates, updates };
}

describe('POST /users — the kind ceiling', () => {
  it('an operator can create an operator, and the kind reaches the store', async () => {
    const { send, creates } = makeApp();
    const r = await send('POST', '/users', { email: 'o@acme.test', roles: ['admin'], kind: 'operator' }, 'ops');
    expect(r.status).toBe(200);
    expect(creates).toEqual([expect.objectContaining({ kind: 'operator' })]);
  });

  it('a subject with the admin role cannot — the role is not the grant', async () => {
    const { send, creates } = makeApp();
    const r = await send('POST', '/users', { email: 'o@acme.test', roles: ['admin'], kind: 'operator' }, 'ayse');
    expect(r.status).toBe(403);
    expect(r.json.error).toContain('staff');
    expect(creates, 'the refused create still reached the store').toEqual([]);
  });

  it('an application cannot mint staff or another application', async () => {
    const { send, creates } = makeApp();
    expect((await send('POST', '/users', { email: 'o@acme.test', kind: 'operator' }, 'app')).status).toBe(403);
    expect((await send('POST', '/users', { email: 'p@acme.test', kind: 'application' }, 'app')).status).toBe(403);
    expect(creates).toEqual([]);
  });

  it('staff may create a plain user; an end user may not manage users at all', async () => {
    const { send, creates } = makeApp();
    expect((await send('POST', '/users', { email: 'a@acme.test', kind: 'subject' }, 'ops')).status).toBe(200);
    expect((await send('POST', '/users', { email: 'b@acme.test' }, 'ops')).status).toBe(200);
    expect((await send('POST', '/users', { email: 'c@acme.test' }, 'ayse')).status).toBe(403);
    expect(creates).toHaveLength(2);
  });

  it('a kind that is not one is a 400, not a stored string', async () => {
    const { send, creates } = makeApp();
    const r = await send('POST', '/users', { email: 'o@acme.test', kind: 'root' }, 'ops');
    expect(r.status).toBe(400);
    expect(r.json.error).toContain('kind');
    expect(creates).toEqual([]);
  });
});

describe('PATCH /users/:id — the self-promotion path', () => {
  it('a subject admin cannot make itself an operator', async () => {
    const { send, updates } = makeApp();
    const r = await send('PATCH', '/users/u-ayse', { kind: 'operator' }, 'ayse');
    expect(r.status).toBe(403);
    expect(updates).toEqual([]);
  });

  it('an operator can, and `kind` alone is something to update', async () => {
    const { send, updates } = makeApp();
    const r = await send('PATCH', '/users/u-ayse', { kind: 'operator' }, 'ops');
    expect(r.status).toBe(200);
    expect(updates).toEqual([{ kind: 'operator' }]);
  });

  it('an invalid kind is a 400', async () => {
    const { send, updates } = makeApp();
    const r = await send('PATCH', '/users/u-ayse', { kind: 'root' }, 'ops');
    expect(r.status).toBe(400);
    expect(r.json.error).toContain('kind');
    expect(updates).toEqual([]);
  });
});
