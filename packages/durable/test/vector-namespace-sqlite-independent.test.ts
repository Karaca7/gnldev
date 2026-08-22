// The namespace column against a REAL sqlite file, and against one written before it existed.
//
// `CREATE TABLE IF NOT EXISTS` does nothing to a table that is already there, so a database created by
// an earlier version keeps its four-column `gnl_vectors`. Without the `ALTER TABLE` migration every
// upsert fails with "no such column: namespace" — the store is bricked, not degraded, and an isolation
// feature takes down the data it was meant to partition. That path is the one nobody exercises,
// because every test starts from an empty database.
//
// The `WHERE namespace IS ?` detail is tested for the same reason: `=` is never true against NULL in
// SQL, so a query for the un-namespaced partition would silently match nothing.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStorage } from '../src/sqlite-storage.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), 'gnl-ns-'));
  dirs.push(d);
  return join(d, 'test.db');
}

/** The raw handle, so the schema can be rewound. `node:sqlite` cannot be imported in a test file —
 *  the root vitest config externalises it — so the driver is reached through the store that owns it. */
type Handle = { exec(sql: string): void; prepare(sql: string): { all(...a: unknown[]): unknown[]; run(...a: unknown[]): unknown } };
const handleOf = (s: SqliteStorage): Handle => (s as unknown as { db: Handle }).db;

/**
 * Rewinds `gnl_vectors` to the schema it had BEFORE the namespace column — four columns plus id — and
 * seeds it. This is what an existing installation's file looks like on the morning of the upgrade.
 */
function legacyDatabase(path: string, rows: Array<{ id: string; text: string; embedding: number[] }>): void {
  const seed = new SqliteStorage(path);
  const db = handleOf(seed);
  db.exec('DROP TABLE IF EXISTS gnl_vectors');
  db.exec('CREATE TABLE gnl_vectors (id TEXT PRIMARY KEY, text TEXT NOT NULL, embedding TEXT NOT NULL, metadata TEXT, created_at INTEGER NOT NULL)');
  const ins = db.prepare('INSERT INTO gnl_vectors (id, text, embedding, metadata, created_at) VALUES (?, ?, ?, ?, ?)');
  for (const r of rows) ins.run(r.id, r.text, JSON.stringify(r.embedding), null, Date.now());
  seed.close?.();
}

const Q = [1, 0, 0];

describe('a database written before the namespace column existed', () => {
  it('is migrated on open rather than bricked', () => {
    const path = tmpDb();
    legacyDatabase(path, [{ id: 'legacy', text: 'PRE-NAMESPACE', embedding: [1, 0, 0] }]);

    const store = new SqliteStorage(path);
    const cols = handleOf(store).prepare('PRAGMA table_info(gnl_vectors)').all() as { name: string }[];

    expect(cols.map((c) => c.name), 'the migration did not run — every upsert will fail with "no such column"')
      .toContain('namespace');
  });

  it('still accepts writes afterwards — the bricking case, stated directly', async () => {
    const path = tmpDb();
    legacyDatabase(path, [{ id: 'legacy', text: 'PRE-NAMESPACE', embedding: [1, 0, 0] }]);
    const store = new SqliteStorage(path);

    await expect(
      store.vectors!.upsert([{ id: 'new', text: 'AFTER', namespace: 'acme', embedding: [1, 0, 0] }]),
      'an existing store cannot be written to after the upgrade',
    ).resolves.toBeUndefined();
  });

  it('keeps its existing rows in the un-namespaced partition, not in someone\'s namespace', async () => {
    const path = tmpDb();
    legacyDatabase(path, [{ id: 'legacy', text: 'PRE-NAMESPACE', embedding: [1, 0, 0] }]);
    const store = new SqliteStorage(path);
    await store.vectors!.upsert([{ id: 'a1', text: 'ACME', namespace: 'acme', embedding: [1, 0, 0] }]);

    const acme = await store.vectors!.query(Q, 10, { namespace: 'acme' });
    expect(acme.map((m) => m.id), 'a pre-existing row was silently adopted into an organization\'s namespace')
      .toEqual(['a1']);
  });

  it('and those rows are still readable — migrated, not lost', async () => {
    const path = tmpDb();
    legacyDatabase(path, [{ id: 'legacy', text: 'PRE-NAMESPACE', embedding: [1, 0, 0] }]);
    const store = new SqliteStorage(path);

    const all = await store.vectors!.query(Q, 10);
    expect(all.map((m) => m.id), 'the migration dropped the data it was migrating').toContain('legacy');
  });

  it('opening the same database twice does not fail on the already-added column', () => {
    const path = tmpDb();
    legacyDatabase(path, []);
    new SqliteStorage(path);

    expect(() => new SqliteStorage(path), 'the migration is not idempotent — a second process opening the store throws')
      .not.toThrow();
  });
});

