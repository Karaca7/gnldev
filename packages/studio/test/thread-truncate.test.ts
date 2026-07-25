// Threads view: DELETE /threads/:id/messages — truncates a thread from a message index onward
// (destructive; e.g. "retry from here"/branching flows). Studio bridges this via the StudioMemory
// interface's optional truncateMessages (the host typically wraps @gnl/memory's AgentMemory
// truncateMessagesAfter) — here we mock it and verify permission (write) + audit + the 501 fallback
// for both "not implemented" and "adapter returned null (store doesn't support it)".
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnl/durable';
import { createStudioApi, type StudioMemory } from '../src/server.js';

/** Simple fake memory: only truncateMessages matters here; listThreads/getMessages are stubs. */
function fakeMemory(removedByCall: (number | null)[]): StudioMemory & { truncateCalls: { threadId: string; afterIndex: number }[] } {
  const truncateCalls: { threadId: string; afterIndex: number }[] = [];
  let i = 0;
  return {
    truncateCalls,
    listThreads: () => [],
    getMessages: () => [],
    truncateMessages: async (threadId: string, afterIndex: number) => {
      truncateCalls.push({ threadId, afterIndex });
      const r = removedByCall[i] ?? null;
      i += 1;
      return r;
    },
  };
}

const del = (app: any, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: 'DELETE', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('DELETE /threads/:id/messages', () => {
  it('truncates via memory.truncateMessages, returns removed count, lands in audit', async () => {
    const memory = fakeMemory([6]);
    const app = createStudioApi({ reader: new InMemoryJournal(), memory });

    const res = await del(app, '/threads/t1/messages', { afterIndex: 3 }, { 'x-gnl-actor': 'ops@acme.co' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: 6 });
    expect(memory.truncateCalls).toEqual([{ threadId: 't1', afterIndex: 3 }]);

    const audit = await (await app.request('/audit?action=thread.truncate')).json();
    expect(audit.items).toHaveLength(1);
    expect(audit.items[0]).toMatchObject({ actor: 'ops@acme.co', target: 't1', detail: { afterIndex: 3, removed: 6 } });
  });

  it('afterIndex === -1 truncates the whole thread (passed through as-is)', async () => {
    const memory = fakeMemory([4]);
    const app = createStudioApi({ reader: new InMemoryJournal(), memory });

    const res = await del(app, '/threads/t1/messages', { afterIndex: -1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: 4 });
    expect(memory.truncateCalls).toEqual([{ threadId: 't1', afterIndex: -1 }]);
  });

  it('403 without write permission (truncateMessages is never called)', async () => {
    const memory = fakeMemory([6]);
    const app = createStudioApi({ reader: new InMemoryJournal(), memory, auth: { write: () => false } });

    const res = await del(app, '/threads/t1/messages', { afterIndex: 3 });
    expect(res.status).toBe(403);
    expect(memory.truncateCalls).toHaveLength(0);
  });

  it('501 if memory.truncateMessages is not implemented (listThreads/getMessages only)', async () => {
    const app = createStudioApi({ reader: new InMemoryJournal(), memory: { listThreads: () => [], getMessages: () => [] } });
    const res = await del(app, '/threads/t1/messages', { afterIndex: 3 });
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: 'truncateMessages is not supported' });
  });

  it('501 if the adapter returns null (underlying store does not support the capability)', async () => {
    const memory = fakeMemory([null]);
    const app = createStudioApi({ reader: new InMemoryJournal(), memory });
    const res = await del(app, '/threads/t1/messages', { afterIndex: 3 });
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: 'truncateMessages is not supported' });

    // a null return is NOT a write failure — nothing lands in audit
    const audit = await (await app.request('/audit?action=thread.truncate')).json();
    expect(audit.items).toHaveLength(0);
  });

  it('400 if afterIndex is missing or not a number', async () => {
    const memory = fakeMemory([6]);
    const app = createStudioApi({ reader: new InMemoryJournal(), memory });

    for (const body of [{}, { afterIndex: 'nope' }, { afterIndex: null }]) {
      const res = await del(app, '/threads/t1/messages', body);
      expect(res.status).toBe(400);
    }
    expect(memory.truncateCalls).toHaveLength(0);
  });

  it('501 also if memory is not given at all (feature check comes AFTER the write permission check)', async () => {
    const app = createStudioApi({ reader: new InMemoryJournal() });
    const res = await del(app, '/threads/t1/messages', { afterIndex: 3 });
    expect(res.status).toBe(501);
  });
});
