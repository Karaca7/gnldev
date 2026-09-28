/**
 * ONE erasure for a person: runs, threads, documents, and — through the erasers the background
 * packages hand in — queued jobs, triggers and events.
 *
 * THE SEAM. `@gnldev/durable` cannot import `@gnldev/queue`, `@gnldev/scheduler` or `@gnldev/events`
 * (they depend on it). Two things make one call possible anyway:
 *  - the owner is recorded in ONE shape wherever it is not a run record: in the NAME the engine writes
 *    (`ownedName`, `~o~<org>:<user>:<name>`), so every owned log record in the work store is found by
 *    its id prefix without knowing what a job or an event is (`deleteIdPrefix`, done here);
 *  - everything ELSE a package keeps about an owned record (markers, locks, trigger definitions) is
 *    keyed in that package's own format, so the package that writes it erases it: `jobEraser`,
 *    `triggerEraser`, `eventEraser`, passed in as `erasers`. A copy of those formats in this file had
 *    already drifted (it knew the trigger families but not the fire locks, nor any job marker).
 * Runs, threads and documents are erased by `purgeResource`, whose thread question is `threadOwnerOf`
 * — the same one the gate and the listing ask.
 *
 * IT TAKES THE STORAGE, NOT A LIST OF ITS STORES. It used to take `{ journal, work?, vectors?, memory? }`,
 * and a store left off the list was a store left untouched, with a report that read like success:
 * without `memory` a person's AgentMemory threads stayed (the queue README's own example did that),
 * and even with it their working memory (`res:<id>`) stayed. Every store the storage carries is now
 * erased from, or the erasure refuses. What lives OUTSIDE the storage — another package's records in
 * its own format, or a memory kept in some other database — comes in as an eraser.
 */
import { purgeResource, purgeThread, assertDeletesOutsideOrganizations } from './retention.js';
import { ownedPrefix } from './owned-name.js';
import { threadOwnerOf } from './thread-owner.js';
import { withOrg } from './organization.js';
import { orgVectorDelete, orgStorageScopeOf, withOrgStorage } from './org-storage.js';
import { toJournal, workingMemoryScope, legacyWorkingMemoryScope } from './storage.js';
import { memKey, MEM_LEAVES, OM_VECTOR_SOURCE } from './memory.js';
import type { Memory } from './memory.js';
import type { Journal } from './journal.js';
import type { MemoryStore, Storage, WorkStore } from './storage.js';

/** One package's share of a person's erasure (`jobEraser`, `triggerEraser`, `eventEraser`), or a store outside the storage. */
export interface SubjectEraser {
  name: string;
  erase(owner: { resourceId: string; orgId?: string }): Promise<number>;
}

export interface EraseOptions {
  /** The person's organization. Their runs, threads, working memory and documents in THAT organization go; the same id elsewhere is somebody else. */
  orgId?: string;
  /** The background packages' erasers — `jobEraser(storage)`, `triggerEraser(journal)`, `eventEraser(work)` — and any store the storage does not hold. */
  erasers?: SubjectEraser[];
  /**
   * The storage the agents' memory was built over, when it is not `storage` — `createGnl({ storage,
   * memory: memoryPreset(otherStorage) })`. Its threads, working memory, observational-memory records
   * and documents are erased by the same rules as `storage`'s: the ROOT storage again, with `orgId`
   * naming the organization. Nothing in `storage` says a memory lives elsewhere, so the erasure cannot
   * find it by itself; what it can see is a thread whose owner record names this person and whose
   * messages it found nowhere, and it lists those in `unreachedThreads`.
   */
  memory?: Storage;
}

