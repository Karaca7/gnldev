// The token endpoint answers a browser's cookie-authenticated request with a bearer that JavaScript
// can read. It used to copy the session id into that bearer's `jti` — the session cookie's value, the
// one thing the cookie was HttpOnly to keep from scripts. A script that got a 5-minute token then had
// the long-lived session too. Now the token carries a one-way id derived from the session, which still
// lets a logout revoke every token of that session.
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { subjectTokenEndpoint, sessionTokenId, roleAuth } from '../src/index.js';

const SECRET = randomBytes(32).toString('hex');
const SID = randomBytes(24).toString('base64url');
const claims = (t: string) => JSON.parse(Buffer.from(t.split('.')[1]!, 'base64url').toString());
const mint = async () => {
  const ep = subjectTokenEndpoint(async () => ({ sub: 'u-ayse', sid: SID }), SECRET, { ttlSec: 300 });
  const res = await ep(new Request('https://app.example/gnl-token', { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } }));
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
};

describe('the token carries no session secret', () => {
  it('its jti is not the session id, and does not contain it', async () => {
    const t = await mint();
    expect(claims(t).jti).not.toBe(SID);
    expect(t).not.toContain(SID);
    expect(claims(t).jti).toBe(sessionTokenId(SID));
  });

  it('a logout still revokes the session\'s tokens, by the derived id', async () => {
    const t = await mint();
    const loggedOut = new Set<string>();
    const auth = roleAuth({ endUsers: { secret: SECRET, orgId: 'acme', isRevoked: ({ jti }) => (jti ? loggedOut.has(jti) : false) } })!;
    const req = () => new Request('https://gnl.example/runs', { headers: { authorization: `Bearer ${t}` } });
    expect(await auth.authenticate(req())).not.toBeNull();
    loggedOut.add(sessionTokenId(SID));
    expect(await auth.authenticate(req())).toBeNull();
  });

  it('the derived id is stable per session and differs across sessions', () => {
    expect(sessionTokenId('a')).toBe(sessionTokenId('a'));
    expect(sessionTokenId('a')).not.toBe(sessionTokenId('b'));
  });
});
