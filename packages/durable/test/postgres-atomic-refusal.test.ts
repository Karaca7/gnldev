// A pool that cannot open a transaction must be refused, not quietly worked around.
//
// `Pool.connect` is optional in the type this adapter accepts, so a `{ query }` object is a legal
// pool — and until this guard existed, `tx` responded to one by running its body as a sequence of
// autocommit statements. Every caller of `tx` documents itself as atomic ("in ONE transaction",
// "closes the crash window"), so all of them were quietly untrue on such a pool.
//
// Measured against a real server before the fix: 23 of 24 concurrent appends rejected, 3 rows of 48
// stored, and a tool call left with no result — the same corruption the per-thread lock exists to
// prevent, while the capability probe reported the server perfectly able to serialise. The probe asks
// what the SERVER can do; `tx` decides whether we are actually IN a transaction. They can disagree.
//
// The split this test pins: single-statement writes still work, because they never needed a
// transaction. Only the multi-statement callers refuse. A guard that refused everything would be
// easier to write and would make the adapter useless for the run-less keys it handles correctly.
import { describe, it, expect } from 'vitest';
import { PostgresStorage } from '../src/postgres-storage.js';
import { newDb } from 'pg-mem';

/** A legal pool that cannot pin a client — no `connect`, exactly as the optional type allows. */
function queryOnlyPool() {
  const { Pool } = newDb().adapters.createPg();
  const real = new Pool();
  return { query: (s: string, p?: unknown[]) => real.query(s, p), options: { max: 10 } } as never;
}

describe('PostgresStorage on a pool that cannot hold a transaction', () => {
  it('withdraws the memory port instead of offering one that loses messages', async () => {
    const st = new PostgresStorage({ pool: queryOnlyPool() });
    // Synchronous check, so it is settled before anyone can call anything.
    expect(st.capabilities.memory).toBe('none');
  });

  it('still serves writes that never needed a transaction', async () => {
    const st = new PostgresStorage({ pool: queryOnlyPool() });
    // A key that belongs to no run is one upsert. Refusing it would break a working path for a
    // guarantee it does not depend on.
    await st.runs.put('not-a-run-key', { a: 1 });
    expect(await st.runs.get('not-a-run-key')).toEqual({ a: 1 });
  });

  it('refuses the journal writes that span more than one statement', async () => {
    const st = new PostgresStorage({ pool: queryOnlyPool() });
    // Each of these reads a previous state and writes derived rows alongside the entry; run
    // bookkeeping and the entry must land together or the run index goes stale.
    await expect(st.runs.put('r1:model:0', { ok: true })).rejects.toThrow(/no connect\(\)/);
    await expect(st.runs.putIfAbsent('r2:tool:x', { status: 'succeeded' })).rejects.toThrow(/no connect\(\)/);
    await expect(st.runs.applyBatch!({ puts: [{ key: 'r3:model:0', value: 1 }] })).rejects.toThrow(/no connect\(\)/);
  });

  it('says the configuration is unusable rather than merely reduced', async () => {
    const st = new PostgresStorage({ pool: queryOnlyPool() });
    const err = await st.runs.put('r1:model:0', { ok: true }).catch((e: Error) => e);
    // The operator needs to know it is not a degraded mode they can accept, and what to pass instead.
    expect(err.message).toMatch(/unusable/);
    expect(err.message).toMatch(/real `pg` Pool/);
  });
});
