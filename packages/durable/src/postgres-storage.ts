// @gnldev/durable/postgres — Postgres implementation of all store ports (prod default).
// Same schema/semantics as SqliteStorage; pg async API ($N placeholders, CAS detection via RETURNING).
// Injectable pool pattern → zero-infra testing with pg-mem. `pg` is an optional peer dep.
// Vector is 'scan' for now (brute-force cosine; pgvector deferred — pg-mem compatibility + lean first cut).
import { createRequire } from 'node:module';
import { cosineSimilarity } from 'ai';
import { runIdOfKey, parseJournalKey, outcomeStatusOf, deriveRunStatus } from './journal.js';
import type { JournalBatch, JournalEntry, RunSummary, ToolJournalRecord } from './journal.js';
import { serialize, deserialize } from './serialize.js';
import { matchFilter } from './storage.js';
import type {
  Storage, CapabilityMatrix, Page, ListQuery,
  RunJournal, MemoryStore, VectorStore, WorkStore, CacheStore, MetaStore,
  ThreadRecord, MessageRecord, Observation, RecallOptions, VectorItem, VectorMatch, LogRecord,
} from './storage.js';
// P2-migrate schema introspection/migration façade — see migrate.ts's header.
import { tablesFromDDL } from './migrate.js';
import type { SchemaCheckResult, SchemaMigrationResult, MissingColumn } from './migrate.js';

type QueryResult = { rows: any[]; rowCount?: number | null };
type PoolClient = { query: (sql: string, params?: unknown[]) => Promise<QueryResult>; release?: (destroy?: boolean) => void };
type Pool = {
  query: (sql: string, params?: unknown[]) => Promise<QueryResult>;
  connect?: () => Promise<PoolClient>;
  end?: () => Promise<void>;
  /** EventEmitter surface — `pg` emits 'error' on idle clients; see the constructor. */
  on?: (event: 'error', listener: (err: Error) => void) => unknown;
  listenerCount?: (event: string) => number;
};
const SCHEMA_VERSION = '1';

export interface PostgresStorageOptions {
  connectionString?: string;
  pool?: Pool;
}

function offset(q?: ListQuery) { return { start: q?.cursor ? Number(q.cursor) || 0 : 0, limit: q?.limit ?? 50 }; }
function pageOf<T>(rows: T[], start: number, limit: number, total: number): Page<T> {
  const next = start + limit;
  return { items: rows, nextCursor: next < total ? String(next) : undefined };
}
// P1.5 matchFilter is now shared (storage.ts) — see its JSDoc for the operator
// Subset ($eq/$ne/$gt/$gte/$lt/$lte/$in/$nin). Import above (was a local exact-equality-only copy).
function normRange(r?: number | { before: number; after: number }) {
  if (r == null) return { before: 0, after: 0 };
  return typeof r === 'number' ? { before: r, after: r } : r;
}
const hasNorm = (v?: number[] | null): v is number[] => !!v && v.some((x) => x !== 0);

const DDL = [
  `CREATE TABLE IF NOT EXISTS gnl_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS gnl_run_journal (key TEXT PRIMARY KEY, run_id TEXT, kind TEXT, suspended BOOLEAN NOT NULL DEFAULT false, value TEXT NOT NULL, created_at BIGINT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS gnl_run_journal_run ON gnl_run_journal (run_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS gnl_runs (run_id TEXT PRIMARY KEY, model_steps INTEGER NOT NULL DEFAULT 0, tool_calls INTEGER NOT NULL DEFAULT 0, suspended BOOLEAN NOT NULL DEFAULT false, suspended_count INTEGER NOT NULL DEFAULT 0, failed BOOLEAN NOT NULL DEFAULT false, running BOOLEAN NOT NULL DEFAULT false, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS gnl_runs_updated ON gnl_runs (updated_at)`,
  // H11b migration: add the column if missing in an old setup (backfill once at init, below).
  `ALTER TABLE gnl_runs ADD COLUMN IF NOT EXISTS suspended_count INTEGER NOT NULL DEFAULT 0`,
  // `failed`: materialized at write time rather than derived at read time (no index — the status
  // Filter is an operator path, not a hot one), because filtering on the serialized outcome
  // Value would mean matching the word 'failed' inside error MESSAGES. Nothing to backfill — a run
  // Written before outcomes existed has none, and false reads exactly as it did before.
  `ALTER TABLE gnl_runs ADD COLUMN IF NOT EXISTS failed BOOLEAN NOT NULL DEFAULT false`,
  // `running` (the write-ahead half): same shape, same no-backfill argument as `failed` above.
  `ALTER TABLE gnl_runs ADD COLUMN IF NOT EXISTS running BOOLEAN NOT NULL DEFAULT false`,
  `CREATE TABLE IF NOT EXISTS gnl_counters (key TEXT NOT NULL, field TEXT NOT NULL, value DOUBLE PRECISION NOT NULL, PRIMARY KEY (key, field))`,
  `CREATE INDEX IF NOT EXISTS gnl_runs_created ON gnl_runs (created_at, run_id)`,
  `CREATE TABLE IF NOT EXISTS gnl_threads (id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, title TEXT, parent_thread_id TEXT, metadata TEXT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, deleted_at BIGINT)`,
  `CREATE INDEX IF NOT EXISTS gnl_threads_res ON gnl_threads (resource_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS gnl_messages (thread_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL, text TEXT, embedding TEXT, metadata TEXT, ts BIGINT NOT NULL, message TEXT NOT NULL, PRIMARY KEY (thread_id, seq))`,
  `CREATE TABLE IF NOT EXISTS gnl_working_memory (scope_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS gnl_observations (thread_id TEXT PRIMARY KEY, obs TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS gnl_vectors (id TEXT PRIMARY KEY, text TEXT NOT NULL, embedding TEXT NOT NULL, metadata TEXT, created_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS gnl_work_log (ns TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, ts BIGINT NOT NULL, PRIMARY KEY (ns, id))`,
  `CREATE INDEX IF NOT EXISTS gnl_work_log_ns ON gnl_work_log (ns, ts)`,
  `CREATE TABLE IF NOT EXISTS gnl_work_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS gnl_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at BIGINT)`,
];

export class PostgresStorage implements Storage {
  /** H10a: deployment durability report (delegates to the runs journal — see PgRunJournal.durabilityReport). */
  durabilityReport() { return (this.runs as any).durabilityReport() as ReturnType<any>; }

  readonly name = 'postgres';
  readonly capabilities: CapabilityMatrix = { runs: 'full', memory: 'full', vectors: 'scan', work: 'full', cache: 'ttl' };
  private _pool: Pool;
  /**
   * The underlying connection pool. Exposed so COMPANION stores that live in the SAME Postgres
   * Database can share this exact pool — notably `@gnldev/auth-ee`'s `createPostgresUserStore(storage.pool)`,
   * Which puts admin/developer accounts in their own `gnl_ee_*` tables next to the run journal.
   */
  get pool(): Pool { return this._pool; }
  private ready?: Promise<void>;
  readonly runs: RunJournal;
  readonly memory: MemoryStore;
  readonly vectors: VectorStore;
  readonly work: WorkStore;
  readonly cache: CacheStore;
  readonly meta: MetaStore;

