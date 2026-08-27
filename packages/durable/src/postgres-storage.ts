// @gnldev/durable/postgres — Postgres implementation of all store ports (prod default).
// Same schema/semantics as SqliteStorage; pg async API ($N placeholders, CAS detection via RETURNING).
// Injectable pool pattern → zero-infra testing with pg-mem. `pg` is an optional peer dep.
// Vector is 'scan' for now (brute-force cosine; pgvector deferred — pg-mem compatibility + lean first cut).
import { prefixUpperBound } from './organization.js';
import { assertUniformSeq } from './storage.js';
import { createRequire } from 'node:module';
import { cosineSimilarity } from 'ai';
import { runIdOfKey, parseJournalKey, outcomeStatusOf, deriveRunStatus } from './journal.js';
import type { JournalBatch, JournalEntry, RunSummary, ToolJournalRecord } from './journal.js';
import { serialize, deserialize } from './serialize.js';
import { matchFilter } from './storage.js';
import type { AdoptIntoOrgResult,
  Storage, CapabilityMatrix, Page, ListQuery,
  RunJournal, MemoryStore, VectorStore, WorkStore, CacheStore, MetaStore,
  ThreadRecord, MessageRecord, MessageAppend, Observation, RecallOptions, VectorItem, VectorMatch, VectorQueryOptions, LogRecord,
} from './storage.js';
// P2-migrate schema introspection/migration façade — see migrate.ts's header.
import { tablesFromDDL } from './migrate.js';
import { ENGINE_META_KEYS, assertNoRunsInFlight, assertOrgRegistered, isPlatformKey, orgPrefix } from './organization.js';
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
/**
 * The materialized `gnl_runs` flags back into the ONE outcome shape `deriveRunStatus` reads — the
 * Twin of sqlite-storage.ts's helper, and written out for the same reason: the flag→status mapping is
 * Precedence-bearing, and hand-copying the ternary chain into listRuns AND countRunsByStatus is
 * Exactly how one of them ends up ordering `failed` ahead of `canceled` while the other does not.
 */
function outcomeOfRow(r: { failed?: unknown; running?: unknown; canceled?: unknown }): { status: 'canceled' | 'failed' | 'running' } | null {
  return r.canceled ? { status: 'canceled' } : r.failed ? { status: 'failed' } : r.running ? { status: 'running' } : null;
}
// P1.5 matchFilter is now shared (storage.ts) — see its JSDoc for the operator
// Subset ($eq/$ne/$gt/$gte/$lt/$lte/$in/$nin). Import above (was a local exact-equality-only copy).
function normRange(r?: number | { before: number; after: number }) {
  if (r == null) return { before: 0, after: 0 };
  return typeof r === 'number' ? { before: r, after: r } : r;
}
const hasNorm = (v?: number[] | null): v is number[] => !!v && v.some((x) => x !== 0);

/**
 * Does plain `<` on this backend order strings by bytes?
 *
 * Every prefix scan here is a range: `key >= prefix AND key < prefix + U+FFFF`. That is only a
 * prefix under BYTE ordering. Under a linguistic collation -- en_US.utf8, the default of nearly
 * every managed Postgres -- U+FFFF is a noncharacter that collates as if absent, so the upper bound
 * reduces to `key < prefix` and the range matches NOTHING: listKeys returns empty, deletePrefix
 * deletes nothing and reports 0, with no error anywhere.
 *
 * `COLLATE "C"` fixes it, but cannot simply be hardcoded: pg-mem (which this suite runs most of its
 * Postgres tests against) rejects the statement at parse time, and its own comparison is already
 * byte order, so it does not need it. A database created with C collation does not need it either.
 *
 * So probe the behaviour instead of guessing the backend, the same way the advisory lock above is
 * best-effort rather than version-gated. Returns the clause to splice into the comparisons.
 */
type PrefixShape = { collate: string };

const DDL = [
  `CREATE TABLE IF NOT EXISTS gnl_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS gnl_run_journal (key TEXT PRIMARY KEY, run_id TEXT, kind TEXT, suspended BOOLEAN NOT NULL DEFAULT false, value TEXT NOT NULL, created_at BIGINT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS gnl_run_journal_run ON gnl_run_journal (run_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS gnl_runs (run_id TEXT PRIMARY KEY, model_steps INTEGER NOT NULL DEFAULT 0, tool_calls INTEGER NOT NULL DEFAULT 0, suspended BOOLEAN NOT NULL DEFAULT false, suspended_count INTEGER NOT NULL DEFAULT 0, failed BOOLEAN NOT NULL DEFAULT false, running BOOLEAN NOT NULL DEFAULT false, canceled BOOLEAN NOT NULL DEFAULT false, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`,
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
  // `canceled` (the operator's ending): same again. Three booleans for one status IS inelegant; they
  // Are only ever written together, from a single `outcomeStatusOf` value in a single statement, so
  // They cannot disagree — collapsing them into one materialized `outcome` column is its own round.
  `ALTER TABLE gnl_runs ADD COLUMN IF NOT EXISTS canceled BOOLEAN NOT NULL DEFAULT false`,
  `CREATE TABLE IF NOT EXISTS gnl_counters (key TEXT NOT NULL, field TEXT NOT NULL, value DOUBLE PRECISION NOT NULL, PRIMARY KEY (key, field))`,
  `CREATE INDEX IF NOT EXISTS gnl_runs_created ON gnl_runs (created_at, run_id)`,
  `CREATE TABLE IF NOT EXISTS gnl_threads (id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, title TEXT, parent_thread_id TEXT, metadata TEXT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, deleted_at BIGINT)`,
  `CREATE INDEX IF NOT EXISTS gnl_threads_res ON gnl_threads (resource_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS gnl_messages (thread_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL, text TEXT, embedding TEXT, metadata TEXT, ts BIGINT NOT NULL, message TEXT NOT NULL, PRIMARY KEY (thread_id, seq))`,
  `CREATE TABLE IF NOT EXISTS gnl_working_memory (scope_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS gnl_observations (thread_id TEXT PRIMARY KEY, obs TEXT NOT NULL)`,
  // Batch identity, beside the messages rather than in the journal. Same transaction as the rows it
  // covers, so "written but not marked" stops being a state this store can be in — see
  // `appendMessagesOnce`. A NEW TABLE rather than a column on gnl_messages: `migrateSchema` emits
  // CREATE TABLE with its constraints for a missing table, but has no path to add an index to one
  // that already exists, so the column-plus-unique-index shape would reach new installs and silently
  // skip existing ones.
  `CREATE TABLE IF NOT EXISTS gnl_message_batches (thread_id TEXT NOT NULL, batch_key TEXT NOT NULL, seq_from INTEGER NOT NULL, seq_to INTEGER NOT NULL, ts BIGINT NOT NULL, PRIMARY KEY (thread_id, batch_key))`,
  `CREATE TABLE IF NOT EXISTS gnl_vectors (id TEXT PRIMARY KEY, text TEXT NOT NULL, embedding TEXT NOT NULL, metadata TEXT, namespace TEXT, created_at BIGINT NOT NULL)`,
  // Same migration shape as the gnl_runs columns above: `CREATE TABLE IF NOT EXISTS` does nothing to
  // a table that already exists, so an old database would keep a five-column gnl_vectors and every
  // upsert would fail with "column namespace does not exist". Deliberately NOT backfilled — rows
  // written before namespaces existed belong to the un-namespaced partition, and a query for a real
  // namespace must not be answered from them.
  `ALTER TABLE gnl_vectors ADD COLUMN IF NOT EXISTS namespace TEXT`,
  `CREATE TABLE IF NOT EXISTS gnl_work_log (ns TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, ts BIGINT NOT NULL, PRIMARY KEY (ns, id))`,
  `CREATE INDEX IF NOT EXISTS gnl_work_log_ns ON gnl_work_log (ns, ts)`,
  `CREATE TABLE IF NOT EXISTS gnl_work_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS gnl_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at BIGINT)`,
];


