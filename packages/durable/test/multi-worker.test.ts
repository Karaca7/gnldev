// MULTI-WORKER CONCURRENCY — internal audit §3.1 verification.
//
// QUESTION: Do CAS + run-lock rely on a "single DB connection" assumption? If multiple instances
// (TWO SEPARATE storages connected to the SAME journal backend) write to the same run at the same
// time, is there a real race condition?
//
// What existing concurrency.test.ts / run-lock.test.ts / exactly-once-intersection.test.ts COVER:
//   - Concurrent calls WITHIN a single InMemoryJournal (single object) (TOCTOU, tool-claim, lock acquire/release/takeover).
//   - exactly-once-intersection: real process-kill but SEQUENTIAL (child crashes → parent resumes), not concurrent.
// What is NOT COVERED (this file adds it):
//   - TWO SEPARATE storage instances connected to the SAME shared backend (same SQLite file / same pg-mem db /
//     same FakeRedis client), writing to the SAME runId with Promise.all, TRULY concurrently.
//
// HONESTY NOTES (evidentiary strength):
//   - InMemory: the "backend" IS the Map itself; there's no separate "connection" concept → j1===j2 (same object).
//     In single-threaded JS, putIfAbsent (Map.has→set, no await in between) is structurally atomic.
//   - Sqlite (shared file): TWO REAL node:sqlite connections to the same file. node:sqlite is SYNCHRONOUS →
//     calls SERIALIZE within a single process; so this test PROVES SQL-level CAS atomicity (ON CONFLICT DO
//     NOTHING → changes), but NOT OS-level parallelism (a synchronous API cannot produce that within a
//     single process). Multi-process proof is in process-kill.test.ts + exactly-once-intersection.
//   - Postgres (pg-mem): TWO Pools against the same in-memory db. pg-mem's `ON CONFLICT DO NOTHING RETURNING`
//     also returns a row on conflict (known fidelity limitation — same note as in storage-backend.test.ts) →
//     the putIfAbsent boolean is NOT RELIABLE. So for pg-mem we verify the DATA invariant (value preserved /
//     single row) rather than the boolean; against real PG the boolean is correct (proven with SQL Sqlite above).
//   - Redis (FakeRedis): ONE client shared by TWO RedisStorages. SET NX is genuinely atomic + async → the
//     most faithful concurrency model of a shared backend.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stepCountIs } from 'ai';
import { InMemoryJournal } from '../src/journal.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { RedisStorage } from '../src/redis-storage.js';
import { runDurable } from '../src/run.js';
import { acquireRunLock } from '../src/run-lock.js';
import { RunBusyError } from '../src/errors.js';
import { makeFakeRedis } from './fake-redis.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';
import { newDb } from 'pg-mem';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── SQLite busy_timeout — audit fix ─────────────────────────────────────────────────────
// Default busy_timeout=0: in two-connection scenarios like §3.1(b-e2e)/(d) below, if BEGIN
// IMMEDIATE was already locked it would IMMEDIATELY throw SQLITE_BUSY. The constructor now sets
// busy_timeout=5000 — here we only verify the PRAGMA is actually set (the behavioral proof is
// that the two-connection tests in this file pass without error).
describe('SQLite busy_timeout (audit fix)', () => {
  it('constructor sets PRAGMA busy_timeout=5000 (not the default 0)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gnl-busy-timeout-'));
    const p = join(dir, 'bt.db');
    const st = new SqliteStorage(p);
    try {
      const row = (st as any).db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
      expect(row.timeout).toBe(5000);
    } finally {
      await st.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Shared-backend factories: two SEPARATE RunJournals, one physical backend ────────────────────
type SharedBackend = {
  name: string;
  exactCas: boolean; // false → pg-mem RETURNING limitation: verify the data invariant, not the boolean
  make: () => Promise<{ j1: any; j2: any; close: () => Promise<void> }>;
};

const backends: SharedBackend[] = [
  {
    name: 'InMemory (single Map = backend)',
    exactCas: true,
    make: async () => {
      const shared = new InMemoryJournal(); // no "two connections" concept → same object
      return { j1: shared, j2: shared, close: async () => {} };
    },
  },
  {
    name: 'Sqlite (shared file, 2 connections)',
    exactCas: true,
    make: async () => {
      const dir = mkdtempSync(join(tmpdir(), 'gnl-mw-sqlite-'));
      const p = join(dir, 'mw.db');
      const a = new SqliteStorage(p);
      const b = new SqliteStorage(p); // SEPARATE node:sqlite connection, SAME file
      return {
        j1: a.runs,
        j2: b.runs,
        close: async () => { await a.close(); await b.close(); rmSync(dir, { recursive: true, force: true }); },
      };
    },
  },
  {
    // pg-mem NOTE: creating TWO Pools from the same `createPg()` and running DDL corrupts pg-mem's
    // global AST-coverage parser state (a pg-mem quirk, not GNL — it blows up on CREATE TABLE). So we
    // model pg-mem with a SINGLE PostgresStorage + one shared pool: "two workers, one shared connection
    // pool" (a realistic multi-worker pattern). Just like InMemory, j1===j2. Also, since pg-mem's
    // RETURNING also returns a row on conflict (known limitation, noted in storage-backend.test.ts),
    // exactCas=false → we verify the DATA invariant rather than the boolean; against real PG the
    // boolean is proven via Sqlite's ON CONFLICT.
    name: 'Postgres (pg-mem, single shared pool)',
    exactCas: false,
    make: async () => {
      const { Pool } = newDb().adapters.createPg();
      const s = new PostgresStorage({ pool: new Pool() });
      await s.init();
      return { j1: s.runs, j2: s.runs, close: async () => { await s.close(); } };
    },
  },
  {
    name: 'Redis (FakeRedis, shared client, 2 storages)',
    exactCas: true,
    make: async () => {
      const client = makeFakeRedis(); // SINGLE client → genuinely shared backend
      const a = new RedisStorage({ client });
      const b = new RedisStorage({ client });
      await a.init();
      await b.init();
      return { j1: a.runs, j2: b.runs, close: async () => { await a.close(); } };
    },
  },
];

// ── (a) Two instances putIfAbsent(same key) concurrently → EXACTLY one true ──────────────────
describe.each(backends)('§3.1(a) multi-worker CAS — $name', ({ exactCas, make }) => {
  it('concurrent putIfAbsent(same key): exactly one winner; value preserved; both instances consistent', async () => {
    const { j1, j2, close } = await make();
    try {
      const key = 'race:tool:k'; // tool key → also exercises the touchRun/real write path
      // REAL concurrency: not sequential, Promise.all.
      const results = await Promise.all([j1.putIfAbsent(key, { w: 1 }), j2.putIfAbsent(key, { w: 2 })]);
      const trues = results.filter(Boolean).length;

      if (exactCas) {
        // The CRITICAL race assertion: if there were two trues (double-insert), this line must FAIL.
        expect(trues).toBe(1);
      } else {
        // pg-mem: the boolean is unreliable (RETURNING also returns on conflict) → at least one true; the data invariant is checked below.
        expect(trues).toBeGreaterThanOrEqual(1);
      }

      // On every backend: DO NOTHING → the first-written value is preserved; both instances see the SAME value (a single row).
      const v1 = await j1.get(key);
      const v2 = await j2.get(key);
      expect(v1).toEqual(v2); // consistency: both connections read the same single record
      expect([{ w: 1 }, { w: 2 }]).toContainEqual(v1); // one of the two candidates; never mixed/duplicated
    } finally {
      await close();
    }
  });
});

// ── (b) Two instances acquireRunLock(same run) → one wins, the other null ─────────────────────
describe.each(backends)('§3.1(b) multi-worker fresh run-lock — $name', ({ exactCas, make }) => {
  it('concurrent acquireRunLock(empty key): atomic claim → exactly one winner', async () => {
    const { j1, j2, close } = await make();
    try {
      const runId = 'lockrace';
      // Acquisition on a fresh (empty) key: acquireRunLock FIRST tries an atomic claim (putIfAbsent).
      const [lA, lB] = await Promise.all([
        acquireRunLock(j1, runId, 'A', 5000),
        acquireRunLock(j2, runId, 'B', 5000),
      ]);
      const held = [lA, lB].filter((x) => x !== null).length;
      if (exactCas) {
        // A fresh acquire goes through the atomic CAS path → EXACTLY one winner. Two locks would FAIL.
        expect(held).toBe(1);
      } else {
        // pg-mem: the claim boolean can return two trues (the RETURNING limitation) → held===1 on real PG.
        expect(held).toBeGreaterThanOrEqual(1);
      }
    } finally {
      await close();
    }
  });
});

// ── (b-e2e) Two REAL Sqlite connections, locked runDurable → one RunBusyError, charge exactly 1 ─────
describe('§3.1(b) e2e — Sqlite two connections, locked runDurable', () => {
  it('same runId concurrently across two storage instances with a lock → one RunBusyError, charge=1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gnl-mw-lockrun-'));
    const p = join(dir, 'mw.db');
    const a = new SqliteStorage(p);
    const b = new SqliteStorage(p); // SAME file, SEPARATE connection
    const counter = { charges: 0 };
    try {
      const tools = () => ({
        charge: {
          execute: async () => {
            counter.charges++;
            await sleep(15); // extend the work → keep the lock held
            return { charged: 20 };
          },
        },
      });
      const model = () =>
        createMockModel(async ({ prompt }: any) =>
          countToolResults(prompt) === 0 ? toolCallResult('charge', 'call-c', { amount: 20 }) : finalTextResult('done'),
        );
      const opts = (journal: any) => ({
        runId: 'shared-run',
        journal,
        model: model(),
        tools: tools(),
        stopWhen: stepCountIs(6),
        prompt: 'x',
        lock: { owner: journal === a.runs ? 'wa' : 'wb', ttlMs: 5000 },
      });

      const settled = await Promise.allSettled([
        runDurable(opts(a.runs) as any),
        runDurable(opts(b.runs) as any),
      ]);
      const busy = settled.filter(
        (s) => s.status === 'rejected' && (s as PromiseRejectedResult).reason instanceof RunBusyError,
      );
      // Cross-connection lock: SQL CAS (ON CONFLICT DO NOTHING) picks exactly one winner → the other gets RunBusyError.
      expect(busy.length).toBe(1);
      expect(counter.charges).toBe(1); // exactly-once: only the winner ran
    } finally {
      await a.close();
      await b.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── (c) With NO LOCK, two concurrent runDurable calls (shared backend) → is there an exactly-once violation? ────
describe('§3.1(c) NO lock, concurrent runDurable — does exactly-once (atomic tool-CAS) still hold?', () => {
  it('shared InMemory backend, same runId, NO lock → tool body EXACTLY 1 call (model may be called twice)', async () => {
    const journal = new InMemoryJournal(); // shared backend
    let charges = 0;
    let modelCalls = 0;
    const tools = () => ({
      charge: {
        execute: async () => {
          charges++;
          await sleep(15);
          return { charged: 20 };
        },
      },
    });
    const model = () =>
      createMockModel(async ({ prompt }: any) => {
        modelCalls++;
        return countToolResults(prompt) === 0 ? toolCallResult('charge', 'call-c', { amount: 20 }) : finalTextResult('done');
      });
    const opts = () => ({ runId: 'r-nolock', journal, model: model(), tools: tools(), stopWhen: stepCountIs(6), prompt: 'x' });

    // NO LOCK — two workers at once; the only protection is the atomic per-tool claim.
    await Promise.allSettled([runDurable(opts() as any), runDurable(opts() as any)]);

    // CORE GUARANTEE: even without a lock, the tool side effect happens EXACTLY once (atomic claim of the
    // 'running' marker). Two would FAIL → meaning an exactly-once violation.
    expect(charges).toBe(1);
    // FINDING: there is NO hard mutual exclusion for the model step (there's a write-ahead claim but no
    // RunBusyError) → without a lock, the model's doGenerate CAN be called twice. This is a deliberate design
    // decision (see durable-model.ts: "concurrent multi-resume protection is opt-in via a run-level lock").
    // Cost/idempotency-wise: the model call may repeat; the actual side effect (the tool) is still exactly once.
    expect(modelCalls).toBeGreaterThanOrEqual(2);
  });
});

// ── (d) Lock expiry / stale takeover — DETECT + DOCUMENT the current mechanism ─────────────────────
describe('§3.1(d) lock expiry / stale takeover', () => {
  it('if the owner dies (no release), the second instance takes over after TTL', async () => {
    const j = new InMemoryJournal();
    const t0 = 1000;
    const lA = await acquireRunLock(j, 'r', 'A', 100, t0); // short TTL
    expect(lA).not.toBeNull();
    // A "dies": release() is NEVER called. The lock record in the journal stays 'alive' (owner=A).
    // Before the TTL elapses, the second acquisition is rejected:
    expect(await acquireRunLock(j, 'r', 'B', 5000, t0 + 50)).toBeNull(); // still alive
    // Once the TTL passes, it can be taken over (current mechanism: expires<now → best-effort takeover):
    const lB = await acquireRunLock(j, 'r', 'B', 5000, t0 + 200);
    expect(lB).not.toBeNull();
    expect(lB!.owner).toBe('B');
  });

  it('H1 FIX: concurrent takeover no longer PRODUCES split-brain (putIfMatch CAS)', async () => {
    // Prior finding: the takeover path (failed claim → get → put) was not atomic, both workers ended up
    // with a handle (held===2 was the characterized behavior). With H1, on adapters supporting
    // journal.putIfMatch, takeover was moved onto CAS: if the expired record you read is still in place
    // you overwrite it — exactly ONE winner.
    const j = new InMemoryJournal(); // supports putIfMatch
    const t0 = 1000;
    await acquireRunLock(j, 'r', 'A', 100, t0); // A gets a short TTL, no release (death)
    const past = t0 + 200; // A's TTL has passed
    const [lB, lC] = await Promise.all([
      acquireRunLock(j, 'r', 'B', 5000, past),
      acquireRunLock(j, 'r', 'C', 5000, past),
    ]);
    const held = [lB, lC].filter((x) => x !== null).length;
    expect(held).toBe(1); // split-brain closed; the loser gets null and DOES NOT RUN
    // The winner's handle is valid: the token in the record belongs to the winner (fencing integrity).
    const winner = [lB, lC].find((x) => x !== null)!;
    expect(['B', 'C']).toContain(winner.owner);
  });

  it('H1 SQLite two connections: expired-lock takeover race → EXACTLY one winner via putIfMatch CAS', async () => {
    // Shared-backend version of (d)'s InMemory proof: TWO REAL node:sqlite connections to the same
    // file. Takeover is now grounded in SQL CAS (UPDATE ... WHERE key=? AND value=?) → atomicity lives
    // inside the engine; even if both connections read the same expired record, the UPDATE affects a
    // row in only ONE of them.
    const dir = mkdtempSync(join(tmpdir(), 'gnl-mw-takeover-'));
    const p = join(dir, 'mw.db');
    const a = new SqliteStorage(p);
    const b = new SqliteStorage(p); // SAME file, SEPARATE connection
    try {
      const t0 = 1000;
      await acquireRunLock(a.runs, 'to-run', 'A', 100, t0); // A gets a short TTL, no release (death)
      const past = t0 + 200; // A's TTL passed → two workers attempt a concurrent takeover
      const [lB, lC] = await Promise.all([
        acquireRunLock(a.runs, 'to-run', 'B', 5000, past),
        acquireRunLock(b.runs, 'to-run', 'C', 5000, past),
      ]);
      const held = [lB, lC].filter((x) => x !== null).length;
      expect(held).toBe(1); // now with putIfMatch: NO split-brain (used to be able to be 2)
      const winner = [lB, lC].find((x) => x !== null)!;
      expect(['B', 'C']).toContain(winner.owner);
    } finally {
      await a.close();
      await b.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('COUNTER-FINDING: a simultaneous FRESH acquire race does NOT PRODUCE split-brain (atomic claim holds)', async () => {
    // Contrast: not a takeover, but acquisition on an empty key → putIfAbsent is atomic → single winner.
    const j = new InMemoryJournal();
    const [lB, lC] = await Promise.all([
      acquireRunLock(j, 'r2', 'B', 5000),
      acquireRunLock(j, 'r2', 'C', 5000),
    ]);
    expect([lB, lC].filter((x) => x !== null).length).toBe(1);
  });
});

// ── (e) T1 audit fix — put() derived-index race: shared-backend proof ────────────────────
// journal.put()'s triple of SELECT prev → UPSERT → touchRunDelta could, under autocommit, let TWO
// SEPARATE workers concurrently put() the SAME NEW key both see prev=none and DOUBLE-increment the
// gnl_runs counter (even though the actual journal row stays SINGLE). BEGIN IMMEDIATE (SQLite) / row
// locking + a single transaction (Postgres) close this window: the second worker's SELECT sees the
// FIRST worker's commit → the delta is correct. Only SQLite (real file, 2 connections) + Postgres
// (pg-mem) — these two are this task's scope.
describe('§T1(e) double-put on the same NEW key — gnl_runs counter DOES NOT DOUBLE-INCREMENT', () => {
  it('Sqlite two connections: concurrent put(same new tool key) → toolCalls exactly 1, entry exactly 1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gnl-mw-t1put-sqlite-'));
    const p = join(dir, 'mw.db');
    const a = new SqliteStorage(p);
    const b = new SqliteStorage(p); // SEPARATE node:sqlite connection, SAME file
    try {
      const runId = 't1race';
      const key = `${runId}:tool:call-x`;
      // TWO workers put concurrently to the same key — the last one wins (UPSERT), but the gnl_runs.toolCalls
      // counter could have been 2 BEFORE THE FIX (if both saw prev=none). It must now be exactly 1.
      await Promise.all([
        a.runs.put(key, { status: 'succeeded', output: 'from-a' }),
        b.runs.put(key, { status: 'succeeded', output: 'from-b' }),
      ]);
      const entries = await a.runs.readRun(runId);
      expect(entries.length).toBe(1); // same key → a single journal row
      const page = await a.runs.listRuns();
      const run = page.items.find((r) => r.runId === runId)!;
      expect(run.toolCalls).toBe(1); // NO DOUBLE-COUNTING (pre-fix risk: 2)
      expect(run.modelSteps).toBe(0);
    } finally {
      await a.close();
      await b.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Postgres (pg-mem) shared pool: concurrent put(same new model key) — HONESTY NOTE: pg-mem CANNOT PROVE THIS', async () => {
    // pg-mem NOTE (experimentally verified — see the tx() JSDoc in postgres-storage.ts): if two clients
    // BEGIN and write INSERT...ON CONFLICT DO UPDATE to the same row, pg-mem executes one IMMEDIATELY
    // WITHOUT WAITING for the other's commit (no real row-level lock/blocking) → lockRunRow's serializing
    // effect CANNOT BE OBSERVED in pg-mem; the counter here CAN GO UP TO 2 (not a code bug, a test-environment
    // fidelity limit). Proof of serialization on a real engine: the 'T1' test in integration-real.test.ts
    // (GNL_INTEGRATION=1, real PG). Here we only verify the invariant pg-mem CAN also provide: same key → a
    // single journal row.
    const { Pool } = newDb().adapters.createPg();
    const s = new PostgresStorage({ pool: new Pool() });
    await s.init();
    try {
      const runId = 't1race-pg';
      const key = `${runId}:model:0`;
      await Promise.all([
        s.runs.put(key, { text: 'from-a' }),
        s.runs.put(key, { text: 'from-b' }),
      ]);
      const entries = await s.runs.readRun(runId);
      expect(entries.length).toBe(1); // same key → a single journal row (true in pg-mem too)
      const page = await s.runs.listRuns();
      const run = page.items.find((r) => r.runId === runId)!;
      expect(run.modelSteps).toBeGreaterThanOrEqual(1); // can be 2 in pg-mem (see note above) — exactly 1 on real PG
      expect(run.toolCalls).toBe(0);
    } finally {
      await s.close();
    }
  });
});

// ── (f) T1 — suspended entry write + derived-index consistency ──────────────────────────────────────
// H7/retention risk: if the gnl_runs.suspended field isn't updated at the same moment a suspended tool
// record is written (a crash or an autocommit intermediate window), retention (sweepRuns → listStaleRuns,
// includeSuspended=false) could WRONGLY delete a suspended run. Here, IMMEDIATELY after put() returns —
// even from a SECOND connection/pool — we verify the derived index is ALREADY correct (suspended=true);
// i.e. there is no observable intermediate state between the journal row and gnl_runs (both are COMMITted
// in a single transaction).
describe('§T1(f) suspended entry write — derived index (gnl_runs.suspended) consistency', () => {
  it('Sqlite: a suspended tool record → a DIFFERENT connection immediately sees listRuns status=suspended; drops on transition to succeeded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gnl-mw-t1susp-sqlite-'));
    const p = join(dir, 'mw.db');
    const a = new SqliteStorage(p);
    const b = new SqliteStorage(p); // observer: different connection, same file
    try {
      const runId = 't1susp';
      const key = `${runId}:tool:call-x`;
      await a.runs.put(key, { status: 'suspended', reason: 'awaiting-approval' });
      // NOT the writing connection but the SECOND connection reads — it must see the committed CONSISTENT state.
      const page1 = await b.runs.listRuns();
      const run1 = page1.items.find((r) => r.runId === runId)!;
      expect(run1.status).toBe('suspended');
      expect(run1.toolCalls).toBe(1);

      // Transition from suspended to approved: overwriting the same key with 'succeeded' should drop suspended.
      await a.runs.put(key, { status: 'succeeded', output: 'ok' });
      const page2 = await b.runs.listRuns();
      const run2 = page2.items.find((r) => r.runId === runId)!;
      expect(run2.status).toBe('completed');
      expect(run2.toolCalls).toBe(1); // still a single entry — overwriting does NOT open a new row
    } finally {
      await a.close();
      await b.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Postgres (pg-mem): a suspended tool record → listRuns status=suspended is instantly consistent; drops on transition to succeeded', async () => {
    const { Pool } = newDb().adapters.createPg();
    const s = new PostgresStorage({ pool: new Pool() });
    await s.init();
    try {
      const runId = 't1susp-pg';
      const key = `${runId}:tool:call-x`;
      await s.runs.put(key, { status: 'suspended', reason: 'awaiting-approval' });
      const page1 = await s.runs.listRuns();
      const run1 = page1.items.find((r) => r.runId === runId)!;
      expect(run1.status).toBe('suspended');
      expect(run1.toolCalls).toBe(1);

      await s.runs.put(key, { status: 'succeeded', output: 'ok' });
      const page2 = await s.runs.listRuns();
      const run2 = page2.items.find((r) => r.runId === runId)!;
      expect(run2.status).toBe('completed');
      expect(run2.toolCalls).toBe(1);
    } finally {
      await s.close();
    }
  });
});
