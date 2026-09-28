// What erasure reaches besides `storage.memory`'s current keys (0.7.0 release panels, final round).
//
// Measured on f9dd23ad, before this file:
//  - Ş1: `createGnl({ storage, memory: memoryPreset(otherStorage) })` — `eraseSubject(storage, 'u-ayse')`
//    deleted nothing from `otherStorage` and reported `memoryThreads: 1`; her thread and her working
//    memory `{"iban":"TR55-AYSE"}` stayed.
//  - Ş2: working memory 0.6.0 wrote (`res:<id>`, a thread's bare id) survived erasure and thread
//    deletion, and 0.7 no longer reads it.
//  - Ş3: observational-memory vectors were written with no owner and no namespace, so the erasure,
//    which deletes documents by owner, left "AYSE-OBSERVATION: diabetic, IBAN TR55".
import { describe, it, expect } from 'vitest';
import { stepCountIs } from 'ai';
import {
  InMemoryStorage, createGnl, user, eraseSubject, withOrgStorage, scopeConfigToOrg, workingMemoryScope, toJournal, staff,
  type Storage, type VectorStore,
} from '@gnldev/durable';
import { SqliteStorage } from '../../durable/src/sqlite-storage.js';
import { AgentMemory, memoryPreset, migrateWorkingMemoryKeys } from '../src/index.js';

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
/** An observer whose summary names the person it observed. */
const observer = (tag: string): any => ({
  specificationVersion: 'v2', provider: 'mock', modelId: 'obs', supportedUrls: {},
  doGenerate: async () => ({ content: [{ type: 'text', text: `OBS|${tag}|` }], finishReason: 'stop', usage: {}, warnings: [] }),
  doStream: async () => { throw new Error('no'); },
});
const embed = async (t: string[]) => t.map(() => [1, 0, 0]);
const wmOpts = { workingMemory: { scope: 'resource' as const } };

