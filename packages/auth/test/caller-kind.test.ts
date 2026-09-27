// WHAT a caller is — operator, application or subject — is stamped by whoever minted the principal,
// and read in one place (`callerKind`). It used to be inferred downstream from the ABSENCE of a name
// (`!p?.id` ⇒ operator), which made every named org admin a subject and every nameless end user an
// operator. These tests pin the stamp at the source and the fail-closed reading of anything unstamped.
import { describe, it, expect } from 'vitest';
import { roleAuth, callerKind, assertAssignablePrivileges, type Principal } from '../src/index.js';

const bearer = (tok: string): Request => new Request('http://x/', { headers: { authorization: `Bearer ${tok}` } });

describe('callerKind — one answer to "what is this caller"', () => {
  it('every roleAuth class says what it is: staff are operators, `client` is the application', async () => {
    const auth = roleAuth({ superAdmin: { token: 's' }, admin: { token: 'a' }, client: { token: 'c' }, viewer: { token: 'v' } })!;
    const kinds = Object.fromEntries(
      await Promise.all(['s', 'a', 'c', 'v'].map(async (t) => [t, callerKind(await auth.authenticate(bearer(t)))])),
    );
    expect(kinds).toEqual({ s: 'operator', a: 'operator', c: 'application', v: 'operator' });
  });

  it('a NAMED staff credential is still an operator — a name does not make it a user', async () => {
    const auth = roleAuth({ admin: { user: 'ops', pass: 'p', orgId: 'acme' } })!;
    const req = new Request('http://x/', { headers: { authorization: `Basic ${Buffer.from('ops:p').toString('base64')}` } });
    const p = await auth.authenticate(req);
    expect(p?.id).toBe('ops');
    expect(callerKind(p)).toBe('operator');
  });

  it('no principal is unnamed', () => {
    expect(callerKind(null)).toBe('unnamed');
    expect(callerKind(undefined)).toBe('unnamed');
  });

  it('a subject with no name is unnamed — it cannot speak for anyone, not even itself', () => {
    expect(callerKind({ kind: 'subject', roles: [] })).toBe('unnamed');
    expect(callerKind({ kind: 'subject', id: '', roles: [] })).toBe('unnamed');
    expect(callerKind({ kind: 'subject', id: 'u-ayse', roles: [] })).toBe('subject');
  });

  it('an UNSTAMPED principal (a JS provider, a cast) reads fail-closed: a user if named, else unnamed', () => {
    // The old inference would have made the nameless one an operator. Never again: staff is declared.
    expect(callerKind({ id: 'u-ayse', roles: ['admin'] } as unknown as Principal)).toBe('subject');
    expect(callerKind({ roles: ['admin'] } as unknown as Principal)).toBe('unnamed');
    expect(callerKind({ kind: 'root', id: 'x', roles: [] } as unknown as Principal)).toBe('subject');
  });

  it('the platform-admin ROLE does not change the kind — scope and kind are separate axes', () => {
    expect(callerKind({ kind: 'subject', id: 'u', roles: ['platform-admin'] })).toBe('subject');
  });
});

describe('assertAssignablePrivileges — only an operator can mint a caller that is not a user', () => {
  const op: Principal = { kind: 'operator', roles: ['admin'], orgId: 'acme' };
  const app: Principal = { kind: 'application', roles: ['client'], orgId: 'acme' };
  const user: Principal = { kind: 'subject', id: 'u-ayse', roles: ['admin'], orgId: 'acme' };

  it('an operator may create operators and applications', () => {
    expect(assertAssignablePrivileges(op, { kind: 'operator' })).toEqual({ ok: true });
    expect(assertAssignablePrivileges(op, { kind: 'application' })).toEqual({ ok: true });
  });

  it('a subject cannot, whatever its roles say', () => {
    expect(assertAssignablePrivileges(user, { kind: 'operator' }).ok).toBe(false);
    expect(assertAssignablePrivileges(user, { kind: 'application' }).ok).toBe(false);
  });

  it('an application cannot mint staff either — it speaks for users, it does not hire', () => {
    expect(assertAssignablePrivileges(app, { kind: 'operator' }).ok).toBe(false);
  });

  it('nobody is refused for creating a plain user', () => {
    for (const who of [op, app, user, null]) expect(assertAssignablePrivileges(who, { kind: 'subject' })).toEqual({ ok: true });
    expect(assertAssignablePrivileges(user, {})).toEqual({ ok: true });
  });
});
