// The one decision about who may reach a surface that listens on a socket.
//
// This rule existed twice before it existed here — once in @gnldev/studio, once in @gnldev/cli — and
// the two were run against the same hosts. They disagreed four ways, and neither copy was simply the
// stricter one: each left open a hole the other had already closed. Those four are the first group
// below, asserted as the regressions they are.
import { describe, it, expect } from 'vitest';
import { decideExposure, isLoopbackHost, isPublishedDevCredential, PUBLISHED_DEV_TOKENS } from '../src/index.js';

const base = { surface: 'gnl studio', authRemedy: 'Configure auth in gnl.config.', allowOpenNetwork: false };

describe('the four divergences the two copies had', () => {
  it('a prefix match is not an address — 127.0.0.1.evil.com is NOT local', () => {
    // studio's copy used startsWith('127.'), so this name — which resolves wherever its owner points
    // it — read as loopback, and an unauthenticated ADMIN panel was served on it with no refusal and
    // no warning.
    expect(isLoopbackHost('127.0.0.1.evil.com')).toBe(false);
    const d = decideExposure({ ...base, host: '127.0.0.1.evil.com', authed: false });
    expect(d.refusal, 'a name that is not an address must go through the network refusal').toBeTruthy();
  });

  it('the whole of 127.0.0.0/8 is local, not just 127.0.0.1', () => {
    // cli's copy held a fixed set, so `gnl dev --host 127.5.5.5` was refused as if it were a network
    // bind. It is a local address; refusing it protects nobody and blocks a legitimate setup.
    expect(isLoopbackHost('127.5.5.5')).toBe(true);
    expect(isLoopbackHost('127.0.0.2')).toBe(true);
    expect(decideExposure({ ...base, host: '127.5.5.5', authed: false }).refusal).toBeUndefined();
  });

  it('case does not decide whether a host is local', () => {
    // studio's copy was case-sensitive: `--host LOCALHOST` read as a network host and was refused.
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
    expect(isLoopbackHost('LocalHost')).toBe(true);
    expect(decideExposure({ ...base, host: 'LOCALHOST', authed: false }).refusal).toBeUndefined();
  });

  it('a token published in this project’s own npm tarball is not auth', () => {
    // studio's copy did not know about the shipped credentials, so `gnl-studio --host 0.0.0.0` with
    // `auth: { admin: { token: 'admin-dev' } }` served, and printed "(auth: protected)".
    const d = decideExposure({ ...base, host: '0.0.0.0', authed: true, credentialTokens: ['admin-dev', undefined] });
    expect(d.refusal, 'a registry-readable credential must not satisfy the network refusal').toBeTruthy();
    expect(d.refusal).toContain('npm tarball');
    expect(d.authed).toBe(false);
    expect(d.authModeLabel).toBe('shipped dev token — treat as OPEN');
  });
});

describe('isLoopbackHost', () => {
  it('accepts the forms a user actually types', () => {
    for (const h of ['127.0.0.1', 'localhost', '::1', '[::1]', '  127.0.0.1  ', '127.255.255.254']) {
      expect(isLoopbackHost(h), h).toBe(true);
    }
  });
  it('rejects everything that can be reached from elsewhere', () => {
    for (const h of ['0.0.0.0', '::', '10.0.0.5', '192.168.1.9', 'example.com', '128.0.0.1', '', '27.0.0.1']) {
      expect(isLoopbackHost(h), h).toBe(false);
    }
  });
  it('rejects a malformed address rather than reading it as local', () => {
    // An out-of-range octet is not an address; treating it as one would be a parse that fails open.
    for (const h of ['127.0.0.999', '127.0.0', '127.0.0.1.2', '127..0.1']) {
      expect(isLoopbackHost(h), h).toBe(false);
    }
  });
});

