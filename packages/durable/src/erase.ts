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
import { toJournal, workingMemoryScope } from './storage.js';
import type { Memory } from './memory.js';
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
}

export interface EraseReport {
  journalRows: number;
  /** Owned log records (jobs, events, their depth-index records) found by id prefix. */
  workRecords: number;
  /** Threads removed from the memory store, with their messages, observations and working memory. */
  memoryThreads: number;
  /** Working-memory records removed: the person's own (`workingMemoryScope.resource`). */
  workingMemory: number;
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

/**
 * Erase one person from a storage: runs, threads (journal- and memory-store-kept, with their
 * observational-memory records), working memory, documents, and owned jobs and events; plus what the
 * erasers hand in. `storage` is the ROOT storage; `orgId` names the person's organization.
 *
 * Refuses, before deleting anything, a storage whose journal cannot `deletePrefix`, whose work store
 * cannot `deleteIdPrefix`, or whose vector store cannot delete (or, without an organization, cannot
 * confine the delete to documents outside organizations).
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
  const journal = toJournal(storage.runs);
  if (typeof journal.deletePrefix !== 'function') throw new Error('@gnldev/durable: eraseSubject needs a journal that can deletePrefix');
  const work = storage.work;
  if (work && typeof work.deleteIdPrefix !== 'function') {
    throw new Error('@gnldev/durable: eraseSubject was given a work store that cannot delete by id prefix, so this person\'s jobs and events cannot be erased');
  }
  const outside = opts.orgId === undefined;
  if (storage.vectors) {
    if (typeof storage.vectors.delete !== 'function') {
      throw new Error('@gnldev/durable: eraseSubject was given a vector store that cannot delete, so this person\'s documents cannot be erased');
    }
    // Without an organization, the documents half says "outside every organization" — asked here,
    // before anything goes, so a store that cannot honour it leaves this person entirely in place.
    if (outside) assertDeletesOutsideOrganizations(storage.vectors, '@gnldev/durable: eraseSubject');
  }
  // A person in an organization: their runs, threads and working memory live in that organization's
  // partition, and the same id in another organization is somebody else.
  const runs = outside ? journal : withOrg(journal, opts.orgId!);
  const store = storage.memory && (outside ? storage.memory : withOrgStorage(storage, opts.orgId!).memory);
  // …and their documents in that organization's namespace, the one withOrgStorage writes them under.
  const vectors = storage.vectors && (outside ? storage.vectors : orgVectorDelete(storage.vectors, opts.orgId!));
  const asker = store ? ownerAsker(store) : undefined;

  // Threads first, while the owner records still exist: the ones this person owns, by the ONE question.
  const deleted: string[] = [];
  let workingMemory = 0;
  if (store) {
    const candidates = new Set<string>(await listedThreads(store, resourceId, outside));
    for (const k of (await runs.listKeys?.('thread:')) ?? []) if (k.endsWith(':owner')) candidates.add(k.slice('thread:'.length, -':owner'.length));
    for (const t of candidates) {
      if ((await threadOwnerOf(runs, asker, t)).owner === resourceId) {
        await store.deleteThread(t);
        deleted.push(t);
      }
    }
    if (await store.deleteWorkingMemory(workingMemoryScope.resource(resourceId))) workingMemory++;
  }
  let journalRows = await purgeResource(runs, resourceId, {
    ...(vectors ? { vectors } : {}),
    ...(asker ? { memory: asker } : {}),
    ...(outside ? { outsideOrganizations: true } : {}),
  });
  // A memory-store thread's journal side (observational memory, dedup window, owner record) — reached
  // here too, for a thread with no run left to lead `purgeResource` to it.
  for (const t of deleted) journalRows += await purgeThread(runs, t);
  const owner = { resourceId, ...(opts.orgId !== undefined ? { orgId: opts.orgId } : {}) };
  const workRecords = work ? await work.deleteIdPrefix!(ownedPrefix(owner)) : 0;
  const byEraser: Record<string, number> = {};
  for (const e of opts.erasers ?? []) byEraser[e.name] = (byEraser[e.name] ?? 0) + (await e.erase(owner));
  return { journalRows, workRecords, memoryThreads: deleted.length, workingMemory, byEraser };
}
