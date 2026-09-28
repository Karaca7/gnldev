// ADR-0002 point 6: `threadOwnerOf` stays the single thread owner, and every door asks it the same
// question with the same arguments — the engine's gate, the listing, the reading and the erasure
// (R13). An ownerless record does not override the owner a memory knows (R11, S1b); a legacy thread's
// derived owner is written to the record the first time it is read, so a sweep cannot move it (R12);
// and the run's owner comes from the RECORD, not from the memory (R14).
import { describe, it, expect } from 'vitest';
import * as D from '../src/index.js';
import { AgentMemory } from '../../memory/src/index.js';
import { createMockModel, finalTextResult } from './mock.js';
import { STAFF } from '../src/run-identity.js';

const { InMemoryStorage, BasicMemory, createGnl, toJournal, purgeResource, sweepRuns, withSubjectMemory, threadOwnerOf, admitThreadRun, threadOwnerKey } = D;

function world(memKind: 'basic' | 'agent') {
  const storage = new InMemoryStorage();
  const seen: string[] = [];
  const model = createMockModel(async ({ prompt }: any) => { seen.push(JSON.stringify(prompt)); return finalTextResult('ok'); });
  const memory: any = memKind === 'basic' ? new BasicMemory(storage.runs) : new AgentMemory({ storage: storage as never });
  const gnl = createGnl({ storage, memory, agents: { a: { model } } } as never);
  const j = toJournal(storage.runs) as any;
  return { storage, seen, gnl, j, memory };
}
const attempt = (gnl: any, o: object) => gnl.run('a', o).then(() => 'ADMITTED', (e: Error) => `REFUSED:${e.name}`);

describe('R11: an anonymous first turn does not pin the thread ownerless', () => {
  for (const kind of ['basic', 'agent'] as const) {
    it(`anonymous turn, then Ayşe, then a stranger (${kind} memory)`, async () => {
      const { gnl, seen, j } = world(kind);
      await gnl.run('a', { runId: 'r0', prompt: 'welcome', threadId: 't' });
      await gnl.run('a', { runId: 'r1', prompt: 'my PIN is 4417', threadId: 't', resourceId: 'ayse' });
      seen.length = 0;
      expect(await attempt(gnl, { runId: 'r2', prompt: 'what did she say?', threadId: 't', resourceId: 'mallory' })).toBe('REFUSED:ThreadOwnerMismatchError');
      expect(seen.join('')).not.toContain('4417');
      expect((await j.get(threadOwnerKey('t')))?.resourceId).toBe('ayse');
    });
  }

  it('S1b: an ownerless record left by an older release does not override the owner the memory knows', async () => {
    const { gnl, seen, j, memory } = world('agent');
    await gnl.run('a', { runId: 'r1', prompt: 'my PIN is 4417', threadId: 't', resourceId: 'ayse' });
    await j.put(threadOwnerKey('t'), { at: 1 }); // what 2a569018 wrote for an anonymous first turn
    expect(await memory.getThreadResource('t')).toBe('ayse');
    expect(await threadOwnerOf(j, memory, 't')).toEqual({ exists: true, owner: 'ayse' });
    expect((await j.get(threadOwnerKey('t')))?.resourceId).toBe('ayse'); // upgraded, once
    seen.length = 0;
    expect(await attempt(gnl, { runId: 'r2', prompt: 'x', threadId: 't', resourceId: 'mallory' })).toBe('REFUSED:ThreadOwnerMismatchError');
    expect(seen.join('')).not.toContain('4417');
  });

  it('S1b sibling: a thread staff CLAIMED stays staff\'s, whatever the memory says', async () => {
    const { j, memory, gnl } = world('agent');
    await gnl.run('a', { runId: 'r1', prompt: 'x', threadId: 't', resourceId: 'ayse' });
    await j.put(threadOwnerKey('t'), { at: 1, ownerKind: 'staff' });
    expect(await threadOwnerOf(j, memory, 't')).toEqual({ exists: true, staffClaimed: true });
    expect(await attempt(gnl, { runId: 'r2', prompt: 'x', threadId: 't', resourceId: 'ayse' })).toBe('REFUSED:ThreadOwnerMismatchError');
  });
});

