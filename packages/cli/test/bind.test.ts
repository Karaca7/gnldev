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
import { resolveBind, isLoopbackHost, exposureNotice } from '../src/bind.js';

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
