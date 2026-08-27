// The MemoryStore conformance cases, extracted so they can run against MORE THAN ONE engine.
//
// They used to live inline in storage-backend.test.ts and ran against pg-mem as the Postgres double.
// That stopped: pg-mem has no `pg_advisory_xact_lock`, so PostgresStorage now withdraws the memory
// port there rather than pretend it can serialise appends — which is honest, and which silently took
// every Postgres memory case out of the default suite with it. `recall`, `messageRange`, the filter
// operators and `deleteMessagesAfter` all have Postgres-specific SQL, and losing their coverage to a
// capability declaration would be the same false comfort the declaration exists to remove.
//
// So the cases moved here and are called twice: by the conformance matrix for the engines that still
// declare the port, and by integration-real.test.ts against a real server, where Postgres gets its
// coverage back for real rather than through a double.
import { it, expect } from 'vitest';
import type { Storage, MessageRecord, ThreadRecord } from '../src/index.js';

const msg = (threadId: string, seq: number, text: string, embedding?: number[]): MessageRecord => ({
  threadId, seq, role: 'user', text, embedding, ts: seq, message: { role: 'user', content: text },
});
const thread = (id: string, resourceId: string, updatedAt: number): ThreadRecord => ({
  id, resourceId, createdAt: updatedAt, updatedAt,
});

