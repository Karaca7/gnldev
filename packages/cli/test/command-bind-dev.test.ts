// `command-bind.test.ts` closed this gap for `gnl studio` and left `gnl dev` open — the same shape of
// omission its own header describes. Measured on the current tree: restoring either original
// vulnerability inside `serveDev` left all 250 tests green.
//
//   dev-server.ts  drop `hostname: bind.hostname` from serve()  -> 250/250, real bind `LISTEN *:PORT`
//   dev-server.ts  drop the auth provider entirely              -> 250/250, unauthenticated writes
//
// Both are fixes that shipped. Neither was held by anything.
//
// Only the `serve` boundary is faked here. Hono, @gnldev/server, @gnldev/durable and @gnldev/auth are
// the real modules, so the auth assertion below goes through the real routing and the real gate — a
// stubbed app would answer whatever the stub decided and prove nothing about the wiring.
import { describe, it, expect, vi, beforeEach } from 'vitest';

type ServeArgs = { fetch: (req: Request) => Response | Promise<Response>; port: number; hostname?: string };
const served: ServeArgs[] = [];

vi.mock('../src/runtime.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/runtime.js')>();
  return {
    ...real,
    projectDirOf: () => '.',
    loadHono: async () => await import('hono'),
    loadServer: async () => await import('@gnldev/server'),
    loadDurable: async () => await import('@gnldev/durable'),
    loadAuth: async () => await import('@gnldev/auth'),
    loadStudio: async () => ({
      createStudioApp: () => ({ fetch: () => new Response('ok') }),
      createStudioRunner: () => ({}),
    }),
    loadStudioAi: async () => ({ aiToolSchema: () => ({}) }),
    loadMemory: async () => ({}),
    // The one boundary under test: capture what the command asks the server to bind to.
    loadNodeServer: async () => ({
      serve: (o: ServeArgs, cb?: (i: { port: number }) => void) => { served.push(o); cb?.({ port: o.port }); return {}; },
    }),
  };
});

import { InMemoryStorage } from '@gnldev/durable';

// A real journal: serveDev builds the REST app against it, so a stub would fail on the first read
// rather than exercising the routing the auth assertion depends on.
const baseConfig = () => ({ agents: {}, studio: false, journal: new InMemoryStorage().runs }) as any;

beforeEach(() => { served.length = 0; });

describe('gnl dev hands the bind decision to serve()', () => {
  it('binds loopback by default — serve() receives an explicit hostname, never undefined', async () => {
    const { serveDev } = await import('../src/dev-server.js');
    await serveDev(baseConfig(), '.', { port: 39901 });
    expect(served).toHaveLength(1);
    // `undefined` is the whole bug: @hono/node-server then binds every interface while the printed
    // line says localhost. Measured with the hostname dropped: `ss` shows `LISTEN *:39901`.
    expect(served[0]!.hostname, 'an implicit bind is the vulnerable state').toBe('127.0.0.1');
  });

  it('refuses --host 0.0.0.0 with no auth and no acknowledgement — nothing is served', async () => {
    const { serveDev } = await import('../src/dev-server.js');
    await expect(serveDev(baseConfig(), '.', { host: '0.0.0.0', port: 39902 }))
      .rejects.toThrow(/refusing to serve/);
    expect(served, 'the socket must never open on a refused bind').toHaveLength(0);
  });

  it('serves 0.0.0.0 when the operator says --allow-open-network, passing it through verbatim', async () => {
    const { serveDev } = await import('../src/dev-server.js');
    await serveDev(baseConfig(), '.', { host: '0.0.0.0', allowOpenNetwork: true, port: 39903 });
    expect(served).toHaveLength(1);
    expect(served[0]!.hostname).toBe('0.0.0.0');
  });

  // The second shipped fix: `gnl studio` once ignored auth entirely. `gnl dev` resolves a provider on
  // the same path, and dropping it left every test green while unauthenticated requests went through.
  it('an auth provider from the config reaches the served app', async () => {
    const { serveDev } = await import('../src/dev-server.js');
    await serveDev({ ...baseConfig(), auth: { admin: { token: 'a-real-secret-token' } } }, '.', { port: 39904 });
    expect(served).toHaveLength(1);

    const call = (headers: Record<string, string> = {}) => served[0]!.fetch(new Request('http://localhost/runs', { headers }));
    const anon = await call();
    expect(anon.status, `an unauthenticated read answered ${anon.status}`).toBe(401);
    // The mirror, so the assertion above cannot pass by everything being refused — which is exactly
    // How the first draft of this file passed while the provider was never resolved at all.
    const authed = await call({ authorization: 'Bearer a-real-secret-token' });
    expect(authed.status, 'a valid token must still get through').not.toBe(401);
  });

  // `authed` decides whether a network bind may proceed without `--allow-open-network`, and a
  // credential the registry publishes is not a credential. Restoring `&& !shippedCreds` on either side
  // of that expression left the suite green.
  //
  // The precondition matters more than usual here: with a config shape that resolves NO provider, this
  // Refusal happens for the ordinary no-auth reason and proves nothing about shipped credentials. So
  // The paired test below establishes that this same shape, with a real token, is accepted.
  it('a shipped dev token does not count as auth for the network gate', async () => {
    const { serveDev } = await import('../src/dev-server.js');
    const shipped = { ...baseConfig(), auth: { admin: { token: 'admin-dev' } } } as any; // the literal `gnl add host` scaffolds
    await expect(serveDev(shipped, '.', { host: '0.0.0.0', port: 39905 }))
      .rejects.toThrow(/refusing to serve/);
    expect(served, 'a published credential must not unlock the network bind').toHaveLength(0);
  });

  it('...while a real token in the same shape DOES unlock it', async () => {
    const { serveDev } = await import('../src/dev-server.js');
    const real = { ...baseConfig(), auth: { admin: { token: 'not-a-published-literal' } } } as any;
    await serveDev(real, '.', { host: '0.0.0.0', port: 39906 });
    expect(served, 'the refusal above must be about the credential, not about the shape').toHaveLength(1);
    expect(served[0]!.hostname).toBe('0.0.0.0');
  });
});