describe('published dev credentials', () => {
  it('recognises a set made only of values this project shipped', () => {
    expect(isPublishedDevCredential(['admin-dev', 'viewer-dev'])).toBe(true);
    expect(isPublishedDevCredential(['admin-dev', undefined])).toBe(true);
  });
  it('a real token — including one alongside a shipped one — is auth', () => {
    expect(isPublishedDevCredential(['admin-dev', 'generated-9f2c'])).toBe(false);
    expect(isPublishedDevCredential(['generated-9f2c'])).toBe(false);
  });
  it('no credential at all is the auth-off case, not the published case', () => {
    expect(isPublishedDevCredential([])).toBe(false);
    expect(isPublishedDevCredential([undefined, undefined])).toBe(false);
    expect(isPublishedDevCredential([''])).toBe(false);
  });
  it('the list can only shrink — it is a closed set, not a pattern', () => {
    expect([...PUBLISHED_DEV_TOKENS].sort()).toEqual(['admin-dev', 'viewer-dev']);
  });
});

describe('decideExposure', () => {
  it('refuses the network + no auth combination, and the message names both ways out', () => {
    const d = decideExposure({ ...base, host: '0.0.0.0', authed: false });
    expect(d.refusal).toContain('refusing to serve on 0.0.0.0');
    expect(d.refusal).toContain('Configure auth in gnl.config.');
    expect(d.refusal).toContain('--allow-open-network');
    expect(d.allowOpenAccess, 'a refused start must not also assert open access').toBe(false);
  });

  it('serves a network host once auth resolved, and says what is exposed', () => {
    const d = decideExposure({ ...base, host: '10.0.0.5', authed: true, credentialTokens: ['s3cret', undefined] });
    expect(d.refusal).toBeUndefined();
    expect(d.exposed).toBe(true);
    expect(d.notice).toContain('(auth: protected)');
    expect(d.allowOpenAccess, 'auth is configured — open access would contradict the gate').toBe(false);
    expect(d.warnings.join(' ')).toContain('reachable from the network');
  });

  it('serves an unauthenticated network host only on the explicit opt-in, and says so loudly', () => {
    const d = decideExposure({ ...base, host: '0.0.0.0', authed: false, allowOpenNetwork: true });
    expect(d.refusal).toBeUndefined();
    expect(d.allowOpenAccess).toBe(true);
    expect(d.notice).toContain('NO AUTH');
    expect(d.warnings.join(' ')).toContain('NO AUTH');
  });

  it('loopback without auth is allowed but never silent', () => {
    const d = decideExposure({ ...base, authed: false });
    expect(d.refusal).toBeUndefined();
    expect(d.loopback).toBe(true);
    expect(d.allowOpenAccess).toBe(true);
    expect(d.warnings, 'an unauthenticated surface must say so even on loopback').not.toHaveLength(0);
    expect(d.notice, 'nothing is exposed, so there is nothing to notice').toBe('');
  });

  it('loopback with auth is quiet and does not assert open access', () => {
    const d = decideExposure({ ...base, authed: true, credentialTokens: ['s3cret', undefined] });
    expect(d.warnings).toHaveLength(0);
    expect(d.allowOpenAccess).toBe(false);
  });

  it('never prints a wildcard as if it were dialable', () => {
    for (const h of ['0.0.0.0', '::']) {
      const d = decideExposure({ ...base, host: h, authed: false, allowOpenNetwork: true });
      expect(d.displayHost, h).toBe('localhost');
      expect(d.hostname, 'the bind target itself must not be rewritten').toBe(h);
    }
  });

  it('normalises the loopback spellings rather than passing them through', () => {
    expect(decideExposure({ ...base, host: 'localhost', authed: false }).hostname).toBe('127.0.0.1');
    expect(decideExposure({ ...base, host: 'LOCALHOST', authed: false }).hostname).toBe('127.0.0.1');
    expect(decideExposure({ ...base, authed: false }).hostname, 'the default is loopback, not a wildcard').toBe('127.0.0.1');
  });

  it('the notice and the mode label read the same answer', () => {
    // These were computed separately at one call site, and printed "treat as OPEN" two lines above
    // "(auth: protected)" for the same process.
    const d = decideExposure({ ...base, host: '0.0.0.0', authed: true, credentialTokens: ['admin-dev', undefined], allowOpenNetwork: true });
    expect(d.authModeLabel).toBe('shipped dev token — treat as OPEN');
    expect(d.notice).toContain('NO AUTH');
    expect(d.notice).not.toContain('protected');
  });
});
