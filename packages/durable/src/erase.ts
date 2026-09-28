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
 */
import { purgeResource } from './retention.js';
import { ownedPrefix } from './owned-name.js';
import { threadOwnerOf } from './thread-owner.js';
import { withOrg } from './organization.js';
import { orgVectorDelete } from './org-storage.js';
import type { Journal } from './journal.js';
import type { Memory } from './memory.js';
import type { VectorStore, WorkStore } from './storage.js';

/** One package's share of a person's erasure (`jobEraser`, `triggerEraser`, `eventEraser`). */
export interface SubjectEraser {
  name: string;
  erase(owner: { resourceId: string; orgId?: string }): Promise<number>;
}

export interface EraseTarget {
  /** The ROOT journal. With `orgId`, the person's runs are erased in that organization's partition. */
  journal: Journal;
  /** Owned log records (jobs and events). Needs `deleteIdPrefix`: an erasure that cannot reach them refuses, loudly. */
  work?: WorkStore;
  vectors?: Pick<VectorStore, 'delete'>;
  /** A memory whose threads live outside the journal (e.g. AgentMemory over storage.memory). */
  memory?: Memory & { deleteThread?: (id: string) => Promise<void> };
  /** The background packages' erasers: `jobEraser(storage)`, `triggerEraser(journal)`, `eventEraser(work)`. */
  erasers?: SubjectEraser[];
}

export interface EraseReport {
  journalRows: number;
  /** Owned log records (jobs, events, their depth-index records) found by id prefix. */
  workRecords: number;
  memoryThreads: number;
  /** What each eraser removed, by its name. */
  byEraser: Record<string, number>;
}

export async function eraseSubject(target: EraseTarget, resourceId: string, opts: { orgId?: string } = {}): Promise<EraseReport> {
  if (typeof resourceId !== 'string' || resourceId === '') throw new TypeError('@gnldev/durable: eraseSubject needs the id of the person to erase');
  const del = target.journal.deletePrefix;
  if (typeof del !== 'function') throw new Error('@gnldev/durable: eraseSubject needs a journal that can deletePrefix');
  if (target.work && typeof target.work.deleteIdPrefix !== 'function') {
    throw new Error('@gnldev/durable: eraseSubject was given a work store that cannot delete by id prefix, so this person\'s jobs and events cannot be erased');
  }
  // A person in an organization: their runs live in that organization's partition, and the same id in
  // another organization is somebody else.
  const runs = opts.orgId !== undefined ? withOrg(target.journal, opts.orgId) : target.journal;
  // …and their documents in that organization's namespace, the one withOrgStorage writes them under.
  const vectors = target.vectors && opts.orgId !== undefined && target.vectors.delete ? orgVectorDelete(target.vectors, opts.orgId) : target.vectors;
  // Threads first, while the owner records still exist: the ones this person owns, by the ONE question.
  let memoryThreads = 0;
  if (target.memory?.deleteThread) {
    const candidates = new Set<string>();
    for (const r of (await target.memory.listThreads?.({ resourceId })) ?? []) candidates.add(String((r as { id?: unknown }).id));
    for (const k of (await runs.listKeys?.('thread:')) ?? []) if (k.endsWith(':owner')) candidates.add(k.slice('thread:'.length, -':owner'.length));
    for (const t of candidates) {
      if ((await threadOwnerOf(runs, target.memory, t)).owner === resourceId) {
        await target.memory.deleteThread(t);
        memoryThreads++;
      }
    }
  }
  const journalRows = await purgeResource(runs, resourceId, {
    ...(vectors ? { vectors } : {}),
    ...(target.memory ? { memory: target.memory } : {}),
    ...(opts.orgId === undefined ? { outsideOrganizations: true } : {}),
  });
  const owner = { resourceId, ...(opts.orgId !== undefined ? { orgId: opts.orgId } : {}) };
  const workRecords = target.work ? await target.work.deleteIdPrefix!(ownedPrefix(owner)) : 0;
  const byEraser: Record<string, number> = {};
  for (const e of target.erasers ?? []) byEraser[e.name] = (byEraser[e.name] ?? 0) + (await e.erase(owner));
  return { journalRows, workRecords, memoryThreads, byEraser };
}
