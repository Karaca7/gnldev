// A connection lost during schema setup must not be permanent.
//
// `ensureReady` memoises its promise so the DDL runs once per instance. Memoising a REJECTED one
// makes a transient failure final: the instance answers every later call with that same dead error,
// on a database that recovered seconds ago. CI found it for real — a `Postgres C` leg terminated a
// backend mid-DDL (`57P01`) and the instance never came back — but that leg only runs with
// GNL_INTEGRATION=1 and a live server. This test needs neither, so a plain `pnpm test` catches a
// revert too. Its sibling lives in packages/rag/test/postgres-vector-store.test.ts.
import { describe, it, expect } from 'vitest';
import { PostgresStorage } from '../src/postgres-storage.js';

function flakyPool(budget: { fail: number }) {
  const calls: string[] = [];
  return {
    calls,
    on() { /* the error-listener wiring is covered by the real-backend suite */ },
    async end() {},
    async query(sql: string) {
      calls.push(sql);
      if (/CREATE\s+TABLE/i.test(sql) && budget.fail > 0) {
        budget.fail--;
        throw Object.assign(new Error('terminating connection due to administrator command'), {
          code: '57P01', severity: 'FATAL',
        });
      }
      // `byte_ordered` keeps the collation probe on its default path; everything else is DDL.
      if (/byte_ordered/.test(sql)) return { rows: [{ byte_ordered: true }] };
      return { rows: [] };
    },
  };
}

describe('PostgresStorage boot, interrupted', () => {
  it('retries the schema on the next call instead of staying dead', async () => {
    const budget = { fail: 1 };                 // one failure, then the backend is healthy
    const pool = flakyPool(budget);
    const s = new PostgresStorage({ pool: pool as never });

    await expect(s.init()).rejects.toThrow(/terminating connection/);
    expect(budget.fail, 'no CREATE TABLE was ever attempted — the test proved nothing').toBe(0);

    // Same instance. Before the fix this replayed the identical rejection, forever.
    await expect(s.init()).resolves.toBeUndefined();
    expect(pool.calls.filter((q) => /CREATE\s+TABLE/i.test(q)).length,
      'the retry did not re-run the DDL').toBeGreaterThan(1);
  });

  it('a boot that succeeded is still memoised — the DDL does not run twice', async () => {
    const pool = flakyPool({ fail: 0 });
    const s = new PostgresStorage({ pool: pool as never });
    await s.init();
    const after = pool.calls.length;
    await s.init();
    expect(pool.calls.length, 'clearing the memo on success would re-run the DDL on every call')
      .toBe(after);
  });
});
