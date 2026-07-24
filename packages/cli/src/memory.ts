// DEFAULT memory for gnl dev/studio (the common "dev-server auto-provisioned LibSQL" pattern).
// @gnl/durable and @gnl/studio CANNOT import @gnl/memory (cycle); this composition layer can.
// The 'chat' preset without embeddings → semantic recall is off, no API key required; thread/message/working-memory fully work.
// NOTE: dev memory requires a MemoryStore → config must supply `storage` (e.g. SqliteStorage) (journal is not enough).
// `mem` is the caller's already project-resolved @gnl/memory module (see runtime.ts's loadMemory) —
// @gnl/memory is an optional peer dependency of @gnl/cli, resolved from the target project at runtime.
import type * as Memory from '@gnl/memory';
import type { AgentMemory } from '@gnl/memory';
import type { Storage, Journal } from '@gnl/durable';

/** createGnl.memoryFactory: derives a writable Memory from storage (so Playground runs get written to a thread). */
export function devMemoryFactory(mem: typeof Memory): (storage: Storage | Journal) => AgentMemory {
  return (storage) => mem.memoryPreset(storage as Storage, 'chat');
}

/** createStudioApp.memory VIEW adapter (list/read) — from storage. Pattern from examples/app. */
export function devStudioMemory(mem: typeof Memory, storage: Storage) {
  const m = mem.memoryPreset(storage, 'chat');
  return {
    listThreads: (rid?: string) => (rid ? m.listThreads({ resourceId: rid }) : m.listAllThreads()),
    getMessages: (tid: string) => m.getMessages(tid),
    getWorkingMemory: (tid: string) => m.getWorkingMemory(tid),
    updateThread: (tid: string, patch: { title?: string; metadata?: Record<string, unknown> }) => m.updateThread(tid, patch),
    deleteThread: (tid: string) => m.deleteThread(tid),
  };
}
