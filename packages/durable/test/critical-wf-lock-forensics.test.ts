// The lock record a critical workflow run leaves behind — read the way an operator reads it in
// Postgres, after the fact.
//
// This file exists because of a live finding that looked, from the outside, like a leaked lock:
// A scheduled trigger burned all five of its attempts with RunBusyError ("already running — locked by
// another process"), not one step ran, and the record left in the table afterwards said
// `{"owner":"sched-…","expires":0}` — released. A released lock and five "somebody else is running it"
// refusals do not fit together, so the first instinct was that the lock had leaked on a throw path and
// only later been let go.
//
// It had not. The three tests below are the forensics that separate the innocent explanations from
// the guilty one, and the guilty one is not in this package: it is that the critical workflow's run
// lock and the caller's own lock are THE SAME KEY (`<runId>:lock`), so a caller holding a lock on the
// runId it is about to run locks the run out of its own execution. The owner field is what tells the
// two apart — a `critical-wf-*` owner means the run got in, a foreign owner means it never did.
import { describe, it, expect } from 'vitest';
import { newDb } from 'pg-mem';
import { InMemoryJournal } from '../src/journal.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { createGnl } from '../src/registry.js';
import { acquireRunLock } from '../src/run-lock.js';
import { RunBusyError } from '../src/errors.js';

interface LockRecord { owner: string; expires: number; token: string }
const lockOf = (j: InMemoryJournal, runId: string) => j.get<LockRecord>(`${runId}:lock`);

const wfOf = (run: (input: unknown) => Promise<unknown>) => ({ run, build: () => [] });

