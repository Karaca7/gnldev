// Greenfield storage contracts — the SAME suite runs against both InMemoryStorage and SqliteStorage
// → concrete proof of "portability" (every storage satisfies the same contract). + composite/capability verification.
import { describe, it, expect } from 'vitest';
import { newDb } from 'pg-mem';
import { InMemoryStorage, composite, requireCapability, CapabilityError, RedisStorage, toJournal } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { makeFakeRedis } from './fake-redis.js';
import type { Storage, MessageRecord, ThreadRecord } from '../src/index.js';

const msg = (threadId: string, seq: number, text: string, embedding?: number[]): MessageRecord => ({
  threadId, seq, role: 'user', text, embedding, ts: seq, message: { role: 'user', content: text },
});
const thread = (id: string, resourceId: string, updatedAt: number): ThreadRecord => ({
  id, resourceId, createdAt: updatedAt, updatedAt,
});

// Storage matrix. exactCas=false: the storage can't model CAS's boolean return in the test environment
// (pg-mem's `ON CONFLICT DO NOTHING RETURNING` returns a row/rowCount=1 even on conflict — a pg-mem
// limitation; the code is correct for real Postgres, same pattern as PostgresJournal, verified in the
// docker integration).
// The data-level invariant (value is preserved / marker written once) is still verified on every storage.
// The memory/vectors skip decision is NOT a manual flag — it's derived from the storage's own capability
// declaration (below, in the describe setup): for PARTIAL storages declaring 'none' (Redis: memory/vectors
// ='none' → overridden via composite), that port's conformance tests are skipped.
type Caps = { exactCas: boolean };
const storages: [string, () => Storage, Caps][] = [['InMemoryStorage', () => new InMemoryStorage(), { exactCas: true }]];
try {
  const probe = new SqliteStorage();
  (probe as any).close?.();
  storages.push(['SqliteStorage', () => new SqliteStorage(':memory:'), { exactCas: true }]);
} catch {
  // node:sqlite unavailable (old Node / flag) → SQLite suite is skipped.
}
// Postgres: fresh db per test via pg-mem (in-memory real SQL).
const pgmemPool = () => { const { Pool } = newDb().adapters.createPg(); return new Pool(); };
storages.push(['PostgresStorage(pg-mem)', () => new PostgresStorage({ pool: pgmemPool() }), { exactCas: false }]);
// Redis: partial storage (runs/work/cache/meta='full/ttl'; memory/vectors='none'). Runs against a fake RedisLike;
// those two ports are skipped in the conformance suite since they're overridden via composite (capability='none' → skip).
storages.push(['RedisStorage(fake)', () => new RedisStorage({ client: makeFakeRedis() }), { exactCas: true }]);

