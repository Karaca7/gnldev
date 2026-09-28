/**
 * Who owns a thread — asked in ONE place, answered from a RECORD.
 *
 * A thread's owner used to be re-derived at every door: from the memory when it could name one
 * (`getThreadResource`), otherwise from whichever runs on the thread were still in the journal. Seven
 * call sites asked seven slightly different ways, and the derivation was not an owner, it was a
 * guess that moved:
 *  - the engine's own gate asked only a memory that could answer, so with `BasicMemory` a second
 *    user's run on the first user's thread went through, and the model was handed her history
 *    (the standalone chat and AG-UI routes rely on exactly that gate);
 *  - once a retention sweep removed the owner's runs, the thread had "no runs", read as "new", and
 *    the next caller became its owner — with the old messages still in it;
 *  - one foreign run on the thread made the derivation ambiguous, locking the owner out, and her
 *    messages were then deleted with the other person's account.
 *
 * So the first run on a thread writes `thread:<threadId>:owner`, first write wins, and the owner does
 * not move after that. It sits under the `thread:` root (reserved: no run id may start with it), next
 * to the thread's taint records, inside the organization prefix like every other thread key.
 *
 * A thread written before this record existed is still read the old way, and one step more strictly:
 * in a memory that cannot name owners, a thread with messages and no owner anywhere is NOT new. It
 * exists and nobody owns it — staff's.
 */
import { claim } from './journal.js';
import type { Journal, JournalReader, RunSummary } from './journal.js';
import type { Memory } from './memory.js';
import { ThreadOwnerMismatchError } from './errors.js';
import type { Caller } from './identity-types.js';

export const threadOwnerKey = (threadId: string): string => `thread:${threadId}:owner`;

export interface ThreadOwnership {
  /** Whether the thread exists at all. A thread that does not exist yet is the first caller's to open. */
  exists: boolean;
  /** Its owner. */
  owner?: string;
  /**
   * An existing thread with no owner: `true` when staff CLAIMED it (a record says so — nobody else
   * may join), `false` when it only has anonymous history (the first named user claims it).
   */
  staffClaimed?: boolean;
}

type ThreadOwnerRecord = { resourceId?: string; ownerKind?: 'staff' | 'unknown'; at?: number };

/**
 * The one answer to "whose thread is this" — for the gate, the listing, the reading and the
 * erasure alike. Read errors propagate: not knowing is not permission.
 *
 * The RECORD wins, with one exception: an ownerless record never overrides a memory that names the
 * owner (the record is upgraded to that owner). A legacy thread's derived owner is WRITTEN to the
 * record the first time it is read, so a later runs sweep cannot move it.
 */
export async function threadOwnerOf(journal: Journal, memory: Memory | undefined, threadId: string): Promise<ThreadOwnership> {
  const key = threadOwnerKey(threadId);
  const rec = await journal.get<ThreadOwnerRecord>(key);
  if (rec !== undefined) {
    if (rec.resourceId) return { exists: true, owner: rec.resourceId };
    if (memory?.getThreadResource) {
      const owner = await memory.getThreadResource(threadId);
      if (owner) {
        await journal.put(key, { ...rec, resourceId: owner, upgradedAt: Date.now() });
        return { exists: true, owner };
      }
    }
    return { exists: true, staffClaimed: rec.ownerKind !== 'unknown' };
  }
  // Older threads, from before the record: the memory's own answer, then the runs, then the messages.
  let derived: string | undefined;
  let exists = false;
  if (memory?.getThreadResource) {
    derived = await memory.getThreadResource(threadId);
    exists = derived !== undefined;
  }
  if (!exists) {
    const runs = await runsOnThread(journal, threadId);
    if (runs.length) {
      exists = true;
      const owners = new Set(runs.map((r) => r.resourceId));
      if (owners.size === 1 && [...owners][0]) derived = [...owners][0]!;
    }
  }
  // Messages with no owner anywhere: the thread exists and is nobody's (anonymous history). Asked only
  // of a memory that cannot name owners — one that can is the authority on its own threads.
  if (!exists && memory && !memory.getThreadResource && ((await memory.getMessages(threadId)) ?? []).length > 0) exists = true;
  if (derived) {
    // LAZY BACKFILL: the derived owner becomes the record, first write wins.
    await claim(journal, key, { at: Date.now(), resourceId: derived, backfilled: true });
    const now = await journal.get<ThreadOwnerRecord>(key);
    return { exists: true, ...(now?.resourceId ? { owner: now.resourceId } : { staffClaimed: true }) };
  }
  return exists ? { exists: true, staffClaimed: false } : { exists: false };
}

/**
 * Every run on a thread. Two shapes reach here: a Journal's `listRuns` answers an array; a storage
 * `RunJournal`'s answers one page, so it is walked to the end — a thread's runs past the first page
 * are exactly the ones a partial read would miss.
 */
async function runsOnThread(journal: Journal, threadId: string): Promise<RunSummary[]> {
  const list = (journal as Partial<JournalReader> & { listRuns?: (q?: { cursor?: string; limit?: number }) => Promise<unknown> }).listRuns;
  if (typeof list !== 'function') return [];
  const first = await list.call(journal);
  if (Array.isArray(first)) return (first as RunSummary[]).filter((r) => r.threadId === threadId);
  const out: RunSummary[] = [];
  let page = first as { items: RunSummary[]; nextCursor?: string };
  for (;;) {
    out.push(...page.items.filter((r) => r.threadId === threadId));
    if (!page.nextCursor) return out;
    page = (await list.call(journal, { cursor: page.nextCursor })) as typeof page;
  }
}

/**
 * The engine's thread gate, for every door that starts a run on a thread. Returns the thread's
 * ownership after the gate (the run adopts a thread owner from THIS answer, not from memory).
 *
 *  - no thread yet: a user claims it; staff claims it ownerless; `unknown` claims nothing (an
 *    anonymous first turn does not pin the thread ownerless forever);
 *  - owned: only that user, or staff; `unknown` is refused (closed);
 *  - staff-claimed: staff only;
 *  - anonymous history, no record: the first named user claims it; staff and unknown pass.
 */
export async function admitThreadRun(journal: Journal, memory: Memory | undefined, threadId: string, caller: Caller): Promise<ThreadOwnership> {
  let o = await threadOwnerOf(journal, memory, threadId);
  const claimFor = async (fields: ThreadOwnerRecord) => {
    await claim(journal, threadOwnerKey(threadId), { at: Date.now(), ...fields });
    const rec = await journal.get<ThreadOwnerRecord>(threadOwnerKey(threadId));
    return rec?.resourceId ? { exists: true, owner: rec.resourceId } : { exists: true, staffClaimed: rec?.ownerKind !== 'unknown' };
  };
  if (!o.exists || (o.owner === undefined && o.staffClaimed === false)) {
    if (caller.kind === 'user') o = await claimFor({ resourceId: caller.id });
    else if (caller.kind === 'staff' && !o.exists) o = await claimFor({ ownerKind: 'staff' });
    else return o;
  }
  const refuse = (requested: string) => {
    throw new ThreadOwnerMismatchError(
      `@gnldev/durable: thread "${threadId}" belongs to ${o.owner ? 'a different resourceId' : 'staff'} — this run names "${requested}".`,
      { threadId, owner: o.owner ?? '(staff)', requested },
    );
  };
  if (caller.kind === 'staff') return o;
  if (caller.kind === 'unknown') return o.owner || o.staffClaimed ? refuse('(unknown)') : o;
  if (o.owner ? o.owner !== caller.id : o.staffClaimed) refuse(caller.id);
  return o;
}
