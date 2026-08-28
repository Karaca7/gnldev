// @gnldev/durable/sqlite — node:sqlite implementation of all store ports (dev default).
// RunJournal = append-only journal (gnl_run_journal) + derived gnl_runs index (indexed readRun/listRuns).
// MemoryStore = gnl_threads + gnl_messages (per-message PK → idempotent append) + WM + observations.
// Vectors = 'scan' (brute-force cosine; no pgvector). node:sqlite (loaded at runtime via createRequire).
import { prefixUpperBound } from './organization.js';
import { assertUniformSeq } from './storage.js';
import { createRequire } from 'node:module';
import { statSync, existsSync } from 'node:fs';
import { cosineSimilarity } from 'ai';
import { runIdOfKey, parseJournalKey, outcomeStatusOf, deriveRunStatus } from './journal.js';
import { ENGINE_META_KEYS, assertNoRunsInFlight, assertOrgRegistered, isPlatformKey, orgPrefix } from './organization.js';
import type { JournalBatch, JournalEntry, RunSummary, ToolJournalRecord } from './journal.js';
import { serialize, deserialize } from './serialize.js';
import { matchFilter } from './storage.js';
import type {
  Storage, CapabilityMatrix, Page, ListQuery,
  RunJournal, MemoryStore, VectorStore, WorkStore, CacheStore, MetaStore,
  AdoptIntoOrgResult, ThreadRecord, MessageRecord, MessageAppend, Observation, RecallOptions, VectorItem, VectorMatch, VectorQueryOptions, LogRecord,
} from './storage.js';
// P2-migrate schema introspection/migration façade — see migrate.ts's header.
import { tablesFromDDL } from './migrate.js';
import type { SchemaCheckResult, SchemaMigrationResult, MissingColumn } from './migrate.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => any };

const SCHEMA_VERSION = '1';

// ── SQLITE_BUSY: bounded retry at the STATEMENT boundary ───────────────────────
/**
 * WHY (multi-process contention): SQLite admits exactly ONE writer at a time. `busy_timeout` (the
 * Constructor's first pragma) hides most of that contention — but NOT all of it:
 *   • SQLite refuses to invoke the busy handler where waiting could deadlock (a read→write lock
 *     Upgrade returns SQLITE_BUSY IMMEDIATELY), and some statements never consult it at all
 *     (`PRAGMA journal_mode = WAL` against a concurrent booter fails instantly — measured).
 *   • The timeout is WALL-CLOCK: on a saturated machine (a full test suite, a noisy host) 5s can
 *     Elapse before the OS even schedules this process.
 * In every one of those cases the caller was handed "database is locked" for a purely TRANSIENT
 * Condition. A durability layer should absorb that (Postgres drivers do the same for transient
 * Conflicts) — and must absorb NOTHING else: only SQLITE_BUSY is retried here; every other error
 * (constraint violations, corruption, misuse) propagates on the FIRST throw, untouched.
 *
 * WHAT IS RETRIED — exactly ONE SQLite statement per attempt. This wrapper sits at the statement
 * Boundary (`exec`, `prepare().run|get|all`), NEVER around a multi-statement block. That placement
 * Is what makes the retry provably safe:
 *   • A statement that fails with SQLITE_BUSY applied NOTHING — it never obtained the write lock, and
 * SQLite rolls back that statement's implicit sub-transaction. There is no half-applied write to
 *     Resume from, so re-executing it cannot apply anything twice.
 *   • `BEGIN IMMEDIATE` is itself a statement, so the usual contention point IS covered, and retrying
 *     It restarts the transaction from before its first write (a failed BEGIN leaves autocommit mode).
 * A statement that fails INSIDE an open transaction re-runs alone — the transaction stays open and
 *     Keeps holding its lock, so the already-applied statements are neither lost nor repeated.
 *   • CAS keeps its exact meaning. `putIfAbsent` (INSERT … ON CONFLICT DO NOTHING) and `putIfMatch`
 *     (UPDATE … WHERE value = ?) are decided by the ENGINE at the instant the statement actually
 *     Executes: if a competing process claimed the key while we were backing off, the retry sees
 *     `changes = 0` → `false` = "we lost", which is the TRUTH (our failed attempt wrote nothing).
 * A retry can therefore never manufacture a second winner for the same key.
 * When the bound is exhausted the error is still THROWN: the "never silently swallow, never fake
 * Atomicity" rule (see SqliteRunJournal.withTx) is unchanged — we merely wait a bounded while first.
 *
 * WHY THE BACKOFF IS SYNCHRONOUS: node:sqlite is synchronous and the journal's transaction bodies
 * Must stay await-free — an `await` between BEGIN and COMMIT would let a concurrent caller's
 * Statements join the open transaction (see applyBatch's comment). So the pause blocks the thread
 * (Atomics.wait — a real sleep, not a spin), exactly as the engine's own busy_timeout wait does.
 *
 * THE BOUND (both halves matter — MEASURED, not guessed). Two very different BUSY regimes exist and
 * One number cannot bound both:
 *   • FAST regime — the engine returns SQLITE_BUSY without waiting (lock upgrade, `journal_mode`
 *     Pragma). Attempts are ~free, so the ATTEMPT count is the meaningful limit: 10 tries spread over
 *     ≈0.65s of backoff.
 *   • SLOW regime — the busy handler IS consulted and eats the whole `busy_timeout` (measured under a
 *     Saturated 6-way parallel race: the FIRST attempt threw at elapsed=5106ms). Here the attempt
 *     Count is irrelevant and only WALL TIME bounds anything — and the ceiling MUST sit above 5000,
 *     Or the very case this retry exists for gets zero retries. 15s ⇒ ~3 full busy_timeout windows.
 * Worst case for a caller is therefore ~20s (the last attempt may start just under the ceiling and
 * Then burn its own 5s busy_timeout) — after which the error is THROWN, never swallowed.
 */
const BUSY_MAX_ATTEMPTS = 10;       // TOTAL executions of the statement (1 initial + 9 retries)
const BUSY_MAX_ELAPSED_MS = 15_000; // hard ceiling; counts the engine's OWN busy_timeout waits too
const BUSY_MAX_DELAY_MS = 100;      // backoff: 1,2,4,8,16,32,64,100,100 ms, each +0..100% jitter

/** SQLITE_BUSY only (primary code 5, incl. the BUSY_* extended codes). NOT SQLITE_LOCKED (6) — a
 *  Table-level/shared-cache conflict is not the transient cross-process case and waiting won't fix it. */
function isBusyError(e: unknown): boolean {
  if (e == null || typeof e !== 'object') return false;
  const err = e as { errcode?: unknown; errstr?: unknown; message?: unknown };
  // Node:sqlite stamps a numeric `errcode` — authoritative, so never second-guess it with a text match
  // (a constraint error whose MESSAGE happened to mention a lock must not be retried).
  if (typeof err.errcode === 'number') return (err.errcode & 0xff) === 5;
  const text = `${String(err.errstr ?? '')} ${String(err.message ?? '')}`;
  return /database is locked/i.test(text) || /SQLITE_BUSY/i.test(text);
}

const BUSY_SLEEP_SLOT = new Int32Array(new SharedArrayBuffer(4));
/** Blocking pause without yielding the event loop (see the "WHY SYNCHRONOUS" note above). */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  try {
    Atomics.wait(BUSY_SLEEP_SLOT, 0, 0, ms);
  } catch {
    // Runtime that forbids Atomics.wait on this thread → short bounded spin (≤100ms) instead.
    const until = Date.now() + ms;
    while (Date.now() < until) { /* spin */ }
  }
}

/** Runs ONE statement, retrying it while it fails with SQLITE_BUSY, within the bound above. */
function retryOnBusy<T>(fn: () => T): T {
  const startedAt = Date.now();
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (e) {
      if (!isBusyError(e)) throw e;                                  // not transient → surface as-is
      if (attempt + 1 >= BUSY_MAX_ATTEMPTS) throw e;                 // bound: attempts
      if (Date.now() - startedAt >= BUSY_MAX_ELAPSED_MS) throw e;    // bound: total elapsed time
      const base = Math.min(1 << attempt, BUSY_MAX_DELAY_MS);
      sleepSync(base + Math.floor(Math.random() * base)); // jitter → two racers don't re-collide in lockstep
    }
  }
}

/**
 * The DatabaseSync handle every store below is given: identical surface (`exec` / `prepare` /
 * `close`), with each statement execution passed through `retryOnBusy`. Wrapping HERE (once, at
 * Construction) rather than at ~25 call sites keeps the retry uniformly at the one granularity that
 * Is safe to repeat — a single statement — instead of leaving it to each caller to get right.
 */
class BusyRetryDatabase {
  constructor(readonly inner: any) {}
  exec(sql: string): unknown {
    // Multi-statement `exec` is used ONLY for BEGIN/COMMIT/ROLLBACK, pragmas and the idempotent
    // `IF NOT EXISTS` DDL — all safe to re-run whole.
    return retryOnBusy(() => this.inner.exec(sql));
  }
  prepare(sql: string): { run: (...a: any[]) => any; get: (...a: any[]) => any; all: (...a: any[]) => any } {
    const stmt = retryOnBusy(() => this.inner.prepare(sql));
    return {
      run: (...a: any[]) => retryOnBusy(() => stmt.run(...a)),
      get: (...a: any[]) => retryOnBusy(() => stmt.get(...a)),
      all: (...a: any[]) => retryOnBusy(() => stmt.all(...a)),
    };
  }
  close(): void { this.inner.close(); }
}