export interface EraseReport {
  journalRows: number;
  /** Owned log records (jobs, events, their depth-index records) found by id prefix. */
  workRecords: number;
  /** Threads removed from a memory store, with their messages, observations and working memory. Only threads a store actually held. */
  memoryThreads: number;
  /** Working-memory records removed: the person's own (`workingMemoryScope.resource`, and the 0.6 key `res:<id>`). */
  workingMemory: number;
  /**
   * Threads this person owns (their owner record says so) whose messages were in no store this erasure
   * reached. Most often a memory kept in another storage: pass it as `memory`. Not empty means the
   * erasure did NOT reach everything, whatever the other counts say.
   */
  unreachedThreads: string[];
  /** What each eraser removed, by its name. */
  byEraser: Record<string, number>;
}

/**
 * Refuses an organization's view of the work store in an erasure. Owned jobs and events live in the
 * ROOT work log — their owner, organization included, is in their id — so the organization's view holds
 * none of them, and its `deleteIdPrefix` cannot be confined: the port deletes by id prefix in every
 * namespace. `eraseSubject`, `jobEraser` and `eventEraser` all ask this, so the three say one thing.
 */
export function assertRootWorkForErasure(work: WorkStore | undefined, who: string): void {
  const org = work ? orgStorageScopeOf(work) : undefined;
  if (org !== undefined) {
    throw new Error(
      `${who} was handed organization '${org}''s work store. A person's jobs and events live in the root work log, ` +
        "with their organization in their id, so this view holds none of them. Pass the root storage (its `work`), " +
        'and name the organization with `{ orgId }`.',
    );
  }
}

/** The memory store answering "whose thread", the one question `threadOwnerOf` asks a memory. */
const ownerAsker = (store: MemoryStore): Memory =>
  ({ getThreadResource: async (id: string) => (await store.getThread(id))?.resourceId }) as unknown as Memory;

/** Does this store hold anything of the thread — its record, a message, or its working memory? */
async function holdsThread(store: MemoryStore, threadId: string): Promise<boolean> {
  if ((await store.getThread(threadId)) !== undefined) return true;
  if ((await store.getMessages(threadId, { limit: 1 })).items.length > 0) return true;
  const legacy = legacyWorkingMemoryScope.thread(threadId);
  return (await store.getWorkingMemory(workingMemoryScope.thread(threadId))) !== undefined
    || (legacy !== undefined && (await store.getWorkingMemory(legacy)) !== undefined);
}

/** Does the journal hold the thread's messages (a journal-kept memory, `BasicMemory`)? */
async function journalHoldsThread(runs: Journal, threadId: string): Promise<boolean> {
  for (const leaf of MEM_LEAVES) {
    let key: string;
    try { key = memKey(threadId, leaf); } catch { return false; }
    if ((await runs.get(key)) !== undefined) return true;
  }
  return false;
}

/** Every thread the store lists for this person. Outside organizations, an organization's thread (`org:<id>:…`) is a namesake's. */
async function listedThreads(store: MemoryStore, resourceId: string, outsideOrganizations: boolean): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.listThreads({ resourceId, limit: 500, ...(cursor !== undefined ? { cursor } : {}) });
    for (const t of page.items) if (!(outsideOrganizations && t.id.startsWith('org:'))) out.push(t.id);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return out;
}

/** A storage handed in as `memory`: the root one, with a memory store; `storage` itself counts once. */
function memoryHome(storage: Storage, memory: Storage | undefined): Storage | undefined {
  if (memory === undefined || memory === storage) return undefined;
  if (!memory || typeof memory !== 'object' || !('runs' in memory) || !memory.memory) {
    throw new TypeError('@gnldev/durable: eraseSubject\'s `memory` is the storage your memory was built over (`eraseSubject(storage, id, { memory: otherStorage })`), and it needs a memory store');
  }
  const scoped = orgStorageScopeOf(memory);
  if (scoped !== undefined) {
    throw new Error(
      `@gnldev/durable: eraseSubject's \`memory\` is organization '${scoped}''s storage. Pass the root storage the memory ` +
        'was built over, and name the organization with `{ orgId }`.',
    );
  }
  return memory;
}

