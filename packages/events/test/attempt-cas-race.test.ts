// The ATTEMPT counter (`evtatt:*`) under concurrency, plus the two ways the caller's own
// `retryDelayMs` can take the poll loop down with it.
//
// WHY THIS FILE EXISTS: `quarantine-cas-race.test.ts` pinned the CAS on the DEAD record. The write
// right before it — the attempt counter — was still a bare get→put, and its window is WIDER: the
// value it overwrites was read BEFORE the handler ran, so a `retryDeadEvent` landing anywhere in the
// handler's lifetime is silently undone. The dead record survived that race; the budget and the
// backoff the release handed out did not.
//
// Same instrumentation discipline as quarantine-cas-race.test.ts: `WorkStore` is an interface, the
// wrapper forwards every method untouched and only chooses the MOMENT a real `retryDeadEvent` runs.
// The consumer, the release and the store are the real thing. Nothing here mocks the logic under
// test, and nothing here asserts "was method X called" — a removed CAS has to fail on the outcome.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import type { WorkStore } from '@gnldev/durable';
import { emit, createConsumer, listDeadEvents, retryDeadEvent } from '../src/index.js';

/** Copy of quarantine-cas-race.test.ts's wrapper (test files share no helper module). */
function scheduling(inner: WorkStore, keyPrefix: string, nth: number, onNth: () => Promise<void>) {
  let hits = 0;
  let busy = false;
  const w = {
    armed: false,
    append: (ns: string, payload: unknown, id?: string) => inner.append(ns, payload, id),
    list: (ns: string, q?: any) => inner.list(ns, q),
    put: (key: string, value: unknown) => inner.put(key, value),
    ackOnce: (key: string) => inner.ackOnce(key),
    putIfMatch: inner.putIfMatch
      ? (key: string, expected: unknown, value: unknown) => inner.putIfMatch!(key, expected, value)
      : undefined,
    async get<T>(key: string): Promise<T | undefined> {
      const value = await inner.get<T>(key);
      if (w.armed && !busy && key.startsWith(keyPrefix) && ++hits === nth) {
        busy = true;
        try {
          await onNth();
        } finally {
          busy = false;
        }
      }
      return value;
    },
  };
  return w;
}

