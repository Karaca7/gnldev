// M4 — Concurrency / optimistic locking.
// putIfAbsent is atomic (3 storages) · TOCTOU: concurrent same toolCallId → body runs once ·
// failed-retry is protected by the claim path · acquireRunLock acquire/release/takeover.
import { describe, it, expect } from 'vitest';
import { newDb } from 'pg-mem';
import { InMemoryJournal } from '../src/journal.js';
import { InMemoryStorage } from '../src/in-memory-storage.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { durableTool } from '../src/durable-tool.js';
import { acquireRunLock } from '../src/run-lock.js';
import { RunBusyError } from '../src/errors.js';

function pgmemPool() {
  const { Pool } = newDb().adapters.createPg();
  return new Pool();
}

// InMemory (Map.has) and Sqlite (changes===1) faithfully report atomicity via boolean.
const atomicStorages: [string, () => any][] = [
  ['InMemory', () => new InMemoryStorage().runs],
  ['Sqlite', () => new SqliteStorage().runs],
];

describe.each(atomicStorages)('M4 putIfAbsent atomic — %s', (_name, make) => {
  it('insert-only: first is true, subsequent is false; the first written value stays', async () => {
    const j = make();
    expect(await j.putIfAbsent('k', { v: 1 })).toBe(true);
    expect(await j.putIfAbsent('k', { v: 2 })).toBe(false);
    expect(await j.get('k')).toEqual({ v: 1 });
  });
});

// On real PG, Postgres putIfAbsent returns 0 rows via `ON CONFLICT DO NOTHING RETURNING` → returns false.
// pg-mem also returns RETURNING on conflict (a known fidelity limitation), so instead of the boolean
// we verify the DO NOTHING semantics (the first value is preserved = no-op); proven with real SQL via Sqlite.
describe('M4 putIfAbsent — Postgres(pg-mem) DO NOTHING semantics', () => {
  it('the second putIfAbsent is a no-op: the first written value is preserved', async () => {
    const b = new PostgresStorage({ pool: pgmemPool() });
    const j = b.runs;
    expect(await j.putIfAbsent('k', { v: 1 })).toBe(true); // absent → added
    await j.putIfAbsent('k', { v: 2 }); // conflict → DO NOTHING
    expect(await j.get('k')).toEqual({ v: 1 }); // the value was NOT clobbered
    await b.close();
  });
});

describe('M4 durableTool claim', () => {
  it('TOCTOU: concurrent same toolCallId, 2 executes → body runs once', async () => {
    const journal = new InMemoryJournal();
    let body = 0;
    const dt = durableTool(
      { execute: async () => ((body++, await Promise.resolve()), { ok: body }) },
      { journal, runId: 'r' },
      'pay',
    );
    const settled = await Promise.allSettled([
      dt.execute!({ a: 1 }, { toolCallId: 'c' }),
      dt.execute!({ a: 1 }, { toolCallId: 'c' }),
    ]);
    expect(body).toBe(1); // did not run twice (TOCTOU closed)
    // The winner got the real output; the loser got either the output or RunBusyError (never a second execute).
    const ok = settled.some((s) => s.status === 'fulfilled' && (s.value as any)?.ok === 1);
    expect(ok).toBe(true);
    const losers = settled.filter((s) => s.status === 'rejected');
    for (const l of losers) expect((l as PromiseRejectedResult).reason).toBeInstanceOf(RunBusyError);
  });

  it('a failed record is retried via the claim path (body runs twice) — a tool marked idempotent', async () => {
    const journal = new InMemoryJournal();
    let calls = 0;
    const dt = durableTool(
      {
        idempotent: true, // H7: an unmarked tool no longer gets automatic retry
        execute: async () => {
          calls++;
          if (calls === 1) throw new Error('boom');
          return 'ok';
        },
      },
      { journal, runId: 'r' },
      't',
    );
    await expect(dt.execute!({}, { toolCallId: 'x' })).rejects.toThrow('boom');
    expect(await dt.execute!({}, { toolCallId: 'x' })).toBe('ok');
    expect(calls).toBe(2);
  });
});

describe('M4 acquireRunLock', () => {
  it('the second is null; acquired after release; expired one is taken over', async () => {
    const journal = new InMemoryJournal();
    const l1 = await acquireRunLock(journal, 'r', 'A', 1000);
    expect(l1).not.toBeNull();
    expect(await acquireRunLock(journal, 'r', 'B', 1000)).toBeNull(); // the live lock is held by someone else

    await l1!.release();
    const l3 = await acquireRunLock(journal, 'r', 'C', 1000);
    expect(l3).not.toBeNull(); // free after release

    // fast-forward now → l3 is considered expired → gets taken over
    const l4 = await acquireRunLock(journal, 'r', 'D', 1000, Date.now() + 10_000);
    expect(l4).not.toBeNull();
  });
});
