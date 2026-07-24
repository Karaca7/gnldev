// P2-migrate (AUDIT-R2 §4 storage comparison): exportSchema/checkSchema/migrateSchema on the
// SQL adapters + the runMigrationCheck façade (migrate.ts).
//
// SQLite honesty note: SqliteStorage's constructor is eager (unconditional `db.exec(DDL)` + the H11b
// suspended_count backfill, both untouched here) — opening a "manually crafted old schema" file via
// `new SqliteStorage(path)` would self-heal it BEFORE checkSchema ever ran, so there is no way to observe
// a "never migrated" state through the constructor. Instead these tests construct a normal (fully
// migrated) instance and then simulate DRIFT on the SAME live connection (`(storage as any).db`) —
// dropping a column/table AFTER construction, exactly like an operator manually altering a table in
// production. checkSchema does real, live introspection each call, so it correctly reports that gap.
//
// Postgres is the case that genuinely demonstrates the "disable auto-init, migrate out-of-band"
// production pattern: `ensureReady()` is already lazy (only `this.q`-routed calls trigger it), and
// checkSchema/migrateSchema deliberately bypass `this.q` — so a pg-mem pool that's had ONLY a reduced,
// hand-written DDL run against it (never `storage.init()`) shows the genuine "before" state.
import { describe, it, expect } from 'vitest';
import { newDb } from 'pg-mem';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { InMemoryStorage } from '../src/in-memory-storage.js';
import { runMigrationCheck } from '../src/migrate.js';

function pgmemPool() {
  const { Pool } = newDb().adapters.createPg();
  return new Pool();
}

