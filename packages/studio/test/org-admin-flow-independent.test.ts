/**
 * Creating an organization from Studio and adding its first admin — as a SEQUENCE.
 *
 * The ordering is the contract, not an implementation detail: an org must exist before a member can be
 * assigned to it, so "add the admin" answers differently before and after "create the org". Seven
 * isolated cases would each set up the world they wanted and would never exercise that.
 *
 * Two route-level guards on this path had no assertion anywhere in the repo before this file:
 *   • server.ts:2035  `you can only create users in your own org ('<own>')`   (403)
 *   • server.ts:2042  `org '<id>' doesn't exist — create the org first`       (400)
 * The privilege ceiling (`platform-admin` cannot be minted by an org admin) is covered in
 * auth-ee/test/rbac-ladder.test.ts, and `POST /organizations` 403 for a bound identity is covered by
 * auth-org.test.ts B2 — those are asserted here only as part of the sequence, not as new coverage.
 *
 * THE SILENT DEFAULT is the point of most of this file. When an org admin omits `orgId`, the route
 * does not refuse and does not create an org-less user: it falls back to the caller's own org
 * (server.ts:2037, `targetOrg = own`). Nothing in a 403-only test would notice if that line were
 * deleted — the refusal cases would all still pass while every user created by an org admin silently
 * became org-less. So the fallback gets its own assertion on the STORED record, before the refusals.
 */
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createStudioApi } from '../src/server.js';

type User = { id: string; email?: string; roles: string[]; permissions?: string[]; orgId?: string; revoked?: boolean };

/**
 * Three identities that differ ONLY in their org binding, so nothing but the binding can explain a
 * different answer. `authorize` allows everything: this file is about the org guards, and a permission
 * refusal would mask them.
 */
const auth = {
  authenticate: (req: Request) => {
    const t = req.headers.get('authorization')?.replace('Bearer ', '');
    if (t === 'root') return { roles: ['admin', 'platform-admin'], id: 'u-root' }; // org-less operator
    if (t === 'acme-adm') return { roles: ['admin'], id: 'u-acme-adm', orgId: 'acme' };
    if (t === 'globex-adm') return { roles: ['admin'], id: 'u-globex-adm', orgId: 'globex' };
    return null;
  },
  authorize: () => ({ allow: true }),
  capabilities: () => ({ sso: false, rbac: false, audit: false, multiOrganization: true, users: true }),
};

/** A user store that actually STORES, so "was the user created, and under which org" is answerable. */
function userStore(opts: { listReturns?: 'all' | 'none' } = {}) {
  const mem = new Map<string, User>();
  const calls: string[] = [];
  let seq = 0;
  return {
    mem,
    calls,
    store: {
      list: async () => (opts.listReturns === 'none' ? [] : [...mem.values()]),
      create: async (u: Omit<User, 'id'>) => {
        const id = `u${++seq}`;
        const user: User = { ...u, id, roles: u.roles ?? [] };
        mem.set(id, user);
        return { user, token: `tok-${id}` };
      },
      update: async (id: string, patch: Partial<User>) => {
        const u = { ...mem.get(id)!, ...patch };
        mem.set(id, u);
        return u;
      },
      remove: async (id: string) => { calls.push(`remove:${id}`); mem.delete(id); },
      revoke: async (id: string) => { calls.push(`revoke:${id}`); const u = mem.get(id); if (u) u.revoked = true; },
    },
  };
}

const J = (body: unknown, token: string) => ({
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify(body),
});

async function makeApp(storeOpts: Parameters<typeof userStore>[0] = {}) {
  const journal = new InMemoryJournal();
  const us = userStore(storeOpts);
  const api = createStudioApi({ reader: journal, auth, org: {}, users: us.store as never });
  const send = async (path: string, init: RequestInit) => {
    const res = await api(new Request(`http://x${path}`, init));
    const text = await res.text();
    let json: any; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, json, text };
  };
  return { journal, us, send };
}

