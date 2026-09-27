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
