// REAL backend integration — runs against the docker-compose.yml services:
//   docker compose up -d && GNL_INTEGRATION=1 npx vitest run packages/durable/test/integration-real.test.ts
// Default SKIP (unless GNL_INTEGRATION=1 is set) → the normal suite stays green without Docker.
//
// PURPOSE (closes the open item in CORE-HARDENING §5.4): prove on REAL engines what pg-mem and
// node:sqlite CANNOT PROVE:
//   1. Postgres's `ON CONFLICT DO NOTHING RETURNING` boolean — pg-mem also returned a row on conflict
//      (a fidelity limit) → putIfAbsent's "exactly one winner" contract is verified at the boolean
//      level for the first time on real PG.
//   2. REAL async parallelism — since node:sqlite is SYNCHRONOUS, single-process tests were serialized;
//      pg/ioredis are async → two separate connection pools/clients genuinely race concurrently.
//   3. Redis SET NX / PX TTL / MGET on a real server (fidelity check of the FakeRedis model).
//   4. D4-real (P1.6b/P0.3 real-backend proof): applyBatch's REAL atomicity — a genuine Postgres
//      transaction (BEGIN/COMMIT/ROLLBACK, not pg-mem's non-undoing ROLLBACK) and the real Redis Lua
//      script (EVAL, not the fake-redis.ts simulation) — under real concurrent races AND a genuine
//      mid-transaction failure; plus deletePrefix's GDPR counter-sweep fix and countRunsByStatus/getMany
//      against real engines (storage-backend.test.ts only proves these against pg-mem/fake-redis).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { stepCountIs } from 'ai';
import { PostgresStorage } from '../src/postgres-storage.js';
import { RedisStorage } from '../src/redis-storage.js';
import { acquireRunLock } from '../src/run-lock.js';
import { runDurable } from '../src/run.js';
import { RunBusyError } from '../src/errors.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';
import { emit, createConsumer } from '../../events/src/index.js';

const RUN = process.env.GNL_INTEGRATION === '1';
const PG_URL = process.env.GNL_PG_URL ?? 'postgres://postgres:gnl@localhost:55432/gnl';
const REDIS_URL = process.env.GNL_REDIS_URL ?? 'redis://localhost:6380';