/**
 * `col >= $n [AND col < $n+1]` with the collation suffix, starting at `from`. The upper bound is omitted
 * for an empty prefix, which means every key — `col < ''` is never true, so emitting it unconditionally
 * turned `deletePrefix('')` into a delete of nothing that still reported success.
 */
function pgRange(col: string, collate: string, prefix: string, from: number): { where: string; params: string[] } {
  const upper = prefixUpperBound(prefix);
  return upper === undefined
    ? { where: `${col}${collate} >= $${from}`, params: [prefix] }
    : { where: `${col}${collate} >= $${from} AND ${col}${collate} < $${from + 1}`, params: [prefix, upper] };
}

/**
 * CONNECTION BUDGET. Measured failure, not a hypothetical: two 8-worker app groups against one
 * Postgres asked for 16 x 10 = 160 connections against `max_connections = 100`, and 513 of 600
 * requests came back as 500s carrying nothing but Postgres's own `sorry, too many clients already`.
 * Nothing in gnl chose that 10 — it is node-postgres's default pool size — and nothing anywhere told
 * the operator the arithmetic that had just broken.
 *
 * gnl cannot see how many processes a deployment runs, so it cannot check the product. What it CAN
 * do is state its own share once, and name the arithmetic when the server refuses a connection.
 */
function connectionAdvice(poolMax: number, serverMax: number): string {
  const safe = Math.max(1, Math.floor((serverMax - 20) / Math.max(1, poolMax)));
  return `@gnldev/durable: this process reserves up to ${poolMax} Postgres connections and the server allows `
    + `${serverMax}. Keep (processes x pool size) under ${serverMax - 20} -- roughly ${safe} process(es) at this `
    + `pool size, leaving headroom for autovacuum and superuser sessions. Set a smaller pool via `
    + `new PostgresStorage({ pool }) if you run more.`;
}

/** Postgres says this when the connection slots are gone. Its own message names no remedy. */
function isTooManyClients(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  const msg = String((e as { message?: string } | null)?.message ?? '');
  return code === '53300' || /too many clients/i.test(msg);
}

/**
 * One statement for a whole set of counter increments, instead of one awaited round trip per field.
 *
 * A completed agent turn writes three counter keys of seven fields each plus the usage counter — 24
 * sequential round trips, for advisory statistics, inside the transaction that also carries the
 * exactly-once claim. Traced against a live server: 24 of the ~114 round trips a request makes.
 *
 * The dedupe is not tidiness. Postgres rejects `ON CONFLICT DO UPDATE` when one statement would touch
 * the same row twice ("cannot affect row a second time"), and a caller may legitimately pass the same
 * (key, field) more than once — the deltas are additive, so summing them first is both the fix and
 * the correct semantics.
 */
function flattenIncrs(incrs: ReadonlyArray<{ key: string; fields: Record<string, number> }>): Array<string | number> {
  const merged = new Map<string, { key: string; field: string; delta: number }>();
  for (const { key, fields } of incrs) {
    for (const [field, delta] of Object.entries(fields)) {
      const id = `${key}\u0000${field}`;
      const prev = merged.get(id);
      if (prev) prev.delta += delta;
      else merged.set(id, { key, field, delta });
    }
  }
  const flat: Array<string | number> = [];
  for (const m of merged.values()) flat.push(m.key, m.field, m.delta);
  return flat;   // [key, field, delta, key, field, delta, ...] — one triple per placeholder group
}

/**
 * The multi-row upsert `flattenIncrs` feeds, built as an explicit `VALUES` list rather than with
 * `UNNEST($1::text[], ...)`. The array form is tidier and works on real Postgres, but pg-mem — which
 * the default suite runs the whole Postgres contract against — answers it with
 * `unnest expects 1 arguments, given 3`. A numbered VALUES list is understood by both, so there is
 * one code path instead of a capability probe and a fallback that would diverge in silence.
 */
