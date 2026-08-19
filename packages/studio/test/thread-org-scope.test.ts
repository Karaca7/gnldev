// Thread endpoints must not serve one tenant another tenant's conversations.
//
// Studio resolves memory two ways: `memoryFactory` is handed the ALS-aware reader, so everything it
// writes lands under `org:<id>:`, while a `memory` object the host passes DIRECTLY has no notion of an
// organization — and cannot be given one from here, because it is somebody else's object with its own
// store behind it.
//
// So the same endpoints were isolated under one option and not the other, with nothing said either way.
// Measured with a host-provided memory and an acme-bound identity:
//
//   GET /threads                            -> 200, listed globex's thread
//   GET /threads/globex-thread/messages     -> 200, returned its contents
//
// Writes were already refused by the org-write guard; reads were not. Nothing here can put a boundary
// inside the host's store, so the honest answer is to refuse rather than to serve — and to say so at
// boot, where a host can act on it, instead of at the first 403, where a user can only file a bug.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryJournal, InMemoryStorage } from '@gnldev/durable';
import { createStudioApi } from '../src/server.js';
import { call } from './call.js';

afterEach(() => vi.restoreAllMocks());

/** A host memory object holding one thread that belongs to globex. */
function hostMemory() {
  const threads = new Map<string, { role: string; content: string }[]>([
    ['globex-thread', [{ role: 'user', content: 'globex confidential' }]],
  ]);
  return {
    threads,
    memory: {
      getMessages: async (t: string) => threads.get(t) ?? [],
      append: async () => {},
      listThreads: async () => [...threads.keys()].map((id) => ({ id })),
      deleteThread: async (t: string) => threads.delete(t),
    },
  };
}

const asOrg = (app: unknown, path: string, init: RequestInit = {}) =>
  call(app as never, path, { ...init, headers: { 'x-gnl-org': 'acme', ...(init.headers ?? {}) } });

describe('threads when the host passes `memory` directly', () => {
  it.each([
    ['/threads', 'GET'],
    ['/threads/globex-thread/messages', 'GET'],
    ['/threads/globex-thread/working-memory', 'GET'],
  ])('refuses %s to an organization-scoped identity', async (path) => {
    const { memory } = hostMemory();
    const app = createStudioApi({ reader: new InMemoryJournal(), memory, org: {} } as never);

    const res = await asOrg(app, path);
    expect(res.status, `${path} served another tenant's threads`).toBe(403);
    expect((await res.json()).error).toMatch(/memoryFactory/);
  });

  it('still serves the unscoped operator — they run the platform', async () => {
    const { memory } = hostMemory();
    const app = createStudioApi({ reader: new InMemoryJournal(), memory, org: {} } as never);

    const res = await call(app as never, '/threads');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: 'globex-thread' }]);
  });

  it('warns at boot rather than only at the first refusal', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { memory } = hostMemory();
    createStudioApi({ reader: new InMemoryJournal(), memory, org: {} } as never);

    const said = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(said, 'a deployment could ship this without ever being told').toContain('memoryFactory');
  });
});

describe('threads when memory comes from memoryFactory', () => {
  it('serves an organization-scoped identity, because the store IS scoped', async () => {
    // The factory receives the org-scoped journal, so isolation is real and refusing would only break
    // a working setup.
    const { memory } = hostMemory();
    const storage = new InMemoryStorage();
    const app = createStudioApi({ reader: storage.runs, memoryFactory: () => memory, org: {} } as never);

    expect((await asOrg(app, '/threads')).status).toBe(200);
    expect((await asOrg(app, '/threads/globex-thread/messages')).status).toBe(200);
  });

  it('says nothing at boot', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { memory } = hostMemory();
    const storage = new InMemoryStorage();
    createStudioApi({ reader: storage.runs, memoryFactory: () => memory, org: {} } as never);

    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain('memoryFactory');
  });
});

describe('a single-organization deployment', () => {
  it('is unaffected — there is nothing to isolate from', async () => {
    // The guard keys off an org actually being in scope, not off which option was used, so the
    // ordinary single-tenant setup in the README keeps working exactly as before.
    const { memory } = hostMemory();
    const app = createStudioApi({ reader: new InMemoryJournal(), memory } as never);

    const res = await call(app as never, '/threads');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: 'globex-thread' }]);
  });

  it('is not warned about either', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { memory } = hostMemory();
    createStudioApi({ reader: new InMemoryJournal(), memory } as never);
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain('memoryFactory');
  });
});