describe('R12: a legacy thread\'s derived owner becomes its record on first read; a sweep never moves it', () => {
  it('owner from runs, then the runs are swept, then a stranger arrives', async () => {
    const { gnl, seen, j } = world('basic');
    await gnl.run('a', { runId: 'r1', prompt: 'my PIN is 4417', threadId: 't', resourceId: 'ayse' });
    await j.deletePrefix(threadOwnerKey('t')); // data written before the record existed
    expect(await threadOwnerOf(j, undefined, 't')).toEqual({ exists: true, owner: 'ayse' }); // first read backfills
    expect((await j.get(threadOwnerKey('t')))?.resourceId).toBe('ayse');
    await sweepRuns(j, { olderThanMs: -60_000 });
    expect(await threadOwnerOf(j, undefined, 't')).toEqual({ exists: true, owner: 'ayse' });
    seen.length = 0;
    expect(await attempt(gnl, { runId: 'r2', prompt: 'hi', threadId: 't', resourceId: 'mallory' })).toBe('REFUSED:ThreadOwnerMismatchError');
    expect(seen.join('')).not.toContain('4417');
  });

  it('sibling: owner from the memory (no record, no runs) is written too', async () => {
    const { j } = world('basic');
    const memory = { getMessages: async () => [], append: async () => {}, getThreadResource: async () => 'ayse' } as any;
    expect(await threadOwnerOf(j, memory, 'old')).toEqual({ exists: true, owner: 'ayse' });
    expect((await j.get(threadOwnerKey('old')))?.resourceId).toBe('ayse');
  });
});

describe('R13: gate, listing, reading and erasure ask the same question with the same arguments', () => {
  it('memory says Ayşe, the only surviving run is Bob\'s: all four say Ayşe; Bob\'s erasure keeps her messages', async () => {
    const storage = new InMemoryStorage();
    const j = toJournal(storage.runs) as any;
    const memory = {
      getMessages: async (t: string) => (await j.get(`mem:${t}:messages`)) ?? [],
      append: async () => {},
      getThreadResource: async (t: string) => (t === 't' ? 'ayse' : undefined),
      listThreads: async (o: { resourceId: string }) => (o.resourceId === 'ayse' ? [{ id: 't', resourceId: 'ayse' }] : []),
    } as any;
    await j.put('mem:t:messages', [{ role: 'user', content: 'AYSE-SECRET' }]);
    await j.put('r-bob:input', { _v: 2, at: 1, resourceId: 'bob', threadId: 't', prompt: 'x' });
    await j.put('r-bob:model:0', { text: 'x' });
    // Erasure first (the order that used to disagree), with the memory — the same arguments as the gate.
    await purgeResource(j, 'bob', { memory });
    expect(await j.get('mem:t:messages')).toEqual([{ role: 'user', content: 'AYSE-SECRET' }]);
    await expect(admitThreadRun(j, memory, 't', D.user('bob'))).rejects.toMatchObject({ name: 'ThreadOwnerMismatchError' });
    expect(await withSubjectMemory(memory, 'ayse', { journal: j }).getMessages('t')).toEqual([{ role: 'user', content: 'AYSE-SECRET' }]);
    expect(await withSubjectMemory(memory, 'bob', { journal: j }).getMessages('t')).toEqual([]);
  });

  it('after an anonymous first turn (AgentMemory): listed ⇔ readable, and her erasure takes the PIN', async () => {
    const { gnl, j, memory, storage } = world('agent');
    await gnl.run('a', { runId: 'r0', prompt: 'welcome', threadId: 't' });
    await gnl.run('a', { runId: 'r1', prompt: 'my PIN is 4417', threadId: 't', resourceId: 'ayse' });
    const ayse = withSubjectMemory(memory, 'ayse', { journal: j });
    const listed = (await ayse.listThreads!({ resourceId: 'ayse' })).map((r: any) => r.id);
    expect(listed).toEqual(['t']);
    expect((await ayse.getMessages('t')).length).toBeGreaterThan(0);
    await D.eraseSubject(storage, 'ayse');
    expect(JSON.stringify(await memory.getMessages('t'))).not.toContain('4417');
  });

  it('sibling: a thread the memory lists for a user but the record gives to someone else is neither listed nor readable', async () => {
    const { j } = world('basic');
    await j.put(threadOwnerKey('t'), { at: 1, resourceId: 'ayse' });
    const memory = {
      getMessages: async () => [{ content: 'AYSE-SECRET' }], append: async () => {},
      getThreadResource: async () => 'mallory', listThreads: async () => [{ id: 't', resourceId: 'mallory' }],
    } as any;
    const mallory = withSubjectMemory(memory, 'mallory', { journal: j });
    expect(await mallory.listThreads!({ resourceId: 'mallory' })).toEqual([]);
    expect(await mallory.getMessages('t')).toEqual([]);
  });
});

