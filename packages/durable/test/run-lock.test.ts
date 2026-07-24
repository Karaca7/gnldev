// M4 — Run-level lock end-to-end: same runId, two concurrent locked runDurable calls →
// one gets RunBusyError, side-effect (charge) stays exactly-once.
import { describe, it, expect } from 'vitest';
import { stepCountIs } from 'ai';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { acquireRunLock } from '../src/run-lock.js';
import { RunBusyError } from '../src/errors.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

describe('M4 run-lock', () => {
  it('2 concurrent locked runs → one gets RunBusyError, charge is exactly 1', async () => {
    const journal = new InMemoryJournal();
    const counter = { charges: 0 };
    const tools = () => ({
      charge: {
        execute: async () => {
          counter.charges++;
          await new Promise((r) => setTimeout(r, 15)); // stretch the work a bit → keep the lock held
          return { charged: 20 };
        },
      },
    });
    const model = () =>
      createMockModel(async ({ prompt }: any) =>
        countToolResults(prompt) === 0
          ? toolCallResult('charge', 'call-c', { amount: 20 })
          : finalTextResult('done'),
      );
    const opts = () => ({
      runId: 'r',
      journal,
      model: model(),
      tools: tools(),
      stopWhen: stepCountIs(6),
      prompt: 'x',
      lock: { owner: 'w', ttlMs: 5000 },
    });

    const settled = await Promise.allSettled([runDurable(opts() as any), runDurable(opts() as any)]);
    const busy = settled.filter(
      (s) => s.status === 'rejected' && (s as PromiseRejectedResult).reason instanceof RunBusyError,
    );
    expect(busy.length).toBe(1); // one was rejected by the lock
    expect(counter.charges).toBe(1); // exactly-once: only the winner ran

    // After the lock is released, the same runId can run again (resume) → charge is still 1.
    const res = await runDurable(opts() as any);
    expect(counter.charges).toBe(1);
    expect(res.text).toContain('done');
  });
});

describe('B4 lock heartbeat (renew mid-run)', () => {
  it('a run longer than ttlMs keeps the lock held (renewed) → a second acquire mid-run still fails', async () => {
    const journal = new InMemoryJournal();
    const counter = { charges: 0 };
    const ttlMs = 40; // short TTL; the run body outlives it several times over
    const tools = {
      charge: {
        execute: async () => {
          counter.charges++;
          await new Promise((r) => setTimeout(r, 150)); // > 3× ttlMs → without renewal the lock expires mid-run
          return { charged: 20 };
        },
      },
    };
    const model = createMockModel(async ({ prompt }: any) =>
      countToolResults(prompt) === 0
        ? toolCallResult('charge', 'call-c', { amount: 20 })
        : finalTextResult('done'),
    );

    // Start the locked run but do not await yet — it holds the lock while the 150ms tool runs.
    const running = runDurable({
      runId: 'r-hb', journal, model, tools, stopWhen: stepCountIs(6), prompt: 'x',
      lock: { owner: 'w', ttlMs },
    } as any);

    // Wait well past the ORIGINAL ttl (but before the body finishes). With the heartbeat, the lock has
    // been renewed and is still live; a second worker must NOT be able to take it over.
    await new Promise((r) => setTimeout(r, 90));
    const takeover = await acquireRunLock(journal, 'r-hb', 'B', ttlMs);
    expect(takeover).toBeNull(); // renewed → still held (pre-fix: the t=40ms-expired lock would be taken over → non-null)

    const res = await running;
    expect(res.text).toContain('done');
    expect(counter.charges).toBe(1);
  });
});

