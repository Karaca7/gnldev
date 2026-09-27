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

export const threadOwnerKey = (threadId: string): string => `thread:${threadId}:owner`;

export interface ThreadOwnership {
  /** Whether the thread exists at all. A thread that does not exist yet is the first caller's to open. */
  exists: boolean;
  /** Its owner. Absent on an existing thread means nobody owns it: it is staff's. */
  owner?: string;
}

/** The one answer to "whose thread is this". Read errors propagate: not knowing is not permission. */
export async function threadOwnerOf(journal: Journal, memory: Memory | undefined, threadId: string): Promise<ThreadOwnership> {
  const rec = await journal.get<{ resourceId?: string }>(threadOwnerKey(threadId));
  if (rec !== undefined) return { exists: true, ...(rec.resourceId ? { owner: rec.resourceId } : {}) };
  // Older threads, from before the record: the memory's own answer, then the runs, then the messages.
  if (memory?.getThreadResource) {
    const owner = await memory.getThreadResource(threadId);
    if (owner) return { exists: true, owner };
  }
  const runs = await runsOnThread(journal, threadId);
  if (runs.length) {
    const owners = new Set(runs.map((r) => r.resourceId));
    return { exists: true, ...(owners.size === 1 && [...owners][0] ? { owner: [...owners][0]! } : {}) };
  }
  // Messages with no owner anywhere: the thread exists and is nobody's. Asked only of a memory that
  // cannot name owners — one that can is the authority on its own threads, and what `getMessages`
  // answers for an unknown id is not part of the Memory contract (a double answering for any id would
  // otherwise refuse every first turn).
  if (memory && !memory.getThreadResource && ((await memory.getMessages(threadId)) ?? []).length > 0) return { exists: true };
  return { exists: false };
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
 * The engine's thread gate, for every door that starts a run on a thread: a new thread is claimed for
 * `resourceId` (or for nobody, when the run names nobody), an existing one must be `resourceId`'s.
 * Claiming here rather than after the run starts closes the race where two callers open the same new
 * thread at once: the claim has one winner, and the loser is held to it.
 *
 * An existing thread with NO owner is let through: the engine cannot tell staff from an end user.
 * The server's gate, which can, refuses it to anyone who is not staff.
 */
export async function admitThreadRun(journal: Journal, memory: Memory | undefined, threadId: string, resourceId: string | undefined): Promise<void> {
  let o = await threadOwnerOf(journal, memory, threadId);
  if (!o.exists) {
    await claim(journal, threadOwnerKey(threadId), { at: Date.now(), ...(resourceId ? { resourceId } : {}) });
    const rec = await journal.get<{ resourceId?: string }>(threadOwnerKey(threadId));
    o = { exists: true, ...(rec?.resourceId ? { owner: rec.resourceId } : {}) };
  }
  if (resourceId && o.owner && o.owner !== resourceId) {
    throw new ThreadOwnerMismatchError(
      `@gnldev/durable: thread "${threadId}" belongs to a different resourceId — this run names "${resourceId}".`,
      { threadId, owner: o.owner, requested: resourceId },
    );
  }
}