function incrSql(rows: number): string {
  const values = Array.from({ length: rows }, (_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`).join(', ');
  return `INSERT INTO gnl_counters (key, field, value) VALUES ${values}
          ON CONFLICT (key, field) DO UPDATE SET value = gnl_counters.value + EXCLUDED.value`;
}

export class PostgresStorage implements Storage {
  /** Filled in by ensureReady's probe; shared BY REFERENCE with PgRunJournal (see PrefixShape). */
  private prefixShape: PrefixShape = { collate: '' };
  /** Filled by ensureReady's budget probe; used to explain a connection refusal. */
  private connectionBudget?: { poolMax: number; serverMax: number };
  /** Per-INSTANCE, never module-global: a test double must not disable the lock for a real pool. */
  private advisoryLocks = true;
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
  /** Absent when the pool cannot hold a transaction — see the constructor and NO_TX_MSG. */
  readonly memory!: MemoryStore;
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
    /**
     * Wraps a connection refusal with the arithmetic that caused it. Postgres answers
     * `sorry, too many clients already` and stops there; the operator is left to work out that
     * processes x pool size has crossed `max_connections`. The original error is kept as `cause`.
     */
    const explain = (e: unknown): unknown => {
      if (!isTooManyClients(e) || !this.connectionBudget) return e;
      const { poolMax, serverMax } = this.connectionBudget;
      const err = new Error(`${String((e as Error).message)} -- ${connectionAdvice(poolMax, serverMax)}`, { cause: e });
      (err as { code?: string }).code = (e as { code?: string }).code;
      return err;
    };
    const q = (sql: string, p?: unknown[]) =>
      this.ensureReady().then(() => this._pool.query(sql, p)).catch((e) => { throw explain(e); });
    // T1 audit fix — transaction helper: all queries inside fn run within BEGIN/COMMIT (error →
    // ROLLBACK) on a SINGLE client checked out from the pool. `pool.query('BEGIN')` on a pg Pool is
    // UNSAFE (each query can go to a different connection) → connect pins the client.
    // Lower-fidelity fallbacks (behavior = old autocommit, test-only):
    // if pool.connect is missing (minimal injected pool): no transaction, queries run sequentially via pool.query.
    // pg-mem: accepts BEGIN/COMMIT/ROLLBACK but ROLLBACK does NOT actually UNDO (verified
    //     Experimentally) → no proof of atomicity under pg-mem; real atomicity proof is in integration-real.test.ts.
    // `atomic: true` means the caller's correctness DEPENDS on the transaction, so the two
    // lower-fidelity fallbacks below must refuse rather than quietly run unwrapped. Without it, a
    // query-only pool made `appendMessages` send its lock and its `SET LOCAL` as separate autocommit
    // statements — the lock released at the end of its own statement, `SET LOCAL` drew a server
    // warning, and the batch was not atomic. Measured on a real server: 23 of 24 appends rejected,
    // 3 rows of 48 stored, and an orphaned tool call — exactly the defect this all exists to remove,
    // with the capability probe reporting everything fine.
    //
    // `BEGIN` runs BEFORE `fn`, so refusing there writes nothing; there is no half-done state.
    const tx = async <T>(fn: (q: Q) => Promise<T>, opts?: { atomic?: true }): Promise<T> => {
      await this.ensureReady();
      if (typeof this._pool.connect !== 'function') {
        if (opts?.atomic) throw new Error(NO_TX_MSG);
        return fn((s, p) => this._pool.query(s, p));
      }
      const client = await this._pool.connect().catch((e: unknown) => { throw explain(e); });
      let inTx = false;
      let destroy = false;
      try {
        try { await client.query('BEGIN'); inTx = true; } catch (e) { if (opts?.atomic) throw new Error(NO_TX_MSG, { cause: e }); /* else: transaction not supported → proceed unwrapped */ }
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
    this.runs = new PgRunJournal(q, tx, this.prefixShape);
    // A1 — DOWNGRADE THE PORT, do not throw. `connect` is a synchronous check, so there is no reason
    // to defer it to the first query; and killing the whole Storage would take the runs journal, work
    // queue and cache down with it, for a deployment that may never touch memory at all. Declaring
    // the port absent is this repo's own idiom for "this adapter cannot offer that" (RedisStorage
    // does exactly this), and it leaves the operator a real way out: route memory elsewhere with
    // composite({ default: pg, overrides: { memory: sqlite() } }).
    if (typeof (this._pool as { connect?: unknown }).connect !== 'function') {
      (this.capabilities as { memory: string }).memory = 'none';
      console.error(NO_TX_MSG);
    } else {
      this.memory = new PgMemoryStore(q, tx, () => this.advisoryLocks);
    }
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
          // Ask the backend what its `<` actually does, rather than assuming. 'a:b' sorts below
          // 'a:' + U+FFFF under byte order and NOT under a linguistic collation, so this single
          // comparison separates the two. A backend that cannot answer is treated as byte-ordered:
          // that is the behaviour every backend had before this probe existed.
          const probe = await this._pool
            .query(`SELECT ('a:b' < ('a:' || U&'\\FFFF')) AS byte_ordered`)
            .then((r: any) => r.rows?.[0]?.byte_ordered !== false, () => true);
          if (!probe) {
            this.prefixShape.collate = ' COLLATE "C"';
            // The PK indexes are in the database's own collation and cannot serve a COLLATE "C"
            // range, so a prefix scan would degrade to a seq scan without these.
            for (const sql of [
              `CREATE INDEX IF NOT EXISTS gnl_run_journal_cprefix ON gnl_run_journal (key COLLATE "C")`,
              `CREATE INDEX IF NOT EXISTS gnl_runs_cprefix ON gnl_runs (run_id COLLATE "C")`,
              `CREATE INDEX IF NOT EXISTS gnl_counters_cprefix ON gnl_counters (key COLLATE "C")`,
            ]) await this._pool.query(sql);
          }
          await this._pool.query(`INSERT INTO gnl_meta (k, v) VALUES ('schema_version', $1) ON CONFLICT (k) DO NOTHING`, [SCHEMA_VERSION]);
          // One extra query at startup to read the budget this process is spending against. Warned
          // only when the margin is genuinely thin, so a single-process deployment stays silent.
          try {
            const serverMax = Number((await this._pool.query('SHOW max_connections')).rows?.[0]?.max_connections);
            const poolMax = Number((this._pool as { options?: { max?: number } }).options?.max ?? 10);
            this.connectionBudget = { poolMax, serverMax };
            if (Number.isFinite(serverMax) && poolMax * 4 > serverMax - 20) {
              console.warn(connectionAdvice(poolMax, serverMax));
            }
          } catch { /* a backend that cannot answer SHOW is left alone -- this is advice, not a gate */ }
          // Can this server serialise appends to one thread? Settled ONCE, here, outside any
          // transaction — see the note on THREAD_LOCK_NS for why asking mid-transaction cannot work.
          // Fail-closed in production: without this lock two runs answering one thread lose messages,
          // and shipping that silently is the exact failure this whole change exists to remove. Test
          // doubles (pg-mem has no advisory locks) are not production, so they warn and carry on.
          // `to_regprocedure` asks the catalog whether the function exists — no lock is taken, nothing
          // is unlocked, and the server logs no warning. Probing by CALLING pg_advisory_unlock would
          // have worked too, but it makes the backend warn about releasing a lock we never held.
          this.advisoryLocks = await this._pool
            .query(`SELECT to_regprocedure('pg_advisory_xact_lock(int,int)') IS NOT NULL AS ok`)
            .then((r: any) => r.rows?.[0]?.ok === true, () => false);
          if (!this.advisoryLocks) {
            // DOWNGRADE, not throw — and with no NODE_ENV branch. Throwing here killed the whole
            // Storage: a deployment running Postgres purely for the exactly-once journal, never
            // touching memory, died on its first query with a message about "concurrent appends to
            // one thread". And branching a correctness guarantee on NODE_ENV means two environments
            // get two different guarantees, which is its own smell. Declaring the port absent lets
            // `requireCapability` stop anyone who tries to USE memory, exactly as it does for Redis,
            // and leaves everything else running.
            (this.capabilities as { memory: string }).memory = 'none';
            console.error(
              '@gnldev/durable: this Postgres has no pg_advisory_xact_lock, so appends to one thread '
              + 'cannot be serialised and two concurrent turns would silently lose messages. The memory '
              + 'port is disabled (capabilities.memory = "none"); the runs journal, work queue, cache '
              + 'and meta stores are unaffected and exactly-once still holds. Route memory elsewhere — '
              + 'composite({ default: postgres, overrides: { memory: sqlite() } }) — or use a Postgres '
              + 'that exposes pg_advisory_xact_lock(int, int). Postgres-compatible proxies and '
              + 'derivatives are the usual cause.',
            );
          }
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
  /** See `Storage.adoptIntoOrg`. Same table list and the same platform-key rule as the SQLite adapter. */
  async adoptIntoOrg(orgId: string, opts?: { dryRun?: boolean; allowUnregistered?: boolean; allowInFlight?: boolean }): Promise<AdoptIntoOrgResult> {
    const prefix = orgPrefix(orgId);
    const ns = prefix.slice(0, -1);
    const dryRun = opts?.dryRun === true;
    await this.ensureReady();
    // A DEDICATED connection, not the pool. `BEGIN` and `COMMIT` issued through `pool.query` can land
    // on different connections, so the statements between them would not be in a transaction at all —
    // and a half-migrated store is worse than an unmigrated one, because nobody can tell which half is
    // which.
    if (typeof this._pool.connect !== 'function') {
      // Refused rather than run without one. A duck-typed pool that cannot hand out a connection
      // cannot give us a transaction, and this migration rewrites every key in the store — running it
      // non-atomically would leave a store nobody can classify if it failed halfway.
      throw new Error(
        '@gnldev/durable: adoptIntoOrg needs a pool that supports connect() so the migration runs in one '
        + 'transaction. Pass a real `pg` Pool (or a connectionString) rather than a minimal query-only object.',
      );
    }
    const client = await this._pool.connect();
    const q = (sql: string, p?: unknown[]) => client.query(sql, p);
    // AFTER the connect() check, because a pool that cannot give a transaction is a configuration
    // error and should be reported as one — checking registration first would answer a question about
    // the data while the setup is unusable.
    try { await assertOrgRegistered(this.runs, orgId, opts?.allowUnregistered);
      await assertNoRunsInFlight(this.runs, opts?.allowInFlight); }
    catch (e) { client.release?.(); throw e; }
    const KEYED: Array<[string, string, string]> = [
      // Missed here, an adopted thread keeps its batch markers under the OLD id: a retry of an
      // in-flight batch is then unmarked and applies twice, and the stale rows sit in the global
      // partition forever. The file's own warning above says a table left off this list is data an
      // upgrade silently leaves behind.
      ['gnl_message_batches', 'thread_id', 'memory'],
      ['gnl_run_journal', 'key', 'runs'], ['gnl_runs', 'run_id', 'runs'], ['gnl_counters', 'key', 'runs'],
      ['gnl_threads', 'id', 'memory'], ['gnl_messages', 'thread_id', 'memory'],
      ['gnl_working_memory', 'scope_id', 'memory'], ['gnl_observations', 'thread_id', 'memory'],
      ['gnl_work_log', 'ns', 'work'], ['gnl_work_kv', 'key', 'work'], ['gnl_cache', 'key', 'cache'],
    ];
    const moved: Record<string, number> = {};
    const skipped = new Set<string>();
    let alreadyScoped = 0;
    const bump = (store: string, n: number) => { moved[store] = (moved[store] ?? 0) + n; };

    if (!dryRun) await q('BEGIN');
    try {
      for (const [table, col, store] of KEYED) {
        alreadyScoped += Number((await q(`SELECT COUNT(*) AS c FROM ${table} WHERE ${col} LIKE 'org:%'`)).rows[0].c);
        const rows = (await q(`SELECT DISTINCT ${col} AS k FROM ${table} WHERE ${col} NOT LIKE 'org:%'`)).rows as { k: string }[];
        let n = 0;
        for (const { k } of rows) {
          if (isPlatformKey(k)) { skipped.add(k.split(':')[0]!); continue; }
          n += Number((await q(`SELECT COUNT(*) AS c FROM ${table} WHERE ${col} = $1`, [k])).rows[0].c);
          if (!dryRun) await q(`UPDATE ${table} SET ${col} = $1 WHERE ${col} = $2`, [prefix + k, k]);
        }
        bump(store, n);
      }
      // gnl_meta minus the engine's own rows — see ENGINE_META_KEYS.
      const metaRows = (await q(`SELECT k FROM gnl_meta WHERE k NOT LIKE 'org:%'`)).rows as { k: string }[];
      alreadyScoped += Number((await q(`SELECT COUNT(*) AS c FROM gnl_meta WHERE k LIKE 'org:%'`)).rows[0].c);
      let metaN = 0;
      for (const { k } of metaRows) {
        if (ENGINE_META_KEYS.includes(k) || isPlatformKey(k)) { skipped.add(k); continue; }
        metaN++;
        if (!dryRun) await q(`UPDATE gnl_meta SET k = $1 WHERE k = $2`, [prefix + k, k]);
      }
      bump('meta', metaN);

      const vecs = Number((await q(`SELECT COUNT(*) AS c FROM gnl_vectors WHERE namespace IS NULL`)).rows[0].c);
      alreadyScoped += Number((await q(`SELECT COUNT(*) AS c FROM gnl_vectors WHERE namespace IS NOT NULL`)).rows[0].c);
      if (!dryRun && vecs) await q(`UPDATE gnl_vectors SET namespace = $1 WHERE namespace IS NULL`, [ns]);
      bump('vectors', vecs);

      if (!dryRun) await q('COMMIT');
    } catch (e) {
      if (!dryRun) await q('ROLLBACK').catch(() => {});
      throw e;
    } finally { client.release?.(); }
    return { orgId, dryRun, moved, alreadyScoped, skippedPlatformKeys: [...skipped].sort() };
  }

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

/**
 * `atomic: true` marks a caller whose correctness DEPENDS on the transaction, so `tx` refuses instead
 * of quietly running the body unwrapped. Every journal write below is such a caller — their own
 * comments say "closes the crash window" and "in a single transaction", and that was true only when a
 * transaction could actually be opened.
 */
type Tx = <T>(fn: (q: Q) => Promise<T>, opts?: { atomic?: true }) => Promise<T>;

class PgRunJournal implements RunJournal {
  constructor(private q: Q, private tx: Tx, private shape: PrefixShape) {}
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
        // Existing row, so it cannot invent a run. ALL THREE flags from ONE status in ONE statement,
        // So they can never disagree — and every transition clears its predecessors.
        if (oc !== null) {
          const runId = key.slice(0, -':outcome'.length);
          // First write of a brand-new run may precede its row — see the sqlite twin's comment.
          await this.touchRunDelta(q, runId, null, false, 0);
          await q(`UPDATE gnl_runs SET failed = $1, running = $2, canceled = $3 WHERE run_id = $4`, [oc === 'failed', oc === 'running', oc === 'canceled', runId]);
        }
      }, { atomic: true });
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
    }, { atomic: true });
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
          if (oc !== null) {
            const runId = key.slice(0, -':outcome'.length);
            await this.touchRunDelta(q, runId, null, false, 0); // see the sqlite twin
            await q(`UPDATE gnl_runs SET failed = $1, running = $2, canceled = $3 WHERE run_id = $4`, [oc === 'failed', oc === 'running', oc === 'canceled', runId]);
          }
        }
        return ok;
      }, { atomic: true });
    }
    // T1: INSERT + touchRunDelta in a single transaction (closes the crash window). lockRunRow uses the
    // SAME lock order as put() (gnl_runs first, then the journal row) → no deadlock possibility between put/putIfAbsent.
    return this.tx(async (q) => {
      await this.lockRunRow(q, p.runId);
      const inserted = inserted1(await ins(q));
      if (inserted) await this.touchRunDelta(q, p.runId, p.kind, true, suspended ? 1 : 0); // fresh insert → O(1)
      return inserted;
    }, { atomic: true });
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
        if (ok) {
          const runId = key.slice(0, -':outcome'.length);
          await this.touchRunDelta(q, runId, null, false, 0); // see the sqlite twin
          await q(`UPDATE gnl_runs SET failed = $1, running = $2, canceled = $3 WHERE run_id = $4`, [oc === 'failed', oc === 'running', oc === 'canceled', runId]);
        }
        return ok;
      }, { atomic: true });
    }
    // T1: UPDATE + recountRun in one transaction (closes the crash → stale gnl_runs window). There is NO
    // LockRunRow here — so a failed match doesn't create a phantom row in gnl_runs (the lock order stays
    // Journal→runs; a theoretical deadlock with put requires the rare path × the same key, and PG detects
    // It and aborts one → the caller sees an error, the takeover just doesn't happen that round = the safe side).
    return this.tx(async (q) => {
      const ok = Number((await upd(q)).rowCount ?? 0) === 1;
      if (ok) await this.recountRun(q, p.runId); // rare path (takeover) → a full recount is safe and sufficient
      return ok;
    }, { atomic: true });
  }

  /** H8a: in-engine atomic counter (UPSERT arithmetic) — lost-update is impossible, hot-row lock is short. */
  async incrBy(key: string, fields: Record<string, number>): Promise<void> {
    const flat = flattenIncrs([{ key, fields }]);
    if (!flat.length) return;
    await this.q(incrSql(flat.length / 3), flat);
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
    // COLLATE "C" is load-bearing, not a micro-optimisation. Under a linguistic collation (en_US.utf8,
    // the default of nearly every managed Postgres) string comparison is NOT byte order: U+FFFF is a
    // noncharacter and collates as if absent, so `key < prefix || U+FFFF` reduces to `key < prefix` and
    // the range matches NOTHING. Measured on a stock pgvector/pg16 (en_US.utf8): the same range that
    // matches 3 rows under "C" matched 0 under the default. That made listKeys silently return empty
    // and deletePrefix silently delete nothing -- returning 0 with no error, so an org purge, a
    // retention sweep and `deletePrefix('xrun:')` all reported success while the rows stayed. SQLite is
    // unaffected: its default collation IS byte order. The gnl_*_cprefix indexes below are declared
    // with the same collation so these stay index-backed range scans rather than seq scans.
    // Same upper bound as the SQLite approach: prefixUpperBound(prefix).
    const c = this.shape.collate;
    const rg = pgRange('key', c, prefix, 1);
    const r = await this.q(`SELECT key FROM gnl_run_journal WHERE ${rg.where} ORDER BY created_at`, rg.params);
    return r.rows.map((x) => x.key);
  }

  /** Retention/GDPR: PERMANENTLY delete keys starting with a prefix; also clean up the derived gnl_runs index. */
  async deletePrefix(prefix: string): Promise<number> {
    const c = this.shape.collate;
    const jr = pgRange('key', c, prefix, 1);
    const r = await this.q(`DELETE FROM gnl_run_journal WHERE ${jr.where}`, jr.params);
    const rid = prefix.endsWith(':') ? prefix.slice(0, -1) : prefix;
    const rr = pgRange('run_id', c, prefix, 2);
    await this.q(`DELETE FROM gnl_runs WHERE run_id = $1 OR (${rr.where})`, [rid, ...rr.params]);
    // Counters (incrBy/H8a) are keys too — see the sqlite-storage.ts deletePrefix note (GDPR org purge
    // + rebuildMetrics correctness). Not included in the return count, same as the gnl_runs rows.
    const cr = pgRange('key', c, prefix, 1);
    await this.q(`DELETE FROM gnl_counters WHERE ${cr.where}`, cr.params);
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
    // Five-way, still on indexed columns, and in the SAME precedence deriveRunStatus applies
    // (canceled beats suspended beats the rest of the recorded outcome) so a filtered page cannot
    // disagree with a full scan.
    const statusWhere =
      q?.status === 'canceled' ? ' WHERE r.canceled = true'
      : q?.status === 'suspended' ? ' WHERE r.canceled = false AND r.suspended = true'
      : q?.status === 'failed' ? ' WHERE r.canceled = false AND r.suspended = false AND r.failed = true'
      : q?.status === 'running' ? ' WHERE r.canceled = false AND r.suspended = false AND r.failed = false AND r.running = true'
      : q?.status === 'completed' ? ' WHERE r.canceled = false AND r.suspended = false AND r.failed = false AND r.running = false'
      : '';
    const statusParams: unknown[] = [];
    const toSummary = (x: any): RunSummary => {
      const input = x.input_val ? deserialize<{ threadId?: string; agent?: string; resourceId?: string }>(x.input_val) : undefined;
      return {
        runId: x.run_id, status: deriveRunStatus(!!x.suspended, outcomeOfRow(x)), modelSteps: Number(x.model_steps), toolCalls: Number(x.tool_calls),
        ...(input?.threadId ? { threadId: input.threadId } : {}),
        ...(input?.agent ? { agent: input.agent } : {}),
        ...(input?.resourceId ? { resourceId: input.resourceId } : {}),
      };
    };
    // `agent` and `resourceId` share ONE path: neither is a column, both live inside the `:input` blob,
    // so both are filtered after the summary is built. Written as a single branch rather than two so a
    // request carrying BOTH cannot take a branch that applies only one of them — and so the
    // filter-BEFORE-slice contract (JournalReader.listRunsPaged) is satisfied once, not per filter.
    if (q?.agent || q?.resourceId) {
      const r = await this.q(
        `SELECT r.run_id, r.model_steps, r.tool_calls, r.suspended, r.failed, r.running, r.canceled, j.value AS input_val
         FROM gnl_runs r LEFT JOIN gnl_run_journal j ON j.key = r.run_id || ':input'${statusWhere}
         ORDER BY r.created_at, r.run_id`,
        statusParams,
      );
      const all = r.rows.map(toSummary)
        .filter((x) => (q.agent ? x.agent === q.agent : true) && (q.resourceId ? x.resourceId === q.resourceId : true));
      return pageOf(all.slice(start, start + limit), start, limit, all.length);
    }
    const total = Number((await this.q(`SELECT COUNT(*) AS n FROM gnl_runs r${statusWhere}`, statusParams)).rows[0].n);
    const limitIdx = statusParams.length + 1;
    const r = await this.q(
      `SELECT r.run_id, r.model_steps, r.tool_calls, r.suspended, r.failed, r.running, r.canceled, j.value AS input_val
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
      {
        const flat = flattenIncrs(batch.incrs ?? []);
        if (flat.length) await q(incrSql(flat.length / 3), flat);
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
    }, { atomic: true });
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
   * Same columns, same booleans, mapped to the status string in JS (not in SQL) so it cannot drift.
   * Grouping by the RAW boolean columns (not a `CASE WHEN ... THEN 'suspended' ...` computed expression) —
   * Pg-mem's query planner mis-groups a `GROUP BY` on a CASE-derived alias (verified experimentally: rows
   * For BOTH branches come back labeled with the wrong status); grouping by the underlying column is
   * Correct on both pg-mem and real Postgres.
   */
  async countRunsByStatus(): Promise<Record<string, number>> {
    const r = await this.q(`SELECT suspended, failed, running, canceled, COUNT(*) AS n FROM gnl_runs GROUP BY suspended, failed, running, canceled`);
    const out: Record<string, number> = {};
    for (const row of r.rows) {
      const status = deriveRunStatus(!!row.suspended, outcomeOfRow(row));
      out[status] = (out[status] ?? 0) + Number(row.n);
    }
    return out;
  }
}