/**
 * Erase one person from a storage: runs, threads (journal- and memory-store-kept, with their
 * observational-memory records and vectors), working memory (0.7 and 0.6 keys), documents, and owned
 * jobs and events; plus what the erasers hand in, and a memory kept in another storage (`memory`).
 * `storage` is the ROOT storage; `orgId` names the person's organization.
 *
 * The report counts what was deleted, never what was looked for: a thread whose owner record names
 * this person but that no store held is not counted — it is listed in `unreachedThreads`.
 *
 * Refuses, before deleting anything, a storage whose journal cannot `deletePrefix`, whose work store
 * cannot `deleteIdPrefix`, or whose vector store cannot delete (or, without an organization, cannot
 * confine the delete to documents outside organizations) — and the same of the `memory` storage.
 */
export async function eraseSubject(storage: Storage, resourceId: string, opts: EraseOptions = {}): Promise<EraseReport> {
  if (typeof resourceId !== 'string' || resourceId === '') throw new TypeError('@gnldev/durable: eraseSubject needs the id of the person to erase');
  if (!storage || typeof storage !== 'object' || !('runs' in storage)) {
    throw new TypeError('@gnldev/durable: eraseSubject takes the storage itself (`eraseSubject(storage, id, { orgId, erasers })`), so no store it holds is left out');
  }
  const scoped = orgStorageScopeOf(storage);
  if (scoped !== undefined) {
    throw new Error(
      `@gnldev/durable: eraseSubject was handed organization '${scoped}''s storage. Jobs and events live in the root work log, ` +
        'so this view cannot reach them. Pass the root storage and name the organization with `{ orgId }`.',
    );
  }
  const home = memoryHome(storage, opts.memory);
  const journal = toJournal(storage.runs);
  if (typeof journal.deletePrefix !== 'function') throw new Error('@gnldev/durable: eraseSubject needs a journal that can deletePrefix');
  const homeJournal = home ? toJournal(home.runs) : undefined;
  if (homeJournal && typeof homeJournal.deletePrefix !== 'function') throw new Error('@gnldev/durable: eraseSubject\'s `memory` storage needs a journal that can deletePrefix');
  const work = storage.work;
  if (work && typeof work.deleteIdPrefix !== 'function') {
    throw new Error('@gnldev/durable: eraseSubject was given a work store that cannot delete by id prefix, so this person\'s jobs and events cannot be erased');
  }
  const outside = opts.orgId === undefined;
  // The memory storage's documents are erased too (observational-memory vectors live there when
  // `omVectors.store` is its vector store) — unless they are the same store.
  const homeVectors = home?.vectors && home.vectors !== storage.vectors ? home.vectors : undefined;
  for (const [v, what] of [[storage.vectors, 'vector store'], [homeVectors, '`memory` storage\'s vector store']] as const) {
    if (!v) continue;
    if (typeof v.delete !== 'function') {
      throw new Error(`@gnldev/durable: eraseSubject was given a ${what} that cannot delete, so this person's documents cannot be erased`);
    }
    // Without an organization, the documents half says "outside every organization" — asked here,
    // before anything goes, so a store that cannot honour it leaves this person entirely in place.
    if (outside) assertDeletesOutsideOrganizations(v, '@gnldev/durable: eraseSubject');
  }
  // A person in an organization: their runs, threads and working memory live in that organization's
  // partition, and the same id in another organization is somebody else.
  const runs = outside ? journal : withOrg(journal, opts.orgId!);
  const view = (s: Storage): Storage => (outside ? s : withOrgStorage(s, opts.orgId!));
  // …and their documents in that organization's namespace, the one withOrgStorage writes them under.
  const docs = (v: Storage['vectors']) => v && (outside ? v : orgVectorDelete(v, opts.orgId!));
  const vectors = docs(storage.vectors);
  // Every memory store this erasure reaches, each with the journal its memory keeps observational
  // memory in: `storage`'s own, and the `memory` storage's.
  const stores: Array<{ store: MemoryStore; runs: Journal }> = [];
  if (storage.memory) stores.push({ store: view(storage).memory!, runs });
  if (home) stores.push({ store: view(home).memory!, runs: outside ? homeJournal! : withOrg(homeJournal!, opts.orgId!) });
  const asker = stores[0] ? ownerAsker(stores[0].store) : undefined;

  // Threads first, while the owner records still exist: the ones this person owns, by the ONE question.
  const ownedByRecord = new Set<string>();
  for (const k of (await runs.listKeys?.('thread:')) ?? []) if (k.endsWith(':owner')) ownedByRecord.add(k.slice('thread:'.length, -':owner'.length));
  const deleted: Array<{ thread: string; runs: Journal }> = [];
  const reached = new Set<string>();
  let workingMemory = 0;
  for (const { store, runs: memRuns } of stores) {
    const candidates = new Set<string>([...(await listedThreads(store, resourceId, outside)), ...ownedByRecord]);
    for (const t of candidates) {
      if ((await threadOwnerOf(runs, ownerAsker(store), t)).owner !== resourceId) continue;
      // Counted only when the store held it: a thread found by its owner record may live elsewhere.
      if (!(await holdsThread(store, t))) continue;
      await store.deleteThread(t);
      deleted.push({ thread: t, runs: memRuns });
      reached.add(t);
    }
    for (const key of [workingMemoryScope.resource(resourceId), legacyWorkingMemoryScope.resource(resourceId)]) {
      if (await store.deleteWorkingMemory(key)) workingMemory++;
    }
  }
  // Threads the record gives this person and no memory store held: kept in the journal (BasicMemory),
  // or somewhere this erasure was not shown. Asked before `purgeResource` removes the owner records.
  const unreachedThreads: string[] = [];
  for (const t of ownedByRecord) {
    if (reached.has(t)) continue;
    if ((await threadOwnerOf(runs, asker, t)).owner !== resourceId) continue;
    if (!(await journalHoldsThread(runs, t))) unreachedThreads.push(t);
  }
  let journalRows = await purgeResource(runs, resourceId, {
    ...(vectors ? { vectors } : {}),
    ...(asker ? { memory: asker } : {}),
    ...(outside ? { outsideOrganizations: true } : {}),
  });
  if (homeVectors) journalRows += await docs(homeVectors)!.delete!({ owner: resourceId, ...(outside ? { outsideOrganizations: true } : {}) });
  // A memory-store thread's journal side (observational memory, dedup window, owner record) — reached
  // here too, for a thread with no run left to lead `purgeResource` to it; and in the `memory`
  // storage's journal, where that memory kept its observational-memory records.
  for (const { thread, runs: memRuns } of deleted) {
    journalRows += await purgeThread(runs, thread);
    if (memRuns !== runs) journalRows += await purgeThread(memRuns, thread);
    // …and its observational-memory vectors, by thread: one indexed while the thread was anonymous
    // has no owner label, and the owner delete above does not see it.
    const ofThread = { filter: { source: OM_VECTOR_SOURCE, threadId: thread }, ...(outside ? { outsideOrganizations: true } : {}) };
    for (const v of [vectors, homeVectors && docs(homeVectors)]) if (v) journalRows += await v.delete!(ofThread);
  }
  const owner = { resourceId, ...(opts.orgId !== undefined ? { orgId: opts.orgId } : {}) };
  const workRecords = work ? await work.deleteIdPrefix!(ownedPrefix(owner)) : 0;
  const byEraser: Record<string, number> = {};
  for (const e of opts.erasers ?? []) byEraser[e.name] = (byEraser[e.name] ?? 0) + (await e.erase(owner));
  return { journalRows, workRecords, memoryThreads: deleted.length, workingMemory, unreachedThreads: unreachedThreads.sort(), byEraser };
}
