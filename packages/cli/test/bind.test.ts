// `serve({ fetch, port })` passes no hostname, and @hono/node-server then binds `::` — every
// interface. Both `gnl dev` and `gnl studio` did that while printing `http://localhost:<port>`, and
// `gnl studio` additionally never wired an auth provider, so the admin surface (purgeRun,
// managed-agent promote, cache invalidation, a Playground that spends the operator's API keys) was
// reachable and unauthenticated from any host on the same network.
//
// The socket-level assertion below is the one that matters: the rest of this file tests a pure
// function, and a pure function cannot tell you what a kernel actually bound.
import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { resolveBind, isLoopbackHost, exposureNotice, isPublishedDevCredential } from '../src/bind.js';

function listenOn(hostname: string | undefined): Promise<{ address: string; family: string }> {
  return new Promise((resolve, reject) => {
    const srv = createServer(() => {});
    srv.on('error', reject);
    // `undefined` reproduces exactly what serve({fetch, port}) used to do.
    srv.listen(0, hostname, () => {
      const a = srv.address() as { address: string; family: string };
      srv.close(() => resolve(a));
    });
  });
}

describe('what the old call actually bound', () => {
  it('omitting the hostname binds every interface — the behaviour the printed URL denied', async () => {
    const a = await listenOn(undefined);
    expect(['::', '0.0.0.0'], `bound ${a.address}`).toContain(a.address);
  });

  it("the default this module chooses is reachable only from this machine", async () => {
    const bind = resolveBind({ authed: false, allowOpenNetwork: false, command: 'gnl dev' });
    const a = await listenOn(bind.hostname);
    expect(a.address).toBe('127.0.0.1');
    expect(isLoopbackHost(a.address)).toBe(true);
  });
});

describe('resolveBind', () => {
  it('defaults to loopback, and says so without needing a flag', () => {
    const b = resolveBind({ authed: false, allowOpenNetwork: false, command: 'gnl studio' });
    expect(b.hostname).toBe('127.0.0.1');
    expect(b.exposed).toBe(false);
    expect(exposureNotice(b, false), 'nothing is exposed → nothing to warn about').toBe('');
  });

  it('normalizes the loopback spellings rather than passing them through', () => {
    for (const h of ['localhost', '127.0.0.1', '::1', '  LOCALHOST  ']) {
      expect(resolveBind({ host: h, authed: false, allowOpenNetwork: false, command: 'x' }).exposed).toBe(false);
    }
  });

  it('refuses a network bind with no auth, and the message names both ways out', () => {
    let err: Error | undefined;
    try { resolveBind({ host: '0.0.0.0', authed: false, allowOpenNetwork: false, command: 'gnl studio' }); }
    catch (e) { err = e as Error; }
    expect(err, 'this is the combination that leaked the admin surface').toBeDefined();
    expect(err!.message).toContain('GNL_ADMIN_TOKEN');
    expect(err!.message).toContain('--allow-open-network');
  });

  it('allows a network bind once auth resolved — no flag needed', () => {
    const b = resolveBind({ host: '0.0.0.0', authed: true, allowOpenNetwork: false, command: 'gnl dev' });
    expect(b.hostname).toBe('0.0.0.0');
    expect(b.exposed).toBe(true);
    expect(exposureNotice(b, true)).toContain('protected');
  });

  it('allows an explicitly acknowledged open bind, and keeps saying so at boot', () => {
    const b = resolveBind({ host: '0.0.0.0', authed: false, allowOpenNetwork: true, command: 'gnl dev' });
    expect(b.exposed).toBe(true);
    // The acknowledgement is per-invocation; the running process should still announce what it is.
    expect(exposureNotice(b, false)).toContain('NO AUTH');
  });

  it('never prints a wildcard as if it were dialable', () => {
    for (const h of ['0.0.0.0', '::']) {
      expect(resolveBind({ host: h, authed: true, allowOpenNetwork: false, command: 'x' }).displayHost).toBe('localhost');
    }
    // A concrete address IS dialable, so it is shown as given.
    expect(resolveBind({ host: '192.168.1.20', authed: true, allowOpenNetwork: false, command: 'x' }).displayHost)
      .toBe('192.168.1.20');
  });
});

// ── credentials this package used to publish ─────────────────────────────────────────────────────
// `gnl init --features auth` wrote `admin-dev`/`viewer-dev` literally into the scaffolded project,
// which meant the working admin credential for every scaffolded project shipped inside this package's
// npm tarball. The production guard in the generated file did not close it: outside production,
// `gnl dev --host 0.0.0.0` bound to every interface, printed "(auth: protected)", and accepted
// `Bearer admin-dev` as full admin.
//
// Two changes, and this covers the second. New scaffolds generate a random token per project
// (recipes.ts), so nothing shared exists to look up. But a project created BEFORE that still carries
// the literal, so the bind decision must not count it as auth either.
describe('published dev credentials are not auth', () => {
  it('recognises a credential set made only of values this package shipped', () => {
    expect(isPublishedDevCredential(['admin-dev'])).toBe(true);
    expect(isPublishedDevCredential(['admin-dev', 'viewer-dev'])).toBe(true);
  });

  it('a real token — including a generated one — is auth', () => {
    expect(isPublishedDevCredential(['admin-2s0Bf_WhvKNL'])).toBe(false);
    expect(isPublishedDevCredential(['s3cret'])).toBe(false);
    // Mixed: one real credential is enough to be authenticated.
    expect(isPublishedDevCredential(['admin-dev', 's3cret'])).toBe(false);
  });

  it('no credential at all is not "published credentials" — that is the auth-off case', () => {
    expect(isPublishedDevCredential([])).toBe(false);
    expect(isPublishedDevCredential([undefined, undefined])).toBe(false);
    expect(isPublishedDevCredential([''])).toBe(false);
  });

  it('so a network bind carrying only the shipped token is refused', () => {
    // This is the composition that mattered: provider resolved, but not with anything private.
    expect(() => resolveBind({
      host: '0.0.0.0',
      authed: true && !isPublishedDevCredential(['admin-dev']),
      allowOpenNetwork: false,
      command: 'gnl dev',
    })).toThrow(/refusing to serve/);
    // ...and a real token still binds.
    expect(resolveBind({
      host: '0.0.0.0',
      authed: true && !isPublishedDevCredential(['admin-2s0Bf_WhvKNL']),
      allowOpenNetwork: false,
      command: 'gnl dev',
    }).exposed).toBe(true);
  });
});