/**
 * Serialise appends to one thread, for the length of the caller's transaction.
 *
 * TWO-KEY form, not one. `pg_advisory_xact_lock(bigint)` and `pg_advisory_xact_lock(int, int)` sit in
 * DIFFERENT lock namespaces, and the single-key space is already taken by the boot-DDL lock
 * (47110001), so a one-key `pg_advisory_xact_lock(hash)` could collide with schema creation. `pg_locks`
 * confirms the two-key form is disjoint: classid = THREAD_LOCK_NS, objsubid = 2.
 *
 * The hash is computed here rather than with Postgres's `hashtext`, which does not exist in pg-mem —
 * the default test double for this adapter.
 *
 * COLLISIONS ARE REAL, and an earlier version of this note claimed otherwise. "Zero collisions over
 * 200k ids" was measured on sequential dense strings; over ids in the shape this codebase actually
 * generates it is 3 in 200k, and the expected value for a 32-bit hash at that count is about 5. Nor is
 * the consequence merely a wait: two unrelated threads sharing a key serialise, and with the
 * `lock_timeout` below one of them can exceed it and fail — an unrelated conversation's turn dies.
 * Correctness is unaffected (MAX(seq) and the INSERT are keyed by `thread_id`, not by the hash), but
 * this is a rare availability cost, not free.
 *
 * There is NO try/catch here, deliberately. Catching a missing-function error INSIDE the transaction
 * does not degrade gracefully — Postgres marks the transaction ABORTED, so the very next statement
 * fails with 25P02 `current transaction is aborted` and the caller sees that instead of anything
 * useful. Measured. Whether this server has advisory locks at all is settled once, outside any
 * transaction, by `probeAdvisoryLocks` during `ensureReady`.
 */