for (const [name, make, caps] of storages) {
  // The port-skip decision comes from the storage's OWN declaration: capability 'none' (or the port not
  // existing at all) → that port's conformance tests are skipped. This makes divergence between a manual
  // flag and the declaration impossible.
  const probe = make();
  const skipMemory = probe.capabilities.memory === 'none' || probe.memory == null;
  const skipVectors = probe.capabilities.vectors === 'none' || probe.vectors == null;
  (probe as any).close?.();

  describe(`Storage contract: ${name}`, () => {
    it('RunJournal: get/put + putIfAbsent CAS', async () => {
      const b = make();
      await b.runs.put('r1:input', { a: 1 });
      expect(await b.runs.get('r1:input')).toEqual({ a: 1 });
      expect(await b.runs.putIfAbsent('claim', 1)).toBe(true);
      const second = await b.runs.putIfAbsent('claim', 2);
      if (caps.exactCas) expect(second).toBe(false);
      expect(await b.runs.get('claim')).toBe(1); // DO NOTHING → value preserved (true on every storage)
    });

    it('RunJournal: deletePrefix also wipes incrBy counters under the prefix (GDPR purge + rebuildMetrics)', async () => {
      const b = make();
      const j = b.runs;
      if (typeof j.incrBy !== 'function' || typeof j.deletePrefix !== 'function') return; // optional caps absent → contract N/A
      // Counters are keys too (deletePrefix contract, journal.ts): an org purge must not leave
      // `org:<id>:__usage__` behind, and rebuildMetrics's wipe must not keep stale `__metrics__:` counters.
      await j.incrBy('org:acme:__usage__', { runs: 3, costUsd: 1.5 });
      await j.incrBy('org:other:__usage__', { runs: 7 });
      await j.put('org:acme:r1:input', { p: 'x' }); // an ordinary key under the same prefix
      await j.deletePrefix!('org:acme:');
      expect(await j.getCounters!('org:acme:__usage__')).toBeUndefined(); // counter swept with the prefix
      expect(await j.get('org:acme:r1:input')).toBeUndefined();
      expect(await j.getCounters!('org:other:__usage__')).toEqual({ runs: 7 }); // neighbor untouched
    });

    it('RunJournal: listRuns PAGINATED + 5 distinct runs', async () => {
      const b = make();
      for (let i = 0; i < 5; i++) await b.runs.put(`run${i}:model:0`, { ok: true });
      const p1 = await b.runs.listRuns({ limit: 2 });
      expect(p1.items.length).toBe(2);
      expect(p1.nextCursor).toBeDefined();
      const p2 = await b.runs.listRuns({ limit: 2, cursor: p1.nextCursor });
      const p3 = await b.runs.listRuns({ limit: 2, cursor: p2.nextCursor });
      expect(p3.nextCursor).toBeUndefined();
      const ids = [...p1.items, ...p2.items, ...p3.items].map((r) => r.runId);
      expect(new Set(ids).size).toBe(5);
    });

    it('RunJournal: listRuns surfaces threadId + agent (from the invisible :input entry, no N+1)', async () => {
      const b = make();
      await b.runs.put('rt:input', { prompt: 'hi', threadId: 'th-9', agent: 'starwars' });
      await b.runs.put('rt:model:0', { ok: true });
      await b.runs.put('rt2:model:0', { ok: true }); // no :input → threadId/agent not printed
      const page = await b.runs.listRuns();
      const rt = page.items.find((r) => r.runId === 'rt')!;
      const rt2 = page.items.find((r) => r.runId === 'rt2')!;
      expect(rt.threadId).toBe('th-9');
      expect(rt.agent).toBe('starwars'); // agent surfaced from the SAME :input read (no extra query)
      expect(rt2.threadId).toBeUndefined();
      expect(rt2.agent).toBeUndefined();
    });

    // P0.3 (AUDIT-R2): status filter — must match summarizeRun's derivation exactly, and
    // must NOT break pagination (filter BEFORE slicing, not after — 3 completed + 2 suspended, walking
    // the completed set with limit:2 must land on exactly the 3 completed runs, no more no less).
    it('RunJournal: listRuns status filter returns only matching runs; pagination still walks correctly under the filter', async () => {
      const b = make();
      for (let i = 0; i < 3; i++) await b.runs.put(`sf-done-${i}:model:0`, { ok: true });
      for (let i = 0; i < 2; i++) {
        await b.runs.put(`sf-susp-${i}:model:0`, { ok: true });
        await b.runs.put(`sf-susp-${i}:tool:t1`, { status: 'suspended', output: {} });
      }
      const suspendedPage = await b.runs.listRuns({ status: 'suspended' });
      expect(suspendedPage.items.map((r) => r.runId).sort()).toEqual(['sf-susp-0', 'sf-susp-1']);
      expect(suspendedPage.items.every((r) => r.status === 'suspended')).toBe(true);

      // Walk the 'completed' filter with limit:2 — cursor must land on EXACTLY the 3 completed runs
      // (never a suspended one, never fewer than 3 total across the walk).
      const seen: string[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await b.runs.listRuns({ status: 'completed', limit: 2, cursor });
        seen.push(...page.items.map((r) => r.runId));
        expect(page.items.every((r) => r.status === 'completed')).toBe(true);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      expect(seen.sort()).toEqual(['sf-done-0', 'sf-done-1', 'sf-done-2']);
    });

    it('RunJournal: listRuns agent filter — exact match against RunSummary.agent, filtered before slicing', async () => {
      const b = make();
      await b.runs.put('af-a1:input', { prompt: 'x', agent: 'alpha' });
      await b.runs.put('af-a1:model:0', { ok: true });
      await b.runs.put('af-a2:input', { prompt: 'x', agent: 'alpha' });
      await b.runs.put('af-a2:model:0', { ok: true });
      await b.runs.put('af-b1:input', { prompt: 'x', agent: 'beta' });
      await b.runs.put('af-b1:model:0', { ok: true });
      await b.runs.put('af-none:model:0', { ok: true }); // no :input → no agent, must not match either filter
      const alpha = await b.runs.listRuns({ agent: 'alpha' });
      expect(alpha.items.map((r) => r.runId).sort()).toEqual(['af-a1', 'af-a2']);
      expect(alpha.items.every((r) => r.agent === 'alpha')).toBe(true);
      const beta = await b.runs.listRuns({ agent: 'beta' });
      expect(beta.items.map((r) => r.runId)).toEqual(['af-b1']);
      // combined with status: agent alpha + limit:1 must still only ever surface alpha runs across a walk.
      const p1 = await b.runs.listRuns({ agent: 'alpha', limit: 1 });
      expect(p1.items.length).toBe(1);
      expect(p1.items[0]!.agent).toBe('alpha');
      if (p1.nextCursor) {
        const p2 = await b.runs.listRuns({ agent: 'alpha', limit: 1, cursor: p1.nextCursor });
        expect(p2.items.every((r) => r.agent === 'alpha')).toBe(true);
        expect([...p1.items, ...p2.items].map((r) => r.runId).sort()).toEqual(['af-a1', 'af-a2']);
      }
    });

    it('RunJournal: readRun + gnl_runs count (running→succeeded not double-counted)', async () => {
      const b = make();
      await b.runs.put('rx:model:0', { text: 'hi' });
      await b.runs.put('rx:tool:t1', { status: 'running', startedAt: 1 });
      await b.runs.put('rx:tool:t1', { status: 'succeeded', output: 1 }); // UPSERT — must not be double-counted
      const entries = await b.runs.readRun('rx');
      expect(entries.length).toBe(2); // model + tool (tool is a single row)
      const page = await b.runs.listRuns();
      const rx = page.items.find((r) => r.runId === 'rx')!;
      expect(rx.modelSteps).toBe(1);
      expect(rx.toolCalls).toBe(1); // NOT double-counted
    });

    it('RunJournal: putIfMatch H1 — matching expected updates, mismatching leaves untouched, missing key false', async () => {
      const b = make();
      const j = b.runs as unknown as {
        get<T = unknown>(k: string): Promise<T | undefined>;
        put(k: string, v: unknown): Promise<void>;
        putIfMatch(k: string, e: unknown, v: unknown): Promise<boolean>;
      };
      // EXACTLY matches acquireRunLock's takeover pattern: write an expired LockRecord-like record,
      // read it back with get (an object that's actually gone through a superjson roundtrip) and hand
      // THAT to putIfMatch — not a synthetic object → this also proves the roundtrip stability of
      // serialize(deserialize(s)) === s (the SQLite/PG comparison is done in SQL against the stored
      // TEXT; if the roundtrip drifted, the match would fail).
      const key = 'pmr:lock';
      const stale = { owner: 'A', expires: 1000, token: 'tok-a' };
      const fresh = { owner: 'B', expires: 99_000, token: 'tok-b' };
      await j.put(key, stale);
      const cur = await j.get(key); // roundtripped expected (as run-lock does)
      expect(await j.putIfMatch(key, cur, fresh)).toBe(true); // matched → updated
      expect(await j.get(key)).toEqual(fresh);
      // Record is now fresh → stale expected no longer matches: false + value PRESERVED.
      // (pg-mem NOTE: UPDATE's affected-row count is reported faithfully — unlike the RETURNING
      // limitation above, no exactCas exemption was NEEDED here; the boolean is verified exactly on
      // every storage.)
      expect(await j.putIfMatch(key, stale, { owner: 'C', expires: 1, token: 'tok-c' })).toBe(false);
      expect(await j.get(key)).toEqual(fresh);
      // Missing key → false (never writes).
      expect(await j.putIfMatch('pmr:missing', stale, fresh)).toBe(false);
      expect(await j.get('pmr:missing')).toBeUndefined();
    });

    // P1.6b: applyBatch/getMany/countRunsByStatus are OPTIONAL Journal capabilities (see journal.ts) —
    // guarded with `typeof j.x === 'function'` skip, the SAME pattern as the incrBy/deletePrefix test above.
    it('RunJournal: applyBatch — atomic claim+incrs+puts; second identical call is a no-op', async () => {
      const b = make();
      const j = b.runs as unknown as {
        applyBatch?: (batch: { claim?: { key: string; value: unknown }; incrs?: { key: string; fields: Record<string, number> }[]; puts?: { key: string; value: unknown }[] }) => Promise<boolean>;
        getCounters?: (key: string) => Promise<Record<string, number> | undefined>;
        get<T = unknown>(key: string): Promise<T | undefined>;
      };
      if (typeof j.applyBatch !== 'function') return; // optional capability absent → contract N/A

      const batch = {
        claim: { key: 'ab:claim', value: { at: 1 } },
        incrs: [{ key: 'ab:ctr', fields: { runs: 1, tokens: 10 } }],
        puts: [{ key: 'ab:row', value: { v: 1 } }],
      };
      expect(await j.applyBatch(batch)).toBe(true);
      expect(await j.getCounters!('ab:ctr')).toEqual({ runs: 1, tokens: 10 });
      expect(await j.get('ab:row')).toEqual({ v: 1 });

      const second = await j.applyBatch(batch);
      // pg-mem (exactCas:false) NOTE: its INSERT...ON CONFLICT DO NOTHING misreports rowCount/RETURNING
      // as 1 even on a genuine conflict (verified experimentally against pg-mem directly — see
      // postgres-storage.ts applyBatch's JSDoc) — UNLIKE putIfAbsent's own conformance test above (where
      // the data invariant holds regardless of exactCas, because DO NOTHING never overwrites the SAME
      // row), applyBatch's counters/puts are SEPARATE keys gated in application code by that same
      // misreported signal — so under pg-mem specifically, the second call's incrs/puts ALSO
      // (incorrectly) re-apply. A SELECT-before-INSERT workaround would dodge this test artifact but
      // reintroduce a genuine TOCTOU race for real concurrent Postgres claims (exactly what applyBatch's
      // claim exists to prevent) — not a worthwhile trade. Real atomicity is proven in
      // integration-real.test.ts; here the whole "second call is a no-op" assertion (boolean AND
      // data-level invariant) is gated on caps.exactCas.
      if (caps.exactCas) {
        expect(second).toBe(false);
        expect(await j.getCounters!('ab:ctr')).toEqual({ runs: 1, tokens: 10 }); // NOT double-incremented
        expect(await j.get('ab:row')).toEqual({ v: 1 }); // unchanged
      }
    });

    it('RunJournal: applyBatch WITHOUT a claim always applies (both calls land)', async () => {
      const b = make();
      const j = b.runs as unknown as {
        applyBatch?: (batch: { incrs?: { key: string; fields: Record<string, number> }[] }) => Promise<boolean>;
        getCounters?: (key: string) => Promise<Record<string, number> | undefined>;
      };
      if (typeof j.applyBatch !== 'function') return;
      const r1 = await j.applyBatch({ incrs: [{ key: 'nb:ctr', fields: { n: 1 } }] });
      const r2 = await j.applyBatch({ incrs: [{ key: 'nb:ctr', fields: { n: 1 } }] });
      expect(r1).toBe(true);
      expect(r2).toBe(true);
      expect(await j.getCounters!('nb:ctr')).toEqual({ n: 2 }); // both applied — no claim to gate
    });

    it('RunJournal: getMany — order-preserving, undefined for misses', async () => {
      const b = make();
      const j = b.runs as unknown as { getMany?: <T = unknown>(keys: string[]) => Promise<(T | undefined)[]> };
      if (typeof j.getMany !== 'function') return;
      await b.runs.put('gm:a', { v: 1 });
      await b.runs.put('gm:c', { v: 3 });
      const [a, missing, c] = await j.getMany(['gm:a', 'gm:b', 'gm:c']);
      expect(a).toEqual({ v: 1 });
      expect(missing).toBeUndefined();
      expect(c).toEqual({ v: 3 });
    });

    it('RunJournal: countRunsByStatus matches a listRuns-derived count exactly (incl. a suspended run)', async () => {
      const b = make();
      const j = b.runs as unknown as { countRunsByStatus?: () => Promise<Record<string, number>> };
      if (typeof j.countRunsByStatus !== 'function') return;
      await b.runs.put('crs1:model:0', { ok: true });
      await b.runs.put('crs2:model:0', { ok: true });
      await b.runs.put('crs2:tool:t1', { status: 'suspended', output: {} }); // makes crs2 a suspended run
      await b.runs.put('crs3:model:0', { ok: true });
      const counted = await j.countRunsByStatus();
      const page = await b.runs.listRuns({ limit: 1_000_000 });
      const expected: Record<string, number> = {};
      for (const r of page.items) expected[r.status] = (expected[r.status] ?? 0) + 1;
      expect(counted).toEqual(expected);
      expect(expected.suspended).toBe(1); // sanity: the suspended run really is in there
    });

    // MemoryStore conformance is skipped for storages that don't provide the memory port (Redis).
    if (!skipMemory) {
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

    it('MemoryStore: appendMessages PER-MESSAGE IDEMPOTENT', async () => {
      const b = make();
      await Promise.all([
        b.memory!.appendMessages('t1', [msg('t1', 0, 'a'), msg('t1', 1, 'b')]),
        b.memory!.appendMessages('t1', [msg('t1', 0, 'a'), msg('t1', 1, 'b')]),
        b.memory!.appendMessages('t1', [msg('t1', 2, 'c')]),
      ]);
      const page = await b.memory!.getMessages('t1');
      expect(page.items.map((m) => m.seq)).toEqual([0, 1, 2]);
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

    } // /memory capability

    it('WorkStore: idempotent append + ackOnce CAS', async () => {
      const b = make();
      await b.work!.append('qjob', { type: 'x' }, 'j1');
      await b.work!.append('qjob', { type: 'x' }, 'j1');
      expect((await b.work!.list('qjob')).items.length).toBe(1);
      expect(await b.work!.ackOnce('ack:c1:e1')).toBe(true);
      const ack2 = await b.work!.ackOnce('ack:c1:e1');
      if (caps.exactCas) expect(ack2).toBe(false);
    });

    // 8.2 — the queue's terminal writes (qdone/qfail/qatt) rely on this for in-engine fencing (see
    // @gnl/queue createWorker: stillOwns()). EXACTLY the same shape as RunJournal's putIfMatch (H1)
    // test, adapted to WorkStore's flat key schema (no envelope → direct value comparison).
    it('WorkStore: putIfMatch — matching expected updates, mismatching (stale token) leaves untouched, missing key false', async () => {
      const b = make();
      const w = b.work as unknown as {
        get<T = unknown>(k: string): Promise<T | undefined>;
        put(k: string, v: unknown): Promise<void>;
        putIfMatch(k: string, e: unknown, v: unknown): Promise<boolean>;
      };
      const key = 'qown:job-x';
      await w.put(key, 'token-a');
      const cur = await w.get(key); // roundtripped expected (as the queue's own CAS gate does)
      expect(await w.putIfMatch(key, cur, 'token-a')).toBe(true); // matched (same owner re-confirms)
      expect(await w.get(key)).toBe('token-a');
      // Takeover simulation: another worker (e.g. claim after lock takeover) switches the key to ITS OWN
      // token — the stale worker's (still expecting 'token-a') terminal write attempt is REJECTED.
      await w.put(key, 'token-b');
      expect(await w.putIfMatch(key, 'token-a', 'STALE-WRITE-SHOULD-NOT-LAND')).toBe(false);
      expect(await w.get(key)).toBe('token-b'); // value PRESERVED — the stale write never landed
      // Missing key → false (never writes).
      expect(await w.putIfMatch('qown:missing', 'token-a', 'x')).toBe(false);
      expect(await w.get('qown:missing')).toBeUndefined();
    });

    it('CacheStore: set/get + TTL expiry + delete', async () => {
      const b = make();
      await b.cache!.set('k', 42);
      expect(await b.cache!.get('k')).toBe(42);
      await b.cache!.set('k2', 'v', { ttlMs: -1 });
      expect(await b.cache!.get('k2')).toBeUndefined();
      await b.cache!.delete('k');
      expect(await b.cache!.get('k')).toBeUndefined();
    });

    if (!skipVectors) {
    it('VectorStore: upsert + query topK', async () => {
      const b = make();
      await b.vectors!.upsert([
        { id: 'a', text: 'cats', embedding: [1, 0] },
        { id: 'b', text: 'dogs', embedding: [0, 1] },
      ]);
      const m = await b.vectors!.query([1, 0], 1);
      expect(m.map((x) => x.text)).toEqual(['cats']);
    });
    } // /vectors capability
  });
}

describe('composite + capability', () => {
  it('per-store override routes correctly + recomputes the capability matrix', async () => {
    const def = new InMemoryStorage();
    const cacheStorage = new InMemoryStorage();
    const b = composite({ default: def, overrides: { cache: cacheStorage } });
    await b.cache!.set('k', 1);
    expect(await cacheStorage.cache.get('k')).toBe(1);
    expect(await def.cache.get('k')).toBeUndefined();
    expect(b.runs).toBe(def.runs);
    expect(b.capabilities.cache).toBe('full');
  });

  it('requireCapability throws CapabilityError for a missing store', () => {
    const fake = {
      name: 'x',
      capabilities: { runs: 'full', memory: 'none', vectors: 'none', work: 'none', cache: 'none' },
      runs: new InMemoryStorage().runs,
      meta: new InMemoryStorage().meta,
    } as unknown as Storage;
    expect(() => requireCapability(fake, 'memory')).toThrow(CapabilityError);
    expect(() => requireCapability(fake, 'runs')).not.toThrow();
  });

  // Bug: toJournal was NOT forwarding optional methods (deletePrefix etc.) → studio's org-delete
  // path returned a "requires deletePrefix support" 501 (even when the underlying SqliteStorage provided it).
  it('toJournal: forwards RunJournal optional methods (deletePrefix/putIfMatch/incrBy…)', async () => {
    const s = new SqliteStorage(':memory:'); // SqliteStorage.runs provides deletePrefix/putIfMatch/incrBy
    const j = toJournal(s.runs);
    expect(typeof j.deletePrefix).toBe('function');
    expect(typeof j.putIfMatch).toBe('function');
    expect(typeof j.incrBy).toBe('function');
    // Verify it actually works: write → delete with deletePrefix → gone (studio's org-delete path).
    await j.put('org:acme:x', 1);
    await j.put('org:acme:y', 2);
    expect(await j.deletePrefix!('org:acme:')).toBe(2);
    expect(await j.get('org:acme:x')).toBeUndefined();
  });

  it('toJournal: does NOT forward an optional method the underlying RunJournal does not provide (old behavior)', () => {
    const bare = {
      get: async () => undefined, put: async () => {}, putIfAbsent: async () => true,
      listKeys: async () => [], readRun: async () => [], listRuns: async () => ({ items: [], total: 0 }),
    } as any; // NO deletePrefix
    const j = toJournal(bare);
    expect(j.deletePrefix).toBeUndefined();
  });

  // P0.3 (AUDIT-R2): toJournal's listRunsPaged bridge — a straight delegation to the
  // underlying RunJournal.listRuns(q) (unconditional, since RunJournal.listRuns is MANDATORY, unlike
  // the optional-methods loop above). Proves the filter+pagination contract survives the bridge intact.
  it('toJournal: bridges listRunsPaged straight through to RunJournal.listRuns (filters + pagination intact)', async () => {
    const storage = new InMemoryStorage();
    await storage.runs.put('tj-done:model:0', { ok: true });
    await storage.runs.put('tj-susp:model:0', { ok: true });
    await storage.runs.put('tj-susp:tool:t1', { status: 'suspended', output: {} });
    const j = toJournal(storage.runs);
    expect(typeof j.listRunsPaged).toBe('function');
    const page = await j.listRunsPaged!({ status: 'suspended' });
    expect(page.items.map((r) => r.runId)).toEqual(['tj-susp']);
    // the array bridge (listRuns()) stays legacy/unfiltered — the two methods are independent surfaces.
    expect((await j.listRuns()).map((r) => r.runId).sort()).toEqual(['tj-done', 'tj-susp']);
  });
});
