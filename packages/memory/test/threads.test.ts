// Track 3: thread CRUD + clone + delete + reader invariant (on top of the MemoryStore port).
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { AgentMemory } from '../src/index.js';

const u = (content: string) => ({ role: 'user', content });

function observerModel(counter: { calls: number }): any {
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'obs', supportedUrls: {},
    doGenerate: async ({ prompt }: any) => {
      counter.calls++;
      const userText = (prompt ?? []).map((m: any) => (typeof m.content === 'string' ? m.content : '')).join(' ');
      return { content: [{ type: 'text', text: `OBS(${userText.length})` }], finishReason: 'stop', usage: {}, warnings: [] };
    },
    doStream: async () => { throw new Error('no'); },
  };
}

describe('Track 3 thread management', () => {
  it('create/list/update + resource', async () => {
    const mem = new AgentMemory({ storage: new InMemoryStorage() });
    await mem.createThread({ id: 't1', resourceId: 'u1', title: 'first' });
    await mem.createThread({ id: 't2', resourceId: 'u1' });
    const list = await mem.listThreads({ resourceId: 'u1' });
    expect(list.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(await mem.getThreadResource('t1')).toBe('u1');

    const upd = await mem.updateThread('t1', { title: 'updated' });
    expect(upd.title).toBe('updated');
    expect((await mem.getThreadById('t1'))!.title).toBe('updated');
  });

  it('cloneThread: copies messages + ancestry; independent of the source', async () => {
    const mem = new AgentMemory({ storage: new InMemoryStorage() });
    await mem.createThread({ id: 'src', resourceId: 'u1' });
    await mem.append('src', [u('hello'), u('world')]);

    const clone = await mem.cloneThread('src', { newThreadId: 'dst' });
    expect(clone.parentThreadId).toBe('src');
    expect(await mem.getThreadResource('dst')).toBe('u1');
    expect(await mem.getMessages('dst')).toEqual([u('hello'), u('world')]);

    await mem.append('dst', [u('new')]);
    expect(await mem.getMessages('src')).toHaveLength(2);
    expect(await mem.getMessages('dst')).toHaveLength(3);
  });

  it('cloneThread: also copies OM RunJournal counters → no double observation', async () => {
    const storage = new InMemoryStorage();
    const counter = { calls: 0 };
    const cfg = { enabled: true, observerModel: observerModel(counter), observation: { messageThreshold: 4 } };
    const mem = new AgentMemory({ storage, observationalMemory: cfg });
    for (let i = 0; i < 10; i++) await mem.append('src', [u(`message ${i}`)]);
    await mem.loadContext('src', {}); // compaction is triggered → OM counters advance
    expect(counter.calls).toBe(1);

    const srcObservedSeq = await storage.runs.get<number>('om:src:observedSeq');
    const srcObserveSeq = await storage.runs.get<number>('om:src:observeSeq');
    const srcObs = await storage.memory.getObservations('src');
    expect(srcObs.length).toBeGreaterThan(0);

    await mem.cloneThread('src', { newThreadId: 'dst' });

    // The counters must be copied verbatim (the clone inherits the source's observation state).
    expect(await storage.runs.get<number>('om:dst:observedSeq')).toBe(srcObservedSeq);
    expect(await storage.runs.get<number>('om:dst:observeSeq')).toBe(srcObserveSeq);
    expect(await storage.memory.getObservations('dst')).toEqual(srcObs);

    // A loadContext call on the clone does NOT re-observe already-observed messages (no double observation):
    // neither a new LLM call happens, nor does the unobserved message count in the context differ from the source.
    const callsBefore = counter.calls;
    const dstCtx = await mem.loadContext('dst', {});
    const srcCtx = await mem.loadContext('src', {});
    expect(counter.calls).toBe(callsBefore);
    expect(dstCtx.messages.length).toBe(srcCtx.messages.length);
  });

  it('deleteThread: record + messages are gone; other threads remain', async () => {
    const mem = new AgentMemory({ storage: new InMemoryStorage() });
    await mem.createThread({ id: 'a', resourceId: 'u1' });
    await mem.createThread({ id: 'b', resourceId: 'u1' });
    await mem.append('a', [u('x')]);

    await mem.deleteThread('a');
    expect(await mem.getThreadById('a')).toBeUndefined();
    expect(await mem.getMessages('a')).toEqual([]);
    expect((await mem.listThreads({ resourceId: 'u1' })).map((t) => t.id)).toEqual(['b']);
  });

  it('reader invariant: memory keys do not leak into the run reader (listRuns is empty)', async () => {
    const storage = new InMemoryStorage();
    const mem = new AgentMemory({ storage });
    await mem.createThread({ id: 't', resourceId: 'u1' });
    await mem.append('t', [u('message')]);
    await mem.setWorkingMemory('t', 'wm');
    await mem.cloneThread('t', { newThreadId: 'c' });
    expect((await storage.runs.listRuns()).items).toEqual([]); // memory → MemoryStore, runs stays clean
  });
});