// ── Ş1 ───────────────────────────────────────────────────────────────────────────────────────────
describe('Ş1: a memory kept in another storage than the one erased', () => {
  async function world(memoryStorage: Storage, storage: Storage) {
    const memory = memoryPreset(memoryStorage as any, 'chat', wmOpts);
    const gnl = createGnl({ storage, memory, agents: { w: { model: writer({ iban: 'TR55-AYSE' }), stopWhen: stepCountIs(3) } } } as any);
    await gnl.run('w', { runId: 'ay1', prompt: 'r', threadId: 'ayse-thread', caller: user('u-ayse') });
    await gnl.run('w', { runId: 'bo1', prompt: 'r', threadId: 'bob-thread', caller: user('u-bob') });
  }
  const threadsOf = async (s: Storage) => (await s.memory!.listThreads({ limit: 100 })).items.map((t) => t.id).sort();

  it('on storage.memory: the thread and working memory go, and the report counts them', async () => {
    const storage = new InMemoryStorage();
    await world(storage, storage);
    const report = await eraseSubject(storage, 'u-ayse');
    expect(await threadsOf(storage)).toEqual(['bob-thread']);
    expect(await storage.memory!.getWorkingMemory(workingMemoryScope.resource('u-ayse'))).toBeUndefined();
    expect(await storage.memory!.getWorkingMemory(workingMemoryScope.resource('u-bob'))).toEqual({ iban: 'TR55-AYSE' });
    expect({ threads: report.memoryThreads, wm: report.workingMemory, unreached: report.unreachedThreads }).toEqual({ threads: 1, wm: 1, unreached: [] });
  });

  it('elsewhere, not named: nothing is claimed — 0 threads, 0 working memory — and the thread is listed as unreached', async () => {
    const storage = new InMemoryStorage();
    const other = new InMemoryStorage();
    await world(other, storage);
    const report = await eraseSubject(storage, 'u-ayse');
    expect({ threads: report.memoryThreads, wm: report.workingMemory, unreached: report.unreachedThreads }).toEqual({ threads: 0, wm: 0, unreached: ['ayse-thread'] });
    // Still there — the report says so instead of reading like success.
    expect(await threadsOf(other)).toEqual(['ayse-thread', 'bob-thread']);
  });

  it('elsewhere, named as `memory`: her thread, working memory and observational journal go there; bob stays', async () => {
    const storage = new InMemoryStorage();
    const other = new InMemoryStorage();
    await world(other, storage);
    await toJournal(other.runs).put('om:ayse-thread:observedSeq', 3);
    const report = await eraseSubject(storage, 'u-ayse', { memory: other });
    expect(await threadsOf(other)).toEqual(['bob-thread']);
    expect(await other.memory!.getWorkingMemory(workingMemoryScope.resource('u-ayse'))).toBeUndefined();
    expect(await other.memory!.getWorkingMemory(workingMemoryScope.resource('u-bob'))).toEqual({ iban: 'TR55-AYSE' });
    expect(await other.runs.get('om:ayse-thread:observedSeq')).toBeUndefined();
    expect({ threads: report.memoryThreads, wm: report.workingMemory, unreached: report.unreachedThreads }).toEqual({ threads: 1, wm: 1, unreached: [] });
  });

  it('`memory` naming `storage` itself counts once', async () => {
    const storage = new InMemoryStorage();
    await world(storage, storage);
    const report = await eraseSubject(storage, 'u-ayse', { memory: storage });
    expect({ threads: report.memoryThreads, wm: report.workingMemory }).toEqual({ threads: 1, wm: 1 });
  });

  it('an organization member, memory elsewhere: acme\'s Ayse goes from it, globex\'s Ayse stays', async () => {
    const storage = new InMemoryStorage();
    const other = new InMemoryStorage();
    for (const org of ['acme', 'globex']) {
      const cfg = scopeConfigToOrg({ storage, memoryFactory: () => memoryPreset(withOrgStorage(other, org) as any, 'chat', wmOpts), agents: { w: { model: writer({ iban: `IBAN-${org}` }), stopWhen: stepCountIs(3) } } } as any, org);
      await createGnl(cfg.config).run('w', { runId: `r-${org}`, prompt: 'r', threadId: 't', caller: user('u-ayse', org) });
    }
    const report = await eraseSubject(storage, 'u-ayse', { orgId: 'acme', memory: other });
    const acme = withOrgStorage(other, 'acme').memory!;
    const globex = withOrgStorage(other, 'globex').memory!;
    expect(await acme.getThread('t')).toBeUndefined();
    expect(await acme.getWorkingMemory(workingMemoryScope.resource('u-ayse'))).toBeUndefined();
    expect(await globex.getThread('t')).toBeDefined();
    expect(await globex.getWorkingMemory(workingMemoryScope.resource('u-ayse'))).toEqual({ iban: 'IBAN-globex' });
    expect({ threads: report.memoryThreads, wm: report.workingMemory, unreached: report.unreachedThreads }).toEqual({ threads: 1, wm: 1, unreached: [] });
  });

  it('refuses an organization\'s view, or a storage with no memory store, as `memory` — before deleting anything', async () => {
    const storage = new InMemoryStorage();
    await world(storage, storage);
    await expect(eraseSubject(storage, 'u-ayse', { memory: withOrgStorage(new InMemoryStorage(), 'acme') })).rejects.toThrow(/organization 'acme''s storage/);
    await expect(eraseSubject(storage, 'u-ayse', { memory: { runs: storage.runs } as unknown as Storage })).rejects.toThrow(/needs a memory store/);
    expect(await threadsOf(storage)).toEqual(['ayse-thread', 'bob-thread']);
  });
});

// ── Ş2 ───────────────────────────────────────────────────────────────────────────────────────────
/** Writes working memory where 0.6.0's AgentMemory did: `res:<id>` for a person, the bare id for a thread. */
async function write06(store: Storage['memory'], who: string, thread: string, tag: string) {
  await store!.setWorkingMemory(`res:${who}`, { v: `LEGRES|${tag}|` });
  await store!.setWorkingMemory(thread, { v: `LEGTHR|${tag}|` });
}

describe('Ş2: working memory 0.6.0 wrote', () => {
  for (const [name, mk] of [['InMemory', () => new InMemoryStorage()], ['SQLite', () => new SqliteStorage(':memory:')]] as const) {
    it(`${name}: eraseSubject deletes the person's res:<id> and her thread's bare-id key; bob's stay`, async () => {
      const storage = (mk as () => Storage)();
      const mem = new AgentMemory({ storage, ...wmOpts });
      await mem.createThread({ id: 'ayse-thread', resourceId: 'u-ayse' });
      await mem.createThread({ id: 'bob-thread', resourceId: 'u-bob' });
      await write06(storage.memory, 'u-ayse', 'ayse-thread', 'ayse');
      await write06(storage.memory, 'u-bob', 'bob-thread', 'bob');

      const report = await eraseSubject(storage, 'u-ayse');

      expect(await storage.memory!.getWorkingMemory('res:u-ayse')).toBeUndefined();
      expect(await storage.memory!.getWorkingMemory('ayse-thread')).toBeUndefined();
      expect(await storage.memory!.getWorkingMemory('res:u-bob')).toEqual({ v: 'LEGRES|bob|' });
      expect(await storage.memory!.getWorkingMemory('bob-thread')).toEqual({ v: 'LEGTHR|bob|' });
      expect({ threads: report.memoryThreads, wm: report.workingMemory }).toEqual({ threads: 1, wm: 1 });
    });

    it(`${name}: in an organization, org:acme:res:<id> and org:acme:<thread> go; globex's same ids stay`, async () => {
      const storage = (mk as () => Storage)();
      for (const org of ['acme', 'globex']) {
        const view = withOrgStorage(storage, org);
        await new AgentMemory({ storage: view }).createThread({ id: 't', resourceId: 'u-ayse' });
        await write06(view.memory, 'u-ayse', 't', org);
      }
      await eraseSubject(storage, 'u-ayse', { orgId: 'acme' });
      expect(await storage.memory!.getWorkingMemory('org:acme:res:u-ayse')).toBeUndefined();
      expect(await storage.memory!.getWorkingMemory('org:acme:t')).toBeUndefined();
      expect(await storage.memory!.getWorkingMemory('org:globex:res:u-ayse')).toEqual({ v: 'LEGRES|globex|' });
      expect(await storage.memory!.getWorkingMemory('org:globex:t')).toEqual({ v: 'LEGTHR|globex|' });
    });

    it(`${name}: deleting a thread takes its bare-id key — and never a person's, whatever the thread is called`, async () => {
      const storage = (mk as () => Storage)();
      const mem = new AgentMemory({ storage });
      await storage.memory!.setWorkingMemory('plain', { v: 'LEGTHR|plain|' });
      await storage.memory!.setWorkingMemory('res:u-ayse', { v: 'LEGRES|ayse|' });
      await storage.memory!.setWorkingMemory(workingMemoryScope.resource('u-ayse'), { v: 'RES|ayse|' });
      for (const t of ['plain', 'res:u-ayse', 'resource:u-ayse']) {
        await mem.createThread({ id: t, resourceId: 'u-bob' });
        await mem.deleteThread(t);
      }
      expect(await storage.memory!.getWorkingMemory('plain')).toBeUndefined();
      expect(await storage.memory!.getWorkingMemory('res:u-ayse')).toEqual({ v: 'LEGRES|ayse|' });
      expect(await storage.memory!.getWorkingMemory(workingMemoryScope.resource('u-ayse'))).toEqual({ v: 'RES|ayse|' });
    });
  }

  it('migrateWorkingMemoryKeys moves 0.6 keys to 0.7 ones, and AgentMemory reads them again', async () => {
    const storage = new SqliteStorage(':memory:');
    const mem = new AgentMemory({ storage, workingMemory: { scope: 'resource' } });
    await mem.createThread({ id: 't-alice', resourceId: 'alice' });
    await storage.memory!.setWorkingMemory('res:alice', { name: 'Alice Smith' });
    await storage.memory!.setWorkingMemory('t-alice', { name: 'Alice (thread)' });
    // Before: 0.7 reads nothing.
    expect((await mem.loadContext('t-alice', { resourceId: 'alice' })).system ?? '').not.toContain('Alice Smith');

    const report = await migrateWorkingMemoryKeys(storage.memory!);

    expect(report).toEqual({ moved: ['res:alice', 't-alice'], kept: [], skipped: [] });
    expect((await mem.loadContext('t-alice', { resourceId: 'alice' })).system).toContain('Alice Smith');
    expect(await storage.memory!.getWorkingMemory(workingMemoryScope.thread('t-alice'))).toEqual({ name: 'Alice (thread)' });
    expect(await storage.memory!.getWorkingMemory('res:alice')).toBeUndefined();
    expect(await storage.memory!.getWorkingMemory('t-alice')).toBeUndefined();
    // Idempotent: a second pass has nothing to move.
    expect(await migrateWorkingMemoryKeys(storage.memory!)).toEqual({ moved: [], kept: [], skipped: [] });
  });

  it('migrateWorkingMemoryKeys never overwrites a newer value, skips an ambiguous thread id, and works in an organization', async () => {
    const storage = new InMemoryStorage();
    const acme = withOrgStorage(storage, 'acme');
    await acme.memory!.setWorkingMemory('res:u-ayse', { v: 'OLD' });
    await acme.memory!.setWorkingMemory(workingMemoryScope.resource('u-ayse'), { v: 'NEW' });
    await acme.memory!.setWorkingMemory('res:u-bob', { v: 'BOB-06' });
    await acme.memory!.setWorkingMemory('res:x', { v: 'thread-or-person' });
    await storage.memory!.setWorkingMemory('res:u-bob', { v: 'ROOT-BOB-06' });

    const report = await migrateWorkingMemoryKeys(acme.memory!, { resourceIds: ['u-ayse', 'u-bob'], threadIds: ['res:x'] });

    expect(report).toEqual({ moved: ['res:u-bob'], kept: ['res:u-ayse'], skipped: ['res:x'] });
    expect(await acme.memory!.getWorkingMemory(workingMemoryScope.resource('u-ayse'))).toEqual({ v: 'NEW' });
    expect(await acme.memory!.getWorkingMemory('res:u-ayse')).toEqual({ v: 'OLD' });
    expect(await acme.memory!.getWorkingMemory(workingMemoryScope.resource('u-bob'))).toEqual({ v: 'BOB-06' });
    expect(await storage.memory!.getWorkingMemory('org:acme:resource:u-bob')).toEqual({ v: 'BOB-06' });
    // Another partition is not touched: the root's 0.6 bob stays where it was.
    expect(await storage.memory!.getWorkingMemory('res:u-bob')).toEqual({ v: 'ROOT-BOB-06' });
    expect(await storage.memory!.getWorkingMemory(workingMemoryScope.resource('u-bob'))).toBeUndefined();
  });
});

// ── Ş3 ───────────────────────────────────────────────────────────────────────────────────────────
type Who = { who: string; orgId?: string; thread: string };
const tagOf = (p: Who) => `${p.who}@${p.orgId ?? '-'}`;

/** One observed thread for a person, through AgentMemory, with omVectors on `vectorsFor(view)`. */
async function observed(storage: Storage, p: Who, vectorsFor: (view: Storage) => VectorStore) {
  const view = p.orgId ? withOrgStorage(storage, p.orgId) : storage;
  const mem = new AgentMemory({ storage: view, observationalMemory: { enabled: true, observerModel: observer(tagOf(p)), observation: { messageThreshold: 2 }, omVectors: { store: vectorsFor(view), embed } } });
  await mem.createThread({ id: p.thread, resourceId: p.who });
  for (let n = 0; n < 4; n++) await mem.append(p.thread, [{ role: 'user', content: `msg ${n}` }]);
  await mem.compact(p.thread);
  return mem;
}
/** Every stored vector text, across the root and both organizations. */
async function vectorTexts(storage: Storage): Promise<string[]> {
  const out = new Set<string>();
  for (const v of [storage.vectors!, withOrgStorage(storage, 'acme').vectors!, withOrgStorage(storage, 'globex').vectors!]) {
    for (const m of await v.query([1, 0, 0], 100)) out.add(m.text);
  }
  return [...out].sort();
}

describe('Ş3: observational-memory vectors belong to the thread\'s owner', () => {
  const AYSE: Who = { who: 'u-ayse', thread: 'ta' };
  const ACME_AYSE: Who = { who: 'u-ayse', orgId: 'acme', thread: 'ta' };
  const people: Who[] = [AYSE, ACME_AYSE, { who: 'u-ayse', orgId: 'globex', thread: 'ta' }, { who: 'u-bob', thread: 'tb' }, { who: 'u-bob', orgId: 'acme', thread: 'tb' }];
  const all = people.map((p) => `OBS|${tagOf(p)}|`);

  for (const [how, vectorsFor] of [
    ['the storage\'s own vector store (an organization\'s view in an organization)', (view: Storage) => view.vectors!],
    ['the ROOT vector store handed to an organization\'s memory', (_view: Storage, root?: Storage) => root!.vectors!],
  ] as const) {
    it(`labelled with owner (and namespace): ${how}`, async () => {
      const storage = new InMemoryStorage();
      for (const p of people) await observed(storage, p, (view) => (vectorsFor as (v: Storage, r?: Storage) => VectorStore)(view, storage));
      await storage.vectors!.upsert([{ id: 'shared-doc', text: 'SHARED|doc|', embedding: [1, 0, 0], shared: true }]);
      await withOrgStorage(storage, 'acme').vectors!.upsert([{ id: 'shared-doc', text: 'SHARED|acme|', embedding: [1, 0, 0], shared: true }]);
      expect(await vectorTexts(storage)).toEqual([...all, 'SHARED|acme|', 'SHARED|doc|'].sort());
      // Bob's own view shows his observations and the shared shelf, never Ayse's.
      expect((await storage.vectors!.query([1, 0, 0], 100, { visibleTo: 'u-bob' })).map((m) => m.text).sort())
        .toEqual(['OBS|u-bob@-|', 'OBS|u-bob@acme|', 'SHARED|acme|', 'SHARED|doc|']);

      // The organization-less Ayse: hers go, acme's and globex's Ayse are other people.
      await eraseSubject(storage, 'u-ayse');
      expect(await vectorTexts(storage)).toEqual(all.filter((t) => t !== `OBS|${tagOf(AYSE)}|`).concat(['SHARED|acme|', 'SHARED|doc|']).sort());
      // acme's Ayse: hers go, globex's Ayse and acme's bob stay.
      await eraseSubject(storage, 'u-ayse', { orgId: 'acme' });
      expect(await vectorTexts(storage)).toEqual(all.filter((t) => t !== `OBS|${tagOf(AYSE)}|` && t !== `OBS|${tagOf(ACME_AYSE)}|`).concat(['SHARED|acme|', 'SHARED|doc|']).sort());
    });
  }

  it('the recall of an organization\'s memory over the root store answers from its own namespace', async () => {
    const storage = new InMemoryStorage();
    const acme = await observed(storage, ACME_AYSE, () => storage.vectors!);
    await observed(storage, { who: 'u-ayse', orgId: 'globex', thread: 'ta' }, () => storage.vectors!);
    expect((await acme.recallObservationsSemantic('ta', 'anything', { topK: 10 })).map((o) => o.text)).toEqual([`OBS|${tagOf(ACME_AYSE)}|`]);
  });

  it('a staff thread\'s observations carry no owner: no end user\'s query reaches them, no person\'s erasure takes them', async () => {
    const storage = new InMemoryStorage();
    const mem = new AgentMemory({ storage, observationalMemory: { enabled: true, observerModel: observer('staff'), observation: { messageThreshold: 2 }, omVectors: { store: storage.vectors!, embed } } });
    const gnl = createGnl({ storage, memory: mem, agents: { a: { model: echoSys } } } as any);
    for (const n of [1, 2]) await gnl.run('a', { runId: `s${n}`, prompt: `staff ${n}`, threadId: 'ts', caller: staff() });
    await mem.compact('ts');
    const [doc] = await storage.vectors!.query([1, 0, 0], 10);
    expect({ text: doc?.text, owner: doc?.owner }).toEqual({ text: 'OBS|staff|', owner: undefined });
    expect(await storage.vectors!.query([1, 0, 0], 10, { visibleTo: 'u-ayse' })).toEqual([]);
    await eraseSubject(storage, 'u-ayse');
    expect(await vectorTexts(storage)).toEqual(['OBS|staff|']);
  });

  it('refuses another organization\'s vector store', () => {
    const storage = new InMemoryStorage();
    expect(() => new AgentMemory({
      storage: withOrgStorage(storage, 'acme'),
      observationalMemory: { enabled: true, observerModel: observer('x'), omVectors: { store: withOrgStorage(storage, 'globex').vectors!, embed } },
    })).toThrow(/organization 'globex''s vector store, but this memory is organization 'acme''s/);
  });

  it('through the engine (the panel probe): the observation of Ayse\'s run goes with her, bob\'s stays', async () => {
    const storage = new InMemoryStorage();
    const memory: any = memoryPreset(storage as any, 'chat', { observationalMemory: { model: echoSys, omVectors: { store: storage.vectors as any, embed } } as any });
    const gnl = createGnl({ storage, memory, agents: { a: { model: echoSys } } } as any);
    await gnl.run('a', { runId: 'ay1', prompt: 'hi', threadId: 'ayse-thread', caller: user('u-ayse') });
    await gnl.run('a', { runId: 'bo1', prompt: 'hi', threadId: 'bob-thread', caller: user('u-bob') });
    await memory.indexObservationVector('ayse-thread', 0, 1, { id: 'o1', text: 'AYSE-OBSERVATION: diabetic, IBAN TR55', fromSeq: 0, toSeq: 1, threadId: 'ayse-thread' });
    await memory.indexObservationVector('bob-thread', 0, 1, { id: 'o1', text: 'BOB-OBSERVATION', fromSeq: 0, toSeq: 1, threadId: 'bob-thread' });
    await eraseSubject(storage, 'u-ayse');
    expect(await vectorTexts(storage)).toEqual(['BOB-OBSERVATION']);
  });
});