describe('critical workflow run-lock — what the record says afterwards', () => {
  it('a step that THROWS still frees the lock, and the owner it leaves behind is the run itself', async () => {
    const journal = new InMemoryJournal();
    const gnl = createGnl({
      journal,
      preset: 'critical',
      workflows: { w: wfOf(async () => { throw new Error('gerçek hata'); }) as any },
    });

    await expect(gnl.runWorkflow('w', { a: 1 }, { runId: 'thr1' })).rejects.toThrow('gerçek hata');

    // registry.ts's finally releases the lock even on the throw path (release = expires pushed into
    // the past, the journal has no delete). Both halves matter to the live finding: `expires: 0` is
    // what a released lock LOOKS like, and `critical-wf-*` is the proof that this run actually got in.
    const rec = await lockOf(journal, 'thr1');
    expect(rec?.expires).toBe(0);
    expect(rec?.owner).toMatch(/^critical-wf-/);
    // And the freed lock is genuinely reusable — a retry of the same runId is not blocked by it.
    await expect(gnl.runWorkflow('w', { a: 1 }, { runId: 'thr1' })).rejects.toThrow('gerçek hata');
  });

  it('SELF-COLLISION: a caller already holding `<runId>:lock` locks the run out of its own execution', async () => {
    const journal = new InMemoryJournal();
    let bodyRuns = 0;
    const gnl = createGnl({
      journal,
      preset: 'critical',
      workflows: { w: wfOf(async () => { bodyRuns++; return 1; }) as any },
    });

    // Exactly what @gnldev/scheduler's pollScheduler did: take a lock on the runId it is about to
    // pass to runWorkflow. A perfectly reasonable thing to do — until the callee locks the same key.
    const outer = await acquireRunLock(journal, 'sched:saglik-5dk:0', 'sched-lui6tf', 60_000);
    expect(outer).not.toBeNull();

    const err = await gnl.runWorkflow('w', {}, { runId: 'sched:saglik-5dk:0' }).catch((e) => e);
    expect(err).toBeInstanceOf(RunBusyError);
    expect((err as { atLockAcquisition?: boolean }).atLockAcquisition).toBe(true);
    expect(bodyRuns).toBe(0); // not one step ran — the live symptom, exactly

    // THE FINGERPRINT. The lock the run refused on is the caller's own, and after the caller releases
    // it the record reads `{owner: 'sched-…', expires: 0}` — released, foreign owner. That pairing is
    // the whole diagnosis: had the workflow ever acquired, the last writer would be `critical-wf-*`.
    await outer!.release();
    const rec = await lockOf(journal, 'sched:saglik-5dk:0');
    expect(rec).toEqual({ owner: 'sched-lui6tf', expires: 0, token: expect.any(String) });
    expect(rec?.owner).not.toMatch(/^critical-wf-/);

    // Nothing is wrong with the lock itself: once the caller is out of the way the run goes through.
    await expect(gnl.runWorkflow('w', {}, { runId: 'sched:saglik-5dk:0' })).resolves.toBeTruthy();
    expect(bodyRuns).toBe(1);
  });

  it('a released (expires: 0) record is taken over — in memory AND over real SQL', async () => {
    // The rival explanation for the live finding: the takeover CAS silently losing, so a released
    // lock keeps refusing. `putIfMatch` on Postgres compares the SERIALISED bytes of a TEXT column
    // (`WHERE value = $4`), which is exactly the kind of comparison that can go wrong on a get →
    // re-serialise round trip. Measured on both adapters rather than argued.
    const mem = new InMemoryJournal();
    const first = await acquireRunLock(mem, 'r1', 'a', 60_000);
    await first!.release();
    expect((await lockOf(mem, 'r1'))?.expires).toBe(0);
    const second = await acquireRunLock(mem, 'r1', 'b', 60_000);
    expect(second?.owner).toBe('b');
    // The superseded handle can no longer touch the new owner's lock (fencing).
    await first!.release();
    expect((await lockOf(mem, 'r1'))?.owner).toBe('b');
    expect((await lockOf(mem, 'r1'))?.expires).toBeGreaterThan(0);

    // SQLite rather than pg-mem, and the reason is worth writing down because the obvious choice is
    // wrong: pg-mem does NOT implement `ON CONFLICT DO NOTHING` faithfully — it reports rowCount 1 and
    // even returns a RETURNING row for a conflicting insert (measured below). `putIfAbsent` therefore
    // always answers "I claimed it" there, so `acquireRunLock` never reaches its takeover branch at all
    // and a takeover test on pg-mem passes without testing anything. SQLite's ON CONFLICT is faithful
    // and its journal stores the same PLAIN serialize() TEXT as Postgres, so the byte-exact
    // `WHERE value = ?` comparison this test is really about is the identical one.
    const storage = new SqliteStorage(':memory:');
    try {
      const sql = storage.runs;
      expect(typeof sql.putIfMatch).toBe('function'); // otherwise this test proves nothing
      const p1 = await acquireRunLock(sql, 'r1', 'a', 60_000);
      await p1!.release();
      expect((await sql.get<LockRecord>('r1:lock'))?.expires).toBe(0);
      const p2 = await acquireRunLock(sql, 'r1', 'b', 60_000);
      expect(p2?.owner).toBe('b'); // the CAS takeover really lands over SQL
      const after = await sql.get<LockRecord>('r1:lock');
      expect(after?.owner).toBe('b');
      expect(after?.expires).toBeGreaterThan(0);
    } finally {
      await storage.close?.();
    }
  });

  it('pg-mem cannot answer the takeover question — its ON CONFLICT DO NOTHING claims a row it did not write', async () => {
    // Pinned so the previous test's substrate choice does not get "simplified" back to pg-mem later.
    // This is a limitation of the FAKE, not of the adapter: on a real Postgres the conflicting insert
    // reports 0 and `putIfAbsent` correctly answers false.
    const { Pool } = newDb().adapters.createPg();
    const pool = new Pool();
    await pool.query('CREATE TABLE t (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const first = await pool.query('INSERT INTO t (key, value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING RETURNING key', ['k', 'v1']);
    const clash = await pool.query('INSERT INTO t (key, value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING RETURNING key', ['k', 'v2']);
    expect(first.rowCount).toBe(1);
    expect(clash.rowCount).toBe(1); // ← the lie; a real Postgres says 0
    expect((await pool.query('SELECT value FROM t')).rows).toEqual([{ value: 'v1' }]); // nothing was written
  });
});