/** `serialisesAppends` false = this engine cannot order two concurrent appends (pg-mem). */
export function memoryConformance(make: () => Storage, caps: { serialisesAppends: boolean }): void {
    it('MemoryStore: thread upsert + listThreads (resource filter + DESC + paginated)', async () => {
      const b = make();
      await b.memory!.upsertThread(thread('t1', 'u1', 100));
      await b.memory!.upsertThread(thread('t2', 'u1', 300));
      await b.memory!.upsertThread(thread('t3', 'u2', 200));
      const u1 = await b.memory!.listThreads({ resourceId: 'u1' });
      expect(u1.items.map((t) => t.id)).toEqual(['t2', 't1']);
      const all = await b.memory!.listThreads({ limit: 2 });
      expect(all.items.length).toBe(2);
      expect(all.nextCursor).toBeDefined();
    });

    // NOTE what this proves and what it does not. Every batch here carries EXPLICIT, pre-arranged
    // positions that cannot collide, so it exercises the replay case — the same rows written twice
    // collapse to one. It says nothing about two callers appending DIFFERENT messages at once, which
    // is the case that was losing a third of all messages in production. That is the next test.
    it('MemoryStore: appendMessages PER-MESSAGE IDEMPOTENT (explicit seq = replay)', async () => {
      const b = make();
      await Promise.all([
        b.memory!.appendMessages('t1', [msg('t1', 0, 'a'), msg('t1', 1, 'b')]),
        b.memory!.appendMessages('t1', [msg('t1', 0, 'a'), msg('t1', 1, 'b')]),
        b.memory!.appendMessages('t1', [msg('t1', 2, 'c')]),
      ]);
      const page = await b.memory!.getMessages('t1');
      expect(page.items.map((m) => m.seq)).toEqual([0, 1, 2]);
    });

    // The store-assigned path. Until this existed, NO test in the repo reached it: every caller in the
    // suite supplied `seq`, so the branch that takes the per-thread lock and reads the tail was dead
    // code as far as CI was concerned, and a green suite said nothing about the defect it fixes.
    it('MemoryStore: assigns seq itself when omitted', async () => {
      const b = make();
      const append = (text: string) => b.memory!.appendMessages('t1', [
        { threadId: 't1', role: 'user', text, ts: 1, message: { role: 'user', content: text } },
      ]);
      await append('a'); await append('b'); await append('c');
      const page = await b.memory!.getMessages('t1');
      expect(page.items.map((m) => m.seq)).toEqual([0, 1, 2]);
      expect(page.items.map((m) => m.text)).toEqual(['a', 'b', 'c']);
    });

    it.skipIf(!caps.serialisesAppends)('MemoryStore: loses nothing when callers race', async () => {
      const b = make();
      const append = (text: string) => b.memory!.appendMessages('t1', [
        { threadId: 't1', role: 'user', text, ts: 1, message: { role: 'user', content: text } },
      ]);
      await Promise.all([append('a'), append('b'), append('c'), append('d')]);

      const page = await b.memory!.getMessages('t1');
      // Four distinct messages, four distinct positions, densely packed from zero. Under the old
      // caller-assigned scheme these four raced for one position and only one survived.
      expect(page.items.map((m) => m.seq)).toEqual([0, 1, 2, 3]);
      expect(page.items.map((m) => m.text).sort()).toEqual(['a', 'b', 'c', 'd']);
    });

    it('MemoryStore: refuses a batch that mixes supplied and omitted seq', async () => {
      const b = make();
      // Measured to lose a row silently INSIDE the transaction: the store computes the next free
      // position, the explicit row in the same batch already claims it, and one of the two is dropped.
      await expect(b.memory!.appendMessages('t1', [
        msg('t1', 2, 'explicit'),
        { threadId: 't1', role: 'user', text: 'implicit', ts: 1, message: { role: 'user', content: 'implicit' } },
      ])).rejects.toThrow(/every row or on none/);
    });

    it('MemoryStore: recall thread + resource scope + threshold', async () => {
      const b = make();
      await b.memory!.upsertThread(thread('t1', 'u1', 1));
      await b.memory!.upsertThread(thread('t2', 'u1', 1));
      await b.memory!.appendMessages('t1', [msg('t1', 0, 'cats', [1, 0]), msg('t1', 1, 'dogs', [0, 1])]);
      await b.memory!.appendMessages('t2', [msg('t2', 0, 'felines', [0.9, 0.1])]);
      const r1 = await b.memory!.recall('t1', [1, 0], { topK: 1, scope: 'thread' });
      expect(r1.map((m) => m.text)).toEqual(['cats']);
      const r2 = await b.memory!.recall('t1', [1, 0], { topK: 2, scope: 'resource', resourceId: 'u1' });
      expect(r2.map((m) => m.text).sort()).toEqual(['cats', 'felines']);
    });

    // P1.5 (AUDIT-R2): messageRange expands EACH hit with its before/after neighbors BY SEQ
    // within the thread, dedups overlapping windows, returns the union in seq order (hits included).
    // Verifies in-memory/sqlite/postgres-storage's shared expansion logic (already present pre-P1.5;
    // this test is new coverage, not a behavior change).
    it('MemoryStore: recall messageRange expands + dedups overlapping windows, seq order', async () => {
      const b = make();
      await b.memory!.upsertThread(thread('t1', 'u1', 1));
      // seq 2 and 5 match the query ([1,0], score 1); every other seq is orthogonal (score 0 → excluded).
      const rows = Array.from({ length: 10 }, (_, seq) => msg('t1', seq, `m${seq}`, seq === 2 || seq === 5 ? [1, 0] : [0, 1]));
      await b.memory!.appendMessages('t1', rows);
      const r = await b.memory!.recall('t1', [1, 0], { topK: 2, messageRange: { before: 1, after: 2 } });
      // hit@2 window = seq[1..4], hit@5 window = seq[4..7] → union deduped at seq4, ASC seq order.
      expect(r.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });

    // P1.5 (AUDIT-R2): filter operators ($eq sugar/$in/$gt) + "filter runs BEFORE topK" — a
    // filtered-out message must NOT consume a topK slot (the crowding-out regression this guards against:
    // naively slicing topK first then filtering would silently return fewer than topK, or none).
    it('MemoryStore: recall filter operators ($eq/$in/$gt), filtered-out hits do not consume topK slots', async () => {
      const b = make();
      await b.memory!.upsertThread(thread('t1', 'u1', 1));
      await b.memory!.appendMessages('t1', [
        { ...msg('t1', 0, 'A', [1, 0]), metadata: { lang: 'en', tier: 1, priority: 1 } }, // score 1.0 — highest, but lang 'en' (filtered out below)
        { ...msg('t1', 1, 'B', [0.8, 0.6]), metadata: { lang: 'tr', tier: 2, priority: 5 } }, // score 0.8 — lang 'tr'
        { ...msg('t1', 2, 'C', [0.6, 0.8]), metadata: { lang: 'tr', tier: 3, priority: 9 } }, // score 0.6 — lang 'tr'
      ]);

      // topK:1 + {lang:'tr'} (bare-value $eq sugar): A (score 1.0, highest) is filtered OUT before topK
      // selection → the slot goes to B (score 0.8), NOT an empty result.
      const eq = await b.memory!.recall('t1', [1, 0], { topK: 1, filter: { lang: 'tr' } });
      expect(eq.map((m) => m.text)).toEqual(['B']);

      // $in: tier ∈ {1, 3} → A and C (not B).
      const inOp = await b.memory!.recall('t1', [1, 0], { topK: 5, filter: { tier: { $in: [1, 3] } } });
      expect(inOp.map((m) => m.text).sort()).toEqual(['A', 'C']);

      // $gt: priority > 4 → B and C (not A).
      const gtOp = await b.memory!.recall('t1', [1, 0], { topK: 5, filter: { priority: { $gt: 4 } } });
      expect(gtOp.map((m) => m.text).sort()).toEqual(['B', 'C']);
    });

    it('MemoryStore: working memory + observations', async () => {
      const b = make();
      await b.memory!.setWorkingMemory('t1', { plan: 'x' });
      expect(await b.memory!.getWorkingMemory('t1')).toEqual({ plan: 'x' });
      await b.memory!.putObservations('t1', [{ id: 'o1', text: 'obs', createdAt: 1, sourceIds: [], level: 0 }]);
      expect((await b.memory!.getObservations('t1')).map((o) => o.text)).toEqual(['obs']);
    });

    // FLOW-10 (optional capability): deleteMessagesAfter — same "typeof … === 'function'" skip
    // pattern as applyBatch/deletePrefix above. Currently only InMemoryStorage implements this; the
    // guard means the test is N/A (not failing) on storages that haven't added it yet, and starts
    // exercising them automatically once they do — no test-file change needed on their side.
    it('MemoryStore: deleteMessagesAfter — truncates the tail by seq (exclusive), keeps the anchor + before', async () => {
      const b = make();
      if (typeof b.memory!.deleteMessagesAfter !== 'function') return; // optional capability absent → N/A
      await b.memory!.upsertThread(thread('t1', 'u1', 1));
      await b.memory!.appendMessages('t1', [msg('t1', 0, 'a'), msg('t1', 1, 'b'), msg('t1', 2, 'c'), msg('t1', 3, 'd')]);

      const removed = await b.memory!.deleteMessagesAfter!('t1', 1);
      expect(removed).toBe(2); // seq 2 and 3 removed

      const page = await b.memory!.getMessages('t1');
      expect(page.items.map((m) => m.seq)).toEqual([0, 1]); // anchor (1) and everything before it kept, in order
    });

    it('MemoryStore: deleteMessagesAfter — unknown thread and out-of-range seq are no-ops (0, never throws)', async () => {
      const b = make();
      if (typeof b.memory!.deleteMessagesAfter !== 'function') return;
      // Unknown thread → 0, no throw.
      await expect(b.memory!.deleteMessagesAfter!('does-not-exist', 0)).resolves.toBe(0);

      await b.memory!.upsertThread(thread('t2', 'u1', 1));
      await b.memory!.appendMessages('t2', [msg('t2', 0, 'a'), msg('t2', 1, 'b')]);

      // afterSeq at/above the highest existing seq → nothing to remove.
      expect(await b.memory!.deleteMessagesAfter!('t2', 1)).toBe(0);
      expect(await b.memory!.deleteMessagesAfter!('t2', 99)).toBe(0);
      expect((await b.memory!.getMessages('t2')).items.map((m) => m.seq)).toEqual([0, 1]);

      // afterSeq below the lowest existing seq → removes everything.
      const removedAll = await b.memory!.deleteMessagesAfter!('t2', -1);
      expect(removedAll).toBe(2);
      expect((await b.memory!.getMessages('t2')).items).toEqual([]);
    });

}
