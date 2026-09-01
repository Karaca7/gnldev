// Head-of-line blocking + dead-letter quarantine.
//
// MEASURED BUG (real SQLite, 120 events, the 4th one's handler always throwing):
//   poll1 = 49   poll2 = 0   poll3 = 0   cursor = undefined
// Events 50..119 were never delivered — not lost (they were still in the log, and fixing the handler
// released all 120), but held indefinitely behind one poison event. `if (pageHasFailure) return
// delivered` conflated two separate things: "don't move the bookmark past an unacked event"
// (correct — moving it is silent loss) and "stop the pass" (wrong). This file pins both halves of
// the fix: the pass no longer stops, and a permanently-failing event becomes visible and finite
// instead of blocking forever.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { emit, createConsumer, listDeadEvents, retryDeadEvent } from '../src/index.js';

const N = 120;
const POISON = 'e3'; // the 4th event — on page 1 (default page size 50), so it gates pages 2 and 3

describe('@gnldev/events — poison event does not block the topic', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
  });

  /**
   * 120 events; `broken` decides whether POISON still throws. Returns the store + consumer + log.
   *
   * `retryDelayMs: 0` + an explicit `maxAttempts` keep these tests about HEAD-OF-LINE BLOCKING: the
   * defaults now space attempts out exponentially (60s → 1h, 8 attempts — see retry-delay.test.ts),
   * which is a property of the retry SCHEDULE, not of the cursor/quarantine machinery pinned here.
   * Asserting it here too would only mean every one of these tests had to drive a virtual clock.
   */
  function setup(work: any, broken: { value: boolean }, topic = 'poison') {
    const seen: string[] = [];
    const c = createConsumer(work, topic, (p: any) => {
      if (p.id === POISON && broken.value) throw new Error('poison handler');
      seen.push(p.id);
    }, { name: 'A', maxAttempts: 5, retryDelayMs: 0 });
    return { c, seen };
  }

  async function fill(work: any, topic = 'poison') {
    for (let i = 0; i < N; i++) await emit(work, topic, { id: `e${i}` }, { id: `e${i}` });
  }

  it('first poll delivers the other 119 — the pass is not stopped by the failing event', async () => {
    const work = new InMemoryStorage().work;
    const broken = { value: true };
    const { c, seen } = setup(work, broken);
    await fill(work);

    // Pre-fix this returned 49 (page 1 only, minus the poison). The remaining 70 events sat behind it.
    expect(await c.poll()).toBe(N - 1);
    expect(seen).toHaveLength(N - 1);
    expect(seen).not.toContain(POISON);
    expect(seen).toContain('e119'); // page 3 — the page the old code never reached

    // The BOOKMARK is still correctly frozen: the poison event is unacked and still retryable, so
    // advancing past it would be loss. Not stopping the pass and not moving the bookmark are
    // independent; the bug was treating them as one.
    expect(await work.get('evtcursor:poison:A')).toBeUndefined();
    expect(await work.get('evtack:poison:A:e3')).toBeUndefined(); // failed → never ack-marked
  });

  it('after maxAttempts the event is quarantined, visible, and NOT counted as delivered', async () => {
    const work = new InMemoryStorage().work;
    const broken = { value: true };
    const { c } = setup(work, broken);
    await fill(work);

    expect(await c.poll()).toBe(N - 1); // attempt 1
    for (let i = 2; i <= 5; i++) expect(await c.poll()).toBe(0); // attempts 2..5 → quarantine on the 5th

    const dead = await listDeadEvents(work, 'poison', 'A');
    expect(dead).toHaveLength(1);
    expect(dead[0]!.id).toBe(POISON);
    expect(dead[0]!.status).toBe('quarantined');
    expect(dead[0]!.attempts).toBe(5); // the maxAttempts setup() asks for (the DEFAULT is 8 — see retry-delay.test.ts)
    expect(dead[0]!.error).toMatch(/poison handler/);
    expect(dead[0]!.payload).toEqual({ id: POISON }); // the payload is recoverable, not just the id

    // Quarantine is NOT an ack: the consumer never saw this event, so nothing may claim it did.
    expect(await work.get('evtack:poison:A:e3')).toBeUndefined();
    // It was loud when it happened — a skipped event that only shows up if you go looking is the
    // silent-loss failure mode wearing a different hat.
    expect(error).toHaveBeenCalled();
    expect(String(error.mock.calls.at(-1)![0])).toMatch(/QUARANTINED/);

    // Quarantine is terminal → the bookmark is no longer frozen → the O(n) rescan cost stops too.
    expect(await work.get('evtcursor:poison:A')).toBeDefined();
    expect(await c.poll()).toBe(0); // and it is not redelivered
  });

  it('a fixed handler + retryDeadEvent recovers the quarantined event → 120/120', async () => {
    const work = new InMemoryStorage().work;
    const broken = { value: true };
    const { c, seen } = setup(work, broken);
    await fill(work);

    let total = await c.poll();
    for (let i = 2; i <= 5; i++) total += await c.poll();
    expect(total).toBe(N - 1);
    expect((await listDeadEvents(work, 'poison', 'A'))[0]!.status).toBe('quarantined');

    // Nothing is redelivered while it stays quarantined, even once the handler is healthy — a
    // dead-letter that self-heals is not a dead-letter.
    broken.value = false;
    expect(await c.poll()).toBe(0);

    expect(await retryDeadEvent(work, 'poison', 'A', POISON)).toBe(true);
    expect(await c.poll()).toBe(1); // the release rewound this consumer's scan, and only this one
    total += 1;
    expect(total).toBe(N);
    expect(seen).toHaveLength(N);
    expect(seen).toContain(POISON);

    const after = await listDeadEvents(work, 'poison', 'A');
    expect(after[0]!.status).toBe('delivered'); // history kept, as queue keeps qfail records
    expect(after[0]!.releases).toBe(1);

    expect(await c.poll()).toBe(0); // recovery does not leave the rescan flag looping
    expect(await retryDeadEvent(work, 'poison', 'A', POISON)).toBe(false); // already delivered → no-op
  });

  // Mutation-driven: nothing failed when retryDeadEvent stopped resetting the attempt counter, so a
  // release into a STILL-broken handler was untested — and it turned out to be broken twice over
  // (no fresh attempt budget, and the cursor stayed parked past the released event, which left it
  // permanently 'released' and unreachable). A release is a fresh chance, not a single extra shot.
  it('releasing into a still-broken handler gets a full attempt budget, then re-quarantines', async () => {
    const work = new InMemoryStorage().work;
    const broken = { value: true };
    let attempts = 0;
    const c = createConsumer(work, 'requar', (p: any) => {
      if (p.id === POISON && broken.value) { attempts++; throw new Error('poison handler'); }
    }, { name: 'A', maxAttempts: 5, retryDelayMs: 0 }); // see setup()'s note: schedule is pinned elsewhere
    await fill(work, 'requar');

    for (let i = 1; i <= 5; i++) await c.poll();
    expect(attempts).toBe(5);
    expect(await retryDeadEvent(work, 'requar', 'A', POISON)).toBe(true);

    // The released event must actually be REACHED again — quarantine had moved the cursor past it.
    await c.poll();
    expect(attempts).toBe(6);
    expect((await listDeadEvents(work, 'requar', 'A'))[0]!.status).toBe('released');

    // ...and it gets the whole budget again rather than dying on the first stumble.
    for (let i = 0; i < 3; i++) await c.poll();
    expect(attempts).toBe(9);
    expect((await listDeadEvents(work, 'requar', 'A'))[0]!.status).toBe('released');

    await c.poll(); // 5th post-release failure
    expect(attempts).toBe(10);
    const dead = (await listDeadEvents(work, 'requar', 'A'))[0]!;
    expect(dead.status).toBe('quarantined');
    expect(dead.attempts).toBe(5); // counted from the release, not 10 cumulative
    expect(dead.releases).toBe(1); // release history survives the re-quarantine

    await c.poll();
    expect(attempts).toBe(10); // parked again — no infinite retry loop

    // A second release still works, and this time the handler is fixed.
    broken.value = false;
    expect(await retryDeadEvent(work, 'requar', 'A', POISON)).toBe(true);
    expect(await c.poll()).toBe(1);
    expect((await listDeadEvents(work, 'requar', 'A'))[0]!.releases).toBe(2);
  });

  it('retryDeadEvent is a no-op for events that never reached quarantine', async () => {
    const work = new InMemoryStorage().work;
    const broken = { value: true };
    const { c } = setup(work, broken);
    await fill(work);
    await c.poll(); // POISON has 1 failed attempt — still retrying on its own, not dead-lettered

    expect(await retryDeadEvent(work, 'poison', 'A', POISON)).toBe(false);
    expect(await retryDeadEvent(work, 'poison', 'A', 'e0')).toBe(false); // delivered fine
    expect(await retryDeadEvent(work, 'poison', 'A', 'nope')).toBe(false); // doesn't exist
    expect(await listDeadEvents(work, 'poison', 'A')).toEqual([]);
  });

  it('quarantine is per-consumer: B is untouched by A giving up', async () => {
    const work = new InMemoryStorage().work;
    const broken = { value: true };
    const { c } = setup(work, broken);
    await fill(work);
    for (let i = 1; i <= 5; i++) await c.poll();
    expect(await listDeadEvents(work, 'poison', 'A')).toHaveLength(1);

    const b: string[] = [];
    const cb = createConsumer(work, 'poison', (p: any) => void b.push(p.id), { name: 'B' });
    expect(await cb.poll()).toBe(N); // B's handler is healthy → all 120, poison included
    expect(await listDeadEvents(work, 'poison', 'B')).toEqual([]);
  });

  // Mutation-driven: deleting the "quarantined → skip" check in poll() left every test above green,
  // because a poison event on page 1 stops being SCANNED once quarantine unfreezes the cursor past
  // it. The check only earns its keep on the LAST, partial page — the one the cursor never advances
  // past, so it is re-listed on every poll forever. Without the check that event would be handed to
  // the handler on every single poll, which is the opposite of dead-lettering it.
  it('a quarantined event on the tail page stops reaching the handler', async () => {
    const work = new InMemoryStorage().work;
    const tail = 'e119'; // pages are 0..49 / 50..99 / 100..119 → tail page, never cursor-advanced past
    let attempts = 0;
    const c = createConsumer(work, 'tail', (p: any) => {
      if (p.id === tail) { attempts++; throw new Error('poison handler'); }
      // retryDelayMs: 0 matters here: with a delay, "the handler stopped being called" would be true
      // for the wrong reason (not due yet) and the quarantine check could be deleted unnoticed again.
    }, { name: 'A', maxAttempts: 5, retryDelayMs: 0 });
    await fill(work, 'tail');

    for (let i = 1; i <= 5; i++) await c.poll();
    expect(attempts).toBe(5);
    expect((await listDeadEvents(work, 'tail', 'A'))[0]!.status).toBe('quarantined');

    for (let i = 0; i < 4; i++) expect(await c.poll()).toBe(0);
    expect(attempts).toBe(5); // quarantine held — no further calls despite being re-listed each poll
    expect((await listDeadEvents(work, 'tail', 'A'))[0]!.attempts).toBe(5);
  });

  // K1 (audit): retryDeadEvent's own docstring documents the non-atomic window — "the cost is that
  // the release needs calling again" — and then the guard `if (rec.releasedAt) return false` refused
  // exactly that second call. An in-flight poll clearing the rescan flag therefore parked the event
  // in `released` forever: never scanned → never failed → never re-quarantined → never releasable.
  // Unrecoverable through the package's own API, which is the one thing a dead-letter must never be.
  it('a release whose rescan flag was lost to an in-flight poll can be released again (idempotent)', async () => {
    const work = new InMemoryStorage().work;
    const broken = { value: true };
    const { c, seen } = setup(work, broken, 'lostflag');
    await fill(work, 'lostflag');
    for (let i = 1; i <= 5; i++) await c.poll();
    expect((await listDeadEvents(work, 'lostflag', 'A'))[0]!.status).toBe('quarantined');

    expect(await retryDeadEvent(work, 'lostflag', 'A', POISON)).toBe(true);
    // A poll that STARTED before the release finishes its own pass and clears the flag (src :236) —
    // the documented race, reproduced here directly rather than through a timing window.
    await work.put('evtrescan:lostflag:A', false);

    broken.value = false;
    for (let i = 0; i < 3; i++) expect(await c.poll()).toBe(0); // out of view: cursor is past it, flag gone
    expect(seen).not.toContain(POISON);

    // The remedy the docstring promises must actually be available.
    expect(await retryDeadEvent(work, 'lostflag', 'A', POISON)).toBe(true);
    expect(await c.poll()).toBe(1);
    expect(seen).toContain(POISON);
    expect((await listDeadEvents(work, 'lostflag', 'A'))[0]!.status).toBe('delivered');
    expect(await retryDeadEvent(work, 'lostflag', 'A', POISON)).toBe(false); // delivered → nothing to release
  });

  // K2 (audit): poll() read the dead record BEFORE the handler and wrote the quarantine record from
  // that stale read afterwards. A release landing while the handler ran was therefore silently
  // undone — `releasedAt` dropped (status back to `quarantined`), the `releases` counter rewound —
  // even though retryDeadEvent had already returned `true` to the operator.
  it('a release landing while the handler runs is not overwritten by the quarantine write', async () => {
    const work = new InMemoryStorage().work;
    let failing = true;
    let releasedMidHandler = false;
    const c = createConsumer(work, 'racerelease', async (_p: any, meta: any) => {
      if (meta.id !== POISON) return;
      if (!failing) return;
      if (!releasedMidHandler && (await listDeadEvents(work, 'racerelease', 'A')).length > 0) {
        // The operator releases the event WHILE this (already doomed) attempt is in flight.
        releasedMidHandler = await retryDeadEvent(work, 'racerelease', 'A', POISON);
      }
      throw new Error('poison handler');
    }, { name: 'A', maxAttempts: 1, retryDelayMs: 0 });
    await fill(work, 'racerelease');

    await c.poll(); // attempt 1 → quarantined immediately (maxAttempts 1)
    expect((await listDeadEvents(work, 'racerelease', 'A'))[0]!.status).toBe('quarantined');
    expect(await retryDeadEvent(work, 'racerelease', 'A', POISON)).toBe(true);

    await c.poll(); // redelivery; the handler releases it again mid-flight, then throws
    expect(releasedMidHandler).toBe(true);
    const mid = (await listDeadEvents(work, 'racerelease', 'A'))[0]!;
    expect(mid.status).toBe('released'); // the stale quarantine write must not have landed on top
    expect(mid.releases).toBe(2); // ...nor rewound the counter to 1

    failing = false;
    expect(await c.poll()).toBe(1); // the release the operator was told succeeded actually delivers
    const after = (await listDeadEvents(work, 'racerelease', 'A'))[0]!;
    expect(after.status).toBe('delivered');
    expect(after.releases).toBe(2);
  });

  // Mutation-driven: with the fresh re-read in place, disabling the CAS as well left every test
  // green — the remaining window (fresh read → write, a single await) can't be hit deterministically
  // through the public API. So the CAS is pinned by forcing it to lose: whatever the other writer
  // put there stands, and the event stays live rather than being silently re-quarantined.
  it('the quarantine write is conditional — a dead record that changed under us is not clobbered', async () => {
    const work = new InMemoryStorage().work;
    const broken = { value: true };
    const { c, seen } = setup(work, broken, 'caswrite');
    await fill(work, 'caswrite');
    for (let i = 1; i <= 5; i++) await c.poll();
    expect((await listDeadEvents(work, 'caswrite', 'A'))[0]!.status).toBe('quarantined');
    expect(await retryDeadEvent(work, 'caswrite', 'A', POISON)).toBe(true);

    // The record EXISTS now, so the re-quarantine write must be conditional on it being unchanged.
    const real = (work as any).putIfMatch.bind(work);
    const spy = vi.spyOn(work as any, 'putIfMatch').mockImplementation(async (...a: any[]) => {
      // Scoped to the DEAD-LETTER key on purpose. The attempt counter is written by CAS too now
      // (attempt-cas-race.test.ts), and a blanket `return false` would stop that write instead, so
      // the event would never reach maxAttempts and this test would pass its assertions for the
      // wrong reason — or, as measured, stop reaching the write it exists to pin at all. Every
      // assertion below is unchanged; only the mock's aim is.
      if (!String(a[0]).startsWith('evtdead:')) return real(...a);
      return false; // someone else wrote this key first
    });
    for (let i = 1; i <= 5; i++) await c.poll(); // 5 post-release failures → tries to quarantine
    spy.mockRestore();

    // Deliberately NO `expect(calls).toContain('evtdead:...')` here — it used to be the first
    // assertion after the mock, and it is a MECHANISM claim, so it fired before the outcome ones and
    // masked their reason. Measured: with it removed, two mutations that used to report "the method
    // wasn't called on this key" now report `expected 'quarantined' to be 'released'` — the actual
    // damage. It also pinned nothing the outcome does not: if the mock stopped matching the key, the
    // quarantine would go through and `status` below would read `quarantined`. Same position as
    // quarantine-cas-race.test.ts:106.
    const rec = (await listDeadEvents(work, 'caswrite', 'A'))[0]!;
    expect(rec.status).toBe('released'); // the lost CAS did not overwrite the released record
    expect(rec.releases).toBe(1);

    broken.value = false;
    expect(await c.poll()).toBe(1); // ...and the event was left live, not silently parked
    expect(seen).toContain(POISON);
  });

  it('maxAttempts: Infinity → retries forever, never quarantines (opt-in old semantics)', async () => {
    const work = new InMemoryStorage().work;
    const c = createConsumer(work, 'forever', (p: any) => {
      if (p.id === POISON) throw new Error('poison handler');
    }, { name: 'A', maxAttempts: Infinity, retryDelayMs: 0 }); // delay 0 → the retries here are real, not merely un-due
    await fill(work, 'forever');

    expect(await c.poll()).toBe(N - 1); // delivery is still unblocked — that is the separable half
    for (let i = 0; i < 8; i++) expect(await c.poll()).toBe(0);
    expect(await listDeadEvents(work, 'forever', 'A')).toEqual([]);
    expect(await work.get('evtcursor:forever:A')).toBeUndefined(); // bookmark parked, as documented
  });

  it('healthy path is unchanged: one pass, exactly-once, cursor advances, no quarantine machinery', async () => {
    const work = new InMemoryStorage().work;
    const counts: Record<string, number> = {};
    const c = createConsumer(work, 'clean', (p: any) => { counts[p.id] = (counts[p.id] ?? 0) + 1; }, { name: 'A' });
    await fill(work, 'clean');

    expect(await c.poll()).toBe(N);
    for (let i = 0; i < N; i++) expect(counts[`e${i}`]).toBe(1);
    expect(await work.get('evtcursor:clean:A')).toBeDefined();
    expect(await c.poll()).toBe(0);
    expect(await listDeadEvents(work, 'clean', 'A')).toEqual([]);
    expect(await work.get('evtatt:clean:A:e0')).toBeUndefined(); // attempt counters only on failure
    expect(await work.get('evtrescan:clean:A')).toBeUndefined(); // rescan flag only on release
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();

    await emit(work, 'clean', { id: 'e120' }, { id: 'e120' });
    expect(await c.poll()).toBe(1);
  });

  // The original measurement was taken on real SQLite, not the in-memory store. Re-running it there
  // keeps the fix honest about the adapter it was reported against (offset cursors, JSON round-trip
  // of the dead record) rather than about a Map.
  it('real SQLite: the measured 49/0/0 becomes 119, then quarantine, then 120/120', async () => {
    const st = new SqliteStorage(':memory:');
    const work = st.work!;
    const broken = { value: true };
    const { c, seen } = setup(work, broken, 'sqlite-poison');
    await fill(work, 'sqlite-poison');

    expect(await c.poll()).toBe(N - 1); // was 49
    expect(await c.poll()).toBe(0);
    expect(await c.poll()).toBe(0);
    expect(seen).toHaveLength(N - 1);

    await c.poll();
    await c.poll(); // 5th attempt → quarantine
    const dead = await listDeadEvents(work, 'sqlite-poison', 'A');
    expect(dead).toHaveLength(1);
    expect(dead[0]!.attempts).toBe(5);
    expect(dead[0]!.status).toBe('quarantined');

    broken.value = false;
    expect(await retryDeadEvent(work, 'sqlite-poison', 'A', POISON)).toBe(true);
    expect(await c.poll()).toBe(1);
    expect(seen).toHaveLength(N);
    await st.close?.();
  });
});
