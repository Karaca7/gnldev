// DEFAULT memory for gnl dev/studio (the common "dev-server auto-provisioned LibSQL" pattern).
// @gnldev/durable and @gnldev/studio CANNOT import @gnldev/memory (cycle); this composition layer can.
// The 'chat' preset without embeddings → semantic recall is off, no API key required; thread/message/working-memory fully work.
// NOTE: dev memory requires a MemoryStore → config must supply `storage` (e.g. SqliteStorage) (journal is not enough).
// `mem` is the caller's already project-resolved @gnldev/memory module (see runtime.ts's loadMemory) —
// @gnldev/memory is an optional peer dependency of @gnldev/cli, resolved from the target project at runtime.
import type * as Memory from '@gnldev/memory';
import type { AgentMemory } from '@gnldev/memory';
import type { Storage, Journal } from '@gnldev/durable';

/** createGnl.memoryFactory: derives a writable Memory from storage (so Playground runs get written to a thread). */
export function devMemoryFactory(mem: typeof Memory): (storage: Storage | Journal) => AgentMemory {
  return (storage) => mem.memoryPreset(storage as Storage, 'chat');
}

/** createStudioApp.memory VIEW adapter (list/read) — from storage. Pattern from examples/app. */
export function devStudioMemory(mem: typeof Memory, storage: Storage) {
  const m = mem.memoryPreset(storage, 'chat');
  return {
    // The two listings stay SEPARATE, matching `Memory.listThreads`/`listAllThreads`. Collapsing them
    // into one string-taking method is what made Studio's `?resourceId=` filter inert for a host that
    // passed AgentMemory directly: the string landed where an `{ resourceId }` object was read, so the
    // store was asked for every thread and answered with every user's.
    listThreads: (opts: { resourceId: string }) => m.listThreads(opts),
    listAllThreads: () => m.listAllThreads(),
    getMessages: (tid: string) => m.getMessages(tid),
    getWorkingMemory: (tid: string) => m.getWorkingMemory(tid),
    updateThread: (tid: string, patch: { title?: string; metadata?: Record<string, unknown> }) => m.updateThread(tid, patch),
    deleteThread: (tid: string) => m.deleteThread(tid),
    truncateMessages: (tid: string, afterIndex: number) => m.truncateMessagesAfter(tid, afterIndex),
  };
}
