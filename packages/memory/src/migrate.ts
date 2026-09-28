/**
 * Moving working memory 0.6.0 wrote to the keys 0.7 reads.
 *
 * 0.6.0's AgentMemory kept a person's working memory under `res:<resourceId>` and a thread's under the
 * bare thread id. 0.7 reads `workingMemoryScope.resource(id)` / `workingMemoryScope.thread(id)` only,
 * so after an upgrade the old records are still stored and no longer shown to the model. (Erasure and
 * thread deletion remove them either way — `legacyWorkingMemoryScope` in @gnldev/durable.)
 */
import { legacyWorkingMemoryScope, workingMemoryScope, type MemoryStore } from '@gnldev/durable';

export interface MigrateWorkingMemoryOptions {
  /** The people whose `res:<id>` record to move. Omitted: every owner of a thread the store lists. */
  resourceIds?: string[];
  /** The threads whose bare-id record to move. Omitted: every thread the store lists. */
  threadIds?: string[];
}

export interface MigrateWorkingMemoryReport {
  /** 0.6 keys moved to their 0.7 key and removed. */
  moved: string[];
  /** 0.6 keys left in place because the 0.7 key already held a (newer) value — which is kept, never overwritten. */
  kept: string[];
  /**
   * Thread ids whose bare key holds a record but is ambiguous — it begins `thread:`, `resource:` or
   * `res:`, so it is, or could be, a person's record or a 0.7 one: not touched. Decide by hand.
   */
  skipped: string[];
}

/**
 * Moves each 0.6 working-memory record to its 0.7 key, without overwriting a value already there.
 * Idempotent: a second run moves nothing.
 *
 * `store` is the memory store the records live in. For an organization, pass its view
 * (`withOrgStorage(storage, orgId).memory`): the `org:<id>:` prefix is that view's to add, so each
 * organization is migrated on its own and none reaches another's records.
 */
export async function migrateWorkingMemoryKeys(store: MemoryStore, opts: MigrateWorkingMemoryOptions = {}): Promise<MigrateWorkingMemoryReport> {
  let threadIds = opts.threadIds;
  let resourceIds = opts.resourceIds;
  if (threadIds === undefined || resourceIds === undefined) {
    const threads: Array<{ id: string; resourceId: string }> = [];
    let cursor: string | undefined;
    do {
      const page = await store.listThreads({ limit: 500, ...(cursor !== undefined ? { cursor } : {}) });
      threads.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    threadIds ??= threads.map((t) => t.id);
    resourceIds ??= [...new Set(threads.map((t) => t.resourceId))];
  }
  const report: MigrateWorkingMemoryReport = { moved: [], kept: [], skipped: [] };
  const move = async (from: string, to: string) => {
    const value = await store.getWorkingMemory(from);
    if (value === undefined) return;
    if ((await store.getWorkingMemory(to)) !== undefined) {
      report.kept.push(from);
      return;
    }
    await store.setWorkingMemory(to, value);
    await store.deleteWorkingMemory(from);
    report.moved.push(from);
  };
  for (const id of new Set(resourceIds)) await move(legacyWorkingMemoryScope.resource(id), workingMemoryScope.resource(id));
  for (const id of new Set(threadIds)) {
    const from = legacyWorkingMemoryScope.thread(id);
    if (from === undefined) {
      if ((await store.getWorkingMemory(id)) !== undefined) report.skipped.push(id);
      continue;
    }
    await move(from, workingMemoryScope.thread(id));
  }
  return report;
}
