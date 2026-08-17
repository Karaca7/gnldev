// Who can reach the Studio. Both cases here shipped broken and neither was catchable, because the
// decision was inline at the top of a bin script that runs on import.
//
// What was measured before the fix, on the publish candidate:
//   • `auth: { admin: { token } }` in gnl.config → `PUT /api/policy` succeeded with NO credentials.
//     cli.ts built its options object without ever reading `cfg.auth`, and then warned the user to
//     "configure roleAuth via --config" — the thing they had already done, which did nothing.
//   • `gnl-studio --host 0.0.0.0` (documented in packages/studio/README.md) served an unauthenticated
//     ADMIN panel — policy writes, retention purge, cache invalidation, a Playground that spends the
//     project's API keys — to every interface, and printed no warning at all. `allowOpenAccess` was
//     assigned `loopback`, so off-loopback it merely passed `false` to a gate that throws only under
//     NODE_ENV=production.
import { describe, it, expect } from 'vitest';
import { decideExposure, isLoopbackHost } from '../src/expose.js';

const on = (host: string, authed: boolean, allowOpenNetwork = false) =>
  decideExposure({ host, authed, allowOpenNetwork });

describe('studio exposure decision', () => {
  it('refuses a network host with no auth — the combination that is unsafe by construction', () => {
    for (const host of ['0.0.0.0', '::', '192.168.1.10', 'studio.internal']) {
      const d = on(host, false);
      expect(d.refusal, `${host} must be refused`).toBeDefined();
      expect(d.refusal).toContain('refusing to serve');
      expect(d.refusal, 'the message must name both ways out').toContain('--allow-open-network');
      expect(d.refusal).toContain('auth: { admin: { token: ... } }');
      expect(d.allowOpenAccess, 'a refused start must not also assert open access').toBe(false);
    }
  });

  it('a network host WITH auth serves, and says what is exposed', () => {
    const d = on('0.0.0.0', true);
    expect(d.refusal).toBeUndefined();
    // The contradiction the old code could produce: auth configured AND open access asserted.
    expect(d.allowOpenAccess, 'auth is configured, so open access must not be claimed').toBe(false);
    expect(d.warnings.join(' ')).toContain('auth: protected');
  });

  it('a network host with no auth serves only on the explicit opt-in, and says so loudly', () => {
    const d = on('0.0.0.0', false, true);
    expect(d.refusal).toBeUndefined();
    expect(d.allowOpenAccess).toBe(true);
    const said = d.warnings.join(' ');
    expect(said).toContain('NO AUTH');
    expect(said, 'the flag that caused it is named, so the log explains itself').toContain('--allow-open-network');
  });

  it('loopback with no auth is allowed but never silent', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      const d = on(host, false);
      expect(d.refusal).toBeUndefined();
      expect(d.allowOpenAccess).toBe(true);
      expect(d.warnings.join(' '), `${host} must warn`).toContain('open without auth');
    }
  });

  it('loopback WITH auth is quiet and does not assert open access', () => {
    const d = on('127.0.0.1', true);
    expect(d.refusal).toBeUndefined();
    expect(d.allowOpenAccess).toBe(false);
    expect(d.warnings, 'nothing is exposed and nothing is open — there is nothing to say').toEqual([]);
  });

  it('isLoopbackHost covers the forms a user actually types', () => {
    for (const h of ['127.0.0.1', '127.0.0.2', 'localhost', '::1', '[::1]', ' 127.0.0.1 ']) {
      expect(isLoopbackHost(h), h).toBe(true);
    }
    for (const h of ['0.0.0.0', '::', '192.168.1.10', 'example.com', '10.0.0.1']) {
      expect(isLoopbackHost(h), h).toBe(false);
    }
  });
});