describe('creating an organization and its first admin, in order', () => {
  it('the whole sequence: the org must exist first, only an operator makes one, and its admin is then confined to it', async () => {
    const { us, send } = await makeApp();

    // 1. BEFORE the org exists, assigning a member to it is refused — a member cannot be added to a
    //    ghost org. Driven as the OPERATOR, because an org-bound caller would be refused earlier by
    //    the same-org guard and would never reach this check.
    const ghost = await send('/users', J({ email: 'a@acme.test', roles: ['admin'], orgId: 'acme' }, 'root'));
    expect(ghost.status, 'a member was assigned to an organization that does not exist').toBe(400);
    expect(ghost.json.error).toContain("doesn't exist");
    expect(ghost.json.error).toContain('create the org first');
    expect(us.mem.size, 'the refused create still reached the store').toBe(0);

    // 2. An org-bound admin cannot create an organization at all.
    const bound = await send('/organizations', J({ id: 'acme' }, 'acme-adm'));
    expect(bound.status, 'an org-bound identity created an organization').toBe(403);
    expect(bound.json.error).toContain('an org-bound identity cannot create a new org');

    // 3. The operator creates it.
    const made = await send('/organizations', J({ id: 'acme', label: 'Acme' }, 'root'));
    expect(made.status, 'the operator could not create an organization').toBe(200);
    expect(made.json.organization?.id).toBe('acme');

    // 4. NOW the same request from step 1 succeeds, and the member lands in that org. This pair is the
    //    contract: the identical request answers 400 then 200, and only creating the org happened in
    //    between.
    const admin = await send('/users', J({ email: 'a@acme.test', roles: ['admin'], orgId: 'acme' }, 'root'));
    expect(admin.status, "the operator could not add the new organization's admin").toBe(200);
    expect(admin.json.user?.orgId, "the new admin was not bound to the organization it was created for").toBe('acme');
    expect(us.mem.get(admin.json.user.id)?.orgId, 'the STORED record carries a different org than the answer').toBe('acme');

    // 5. THE SILENT DEFAULT, asserted on the stored record. An org admin that omits `orgId` must get a
    //    user in ITS OWN org — not an org-less one, and not a refusal. Deleting `targetOrg = own`
    //    leaves every refusal below passing while this user silently becomes global.
    const implied = await send('/users', J({ email: 'b@acme.test', roles: ['viewer'] }, 'acme-adm'));
    expect(implied.status, 'an org admin could not create a user in its own org without naming it').toBe(200);
    expect(implied.json.user?.orgId, 'the omitted orgId did not fall back to the caller\'s own org').toBe('acme');
    expect(us.mem.get(implied.json.user.id)?.orgId,
      'the fallback org reached the answer but not the store').toBe('acme');

    // 6. Naming SOMEONE ELSE'S org is refused — the guard the fallback sits behind.
    const foreign = await send('/users', J({ email: 'c@globex.test', roles: ['admin'], orgId: 'globex' }, 'acme-adm'));
    expect(foreign.status, 'an org admin created a user in another organization').toBe(403);
    expect(foreign.json.error).toContain("you can only create users in your own org ('acme')");

    // 7. Naming its OWN org explicitly is the same as omitting it.
    const explicit = await send('/users', J({ email: 'd@acme.test', roles: ['viewer'], orgId: 'acme' }, 'acme-adm'));
    expect(explicit.status, 'an org admin could not name its own org explicitly').toBe(200);
    expect(explicit.json.user?.orgId).toBe('acme');

    // 8. The privilege ceiling still holds inside its own org: an org admin cannot mint a platform-admin.
    const escalate = await send('/users', J({ email: 'e@acme.test', roles: ['platform-admin'] }, 'acme-adm'));
    expect(escalate.status, 'an org admin minted a platform-admin').toBe(403);
    expect(escalate.json.error).toContain('platform-admin');

    // 9. Nothing refused above was written.
    const orgs = [...us.mem.values()].map((u) => u.orgId);
    expect(orgs, 'a refused request created a user anyway').toEqual(['acme', 'acme', 'acme']);
  });
});

describe('what an org admin may do to a user in ANOTHER organization', () => {
  /**
   * Measured, because the guard on `POST /users` does not imply these: it compares `body.orgId` against
   * the caller, while delete/revoke/patch each LOOK THE TARGET UP first and compare the stored record's
   * org. Different mechanism, so it needed its own answer. All three refuse, and none of them reaches
   * the host — a refusal that still called `remove` would be a 403 in name only.
   */
  it('delete, revoke and update are each refused, and never reach the host', async () => {
    const { us, send } = await makeApp();
    await send('/organizations', J({ id: 'acme' }, 'root'));
    await send('/organizations', J({ id: 'globex' }, 'root'));
    await send('/users', J({ email: 'a@acme.test', roles: ['admin'], orgId: 'acme' }, 'root'));
    const g = await send('/users', J({ email: 'g@globex.test', roles: ['admin'], orgId: 'globex' }, 'root'));
    const gid = g.json.user.id;
    const H = { authorization: 'Bearer acme-adm' };

    const del = await send(`/users/${gid}`, { method: 'DELETE', headers: H });
    const rev = await send(`/users/${gid}/revoke`, { method: 'POST', headers: H });
    const pat = await send(`/users/${gid}`, {
      method: 'PATCH', headers: { ...H, 'content-type': 'application/json' },
      body: JSON.stringify({ roles: ['viewer'] }),
    });

    // The EFFECT first: a guard that answers 403 after already mutating is not a guard. `calls` records
    // every remove/revoke that reached the store.
    expect(us.calls, "a refused request still reached the host's user store").toEqual([]);
    expect([...us.mem.values()].map((u) => `${u.id}:${u.orgId}:${u.roles.join('/')}:${u.revoked ?? false}`),
      "another organization's user was altered by a refused request")
      .toEqual(['u1:acme:admin:false', 'u2:globex:admin:false']);

    expect(del.status, "an org admin deleted another organization's user").toBe(403);
    expect(del.json.error).toContain("you can only delete members of your own org ('acme')");
    expect(rev.status, "an org admin revoked another organization's user").toBe(403);
    expect(rev.json.error).toContain("you can only revoke members of your own org ('acme')");
    expect(pat.status, "an org admin updated another organization's user").toBe(403);
    expect(pat.json.error).toContain("you can only update members of your own org ('acme')");
  });

  /** The same three routes, against a member of the caller's OWN org, must still work — otherwise the
   *  test above would pass just as well against a route that refuses everybody. */
  it('the same three succeed against a member of the caller\'s own org', async () => {
    const { us, send } = await makeApp();
    await send('/organizations', J({ id: 'acme' }, 'root'));
    const mine = await send('/users', J({ email: 'b@acme.test', roles: ['viewer'] }, 'acme-adm'));
    const id = mine.json.user.id;
    const H = { authorization: 'Bearer acme-adm' };

    expect((await send(`/users/${id}`, {
      method: 'PATCH', headers: { ...H, 'content-type': 'application/json' },
      body: JSON.stringify({ roles: ['admin'] }),
    })).status, 'an org admin could not update its own member').toBe(200);
    expect((await send(`/users/${id}/revoke`, { method: 'POST', headers: H })).status,
      'an org admin could not revoke its own member').toBe(200);
    expect((await send(`/users/${id}`, { method: 'DELETE', headers: H })).status,
      'an org admin could not delete its own member').toBe(200);
    expect(us.calls).toEqual([`revoke:${id}`, `remove:${id}`]);
  });
});
