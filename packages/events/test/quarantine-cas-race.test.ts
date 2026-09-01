// The quarantine CAS, pinned by a REAL interleaving rather than a forced return value.
//
// WHY THIS FILE EXISTS: `head-of-line.test.ts` pins the CAS by mocking `putIfMatch` to return false.
// That proves the HANDLING (a lost CAS does not clobber) but not the DETECTION (a real concurrent
// release actually makes the CAS lose) — and detection is the half the fix is for. Disabling the CAS
// alone left that suite green, which is exactly the gap.
//
// The window is one `await` wide: `fresh = await work.get(deadKey)` → build record → conditional
// write. Nothing in the public API lets a caller land inside it. So the timing is instrumented, NOT
// the logic: `WorkStore` is an interface (packages/durable/src/storage.ts:346), and this wrapper
// forwards every method untouched except that it runs a callback right after one specific `get`
// resolves. The consumer, the release and the store are all the real thing; only the moment the
// release happens is chosen. That is the difference between mocking a collaborator and scheduling
// one.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import type { WorkStore } from '@gnldev/durable';
import { emit, createConsumer, listDeadEvents, retryDeadEvent } from '../src/index.js';

const TOPIC = 'casrace';
const CONSUMER = 'A';
const POISON = 'p1';

/**
 * Forwards to `inner`, but after the Nth `get` of a key matching `keyPrefix` resolves, awaits
 * `onNth()` before handing the value back. `armed` gates it so the setup phase runs untouched, and
 * `busy` stops the callback's own reads from re-entering the hook.
 */