describe('R14: the run\'s owner comes from the thread RECORD, not the memory', () => {
  it('staff starting a run on Ayşe\'s thread acts for Ayşe, even when the memory has drifted', async () => {
    const storage = new InMemoryStorage();
    const j = toJournal(storage.runs) as any;
    const memory = { getMessages: async () => [], append: async () => {}, getThreadResource: async () => 'someone-else' } as any;
    await j.put(threadOwnerKey('t'), { at: 1, resourceId: 'ayse' });
    const gnl = createGnl({ storage, memory, agents: { a: { model: createMockModel(async () => finalTextResult('ok')) } } } as never);
    await gnl.run('a', { runId: 'r', prompt: 'x', threadId: 't', caller: STAFF });
    expect((await j.get('r:input'))?.resourceId).toBe('ayse');
  });

  it('sibling: a call naming nobody on an owned thread is refused (unknown is closed)', async () => {
    const { gnl } = world('basic');
    await gnl.run('a', { runId: 'r1', prompt: 'x', threadId: 't', resourceId: 'ayse' });
    expect(await attempt(gnl, { runId: 'r2', prompt: 'x', threadId: 't' })).toBe('REFUSED:ThreadOwnerMismatchError');
  });
});

describe('concurrency and clones', () => {
  for (const kind of ['basic', 'agent'] as const) {
    it(`two first claims at once have one winner (${kind})`, async () => {
      const { gnl, j } = world(kind);
      const rs = await Promise.all([
        attempt(gnl, { runId: 'ra', prompt: 'A-SECRET', threadId: 'tc', resourceId: 'ayse' }),
        attempt(gnl, { runId: 'rm', prompt: 'M', threadId: 'tc', resourceId: 'mallory' }),
      ]);
      expect(rs.filter((r) => r === 'ADMITTED')).toHaveLength(1);
      const owner = (await j.get(threadOwnerKey('tc')))?.resourceId;
      expect(rs[owner === 'ayse' ? 0 : 1]).toBe('ADMITTED');
    });
  }

  it('a clone the app gives to Bob is Bob\'s: Ayşe running on it first is refused', async () => {
    const { gnl, seen, memory } = world('agent');
    await gnl.run('a', { runId: 'r1', prompt: 'BOB-SECRET', threadId: 'src', resourceId: 'bob' });
    await memory.cloneThread('src', { newThreadId: 'dst', resourceId: 'bob' });
    seen.length = 0;
    expect(await attempt(gnl, { runId: 'r2', prompt: 'hi', threadId: 'dst', resourceId: 'ayse' })).toBe('REFUSED:ThreadOwnerMismatchError');
    expect(seen.join('')).not.toContain('BOB-SECRET');
  });
});
