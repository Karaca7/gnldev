// `roleAuth({ endUsers })`: the holder of a token the application signed is ONE user, and only `sub`
// is read from it. See packages/server/test/signed-end-user-token.test.ts for the same over HTTP.
import { describe, it, expect } from 'vitest';
import { roleAuth, signSubjectToken, callerKind, END_USER_ROLE } from '../src/index.js';

const SECRET = 'app-signing-secret-at-least-32-bytes!!';
const bearer = (t: string) => new Request('http://x/', { headers: { authorization: `Bearer ${t}` } });

describe('roleAuth endUsers', () => {
  it('a class with no key to verify with is a startup error, not a provider that accepts nothing', () => {
    expect(() => roleAuth({ endUsers: {} })).toThrow(/secret.*publicKey/);
  });

  it('endUsers alone is a provider (auth is on)', () => {
    expect(roleAuth({ endUsers: { secret: SECRET } })).toBeDefined();
  });

  it('mints exactly one subject, bound to the configured organization, whatever the claims say', async () => {
    const auth = roleAuth({ endUsers: { secret: SECRET, orgId: 'acme' } })!;
    const p = await auth.authenticate(bearer(signSubjectToken({ sub: 'u-ayse', kind: 'operator', roles: ['admin'], orgId: 'globex' }, SECRET)));
    expect(p).toEqual({ kind: 'subject', id: 'u-ayse', roles: [END_USER_ROLE], orgId: 'acme' });
    expect(callerKind(p)).toBe('subject');
  });

  it('a static staff token still wins — it is checked first', async () => {
    const auth = roleAuth({ admin: { token: 'A' }, endUsers: { secret: SECRET } })!;
    expect((await auth.authenticate(bearer('A')))?.kind).toBe('operator');
  });

  it('no sub, a wrong key, an expired token, or iss/aud mismatch: nobody', async () => {
    const auth = roleAuth({ endUsers: { secret: SECRET, issuer: 'my-app', audience: 'gnl' } })!;
    const ok = { iss: 'my-app', aud: 'gnl' };
    expect(await auth.authenticate(bearer(signSubjectToken({ sub: 'u', ...ok }, SECRET)))).not.toBeNull();
    expect(await auth.authenticate(bearer(signSubjectToken({ sub: '', ...ok }, SECRET)))).toBeNull();
    expect(await auth.authenticate(bearer(signSubjectToken({ sub: 'u', ...ok }, 'another-secret-that-is-32-bytes-long')))).toBeNull();
    expect(await auth.authenticate(bearer(signSubjectToken({ sub: 'u', ...ok }, SECRET, { ttlSec: -1 })))).toBeNull();
    expect(await auth.authenticate(bearer(signSubjectToken({ sub: 'u', iss: 'other', aud: 'gnl' }, SECRET)))).toBeNull();
    expect(await auth.authenticate(bearer(signSubjectToken({ sub: 'u', iss: 'my-app', aud: 'x' }, SECRET)))).toBeNull();
  });

  it('writes are the application whitelist: run and cancel, nothing else', async () => {
    const auth = roleAuth({ endUsers: { secret: SECRET } })!;
    const p = await auth.authenticate(bearer(signSubjectToken({ sub: 'u' }, SECRET)));
    const req = bearer('x');
    expect(await auth.authorize(p, req, { path: '/', method: 'POST', action: 'write', permission: 'agents:run' })).toEqual({ allow: true });
    expect((await auth.authorize(p, req, { path: '/', method: 'POST', action: 'write', permission: 'budget:write' })).allow).toBe(false);
    expect((await auth.authorize(p, req, { path: '/', method: 'GET', action: 'read' })).allow).toBe(true);
  });
});