function scheduling(inner: WorkStore, keyPrefix: string, nth: number, onNth: () => Promise<void>) {
  let hits = 0;
  let busy = false;
  const w = {
    armed: false,
    calls: 0,
    append: (ns: string, payload: unknown, id?: string) => inner.append(ns, payload, id),
    list: (ns: string, q?: any) => inner.list(ns, q),
    put: (key: string, value: unknown) => inner.put(key, value),
    ackOnce: (key: string) => inner.ackOnce(key),
    putIfMatch: inner.putIfMatch
      ? (key: string, expected: unknown, value: unknown) => {
          w.calls++;
          return inner.putIfMatch!(key, expected, value);
        }
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

describe('@gnldev/events — quarantine write vs. a concurrent release', () => {
  it('a release landing AFTER the fresh read still survives: the CAS loses and nothing is clobbered', async () => {
    const inner = new InMemoryStorage().work;
    const deadK = `evtdead:${TOPIC}:${CONSUMER}:`;

    // The injected release: it runs against the SAME store, through the real public function, at the
    // one moment the fix cannot see it coming — after `fresh` has already been read.
    let injected = 0;
    const work: any = scheduling(inner, deadK, 2, async () => {
      injected++;
      await retryDeadEvent(work, TOPIC, CONSUMER, POISON);
    });

    const seen: string[] = [];
    let broken = true;
    const c = createConsumer(
      work,
      TOPIC,
      async (_p, meta) => {
        if (broken && meta.id === POISON) throw new Error('poison');
        seen.push(meta.id);
      },
      // One event in the topic → exactly two `evtdead:` reads per failing pass: the pre-handler
      // check and the fresh read. The hook wants the second one.
      { name: CONSUMER, maxAttempts: 1, retryDelayMs: 0 },
    );

    await emit(work, TOPIC, { n: 1 }, { id: POISON });

    // Pass 1 — first failure quarantines. No prior record, so this write is a plain put.
    await c.poll();
    expect((await listDeadEvents(work, TOPIC, CONSUMER))[0]!.status).toBe('quarantined');

    // Operator releases it. releases: 1.
    expect(await retryDeadEvent(work, TOPIC, CONSUMER, POISON)).toBe(true);
    expect((await listDeadEvents(work, TOPIC, CONSUMER))[0]!.releases).toBe(1);

    // Pass 2 — the event comes back via the rescan flag, fails again, and tries to re-quarantine.
    // Mid-write, a SECOND release lands (releases: 2). The record the write is holding is stale.
    work.armed = true;
    await c.poll();
    work.armed = false;

    expect(injected).toBe(1); // the interleaving really happened

    // Deliberately NO assertion that `putIfMatch` was called. That is the mechanism, and asserting it
    // would fire FIRST when the CAS is removed — the test would go red for "the method wasn't called"
    // instead of for the outcome, which is the same mechanism-over-effect trap this file exists to
    // avoid. What follows must fail on its own.
    const rec = (await listDeadEvents(work, TOPIC, CONSUMER))[0]!;
    expect(rec.status).toBe('released'); // the concurrent release stands
    expect(rec.releases).toBe(2); // ...and was not rolled back to the stale value

    // The release was real, not just bookkeeping: the event is still live and delivers once fixed.
    broken = false;
    await c.poll();
    expect(seen).toContain(POISON);
  });
});

// The OTHER side of the same window. Above, a release races poll()'s quarantine write and the CAS
// there protects it. `retryDeadEvent`'s own write had no such protection — it was a plain
// read → modify → put, so two releases landing together (an operator double-clicking, two panels,
// a retry script and a human) both read the same record and both wrote `releases: n + 1` from it.
//
// MEASURED: two concurrent releases → `both returned true? true true`, dead record
// `{..., "releasedAt": ..., "releases": 1}` — two releases, counter at 1. `releases` is an
// operator-facing number whose JSDoc promises "how many times it has been released"; a counter that
// answers a question wrongly is worse than no counter. It is also the ABA input `gen` exists to
// separate: same `releases`, and in the same millisecond the same `releasedAt`, is the same
// `releaseStamp` — the one thing a value CAS cannot see through.
describe('@gnldev/events — retryDeadEvent vs. a concurrent retryDeadEvent', () => {
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { error = vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { error.mockRestore(); });

  it('two releases landing together are both counted — `releases` does not lose one', async () => {
    const inner = new InMemoryStorage().work;
    const deadK = `evtdead:${TOPIC}:${CONSUMER}:`;

    // The injected release runs through the real public function, at the one moment the outer
    // release cannot see it coming: after its own read of the dead record has already resolved.
    let injected = 0;
    const work: any = scheduling(inner, deadK, 1, async () => {
      injected++;
      await retryDeadEvent(work, TOPIC, CONSUMER, POISON);
    });

    let broken = true;
    const seen: string[] = [];
    const c = createConsumer(work, TOPIC, (_p, meta) => {
      if (broken && meta.id === POISON) throw new Error('poison');
      seen.push(meta.id);
    }, { name: CONSUMER, maxAttempts: 1, retryDelayMs: 0 });
    await emit(work, TOPIC, { n: 1 }, { id: POISON });

    await c.poll(); // first failure → quarantined
    expect((await listDeadEvents(work, TOPIC, CONSUMER))[0]!.status).toBe('quarantined');

    work.armed = true;
    const outer = await retryDeadEvent(work, TOPIC, CONSUMER, POISON);
    work.armed = false;
    expect(injected).toBe(1); // the interleaving really happened

    // Both operators were told their release took effect, so both must be in the count.
    expect(outer).toBe(true);
    expect((await listDeadEvents(work, TOPIC, CONSUMER))[0]!.releases).toBe(2); // 1 = one was lost

    // And the release is still a release: the event comes back and delivers.
    broken = false;
    expect(await c.poll()).toBe(1);
    expect(seen).toContain(POISON);
    const after = (await listDeadEvents(work, TOPIC, CONSUMER))[0]!;
    expect(after.status).toBe('delivered');
    expect(after.releases).toBe(2); // the count survives delivery — it is audit history
  });

  it('`releases` is monotonic across a re-quarantine + release cycle', async () => {
    const work = new InMemoryStorage().work;
    let broken = true;
    const c = createConsumer(work, 'monotonic', (_p, meta) => { if (broken && meta.id === POISON) throw new Error('poison'); },
      { name: CONSUMER, maxAttempts: 1, retryDelayMs: 0 });
    await emit(work, 'monotonic', { n: 1 }, { id: POISON });

    await c.poll();
    for (let expected = 1; expected <= 3; expected++) {
      expect(await retryDeadEvent(work, 'monotonic', CONSUMER, POISON)).toBe(true);
      expect((await listDeadEvents(work, 'monotonic', CONSUMER))[0]!.releases).toBe(expected);
      await c.poll(); // fails again → re-quarantined, carrying the count forward
    }
    expect((await listDeadEvents(work, 'monotonic', CONSUMER))[0]!.status).toBe('quarantined');

    broken = false;
    expect(await retryDeadEvent(work, 'monotonic', CONSUMER, POISON)).toBe(true);
    expect(await c.poll()).toBe(1);
    expect((await listDeadEvents(work, 'monotonic', CONSUMER))[0]!.releases).toBe(4);
  });
});