describe('@gnldev/events — the attempt counter vs. a concurrent release', () => {
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

  it('a release landing during the failed attempt still buys a FULL budget, not one attempt', async () => {
    const TOPIC = 'attbudget';
    const CONSUMER = 'A';
    const POISON = 'p1';
    const inner = new InMemoryStorage().work;

    // The injected release runs through the real public function, at the one moment the attempt
    // write cannot see it coming: after the fresh dead-record read has already resolved.
    let injected = 0;
    const work: any = scheduling(inner, `evtdead:${TOPIC}:${CONSUMER}:`, 2, async () => {
      injected++;
      await retryDeadEvent(work, TOPIC, CONSUMER, POISON);
    });

    let calls = 0;
    const c = createConsumer(work, TOPIC, () => { calls++; throw new Error('poison'); },
      { name: CONSUMER, maxAttempts: 3, retryDelayMs: 0 });
    await emit(work, TOPIC, { n: 1 }, { id: POISON });

    await c.poll(); await c.poll(); await c.poll(); // budget of 3 burned → quarantined
    expect((await listDeadEvents(work, TOPIC, CONSUMER))[0]!.status).toBe('quarantined');

    expect(await retryDeadEvent(work, TOPIC, CONSUMER, POISON)).toBe(true); // release #1
    await c.poll(); await c.poll(); // 2 of the new budget's 3 attempts used

    // The third failure. Mid-write, an operator releases it AGAIN (release #2) — a fresh budget of 3.
    work.armed = true;
    await c.poll();
    work.armed = false;
    expect(injected).toBe(1); // the interleaving really happened

    // How many attempts did the operator's release ACTUALLY buy? Count them.
    calls = 0;
    for (let i = 0; i < 10; i++) {
      if ((await listDeadEvents(work, TOPIC, CONSUMER))[0]!.status === 'quarantined') break;
      await c.poll();
    }
    expect((await listDeadEvents(work, TOPIC, CONSUMER))[0]!.status).toBe('quarantined');
    expect(calls).toBe(3); // 1 = the release was silently downgraded to a single retry
  });

  it('a release landing during the failed attempt means NOW, not one hour later', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const TOPIC = 'attdelay';
      const CONSUMER = 'A';
      const POISON = 'p1';
      const inner = new InMemoryStorage().work;

      let injected = 0;
      const work: any = scheduling(inner, `evtdead:${TOPIC}:${CONSUMER}:`, 2, async () => {
        injected++;
        await retryDeadEvent(work, TOPIC, CONSUMER, POISON);
      });

      let broken = true;
      const c = createConsumer(work, TOPIC, () => { if (broken) throw new Error('poison'); },
        { name: CONSUMER, maxAttempts: 2, retryDelayMs: 3_600_000 });
      await emit(work, TOPIC, { n: 1 }, { id: POISON });

      await c.poll(); // attempt 1
      vi.setSystemTime(3_600_000);
      await c.poll(); // attempt 2 → quarantined
      expect((await listDeadEvents(work, TOPIC, CONSUMER))[0]!.status).toBe('quarantined');

      expect(await retryDeadEvent(work, TOPIC, CONSUMER, POISON)).toBe(true); // release #1 → due now

      // It fails once more; mid-write, release #2 lands. A release clears the backoff — that is the
      // whole point of retry-delay.test.ts's "a release clears the delay too". It has to hold when
      // the release is concurrent with the attempt, or it only holds when nothing else is happening.
      work.armed = true;
      await c.poll();
      work.armed = false;
      expect(injected).toBe(1);

      // No clock movement at all: the operator said "now".
      broken = false;
      expect(await c.poll()).toBe(1); // 0 = the release was pushed an hour into the future
      expect((await listDeadEvents(work, TOPIC, CONSUMER))[0]!.status).toBe('delivered');
    } finally {
      vi.useRealTimers();
    }
  });

  // Mutation-driven (X2): deleting `frozen = true` from the LOST-CAS branch left all 42 tests
  // green. The branch is reached when another writer moved the attempt counter under us, and the
  // whole point of that discard is that the event is still LIVE — so the bookmark may not move past
  // it. Without the flag the pass finishes a page, sees no failure it is willing to admit to, and
  // persists a cursor beyond a never-delivered, never-quarantined event: the silent loss this
  // package refuses, entering through the one branch nothing was watching.
  //
  // No mock: two consumer instances under the SAME name is the supported way to scale a consumer
  // (src/index.ts, the "already DELIVERED by another process" branch), and the second one really
  // does win the CAS while the first one's handler is still in flight. The event has to be on page 1
  // of several, because the cursor is only persisted BETWEEN pages.
  it('an attempt whose CAS was lost still freezes the bookmark — the event is not scanned past', async () => {
    const work = new InMemoryStorage().work;
    const N = 120; // page size 50 → 3 pages
    const POISON = 'e3'; // page 1, so a cursor advance would strand it
    let broken = true;
    let armed = false;
    let raced = false;

    const fail = (id: string) => { if (id === POISON && broken) throw new Error('poison'); };
    const seen: string[] = [];
    // P2 exists only to win the attempt CAS. It shares P1's consumer name, hence P1's counter.
    const p2 = createConsumer(work, 'attfrozen', (_p, meta) => fail(meta.id),
      { name: 'A', maxAttempts: 5, retryDelayMs: 0 });
    const p1 = createConsumer(work, 'attfrozen', async (_p, meta) => {
      if (meta.id === POISON && armed && !raced) {
        raced = true;
        await p2.poll(); // P2 fails the same event and writes the counter P1 is holding
      }
      fail(meta.id);
      seen.push(meta.id);
    }, { name: 'A', maxAttempts: 5, retryDelayMs: 0 });
    for (let i = 0; i < N; i++) await emit(work, 'attfrozen', { id: `e${i}` }, { id: `e${i}` });

    // Pass 1: no race yet. The counter goes from absent to {n:1} — an absent key is a plain put, so
    // the CAS branch is not even reachable until a record exists.
    expect(await p1.poll()).toBe(N - 1);
    expect(await work.get('evtatt:attfrozen:A:e3')).toMatchObject({ n: 1 });

    // Pass 2: P1 reads {n:1}, P2 moves it to {n:2} mid-handler, P1's CAS therefore loses.
    armed = true;
    expect(await p1.poll()).toBe(0);
    expect(raced).toBe(true);
    expect(await work.get('evtatt:attfrozen:A:e3')).toMatchObject({ n: 2 }); // P2's write stands, not P1's

    // The event was neither delivered nor given up on, so it must still be reachable.
    broken = false;
    expect(await p1.poll()).toBe(1); // 0 = the bookmark moved past a live event
    expect(seen).toContain(POISON);
    // ...and nothing recorded that it had been skipped, which is what makes the loss silent.
    expect(await listDeadEvents(work, 'attfrozen', 'A')).toEqual([]);
  });

  it('a retryDelayMs that throws does not kill the pass — the default schedule takes over', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const work = new InMemoryStorage().work;
      const seen: string[] = [];
      const c = createConsumer(work, 'delaythrow',
        (_p, meta) => { if (meta.id === 'e1') throw new Error('poison'); seen.push(meta.id); },
        { name: 'A', retryDelayMs: () => { throw new Error('user delay fn exploded'); } });
      for (let i = 0; i < 10; i++) await emit(work, 'delaythrow', { i }, { id: `e${i}` });

      // Caller code throwing inside the catch block used to escape poll() entirely: 1 event
      // delivered out of 10, no attempt counter written, and every later poll died in the same
      // place — the head-of-line blocking this package exists to remove, through another door.
      expect(await c.poll()).toBe(9);
      expect(seen).toEqual(['e0', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8', 'e9']);
      // The counter must NOT be skipped, or the event retries forever with no budget burn.
      expect(await work.get('evtatt:delaythrow:A:e1')).toMatchObject({ n: 1, nextAt: 60_000 });

      vi.setSystemTime(60_000);
      expect(await c.poll()).toBe(0); // still broken, but the pass runs
      expect(await work.get('evtatt:delaythrow:A:e1')).toMatchObject({ n: 2, nextAt: 180_000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a non-finite retryDelayMs is rejected — the same behavior on every adapter', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      // Infinity/NaN do not survive the JSON round-trip a SQLite/Postgres WorkStore does
      // (Infinity → null → 0 = due IMMEDIATELY), while InMemory keeps it and the event becomes
      // undue FOREVER. Same code, same options, opposite behavior per store. Reject it instead.
      for (const [topic, retryDelayMs] of [
        ['inf-fn', () => Infinity],
        ['inf-num', Infinity],
        ['nan-fn', () => NaN],
      ] as const) {
        const work = new InMemoryStorage().work;
        let calls = 0;
        const c = createConsumer(work, topic, () => { calls++; throw new Error('boom'); },
          { name: 'A', maxAttempts: 3, retryDelayMs: retryDelayMs as any });
        await emit(work, topic, { id: 'p' }, { id: 'p' });

        await c.poll();
        expect(calls).toBe(1);
        const att: any = await work.get(`evtatt:${topic}:A:p`);
        expect(Number.isFinite(att.nextAt)).toBe(true); // Infinity/NaN never reaches the store
        expect(att.nextAt).toBe(60_000); // fell back to the default schedule

        vi.setSystemTime(60_000);
        await c.poll();
        expect(calls).toBe(2); // 1 = the event is undue forever on this adapter and due at once on the next
        vi.setSystemTime(0);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('an event another process already delivered is not quarantined behind its back', async () => {
    const work = new InMemoryStorage().work;
    // Two processes, ONE consumer name (the supported way to scale a consumer horizontally).
    // P2 delivers and acks while P1's attempt is still in flight; P1's failure then arrives late.
    const p2 = createConsumer(work, 'dup', () => {}, { name: 'A', maxAttempts: 1, retryDelayMs: 0 });
    let raced = false;
    const p1 = createConsumer(work, 'dup', async () => {
      if (!raced) { raced = true; expect(await p2.poll()).toBe(1); }
      throw new Error('p1 lost the race');
    }, { name: 'A', maxAttempts: 1, retryDelayMs: 0 });
    await emit(work, 'dup', { id: 'p' }, { id: 'p' });

    expect(await p1.poll()).toBe(0); // P2 already marked it; P1 counts nothing
    expect(await work.get('evtack:dup:A:p')).toBeDefined(); // the event WAS delivered
    // ...so there is nothing to give up on. A dead-letter record here is a page at 3am for an
    // event that succeeded, and permanent audit history for a failure that never happened.
    expect(await listDeadEvents(work, 'dup', 'A')).toEqual([]);
    expect(error).not.toHaveBeenCalled();
  });

  it('a WorkStore without putIfMatch still counts, quarantines and releases (documented fallback)', async () => {
    // The `!work.putIfMatch` fallback branch had NO coverage: every test ran on a store that has
    // the CAS, so a fix that assumed it (`work.putIfMatch!(...)`) would have gone in green and
    // thrown TypeError on the first old/custom store. The fallback is a documented quality drop,
    // not a crash — pin exactly that much.
    const inner = new InMemoryStorage().work;
    const work: any = {
      append: (ns: string, p: unknown, id?: string) => inner.append(ns, p, id),
      list: (ns: string, q?: any) => inner.list(ns, q),
      get: (key: string) => inner.get(key),
      put: (key: string, v: unknown) => inner.put(key, v),
      ackOnce: (key: string) => inner.ackOnce(key),
      // no putIfMatch — an older/custom WorkStore implementation
    };
    let broken = true;
    let calls = 0;
    const c = createConsumer(work, 'nocas', () => { calls++; if (broken) throw new Error('boom'); },
      { name: 'A', maxAttempts: 2, retryDelayMs: 0 });
    await emit(work, 'nocas', { id: 'p' }, { id: 'p' });

    await c.poll();
    expect(await work.get('evtatt:nocas:A:p')).toMatchObject({ n: 1 }); // the counter still advances
    await c.poll();
    const dead = await listDeadEvents(work, 'nocas', 'A');
    expect(dead).toHaveLength(1);
    expect(dead[0]!.status).toBe('quarantined'); // ...and the quarantine still happens
    expect(dead[0]!.attempts).toBe(2);

    broken = false;
    expect(await retryDeadEvent(work, 'nocas', 'A', 'p')).toBe(true);
    expect(await c.poll()).toBe(1); // and the release still gets it delivered
    expect(calls).toBe(3);
  });
});