describe('SqliteStorage schema tooling', () => {
  it('exportSchema: connectionless DDL array, includes the H11b suspended_count ALTER', () => {
    const storage = new SqliteStorage(':memory:');
    const stmts = storage.exportSchema();
    expect(stmts.length).toBeGreaterThan(5);
    expect(stmts.some((s) => /CREATE TABLE IF NOT EXISTS gnl_meta/i.test(s))).toBe(true);
    expect(stmts.some((s) => /CREATE TABLE IF NOT EXISTS gnl_runs/i.test(s))).toBe(true);
    expect(stmts.some((s) => /ALTER TABLE gnl_runs ADD COLUMN suspended_count/i.test(s))).toBe(true);
  });

  it('fresh sqlite → checkSchema ok:true, nothing missing', async () => {
    const storage = new SqliteStorage(':memory:');
    const check = await storage.checkSchema();
    expect(check.ok).toBe(true);
    expect(check.missingTables).toEqual([]);
    expect(check.missingColumns).toEqual([]);
  });

  it('drift (missing column + missing table) → checkSchema reports exactly the gap; dryRun previews without applying; migrateSchema() closes it and the storage actually works after', async () => {
    const storage = new SqliteStorage(':memory:');
    // simulate drift AFTER construction (the constructor already fully migrated this instance —
    // see the file header for why the "old db" has to be crafted post-construction for sqlite).
    const raw = (storage as unknown as { db: any }).db;
    raw.exec('ALTER TABLE gnl_runs DROP COLUMN suspended_count');
    raw.exec('DROP TABLE gnl_counters');

    const before = await storage.checkSchema();
    expect(before.ok).toBe(false);
    expect(before.missingTables).toEqual(['gnl_counters']);
    expect(before.missingColumns).toEqual([{ table: 'gnl_runs', column: 'suspended_count' }]);

    const dry = await storage.migrateSchema({ dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.statements.length).toBeGreaterThan(0);
    expect(dry.statements.some((s) => /CREATE TABLE IF NOT EXISTS gnl_counters/i.test(s))).toBe(true);
    expect(dry.statements.some((s) => /ALTER TABLE gnl_runs ADD COLUMN suspended_count/i.test(s))).toBe(true);
    // dry-run must not have touched the DB
    const stillBefore = await storage.checkSchema();
    expect(stillBefore.ok).toBe(false);
    expect(stillBefore.missingTables).toEqual(['gnl_counters']);

    const applied = await storage.migrateSchema();
    expect(applied.dryRun).toBe(false);
    expect(applied.statements.length).toBe(dry.statements.length);

    const after = await storage.checkSchema();
    expect(after.ok).toBe(true);
    expect(after.missingTables).toEqual([]);
    expect(after.missingColumns).toEqual([]);

    // the storage actually WORKS after migration: a journal write/read + incrBy (gnl_counters, the
    // table that was entirely missing) both round-trip correctly.
    await storage.runs.put('mig-run:model:0', { hello: 'world' });
    expect(await storage.runs.get('mig-run:model:0')).toEqual({ hello: 'world' });
    await storage.runs.incrBy('mig-run:usage', { tokens: 5 });
    expect(await storage.runs.getCounters('mig-run:usage')).toEqual({ tokens: 5 });
    // suspended_count-driven bookkeeping (the exact column that was missing) also works: a suspended
    // tool record increments gnl_runs.suspended_count under the hood (touchRunDelta).
    await storage.runs.put('mig-run:tool:c1', { status: 'suspended' });
    const page = await storage.runs.listRuns({ status: 'suspended' });
    expect(page.items.some((r) => r.runId === 'mig-run')).toBe(true);
  });

  it('migrateSchema is a no-op (empty statements) when the schema is already current', async () => {
    const storage = new SqliteStorage(':memory:');
    const res = await storage.migrateSchema();
    expect(res.statements).toEqual([]);
    expect((await storage.checkSchema()).ok).toBe(true);
  });
});

describe('PostgresStorage schema tooling (pg-mem)', () => {
  it('exportSchema: connectionless, mirrors the adapter DDL (includes the suspended_count ALTER)', () => {
    const storage = new PostgresStorage({ pool: pgmemPool() });
    const stmts = storage.exportSchema();
    expect(stmts.some((s) => /CREATE TABLE IF NOT EXISTS gnl_meta/i.test(s))).toBe(true);
    expect(stmts.some((s) => /ALTER TABLE gnl_runs ADD COLUMN IF NOT EXISTS suspended_count/i.test(s))).toBe(true);
  });

  it('fresh (after init()) → checkSchema ok:true', async () => {
    const storage = new PostgresStorage({ pool: pgmemPool() });
    await storage.init();
    const check = await storage.checkSchema();
    expect(check.ok).toBe(true);
    expect(check.missingTables).toEqual([]);
    expect(check.missingColumns).toEqual([]);
  });

  it('out-of-band: checkSchema on a hand-built reduced schema reports the gap WITHOUT ever calling init() (ensureReady is never triggered)', async () => {
    const pool = pgmemPool();
    // hand-written REDUCED schema — no gnl_counters at all; gnl_runs without suspended_count. This is
    // the "old db, never auto-inited" scenario the P2 out-of-band production pattern targets.
    await pool.query(`CREATE TABLE IF NOT EXISTS gnl_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    await pool.query(
      `CREATE TABLE IF NOT EXISTS gnl_runs (run_id TEXT PRIMARY KEY, model_steps INTEGER NOT NULL DEFAULT 0, tool_calls INTEGER NOT NULL DEFAULT 0, suspended BOOLEAN NOT NULL DEFAULT false, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`,
    );

    const storage = new PostgresStorage({ pool }); // NOTE: .init() deliberately never called
    const before = await storage.checkSchema();
    expect(before.ok).toBe(false);
    expect(before.missingColumns).toEqual([{ table: 'gnl_runs', column: 'suspended_count' }]);
    expect(before.missingTables.sort()).toEqual(
      ['gnl_counters', 'gnl_run_journal', 'gnl_threads', 'gnl_messages', 'gnl_working_memory', 'gnl_observations', 'gnl_vectors', 'gnl_work_log', 'gnl_work_kv', 'gnl_cache'].sort(),
    );

    const dry = await storage.migrateSchema({ dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.statements.some((s) => /CREATE TABLE IF NOT EXISTS gnl_counters/i.test(s))).toBe(true);
    expect(dry.statements.some((s) => /ALTER TABLE gnl_runs ADD COLUMN IF NOT EXISTS suspended_count/i.test(s))).toBe(true);
    const stillBefore = await storage.checkSchema();
    expect(stillBefore.ok).toBe(false); // dry-run applied nothing

    const applied = await storage.migrateSchema();
    expect(applied.dryRun).toBe(false);
    const after = await storage.checkSchema();
    expect(after.ok).toBe(true);

    // pg-mem NOTE (limitation, verified experimentally — not a migrate.ts defect): re-executing the
    // exact `CREATE TABLE IF NOT EXISTS gnl_meta (...)` text against a pool where that table already
    // exists throws pg-mem's "AST parts not read by the query planner" error; real Postgres treats
    // IF NOT EXISTS as a true no-op and has no such issue. `storage.runs.*` is routed through
    // `this.q`/`ensureReady()`, which unconditionally re-runs the FULL DDL array the FIRST time any
    // `this.q`-routed method is called on this instance — and gnl_meta already exists here (created by
    // migrateSchema, since it was one of the missing tables). checkSchema/migrateSchema themselves
    // deliberately bypass `this.q` (see their JSDoc), so they're unaffected — only a subsequent
    // `storage.runs.*` call on the SAME instance would trip this. So functionality is verified via the
    // raw pool against the tables migrateSchema just created (real INSERT/SELECT, same tables, no
    // ensureReady re-entry) — same caps-gating idea as `caps.exactCas` in the conformance suite; the
    // SQLite test above is the load-bearing proof of "the storage genuinely works end-to-end (through
    // its own public API) after migrateSchema".
    await pool.query(
      `INSERT INTO gnl_run_journal (key, run_id, kind, suspended, value, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      ['pg-mig-run:model:0', 'pg-mig-run', 'model', false, 'hello-after-migration', Date.now()],
    );
    const sel = await pool.query(`SELECT value FROM gnl_run_journal WHERE key = $1`, ['pg-mig-run:model:0']);
    expect(sel.rows[0].value).toBe('hello-after-migration');
    // gnl_counters was the entirely-missing table — prove it's genuinely usable, not just present.
    await pool.query(`INSERT INTO gnl_counters (key, field, value) VALUES ($1,$2,$3)`, ['pg-mig-run:usage', 'tokens', 3]);
    const cnt = await pool.query(`SELECT value FROM gnl_counters WHERE key = $1 AND field = $2`, ['pg-mig-run:usage', 'tokens']);
    expect(Number(cnt.rows[0].value)).toBe(3);
  });
});

describe('runMigrationCheck (duck-typed façade)', () => {
  it('SqliteStorage: supported:true, delegates to checkSchema()', async () => {
    const storage = new SqliteStorage(':memory:');
    const res = await runMigrationCheck(storage);
    expect(res.supported).toBe(true);
    if (res.supported) {
      expect(res.storage).toBe('sqlite');
      expect(res.check.ok).toBe(true);
    }
  });

  it('InMemoryStorage: not-supported (schema-free by construction)', async () => {
    const storage = new InMemoryStorage();
    const res = await runMigrationCheck(storage);
    expect(res.supported).toBe(false);
    if (!res.supported) {
      expect(res.storage).toBe('in-memory');
      expect(res.reason).toMatch(/checkSchema/);
    }
  });

  it('duck-typing: any structurally-shaped object works, no concrete-class import needed', async () => {
    const fake = {
      name: 'fake-sql',
      exportSchema: () => ['CREATE TABLE IF NOT EXISTS x (id TEXT)'],
      checkSchema: async () => ({ ok: true, missingTables: [], missingColumns: [] }),
    };
    const res = await runMigrationCheck(fake);
    expect(res.supported).toBe(true);
    if (res.supported) expect(res.storage).toBe('fake-sql');
  });

  it('a plain object missing checkSchema/exportSchema → not-supported, no throw', async () => {
    const res = await runMigrationCheck({ name: 'nothing-here' });
    expect(res.supported).toBe(false);
  });
});
