// `gnl studio` once built its admin app with no auth provider at all — the config said protected, the
// API was open. That was fixed, and then nothing held the fix: `command-bind.test.ts` mocks
// `resolveAuthProvider` to return `undefined` so it can exercise the risky bind, which means the line
// that hands the provider to `createStudioApp` is never observed. Measured: setting
// `commands/studio.ts:48` back to `auth: undefined` left all 261 tests green.
//
// The bind half of that command IS covered. This is the other half, and it is the half the original
// vulnerability was.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const appOptions: Record<string, unknown>[] = [];
const served: { hostname?: string }[] = [];

vi.mock('../src/runtime.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/runtime.js')>();
  return {
    ...real,
    projectDirOf: () => '.',
    loadDurable: async () => await import('@gnldev/durable'),
    loadAuth: async () => await import('@gnldev/auth'),
    loadStudio: async () => ({
      // The boundary under test: what does the command actually build the admin app with?
      createStudioApp: (opts: Record<string, unknown>) => { appOptions.push(opts); return { fetch: () => new Response('ok') }; },
      createStudioRunner: () => ({}),
    }),
    loadStudioAi: async () => ({ aiToolSchema: () => ({}) }),
    loadMemory: async () => ({}),
    loadNodeServer: async () => ({
      serve: (o: { hostname?: string; port: number }, cb?: (i: { port: number }) => void) => { served.push(o); cb?.({ port: o.port }); return {}; },
    }),
  };
});

const { InMemoryStorage } = await import('@gnldev/durable');
const cfg = { agents: {}, journal: new InMemoryStorage().runs, auth: { admin: { token: 'a-real-secret-token' } } };
vi.mock('../src/config.js', () => ({ loadConfig: async () => cfg }));
vi.mock('../src/memory.js', () => ({ devMemoryFactory: () => ({}), devStudioMemory: () => ({}) }));

import { studioCommand } from '../src/commands/studio.js';

beforeEach(() => { appOptions.length = 0; served.length = 0; });

describe('gnl studio applies the auth it was configured with', () => {
  it('the resolved provider reaches createStudioApp', async () => {
    await studioCommand.run({ argv: [] } as any);
    expect(appOptions, 'the command must have built an app').toHaveLength(1);
    // `auth: undefined` here is the whole original bug: the admin API answers everyone.
    expect(appOptions[0]!.auth, 'an admin surface built with no provider is an open one').toBeDefined();
  });

  it('an authenticating provider is what arrives, not merely something truthy', async () => {
    await studioCommand.run({ argv: [] } as any);
    const provider = appOptions[0]!.auth as { authenticate?: (r: Request) => unknown };
    // Driven, so a stub object or a stale reference cannot satisfy the assertion above.
    const anon = await provider.authenticate?.(new Request('http://s/runs'));
    const authed = await provider.authenticate?.(new Request('http://s/runs', {
      headers: { authorization: 'Bearer a-real-secret-token' },
    }));
    expect(anon, 'no credential must not produce a principal').toBeFalsy();
    expect(authed, 'the configured token must').toBeTruthy();
  });

  it('and the bind is still loopback — the two decisions are independent', async () => {
    await studioCommand.run({ argv: [] } as any);
    expect(served[0]!.hostname).toBe('127.0.0.1');
  });
});
