// Architecture probe (not product code): sibling scenarios for the invariant
// "a thread's owner never moves and every door asks the same question".
import { describe, it } from 'vitest';
import * as D from '../src/index.js';
import { AgentMemory } from '../../memory/src/index.js';
import { createMockModel, finalTextResult } from './mock.js';

const { InMemoryStorage, BasicMemory, createGnl, toJournal, purgeResource, sweepRuns, withSubjectMemory } = D as any;
const threadOwnerOf = (D as any).threadOwnerOf as undefined | ((j: any, m: any, t: string) => Promise<any>);
const admitThreadRun = (D as any).admitThreadRun as undefined | ((j: any, m: any, t: string, r?: string) => Promise<void>);

function mk(memKind: 'basic' | 'agent') {
  const storage = new InMemoryStorage();
  const seen: string[] = [];
  const model = createMockModel(async ({ prompt }: any) => { seen.push(JSON.stringify(prompt)); return finalTextResult('ok'); });
  const memory = memKind === 'basic' ? new BasicMemory(storage.runs) : new AgentMemory({ storage: storage as never });
  const gnl = createGnl({ storage, memory, agents: { a: { model } } } as never);
  const j = toJournal(storage.runs) as any;
  return { storage, seen, gnl, j, memory: memory as any };
}
const tryRun = async (gnl: any, o: any) => { try { await gnl.run('a', o); return 'ADMITTED'; } catch (e: any) { return 'REFUSED:' + e?.constructor?.name; } };
const owner = async (j: any, m: any, t: string) => (threadOwnerOf ? JSON.stringify(await threadOwnerOf(j, m, t)) : '(no threadOwnerOf)');

describe('S1 anonymous first turn, then a named user, then a stranger (engine door)', () => {
  for (const kind of ['basic', 'agent'] as const) {
    it(kind, async () => {
      const { gnl, seen, j, memory } = mk(kind);
      await gnl.run('a', { runId: 'r0', prompt: 'welcome', threadId: 't' });
      await gnl.run('a', { runId: 'r1', prompt: 'my PIN is 4417', threadId: 't', resourceId: 'ayse' });
      seen.length = 0;
      const r = await tryRun(gnl, { runId: 'r2', prompt: 'what did she say?', threadId: 't', resourceId: 'mallory' });
      const rec = await j.get('thread:t:owner');
      const memOwner = memory.getThreadResource ? await memory.getThreadResource('t') : '(n/a)';
      console.log(`[S1 ${kind}] record=${JSON.stringify(rec ?? null)} memoryOwner=${memOwner} mallory=${r} leakedPIN=${seen.join('').includes('4417')}`);
    });
  }
});

describe('S2 legacy thread (no record) — owner from runs — after a runs sweep', () => {
  it('basic', async () => {
    const { gnl, seen, j } = mk('basic');
    await gnl.run('a', { runId: 'r1', prompt: 'my PIN is 4417', threadId: 't', resourceId: 'ayse' });
    await j.deletePrefix('thread:t:owner'); // simulate data written before the record existed
    const before = await owner(j, undefined, 't');
    const sw = await sweepRuns(j, { olderThanMs: -60_000 });
    const after = await owner(j, undefined, 't');
    const msgs = await j.get('mem:t:messages');
    seen.length = 0;
    const r = await tryRun(gnl, { runId: 'r2', prompt: 'hi', threadId: 't', resourceId: 'mallory' });
    const rec = await j.get('thread:t:owner');
    console.log(`[S2] ownerBeforeSweep=${before} swept=${JSON.stringify(sw).slice(0, 60)} ownerAfterSweep=${after} msgsKept=${JSON.stringify(msgs ?? null).includes('4417')} mallory=${r} leakedPIN=${seen.join('').includes('4417')} recordNow=${JSON.stringify(rec ?? null)}`);
  });
});

