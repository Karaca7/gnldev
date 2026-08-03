// The lease — exactly one process does the unattended work.
//
// The failure it prevents is dull and expensive: a nightly job that costs real model calls runs on
// every instance that has it enabled. Two instances, two bills, and two sets of results that
// disagree about which was "the" nightly run.
//
// Everything here is about the moment the lease turns over, because that is the only moment two
// processes can both believe they hold it:
//
//   · a live lease is not stealable, however much somebody wants it
//   · an EXPIRED one is taken over by exactly one of two contenders — not both
//   · the holder can renew, so long work does not lose its own lease mid-flight
//   · releasing somebody else's is refused; that is how two processes end up running
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { acquireLease, releaseLease, readLease } from '../src/lease.js';

afterEach(() => vi.restoreAllMocks());

const KEY = '__drift_lease__';
const T = 1_000_000;

describe('acquiring', () => {
  it('gives it to the first asker and refuses the second', async () => {
    const j = new InMemoryJournal();
    expect(await acquireLease(j, KEY, 'A', 60_000, T)).toBe(true);
    expect(await acquireLease(j, KEY, 'B', 60_000, T + 1)).toBe(false);
  });

  it('lets the holder renew, so long work does not lose its own lease', async () => {
    // A job that takes longer than one TTL must be able to keep going. Losing your own lease
    // mid-run hands the work to a second process — the exact thing being prevented.
    const j = new InMemoryJournal();
    await acquireLease(j, KEY, 'A', 60_000, T);
    expect(await acquireLease(j, KEY, 'A', 60_000, T + 30_000)).toBe(true);
    expect((await readLease(j, KEY, T + 30_000))!.expiresAt).toBe(T + 90_000);
  });

  it('refuses to hand a live lease to somebody else even at the last millisecond', async () => {
    const j = new InMemoryJournal();
    await acquireLease(j, KEY, 'A', 60_000, T);
    expect(await acquireLease(j, KEY, 'B', 60_000, T + 59_999)).toBe(false);
  });
});

describe('the turnover', () => {
  it('hands an expired lease to exactly ONE of two contenders', async () => {
    // The only moment that matters. Both see the same stale value; only the compare-and-set that
    // lands wins, which is why this is CAS and not "read, decide, write".
    const j = new InMemoryJournal();
    await acquireLease(j, KEY, 'dead', 60_000, T);

    const after = T + 60_001;
    const results = await Promise.all([
      acquireLease(j, KEY, 'B', 60_000, after),
      acquireLease(j, KEY, 'C', 60_000, after),
    ]);

    expect(results.filter(Boolean).length).toBe(1);
    const winner = results[0] ? 'B' : 'C';
    expect((await readLease(j, KEY, after))!.owner).toBe(winner);
  });

  it('does not leave the work parked for ever when the holder dies', async () => {
    // The TTL is the whole reason a crashed leader is survivable. Without it the nightly check
    // simply stops, and the screen goes on showing the last good result.
    const j = new InMemoryJournal();
    await acquireLease(j, KEY, 'crashed', 60_000, T);
    expect(await acquireLease(j, KEY, 'B', 60_000, T + 30_000)).toBe(false);
    expect(await acquireLease(j, KEY, 'B', 60_000, T + 60_001)).toBe(true);
  });
});

describe('releasing', () => {
  it('frees it immediately, so a clean shutdown does not park the work until the TTL', async () => {
    const j = new InMemoryJournal();
    await acquireLease(j, KEY, 'A', 60_000, T);
    await releaseLease(j, KEY, 'A');

    expect(await readLease(j, KEY, T + 1)).toBeUndefined();
    expect(await acquireLease(j, KEY, 'B', 60_000, T + 1)).toBe(true);
  });

  it('refuses to release a lease it does not hold', async () => {
    // Releasing a lease you do not hold is a way to make two processes run at once, dressed up as
    // tidying up.
    const j = new InMemoryJournal();
    await acquireLease(j, KEY, 'A', 60_000, T);
    await releaseLease(j, KEY, 'B');

    expect((await readLease(j, KEY, T + 1))!.owner).toBe('A');
  });
});

describe('an adapter without compare-and-set', () => {
  it('says so once, loudly, instead of pretending to elect a leader', async () => {
    // The honest failure: it still works single-process, and with several instances two of them can
    // believe they hold the same lease at the moment one expires. That has to be said out loud —
    // a silent degradation here is a doubled bill nobody attributes to anything.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const j = new InMemoryJournal();
    (j as any).putIfMatch = undefined;

    await acquireLease(j, KEY, 'A', 60_000, T);
    await acquireLease(j, KEY, 'A', 60_000, T + 10);           // renewal → the fallback path
    await acquireLease(j, KEY, 'A', 60_000, T + 20);           // and it does not repeat itself

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/putIfMatch/);
    expect(String(warn.mock.calls[0][0])).toMatch(/runs twice/);
  });
});

describe('reading it', () => {
  it('reports an expired lease as nobody holding it', async () => {
    const j = new InMemoryJournal();
    await acquireLease(j, KEY, 'A', 60_000, T);
    expect(await readLease(j, KEY, T + 1)).toMatchObject({ owner: 'A' });
    expect(await readLease(j, KEY, T + 60_001)).toBeUndefined();
  });

  it('survives a value that is not a lease at all', async () => {
    // Whatever else is in the journal under a colliding key, this must not throw and take the
    // schedule down with it.
    const j = new InMemoryJournal();
    await j.put(KEY, { something: 'else' });
    expect(await readLease(j, KEY, T)).toBeUndefined();
    expect(await acquireLease(j, KEY, 'A', 60_000, T)).toBe(false);
  });
});
