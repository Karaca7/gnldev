// `GET /capabilities` is what the UI builds itself from. It must answer for THIS caller.
//
// The org-scoped refusals landed on the endpoints but not on the capability list, so an org-bound admin
// was told `knowledge=true queueManage=true cacheManage=true workflowManage=true memory=true` and then
// got a 403 on every one. That is not cosmetic:
//
//   App.tsx      polls Jobs every 3s while `caps.queue` is true  -> a 403 every three seconds, forever
//   Playground   sent a threadId while `caps.memory` was true    -> the whole Playground 403s, not just
//                                                                   its thread list
//
// A capability the caller cannot use is not a capability.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { roleAuth } from '@gnldev/auth';
import { createStudioApi } from '../src/server.js';
import { call } from './call.js';

afterEach(() => vi.restoreAllMocks());

const boundAdmin = roleAuth({ admin: { token: 'acme-adm', orgId: 'acme' } });
const operator = roleAuth({ admin: { token: 'op' } });
const H = (t: string) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });

/** Host objects that ignore the `orgId` they are handed — the default state of any such host. */
const blind = () => ({
  vectors: { search: async () => [] },
  cache: { stats: async () => ({ size: 0 }), invalidate: async () => 0 },
  queue: { listJobs: async () => [], retry: async () => 'j' },
  memory: { getMessages: async () => [], append: async () => {}, listThreads: async () => [] },
  workflowStore: { list: async () => [], get: async () => undefined, set: async () => {}, delete: async () => {} },
});

const caps = async (app: unknown, token: string) =>
  (await call(app as never, '/capabilities', { headers: H(token) })).json() as Promise<Record<string, boolean>>;

describe('capabilities for a caller whose org-scoped identity will be refused', () => {
  it('reports false for every surface behind an unscopeable host object', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = createStudioApi({ reader: new InMemoryJournal(), auth: boundAdmin, org: {}, ...blind() } as never);

    const c = await caps(app, 'acme-adm');
    for (const k of ['knowledge', 'queue', 'queueManage', 'cache', 'cacheManage', 'workflowManage', 'memory']) {
      expect(c[k], `capabilities advertised '${k}' to a caller the endpoint refuses`).toBe(false);
    }
  });

  it('still reports true to an unscoped operator, who is not refused', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = createStudioApi({ reader: new InMemoryJournal(), auth: operator, org: {}, ...blind() } as never);

    const c = await caps(app, 'op');
    for (const k of ['knowledge', 'queue', 'cache', 'workflowManage', 'memory']) {
      expect(c[k], `an operator lost '${k}', which is not refused to them`).toBe(true);
    }
  });

  it('still reports true when the host declares its object organization-aware', async () => {
    const hosts = blind();
    const app = createStudioApi({
      reader: new InMemoryJournal(), auth: boundAdmin, org: {},
      ...hosts,
      vectors: { ...hosts.vectors, orgScoped: true },
      cache: { ...hosts.cache, orgScoped: true },
      queue: { ...hosts.queue, orgScoped: true },
    } as never);

    const c = await caps(app, 'acme-adm');
    expect([c.knowledge, c.cache, c.queue]).toEqual([true, true, true]);
  });
});

describe('an agent run that names no thread', () => {
  it('is served to an org-bound admin even when the conversation store is unscopeable', async () => {
    // The Playground's own path once memory is reported off. Refusing it made the Playground unusable
    // for that admin on every prompt, not just on the thread list.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gnl = { listAgents: async () => [{ name: 'bot' }], run: async () => ({ text: 'ok' }) };
    const app = createStudioApi({ reader: new InMemoryJournal(), auth: boundAdmin, org: {}, gnl, ...blind() } as never);

    const res = await call(app as never, '/agents/bot/run', {
      method: 'POST', headers: H('acme-adm'), body: JSON.stringify({ runId: 'r1', prompt: 'hi' }),
    });
    expect(res.status, 'the Playground was refused a run that touches no conversation store').toBe(200);
  });

  it('treats an empty threadId as naming no thread', async () => {
    // `runDurable` gates every memory read and write on `memory && threadId`, so a falsy id is inert.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gnl = { listAgents: async () => [{ name: 'bot' }], run: async () => ({ text: 'ok' }) };
    const app = createStudioApi({ reader: new InMemoryJournal(), auth: boundAdmin, org: {}, gnl, ...blind() } as never);

    const res = await call(app as never, '/agents/bot/run', {
      method: 'POST', headers: H('acme-adm'), body: JSON.stringify({ runId: 'r2', prompt: 'hi', threadId: '' }),
    });
    expect(res.status).toBe(200);
  });

  it('still refuses one that DOES name a thread', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gnl = { listAgents: async () => [{ name: 'bot' }], run: async () => ({ text: 'ok' }) };
    const app = createStudioApi({ reader: new InMemoryJournal(), auth: boundAdmin, org: {}, gnl, ...blind() } as never);

    const res = await call(app as never, '/agents/bot/run', {
      method: 'POST', headers: H('acme-adm'), body: JSON.stringify({ runId: 'r3', prompt: 'hi', threadId: 'globex-thread' }),
    });
    expect(res.status).toBe(403);
  });
});