  constructor(opts: PostgresStorageOptions = {}) {
    if (opts.pool) this._pool = opts.pool;
    else {
      const { Pool } = createRequire(import.meta.url)('pg') as { Pool: new (c: any) => Pool };
      this._pool = new Pool(opts.connectionString ? { connectionString: opts.connectionString } : {});
    }
    // `pg` emits 'error' on IDLE clients — a server restart, a failover, a scale-to-zero, a PgBouncer
    // idle reap. An EventEmitter 'error' with no listener is an uncaught exception, so without this
    // the host process DIES, and it dies where no try/catch around a call site can reach: the pool is
    // idle, nobody is awaiting it. Measured: `docker restart` on the database took down a plain
    // `@hono/node-server` process behind ~200 lines of dumped Client internals.
    //
    // The right behaviour is to say so and carry on. `pg` evicts the broken client itself and the
    // next checkout opens a fresh connection; in-flight queries still reject at their own call sites,
    // which is where a caller can actually handle them. Attached only when no listener exists, so a
    // caller who passed their own pool and their own handler keeps theirs.
    if (this._pool.on && this._pool.listenerCount?.('error') === 0) {
      this._pool.on('error', (err: Error) => {
        console.error(
          `@gnldev/durable: postgres pool error on an idle connection — ${err.message}. ` +
            'The pool drops that connection and reconnects on the next query; in-flight queries reject ' +
            'at their call sites. This is logged rather than thrown because an unhandled pool error ' +
            'would terminate the process.',
        );
      });
    }
    const q = (sql: string, p?: unknown[]) => this.ensureReady().then(() => this._pool.query(sql, p));
    // T1 audit fix — transaction helper: all queries inside fn run within BEGIN/COMMIT (error →
    // ROLLBACK) on a SINGLE client checked out from the pool. `pool.query('BEGIN')` on a pg Pool is
    // UNSAFE (each query can go to a different connection) → connect pins the client.
    // Lower-fidelity fallbacks (behavior = old autocommit, test-only):
    // if pool.connect is missing (minimal injected pool): no transaction, queries run sequentially via pool.query.
    // pg-mem: accepts BEGIN/COMMIT/ROLLBACK but ROLLBACK does NOT actually UNDO (verified
    //     Experimentally) → no proof of atomicity under pg-mem; real atomicity proof is in integration-real.test.ts.
    const tx = async <T>(fn: (q: Q) => Promise<T>): Promise<T> => {
      await this.ensureReady();
      if (typeof this._pool.connect !== 'function') return fn((s, p) => this._pool.query(s, p));
      const client = await this._pool.connect();
      let inTx = false;
      let destroy = false;
      try {
        try { await client.query('BEGIN'); inTx = true; } catch { /* transaction not supported → proceed unwrapped */ }
        const out = await fn((s, p) => client.query(s, p));
        if (inTx) await client.query('COMMIT');
        return out;
      } catch (e) {
        if (inTx) { try { await client.query('ROLLBACK'); } catch { destroy = true; /* client in an uncertain state must not return to the pool */ } }
        throw e;
      } finally {
        client.release?.(destroy);
      }
    };
    this.runs = new PgRunJournal(q, tx);
    this.memory = new PgMemoryStore(q);
    this.vectors = new PgVectorStore(q);
    this.work = new PgWorkStore(q);
    this.cache = new PgCacheStore(q);
    this.meta = new PgMetaStore(q);
  }
  private ensureReady(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        // `CREATE TABLE IF NOT EXISTS` is not safe against a concurrent copy of itself. Two sessions
        // Both pass the existence check, both proceed, and the loser dies inside Postgres' catalog
        // With `duplicate key value violates unique constraint "pg_type_typname_nsp_index"` — a
        // Message about an internal index, offering the reader nothing to act on.
        //
        // Measured, not theorised: two PostgresStorage instances opened against a fresh database in
        // The same moment, one of them rejected exactly like that. Which is the shape of a fleet
        // Boot — several instances starting together against a database that was created minutes
        // Ago, the normal case on a managed platform that scales by adding copies.
        //
        // A session-level advisory lock serialises the whole block: the first arrival creates the
        // Schema, the others wait and then find it already there. The key is an arbitrary constant,
        // Scoped to this database and to us; `pg_advisory_lock` blocks rather than failing, so no
        // Caller has to retry. Released in `finally` — an error during DDL must not leave every
        // Other instance waiting forever.
        // Best-effort, not required. The key is inlined rather than bound: a parameter makes the
        // Argument's type ambiguous and picks the `text` overload, which does not exist. And a
        // Backend without advisory locks at all — pg-mem, which this suite runs most of its Postgres
        // Tests against — must still come up: it has no second writer to race with, so losing the
        // Lock costs it nothing. Failing here instead would trade a rare boot race for a certain one.
        const locked = await this._pool.query('SELECT pg_advisory_lock(47110001)').then(() => true, () => false);
        try {
          for (const sql of DDL) await this._pool.query(sql);
          await this._pool.query(`INSERT INTO gnl_meta (k, v) VALUES ('schema_version', $1) ON CONFLICT (k) DO NOTHING`, [SCHEMA_VERSION]);
        } finally {
          if (locked) await this._pool.query('SELECT pg_advisory_unlock(47110001)').catch(() => {});
        }
      })();
    }
    return this.ready;
  }
  async init() { await this.ensureReady(); }
  async close() { if (this._pool.end) await this._pool.end(); }

  /**
   * H12: reclaiming deleted space. In Postgres, autovacuum AUTOMATICALLY moves dead rows to the
   * Freelist (reused → no unbounded growth); this method triggers it manually. The default `VACUUM`
   * Does NOT LOCK but does NOT RETURN disk to the OS either (keeps it in the freelist — subsequent
   * Writes reuse it). To actually reclaim disk, use `{ full: true }` → `VACUUM FULL`: this LOCKS the
   * Table + temporarily needs 2× disk → only during a maintenance window. Postgres doesn't expose file
   * Size via the API → reclaimedBytes = -1 (unknown).
   */
  async compact(opts?: { full?: boolean }): Promise<{ reclaimedBytes: number }> {
    const tables = ['gnl_run_journal', 'gnl_runs', 'gnl_messages', 'gnl_work_log', 'gnl_vectors'];
    for (const t of tables) {
      await this.ensureReady();
      await this._pool.query(`VACUUM ${opts?.full ? 'FULL ' : ''}${t}`); // FULL: ACCESS EXCLUSIVE lock
    }
    return { reclaimedBytes: -1 };
  }

  /**
   * P2-migrate connectionless — the exact DDL array `ensureReady()` executes
   * (already includes the H11b `suspended_count` ALTER, see the DDL const above). For CI schema diffing
   * Or an out-of-band migration script.
   */
  exportSchema(): string[] {
    return [...DDL];
  }

  /**
   * P2-migrate: READ-ONLY dry-run against information_schema — deliberately bypasses `this.q`/
   * `ensureReady()` (unlike every other method on this class) so calling it does NOT auto-create the
   * Schema first. That's what makes "disable auto-init, run checkSchema/migrateSchema out-of-band"
   * Actually work for Postgres: `ensureReady` is already lazy (only `this.q`-routed calls trigger it), so
   * Simply not routing through it is enough — no constructor change needed. Never mutates.
   */
  async checkSchema(): Promise<SchemaCheckResult> {
    const expected = tablesFromDDL(DDL);
    const tRes = await this._pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()`);
    const liveTables = new Set(
      (tRes.rows as { table_name: string }[]).map((r) => r.table_name).filter((t) => t.startsWith('gnl_')),
    );
    const cRes = await this._pool.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()`);
    const liveCols = new Map<string, Set<string>>();
    for (const row of cRes.rows as { table_name: string; column_name: string }[]) {
      if (!row.table_name.startsWith('gnl_')) continue;
      if (!liveCols.has(row.table_name)) liveCols.set(row.table_name, new Set());
      liveCols.get(row.table_name)!.add(row.column_name);
    }
    const missingTables: string[] = [];
    const missingColumns: MissingColumn[] = [];
    for (const [table, cols] of expected) {
      if (!liveTables.has(table)) { missingTables.push(table); continue; }
      const have = liveCols.get(table) ?? new Set<string>();
      for (const col of cols.keys()) if (!have.has(col)) missingColumns.push({ table, column: col });
    }
    const unknownTables = [...liveTables].filter((t) => !expected.has(t));
    return { ok: missingTables.length === 0 && missingColumns.length === 0, missingTables, missingColumns, unknownTables };
  }

  /**
   * P2-migrate: applies exactly the gap checkSchema reports (same additive-only contract as
   * SqliteStorage.migrateSchema — never drops/renames, see migrate.ts's header). Also bypasses
   * `this.q`/`ensureReady()` — queries `this._pool` directly so it never implicitly runs the full DDL
   * First. `dryRun: true` returns the statements it WOULD run without touching the DB.
   */
  async migrateSchema(opts?: { dryRun?: boolean }): Promise<SchemaMigrationResult> {
    const check = await this.checkSchema();
    const expected = tablesFromDDL(DDL);
    const statements: string[] = [];
    for (const table of check.missingTables) {
      for (const stmt of DDL) {
        if (new RegExp(`^CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i').test(stmt)
          || new RegExp(`^CREATE INDEX IF NOT EXISTS \\S+ ON ${table}\\b`, 'i').test(stmt)) {
          statements.push(stmt);
        }
      }
    }
    for (const { table, column } of check.missingColumns) {
      const def = expected.get(table)?.get(column);
      if (def) statements.push(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${def}`);
    }
    if (opts?.dryRun) return { statements, dryRun: true };
    for (const stmt of statements) await this._pool.query(stmt);
    return { statements, dryRun: false };
  }
}

type Q = (sql: string, params?: unknown[]) => Promise<QueryResult>;
/** Number of rows inserted: real pg rowCount (0 on a DO NOTHING conflict); pg-mem fallback is rows.length. */
const inserted1 = (r: QueryResult) => (r.rowCount ?? r.rows.length) === 1;

type Tx = <T>(fn: (q: Q) => Promise<T>) => Promise<T>;

class PgRunJournal implements RunJournal {
  constructor(private q: Q, private tx: Tx) {}
  async get<T = unknown>(key: string): Promise<T | undefined> {
    const r = await this.q('SELECT value FROM gnl_run_journal WHERE key = $1', [key]);
    return r.rows[0] ? deserialize<T>(r.rows[0].value) : undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    const p = parseJournalKey(key);
    const suspended = p?.kind === 'tool' && (value as ToolJournalRecord | undefined)?.status === 'suspended';
    const upsert = (q: Q) => q(
      `INSERT INTO gnl_run_journal (key, run_id, kind, suspended, value, created_at) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, suspended = EXCLUDED.suspended`,
      [key, p?.runId ?? null, p?.kind ?? null, !!suspended, serialize(value), Date.now()],
    );
    if (!p) {
      // Not a replayable entry (no run_id / no kind in the journal table — readRun and time-travel must
      // Not start seeing it), but it may still BELONG to a run. Register the run itself, or one that died
      // Before its first model step never appears in listRuns and is never reached by sweepRuns — its
      // Persisted prompt then outlives every retention window.
      const owner = runIdOfKey(key, value);
      const oc = outcomeStatusOf(key, value);
      if (!owner && oc === null) { await upsert(this.q); return; } // genuinely run-less key
      await this.tx(async (q) => {
        await upsert(q);
        if (owner) await this.touchRunDelta(q, owner, null, false, 0);
        // Own path, not riding on run ownership (see the sqlite twin). The UPDATE only touches an
        // Existing row, so it cannot invent a run. Both flags from ONE status in ONE statement, so
        // They can never disagree — and every transition clears its predecessor.
        if (oc !== null) {
          const runId = key.slice(0, -':outcome'.length);
          await q(`UPDATE gnl_runs SET failed = $1, running = $2 WHERE run_id = $3`, [oc === 'failed', oc === 'running', runId]);
        }
      });
      return;
    }
    // T1 audit fix: SELECT prev → journal UPSERT → gnl_runs delta triple, all in ONE transaction.
    // Under autocommit there were two hazards: (1) two workers on the same NEW key both see prev=none →
    // The counter double-increments; (2) a crash between the suspended write and the gnl_runs update →
    // Stale suspended=false → retention could delete a suspended run. The transaction ALONE does NOT
    // FIX (1) (under READ COMMITTED both txns still read prev=none from the old snapshot) → first
    // LockRunRow: writers to the same run get SERIALIZED on the gnl_runs row lock, so the second txn's
    // SELECT sees the committed prev. H11b's O(1) incremental update (touchRunDelta) is preserved as-is.
    await this.tx(async (q) => {
      await this.lockRunRow(q, p.runId);
      const prev = (await q('SELECT suspended FROM gnl_run_journal WHERE key = $1', [key])).rows[0];
      await upsert(q);
      const delta = (suspended ? 1 : 0) - (prev?.suspended ? 1 : 0);
      await this.touchRunDelta(q, p.runId, p.kind, prev === undefined, delta);
    });
  }
  async putIfAbsent(key: string, value: unknown): Promise<boolean> {
    const p = parseJournalKey(key);
    const suspended = p?.kind === 'tool' && (value as ToolJournalRecord | undefined)?.status === 'suspended';
    const ins = (q: Q) => q(
      `INSERT INTO gnl_run_journal (key, run_id, kind, suspended, value, created_at) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (key) DO NOTHING RETURNING key`,
      [key, p?.runId ?? null, p?.kind ?? null, !!suspended, serialize(value), Date.now()],
    );
    if (!p) {
      const owner = runIdOfKey(key, value);
      const oc = outcomeStatusOf(key, value);
      if (!owner && oc === null) return inserted1(await ins(this.q)); // genuinely run-less key
      return await this.tx(async (q) => {
        const ok = inserted1(await ins(q));
        if (ok) {
          if (owner) await this.touchRunDelta(q, owner, null, false, 0);
          // First outcome write arrives via putIfAbsent (monotonic recordRunOutcome) — see sqlite twin.
          if (oc !== null) await q(`UPDATE gnl_runs SET failed = $1, running = $2 WHERE run_id = $3`, [oc === 'failed', oc === 'running', key.slice(0, -':outcome'.length)]);
        }
        return ok;
      });
    }
    // T1: INSERT + touchRunDelta in a single transaction (closes the crash window). lockRunRow uses the
    // SAME lock order as put() (gnl_runs first, then the journal row) → no deadlock possibility between put/putIfAbsent.
    return this.tx(async (q) => {
      await this.lockRunRow(q, p.runId);
      const inserted = inserted1(await ins(q));
      if (inserted) await this.touchRunDelta(q, p.runId, p.kind, true, suspended ? 1 : 0); // fresh insert → O(1)
      return inserted;
    });
  }
  /**
   * H1: atomic conditional replace (expired run-lock takeover, see journal.ts JSDoc).
   * Stored form is the same as SQLite: PLAIN serialize() TEXT (no envelope) → comparison happens
   * Directly in SQL via `WHERE key=$ AND value=serialize(expected)`; if the affected row count is 1, we won.
   * The superjson roundtrip stability assumption is the same as the note in SQLite — a mismatch = false = the safe side.
   * NOTE: pg-mem faithfully reports UPDATE rowCount (unlike the RETURNING limitation) → verified in conformance;
   * The real PG proof is in integration-real.test.ts.
   */
  async putIfMatch(key: string, expected: unknown, value: unknown): Promise<boolean> {
    const p = parseJournalKey(key);
    const suspended = p?.kind === 'tool' && (value as ToolJournalRecord | undefined)?.status === 'suspended';
    const upd = (q: Q) => q(
      'UPDATE gnl_run_journal SET value = $1, suspended = $2 WHERE key = $3 AND value = $4',
      [serialize(value), !!suspended, key, serialize(expected)],
    );
    if (!p) {
      const oc = outcomeStatusOf(key, value);
      if (oc === null) return Number((await upd(this.q)).rowCount ?? 0) === 1; // ':lock' etc. → no derived index
      return await this.tx(async (q) => {
        const ok = Number((await upd(q)).rowCount ?? 0) === 1;
        if (ok) await q(`UPDATE gnl_runs SET failed = $1, running = $2 WHERE run_id = $3`, [oc === 'failed', oc === 'running', key.slice(0, -':outcome'.length)]);
        return ok;
      });
    }
    // T1: UPDATE + recountRun in one transaction (closes the crash → stale gnl_runs window). There is NO
    // LockRunRow here — so a failed match doesn't create a phantom row in gnl_runs (the lock order stays
    // Journal→runs; a theoretical deadlock with put requires the rare path × the same key, and PG detects
    // It and aborts one → the caller sees an error, the takeover just doesn't happen that round = the safe side).
    return this.tx(async (q) => {
      const ok = Number((await upd(q)).rowCount ?? 0) === 1;
      if (ok) await this.recountRun(q, p.runId); // rare path (takeover) → a full recount is safe and sufficient
      return ok;
    });
  }

  /** H8a: in-engine atomic counter (UPSERT arithmetic) — lost-update is impossible, hot-row lock is short. */
  async incrBy(key: string, fields: Record<string, number>): Promise<void> {
    for (const [f, d] of Object.entries(fields)) {
      await this.q(
        'INSERT INTO gnl_counters (key, field, value) VALUES ($1, $2, $3) ON CONFLICT (key, field) DO UPDATE SET value = gnl_counters.value + EXCLUDED.value',
        [key, f, d],
      );
    }
  }
  async getCounters(key: string): Promise<Record<string, number> | undefined> {
    const r = await this.q('SELECT field, value FROM gnl_counters WHERE key = $1', [key]);
    if (!r.rows.length) return undefined;
    return Object.fromEntries(r.rows.map((row: any) => [row.field, Number(row.value)]));
  }

  /**
   * H10a — DURABILITY REPORT: queries the setup ITSELF for the precondition of exactly-once ("an
   * Acked write is never lost"). In multi-server production, asynchronous replication = a lost-write
   * Window on failover = exactly-once CAN BE VIOLATED (see the core-hardening review) — this method surfaces
   * That before the run starts. A single node (no replica) is safe for a single worker; noted as such.
   */
  async durabilityReport(): Promise<{
    syncCommit: string;
    standbyNames: string;
    connectedStandbys: number;
    syncStandbys: number;
    safeForFailover: boolean;
    notes: string[];
  }> {
    const one = async (sql: string): Promise<string> => String((await this.q(sql)).rows[0]?.v ?? '');
    const syncCommit = await one("SELECT setting AS v FROM pg_settings WHERE name = 'synchronous_commit'");
    const standbyNames = await one("SELECT setting AS v FROM pg_settings WHERE name = 'synchronous_standby_names'");
    let connectedStandbys = 0;
    let syncStandbys = 0;
    try {
      const r = await this.q("SELECT COUNT(*) AS c, COUNT(*) FILTER (WHERE sync_state = 'sync') AS s FROM pg_stat_replication");
      connectedStandbys = Number(r.rows[0]?.c ?? 0);
      syncStandbys = Number(r.rows[0]?.s ?? 0);
    } catch {
      // If we lack view permission, assume 0 (noted in notes)
    }
    const notes: string[] = [];
    const syncOn = !['off', 'local'].includes(syncCommit);
    let safeForFailover = false;
    if (connectedStandbys === 0) {
      notes.push('No replica (single node): no failover scenario; sufficient for single-worker/single-node. Add a synchronous standby for multi-server production.');
    } else if (!syncOn || standbyNames.trim() === '') {
      notes.push(`ASYNCHRONOUS replication detected (synchronous_commit=${syncCommit}, standby_names='${standbyNames}') — acked CAS writes MAY BE LOST on primary failover → exactly-once can be violated. Set synchronous_commit=on + synchronous_standby_names (see README deployment notes).`);
    } else if (syncStandbys === 0) {
      notes.push('Synchronous config is present but no standby is currently in SYNC state — check replication health.');
    } else {
      safeForFailover = true;
      notes.push(`Synchronous replication active (${syncStandbys} sync standby): acked writes survive failover — live proof: test/failover-real.test.ts.`);
    }
    return { syncCommit, standbyNames, connectedStandbys, syncStandbys, safeForFailover, notes };
  }

  /** H8b: indexed age query for sweepRuns (gnl_runs.updated_at) — without transferring entries. */
  async listStaleRuns(cutoffTs: number, opts?: { includeSuspended?: boolean }): Promise<string[]> {
    const sql = opts?.includeSuspended
      ? 'SELECT run_id FROM gnl_runs WHERE updated_at < $1'
      : 'SELECT run_id FROM gnl_runs WHERE updated_at < $1 AND suspended = false';
    const r = await this.q(sql, [cutoffTs]);
    return r.rows.map((row: any) => row.run_id);
  }

  /** H8c: cheap run statistics — COUNT + SUM(length(value)) (without transferring data). */
  async readRunStats(runId: string): Promise<{ entries: number; bytes: number }> {
    const r = await this.q(
      'SELECT COUNT(*) AS c, COALESCE(SUM(LENGTH(value)), 0) AS b FROM gnl_run_journal WHERE run_id = $1',
      [runId],
    );
    return { entries: Number(r.rows[0].c), bytes: Number(r.rows[0].b) };
  }
  /** H2: the storage's own clock (epoch ms) — lock TTL decisions become independent of worker clock-skew. */
  async now(): Promise<number> {
    const r = await this.q(`SELECT (extract(epoch from now())*1000)::bigint AS ms`);
    return Number(r.rows[0].ms);
  }
  /**
   * T1: row lock that serializes concurrent writers to the same run — locks the gnl_runs row
   * (creating it if missing) via ON CONFLICT DO UPDATE (even a no-op update takes a row lock);
   * Held until the end of the transaction. On rollback the created row is also undone → no phantom run remains.
   */
  private async lockRunRow(q: Q, runId: string): Promise<void> {
    const now = Date.now();
    await q(
      `INSERT INTO gnl_runs (run_id, model_steps, tool_calls, suspended, suspended_count, created_at, updated_at)
       VALUES ($1,0,0,false,0,$2,$3)
       ON CONFLICT (run_id) DO UPDATE SET updated_at = gnl_runs.updated_at`,
      [runId, now, now],
    );
  }

  /** H11b — O(1) incremental gnl_runs update (hot path; details: sqlite-storage.ts's equivalent method). */
  private async touchRunDelta(q: Q, runId: string, kind: 'model' | 'tool' | null, isInsert: boolean, suspendedDelta: number): Promise<void> {
    const m = isInsert && kind === 'model' ? 1 : 0;
    const t = isInsert && kind === 'tool' ? 1 : 0;
    const now = Date.now();
    await q(
      `INSERT INTO gnl_runs (run_id, model_steps, tool_calls, suspended, suspended_count, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (run_id) DO UPDATE SET
         model_steps = gnl_runs.model_steps + $8,
         tool_calls = gnl_runs.tool_calls + $9,
         suspended_count = gnl_runs.suspended_count + $10,
         suspended = (gnl_runs.suspended_count + $10) > 0,
         updated_at = $11`,
      [runId, m, t, suspendedDelta > 0, Math.max(0, suspendedDelta), now, now, m, t, suspendedDelta, now],
    );
  }

  /** Full recount — for rare paths (putIfMatch/repair). */
  private async recountRun(q: Q, runId: string): Promise<void> {
    const c = (await q(
      `SELECT SUM(CASE WHEN kind='model' THEN 1 ELSE 0 END) AS m, SUM(CASE WHEN kind='tool' THEN 1 ELSE 0 END) AS t,
              SUM(CASE WHEN suspended THEN 1 ELSE 0 END) AS s, MIN(created_at) AS c0 FROM gnl_run_journal WHERE run_id = $1`,
      [runId],
    )).rows[0];
    await q(
      `INSERT INTO gnl_runs (run_id, model_steps, tool_calls, suspended, suspended_count, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (run_id) DO UPDATE SET model_steps=EXCLUDED.model_steps, tool_calls=EXCLUDED.tool_calls, suspended=EXCLUDED.suspended, suspended_count=EXCLUDED.suspended_count, updated_at=EXCLUDED.updated_at`,
      [runId, Number(c.m) || 0, Number(c.t) || 0, Number(c.s) > 0, Number(c.s) || 0, Number(c.c0) || Date.now(), Date.now()],
    );
  }
  async listKeys(prefix: string): Promise<string[]> {
    // Sargable range scan (uses the PK index) — LIKE 'prefix%' would fall back to a seq scan under the default collation.
    // Same upper bound as the SQLite approach: prefix + '￿'.
    const r = await this.q(`SELECT key FROM gnl_run_journal WHERE key >= $1 AND key < $2 ORDER BY created_at`, [prefix, prefix + '￿']);
    return r.rows.map((x) => x.key);
  }

  /** Retention/GDPR: PERMANENTLY delete keys starting with a prefix; also clean up the derived gnl_runs index. */
  async deletePrefix(prefix: string): Promise<number> {
    const r = await this.q('DELETE FROM gnl_run_journal WHERE key >= $1 AND key < $2', [prefix, prefix + '￿']);
    const rid = prefix.endsWith(':') ? prefix.slice(0, -1) : prefix;
    await this.q('DELETE FROM gnl_runs WHERE run_id = $1 OR (run_id >= $2 AND run_id < $3)', [rid, prefix, prefix + '￿']);
    // Counters (incrBy/H8a) are keys too — see the sqlite-storage.ts deletePrefix note (GDPR org purge
    // + rebuildMetrics correctness). Not included in the return count, same as the gnl_runs rows.
    await this.q('DELETE FROM gnl_counters WHERE key >= $1 AND key < $2', [prefix, prefix + '￿']);
    return r.rowCount ?? 0;
  }
  async readRun(runId: string): Promise<JournalEntry[]> {
    // Decision #4: `key` tie-breaker — Postgres does NOT GUARANTEE order for equal ORDER BY keys; records
    // Written within the same ms (parallel tool-calls) could otherwise shuffle position between reads. Same semantics as SQLite.
    const r = await this.q('SELECT key, kind, value, created_at FROM gnl_run_journal WHERE run_id = $1 ORDER BY created_at, key', [runId]);
    return r.rows.map((x, seq) => ({ key: x.key, runId, kind: x.kind as JournalEntry['kind'], value: deserialize(x.value), seq, ts: Number(x.created_at) }));
  }
  /**
   * AUDIT (threadId first-class): SAME purpose as the SQLite equivalent — the `<run_id>:input` row is
   * Embedded into a SINGLE query (NOT an N+1 round-trip). LEFT JOIN INSTEAD OF a correlated subquery:
   * Pg-mem (test-only in-memory Postgres) does NOT SUPPORT a correlated subquery that references the
   * Outer alias ("column r.run_id does not exist") — a LEFT JOIN is planned equivalently (and usually
   * Faster) on real Postgres too, same behavior. `||` is the string concat operator in Postgres.
   *
   * P0.3 filters — same split as sqlite-storage.ts's listRuns: `status` pushes
   * Down to a WHERE on the indexed `gnl_runs.suspended` boolean (matches the SAME derivation used
   * Below, cannot drift); `agent` has no indexed column (it's inside the `:input` blob) — when given,
   * This fetches every (status-filtered) row WITHOUT LIMIT/OFFSET, filters+paginates in JS (filter
   * BEFORE slicing). Honest scan cost, acceptable for an operator/debug filter — see the sqlite
   * Comment for the full rationale.
   */
  async listRuns(q?: ListQuery): Promise<Page<RunSummary>> {
    const { start, limit } = offset(q);
    // Three-way, still on indexed columns, and in the SAME precedence deriveRunStatus applies
    // (suspended beats the recorded outcome) so a filtered page cannot disagree with a full scan.
    const statusWhere =
      q?.status === 'suspended' ? ' WHERE r.suspended = true'
      : q?.status === 'failed' ? ' WHERE r.suspended = false AND r.failed = true'
      : q?.status === 'running' ? ' WHERE r.suspended = false AND r.failed = false AND r.running = true'
      : q?.status === 'completed' ? ' WHERE r.suspended = false AND r.failed = false AND r.running = false'
      : '';
    const statusParams: unknown[] = [];
    const toSummary = (x: any): RunSummary => {
      const input = x.input_val ? deserialize<{ threadId?: string; agent?: string }>(x.input_val) : undefined;
      return {
        runId: x.run_id, status: deriveRunStatus(!!x.suspended, x.failed ? { status: 'failed' } : x.running ? { status: 'running' } : null), modelSteps: Number(x.model_steps), toolCalls: Number(x.tool_calls),
        ...(input?.threadId ? { threadId: input.threadId } : {}),
        ...(input?.agent ? { agent: input.agent } : {}),
      };
    };
    if (q?.agent) {
      const r = await this.q(
        `SELECT r.run_id, r.model_steps, r.tool_calls, r.suspended, r.failed, r.running, j.value AS input_val
         FROM gnl_runs r LEFT JOIN gnl_run_journal j ON j.key = r.run_id || ':input'${statusWhere}
         ORDER BY r.created_at, r.run_id`,
        statusParams,
      );
      const all = r.rows.map(toSummary).filter((x) => x.agent === q.agent);
      return pageOf(all.slice(start, start + limit), start, limit, all.length);
    }
    const total = Number((await this.q(`SELECT COUNT(*) AS n FROM gnl_runs r${statusWhere}`, statusParams)).rows[0].n);
    const limitIdx = statusParams.length + 1;
    const r = await this.q(
      `SELECT r.run_id, r.model_steps, r.tool_calls, r.suspended, r.failed, r.running, j.value AS input_val
       FROM gnl_runs r LEFT JOIN gnl_run_journal j ON j.key = r.run_id || ':input'${statusWhere}
       ORDER BY r.created_at, r.run_id LIMIT $${limitIdx} OFFSET $${limitIdx + 1}`,
      [...statusParams, limit, start],
    );
    return pageOf(r.rows.map(toSummary), start, limit, total);
  }

  /**
   * P1.6b: atomic batch — claim + counter increments + puts as ONE transaction (a single pinned client
   * Via `tx`, same helper `put`/`putIfAbsent` use). `put`/`putIfAbsent` themselves can't be REUSED here
   * (each opens its OWN client via `tx()`, which would be a SEPARATE Postgres session — nesting them
   * Would silently defeat atomicity) — so the INSERT/UPSERT statements are mirrored inline (identical SQL
   * To `put`'s `upsert`/`putIfAbsent`'s `ins`), while `touchRunDelta`/`lockRunRow` ARE reused as-is since
   * They already take an explicit `q` and compose correctly with `tx`'s pinned client.
   *
   * Pg-mem NOTE (test-only limitation, see the file-header comment + `exactCas` in the conformance
   * Matrix): pg-mem's `INSERT ... ON CONFLICT DO NOTHING RETURNING`/`rowCount` reports 1 even on a
   * Genuine conflict — verified experimentally, independent of whether `RETURNING` is present. A
   * SELECT-before-INSERT existence check would dodge that specific test-double bug, but would REGRESS
   * Real-Postgres correctness (a genuine TOCTOU race between two concurrent claims on the SAME key —
   * Exactly the scenario `applyBatch`'s claim exists to protect). So this mirrors `putIfAbsent`'s
   * Genuinely-atomic INSERT-based check (correct on real Postgres, proven in integration-real.test.ts);
   * The pg-mem test suite gates BOTH the boolean AND the resulting counters/puts invariant behind
   * `caps.exactCas` for this one case (see storage-backend.test.ts) — an accepted, documented gap in the
   * Test double, not in the adapter.
   */
  async applyBatch(batch: JournalBatch): Promise<boolean> {
    return this.tx(async (q) => {
      if (batch.claim) {
        const p = parseJournalKey(batch.claim.key);
        const suspended = p?.kind === 'tool' && (batch.claim.value as ToolJournalRecord | undefined)?.status === 'suspended';
        if (p) await this.lockRunRow(q, p.runId);
        const ins = await q(
          `INSERT INTO gnl_run_journal (key, run_id, kind, suspended, value, created_at) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (key) DO NOTHING RETURNING key`,
          [batch.claim.key, p?.runId ?? null, p?.kind ?? null, !!suspended, serialize(batch.claim.value), Date.now()],
        );
        if (!inserted1(ins)) return false; // claim lost → the whole batch is a no-op (nothing else applied)
        if (p) await this.touchRunDelta(q, p.runId, p.kind, true, suspended ? 1 : 0);
      }
      for (const { key, fields } of batch.incrs ?? []) {
        for (const [f, d] of Object.entries(fields)) {
          await q(
            'INSERT INTO gnl_counters (key, field, value) VALUES ($1, $2, $3) ON CONFLICT (key, field) DO UPDATE SET value = gnl_counters.value + EXCLUDED.value',
            [key, f, d],
          );
        }
      }
      for (const { key, value } of batch.puts ?? []) {
        const p = parseJournalKey(key);
        const suspended = p?.kind === 'tool' && (value as ToolJournalRecord | undefined)?.status === 'suspended';
        const prev = p ? (await q('SELECT suspended FROM gnl_run_journal WHERE key = $1', [key])).rows[0] : undefined;
        await q(
          `INSERT INTO gnl_run_journal (key, run_id, kind, suspended, value, created_at) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, suspended = EXCLUDED.suspended`,
          [key, p?.runId ?? null, p?.kind ?? null, !!suspended, serialize(value), Date.now()],
        );
        if (p) {
          const delta = (suspended ? 1 : 0) - (prev?.suspended ? 1 : 0);
          await this.touchRunDelta(q, p.runId, p.kind, prev === undefined, delta);
        }
      }
      return true;
    });
  }

  /** P1.6b: batch point-read — a single `WHERE key IN (...)` instead of N sequential `get` calls;
   *  Order-preserving, `undefined` for misses (getMany contract, journal.ts). Dynamic `$N` placeholders
   *  (NOT `= ANY($1::text[])`) — pg-mem does not evaluate the array form correctly (verified
   *  Experimentally: it returns zero rows even for genuine matches), while plain `IN ($1,$2,...)` works
   *  Identically on both pg-mem and real Postgres. */
  async getMany<T = unknown>(keys: string[]): Promise<(T | undefined)[]> {
    if (keys.length === 0) return [];
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(',');
    const r = await this.q(`SELECT key, value FROM gnl_run_journal WHERE key IN (${placeholders})`, keys);
    const byKey = new Map(r.rows.map((row: any) => [row.key as string, row.value as string]));
    return keys.map((k) => (byKey.has(k) ? deserialize<T>(byKey.get(k)!) : undefined));
  }

  /**
   * P1.6b: push-down status aggregate — a single `GROUP BY` over the indexed `gnl_runs.suspended`
   * Column, MUST MATCH listRuns' own status derivation (deriveRunStatus: suspended, then failed) —
   * Same column, same boolean, mapped to the status string in JS (not in SQL) so it cannot drift.
   * Grouping by the RAW boolean column (not a `CASE WHEN ... THEN 'suspended' ...` computed expression) —
   * Pg-mem's query planner mis-groups a `GROUP BY` on a CASE-derived alias (verified experimentally: rows
   * For BOTH branches come back labeled with the wrong status); grouping by the underlying column is
   * Correct on both pg-mem and real Postgres.
   */
  async countRunsByStatus(): Promise<Record<string, number>> {
    const r = await this.q(`SELECT suspended, failed, running, COUNT(*) AS n FROM gnl_runs GROUP BY suspended, failed, running`);
    const out: Record<string, number> = {};
    for (const row of r.rows) {
      const status = deriveRunStatus(!!row.suspended, row.failed ? { status: 'failed' } : row.running ? { status: 'running' } : null);
      out[status] = (out[status] ?? 0) + Number(row.n);
    }
    return out;
  }
}

class PgMemoryStore implements MemoryStore {
  constructor(private q: Q) {}
  async upsertThread(rec: ThreadRecord): Promise<void> {
    await this.q(
      `INSERT INTO gnl_threads (id, resource_id, title, parent_thread_id, metadata, created_at, updated_at, deleted_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET resource_id=EXCLUDED.resource_id, title=EXCLUDED.title, parent_thread_id=EXCLUDED.parent_thread_id, metadata=EXCLUDED.metadata, updated_at=EXCLUDED.updated_at, deleted_at=EXCLUDED.deleted_at`,
      [rec.id, rec.resourceId, rec.title ?? null, rec.parentThreadId ?? null, rec.metadata ? serialize(rec.metadata) : null, rec.createdAt, rec.updatedAt, rec.deletedAt ?? null],
    );
  }
  private toThread(x: any): ThreadRecord {
    return { id: x.id, resourceId: x.resource_id, title: x.title ?? undefined, parentThreadId: x.parent_thread_id ?? undefined, metadata: x.metadata ? deserialize(x.metadata) : undefined, createdAt: Number(x.created_at), updatedAt: Number(x.updated_at), deletedAt: x.deleted_at != null ? Number(x.deleted_at) : undefined };
  }
  async getThread(id: string): Promise<ThreadRecord | undefined> {
    const r = await this.q('SELECT * FROM gnl_threads WHERE id = $1 AND deleted_at IS NULL', [id]);
    return r.rows[0] ? this.toThread(r.rows[0]) : undefined;
  }
  async listThreads(q: { resourceId?: string } & ListQuery): Promise<Page<ThreadRecord>> {
    const { start, limit } = offset(q);
    const where = q.resourceId != null ? 'deleted_at IS NULL AND resource_id = $1' : 'deleted_at IS NULL';
    const base = q.resourceId != null ? [q.resourceId] : [];
    const total = Number((await this.q(`SELECT COUNT(*) AS n FROM gnl_threads WHERE ${where}`, base)).rows[0].n);
    const r = await this.q(`SELECT * FROM gnl_threads WHERE ${where} ORDER BY updated_at DESC, id LIMIT $${base.length + 1} OFFSET $${base.length + 2}`, [...base, limit, start]);
    return pageOf(r.rows.map((x) => this.toThread(x)), start, limit, total);
  }
  async deleteThread(id: string): Promise<void> {
    await this.q('UPDATE gnl_threads SET deleted_at = $1 WHERE id = $2', [Date.now(), id]);
    await this.q('DELETE FROM gnl_messages WHERE thread_id = $1', [id]);
    await this.q('DELETE FROM gnl_working_memory WHERE scope_id = $1', [id]);
    await this.q('DELETE FROM gnl_observations WHERE thread_id = $1', [id]);
  }
  async appendMessages(threadId: string, rows: MessageRecord[]): Promise<void> {
    for (const r of rows) {
      await this.q(
        `INSERT INTO gnl_messages (thread_id, seq, role, text, embedding, metadata, ts, message) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (thread_id, seq) DO NOTHING`,
        [threadId, r.seq, r.role, r.text ?? null, r.embedding ? JSON.stringify(r.embedding) : null, r.metadata ? serialize(r.metadata) : null, r.ts, serialize(r.message)],
      );
    }
  }
  private toMsg(x: any): MessageRecord {
    return { threadId: x.thread_id, seq: Number(x.seq), role: x.role, text: x.text ?? undefined, embedding: x.embedding ? JSON.parse(x.embedding) : undefined, metadata: x.metadata ? deserialize(x.metadata) : undefined, ts: Number(x.ts), message: deserialize(x.message) };
  }
  async getMessages(threadId: string, q?: ListQuery): Promise<Page<MessageRecord>> {
    const { start, limit } = offset(q);
    const total = Number((await this.q('SELECT COUNT(*) AS n FROM gnl_messages WHERE thread_id = $1', [threadId])).rows[0].n);
    const r = await this.q('SELECT * FROM gnl_messages WHERE thread_id = $1 ORDER BY seq LIMIT $2 OFFSET $3', [threadId, limit, start]);
    return pageOf(r.rows.map((x) => this.toMsg(x)), start, limit, total);
  }
  /**
   * FLOW-10: truncate a thread's tail — deletes every message with seq > afterSeq (afterSeq itself,
   * And everything before it, is kept). See MemoryStore.deleteMessagesAfter (storage.ts) for the full
   * Contract. Same DELETE-then-rowCount pattern as PgRunJournal.deletePrefix above. Boundary cases fall
   * Out of the WHERE clause naturally: unknown threadId or afterSeq >= the thread's max seq → the WHERE
   * Matches no rows → 0; afterSeq below the thread's min seq → the WHERE matches every row for that thread.
   */
  async deleteMessagesAfter(threadId: string, afterSeq: number): Promise<number> {
    const r = await this.q('DELETE FROM gnl_messages WHERE thread_id = $1 AND seq > $2', [threadId, afterSeq]);
    return r.rowCount ?? 0;
  }
  async recall(threadId: string, query: number[], opts: RecallOptions): Promise<MessageRecord[]> {
    if (!hasNorm(query)) return [];
    const r = opts.scope === 'resource' && opts.resourceId
      ? await this.q(`SELECT m.* FROM gnl_messages m JOIN gnl_threads t ON t.id = m.thread_id WHERE t.resource_id = $1 AND t.deleted_at IS NULL ORDER BY m.thread_id, m.seq`, [opts.resourceId])
      : await this.q('SELECT * FROM gnl_messages WHERE thread_id = $1 ORDER BY seq', [threadId]);
    const byThread = new Map<string, MessageRecord[]>();
    for (const x of r.rows) { const m = this.toMsg(x); const a = byThread.get(m.threadId) ?? []; a.push(m); byThread.set(m.threadId, a); }
    const threshold = opts.threshold ?? 0;
    const cand: { m: MessageRecord; tid: string; idx: number; score: number }[] = [];
    for (const [tid, msgs] of byThread) msgs.forEach((m, idx) => {
      if (!hasNorm(m.embedding)) return;
      const score = cosineSimilarity(query, m.embedding);
      if (score > 0 && score >= threshold) cand.push({ m, tid, idx, score });
    });
    let scored = cand;
    if (opts.filter) scored = scored.filter((c) => matchFilter(c.m.metadata, opts.filter!));
    scored.sort((a, b) => b.score - a.score);
    const hits = scored.slice(0, opts.topK ?? 3);
    const range = normRange(opts.messageRange);
    const picked = new Map<string, MessageRecord>();
    for (const h of hits) {
      const msgs = byThread.get(h.tid)!;
      const lo = Math.max(0, h.idx - range.before), hi = Math.min(msgs.length - 1, h.idx + range.after);
      for (let i = lo; i <= hi; i++) picked.set(`${h.tid}:${msgs[i]!.seq}`, msgs[i]!);
    }
    // Provenance parity with sqlite-storage.ts: hits carry their similarity, neighbors stay unscored.
    for (const h of hits) picked.set(`${h.tid}:${h.m.seq}`, { ...h.m, score: h.score });
    return [...picked.values()].sort((a, b) => a.ts - b.ts || a.seq - b.seq);
  }
  async getWorkingMemory(scopeId: string): Promise<unknown> {
    const r = await this.q('SELECT data FROM gnl_working_memory WHERE scope_id = $1', [scopeId]);
    return r.rows[0] ? deserialize(r.rows[0].data) : undefined;
  }
  async setWorkingMemory(scopeId: string, data: unknown): Promise<void> {
    await this.q(`INSERT INTO gnl_working_memory (scope_id, data, updated_at) VALUES ($1,$2,$3) ON CONFLICT (scope_id) DO UPDATE SET data=EXCLUDED.data, updated_at=EXCLUDED.updated_at`, [scopeId, serialize(data), Date.now()]);
  }
  async getObservations(threadId: string): Promise<Observation[]> {
    const r = await this.q('SELECT obs FROM gnl_observations WHERE thread_id = $1', [threadId]);
    return r.rows[0] ? deserialize<Observation[]>(r.rows[0].obs) : [];
  }
  async putObservations(threadId: string, obs: Observation[]): Promise<void> {
    await this.q(`INSERT INTO gnl_observations (thread_id, obs) VALUES ($1,$2) ON CONFLICT (thread_id) DO UPDATE SET obs=EXCLUDED.obs`, [threadId, serialize(obs)]);
  }
}

class PgVectorStore implements VectorStore {
  constructor(private q: Q) {}
  async upsert(items: VectorItem[]): Promise<void> {
    for (const it of items) await this.q(
      `INSERT INTO gnl_vectors (id, text, embedding, metadata, created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET text=EXCLUDED.text, embedding=EXCLUDED.embedding, metadata=EXCLUDED.metadata`,
      [it.id, it.text, JSON.stringify(it.embedding), it.metadata ? serialize(it.metadata) : null, Date.now()],
    );
  }
  async query(embedding: number[], topK: number): Promise<VectorMatch[]> {
    const r = await this.q('SELECT id, text, embedding, metadata FROM gnl_vectors');
    return r.rows
      .map((x) => ({ id: x.id, text: x.text, metadata: x.metadata ? deserialize<Record<string, unknown>>(x.metadata) : undefined, score: cosineSimilarity(embedding, JSON.parse(x.embedding)) }))
      .sort((a, b) => b.score - a.score).slice(0, topK);
  }
}

class PgWorkStore implements WorkStore {
  constructor(private q: Q) {}
  async append(ns: string, payload: unknown, id?: string): Promise<string> {
    const eid = id ?? `${ns}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    await this.q(`INSERT INTO gnl_work_log (ns, id, payload, ts) VALUES ($1,$2,$3,$4) ON CONFLICT (ns, id) DO NOTHING`, [ns, eid, serialize(payload), Date.now()]);
    return eid;
  }
  async list<T = unknown>(ns: string, q?: ListQuery): Promise<Page<LogRecord<T>>> {
    const { start, limit } = offset(q);
    const total = Number((await this.q('SELECT COUNT(*) AS n FROM gnl_work_log WHERE ns = $1', [ns])).rows[0].n);
    const r = await this.q('SELECT id, payload, ts FROM gnl_work_log WHERE ns = $1 ORDER BY ts, id LIMIT $2 OFFSET $3', [ns, limit, start]);
    return pageOf(r.rows.map((x) => ({ id: x.id, payload: deserialize<T>(x.payload), ts: Number(x.ts) })), start, limit, total);
  }
  async get<T = unknown>(key: string): Promise<T | undefined> {
    const r = await this.q('SELECT value FROM gnl_work_kv WHERE key = $1', [key]);
    return r.rows[0] ? deserialize<T>(r.rows[0].value) : undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    await this.q(`INSERT INTO gnl_work_kv (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [key, serialize(value)]);
  }
  async ackOnce(key: string): Promise<boolean> {
    const r = await this.q(`INSERT INTO gnl_work_kv (key, value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING RETURNING key`, [key, serialize(true)]);
    return inserted1(r);
  }
  /**
   * 8.2: SAME pattern as PgRunJournal.putIfMatch's `!p` branch (gnl_work_kv has NO derived index like
   * Gnl_run_journal → no need to wrap it in a transaction/row-lock, a single UPDATE is enough). Stored
   * Form is the same as SQLite: PLAIN serialize() TEXT — comparison via `WHERE key=$ AND value=serialize(expected)`.
   */
  async putIfMatch(key: string, expected: unknown, value: unknown): Promise<boolean> {
    const r = await this.q('UPDATE gnl_work_kv SET value = $1 WHERE key = $2 AND value = $3', [serialize(value), key, serialize(expected)]);
    return Number(r.rowCount ?? 0) === 1;
  }
}

class PgCacheStore implements CacheStore {
  constructor(private q: Q) {}
  async get<T = unknown>(key: string): Promise<T | undefined> {
    const r = await this.q('SELECT value, expires_at FROM gnl_cache WHERE key = $1', [key]);
    const row = r.rows[0];
    if (!row) return undefined;
    if (row.expires_at != null && Number(row.expires_at) <= Date.now()) { await this.q('DELETE FROM gnl_cache WHERE key = $1', [key]); return undefined; }
    return deserialize<T>(row.value);
  }
  async set(key: string, value: unknown, opts?: { ttlMs?: number }): Promise<void> {
    const exp = opts?.ttlMs != null ? Date.now() + opts.ttlMs : null;
    await this.q(`INSERT INTO gnl_cache (key, value, expires_at) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, expires_at=EXCLUDED.expires_at`, [key, serialize(value), exp]);
  }
  async delete(key: string): Promise<void> { await this.q('DELETE FROM gnl_cache WHERE key = $1', [key]); }
}

class PgMetaStore implements MetaStore {
  constructor(private q: Q) {}
  async get(key: string): Promise<string | undefined> {
    const r = await this.q('SELECT v FROM gnl_meta WHERE k = $1', [key]);
    return r.rows[0]?.v;
  }
  async set(key: string, value: string): Promise<void> {
    await this.q(`INSERT INTO gnl_meta (k, v) VALUES ($1,$2) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`, [key, value]);
  }
}