function offset(q?: ListQuery): { start: number; limit: number } {
  return { start: q?.cursor ? Number(q.cursor) || 0 : 0, limit: q?.limit ?? 50 };
}
function pageOf<T>(rows: T[], start: number, limit: number, total: number): Page<T> {
  const next = start + limit;
  return { items: rows, nextCursor: next < total ? String(next) : undefined };
}
/** A `gnl_runs` row as listRuns selects it (plus the joined `:input` blob). */
type RunRow = {
  run_id: string; model_steps: number; tool_calls: number;
  suspended: number; failed: number; running: number; canceled: number;
  input_val: string | null;
};
/**
 * The materialized flags back into the ONE outcome shape `deriveRunStatus` reads. Written out once
 * Rather than inline at each of the three call sites (listRuns' two queries and countRunsByStatus):
 * The flag→status mapping is precedence-bearing, and three hand-copied ternary chains is exactly how
 * One of them ends up ordering `failed` ahead of `canceled` while the other two do not.
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
 * `key >= lower [AND key < upper]` — the upper bound is omitted for an empty prefix, which means every
 * key. Built in one place so the four call sites cannot disagree about what "no bound" means.
 */
function range(col: string, prefix: string): { where: string; params: string[] } {
  const upper = prefixUpperBound(prefix);
  return upper === undefined
    ? { where: `${col} >= ?`, params: [prefix] }
    : { where: `${col} >= ? AND ${col} < ?`, params: [prefix, upper] };
}

export class SqliteStorage implements Storage {
  readonly name = 'sqlite';
  readonly capabilities: CapabilityMatrix = { runs: 'full', memory: 'full', vectors: 'scan', work: 'full', cache: 'ttl' };
  private db: any;
  readonly runs: RunJournal;
  readonly memory: MemoryStore;
  readonly vectors: VectorStore;
  readonly work: WorkStore;
  readonly cache: CacheStore;
  readonly meta: MetaStore;