describe('roleAuth endUsers — hardening', () => {
  const now = Math.floor(Date.now() / 1000);
  const tok = (claims: Record<string, unknown>, ttlSec = 300) => signSubjectToken({ sub: 'u-ayse', ...claims }, SECRET, { ttlSec });

  it('a secret shorter than 32 bytes is a startup error, on both sides', () => {
    expect(() => roleAuth({ endUsers: { secret: '' } })).toThrow(/32 bytes/);
    expect(() => roleAuth({ endUsers: { secret: 'x' } })).toThrow(/32 bytes/);
    expect(() => signSubjectToken({ sub: 'u' }, 'short')).toThrow(/32 bytes/);
  });

  it('without isRevoked a token may live 1 hour; asking for more is a startup error', async () => {
    const auth = roleAuth({ endUsers: { secret: SECRET } })!;
    expect(await auth.authenticate(bearer(tok({}, 3600)))).not.toBeNull();
    expect(await auth.authenticate(bearer(tok({}, 24 * 3600)))).toBeNull();
    expect(() => roleAuth({ endUsers: { secret: SECRET, maxTtlSec: 2 * 3600 } })).toThrow(/needs `isRevoked`/);
  });

  it('with isRevoked a longer lifetime is allowed, up to 30 days', async () => {
    const auth = roleAuth({ endUsers: { secret: SECRET, maxTtlSec: 7 * 24 * 3600, isRevoked: () => false } })!;
    expect(await auth.authenticate(bearer(tok({}, 24 * 3600)))).not.toBeNull();
    expect(await auth.authenticate(bearer(tok({}, 8 * 24 * 3600)))).toBeNull();
    expect(() => roleAuth({ endUsers: { secret: SECRET, maxTtlSec: 31 * 24 * 3600, isRevoked: () => false } })).toThrow(/30 days/);
  });

  it('a revoked token is nobody, and a hook that throws refuses', async () => {
    const revoked = roleAuth({ endUsers: { secret: SECRET, isRevoked: ({ jti }) => jti === 'sess-1' } })!;
    expect(await revoked.authenticate(bearer(tok({ jti: 'sess-1' })))).toBeNull();
    expect(await revoked.authenticate(bearer(tok({ jti: 'sess-2' })))).not.toBeNull();
    const broken = roleAuth({ endUsers: { secret: SECRET, isRevoked: () => { throw new Error('store down'); } } })!;
    expect(await broken.authenticate(bearer(tok({})))).toBeNull();
    // The hook sees who and when, not only the id.
    let seen: unknown;
    await roleAuth({ endUsers: { secret: SECRET, isRevoked: (c) => { seen = c; return false; } } })!.authenticate(bearer(tok({ jti: 'j' })));
    expect(seen).toMatchObject({ sub: 'u-ayse', jti: 'j', iat: expect.any(Number) });
    expect((seen as { iat: number }).iat).toBeGreaterThanOrEqual(now - 5);
  });

  it('a sub that could not be a resourceId, or sits in a staff namespace, is nobody', async () => {
    const auth = roleAuth({ endUsers: { secret: SECRET } })!;
    for (const sub of ['a\u0000b', 'x'.repeat(201), 'operator:ops', 'application:app', 'role:admin', 'token:abc']) {
      expect(await auth.authenticate(bearer(signSubjectToken({ sub }, SECRET))), JSON.stringify(sub)).toBeNull();
    }
    expect(await auth.authenticate(bearer(signSubjectToken({ sub: 'x'.repeat(200) }, SECRET)))).not.toBeNull();
  });

  it('no credential is 401 on a write too, so a client knows a refresh would help', async () => {
    const auth = roleAuth({ admin: { token: 'A' }, endUsers: { secret: SECRET } })!;
    const w = await auth.authorize(null, bearer('x'), { path: '/', method: 'POST', action: 'write', permission: 'agents:run' });
    expect(w).toEqual({ allow: false, status: 401, reason: 'unauthorized' });
  });
});

describe('actorIdOf — staff and users never share a name', () => {
  it('a subject keeps its id; staff are kind-qualified', async () => {
    const { actorIdOf } = await import('../src/index.js');
    expect(actorIdOf({ kind: 'subject', id: 'ops', roles: [] })).toBe('ops');
    expect(actorIdOf({ kind: 'operator', id: 'ops', roles: [] })).toBe('operator:ops');
    expect(actorIdOf({ kind: 'application', id: 'app', roles: [] })).toBe('application:app');
    expect(actorIdOf({ kind: 'operator', roles: [] })).toBeUndefined();
  });
});

describe('identityFromAuth — MCP asks the same provider the HTTP surfaces ask', () => {
  it('an end user is an MCP identity, bound to itself and its organization; nobody else is', async () => {
    const { identityFromAuth } = await import('../src/index.js');
    const auth = roleAuth({ admin: { token: 'STAFF' }, client: { token: 'APP' }, endUsers: { secret: SECRET, orgId: 'acme' } })!;
    const identity = identityFromAuth(auth);
    const ayse = signSubjectToken({ sub: 'u-ayse' }, SECRET);
    expect(await identity({ authInfo: { token: ayse } })).toEqual({ resourceId: 'u-ayse', orgId: 'acme', actor: 'u-ayse' });
    // Staff names nobody, so no per-user work id can be derived; an application could only name its
    // user in the call body. Both are refused — mint the user a subject token instead.
    expect(await identity({ authInfo: { token: 'STAFF' } })).toBeUndefined();
    expect(await identity({ authInfo: { token: 'APP' } })).toBeUndefined();
    expect(await identity({ authInfo: { token: 'forged.token.value' } })).toBeUndefined();
    expect(await identity({})).toBeUndefined();
  });
});
