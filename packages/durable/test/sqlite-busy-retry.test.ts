// SQLITE_BUSY retry (sqlite-storage.ts / BusyRetryDatabase): a TRANSIENT lock must be absorbed, a
// PERMANENT one must still THROW, and nothing else may ever be retried.
//
// WHY FAULT INJECTION AND NOT A REAL LOCK: a real second connection holding the write lock cannot
// exercise this code at all — the engine's own `busy_timeout = 5000` would either outlast the lock
// (the statement then simply succeeds, no retry involved) or block the thread for 5s per attempt.
// The retry exists precisely for the cases where the engine hands BACK SQLITE_BUSY, so the only way
// to test it deterministically is to make a statement return exactly that. The injector below fails
// the REAL node:sqlite handle's chosen statement with node:sqlite's own error shape (errcode 5 /
// 'database is locked'); every other statement goes straight to the real engine, so all assertions
// about the resulting DATA are made against real SQLite state, not against a mock.
// The end-to-end proof that this fixes real contention is multi-process-race.test.ts (two OS
// processes, untouched).
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStorage } from '../src/sqlite-storage.js';

const withDb = async (fn: (path: string) => Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), 'gnl-busy-'));
  try {
    await fn(join(dir, 'runs.db'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** node:sqlite's own SQLITE_BUSY shape (verified against a real cross-process failure). */
function busyError(): Error {
  return Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5, errstr: 'database is locked' });
}
/** A NON-transient error, for the "must not be retried" case. */
function constraintError(): Error {
  return Object.assign(new Error('UNIQUE constraint failed: gnl_run_journal.key'), { code: 'ERR_SQLITE_ERROR', errcode: 19, errstr: 'constraint failed' });
}

type Fault = { match: RegExp; times: number; make: () => Error; before?: () => void };

/**
 * Swaps the REAL handle inside BusyRetryDatabase for a pass-through that fails the first `times`
 * executions of the statements matching `match` (`times: Infinity` = permanently). Returns a counter
 * of how many times the matching statement was ATTEMPTED, and a restore function.
 */
function injectFault(storage: SqliteStorage, fault: Fault) {
  const holder = storage as any;
  const real = holder.db.inner;
  const state = { attempts: 0 };
  let remaining = fault.times;
  const gate = (sql: string) => {
    if (!fault.match.test(sql)) return;
    state.attempts++;
    if (remaining <= 0) return;
    remaining--;
    fault.before?.();
    throw fault.make();
  };
  holder.db.inner = {
    exec: (sql: string) => { gate(sql); return real.exec(sql); },
    prepare: (sql: string) => {
      const st = real.prepare(sql);
      return {
        run: (...a: any[]) => { gate(sql); return st.run(...a); },
        get: (...a: any[]) => { gate(sql); return st.get(...a); },
        all: (...a: any[]) => { gate(sql); return st.all(...a); },
      };
    },
    close: () => real.close(),
  };
  return { state, restore: () => { holder.db.inner = real; } };
}

describe('SQLITE_BUSY: bounded retry (transient absorbed, permanent still throws)', () => {
  it('transient BUSY on an autocommit write → the write SUCCEEDS and the data is correct', async () => {
    await withDb(async (path) => {
      const s = new SqliteStorage(path);
      const f = injectFault(s, { match: /INSERT INTO gnl_run_journal/, times: 3, make: busyError });
      const won = await s.runs.putIfAbsent!('busy:k1', { v: 'first' });
      f.restore();
      expect(won).toBe(true);                                    // absorbed, not surfaced
      expect(f.state.attempts).toBe(4);                          // 3 BUSY + the one that landed
      expect(await s.runs.get('busy:k1')).toEqual({ v: 'first' });
      await s.close();
    });
  });

  it('transient BUSY on BEGIN IMMEDIATE → the transaction restarts from scratch, nothing applied twice', async () => {
    await withDb(async (path) => {
      const s = new SqliteStorage(path);
      // A run key → the withTx path. The lock is contended at BEGIN, i.e. BEFORE the first write.
      const f = injectFault(s, { match: /^BEGIN IMMEDIATE$/, times: 4, make: busyError });
      await s.runs.put('busy-run:model:0', { step: 0 });
      f.restore();
      expect(f.state.attempts).toBe(5);
      expect(await s.runs.get('busy-run:model:0')).toEqual({ step: 0 });
      // The derived gnl_runs index is the double-apply detector: 4 restarts must still leave ONE step.
      const runs = await s.runs.listRuns!();
      expect(runs.items.find((r) => r.runId === 'busy-run')).toMatchObject({ modelSteps: 1, toolCalls: 0 });
      await s.close();
    });
  });

  it('transient BUSY on a statement INSIDE the transaction → only that statement re-runs (no double-count)', async () => {
    await withDb(async (path) => {
      const s = new SqliteStorage(path);
      // touchRunDelta's counter upsert is the SECOND statement of the transaction: the journal row is
      // already written when it fails. Retrying the statement alone must not re-apply the first write.
      const f = injectFault(s, { match: /INSERT INTO gnl_runs/, times: 3, make: busyError });
      await s.runs.put('busy-run2:tool:call-1', { status: 'succeeded', output: 1 });
      f.restore();
      expect(f.state.attempts).toBe(4);
      const runs = await s.runs.listRuns!();
      expect(runs.items.find((r) => r.runId === 'busy-run2')).toMatchObject({ modelSteps: 0, toolCalls: 1 });
      expect(await s.runs.readRunStats!('busy-run2')).toMatchObject({ entries: 1 });
      await s.close();
    });
  });

  it('PERMANENT BUSY → still THROWS after a bounded number of attempts (never silently "succeeds")', async () => {
    await withDb(async (path) => {
      const s = new SqliteStorage(path);
      const f = injectFault(s, { match: /INSERT INTO gnl_run_journal/, times: Infinity, make: busyError });
      const t0 = Date.now();
      await expect(s.runs.putIfAbsent!('busy:permanent', { v: 1 })).rejects.toThrow(/database is locked/);
      const elapsed = Date.now() - t0;
      f.restore();
      expect(f.state.attempts).toBeGreaterThan(1);   // it DID retry
      expect(f.state.attempts).toBeLessThanOrEqual(10); // …but a bounded number of times
      expect(elapsed).toBeLessThan(5_000);           // and within the time bound
      expect(await s.runs.get('busy:permanent')).toBeUndefined(); // the failed write left NOTHING behind
      await s.close();
    });
  });

  it('a NON-BUSY error (constraint) is NOT retried — it throws on the first attempt', async () => {
    await withDb(async (path) => {
      const s = new SqliteStorage(path);
      const f = injectFault(s, { match: /INSERT INTO gnl_run_journal/, times: Infinity, make: constraintError });
      await expect(s.runs.put('busy:constraint', { v: 1 })).rejects.toThrow(/UNIQUE constraint failed/);
      f.restore();
      expect(f.state.attempts).toBe(1); // masking real errors behind a retry storm is the thing to avoid
      await s.close();
    });
  });

  it('CAS semantics survive a retry: a competitor that wins during the backoff makes the retrier LOSE', async () => {
    await withDb(async (path) => {
      const a = new SqliteStorage(path);
      const b = new SqliteStorage(path);
      // While A is locked out, B claims the SAME key. (node:sqlite is synchronous and putIfAbsent has
      // no `await` before its statement → the write has really landed by the time this hook returns.)
      let claimed = false;
      const f = injectFault(a, {
        match: /INSERT INTO gnl_run_journal/,
        times: 2,
        make: busyError,
        before: () => { if (!claimed) { claimed = true; void b.runs.putIfAbsent!('busy:cas', { w: 'B' }); } },
      });
      const aWon = await a.runs.putIfAbsent!('busy:cas', { w: 'A' });
      f.restore();
      // The retry must report the TRUTH — A's earlier attempts wrote nothing, so B is the single winner.
      expect(aWon).toBe(false);
      expect(await a.runs.get('busy:cas')).toEqual({ w: 'B' });
      // And a second claim by A (no fault at all) still loses: exactly one winner per key, always.
      expect(await a.runs.putIfAbsent!('busy:cas', { w: 'A' })).toBe(false);
      await a.close();
      await b.close();
    });
  });
});
