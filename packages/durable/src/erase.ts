/**
 * ONE erasure for a person: runs, threads, documents, queued jobs, triggers and events.
 *
 * It can be one call because the owner is recorded in ONE shape everywhere it is not a run record:
 * in the NAME the engine writes (`ownedName`, `~o~<org>:<user>:<name>`). A job, an event and a
 * trigger owned by this person all carry the same id prefix, so the stores can find them without
 * knowing what a job or a trigger is. Runs, threads and documents are erased by `purgeResource`,
 * whose thread question is `threadOwnerOf` — the same one the gate and the listing ask.
 */
import { purgeResource } from './retention.js';
import { ownedPrefix } from './owned-name.js';
import { threadOwnerOf } from './thread-owner.js';
import type { Journal } from './journal.js';
import type { Memory } from './memory.js';
import type { VectorStore, WorkStore } from './storage.js';

/** Trigger key families of @gnldev/scheduler, all keyed by the (owned) trigger id. */
const TRIGGER_FAMILIES = ['sched:def:', 'sched:state:', 'sched:fail:', 'sched:budget-skip:', 'sched:busy-skip:'];

export interface EraseTarget {
  journal: Journal;
  /** Jobs and events. Needs `deleteIdPrefix`: an erasure that cannot reach them refuses, loudly. */
  work?: WorkStore;
  vectors?: Pick<VectorStore, 'delete'>;
  /** A memory whose threads live outside the journal (e.g. AgentMemory over storage.memory). */
  memory?: Memory & { deleteThread?: (id: string) => Promise<void> };
}

export interface EraseReport {
  journalRows: number;
  triggers: number;
  jobsAndEvents: number;
  memoryThreads: number;
}

export async function eraseSubject(target: EraseTarget, resourceId: string, opts: { orgId?: string } = {}): Promise<EraseReport> {
  const del = target.journal.deletePrefix;
  if (typeof del !== 'function') throw new Error('@gnldev/durable: eraseSubject needs a journal that can deletePrefix');
  if (target.work && typeof target.work.deleteIdPrefix !== 'function') {
    throw new Error('@gnldev/durable: eraseSubject was given a work store that cannot delete by id prefix, so this person\'s jobs and events cannot be erased');
  }
  // Threads first, while the owner records still exist: the ones this person owns, by the ONE question.
  let memoryThreads = 0;
  if (target.memory?.deleteThread) {
    const candidates = new Set<string>();
    for (const r of (await target.memory.listThreads?.({ resourceId })) ?? []) candidates.add(String((r as { id?: unknown }).id));
    for (const k of (await target.journal.listKeys?.('thread:')) ?? []) if (k.endsWith(':owner')) candidates.add(k.slice('thread:'.length, -':owner'.length));
    for (const t of candidates) {
      if ((await threadOwnerOf(target.journal, target.memory, t)).owner === resourceId) {
        await target.memory.deleteThread(t);
        memoryThreads++;
      }
    }
  }
  const journalRows = await purgeResource(target.journal, resourceId, { ...(target.vectors ? { vectors: target.vectors } : {}), ...(target.memory ? { memory: target.memory } : {}) });
  const prefix = ownedPrefix({ ...(opts.orgId !== undefined ? { orgId: opts.orgId } : {}), resourceId });
  let triggers = 0;
  for (const fam of TRIGGER_FAMILIES) triggers += await del.call(target.journal, `${fam}${prefix}`);
  const jobsAndEvents = target.work ? await target.work.deleteIdPrefix!(prefix) : 0;
  return { journalRows, triggers, jobsAndEvents, memoryThreads };
}