describe('sqlite namespace matching', () => {
  /**
   * `WHERE namespace IS ?` is CORRECT but currently UNREACHABLE, and that is worth writing down.
   *
   * The `IS` exists so that a query for the un-namespaced partition is not silently empty — `= NULL`
   * is never true in SQL. But the production branch above it routes `opts?.namespace === undefined` to
   * the unrestricted SELECT, and `{ namespace: undefined }` is indistinguishable from `{}` in JS. So no
   * caller can ask for the legacy partition, the parameterised branch only ever receives a non-null
   * string, and `IS` and `=` behave identically there.
   *
   * Measured: mutating `IS` to `=` fails NOTHING across both vector suites. An earlier version of this
   * file asserted the `IS` semantics with raw SQL — that tested SQLite, not gnl, and would have passed
   * whatever the production code did. It is replaced by the assertion below, which pins the reachable
   * consequence: the un-namespaced partition can only be reached by searching everything.
   */
  it('the un-namespaced partition cannot be selected on its own — only searched along with the rest', async () => {
    const path = tmpDb();
    legacyDatabase(path, [{ id: 'legacy', text: 'PRE', embedding: [1, 0, 0] }]);
    const store = new SqliteStorage(path);
    await store.vectors!.upsert([{ id: 'a1', text: 'ACME', namespace: 'acme', embedding: [1, 0, 0] }]);

    // An explicit `undefined` is the same as omitting it: unrestricted, not "the legacy partition".
    const explicit = await store.vectors!.query(Q, 10, { namespace: undefined });
    expect(explicit.map((m) => m.id).sort(),
      '`namespace: undefined` started meaning "the un-namespaced partition" — the asymmetry moved, and '
      + '`WHERE namespace IS ?` is now load-bearing rather than defensive')
      .toEqual(['a1', 'legacy']);
  });

  it('filters before ranking, so the owner still gets the K it asked for', async () => {
    const store = new SqliteStorage(tmpDb());
    // The rival sits strictly closer to the query than every one of the owner's documents.
    await store.vectors!.upsert([
      ...[0.90, 0.80, 0.70, 0.60].map((x, i) => ({ id: `a${i}`, text: `acme-${i}`, namespace: 'acme', embedding: [x, Math.sqrt(1 - x * x), 0] })),
      ...[1, 0.99, 0.98, 0.97].map((x, i) => ({ id: `g${i}`, text: `globex-${i}`, namespace: 'globex', embedding: [x, Math.sqrt(1 - x * x), 0] })),
    ]);

    const mine = await store.vectors!.query(Q, 4, { namespace: 'acme' });
    expect(mine, 'the owner asked for 4 and got fewer — ranking happened before the namespace filter').toHaveLength(4);
    expect(mine.every((m) => m.namespace === 'acme'), 'a rival document answered a namespaced query').toBe(true);
  });

  it('survives a round trip through the file, not just the open handle', async () => {
    const path = tmpDb();
    const first = new SqliteStorage(path);
    await first.vectors!.upsert([{ id: 'a1', text: 'ACME', namespace: 'acme', embedding: [1, 0, 0] }]);
    first.close?.();

    const second = new SqliteStorage(path);
    const hits = await second.vectors!.query(Q, 10, { namespace: 'acme' });
    expect(hits.map((m) => m.namespace), 'the namespace was not persisted').toEqual(['acme']);
    expect(await second.vectors!.query(Q, 10, { namespace: 'globex' }), 'the partition did not survive reopening').toEqual([]);
  });
});
