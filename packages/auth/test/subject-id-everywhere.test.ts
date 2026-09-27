// A subject id that could pass for staff, or hide a character, is no user at all — whichever provider
// minted it. The rule lived in roleAuth's own verifier only, so a user from SSO, from Auth0/WorkOS or
// from a user store could be `operator:ops`: the same actor name as the operator `ops`. Now it is
// asked where every consumer asks what a caller is (`callerKind`), so every provider is covered.
import { describe, it, expect } from 'vitest';
import { randomBytes, createHmac } from 'node:crypto';
import { callerKind, actorIdOf, subjectIdProblem, verifyJwt, signSubjectToken } from '../src/index.js';

describe('subject ids', () => {
  it('a reserved prefix, a control character or a line separator makes a subject unnamed', () => {
    for (const id of ['operator:ops', 'application:x', 'role:admin', 'token:t', 'a\u0000b', 'a\u0085b', 'a b', 'x'.repeat(201), '']) {
      expect(callerKind({ kind: 'subject', id, roles: [] } as never), JSON.stringify(id)).toBe('unnamed');
      expect(actorIdOf({ kind: 'subject', id, roles: [] } as never), JSON.stringify(id)).toBeUndefined();
    }
    expect(subjectIdProblem('operator:ops')).toBe('reserved prefix');
  });

  it('an ordinary id is a subject, and staff are unaffected', () => {
    expect(callerKind({ kind: 'subject', id: 'u-ayse', roles: [] } as never)).toBe('subject');
    expect(callerKind({ kind: 'operator', id: 'ops', roles: [] } as never)).toBe('operator');
    expect(actorIdOf({ kind: 'operator', id: 'ops', roles: [] } as never)).toBe('operator:ops');
  });
});

describe('a JWT is read strictly', () => {
  const SECRET = randomBytes(32).toString('hex');
  it('a signature with characters outside base64url is refused, not decoded around', () => {
    const t = signSubjectToken({ sub: 'u1' }, SECRET);
    expect(verifyJwt(t, { secret: SECRET }, Date.now())).not.toBeNull();
    for (const junk of ['=', '!', '~', ' ']) expect(verifyJwt(t + junk, { secret: SECRET }, Date.now()), JSON.stringify(junk)).toBeNull();
  });

  it('a segment of the header or payload with junk is refused too', () => {
    const [h, p, s] = signSubjectToken({ sub: 'u1' }, SECRET).split('.');
    expect(verifyJwt(`${h}!.${p}.${s}`, { secret: SECRET }, Date.now())).toBeNull();
    const payload = Buffer.from(JSON.stringify({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + 60 })).toString('base64url') + '~';
    const sig = createHmac('sha256', SECRET).update(`${h}.${payload}`).digest('base64url');
    expect(verifyJwt(`${h}.${payload}.${sig}`, { secret: SECRET }, Date.now())).toBeNull();
  });
});