// A unique key space per run → leftovers from previous runs don't pollute tests (no TRUNCATE needed).
const SEED = `it${Date.now().toString(36)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!RUN)('REAL Postgres — multi-pool CAS + run-lock + exactly-once', () => {
  let a: PostgresStorage; // SEPARATE Pool
  let b: PostgresStorage; // SEPARATE Pool — a real multi-worker model

  beforeAll(async () => {
    a = new PostgresStorage({ connectionString: PG_URL });
    b = new PostgresStorage({ connectionString: PG_URL });
    // The container may have just started up → wait until it's ready (init is idempotent).
    for (let i = 0; ; i++) {
      try {
        await a.init();
        break;
      } catch (e) {
        if (i >= 20) throw e;
        await sleep(500);
      }
    }
    await b.init();
  }, 30_000);

  afterAll(async () => {
    await a?.close();
    await b?.close();
  });

  it('the putIfAbsent boolean on REAL PG: two separate Pools concurrently → EXACTLY ONE true per round', async () => {
    // This boolean is exactly the thing pg-mem could not prove. 20 rounds of a real race:
    for (let round = 0; round < 20; round++) {
      const key = `${SEED}:cas:${round}:tool:t`; // a tool key → the real journal write path
      const results = await Promise.all([a.runs.putIfAbsent(key, { w: 'a' }), b.runs.putIfAbsent(key, { w: 'b' })]);
      expect(results.filter(Boolean).length).toBe(1); // this assertion was UNRELIABLE under pg-mem
      const [va, vb] = await Promise.all([a.runs.get(key), b.runs.get(key)]);
      expect(va).toEqual(vb); // both pools read the single real record
    }
  });

  it('a putIfAbsent storm: 10 concurrent attempts on the same key from two pools → exactly 1 winner', async () => {
    const key = `${SEED}:storm:tool:t`;
    const attempts = Array.from({ length: 10 }, (_, i) =>
      (i % 2 === 0 ? a : b).runs.putIfAbsent(key, { attempt: i }),
    );
    const results = await Promise.all(attempts);
    expect(results.filter(Boolean).length).toBe(1);
  });

  it('an acquireRunLock fresh race across two pools: exactly one winner (10 rounds)', async () => {
    for (let round = 0; round < 10; round++) {
      const runId = `${SEED}:lock:${round}`;
      const [lA, lB] = await Promise.all([
        acquireRunLock(a.runs, runId, 'A', 5000),
        acquireRunLock(b.runs, runId, 'B', 5000),
      ]);
      expect([lA, lB].filter((x) => x !== null).length).toBe(1);
    }
  });

  it('locked runDurable e2e: two pools with the same runId → one gets RunBusyError, tool side effect EXACTLY 1', async () => {
    const counter = { charges: 0 };
    const mkTools = () => ({
      charge: {
        execute: async () => {
          counter.charges++;
          await sleep(30); // keep the lock held
          return { charged: 20 };
        },
      },
    });
    const mkModel = () =>
      createMockModel(async ({ prompt }: any) =>
        countToolResults(prompt) === 0 ? toolCallResult('charge', 'call-c', { amount: 20 }) : finalTextResult('done'),
      );
    const opts = (storage: PostgresStorage, owner: string) => ({
      runId: `${SEED}:e2e-run`,
      journal: storage.runs,
      model: mkModel(),
      tools: mkTools(),
      stopWhen: stepCountIs(6),
      prompt: 'x',
      lock: { owner, ttlMs: 10_000 },
    });
    const settled = await Promise.allSettled([runDurable(opts(a, 'wa') as any), runDurable(opts(b, 'wb') as any)]);
    const busy = settled.filter(
      (s) => s.status === 'rejected' && (s as PromiseRejectedResult).reason instanceof RunBusyError,
    );
    expect(busy.length).toBe(1); // under real async parallelism, the cross-pool lock picked exactly one winner
    expect(counter.charges).toBe(1); // exactly-once on a REAL engine
  });

  it('H1: an expired lock takeover race across two pools → putIfMatch CAS produces EXACTLY ONE winner (10 rounds)', async () => {
    // Prove on a real engine what pg-mem could not: UPDATE ... WHERE key=$ AND value=$ produces an
    // affected-row count of 1 in only ONE of the two concurrent pools. The expired record is written
    // with ttlMs<0 as "already expired in the past"; the takeover calls run WITHOUT a `now` parameter
    // → the H2 journal.now() (PG clock) path is exercised on a real server too.
    for (let round = 0; round < 10; round++) {
      const runId = `${SEED}:takeover:${round}`;
      const dead = await acquireRunLock(a.runs, runId, 'old', -1000); // expires = now-1000 → immediately expired
      expect(dead).not.toBeNull(); // the fresh claim succeeded (the record exists but is already expired)
      const [lB, lC] = await Promise.all([
        acquireRunLock(a.runs, runId, 'B', 60_000),
        acquireRunLock(b.runs, runId, 'C', 60_000),
      ]);
      expect([lB, lC].filter((x) => x !== null).length).toBe(1); // NO split-brain — exactly one winner
    }
  });

  it('H2: journal.now() returns a reasonable epoch ms from the real PG clock', async () => {
    const ms = await (a.runs as any).now();
    expect(typeof ms).toBe('number');
    expect(Number.isFinite(ms)).toBe(true);
    // The container clock is on the same machine as the host → 60s tolerance is more than enough.
    expect(Math.abs(ms - Date.now())).toBeLessThan(60_000);
  });

  it('H12: compact() on REAL PG — VACUUM (lock-free) runs without corrupting data', async () => {
    const runId = `${SEED}:compact`;
    for (let i = 0; i < 50; i++) await a.runs.put(`${runId}:model:${i}`, { i, blob: 'x'.repeat(200) });
    const res = await (a as any).compact(); // default VACUUM (NO ACCESS EXCLUSIVE lock)
    expect(res.reclaimedBytes).toBe(-1); // PG doesn't report size → unknown (contract)
    expect((await b.runs.readRun(runId)).length).toBe(50); // data intact (compact is non-destructive)
  });

  it('T1: concurrent put(same NEW key) across two pools → the gnl_runs counter is exactly 1 (pg-mem CANNOT PROVE THIS)', async () => {
    // Under pg-mem this test showed the counter could reach 2 (verified experimentally: pg-mem does
    // NOT enforce real row-level locking/blocking between concurrent BEGIN'd clients — see
    // multi-worker.test.ts §T1(e) HONESTY NOTE). On real PG, journal.put()'s lockRunRow row lock
    // SERIALIZES the two pools: the second pool's "does prev exist" SELECT sees the first pool's
    // commit → touchRunDelta is applied exactly once as +1.
    const runId = `${SEED}:t1race`;
    const key = `${runId}:tool:call-x`;
    await Promise.all([
      a.runs.put(key, { status: 'succeeded', output: 'from-a' }),
      b.runs.put(key, { status: 'succeeded', output: 'from-b' }),
    ]);
    const entries = await a.runs.readRun(runId);
    expect(entries.length).toBe(1); // same key → a single journal row
    // Read from the OTHER pool — cross-pool consistency. listRuns is paginated with created_at ASC +
    // default limit(50): since earlier tests in this file created dozens of runs with the SAME SEED,
    // the most-recently-created t1race can land on the last page and flake this lookup (not the
    // counter itself, but .find() returning undefined). Fetch with a high limit in a single page →
    // the underlying gnl_runs counter check remains identical, deterministic.
    const page = await b.runs.listRuns({ limit: 100_000 });
    const run = page.items.find((r) => r.runId === runId)!;
    expect(run.toolCalls).toBe(1); // NO DOUBLE COUNTING — exactly 1 on real PG (the thing pg-mem could not prove)
  });

  it('H8: an atomic counter (UPSERT arithmetic) on REAL PG — 40 concurrent increments from two pools, exact total', async () => {
    const key = `${SEED}:usage`;
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        ((i % 2 === 0 ? a : b).runs as any).incrBy(key, { runs: 1, tokens: 5, costUsd: 0.25 }),
      ),
    );
    // Two SEPARATE pools + real concurrency: a get→put approach would have made a lost update inevitable.
    expect(await (a.runs as any).getCounters(key)).toEqual({ runs: 40, tokens: 200, costUsd: 10 });
  });

  it('H8: listStaleRuns + readRunStats on REAL PG (indexed age query, a statistic that doesn\'t move data)', async () => {
    const runId = `${SEED}:stale`;
    await a.runs.put(`${runId}:model:0`, { blob: 'x'.repeat(2000) });
    const stats = await (b.runs as any).readRunStats(runId);
    expect(stats.entries).toBe(1);
    expect(stats.bytes).toBeGreaterThan(2000);
    const future = Date.now() + 60_000; // everything counts as "stale"
    const stale = await (b.runs as any).listStaleRuns(future);
    expect(stale).toContain(runId);
    expect(await (b.runs as any).listStaleRuns(0)).toEqual([]); // a cutoff in the past → nothing is stale
  });

  it('H10a: durabilityReport on REAL PG — honestly reports a single node (NOT failover-safe)', async () => {
    const rep = await (a as any).durabilityReport();
    expect(typeof rep.syncCommit).toBe('string');
    expect(rep.connectedStandbys).toBe(0); // the main compose PG has no replica
    expect(rep.safeForFailover).toBe(false); // an honest report: a single node does NOT guarantee failover
    expect(rep.notes.join(' ')).toMatch(/No replica|single node/);
  });

  it('the readRun ordering contract + superjson type preservation on REAL PG', async () => {
    const runId = `${SEED}:order`;
    // Decision #4: order by (created_at, key); writes landing in the same ms trigger the key tie-break
    // and make the insertion-order assertion flake → separate the timestamps to test insertion order.
    await a.runs.put(`${runId}:model:0`, { step: 0, at: new Date(1700000000000) });
    await sleep(5);
    await a.runs.put(`${runId}:tool:t1`, { status: 'succeeded' });
    await sleep(5);
    await a.runs.put(`${runId}:model:1`, { step: 1 });
    const entries = await b.runs.readRun(runId); // read from the OTHER pool
    expect(entries.map((e) => e.key)).toEqual([`${runId}:model:0`, `${runId}:tool:t1`, `${runId}:model:1`]);
    expect((entries[0]!.value as any).at).toBeInstanceOf(Date); // superjson roundtrip
  });

  // D4-real (P1.6b): applyBatch — pg-mem's INSERT...ON CONFLICT DO NOTHING misreports rowCount=1 even on
  // a genuine conflict (see postgres-storage.ts applyBatch's JSDoc), so storage-backend.test.ts gates its
  // "second call is a no-op" assertion behind caps.exactCas=false for Postgres — it CANNOT prove the
  // exactly-one-winner invariant under real concurrency, or that a mid-batch failure genuinely rolls back
  // (pg-mem's ROLLBACK does not actually undo). Both are proven here against a REAL transaction.
  it('D4-real (P1.6b): applyBatch atomicity under CONCURRENCY — two pools race the SAME claim key with different increments, exactly ONE batch lands', async () => {
    for (let round = 0; round < 10; round++) {
      const key = `${SEED}:batch-race:${round}`;
      const batchA = {
        claim: { key: `${key}:claim`, value: { w: 'a' } },
        incrs: [{ key: `${key}:ctr`, fields: { n: 1 } }],
        puts: [{ key: `${key}:row`, value: { from: 'a' } }],
      };
      const batchB = {
        claim: { key: `${key}:claim`, value: { w: 'b' } },
        incrs: [{ key: `${key}:ctr`, fields: { n: 100 } }],
        puts: [{ key: `${key}:row`, value: { from: 'b' } }],
      };
      const results = await Promise.all([(a.runs as any).applyBatch(batchA), (b.runs as any).applyBatch(batchB)]);
      expect(results.filter(Boolean).length).toBe(1); // exactly ONE batch landed — this is what pg-mem cannot prove
      const counters = await (a.runs as any).getCounters(`${key}:ctr`);
      const row = await a.runs.get<{ from: string }>(`${key}:row`);
      const claimVal = await a.runs.get<{ w: string }>(`${key}:claim`);
      // The LOSER's increment/put must be totally ABSENT — not merged (101), not partially applied.
      if (results[0]) {
        expect(claimVal?.w).toBe('a');
        expect(counters).toEqual({ n: 1 });
        expect(row?.from).toBe('a');
      } else {
        expect(claimVal?.w).toBe('b');
        expect(counters).toEqual({ n: 100 });
        expect(row?.from).toBe('b');
      }
    }
  });

  it('D4-real (P1.6b): applyBatch — a genuine mid-batch failure ROLLS BACK the whole transaction on REAL PG (claim + the individually-valid FIRST incr are BOTH undone)', async () => {
    const runId = `${SEED}:batch-fail`;
    const claimKey = `${runId}:tool:call-fail`;
    const ctrKeyA = `${SEED}:batch-fail:ctr-a`;
    const ctrKeyB = `${SEED}:batch-fail:ctr-b`;
    const batch = {
      claim: { key: claimKey, value: { status: 'succeeded', output: 1 } },
      incrs: [
        { key: ctrKeyA, fields: { n: 1 } }, // would succeed in isolation
        { key: ctrKeyB, fields: { bad: 'not-a-number' } }, // gnl_counters.value is DOUBLE PRECISION → this
        // non-numeric text fails the INSERT with "invalid input syntax for type double precision" —
        // a genuine SQL error raised MID-TRANSACTION, reachable through the public applyBatch API alone
        // (no src hook needed) — exactly the kind of failure pg-mem's non-undoing ROLLBACK can't prove safe.
      ],
    };
    await expect((a.runs as any).applyBatch(batch)).rejects.toThrow();
    expect(await a.runs.get(claimKey)).toBeUndefined(); // the claim insert was undone too
    expect(await (a.runs as any).getCounters(ctrKeyA)).toBeUndefined(); // the FIRST (valid-on-its-own) incr was undone too
    expect(await (a.runs as any).getCounters(ctrKeyB)).toBeUndefined();
  });

  it('D4-real (GDPR fix): deletePrefix sweeps org usage + metrics counters on REAL PG (gnl_counters), leaves a neighbor org intact', async () => {
    const org = `${SEED}:gdpr-org`;
    await (a.runs as any).incrBy(`${org}:__usage__`, { runs: 3, costUsd: 1.5 });
    await (a.runs as any).incrBy(`${org}:__metrics__:calls`, { n: 5 });
    await a.runs.put(`${org}:r1:input`, { p: 'x' }); // an ordinary (non-counter) key under the same prefix
    await (a.runs as any).incrBy(`${SEED}:gdpr-neighbor:__usage__`, { runs: 7 });
    await (a.runs as any).deletePrefix(`${org}:`);
    expect(await (b.runs as any).getCounters(`${org}:__usage__`)).toBeUndefined(); // swept (cross-pool read)
    expect(await (b.runs as any).getCounters(`${org}:__metrics__:calls`)).toBeUndefined();
    expect(await b.runs.get(`${org}:r1:input`)).toBeUndefined();
    expect(await (b.runs as any).getCounters(`${SEED}:gdpr-neighbor:__usage__`)).toEqual({ runs: 7 }); // neighbor untouched
  });

  it('D4-real (P1.6b): countRunsByStatus on REAL PG — matches a listRuns-derived count exactly (mixed completed/suspended)', async () => {
    for (let i = 0; i < 3; i++) await a.runs.put(`${SEED}:crs-done-${i}:model:0`, { ok: true });
    for (let i = 0; i < 2; i++) {
      await a.runs.put(`${SEED}:crs-susp-${i}:model:0`, { ok: true });
      await a.runs.put(`${SEED}:crs-susp-${i}:tool:t1`, { status: 'suspended', output: {} });
    }
    const counted = await (b.runs as any).countRunsByStatus(); // cross-pool read, indexed GROUP BY
    // The describe block's earlier tests also created SEED-prefixed runs on this same table — compare
    // against the WHOLE table's listRuns-derived truth (same source countRunsByStatus itself groups over),
    // not just this test's own runs — the two must agree regardless of what else exists.
    const page = await b.runs.listRuns({ limit: 1_000_000 });
    const expected: Record<string, number> = {};
    for (const r of page.items) expected[r.status] = (expected[r.status] ?? 0) + 1;
    expect(counted).toEqual(expected);
    expect(expected.suspended).toBeGreaterThanOrEqual(2); // sanity: the mixed statuses really landed
  });

  it('D4-real (P1.6b): getMany on REAL PG — order-preserving, undefined for misses, cross-pool read', async () => {
    await a.runs.put(`${SEED}:gm:a`, { v: 1 });
    await a.runs.put(`${SEED}:gm:c`, { v: 3 });
    const [va, vb, vc] = await (b.runs as any).getMany([`${SEED}:gm:a`, `${SEED}:gm:b`, `${SEED}:gm:c`]);
    expect(va).toEqual({ v: 1 });
    expect(vb).toBeUndefined();
    expect(vc).toEqual({ v: 3 });
  });
});

describe.skipIf(!RUN)('REAL Redis — SET NX / TTL / MGET (FakeRedis fidelity check)', () => {
  let clientA: any;
  let clientB: any; // SEPARATE connection — a real two-worker model
  let a: RedisStorage;
  let b: RedisStorage;

  beforeAll(async () => {
    const { default: Redis } = await import('ioredis');
    clientA = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });
    clientB = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });
    a = new RedisStorage({ client: clientA, keyPrefix: `${SEED}:` });
    b = new RedisStorage({ client: clientB, keyPrefix: `${SEED}:` });
    await a.init();
  }, 30_000);

  afterAll(async () => {
    await clientA?.quit();
    await clientB?.quit();
  });

  it('a SET NX race across two separate connections: exactly one winner per round (20 rounds)', async () => {
    for (let round = 0; round < 20; round++) {
      const key = `cas:${round}:tool:t`;
      const results = await Promise.all([a.runs.putIfAbsent(key, { w: 'a' }), b.runs.putIfAbsent(key, { w: 'b' })]);
      expect(results.filter(Boolean).length).toBe(1);
      expect(await a.runs.get(key)).toEqual(await b.runs.get(key));
    }
  });

  it('ackOnce on real Redis: concurrent from two connections → exactly one true', async () => {
    const results = await Promise.all([a.work.ackOnce('job-1'), b.work.ackOnce('job-1')]);
    expect(results.filter(Boolean).length).toBe(1);
  });

  it('cache PX TTL on a real server: the key REALLY drops once the ttl elapses', async () => {
    await a.cache.set('k', { v: 1 }, { ttlMs: 150 });
    expect(await b.cache.get('k')).toEqual({ v: 1 }); // visible from the other connection
    await sleep(300);
    expect(await a.cache.get('k')).toBeUndefined(); // Redis dropped it itself (not a lazy-expire simulation)
  });

  it('H1: an expired lock takeover race across two connections → Lua CAS produces EXACTLY ONE winner (10 rounds)', async () => {
    // Fidelity check of the FakeRedis.eval simulation: on a real server, EVAL (GET==ARGV[1] → SET
    // ARGV[2]) runs atomically; the RjEnv-enveloped raw-string CAS pattern should produce exactly ONE
    // winner across two concurrent ioredis connections. Takeovers run WITHOUT passing `now` → the H2
    // TIME path is exercised too.
    for (let round = 0; round < 10; round++) {
      const runId = `takeover:${round}`;
      const dead = await acquireRunLock(a.runs, runId, 'old', -1000); // expires in the past → immediately expired
      expect(dead).not.toBeNull();
      const [lB, lC] = await Promise.all([
        acquireRunLock(a.runs, runId, 'B', 60_000),
        acquireRunLock(b.runs, runId, 'C', 60_000),
      ]);
      expect([lB, lC].filter((x) => x !== null).length).toBe(1); // NO split-brain
    }
  });

  it('H2: journal.now() returns a reasonable epoch ms from the real Redis TIME command', async () => {
    const ms = await (a.runs as any).now();
    expect(typeof ms).toBe('number');
    expect(Number.isFinite(ms)).toBe(true);
    expect(Math.abs(ms - Date.now())).toBeLessThan(60_000);
  });

  it('DISTRIBUTED PUBSUB: @gnl/events on a real Redis WorkStore — fan-out to two workers, exactly-once', async () => {
    // The GNL-design closure of the internal audit's "external pubsub backends" item: events already
    // sits on the WorkStore port; RedisStorage.work='full' → pointing at Redis is enough. Two
    // consumers on two SEPARATE connections (fan-out) must each receive EVERY event EXACTLY ONCE;
    // two concurrent polls of the SAME consumer name (a racing replica) must NOT deliver twice
    // (ackOnce CAS).
    const gotX: string[] = [];
    const gotY: string[] = [];
    const cX = createConsumer(a.work, 'order', async (p: any) => { gotX.push(p.id); }, { name: 'reporter' });
    const cY = createConsumer(b.work, 'order', async (p: any) => { gotY.push(p.id); }, { name: 'biller' });

    await emit(a.work, 'order', { id: 's1' }, { id: 'e1' });
    await emit(b.work, 'order', { id: 's2' }, { id: 'e2' });
    await emit(a.work, 'order', { id: 's1' }, { id: 'e1' }); // idempotent emit → a single event

    await Promise.all([cX.poll(), cY.poll()]);
    expect(gotX.sort()).toEqual(['s1', 's2']); // fan-out: EVERY consumer got EVERY event
    expect(gotY.sort()).toEqual(['s1', 's2']);

    // A racing replica of the same consumer (two connections, the SAME name) — the post-K2 contract:
    // exactly-once MARKING + at-least-once DELIVERY. Under racing polls the HANDLER can run twice
    // (the ack now happens AFTER the handler — the get pre-check doesn't close the race window, an
    // idempotent handler is required; see the events/src/index.ts header). The CAS guarantee is on
    // DELIVERY COUNT: only one wins ackOnce → the delivered total is exactly 2. The old expectation
    // (dupGot exactly ['s1','s2']) belonged to the at-most-once era; the package's unit tests were
    // updated, but this gated test was overlooked.
    const dupGot: string[] = [];
    const r1 = createConsumer(a.work, 'order', async (p: any) => { dupGot.push(p.id); }, { name: 'replica' });
    const r2 = createConsumer(b.work, 'order', async (p: any) => { dupGot.push(p.id); }, { name: 'replica' });
    const [d1, d2] = await Promise.all([r1.poll(), r2.poll()]);
    expect(d1 + d2).toBe(2); // CAS: EXACTLY ONE replica won ackOnce for each event (double delivery does NOT COUNT)
    expect([...new Set(dupGot)].sort()).toEqual(['s1', 's2']); // each event was processed at least once (no loss)
    expect(dupGot.length).toBeLessThanOrEqual(4); // the handler runs at most once per replica
  });

  it('readRun with real MGET: ordering + content correct (the bulkGet path)', async () => {
    const runId = 'mget-run';
    // Separate the timestamps against the Decision #4 tie-break flake (same note as PG — order = created_at, key).
    await a.runs.put(`${runId}:model:0`, { s: 0 });
    await sleep(5);
    await a.runs.put(`${runId}:tool:t1`, { status: 'succeeded' });
    await sleep(5);
    await a.runs.put(`${runId}:model:1`, { s: 1 });
    const entries = await b.runs.readRun(runId); // ioredis.mget on a real server
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.kind)).toEqual(['model', 'tool', 'model']);
  });

  // D4-real (P1.6b Lua): the fake-redis.ts APPLY_BATCH_LUA mimic (test.storage-backend.test.ts /
  // metrics.test.ts) is a JS simulation of the script's semantics — it cannot prove the REAL server
  // actually runs `EVAL` atomically, nor that cjson.decode/HINCRBYFLOAT/ZADD behave as expected inside
  // real Lua. Proven here against a real Redis EVAL.
  it('D4-real (P1.6b Lua): applyBatch on REAL Redis — claim+incrs+puts land atomically across rj:/ctr:, and the activity ZSET is touched', async () => {
    const runId = 'lua-batch-run';
    const batch = {
      claim: { key: `${runId}:tool:call-1`, value: { status: 'succeeded', output: 1 } },
      incrs: [{ key: 'lua-batch:usage', fields: { runs: 1, tokens: 5 } }],
      puts: [{ key: `${runId}:model:0`, value: { step: 0 } }],
    };
    expect(await (a.runs as any).applyBatch(batch)).toBe(true);
    // rj: namespace — both the claim record and the plain put are readable (cross-connection read).
    expect(await b.runs.get(batch.claim.key)).toEqual({ status: 'succeeded', output: 1 });
    expect(await b.runs.get(`${runId}:model:0`)).toEqual({ step: 0 });
    // ctr: namespace (HINCRBYFLOAT via the real Lua script).
    expect(await (b.runs as any).getCounters('lua-batch:usage')).toEqual({ runs: 1, tokens: 5 });
    // H8b parity: applyBatch's run-shaped keys (claim.key/puts[].key that parse as `<runId>:model|tool:*`)
    // ALSO ZADD the activity ZSET inside the SAME Lua unit (see redis-storage.ts's `touchOf`) — same
    // "future cutoff sees it, cutoff=0 doesn't" idiom as the H8 Postgres test above proves the ZADD fired.
    const future = Date.now() + 60_000;
    expect(await (b.runs as any).listStaleRuns(future)).toContain(runId);
    expect(await (b.runs as any).listStaleRuns(0)).toEqual([]);
  });

  it('D4-real (P1.6b Lua): applyBatch — claim key EXISTS → the WHOLE batch is a no-op (rj: claim/put AND ctr: counter all untouched)', async () => {
    const claimKey = 'lua-noop:claim';
    await a.runs.put(claimKey, { pre: true });
    const batch = {
      claim: { key: claimKey, value: { at: 2 } },
      incrs: [{ key: 'lua-noop:ctr', fields: { n: 1 } }],
      puts: [{ key: 'lua-noop:row', value: { v: 1 } }],
    };
    expect(await (a.runs as any).applyBatch(batch)).toBe(false);
    expect(await a.runs.get(claimKey)).toEqual({ pre: true }); // the PRE-EXISTING claim value, untouched
    expect(await (a.runs as any).getCounters('lua-noop:ctr')).toBeUndefined(); // ctr: namespace never written
    expect(await a.runs.get('lua-noop:row')).toBeUndefined(); // rj: put never written — the Lua script returned early
  });

  it('D4-real (P1.6b Lua): applyBatch atomicity under CONCURRENCY — two connections race the SAME claim key with different increments, exactly ONE batch lands', async () => {
    for (let round = 0; round < 10; round++) {
      const key = `batch-race:${round}`;
      const batchA = {
        claim: { key: `${key}:claim`, value: { w: 'a' } },
        incrs: [{ key: `${key}:ctr`, fields: { n: 1 } }],
        puts: [{ key: `${key}:row`, value: { from: 'a' } }],
      };
      const batchB = {
        claim: { key: `${key}:claim`, value: { w: 'b' } },
        incrs: [{ key: `${key}:ctr`, fields: { n: 100 } }],
        puts: [{ key: `${key}:row`, value: { from: 'b' } }],
      };
      const results = await Promise.all([(a.runs as any).applyBatch(batchA), (b.runs as any).applyBatch(batchB)]);
      expect(results.filter(Boolean).length).toBe(1); // exactly ONE batch landed on the real server
      const counters = await (a.runs as any).getCounters(`${key}:ctr`);
      const row = await a.runs.get<{ from: string }>(`${key}:row`);
      const claimVal = await a.runs.get<{ w: string }>(`${key}:claim`);
      if (results[0]) {
        expect(claimVal?.w).toBe('a');
        expect(counters).toEqual({ n: 1 });
        expect(row?.from).toBe('a');
      } else {
        expect(claimVal?.w).toBe('b');
        expect(counters).toEqual({ n: 100 });
        expect(row?.from).toBe('b');
      }
    }
  });

  it('D4-real (GDPR fix): deletePrefix sweeps org usage + metrics counters on REAL Redis (ctr: namespace), leaves a neighbor org intact', async () => {
    const org = 'gdpr-org';
    await (a.runs as any).incrBy(`${org}:__usage__`, { runs: 3, costUsd: 1.5 });
    await (a.runs as any).incrBy(`${org}:__metrics__:calls`, { n: 5 });
    await a.runs.put(`${org}:r1:input`, { p: 'x' }); // an ordinary (non-counter) key under the same prefix
    await (a.runs as any).incrBy('gdpr-neighbor:__usage__', { runs: 7 });
    await (a.runs as any).deletePrefix(`${org}:`);
    expect(await (b.runs as any).getCounters(`${org}:__usage__`)).toBeUndefined(); // swept (cross-connection read)
    expect(await (b.runs as any).getCounters(`${org}:__metrics__:calls`)).toBeUndefined();
    expect(await b.runs.get(`${org}:r1:input`)).toBeUndefined();
    expect(await (b.runs as any).getCounters('gdpr-neighbor:__usage__')).toEqual({ runs: 7 }); // neighbor untouched
  });

  it('D4-real (P1.6b): getMany on REAL Redis — order-preserving, undefined for misses (cross-connection MGET)', async () => {
    await a.runs.put('gm:a', { v: 1 });
    await a.runs.put('gm:c', { v: 3 });
    const [va, vb, vc] = await (b.runs as any).getMany(['gm:a', 'gm:b', 'gm:c']);
    expect(va).toEqual({ v: 1 });
    expect(vb).toBeUndefined();
    expect(vc).toEqual({ v: 3 });
  });
});