/**
 * Said in one sentence, the way `connectionAdvice()` does it: what breaks, and what to do instead.
 */
const NO_TX_MSG =
  '@gnldev/durable: the pool given to PostgresStorage has no connect(), so nothing can be written in a '
  + 'transaction. This is not a degraded mode, it is an unusable one: appending a message batch would '
  + 'leave a tool call with no result, the per-thread append lock cannot be held, and every journal '
  + 'write that spans more than one statement — the replay entries, putIfAbsent, putIfMatch, '
  + 'applyBatch — depends on exactly the atomicity that is missing. Those refuse rather than write '
  + 'unserialised; the memory port is withdrawn outright (capabilities.memory = "none"). Single-'
  + 'statement writes still work, which is why this is reported rather than thrown at construction. '
  + 'Pass a real `pg` Pool, or a connectionString and let the adapter build one.';

const NO_LOCK_APPEND_MSG =
  '@gnldev/durable: this Postgres cannot take the per-thread append lock (no pg_advisory_xact_lock), '
  + 'so two concurrent turns on one thread would silently lose messages. Refusing to append rather '
  + 'than write unserialised. Route the memory port to another adapter, or use a Postgres that '
  + 'exposes pg_advisory_xact_lock(int, int).';

/**
 * Turns `55P03` into something an operator can act on.
 *
 * The raw text is `canceling statement due to lock timeout`, which names neither the thread nor the
 * writer that held it. The measured cause is not contention between ordinary turns — those queue in
 * milliseconds — but a single large explicit-`seq` write: importing a 20,000-row transcript holds the
 * lock for about six seconds, and a live turn on the same thread gives up at five. So the sentence
 * has to point at bulk writes, not at load.
 *
 * `code` is preserved and the original chained as `cause`, following `explain()` above: the code is
 * the only machine-readable signal a caller has for "this is worth retrying".
 */