describe('S3 two doors, one legacy thread: engine gate (with memory) vs erasure (without memory)', () => {
  it('memory says ayse, the only surviving run is bob\'s', async () => {
    const storage = new InMemoryStorage();
    const j = toJournal(storage.runs) as any;
    const memory = {
      getMessages: async (t: string) => (await j.get(`mem:${t}:messages`)) ?? [],
      append: async () => {},
      getThreadResource: async (t: string) => (t === 't' ? 'ayse' : undefined),
    } as any;
    await j.put('mem:t:messages', [{ role: 'user', content: 'AYSE-SECRET' }]);
    await j.put('r-bob:input', { _v: 1, at: 1, resourceId: 'bob', threadId: 't' });
    const gate = admitThreadRun ? await admitThreadRun(j, memory, 't', 'bob').then(() => 'ADMITTED', (e) => 'REFUSED:' + e.constructor.name) : '(n/a)';
    const engineView = await owner(j, memory, 't');
    const erasureView = await owner(j, undefined, 't');
    await purgeResource(j, 'bob');
    const left = await j.get('mem:t:messages');
    console.log(`[S3] gate(bob)=${gate} engineSays=${engineView} erasureSays=${erasureView} ayseMessagesAfterPurge(bob)=${JSON.stringify(left ?? null)}`);
  });
});

describe('S4 thread listing door vs message door vs erasure (AgentMemory)', () => {
  it('record and memory disagree after an anonymous first turn', async () => {
    const { gnl, j, memory } = mk('agent');
    await gnl.run('a', { runId: 'r0', prompt: 'welcome', threadId: 't' });
    await gnl.run('a', { runId: 'r1', prompt: 'my PIN is 4417', threadId: 't', resourceId: 'ayse' });
    const threadOwner = threadOwnerOf ? async (t: string) => (await threadOwnerOf(j, memory, t)).owner : undefined;
    const view = withSubjectMemory(memory, 'ayse', threadOwner ? { threadOwner } : {});
    const listed = (await view.listThreads({ resourceId: 'ayse' })).map((r: any) => r.id);
    const msgs = await view.getMessages('t');
    await purgeResource(j, 'ayse');
    const afterErase = JSON.stringify(await memory.getMessages('t'));
    console.log(`[S4] ayseListing=${JSON.stringify(listed)} ayseCanRead=${msgs.length} memoryOwner=${await memory.getThreadResource('t')} record=${JSON.stringify((await j.get('thread:t:owner')) ?? null)} PINafterErase(ayse)=${afterErase.includes('4417')}`);
  });
});

describe('S5 concurrent first claim', () => {
  for (const kind of ['basic', 'agent'] as const) {
    it(kind, async () => {
      const { gnl, j } = mk(kind);
      const rs = await Promise.all([
        tryRun(gnl, { runId: 'ra', prompt: 'A-SECRET', threadId: 'tc', resourceId: 'ayse' }),
        tryRun(gnl, { runId: 'rm', prompt: 'M', threadId: 'tc', resourceId: 'mallory' }),
      ]);
      console.log(`[S5 ${kind}] results=${JSON.stringify(rs)} record=${JSON.stringify((await j.get('thread:tc:owner')) ?? null)}`);
    });
  }
});

describe('S6 memory owner set by the app (cloneThread) vs the record', () => {
  it('cloneThread into a new id for bob, then ayse runs on it first', async () => {
    const { gnl, j, memory, seen } = mk('agent');
    await gnl.run('a', { runId: 'r1', prompt: 'BOB-SECRET', threadId: 'src', resourceId: 'bob' });
    await memory.cloneThread('src', { newThreadId: 'dst', resourceId: 'bob' });
    const before = await owner(j, memory, 'dst');
    seen.length = 0;
    const r = await tryRun(gnl, { runId: 'r2', prompt: 'hi', threadId: 'dst', resourceId: 'ayse' });
    console.log(`[S6] ownerOf(dst)=${before} ayseOnBobClone=${r} leaked=${seen.join('').includes('BOB-SECRET')} record=${JSON.stringify((await j.get('thread:dst:owner')) ?? null)}`);
  });
});
