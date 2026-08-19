// The astral prefix bound, against a REAL Postgres in a REAL collation.
//
// `key < prefix + '￿'` is a prefix range only under BYTE ordering. Managed Postgres is
// `en_US.utf8`, where U+FFFF is a noncharacter that collates as absent — so the bound sorts BELOW keys
// it is supposed to include, and `listKeys` / `deletePrefix` silently match nothing. They return 0 with
// no error, so an org purge, a retention sweep and `deletePrefix('xrun:')` all report success while
// the rows stay.
//
// prefix-astral.test.ts pins this for SQLite, which is the one engine that CANNOT reproduce it: its
// default collation IS byte order. Nothing exercised the Postgres half, and pg-mem cannot stand in —
// it does not implement collation-sensitive comparison, so it would agree with whatever the code did.
//
// This file also covers all THREE tables deletePrefix touches. The SQLite test only looks at the
// journal; `gnl_runs` (the derived run index) and `gnl_counters` (incrBy totals) are swept by separate
// statements with separate range expressions, and a bound that was fixed in one and not the others
// would leave a purge that reports success and leaves a tenant's run list and usage totals behind.
//
// Skipped unless GNL_PG_URL is set, like integration-real.test.ts. CI runs it in both collations.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgresStorage } from '../src/postgres-storage.js';
import { listRunsArray } from '../src/journal.js';

const URL = process.env.GNL_PG_URL;
const d = URL ? describe : describe.skip;

/** A key whose org segment ends in an ASTRAL character — a surrogate pair in UTF-16, four bytes in UTF-8. */
const ASTRAL = 'org:acme\u{1F600}:run-1:model:0';

d('prefix ranges on a real Postgres', () => {
  let storage: PostgresStorage;
  let collation: string;

  beforeAll(async () => {
    storage = new PostgresStorage({ connectionString: URL! });
    // The container may still be starting; init is idempotent (same pattern as integration-real).
    for (let i = 0; ; i++) {
      try { await storage.init(); break; } catch (e) { if (i > 30) throw e; await new Promise((r) => setTimeout(r, 500)); }
    }
    const r = await storage.pool.query("SELECT datcollate FROM pg_database WHERE datname = current_database()");
    collation = (r.rows[0] as { datcollate?: string })?.datcollate ?? '(unknown)';
  });

  // Every key this file writes carries a unique `org:<something><timestamp>` prefix, so runs do not
  // collide with each other or with anything else already in the database.
  afterAll(async () => { await storage?.close(); });

  it('runs against the collation the environment claims', () => {
    // The whole point is the collation, so a leg that silently ran under the wrong one would prove
    // nothing while looking green. CI sets GNL_PG_EXPECT_COLLATION per matrix leg.
    const expected = process.env.GNL_PG_EXPECT_COLLATION;
    if (expected) expect(collation, 'POSTGRES_INITDB_ARGS did not take effect').toContain(expected);
    else expect(collation.length).toBeGreaterThan(0);
  });

  it('listKeys returns a key whose prefix segment ends in an astral character', async () => {
    const j = storage.runs;
    await j.put('org:acme:plain:model:0', { a: 1 });
    await j.put(ASTRAL, { a: 2 });

    const keys = await j.listKeys('org:acme');
    expect(keys, 'the astral key sorted outside its own prefix range').toContain(ASTRAL);
  });

  it('deletePrefix removes it, and the count it reports is the truth', async () => {
    const j = storage.runs;
    const pre = `org:del${Date.now().toString(36)}`;
    await j.put(`${pre}:plain:model:0`, { a: 1 });
    await j.put(`${pre}\u{1F600}:run-1:model:0`, { a: 2 });

    const n = await j.deletePrefix(pre);
    expect(n, 'the count a GDPR caller is handed').toBe(2);
    expect(await j.get(`${pre}\u{1F600}:run-1:model:0`), 'an erasure reported success and left this row').toBeUndefined();
  });

  it('stops at the prefix boundary — a neighbour is not swept', async () => {
    // The failure an over-wide bound produces while fixing the under-wide one.
    const j = storage.runs;
    const pre = `org:b${Date.now().toString(36)}`;
    await j.put(`${pre}:mine:model:0`, { a: 1 });
    await j.put(`${pre}X:theirs:model:0`, { a: 2 });

    await j.deletePrefix(`${pre}:`);
    expect(await j.get(`${pre}X:theirs:model:0`), 'a neighbouring org was swept').toBeDefined();
  });

  it('sweeps gnl_runs too, not only the journal', async () => {
    // deletePrefix touches three tables with three separate range expressions. A bound fixed in one
    // and not the others leaves a purge that reports success and leaves the tenant's run list behind.
    const j = storage.runs;
    const pre = `org:r${Date.now().toString(36)}`;
    const runId = `${pre}\u{1F600}:run-1`;
    await j.put(`${runId}:input`, { prompt: 'x' });
    await j.put(`${runId}:model:0`, { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
    const before = await listRunsArray(j as never);
    expect(before.some((r) => r.runId === runId), 'the run was never indexed').toBe(true);

    await j.deletePrefix(pre);
    const after = await listRunsArray(j as never);
    expect(after.some((r) => r.runId === runId), 'the run index kept a purged tenant\'s run').toBe(false);
  });

  it('sweeps gnl_counters too', async () => {
    const j = storage.runs;
    const pre = `org:c${Date.now().toString(36)}`;
    const key = `${pre}\u{1F600}:__usage__`;
    await j.incrBy!(key, { runs: 1, tokens: 100, costUsd: 0.5 });
    expect(await j.getCounters!(key), 'the counter was never written').toBeTruthy();

    await j.deletePrefix(pre);
    const remaining = await j.getCounters!(key);
    expect(remaining == null || Object.keys(remaining).length === 0, 'usage totals survived the purge').toBe(true);
  });
});