describe('M4.2 fencing token', () => {
  it('after takeover, the old owner\'s stale release call is a no-op — does not overwrite the new owner\'s record', async () => {
    const journal = new InMemoryJournal();
    const runId = 'r-fence';
    const key = `${runId}:lock`;

    // A acquires the lock with a short TTL.
    const now0 = 1_000;
    const lockA = await acquireRunLock(journal, runId, 'A', 100, now0);
    expect(lockA).not.toBeNull();

    // TTL expired → B (new owner) takes over; a new fencing token is generated.
    const now1 = now0 + 200;
    const lockB = await acquireRunLock(journal, runId, 'B', 5_000, now1);
    expect(lockB).not.toBeNull();
    expect(lockB!.owner).toBe('B');

    const afterTakeover = await journal.get<{ owner: string; expires: number; token: string }>(key);
    expect(afterTakeover?.owner).toBe('B');

    // Old owner (A) is now stale — even if it calls release(), it must NOT OVERWRITE B's record (rejected/no-op).
    await lockA!.release();
    const afterStaleRelease = await journal.get<{ owner: string; expires: number; token: string }>(key);
    expect(afterStaleRelease).toEqual(afterTakeover); // A's release changed nothing

    // B (the new/real owner) can still work: someone else (C) cannot acquire the lock at the same time (B keeps it alive).
    const lockC = await acquireRunLock(journal, runId, 'C', 5_000, now1 + 1);
    expect(lockC).toBeNull();

    // When B releases its own lock it is genuinely freed (its own fencing token is valid → it writes).
    await lockB!.release();
    const afterRealRelease = await journal.get<{ owner: string; expires: number; token: string }>(key);
    expect(afterRealRelease?.expires).toBe(0);

    // The now-free lock can be acquired by someone else (D).
    const lockD = await acquireRunLock(journal, runId, 'D', 5_000, now1 + 2);
    expect(lockD).not.toBeNull();
    expect(lockD!.owner).toBe('D');
  });

  it('happy path: single owner acquire→release behaves the same (no regression vs pre-fencing behavior)', async () => {
    const journal = new InMemoryJournal();
    const runId = 'r-fence-happy';
    const lock = await acquireRunLock(journal, runId, 'solo', 5_000);
    expect(lock).not.toBeNull();
    await lock!.release();
    const rec = await journal.get<{ expires: number }>(`${runId}:lock`);
    expect(rec?.expires).toBe(0);
    // Once free, the same runId can be acquired again.
    const reacquired = await acquireRunLock(journal, runId, 'solo2', 5_000);
    expect(reacquired).not.toBeNull();
  });
});

describe('Y2 renew (heartbeat)', () => {
  it('happy path: renew extends the duration, the fencing token DOES NOT CHANGE, the lock stays with the owner', async () => {
    const journal = new InMemoryJournal();
    const runId = 'r-renew';
    const key = `${runId}:lock`;
    const lock = await acquireRunLock(journal, runId, 'A', 100); // 100ms TTL, real clock
    expect(lock).not.toBeNull();
    const before = await journal.get<{ token: string; expires: number }>(key);

    const ok = await lock!.renew(5_000); // extend the duration a lot
    expect(ok).toBe(true);
    const after = await journal.get<{ token: string; expires: number }>(key);
    expect(after?.token).toBe(before?.token); // same acquisition — token did NOT CHANGE
    expect(after!.expires).toBeGreaterThan(before!.expires); // duration genuinely extended

    // Even though the original 100ms TTL has long since passed (wait 150ms), renew(5000) still keeps it alive → B cannot acquire it.
    await new Promise((r) => setTimeout(r, 150));
    expect(await acquireRunLock(journal, runId, 'B', 5_000)).toBeNull();
  });

  it('on token mismatch (after takeover), renew returns false and does NOT CHANGE the record', async () => {
    const journal = new InMemoryJournal();
    const runId = 'r-renew-stale';
    const key = `${runId}:lock`;
    const t0 = 1_000;
    const lockA = await acquireRunLock(journal, runId, 'A', 100, t0);
    expect(lockA).not.toBeNull();

    // TTL expired → B takes over (new fencing token) — A is now stale.
    const lockB = await acquireRunLock(journal, runId, 'B', 5_000, t0 + 200);
    expect(lockB).not.toBeNull();
    const afterTakeover = await journal.get(key);

    const ok = await lockA!.renew(1_000);
    expect(ok).toBe(false); // a lost lock cannot be renewed
    expect(await journal.get(key)).toEqual(afterTakeover); // B's record remained UNTOUCHED
  });
});
