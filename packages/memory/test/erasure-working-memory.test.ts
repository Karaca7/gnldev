// Forgetting a person through AgentMemory, and whose working memory a thread id can reach.
//
// Measured before (release panel, 0.7.0):
//  - `eraseSubject` left the person's resource-scoped working memory (`res:u-ayse` = {"iban":"TR55-AYSE"})
//    and reported success;
//  - called without `memory` (as the queue README showed it), it left all of their threads, no error;
//  - a thread named `res:u-ayse` was the same key as Ayse's working memory: an anonymous caller, or a
//    thread-scoped agent on the same storage, read it into its system prompt.
import { describe, it, expect } from 'vitest';
import { stepCountIs } from 'ai';
import {
  InMemoryStorage, createGnl, user, eraseSubject, toJournal, withOrgStorage, workingMemoryScope, type Storage,
} from '@gnldev/durable';
import { AgentMemory, memoryPreset } from '../src/index.js';

(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;
const usage = { inputTokens: { total: 1, text: 1 }, outputTokens: { total: 1, text: 1, reasoning: undefined }, totalTokens: 2 };
const stop = { unified: 'stop', raw: 'stop' };
/** Calls `updateWorkingMemory` with `memory`, then answers. */
const writer = (memory: Record<string, unknown>): any => ({
  specificationVersion: 'v4', provider: 'mock', modelId: 'w', supportedUrls: {},
  doGenerate: async ({ prompt }: any) => ((prompt ?? []).some((m: any) => m.role === 'tool')
    ? { content: [{ type: 'text', text: 'saved' }], finishReason: stop, usage, warnings: [] }
    : { content: [{ type: 'tool-call', toolCallId: 'w1', toolName: 'updateWorkingMemory', input: JSON.stringify({ memory }) }], finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage, warnings: [] }),
});
/** Answers with its own system prompt, so a test sees what memory put there. */
const echoSys: any = {
  specificationVersion: 'v4', provider: 'mock', modelId: 'e', supportedUrls: {},
  doGenerate: async ({ prompt }: any) => ({
    content: [{ type: 'text', text: `SYS=${(prompt ?? []).filter((m: any) => m.role === 'system').map((m: any) => String(m.content)).join('|')}` }],
    finishReason: stop, usage, warnings: [],
  }),
};
const obsModel: any = {
  specificationVersion: 'v2', provider: 'mock', modelId: 'obs', supportedUrls: {},
  doGenerate: async () => ({ content: [{ type: 'text', text: 'OBS: ayse iban TR55' }], finishReason: 'stop', usage: {}, warnings: [] }),
  doStream: async () => { throw new Error('no'); },
};

const wm = (s: Storage, key: string) => s.memory!.getWorkingMemory(key);

/** Ayse (and a namesake-free neighbour, zed) remembered through a resource-scoped agent. */
async function world() {
  const storage = new InMemoryStorage();
  const memory = memoryPreset(storage as any, 'chat', { workingMemory: { scope: 'resource' } });
  const gnl = createGnl({ storage, memory, agents: { w: { model: writer({ iban: 'TR55-AYSE' }), stopWhen: stepCountIs(3) } } } as any);
  await gnl.run('w', { runId: 'ay1', prompt: 'remember', threadId: 'ayse-thread', caller: user('u-ayse') });
  const zgnl = createGnl({ storage, memory, agents: { w: { model: writer({ iban: 'ZED-KEEP' }), stopWhen: stepCountIs(3) } } } as any);
  await zgnl.run('w', { runId: 'z1', prompt: 'remember', threadId: 'zed-thread', caller: user('u-zed') });
  return { storage, memory };
}

describe('eraseSubject(storage) forgets what AgentMemory holds', () => {
  it("the person's resource-scoped working memory goes, and the report counts it (M-1)", async () => {
    const { storage } = await world();
    expect(await wm(storage, workingMemoryScope.resource('u-ayse'))).toEqual({ iban: 'TR55-AYSE' });

    const report = await eraseSubject(storage, 'u-ayse');

    expect(await wm(storage, workingMemoryScope.resource('u-ayse'))).toBeUndefined();
    expect(report).toMatchObject({ memoryThreads: 1, workingMemory: 1 });
    // The neighbour keeps everything.
    expect(await wm(storage, workingMemoryScope.resource('u-zed'))).toEqual({ iban: 'ZED-KEEP' });
    expect((await storage.memory.getMessages('zed-thread')).items.length).toBeGreaterThan(0);
  });

  it('no store has to be listed: the threads go without naming the memory (M-2)', async () => {
    const { storage } = await world();
    expect((await storage.memory.getMessages('ayse-thread')).items.length).toBeGreaterThan(0);

    await eraseSubject(storage, 'u-ayse');

    expect((await storage.memory.getMessages('ayse-thread')).items).toEqual([]);
    expect(await storage.memory.getThread('ayse-thread')).toBeUndefined();
    const left = (await storage.runs.listKeys!('')).filter((k) => k.includes('ayse'));
    expect(left).toEqual([]);
  });

  it('a thread-scoped agent: the thread and its working memory go with the person', async () => {
    const storage = new InMemoryStorage();
    const memory = memoryPreset(storage as any, 'chat', { workingMemory: { scope: 'thread' } });
    const gnl = createGnl({ storage, memory, agents: { w: { model: writer({ note: 'AYSE-THREAD-WM' }), stopWhen: stepCountIs(3) } } } as any);
    await gnl.run('w', { runId: 't1', prompt: 'remember', threadId: 't-ayse', caller: user('u-ayse') });
    expect(await wm(storage, workingMemoryScope.thread('t-ayse'))).toEqual({ note: 'AYSE-THREAD-WM' });

    await eraseSubject(storage, 'u-ayse');

    expect(await wm(storage, workingMemoryScope.thread('t-ayse'))).toBeUndefined();
  });

  it("observational memory's journal records (the observer's summary) go with the thread", async () => {
    const storage = new InMemoryStorage();
    const mem = new AgentMemory({ storage, observationalMemory: { enabled: true, observerModel: obsModel, observation: { messageThreshold: 3 } } });
    for (const [t, who] of [['th-ayse', 'ayse'], ['th-ayse:2', 'zed']] as const) {
      await mem.createThread({ id: t, resourceId: who });
      for (let i = 0; i < 8; i++) await mem.append(t, [{ role: 'user', content: `iban ${who} ${i}` }]);
      await mem.compact(t);
    }
    const j = toJournal(storage.runs);
    expect((await j.listKeys!('om:th-ayse:proc:')).length).toBeGreaterThan(0);

    const report = await eraseSubject(storage, 'ayse');

    expect(report.memoryThreads).toBe(1);
    // `th-ayse:2` extends the id and is zed's: its records stay whole.
    const left = await j.listKeys!('om:');
    expect(left.length).toBeGreaterThan(0);
    expect(left.every((k) => k.startsWith('om:th-ayse:2:'))).toBe(true);
  });

  it("in an organization: acme's ayse goes, the organization-less ayse keeps her working memory and threads", async () => {
    const storage = new InMemoryStorage();
    const acme = withOrgStorage(storage, 'acme');
    const inAcme = new AgentMemory({ storage: acme, workingMemory: { scope: 'resource' } });
    const atRoot = new AgentMemory({ storage, workingMemory: { scope: 'resource' } });
    for (const m of [inAcme, atRoot]) {
      await m.createThread({ id: 't-1', resourceId: 'ayse' });
      await m.append('t-1', [{ role: 'user', content: 'hi' }]);
      await m.applyWorkingMemoryUpdate('t-1', { iban: 'TR55' }, 'ayse');
    }

    await eraseSubject(storage, 'ayse', { orgId: 'acme' });
    expect(await acme.memory!.getWorkingMemory(workingMemoryScope.resource('ayse'))).toBeUndefined();
    expect(await acme.memory!.getThread('t-1')).toBeUndefined();
    expect(await wm(storage, workingMemoryScope.resource('ayse'))).toEqual({ iban: 'TR55' });
    expect(await storage.memory.getThread('t-1')).toBeDefined();

    // And the other way round: the organization-less erasure leaves acme's (re-created) ayse alone.
    await inAcme.createThread({ id: 't-2', resourceId: 'ayse' });
    await inAcme.applyWorkingMemoryUpdate('t-2', { iban: 'ACME' }, 'ayse');
    await eraseSubject(storage, 'ayse');
    expect(await wm(storage, workingMemoryScope.resource('ayse'))).toBeUndefined();
    expect(await storage.memory.getThread('t-1')).toBeUndefined();
    expect(await acme.memory!.getWorkingMemory(workingMemoryScope.resource('ayse'))).toEqual({ iban: 'ACME' });
    expect(await acme.memory!.getThread('t-2')).toBeDefined();
  });

  it('the old call shape, a list of stores, is refused rather than half-honoured', async () => {
    const { storage } = await world();
    await expect(eraseSubject({ journal: toJournal(storage.runs) } as any, 'u-ayse')).rejects.toThrow(/takes the storage itself/);
    expect((await storage.memory.getMessages('ayse-thread')).items.length).toBeGreaterThan(0);
  });

  it("an organization's view of the storage is refused: jobs and events are in the root", async () => {
    const { storage } = await world();
    await expect(eraseSubject(withOrgStorage(storage, 'acme'), 'u-ayse')).rejects.toThrow(/root storage/);
  });
});

describe("a thread id cannot name a person's working memory (M-3)", () => {
  async function ayseRemembers() {
    const storage = new InMemoryStorage();
    const memory = memoryPreset(storage as any, 'chat', { workingMemory: { scope: 'resource' } });
    const gnl = createGnl({ storage, memory, agents: { w: { model: writer({ secret: 'AYSE-WM-SECRET' }), stopWhen: stepCountIs(3) }, e: { model: echoSys } } } as any);
    await gnl.run('w', { runId: 'ay1', prompt: 'remember', threadId: 'ayse-thread', caller: user('u-ayse') });
    return { storage, gnl };
  }

  it('control: Ayse sees her own working memory on a new thread', async () => {
    const { gnl } = await ayseRemembers();
    const own = await gnl.run('e', { runId: 'ay2', prompt: 'x', threadId: 'ayse-thread-2', caller: user('u-ayse') });
    expect(own.text).toContain('AYSE-WM-SECRET');
  });

  it.each(['res:u-ayse', 'resource:u-ayse', 'thread:resource:u-ayse'])('an anonymous caller on thread %s does not see it', async (threadId) => {
    const { gnl } = await ayseRemembers();
    const r = await gnl.run('e', { runId: 'anon', prompt: 'x', threadId });
    expect(r.text).not.toContain('AYSE-WM-SECRET');
  });

  it.each(['res:u-ayse', 'resource:u-ayse'])('a thread-scoped agent on the same storage, thread %s: cannot read it, and its writes land in its own thread', async (threadId) => {
    const { storage } = await ayseRemembers();
    const memory = memoryPreset(storage as any, 'chat', { workingMemory: { scope: 'thread' } });
    const gnl = createGnl({ storage, memory, agents: { e: { model: echoSys }, w: { model: writer({ secret: 'MALLORY' }), stopWhen: stepCountIs(3) } } } as any);
    const read = await gnl.run('e', { runId: 'm1', prompt: 'x', threadId, caller: user('u-mallory') });
    expect(read.text).not.toContain('AYSE-WM-SECRET');
    await gnl.run('w', { runId: 'm2', prompt: 'x', threadId, caller: user('u-mallory') });
    expect(await wm(storage, workingMemoryScope.resource('u-ayse'))).toEqual({ secret: 'AYSE-WM-SECRET' });
    expect(await wm(storage, workingMemoryScope.thread(threadId))).toEqual({ secret: 'MALLORY' });
  });

  it("Memory.getWorkingMemory(threadId) — the studio's and the engine's reader — reads the thread's key only", async () => {
    const { storage } = await ayseRemembers();
    const mem = new AgentMemory({ storage, workingMemory: { scope: 'thread' } });
    expect(await mem.getWorkingMemory('resource:u-ayse')).toBeUndefined();
    expect(await mem.getWorkingMemory('res:u-ayse')).toBeUndefined();
  });
});