  private readonly dbPath: string;
  constructor(path = ':memory:') {
    this.dbPath = path;
    // Every statement below (and in every store class) goes through the SQLITE_BUSY retry wrapper —
    // See BusyRetryDatabase. Transient lock contention is absorbed; anything else still throws.
    this.db = new BusyRetryDatabase(new DatabaseSync(path));
    // Busy_timeout MUST be
    // The FIRST pragma, in its OWN try. It used to be the LAST statement of the shared try below —
    // When two processes cold-started the same file simultaneously, the WAL switch raced with
    // Busy_timeout STILL AT 0, threw SQLITE_BUSY, and the shared catch swallowed the error TOGETHER
    // WITH the never-executed busy_timeout — so the DDL below then ran unprotected and crashed with
    // "database is locked". Setting the wait first makes every subsequent init statement (WAL switch,
    // DDL, migration) simply WAIT OUT a concurrent booter instead of dying.
    try {
      this.db.exec('PRAGMA busy_timeout = 5000');
    } catch {
      // memory: / old sqlite: unsupported pragma → default (0) — single-process behavior is unchanged
    }
    // H11a — WRITE SPEED: WAL mode (which the README already promises). The default rollback-journal +
    // FULL fsync was making every INSERT wait for a full disk sync (measured: ~3.7ms/write — slower
    // Even than a networked Postgres). WAL + synchronous=FULL: commit is still fsync'd (an acked write
    // Is not lost on a power outage either — the exactly-once precondition is PRESERVED) but the WAL fsync is much cheaper.
    try {
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = FULL');
      this.db.exec('PRAGMA wal_autocheckpoint = 1000'); // flush to the main file once WAL exceeds ~4MB (bounded)
    } catch {
      // memory: / old sqlite: if pragmas are unsupported, continue with the default (same behavior, just slower)
    }
    this.db.exec(DDL);
    // H11b migration: suspended_count column (for incremental touchRun). Add it if missing from the
    // Old table + backfill existing rows with a ONE-TIME recount (init cost; O(1) afterward).
    // `gnl_vectors.namespace`: the same migration shape as the `gnl_runs` columns below. `CREATE TABLE
    // IF NOT EXISTS` does nothing to a table that already exists, so without this an existing database
    // keeps a four-column `gnl_vectors` and every upsert fails with "no such column: namespace" —
    // an isolation feature that bricks the store it was meant to partition.
    //
    // No backfill, and NULL is the right value for the rows already there: they were written before
    // namespaces existed, so they belong to the un-namespaced partition. A query for namespace 'x'
    // must not be answered from them, and `WHERE namespace IS ?` gives exactly that.
    const vcols = this.db.prepare(`PRAGMA table_info(gnl_vectors)`).all() as { name: string }[];
    if (!vcols.some((c) => c.name === 'namespace')) {
      try {
        this.db.exec(`ALTER TABLE gnl_vectors ADD COLUMN namespace TEXT`);
      } catch (e) {
        if (!String((e as Error)?.message ?? e).includes('duplicate column')) throw e;
      }
    }
    const cols = this.db.prepare(`PRAGMA table_info(gnl_runs)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === 'suspended_count')) {
      // Two processes can BOTH see the column missing and BOTH try
      // The ALTER — the loser gets "duplicate column name" (the winner already migrated) → benign,
      // Swallow ONLY that; any other error is real and must surface.
      try {
        this.db.exec(`ALTER TABLE gnl_runs ADD COLUMN suspended_count INTEGER NOT NULL DEFAULT 0`);
      } catch (e) {
        if (!String((e as Error)?.message ?? e).includes('duplicate column')) throw e;
      }
      this.db.exec(`UPDATE gnl_runs SET suspended_count = (
        SELECT COUNT(*) FROM gnl_run_journal j WHERE j.run_id = gnl_runs.run_id AND j.suspended = 1)`);
    }
    // `failed` column: the same shape of migration as suspended_count above. MATERIALIZED at write
    // Time rather than derived at read time (there is no index on it — the status filter is an
    // Operator path), because filtering on the serialized outcome value would mean matching the
    // Word 'failed' inside error MESSAGES. Nothing to backfill — runs written before this have no
    // Outcome record at all, and 0 is exactly right for them (they read as before).
    if (!cols.some((c) => c.name === 'failed')) {
      try {
        this.db.exec(`ALTER TABLE gnl_runs ADD COLUMN failed INTEGER NOT NULL DEFAULT 0`);
      } catch (e) {
        if (!String((e as Error)?.message ?? e).includes('duplicate column')) throw e;
      }
    }
    // `running` (the write-ahead half of the outcome): same shape, same no-backfill argument — an
    // Outcome with status 'running' only exists from the write-ahead onward, so pre-existing rows
    // Have nothing to reconstruct it from and 0 reads as before.
    if (!cols.some((c) => c.name === 'running')) {
      try {
        this.db.exec(`ALTER TABLE gnl_runs ADD COLUMN running INTEGER NOT NULL DEFAULT 0`);
      } catch (e) {
        if (!String((e as Error)?.message ?? e).includes('duplicate column')) throw e;
      }
    }
    // `canceled`: same shape, same no-backfill argument again — a cancel recorded no outcome at all
    // Before this, so there is nothing in an older journal to reconstruct one from, and 0 reads as
    // Before. Three booleans for one status IS inelegant; they are only ever written together, from a
    // Single `outcomeStatusOf` value in a single statement (see putCore), so they cannot disagree —
    // Collapsing them into one materialized `outcome` TEXT column is a schema round of its own.
    if (!cols.some((c) => c.name === 'canceled')) {
      try {
        this.db.exec(`ALTER TABLE gnl_runs ADD COLUMN canceled INTEGER NOT NULL DEFAULT 0`);
      } catch (e) {
        if (!String((e as Error)?.message ?? e).includes('duplicate column')) throw e;
      }
    }
    // The seed used to be
    // Check-then-INSERT (SELECT → INSERT if absent) — a TOCTOU: two simultaneous booters both saw no
    // Row, both inserted, and the loser CRASHED ON BOOT with a UNIQUE constraint. `INSERT OR IGNORE`
    // Is the engine-atomic form of the same intent (write only if absent; an existing version row —
    // Whatever it says — is never overwritten, exactly as before).
    this.db.prepare(`INSERT OR IGNORE INTO gnl_meta(k,v) VALUES('schema_version', ?)`).run(SCHEMA_VERSION);
    const db = this.db;
    this.runs = new SqliteRunJournal(db);
    this.memory = new SqliteMemoryStore(db);
    this.vectors = new SqliteVectorStore(db);
    this.work = new SqliteWorkStore(db);
    this.cache = new SqliteCacheStore(db);
    this.meta = new SqliteMetaStore(db);
  }
  async init() {/* schema was set up idempotently in the constructor */}
  async close() {
    // Flush the WAL to the main file on close → no leftover side file buildup (H12).
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* :memory: etc. */ }
    this.db.close();
  }

  /**
   * H12: reclaiming deleted space on disk. purge/sweep leaves behind empty pages (the engine reuses
   * Them but doesn't return them to the OS); after a large purge, this method reclaims the disk space.
   * VACUUM briefly blocks in single-writer SQLite → call it during a cron/maintenance window, NOT on
   * The hot path. (`full` is ignored on SQLite since VACUUM is already complete.) No-op on a `:memory:` DB.
   */
  /**
   * See `Storage.adoptIntoOrg`. Every table that carries an organization-bearing column is listed here
   * ONCE — a table added later and not added to this list is data an upgrade silently leaves behind,
   * which is why the list sits next to the DDL rather than in a doc.
   *
   * `gnl_vectors` is the odd one: it is partitioned by a `namespace` COLUMN rather than by a key
   * prefix (the store ranks, so a prefix cannot be applied before it has already chosen its global
   * top K — see `VectorStore.query`). Its rows are stamped, not renamed, and the namespace has no
   * trailing colon, matching what `withOrgStorage` writes.
   */
  async adoptIntoOrg(orgId: string, opts?: { dryRun?: boolean; allowUnregistered?: boolean; allowInFlight?: boolean }): Promise<AdoptIntoOrgResult> {
    const prefix = orgPrefix(orgId);               // throws on '' or a ':'-bearing id — one guard, shared
    await assertOrgRegistered(this.runs, orgId, opts?.allowUnregistered);
    await assertNoRunsInFlight(this.runs, opts?.allowInFlight);
    const ns = prefix.slice(0, -1);                // 'org:acme', what scopedVectors writes
    const dryRun = opts?.dryRun === true;
    // [table, column, store-name-for-the-report]
    const KEYED: Array<[string, string, string]> = [
      ['gnl_run_journal', 'key', 'runs'],
      ['gnl_runs', 'run_id', 'runs'],
      ['gnl_counters', 'key', 'runs'],
      ['gnl_threads', 'id', 'memory'],
      ['gnl_messages', 'thread_id', 'memory'],
      ['gnl_working_memory', 'scope_id', 'memory'],
      ['gnl_observations', 'thread_id', 'memory'],
      ['gnl_message_batches', 'thread_id', 'memory'],
      ['gnl_work_log', 'ns', 'work'],
      ['gnl_work_kv', 'key', 'work'],
      ['gnl_cache', 'key', 'cache'],
    ];
    const moved: Record<string, number> = {};
    const skipped = new Set<string>();
    let alreadyScoped = 0;
    const bump = (store: string, n: number) => { moved[store] = (moved[store] ?? 0) + n; };

    const run = () => {
      for (const [table, col, store] of KEYED) {
        alreadyScoped += this.db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${col} LIKE 'org:%'`).get().c as number;
        // Row by row rather than one UPDATE, because which reserved keys are the PLATFORM's is a rule
        // in TypeScript (`isPlatformKey`), not something SQL can express — and a blanket UPDATE here
        // would move `__org__:acme` to `org:acme:__org__:acme` and stop every organization resolving.
        const rows = this.db.prepare(`SELECT DISTINCT ${col} AS k FROM ${table} WHERE ${col} NOT LIKE 'org:%'`).all() as { k: string }[];
        let n = 0;
        for (const { k } of rows) {
          if (isPlatformKey(k)) { skipped.add(k.split(':')[0]!); continue; }
          n += this.db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${col} = ?`).get(k).c as number;
          if (!dryRun) this.db.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`).run(prefix + k, k);
        }
        bump(store, n);
      }
      // `gnl_meta` minus the engine's own rows — see ENGINE_META_KEYS for why moving `schema_version`
      // would leave the deployment looking unversioned on its next boot.
      const holes = ENGINE_META_KEYS.map(() => '?').join(',');
      const metaTodo = this.db.prepare(`SELECT COUNT(*) AS c FROM gnl_meta WHERE k NOT LIKE 'org:%' AND k NOT IN (${holes})`).get(...ENGINE_META_KEYS).c as number;
      alreadyScoped += this.db.prepare(`SELECT COUNT(*) AS c FROM gnl_meta WHERE k LIKE 'org:%'`).get().c as number;
      if (!dryRun && metaTodo) this.db.prepare(`UPDATE gnl_meta SET k = ? || k WHERE k NOT LIKE 'org:%' AND k NOT IN (${holes})`).run(prefix, ...ENGINE_META_KEYS);
      bump('meta', metaTodo);

      const vecs = this.db.prepare(`SELECT COUNT(*) AS c FROM gnl_vectors WHERE namespace IS NULL`).get().c as number;
      alreadyScoped += this.db.prepare(`SELECT COUNT(*) AS c FROM gnl_vectors WHERE namespace IS NOT NULL`).get().c as number;
      if (!dryRun && vecs) this.db.prepare(`UPDATE gnl_vectors SET namespace = ? WHERE namespace IS NULL`).run(ns);
      bump('vectors', vecs);
    };

    // One transaction: a half-migrated store is worse than an unmigrated one, because the operator can
    // no longer tell which half is which.
    if (dryRun) run();
    else {
      this.db.exec('BEGIN IMMEDIATE');
      try { run(); this.db.exec('COMMIT'); } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    }
    return { orgId, dryRun, moved, alreadyScoped, skippedPlatformKeys: [...skipped].sort() };
  }

  async compact(): Promise<{ reclaimedBytes: number }> {
    if (this.dbPath === ':memory:') return { reclaimedBytes: 0 };
    let before = 0;
    try { before = statSync(this.dbPath).size + (existsSync(this.dbPath + '-wal') ? statSync(this.dbPath + '-wal').size : 0); } catch { /* new file */ }
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.db.exec('VACUUM');
    let after = before;
    try { after = statSync(this.dbPath).size; } catch { /* */ }
    return { reclaimedBytes: Math.max(0, before - after) };
  }

  /**
   * P2-migrate the adapter's full DDL as a flat statement array —
   * Connectionless/pure (no DB access), for CI schema diffing or documenting an out-of-band migration.
   * Includes the H11b `suspended_count` migration ALTER the constructor also runs (see migrate.ts's
   * Header for why this is diffing/documentation rather than a literal one-shot replay script for
   * SQLite specifically: the constructor's own init is eager and can't be disabled).
   */
  exportSchema(): string[] {
    return [
      ...DDL.split(';').map((s) => s.trim()).filter(Boolean),
      'ALTER TABLE gnl_runs ADD COLUMN suspended_count INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE gnl_runs ADD COLUMN failed INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE gnl_runs ADD COLUMN running INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE gnl_runs ADD COLUMN canceled INTEGER NOT NULL DEFAULT 0',
    ];
  }

  /**
   * P2-migrate: READ-ONLY dry-run — diffs the LIVE schema (sqlite_master + `PRAGMA table_info`) against
   * The DDL this adapter expects (parsed once via migrate.ts's `tablesFromDDL`, so "expected" can never
   * Drift from what the constructor actually creates). Never mutates. Reflects genuine drift even after
   * Construction (e.g. a manually altered table) — see migrate.ts's header for the construction-time caveat.
   */
  async checkSchema(): Promise<SchemaCheckResult> {
    const expected = tablesFromDDL(DDL);
    const liveTables = new Set(
      (this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[])
        .map((r) => r.name)
        .filter((n) => n.startsWith('gnl_')),
    );
    const missingTables: string[] = [];
    const missingColumns: MissingColumn[] = [];
    for (const [table, cols] of expected) {
      if (!liveTables.has(table)) { missingTables.push(table); continue; }
      const liveCols = new Set(
        (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name),
      );
      for (const col of cols.keys()) if (!liveCols.has(col)) missingColumns.push({ table, column: col });
    }
    const unknownTables = [...liveTables].filter((t) => !expected.has(t));
    return { ok: missingTables.length === 0 && missingColumns.length === 0, missingTables, missingColumns, unknownTables };
  }

  /**
   * P2-migrate: applies exactly the gap checkSchema reports — CREATE TABLE (+ its indexes) for a missing
   * Table, ADD COLUMN for a missing column — pulled from the SAME DDL text checkSchema/exportSchema
   * Parse (no hand-copied SQL). Additive ONLY: this never drops or renames anything — destructive schema
   * Changes are deliberately out of scope, see migrate.ts's header (the run journal is the append-only
   * Source of truth). `dryRun: true` returns the statements it WOULD run without touching the DB.
   */
  async migrateSchema(opts?: { dryRun?: boolean }): Promise<SchemaMigrationResult> {
    const check = await this.checkSchema();
    const expected = tablesFromDDL(DDL);
    const ddlStatements = DDL.split(';').map((s) => s.trim()).filter(Boolean);
    const statements: string[] = [];
    for (const table of check.missingTables) {
      for (const stmt of ddlStatements) {
        if (new RegExp(`^CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i').test(stmt)
          || new RegExp(`^CREATE INDEX IF NOT EXISTS \\S+ ON ${table}\\b`, 'i').test(stmt)) {
          statements.push(stmt);
        }
      }
    }
    for (const { table, column } of check.missingColumns) {
      const def = expected.get(table)?.get(column);
      if (def) statements.push(`ALTER TABLE ${table} ADD COLUMN ${def}`);
    }
    if (opts?.dryRun) return { statements, dryRun: true };
    for (const stmt of statements) {
      try {
        this.db.exec(stmt);
      } catch (e) {
        // Benign only if a concurrent migrator already applied the same ADD COLUMN (mirrors the
        // Constructor's own H11b duplicate-column swallow, above); any other error is real and surfaces.
        if (!String((e as Error)?.message ?? e).includes('duplicate column')) throw e;
      }
    }
    return { statements, dryRun: false };
  }
}

const DDL = `
CREATE TABLE IF NOT EXISTS gnl_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS gnl_run_journal (
  key TEXT PRIMARY KEY, run_id TEXT, kind TEXT, suspended INTEGER NOT NULL DEFAULT 0,
  value TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS gnl_run_journal_run ON gnl_run_journal (run_id, created_at);
CREATE TABLE IF NOT EXISTS gnl_runs (
  run_id TEXT PRIMARY KEY, model_steps INTEGER NOT NULL DEFAULT 0, tool_calls INTEGER NOT NULL DEFAULT 0,
  suspended INTEGER NOT NULL DEFAULT 0, suspended_count INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, running INTEGER NOT NULL DEFAULT 0, canceled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS gnl_runs_created ON gnl_runs (created_at, run_id);
CREATE INDEX IF NOT EXISTS gnl_runs_updated ON gnl_runs (updated_at);
CREATE TABLE IF NOT EXISTS gnl_counters (key TEXT NOT NULL, field TEXT NOT NULL, value REAL NOT NULL, PRIMARY KEY (key, field));
CREATE TABLE IF NOT EXISTS gnl_threads (
  id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, title TEXT, parent_thread_id TEXT,
  metadata TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS gnl_threads_res ON gnl_threads (resource_id, updated_at);
CREATE TABLE IF NOT EXISTS gnl_messages (
  thread_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL, text TEXT,
  embedding TEXT, metadata TEXT, ts INTEGER NOT NULL, message TEXT NOT NULL,
  PRIMARY KEY (thread_id, seq)
);
CREATE TABLE IF NOT EXISTS gnl_working_memory (scope_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS gnl_observations (thread_id TEXT PRIMARY KEY, obs TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS gnl_message_batches (thread_id TEXT NOT NULL, batch_key TEXT NOT NULL, seq_from INTEGER NOT NULL, seq_to INTEGER NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (thread_id, batch_key));
CREATE TABLE IF NOT EXISTS gnl_vectors (id TEXT PRIMARY KEY, text TEXT NOT NULL, embedding TEXT NOT NULL, metadata TEXT, namespace TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS gnl_work_log (ns TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (ns, id));
CREATE INDEX IF NOT EXISTS gnl_work_log_ns ON gnl_work_log (ns, ts);
CREATE TABLE IF NOT EXISTS gnl_work_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS gnl_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER);
`;

// ── RunJournal ──────────────────────────────────────────────────────────────────
class SqliteRunJournal implements RunJournal {
  constructor(private db: any) {}

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const row = this.db.prepare('SELECT value FROM gnl_run_journal WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? deserialize<T>(row.value) : undefined;
  }
  /**
   * T1 audit fix: the SELECT prev → journal write → gnl_runs delta trio is A SINGLE atomic unit.
   * In autocommit there were two hazards: (1) two PROCESSES both see prev=absent for the same NEW key →
   * The gnl_runs counter is double-incremented (doesn't happen within a single process since node:sqlite
   * Is synchronous, but it does across multiple processes); (2) a crash between the suspended write and
   * The gnl_runs update → stale suspended=0 → retention (sweepRuns's fast path listStaleRuns) could delete a suspended run.
   * BEGIN IMMEDIATE: the write lock is acquired upfront → no read→write lock-upgrade BUSY, and
   * Concurrent processes are fully serialized. If the caller is ALREADY inside a transaction (the
   * "within a transaction" error), it proceeds without wrapping — the outer transaction provides
   * Atomicity (a savepoint is unnecessary: nothing in src/ calls the journal from inside a transaction,
   * This is purely a safety net for external callers).
   * Other errors are NOT SWALLOWED — thrown rather than silently dropping atomicity. SQLITE_BUSY is
   * The one contended-but-transient case, and it is handled WITHOUT weakening that rule: the retry
   * Lives one level down, per STATEMENT (BusyRetryDatabase — `BEGIN IMMEDIATE` is a statement, so a
   * Contended lock is retried from before the transaction's first write); once its bound is exhausted
   * The error still lands here and is still thrown, after this ROLLBACK.
   */
  private withTx<T>(fn: () => T): T {
    let began = false;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      began = true;
    } catch (e) {
      if (!/within a transaction/i.test(String((e as Error)?.message ?? e))) throw e;
    }
    try {
      const out = fn();
      if (began) this.db.exec('COMMIT');
      return out;
    } catch (e) {
      if (began) { try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ } }
      throw e;
    }
  }

  async put(key: string, value: unknown): Promise<void> {
    this.putCore(key, value);
  }
  /** SYNC core of put — shared with applyBatch (which must stay await-free inside its transaction). */
  private putCore(key: string, value: unknown): void {
    const p = parseJournalKey(key);
    const suspended = p?.kind === 'tool' && (value as ToolJournalRecord | undefined)?.status === 'suspended' ? 1 : 0;
    const upsert = () => this.db.prepare(
      `INSERT INTO gnl_run_journal (key, run_id, kind, suspended, value, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, suspended = excluded.suspended`,
    ).run(key, p?.runId ?? null, p?.kind ?? null, suspended, serialize(value), Date.now());
    if (!p) {
      // Not a replayable entry — so it gets NO run_id and NO kind in the journal table (readRun and
      // Time-travel must not start seeing it). But if it belongs to a run, the run itself has to exist
      // In the index, or a run that died before its first model step is invisible to listRuns and,
      // Worse, to sweepRuns — its persisted prompt then outlives every retention window.
      const owner = runIdOfKey(key, value);
      const oc = outcomeStatusOf(key, value);
      if (!owner && oc === null) { upsert(); return; } // genuinely run-less key (queues, events, cache)
      this.withTx(() => {
        upsert();
        if (owner) this.touchRunDelta(owner, null, false, 0);
        // The outcome carries its OWN path rather than riding on run ownership: it is not a versioned
        // Record, so runIdOfKey (which now demands that proof) does not claim it. The UPDATE only
        // Touches a row that already exists, so it cannot invent a run. ALL THREE flags from ONE
        // Status in ONE statement, so they can never disagree — and every transition clears its
        // Predecessors (running→canceled leaves running=0, which is what the five-way filter reads).
        if (oc !== null) {
          const runId = key.slice(0, -':outcome'.length);
          // The write-ahead 'running' is the FIRST write of a brand-new run — before `:input`, before
          // any entry — so the row may not exist yet, and an UPDATE against a missing row silently
          // dropped the flag (measured: outcome said running, gnl_runs said 0 0 0 → 'completed', the
          // exact lie this vocabulary removes). touchRunDelta's upsert creates the row with zero
          // counts; an outcome is only ever written by the engine for a real run, so this does not
          // reopen the invented-run hazard the non-owner branch guards against.
          this.touchRunDelta(runId, null, false, 0);
          this.db.prepare(`UPDATE gnl_runs SET failed = ?, running = ?, canceled = ? WHERE run_id = ?`).run(oc === 'failed' ? 1 : 0, oc === 'running' ? 1 : 0, oc === 'canceled' ? 1 : 0, runId);
        }
      });
      return;
    }
    this.withTx(() => {
      // H11b: an O(1) point read BEFORE writing → is-new-row + old suspended (for the incremental touch).
      // The old touchRun used to SUM ALL rows of the run on every write → write cost GREW with the
      // Run's length (measured: +8% at 3000 steps, linear). Now it's O(1).
      const prev = this.db.prepare(`SELECT suspended FROM gnl_run_journal WHERE key = ?`).get(key) as { suspended: number } | undefined;
      upsert();
      this.touchRunDelta(p.runId, p.kind, prev === undefined, suspended - (prev?.suspended ?? 0));
    });
  }
  async putIfAbsent(key: string, value: unknown): Promise<boolean> {
    return this.putIfAbsentCore(key, value);
  }
  /** SYNC core of putIfAbsent — shared with applyBatch (await-free transaction requirement). */
  private putIfAbsentCore(key: string, value: unknown): boolean {
    const p = parseJournalKey(key);
    const suspended = p?.kind === 'tool' && (value as ToolJournalRecord | undefined)?.status === 'suspended' ? 1 : 0;
    const ins = () => this.db.prepare(
      `INSERT INTO gnl_run_journal (key, run_id, kind, suspended, value, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO NOTHING`,
    ).run(key, p?.runId ?? null, p?.kind ?? null, suspended, serialize(value), Date.now());
    if (!p) {
      const owner = runIdOfKey(key, value);
      const oc = outcomeStatusOf(key, value);
      if (!owner && oc === null) return ins().changes === 1; // genuinely run-less key
      return this.withTx(() => {
        const info = ins();
        if (info.changes === 1) {
          if (owner) this.touchRunDelta(owner, null, false, 0);
          // The outcome's first write arrives through putIfAbsent (recordRunOutcome's monotonic
          // path); handling the flags only in put() left sqlite reading every failure as completed.
          if (oc !== null) {
            const runId = key.slice(0, -':outcome'.length);
            this.touchRunDelta(runId, null, false, 0); // first write of a new run — see putCore's twin
            this.db.prepare(`UPDATE gnl_runs SET failed = ?, running = ?, canceled = ? WHERE run_id = ?`).run(oc === 'failed' ? 1 : 0, oc === 'running' ? 1 : 0, oc === 'canceled' ? 1 : 0, runId);
          }
        }
        return info.changes === 1;
      });
    }
    return this.withTx(() => {
      const info = ins();
      if (info.changes === 1) this.touchRunDelta(p.runId, p.kind, true, suspended); // fresh insert → O(1)
      return info.changes === 1;
    });
  }
  /**
   * H1: atomic conditional replace (expired run-lock takeover, see journal.ts JSDoc).
   * The STORED FORM is PLAIN serialize() TEXT (no envelope) → the comparison happens directly in SQL:
   * `WHERE key=? AND value=serialize(expected)` — the TOCTOU window is closed inside the engine.
   * Contract assumption: the superjson roundtrip is stable (serialize(deserialize(s)) === s) — holds
   * For plain objects like LockRecord; on a deviation it just won't match → false = the SAFE side (no takeover that round).
   */
  async putIfMatch(key: string, expected: unknown, value: unknown): Promise<boolean> {
    const p = parseJournalKey(key);
    const suspended = p?.kind === 'tool' && (value as ToolJournalRecord | undefined)?.status === 'suspended' ? 1 : 0;
    const upd = () => this.db.prepare(
      'UPDATE gnl_run_journal SET value = ?, suspended = ? WHERE key = ? AND value = ?',
    ).run(serialize(value), suspended, key, serialize(expected));
    if (!p) {
      const oc = outcomeStatusOf(key, value);
      if (oc === null) return Number(upd().changes ?? 0) === 1; // lock key (e.g. ':lock') → no derived index
      // The monotonic outcome REPLACEMENT (running→terminal, or a later success clearing an earlier
      // failure) arrives through putIfMatch — the flags must follow the record here too.
      return this.withTx(() => {
        const ok = Number(upd().changes ?? 0) === 1;
        if (ok) {
          const runId = key.slice(0, -':outcome'.length);
          this.touchRunDelta(runId, null, false, 0); // see putCore's twin
          this.db.prepare(`UPDATE gnl_runs SET failed = ?, running = ?, canceled = ? WHERE run_id = ?`).run(oc === 'failed' ? 1 : 0, oc === 'running' ? 1 : 0, oc === 'canceled' ? 1 : 0, runId);
        }
        return ok;
      });
    }
    // T1 (symmetric with the Postgres side): there's already no await between UPDATE and recountRun in
    // JS (structurally atomic within a single process) but the CRASH window is a separate concern — if
    // The process dies between the two, gnl_runs stays stale (this rare path had been untested until
    // Now). withTx provides the same BEGIN IMMEDIATE/COMMIT protection here too; the cost is negligible (takeover is a rare path).
    return this.withTx(() => {
      const ok = Number(upd().changes ?? 0) === 1;
      if (ok) this.recountRun(p.runId); // rare path (takeover) → a full recount is safe and sufficient
      return ok;
    });
  }

  /** H8a: engine-internal atomic counter (UPSERT arithmetic) — lost-update is impossible. */
  async incrBy(key: string, fields: Record<string, number>): Promise<void> {
    this.incrByCore(key, fields);
  }
  /** SYNC core of incrBy — shared with applyBatch (await-free transaction requirement). */
  private incrByCore(key: string, fields: Record<string, number>): void {
    const st = this.db.prepare(
      'INSERT INTO gnl_counters (key, field, value) VALUES (?, ?, ?) ON CONFLICT(key, field) DO UPDATE SET value = value + excluded.value',
    );
    for (const [f, d] of Object.entries(fields)) st.run(key, f, d);
  }
  async getCounters(key: string): Promise<Record<string, number> | undefined> {
    const rows = this.db.prepare('SELECT field, value FROM gnl_counters WHERE key = ?').all(key) as { field: string; value: number }[];
    if (!rows.length) return undefined;
    return Object.fromEntries(rows.map((r) => [r.field, Number(r.value)]));
  }

  /** H8b: indexed age query for sweepRuns — without transferring entries (gnl_runs.updated_at). */
  async listStaleRuns(cutoffTs: number, opts?: { includeSuspended?: boolean }): Promise<string[]> {
    const sql = opts?.includeSuspended
      ? 'SELECT run_id FROM gnl_runs WHERE updated_at < ?'
      : 'SELECT run_id FROM gnl_runs WHERE updated_at < ? AND suspended = 0';
    return (this.db.prepare(sql).all(cutoffTs) as { run_id: string }[]).map((r) => r.run_id);
  }

  /** H8c: cheap run stats — COUNT + total value length (without transferring data). */
  async readRunStats(runId: string): Promise<{ entries: number; bytes: number }> {
    const r = this.db.prepare(
      'SELECT COUNT(*) AS c, COALESCE(SUM(LENGTH(value)), 0) AS b FROM gnl_run_journal WHERE run_id = ?',
    ).get(runId) as { c: number; b: number };
    return { entries: Number(r.c), bytes: Number(r.b) };
  }
  /**
   * H11b — O(1) INCREMENTAL gnl_runs update (hot path). The old recompute used to SUM ALL rows of
   * The run on every write → write cost grew with the run's length. Now: a fresh insert →
   * Counter +1; an overwrite → counter unchanged; suspended is kept as a SIGNED sum of row transitions
   * (suspended_count) → it can correctly DECREASE on a suspended-to-succeeded transition (a boolean MAX
   * Couldn't do that). The `suspended` boolean is derived in the same expression (count+delta > 0).
   */
  private touchRunDelta(runId: string, kind: 'model' | 'tool' | null, isInsert: boolean, suspendedDelta: number): void {
    const m = isInsert && kind === 'model' ? 1 : 0;
    const t = isInsert && kind === 'tool' ? 1 : 0;
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO gnl_runs (run_id, model_steps, tool_calls, suspended, suspended_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         model_steps = gnl_runs.model_steps + ?,
         tool_calls = gnl_runs.tool_calls + ?,
         suspended_count = gnl_runs.suspended_count + ?,
         suspended = (gnl_runs.suspended_count + ?) > 0,
         updated_at = ?`,
    ).run(runId, m, t, suspendedDelta > 0 ? 1 : 0, Math.max(0, suspendedDelta), now, now,
          m, t, suspendedDelta, suspendedDelta, now);
  }

  /** Full recount — for rare paths (putIfMatch/repair); NOT USED on the hot path. */
  private recountRun(runId: string): void {
    const c = this.db.prepare(
      `SELECT
         SUM(CASE WHEN kind='model' THEN 1 ELSE 0 END) AS m,
         SUM(CASE WHEN kind='tool' THEN 1 ELSE 0 END) AS t,
         SUM(suspended) AS s, MIN(created_at) AS c0
       FROM gnl_run_journal WHERE run_id = ?`,
    ).get(runId) as { m: number; t: number; s: number; c0: number };
    this.db.prepare(
      `INSERT INTO gnl_runs (run_id, model_steps, tool_calls, suspended, suspended_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET model_steps=excluded.model_steps, tool_calls=excluded.tool_calls,
         suspended=excluded.suspended, suspended_count=excluded.suspended_count, updated_at=excluded.updated_at`,
    ).run(runId, c.m ?? 0, c.t ?? 0, (c.s ?? 0) > 0 ? 1 : 0, c.s ?? 0, c.c0 ?? Date.now(), Date.now());
  }
  async listKeys(prefix: string): Promise<string[]> {
    const rg = range('key', prefix);
    // `key` tie-breaker — same reason `readRun` below carries one (Decision #4): entries written in
    // the same millisecond have no defined order without it, so two reads of one prefix can disagree.
    // SQLite's plan is stabler than Postgres's in practice, which is exactly why this was easy to
    // leave out and hard to notice; the guarantee should not depend on which engine you happen to run.
    const rows = this.db.prepare(`SELECT key FROM gnl_run_journal WHERE ${rg.where} ORDER BY created_at, key`)
      .all(...rg.params) as { key: string }[];
    return rows.map((r) => r.key);
  }

  /** Retention/GDPR: PERMANENTLY delete keys starting with the prefix; also clean up the derived gnl_runs index. */
  async deletePrefix(prefix: string): Promise<number> {
    const jr = range('key', prefix);
    const r = this.db.prepare(`DELETE FROM gnl_run_journal WHERE ${jr.where}`).run(...jr.params);
    // Deleting by a `<runId>:` prefix must also drop the run summary (gnl_runs is indexed by run_id).
    const rid = prefix.endsWith(':') ? prefix.slice(0, -1) : prefix;
    const rr = range('run_id', prefix);
    this.db.prepare(`DELETE FROM gnl_runs WHERE run_id = ? OR (${rr.where})`).run(rid, ...rr.params);
    // Counters (incrBy/H8a) are keys too — the deletePrefix contract (journal.ts) says ALL keys under
    // The prefix go. Without this, an org purge (GDPR) left `org:<id>:__usage__` behind forever, and
    // RebuildMetrics's wipe kept stale `__metrics__:` counters (recompute would ADD on top of them).
    // Not included in the return count, same as the derived gnl_runs rows above.
    const cr = range('key', prefix);
    this.db.prepare(`DELETE FROM gnl_counters WHERE ${cr.where}`).run(...cr.params);
    return Number(r.changes ?? 0);
  }
  async readRun(runId: string): Promise<JournalEntry[]> {
    // Decision #4: `key` tie-breaker — the order of records written in the same ms is deterministic
    // (limits.ts's loop counting + regression diff rely on the order; identical semantics to Postgres).
    const rows = this.db.prepare(
      'SELECT key, kind, value, created_at FROM gnl_run_journal WHERE run_id = ? ORDER BY created_at, key',
    ).all(runId) as { key: string; kind: string; value: string; created_at: number }[];
    return rows.map((r, seq) => ({ key: r.key, runId, kind: r.kind as JournalEntry['kind'], value: deserialize(r.value), seq, ts: r.created_at }));
  }
  /**
   * AUDIT (threadId first-class): surface the threadId from the run's invisible `:input` entry
   * (`<run_id>:input`) in A SINGLE query — the (per-row correlated) subquery is NOT N+1, it's part
   * Of the single SELECT. Ordering (LIMIT/OFFSET) is already applied on `gnl_runs` → the subquery
   * Only runs for the rows on that page (the SQLite planner applies the subquery to the rows after LIMIT).
   *
   * P0.3 filters: `status` is pushed down to SQL as a WHERE on the materialized
   * `gnl_runs.suspended` column — same boolean `listRuns` already derives status FROM (`r.suspended ?
   * 'suspended' : 'completed'`), so it cannot drift from the unfiltered read. `agent` has NO indexed
   * Column of its own (it lives inside the superjson-serialized `:input` blob) — pushing it into SQL
   * Would mean parsing that blob in a WHERE clause, which isn't sargable anyway. Honest cost: when
   * `agent` is given, this fetches every (status-filtered) run's summary WITHOUT LIMIT/OFFSET, decodes
   * `:input` for each, filters+paginates in JS (filter BEFORE slicing — never after). Acceptable since
   * The agent filter is an operator/debug tool, not a hot path; a dedicated `agent` column+index would
   * Be the fix if this ever becomes a bottleneck at scale.
   */
  async listRuns(q?: ListQuery): Promise<Page<RunSummary>> {
    const { start, limit } = offset(q);
    // Five-way, still entirely in SQL and still on indexed columns — 'canceled' outranks 'suspended',
    // Which outranks the rest of the recorded outcome, matching deriveRunStatus exactly (see
    // journal.ts), so a filtered page and an unfiltered scan can never disagree about the same run.
    const statusWhere =
      q?.status === 'canceled' ? ' WHERE canceled = 1'
      : q?.status === 'suspended' ? ' WHERE canceled = 0 AND suspended = 1'
      : q?.status === 'failed' ? ' WHERE canceled = 0 AND suspended = 0 AND failed = 1'
      : q?.status === 'running' ? ' WHERE canceled = 0 AND suspended = 0 AND failed = 0 AND running = 1'
      : q?.status === 'completed' ? ' WHERE canceled = 0 AND suspended = 0 AND failed = 0 AND running = 0'
      : '';
    const statusParams: unknown[] = [];
    const toSummary = (r: RunRow): RunSummary => {
      const input = r.input_val ? deserialize<{ threadId?: string; agent?: string; resourceId?: string }>(r.input_val) : undefined;
      return {
        runId: r.run_id, status: deriveRunStatus(!!r.suspended, outcomeOfRow(r)), modelSteps: r.model_steps, toolCalls: r.tool_calls,
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
      const rows = this.db.prepare(
        `SELECT r.run_id, r.model_steps, r.tool_calls, r.suspended, r.failed, r.running, r.canceled,
                (SELECT value FROM gnl_run_journal WHERE key = r.run_id || ':input') AS input_val
         FROM gnl_runs r${statusWhere} ORDER BY r.created_at, r.run_id`,
      ).all(...statusParams) as RunRow[];
      const all = rows.map(toSummary)
        .filter((r) => (q.agent ? r.agent === q.agent : true) && (q.resourceId ? r.resourceId === q.resourceId : true));
      return pageOf(all.slice(start, start + limit), start, limit, all.length);
    }
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM gnl_runs${statusWhere}`).get(...statusParams) as { n: number }).n;
    const rows = this.db.prepare(
      `SELECT r.run_id, r.model_steps, r.tool_calls, r.suspended, r.failed, r.running, r.canceled,
              (SELECT value FROM gnl_run_journal WHERE key = r.run_id || ':input') AS input_val
       FROM gnl_runs r${statusWhere} ORDER BY r.created_at, r.run_id LIMIT ? OFFSET ?`,
    ).all(...statusParams, limit, start) as RunRow[];
    return pageOf(rows.map(toSummary), start, limit, total);
  }

  /**
   * P1.6b: atomic batch — claim (putIfAbsent semantics) + counter increments + puts as ONE transaction.
   * Written out explicitly (mirroring `withTx`'s BEGIN IMMEDIATE/COMMIT/ROLLBACK idiom) rather than
   * Reusing `withTx` directly because it needs to `await` the existing `put`/`putIfAbsent`/`incrBy`
   * Calls in between — `withTx`'s `fn` is synchronous. Those calls detect the already-open transaction
   * (the SAME "within a transaction" reentrancy `withTx` already relies on) and skip their OWN
   * BEGIN/COMMIT → ALL derived bookkeeping (gnl_runs `touchRunDelta` etc.) is reused as-is, no SQL
   * Duplicated. Claim-loses → `false`, with NOTHING else applied (checked FIRST, before any incr/put).
   */
  // P1.6b: ONE synchronous withTx block with ZERO awaits inside — critical, not stylistic. node:sqlite
  // Is sync, but an `await` between BEGIN and COMMIT yields to the event loop, and a CONCURRENT caller's
  // Statements would then JOIN this open transaction (its own nested BEGIN is swallowed by withTx) —
  // Our ROLLBACK could erase its committed-in-good-faith writes. The sync cores (putIfAbsentCore/
  // IncrByCore/putCore) exist precisely so this block never yields; their internal withTx nesting is
  // Safe (began=false inner → no premature COMMIT). Claim lost → return false; withTx commits the
  // (empty) transaction — nothing was written, so that commit is a no-op by construction.
  async applyBatch(batch: JournalBatch): Promise<boolean> {
    return this.withTx(() => {
      if (batch.claim && !this.putIfAbsentCore(batch.claim.key, batch.claim.value)) return false;
      for (const { key, fields } of batch.incrs ?? []) this.incrByCore(key, fields);
      for (const { key, value } of batch.puts ?? []) this.putCore(key, value);
      return true;
    });
  }

  /** P1.6b: batch point-read — a single `WHERE key IN (...)` instead of N sequential `get` calls;
   *  Order-preserving, `undefined` for misses (getMany contract, journal.ts). */
  async getMany<T = unknown>(keys: string[]): Promise<(T | undefined)[]> {
    if (keys.length === 0) return [];
    const placeholders = keys.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT key, value FROM gnl_run_journal WHERE key IN (${placeholders})`).all(...keys) as { key: string; value: string }[];
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    return keys.map((k) => (byKey.has(k) ? deserialize<T>(byKey.get(k)!) : undefined));
  }

  /**
   * P1.6b: push-down status aggregate — a single `GROUP BY` over the same materialized `gnl_runs`
   * Columns, MUST MATCH listRuns' own status derivation (deriveRunStatus: canceled, then suspended,
   * Then failed, then running) — same columns, same order, so it cannot drift. `canceled` leads the
   * CASE for the same reason it leads deriveRunStatus: a run canceled while suspended is over.
   */
  async countRunsByStatus(): Promise<Record<string, number>> {
    const rows = this.db.prepare(
      `SELECT CASE WHEN canceled THEN 'canceled' WHEN suspended THEN 'suspended' WHEN failed THEN 'failed' WHEN running THEN 'running' ELSE 'completed' END AS status, COUNT(*) AS n FROM gnl_runs GROUP BY status`,
    ).all() as { status: string; n: number }[];
    const out: Record<string, number> = {};
    for (const r of rows) out[r.status] = Number(r.n);
    return out;
  }
}

// ── MemoryStore ────────────────────────────────────────────────────────────────
class SqliteMemoryStore implements MemoryStore {
  constructor(private db: any) {}

  async upsertThread(rec: ThreadRecord): Promise<void> {
    this.db.prepare(
      `INSERT INTO gnl_threads (id, resource_id, title, parent_thread_id, metadata, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET resource_id=excluded.resource_id, title=excluded.title,
         parent_thread_id=excluded.parent_thread_id, metadata=excluded.metadata, updated_at=excluded.updated_at,
         deleted_at=excluded.deleted_at`,
    ).run(rec.id, rec.resourceId, rec.title ?? null, rec.parentThreadId ?? null,
      rec.metadata ? serialize(rec.metadata) : null, rec.createdAt, rec.updatedAt, rec.deletedAt ?? null);
  }
  private rowToThread(r: any): ThreadRecord {
    return {
      id: r.id, resourceId: r.resource_id, title: r.title ?? undefined,
      parentThreadId: r.parent_thread_id ?? undefined,
      metadata: r.metadata ? deserialize(r.metadata) : undefined,
      createdAt: r.created_at, updatedAt: r.updated_at, deletedAt: r.deleted_at ?? undefined,
    };
  }
  async getThread(id: string): Promise<ThreadRecord | undefined> {
    const r = this.db.prepare('SELECT * FROM gnl_threads WHERE id = ? AND deleted_at IS NULL').get(id);
    return r ? this.rowToThread(r) : undefined;
  }
  async listThreads(q: { resourceId?: string } & ListQuery): Promise<Page<ThreadRecord>> {
    const { start, limit } = offset(q);
    const where = q.resourceId != null ? 'deleted_at IS NULL AND resource_id = ?' : 'deleted_at IS NULL';
    const params = q.resourceId != null ? [q.resourceId] : [];
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM gnl_threads WHERE ${where}`).get(...params) as { n: number }).n;
    const rows = this.db.prepare(`SELECT * FROM gnl_threads WHERE ${where} ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`)
      .all(...params, limit, start);
    return pageOf(rows.map((r: any) => this.rowToThread(r)), start, limit, total);
  }
  async deleteThread(id: string): Promise<void> {
    this.db.prepare('UPDATE gnl_threads SET deleted_at = ? WHERE id = ?').run(Date.now(), id);
    this.db.prepare('DELETE FROM gnl_messages WHERE thread_id = ?').run(id);
    this.db.prepare('DELETE FROM gnl_working_memory WHERE scope_id = ?').run(id);
    this.db.prepare('DELETE FROM gnl_observations WHERE thread_id = ?').run(id);
    // See the Postgres twin: a resurrected thread that kept its markers silently drops a legitimate
    // batch that reuses one of them.
    this.db.prepare('DELETE FROM gnl_message_batches WHERE thread_id = ?').run(id);
  }
  /**
   * The same BEGIN IMMEDIATE idiom the run journal uses (see `withTx` there, and the note about why
   * the body must not `await`). Duplicated rather than shared because it is four lines and the
   * journal's copy is private to a different class; extracting it would be a wider change than the
   * defect warrants.
   *
   * IMMEDIATE, not deferred: it takes the write lock up front, so two processes on one database file
   * cannot both read a stale tail and then collide. `fn` is synchronous, which is load-bearing —
   * node:sqlite is synchronous, and an `await` between BEGIN and COMMIT would let a concurrent caller
   * join this open transaction and have its committed-in-good-faith writes erased by our ROLLBACK.
   */
  private withTx<T>(fn: () => T): T {
    let began = false;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      began = true;
    } catch (e) {
      if (!/within a transaction/i.test(String((e as Error)?.message ?? e))) throw e;
    }
    try {
      const out = fn();
      if (began) this.db.exec('COMMIT');
      return out;
    } catch (e) {
      if (began) { try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ } }
      throw e;
    }
  }

  /**
   * ONE TRANSACTION for the whole batch — see the long note on the Postgres adapter's
   * `appendMessages`. The rows of an append must land together or not at all: a batch is
   * `[assistant(tool-call), tool(tool-result)]`, and a half-written one leaves the thread holding a
   * tool call nothing ever answers, which the AI SDK rejects on every later turn until the orphan
   * slides out of the memory window (see the Postgres adapter for the measured cost).
   *
   * Postgres showed this first because its adapter wrote each row on its own pooled connection. On
   * sqlite the single-process case was already safe by accident (node:sqlite is synchronous, so the
   * loop cannot be interrupted); the exposed case is several processes on one file, where each
   * `stmt.run` was its own autocommit. Measured there: 3 processes x 40 appends lost 14 of 120
   * messages. The transaction closes the multi-process case and costs nothing in the single-process
   * one.
   */
  async appendMessagesOnce(threadId: string, rows: MessageAppend[], batchKey: string): Promise<boolean> {
    const assign = assertUniformSeq(threadId, rows);
    const stmt = this.db.prepare(
      `INSERT INTO gnl_messages (thread_id, seq, role, text, embedding, metadata, ts, message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(thread_id, seq) DO NOTHING`,
    );
    const strict = this.db.prepare(
      `INSERT INTO gnl_messages (thread_id, seq, role, text, embedding, metadata, ts, message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tail = this.db.prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM gnl_messages WHERE thread_id = ?');
    const claim = this.db.prepare(
      `INSERT INTO gnl_message_batches (thread_id, batch_key, seq_from, seq_to, ts) VALUES (?, ?, 0, 0, ?)
       ON CONFLICT(thread_id, batch_key) DO NOTHING`,
    );
    const settle = this.db.prepare('UPDATE gnl_message_batches SET seq_from = ?, seq_to = ? WHERE thread_id = ? AND batch_key = ?');
    // BEGIN IMMEDIATE takes the write lock before the claim is read, so two processes racing the same
    // key cannot both see it absent. The claim and the rows commit together or not at all.
    return this.withTx(() => {
      if (Number(claim.run(threadId, batchKey, Date.now()).changes ?? 0) === 0) return false;
      let next = assign ? Number(tail.get(threadId).n) : 0;
      const from = next;
      for (const r of rows) {
        (r.seq === undefined ? strict : stmt).run(threadId, r.seq ?? next++, r.role, r.text ?? null,
          r.embedding ? JSON.stringify(r.embedding) : null,
          r.metadata ? serialize(r.metadata) : null, r.ts, serialize(r.message));
      }
      settle.run(from, next, threadId, batchKey);
      return true;
    });
  }

  async appendMessages(threadId: string, rows: MessageAppend[]): Promise<void> {
    if (rows.length === 0) return;
    const assign = assertUniformSeq(threadId, rows);
    const stmt = this.db.prepare(
      `INSERT INTO gnl_messages (thread_id, seq, role, text, embedding, metadata, ts, message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(thread_id, seq) DO NOTHING`,
    );
    // No ON CONFLICT for positions this method assigned: a conflict there means something is wrong,
    // and swallowing it would silently drop a message. Explicit positions keep the idempotent form.
    const strict = this.db.prepare(
      `INSERT INTO gnl_messages (thread_id, seq, role, text, embedding, metadata, ts, message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tail = this.db.prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM gnl_messages WHERE thread_id = ?');
    this.withTx(() => {
      // No advisory lock needed here: BEGIN IMMEDIATE already took the database's write lock, so the
      // tail this reads cannot move before COMMIT — across processes sharing the file as well as
      // within one. That is the whole reason the transaction is IMMEDIATE rather than deferred.
      let next = assign ? Number(tail.get(threadId).n) : 0;
      for (const r of rows) {
        (r.seq === undefined ? strict : stmt).run(threadId, r.seq ?? next++, r.role, r.text ?? null,
          r.embedding ? JSON.stringify(r.embedding) : null,
          r.metadata ? serialize(r.metadata) : null, r.ts, serialize(r.message));
      }
    });
  }
  private rowToMsg(r: any): MessageRecord {
    return {
      threadId: r.thread_id, seq: r.seq, role: r.role, text: r.text ?? undefined,
      embedding: r.embedding ? JSON.parse(r.embedding) : undefined,
      metadata: r.metadata ? deserialize(r.metadata) : undefined, ts: r.ts, message: deserialize(r.message),
    };
  }
  async getMessages(threadId: string, q?: ListQuery): Promise<Page<MessageRecord>> {
    const { start, limit } = offset(q);
    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM gnl_messages WHERE thread_id = ?').get(threadId) as { n: number }).n;
    const rows = this.db.prepare('SELECT * FROM gnl_messages WHERE thread_id = ? ORDER BY seq LIMIT ? OFFSET ?')
      .all(threadId, limit, start);
    return pageOf(rows.map((r: any) => this.rowToMsg(r)), start, limit, total);
  }
  /**
   * FLOW-10: tail-truncate — deletes every row with seq > afterSeq for the thread; afterSeq itself
   * (and everything before it) is kept. `gnl_messages`' PK is (thread_id, seq), so this is a direct
   * Indexed range delete. Unknown/nonexistent threadId simply matches zero rows → 0, never throws.
   * Observations (gnl_observations) are a separate table and are intentionally left untouched.
   */
  async deleteMessagesAfter(threadId: string, afterSeq: number): Promise<number> {
    const info = this.db.prepare('DELETE FROM gnl_messages WHERE thread_id = ? AND seq > ?').run(threadId, afterSeq);
    // Markers for batches that ended past the cut go with them. Leaving them behind makes a later
    // batch reusing the same key look "already applied", and the regenerated turn is dropped in
    // silence — measured at 1 message written where 3 were expected, which is the exact class of loss
    // batch identity exists to prevent.
    this.db.prepare('DELETE FROM gnl_message_batches WHERE thread_id = ? AND seq_to > ?').run(threadId, afterSeq);
    return Number(info.changes ?? 0);
  }
  async recall(threadId: string, query: number[], opts: RecallOptions): Promise<MessageRecord[]> {
    if (!hasNorm(query)) return [];
    let rows: any[];
    if (opts.scope === 'resource' && opts.resourceId) {
      rows = this.db.prepare(
        `SELECT m.* FROM gnl_messages m JOIN gnl_threads t ON t.id = m.thread_id
         WHERE t.resource_id = ? AND t.deleted_at IS NULL ORDER BY m.thread_id, m.seq`,
      ).all(opts.resourceId);
    } else {
      rows = this.db.prepare('SELECT * FROM gnl_messages WHERE thread_id = ? ORDER BY seq').all(threadId);
    }
    const byThread = new Map<string, MessageRecord[]>();
    for (const r of rows) {
      const m = this.rowToMsg(r);
      const arr = byThread.get(m.threadId) ?? [];
      arr.push(m); byThread.set(m.threadId, arr);
    }
    const threshold = opts.threshold ?? 0;
    const cand: { m: MessageRecord; tid: string; idx: number; score: number }[] = [];
    for (const [tid, msgs] of byThread) {
      msgs.forEach((m, idx) => {
        if (!hasNorm(m.embedding)) return;
        const score = cosineSimilarity(query, m.embedding);
        if (score > 0 && score >= threshold) cand.push({ m, tid, idx, score });
      });
    }
    let scored = cand;
    if (opts.filter) scored = scored.filter((c) => matchFilter(c.m.metadata, opts.filter!));
    scored.sort((a, b) => b.score - a.score);
    const hits = scored.slice(0, opts.topK ?? 3);
    const range = normRange(opts.messageRange);
    const picked = new Map<string, MessageRecord>();
    for (const h of hits) {
      const msgs = byThread.get(h.tid)!;
      const lo = Math.max(0, h.idx - range.before);
      const hi = Math.min(msgs.length - 1, h.idx + range.after);
      for (let i = lo; i <= hi; i++) picked.set(`${h.tid}:${msgs[i]!.seq}`, msgs[i]!);
    }
    // Provenance: stamp the similarity on the HITS (after the neighbor loop, so a message that is
    // Both a neighbor and a hit keeps its score). Per-call copies (rowToMsg) — nothing is persisted.
    for (const h of hits) picked.set(`${h.tid}:${h.m.seq}`, { ...h.m, score: h.score });
    return [...picked.values()].sort((a, b) => a.ts - b.ts || a.seq - b.seq);
  }
  async getWorkingMemory(scopeId: string): Promise<unknown> {
    const r = this.db.prepare('SELECT data FROM gnl_working_memory WHERE scope_id = ?').get(scopeId) as { data: string } | undefined;
    return r ? deserialize(r.data) : undefined;
  }
  async setWorkingMemory(scopeId: string, data: unknown): Promise<void> {
    this.db.prepare(
      `INSERT INTO gnl_working_memory (scope_id, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(scope_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`,
    ).run(scopeId, serialize(data), Date.now());
  }
  async getObservations(threadId: string): Promise<Observation[]> {
    const r = this.db.prepare('SELECT obs FROM gnl_observations WHERE thread_id = ?').get(threadId) as { obs: string } | undefined;
    return r ? deserialize<Observation[]>(r.obs) : [];
  }
  async putObservations(threadId: string, obs: Observation[]): Promise<void> {
    this.db.prepare(
      `INSERT INTO gnl_observations (thread_id, obs) VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET obs=excluded.obs`,
    ).run(threadId, serialize(obs));
  }
}

// ── VectorStore (scan/brute-force) ──────────────────────────────────────────────
class SqliteVectorStore implements VectorStore {
  constructor(private db: any) {}
  async upsert(items: VectorItem[]): Promise<void> {
    const stmt = this.db.prepare(
      `INSERT INTO gnl_vectors (id, text, embedding, metadata, namespace, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET text=excluded.text, embedding=excluded.embedding, metadata=excluded.metadata, namespace=excluded.namespace`,
    );
    for (const it of items) stmt.run(it.id, it.text, JSON.stringify(it.embedding), it.metadata ? serialize(it.metadata) : null, it.namespace ?? null, Date.now());
  }
  async query(embedding: number[], topK: number, opts?: VectorQueryOptions): Promise<VectorMatch[]> {
    // Filtered in SQL, so the rows that reach the ranking are already the eligible ones. Ranking the
    // whole table and filtering afterwards would make a caller's result count depend on how many other
    // namespaces exist: ask for 4, get however many of the global top 4 were yours. Nothing errors and
    // nothing leaks — recall just degrades as other organizations upload, invisibly.
    //
    // `IS` rather than `=`: SQLite's `=` is never true against NULL, so a query for the un-namespaced
    // partition would silently match nothing at all.
    const rows = (opts?.namespace === undefined
      ? this.db.prepare('SELECT id, text, embedding, metadata, namespace FROM gnl_vectors').all()
      : this.db.prepare('SELECT id, text, embedding, metadata, namespace FROM gnl_vectors WHERE namespace IS ?').all(opts.namespace)) as any[];
    return rows
      .map((r) => ({ id: r.id, text: r.text, metadata: r.metadata ? deserialize<Record<string, unknown>>(r.metadata) : undefined, ...(r.namespace != null ? { namespace: r.namespace as string } : {}), score: cosineSimilarity(embedding, JSON.parse(r.embedding)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}

// ── WorkStore ────────────────────────────────────────────────────────────────
class SqliteWorkStore implements WorkStore {
  constructor(private db: any) {}
  async append(ns: string, payload: unknown, id?: string): Promise<string> {
    const eid = id ?? `${ns}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    this.db.prepare(`INSERT INTO gnl_work_log (ns, id, payload, ts) VALUES (?, ?, ?, ?) ON CONFLICT(ns, id) DO NOTHING`)
      .run(ns, eid, serialize(payload), Date.now());
    return eid;
  }
  async list<T = unknown>(ns: string, q?: ListQuery): Promise<Page<LogRecord<T>>> {
    const { start, limit } = offset(q);
    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM gnl_work_log WHERE ns = ?').get(ns) as { n: number }).n;
    const rows = this.db.prepare('SELECT id, payload, ts FROM gnl_work_log WHERE ns = ? ORDER BY ts, id LIMIT ? OFFSET ?')
      .all(ns, limit, start) as { id: string; payload: string; ts: number }[];
    return pageOf(rows.map((r) => ({ id: r.id, payload: deserialize<T>(r.payload), ts: r.ts })), start, limit, total);
  }
  async get<T = unknown>(key: string): Promise<T | undefined> {
    const r = this.db.prepare('SELECT value FROM gnl_work_kv WHERE key = ?').get(key) as { value: string } | undefined;
    return r ? deserialize<T>(r.value) : undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.db.prepare(`INSERT INTO gnl_work_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
      .run(key, serialize(value));
  }
  async ackOnce(key: string): Promise<boolean> {
    const info = this.db.prepare(`INSERT INTO gnl_work_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING`)
      .run(key, serialize(true));
    return info.changes === 1;
  }
  /**
   * 8.2: SAME pattern as SqliteRunJournal.putIfMatch's `!p` branch (unlike gnl_run_journal's derived
   * Gnl_runs index, gnl_work_kv has NO derived index → no need to wrap with BEGIN IMMEDIATE, a single
   * UPDATE statement is already atomic in SQLite). The STORED FORM is PLAIN serialize() TEXT (no
   * Envelope) → the comparison happens directly in SQL: `WHERE key=? AND value=serialize(expected)`.
   */
  async putIfMatch(key: string, expected: unknown, value: unknown): Promise<boolean> {
    const info = this.db.prepare('UPDATE gnl_work_kv SET value = ? WHERE key = ? AND value = ?')
      .run(serialize(value), key, serialize(expected));
    return Number(info.changes ?? 0) === 1;
  }
}

// ── CacheStore (TTL'li) ─────────────────────────────────────────────────────────
class SqliteCacheStore implements CacheStore {
  constructor(private db: any) {}
  async get<T = unknown>(key: string): Promise<T | undefined> {
    const r = this.db.prepare('SELECT value, expires_at FROM gnl_cache WHERE key = ?').get(key) as { value: string; expires_at: number | null } | undefined;
    if (!r) return undefined;
    if (r.expires_at != null && r.expires_at <= Date.now()) { this.db.prepare('DELETE FROM gnl_cache WHERE key = ?').run(key); return undefined; }
    return deserialize<T>(r.value);
  }
  async set(key: string, value: unknown, opts?: { ttlMs?: number }): Promise<void> {
    const exp = opts?.ttlMs != null ? Date.now() + opts.ttlMs : null;
    this.db.prepare(`INSERT INTO gnl_cache (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at`)
      .run(key, serialize(value), exp);
  }
  async delete(key: string): Promise<void> { this.db.prepare('DELETE FROM gnl_cache WHERE key = ?').run(key); }
}

class SqliteMetaStore implements MetaStore {
  constructor(private db: any) {}
  async get(key: string): Promise<string | undefined> {
    const r = this.db.prepare('SELECT v FROM gnl_meta WHERE k = ?').get(key) as { v: string } | undefined;
    return r?.v;
  }
  async set(key: string, value: string): Promise<void> {
    this.db.prepare(`INSERT INTO gnl_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).run(key, value);
  }
}
