// The audit's sharpest finding about the bind fix: bind.test.ts pins the HELPER, not the commands.
// With the vulnerable serve() calls restored in dev-server.ts and commands/studio.ts — no hostname,
// admin surface on every interface — all eight bind tests stayed green, because nothing asserted the
// commands actually consult resolveBind and hand its answer to serve(). This file closes that: it
// drives the real command paths with the serve boundary captured, so a refactor that drops the
// hostname (the exact regression) fails here, loudly.
import { describe, it, expect, vi, beforeEach } from 'vitest';

type ServeArgs = { fetch: unknown; port: number; hostname?: string };
const served: ServeArgs[] = [];

vi.mock('../src/runtime.js', () => ({
  projectDirOf: () => '.',
  loadNodeServer: async () => ({
    serve: (o: ServeArgs, cb?: (i: { port: number }) => void) => { served.push(o); cb?.({ port: o.port }); return {}; },
  }),
  loadDurable: async () => ({
    createGnl: () => ({}),
    toJournal: (x: unknown) => x,
  }),
  loadStudio: async () => ({
    createStudioApp: () => ({ fetch: () => new Response('ok') }),
    createStudioRunner: () => ({}),
  }),
  loadStudioAi: async () => ({ aiToolSchema: () => ({}) }),
  loadMemory: async () => ({}),
  loadAuth: async () => ({ roleAuth: () => undefined }),
}));

vi.mock('../src/config.js', () => ({
  loadConfig: async () => ({ journal: { listRuns: async () => [] } }),
}));

vi.mock('../src/memory.js', () => ({
  devMemoryFactory: () => ({}),
  devStudioMemory: () => ({}),
}));

vi.mock('../src/dev-server.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/dev-server.js')>();
  return { ...real, resolveAuthProvider: async () => undefined }; // no auth resolves — the risky case
});

import { studioCommand } from '../src/commands/studio.js';

beforeEach(() => { served.length = 0; });

describe('gnl studio hands the bind decision to serve()', () => {
  it('binds loopback by default — serve() receives an explicit hostname, never undefined', async () => {
    await studioCommand.run({ argv: [] } as any);
    expect(served).toHaveLength(1);
    // `undefined` is the whole bug: @hono/node-server then binds every interface while the printed
    // line says localhost. The command must always pass a concrete address.
    expect(served[0]!.hostname, 'an implicit bind is the vulnerable state').toBe('127.0.0.1');
  });

  it('refuses --host 0.0.0.0 with no auth and no acknowledgement — nothing is served', async () => {
    await expect(studioCommand.run({ argv: ['--host', '0.0.0.0'] } as any))
      .rejects.toThrow(/refusing to serve/);
    expect(served, 'the socket must never open on a refused bind').toHaveLength(0);
  });

  it('serves 0.0.0.0 when the operator says --allow-open-network, passing it through verbatim', async () => {
    await studioCommand.run({ argv: ['--host', '0.0.0.0', '--allow-open-network'] } as any);
    expect(served).toHaveLength(1);
    expect(served[0]!.hostname).toBe('0.0.0.0');
  });
});