function lockWaitAdvice(e: unknown, threadId: string, rows: number): unknown {
  if ((e as { code?: string })?.code !== '55P03') return e;
  const err = new Error(
    `@gnldev/durable: appending ${rows} message(s) to thread '${threadId}' timed out waiting for that `
    + `thread's append lock — another writer is holding it. The usual cause is a large explicit-seq `
    + `write on the same thread (a transcript import, or cloneThread): the lock is held for the whole `
    + `batch. Nothing was written, so the run can retry. Import large transcripts into a thread that is `
    + `not taking live turns, or split them into smaller batches.`,
    { cause: e },
  );
  (err as { code?: string }).code = '55P03';
  return err;
}

const THREAD_LOCK_NS = 47110002;

function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h | 0;   // signed int32, which is what the two-key form takes
}

class PgMemoryStore implements MemoryStore {
  /**
   * `tx` as well as `q`: a message batch has to land all-or-nothing (see `appendMessages`). Before
   * this, the memory store had no way to open a transaction at all — it was handed only `q`, so every
   * write was its own autocommit on whichever pooled connection answered first.
   */
  constructor(private q: Q, private tx: <T>(fn: (q: Q) => Promise<T>, opts?: { atomic?: true }) => Promise<T>, private advisoryLocks: () => boolean) {}
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
    // Batch markers too. A thread is soft-deleted while its messages are hard-deleted, and
    // `upsertThread` can bring the id back — a resurrected thread that kept its markers answers a
    // legitimate later batch with "already applied" and drops it in silence. Measured: 0 rows written
    // where 2 were expected.
    await this.q('DELETE FROM gnl_message_batches WHERE thread_id = $1', [id]);
  }
  /**
   * ONE TRANSACTION for the whole batch — the rows of an append land together or not at all.
   *
   * This used to be a bare loop of autocommit INSERTs, each potentially on a different pooled
   * connection, and that is the defect users actually saw. A batch is `[assistant(tool-call),
   * tool(tool-result)]`; when only the first row commits, the thread is left holding a tool call that
   * is never answered, and the AI SDK refuses to build a prompt from it — `MissingToolResultsError`,
   * surfaced as `HTTP 400 "Tool result is missing for tool call …"`. Every later turn on that thread
   * fails the same way until the orphan slides out of the memory window — measured at 5 consecutive
   * failures with the default `chat` preset (recentN 10), because a failed turn still write-aheads its
   * user message and so keeps the window moving. Self-healing, then, but at the cost of five real
   * errors and five junk messages left in the transcript; and only while nothing pulls the orphan back
   * into context, which recall can.
   *
   * Measured, 900 requests against real Postgres with the fix toggled on and off:
   *
   *     base    7 errors (0.78%)  |  7 threads left with an orphan call  |  96.4 req/s
   *     atomic  0 errors          |  0 orphans                           |  99.8 req/s
   *
   * So atomicity alone removes 100% of those failures, and costs nothing — it is fewer round trips,
   * not more, because the batch now travels on one pinned client instead of N pool checkouts.
   *
   * This is NOT the whole story. A separate defect — `AgentMemory.append` computing `seq` from an
   * unlocked read — still drops whole batches under concurrency (measured: 33% of messages). That
   * loss is silent and leaves the history self-consistent, which is why it produces no 400s and why
   * it needs its own fix. Atomicity is what stops a half-written batch from BREAKING a thread.
   *
   * Per-row INSERTs are kept deliberately. Collapsing them into one multi-row statement was measured
   * at 1.14x on this subsystem, which is ~11.9% of a request's round trips — a fraction of a percent
   * end to end — and `ON CONFLICT` under pg-mem (the default test double) has known fidelity gaps.
   * The atomicity comes from the transaction; the statement shape is not what was broken.
   */
  async appendMessagesOnce(threadId: string, rows: MessageAppend[], batchKey: string): Promise<boolean> {
    const assign = assertUniformSeq(threadId, rows);
    if (!this.advisoryLocks()) throw new Error(NO_LOCK_APPEND_MSG);
    return this.tx(async (q) => {
      await q(`SET LOCAL lock_timeout = '5s'`);
      await q('SELECT pg_advisory_xact_lock($1, $2)', [THREAD_LOCK_NS, hash32(threadId)]);
      // CLAIM FIRST, in the same transaction as the rows. Zero rows back means this batch already
      // landed, and the messages are not touched — which is the whole point: the identity cannot
      // survive a rollback that took the rows with it, and the rows cannot survive a rollback that
      // took the identity. `run.ts`'s two-phase marker existed only because those were separate
      // writes to separate stores.
      const claim = await q(
        `INSERT INTO gnl_message_batches (thread_id, batch_key, seq_from, seq_to, ts) VALUES ($1,$2,0,0,$3)
         ON CONFLICT (thread_id, batch_key) DO NOTHING RETURNING batch_key`,
        [threadId, batchKey, Date.now()],
      );
      if ((claim.rowCount ?? 0) === 0) return false;
      let next = 0;
      if (assign) {
        const r = await q('SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM gnl_messages WHERE thread_id = $1', [threadId]);
        next = Number(r.rows[0].n);
      }
      const from = next;
      for (const r of rows) {
        const conflict = r.seq === undefined ? '' : ' ON CONFLICT (thread_id, seq) DO NOTHING';
        await q(
          `INSERT INTO gnl_messages (thread_id, seq, role, text, embedding, metadata, ts, message) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)${conflict}`,
          [threadId, r.seq ?? next++, r.role, r.text ?? null, r.embedding ? JSON.stringify(r.embedding) : null, r.metadata ? serialize(r.metadata) : null, r.ts, serialize(r.message)],
        );
      }
      await q('UPDATE gnl_message_batches SET seq_from = $1, seq_to = $2 WHERE thread_id = $3 AND batch_key = $4',
        [from, next, threadId, batchKey]);
      return true;
    }, { atomic: true }).catch((e: unknown) => { throw lockWaitAdvice(e, threadId, rows.length); });
  }

  async appendMessages(threadId: string, rows: MessageAppend[]): Promise<void> {
    if (rows.length === 0) return;
    const assign = assertUniformSeq(threadId, rows);
    // Second line of defence: the capability downgrade above should have stopped anyone getting here
    // without a usable lock, but a caller holding `storage.memory` directly bypasses that check.
    if (!this.advisoryLocks()) throw new Error(NO_LOCK_APPEND_MSG);
    await this.tx(async (q) => {
      // ALWAYS take the lock, not only when assigning. The explicit-seq path was measured racing:
      // importing a transcript (explicit positions, unlocked) alongside a live run (assigned
      // positions, locked) lost rows in 20 of 60 turns. The contract invites transcript import, so
      // leaving that path unserialised makes the documented use case the unsafe one. The lock costs a
      // single round trip on a connection that is already pinned.
      if (this.advisoryLocks()) {
        // BOUND THE WAIT, and bound it BELOW run.ts's MEM_APPEND_TTL_MS (60s). This is not tidiness —
        // an unbounded wait here reopens the very defect the lock closes, with no crash involved:
        //
        //   worker A takes the lock and its connection dies without closing (a TCP blackhole; the
        //   backend is not reaped for minutes under default keepalives) -> worker B's append queues on
        //   the lock -> 60s pass -> run.ts decides A's append marker is stale and lets a retry take it
        //   over -> the lock is finally released -> BOTH writes land.
        //
        // Measured exactly that, with no process ever crashing: the same user message twice in one
        // thread. Timing out instead surfaces 55P03 with nothing written, which fails the run and lets
        // it retry cleanly. 5s leaves a 12x margin under the TTL.
        //
        // IT CAN FIRE, and an earlier version of this note said it could not. That claim rested on one
        // axis only — concurrency, where the deepest contention measured was p99 336ms at 128 writers.
        // Batch SIZE was never measured, and it is the axis that reaches the limit: importing a
        // 20,000-row transcript holds this lock for about six seconds, so a live turn on the same
        // thread times out at five. On a managed Postgres at 1.5ms round trip, roughly 3,300 messages
        // is enough. Large imports belong on a thread that is not taking live turns.
        await q(`SET LOCAL lock_timeout = '5s'`);
        // ITS OWN STATEMENT. Folding the lock into the scalar subquery that reads MAX(seq) does not
        // work and was measured failing: under READ COMMITTED a statement's snapshot is taken when the
        // statement STARTS and the lock is acquired part-way through it, so MAX(seq) still reads the
        // pre-lock tail. 155 of 160 messages were lost that way.
        await q('SELECT pg_advisory_xact_lock($1, $2)', [THREAD_LOCK_NS, hash32(threadId)]);
      }
      let next = 0;
      if (assign) {
        const r = await q('SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM gnl_messages WHERE thread_id = $1', [threadId]);
        next = Number(r.rows[0].n);
      }
      for (const r of rows) {
        // `ON CONFLICT DO NOTHING` ONLY for caller-supplied positions, where re-writing the same row
        // is the documented idempotent case. For positions this method just assigned under the lock, a
        // conflict is impossible unless something is wrong — and swallowing it would silently drop a
        // message, which is the defect this method exists to fix. Let it raise.
        const conflict = r.seq === undefined ? '' : ' ON CONFLICT (thread_id, seq) DO NOTHING';
        await q(
          `INSERT INTO gnl_messages (thread_id, seq, role, text, embedding, metadata, ts, message) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)${conflict}`,
          [threadId, r.seq ?? next++, r.role, r.text ?? null, r.embedding ? JSON.stringify(r.embedding) : null, r.metadata ? serialize(r.metadata) : null, r.ts, serialize(r.message)],
        );
      }
    }, { atomic: true }).catch((e: unknown) => { throw lockWaitAdvice(e, threadId, rows.length); });
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
    // Markers for batches that ended past the cut go with them. Leaving them behind makes a later
    // batch reusing the same key look "already applied", and the regenerated turn is dropped in
    // silence — measured at 1 message written where 3 were expected, which is the exact class of loss
    // batch identity exists to prevent.
    await this.q('DELETE FROM gnl_message_batches WHERE thread_id = $1 AND seq_to > $2', [threadId, afterSeq]);
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
      `INSERT INTO gnl_vectors (id, text, embedding, metadata, namespace, created_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET text=EXCLUDED.text, embedding=EXCLUDED.embedding, metadata=EXCLUDED.metadata, namespace=EXCLUDED.namespace`,
      [it.id, it.text, JSON.stringify(it.embedding), it.metadata ? serialize(it.metadata) : null, it.namespace ?? null, Date.now()],
    );
  }
  async query(embedding: number[], topK: number, opts?: VectorQueryOptions): Promise<VectorMatch[]> {
    // Filtered in SQL, so only eligible rows reach the ranking. Ranking the whole table and filtering
    // afterwards would tie a caller's result count to how many other namespaces exist: ask for 4, get
    // however many of the global top 4 were yours. Nothing errors, nothing leaks — recall just decays
    // as other organizations upload, and only a fixture with two organizations can see it.
    //
    // `IS NOT DISTINCT FROM` rather than `=`: `= NULL` is never true in SQL, so a query for the
    // un-namespaced partition would match nothing at all.
    const r = opts?.namespace === undefined
      ? await this.q('SELECT id, text, embedding, metadata, namespace FROM gnl_vectors')
      : await this.q('SELECT id, text, embedding, metadata, namespace FROM gnl_vectors WHERE namespace IS NOT DISTINCT FROM $1', [opts.namespace]);
    return r.rows
      .map((x) => ({ id: x.id, text: x.text, metadata: x.metadata ? deserialize<Record<string, unknown>>(x.metadata) : undefined, ...(x.namespace != null ? { namespace: x.namespace as string } : {}), score: cosineSimilarity(embedding, JSON.parse(x.embedding)) }))
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
