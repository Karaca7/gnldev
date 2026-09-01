// Retry SPACING (K3). `maxAttempts` counts polls, not time — with a 200ms poll interval the whole
// attempt budget used to burn in about a second, so a one-second downstream blip quarantined every
// in-flight event permanently. An attempt budget is only meaningful if the attempts are spread out.
//
// The schedule mirrors @gnldev/scheduler's `backoff()` (packages/scheduler/src/index.ts:104 —
// `Math.min(base * 2 ** (attempts - 1), cap)`), with an events-sized base/cap: 60s → 1h, 8 attempts,
// ~2h of tolerance for a broken downstream before anything is given up on.
//
// All timing here is VIRTUAL (vi.useFakeTimers + setSystemTime): the code reads Date.now(), so the
// schedule can be asserted exactly instead of slept through.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { emit, createConsumer, listDeadEvents, retryDeadEvent } from '../src/index.js';

describe('@gnldev/events — delay between retry attempts', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    warn.mockRestore();
    error.mockRestore();
  });

  it('a failed event is not re-handed to the handler until its delay elapses — and the bookmark stays frozen meanwhile', async () => {
    const work = new InMemoryStorage().work;
    let calls = 0;
    const c = createConsumer(work, 'freeze', (p: any) => {
      if (p.id === 'e3') { calls++; throw new Error('boom'); }
    }, { name: 'A' });
    for (let i = 0; i < 60; i++) await emit(work, 'freeze', { id: `e${i}` }, { id: `e${i}` }); // 2 pages

    expect(await c.poll()).toBe(59); // e3 fails, the other 59 are delivered (head-of-line fix)
    expect(calls).toBe(1);

    // Polls inside the delay window must NOT call the handler again...
    await c.poll();
    await c.poll();
    expect(calls).toBe(1);
    // ...but the event is still RETRYABLE, so the persisted cursor may not move past it. Waiting is
    // not giving up: if the bookmark advanced here, e3 would never be scanned again = silent loss.
    expect(await work.get('evtcursor:freeze:A')).toBeUndefined();
    expect(await work.get('evtack:freeze:A:e3')).toBeUndefined();

    vi.setSystemTime(59_999); // one millisecond short of the first delay
    await c.poll();
    expect(calls).toBe(1);

    vi.setSystemTime(60_000); // due
    await c.poll();
    expect(calls).toBe(2);
  });

  it('the attempt record carries n/firstAt/nextAt (not a bare count)', async () => {
    const work = new InMemoryStorage().work;
    const c = createConsumer(work, 'shape', () => { throw new Error('boom'); }, { name: 'A' });
    await emit(work, 'shape', { id: 'p' }, { id: 'p' });

    vi.setSystemTime(1_000);
    await c.poll();
    expect(await work.get('evtatt:shape:A:p')).toEqual({ n: 1, firstAt: 1_000, nextAt: 61_000 });

    vi.setSystemTime(61_000);
    await c.poll();
    // firstAt is the start of the failure streak (for "how long has this been broken"), not the last attempt.
    expect(await work.get('evtatt:shape:A:p')).toEqual({ n: 2, firstAt: 1_000, nextAt: 61_000 + 120_000 });
  });

  it('default schedule: 8 attempts, exponential from 60s, capped at 1h → ~2h before quarantine', async () => {
    const work = new InMemoryStorage().work;
    let calls = 0;
    const c = createConsumer(work, 'sched', () => { calls++; throw new Error('boom'); }, { name: 'A' });
    await emit(work, 'sched', { id: 'p' }, { id: 'p' });

    await c.poll();
    expect(calls).toBe(1);

    // 60s, 120s, 240s, 480s, 960s, 1920s, then the 1h CAP (3840s would be next without it).
    const delays = [60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000];
    for (const d of delays) {
      const before = calls;
      vi.setSystemTime(Date.now() + d - 1);
      await c.poll();
      expect(calls).toBe(before); // still one millisecond early
      vi.setSystemTime(Date.now() + 1);
      await c.poll();
      expect(calls).toBe(before + 1);
    }

    expect(calls).toBe(8); // default maxAttempts
    expect(Date.now()).toBe(7_380_000); // sum of the 7 waits
    expect(Date.now()).toBeGreaterThan(2 * 3_600_000); // a downstream outage has ~2 hours, not ~1 second

    const dead = await listDeadEvents(work, 'sched', 'A');
    expect(dead).toHaveLength(1);
    expect(dead[0]!.attempts).toBe(8);
    expect(dead[0]!.status).toBe('quarantined');

    // And it stays quarantined — the delay never expires into a 9th attempt.
    vi.setSystemTime(Date.now() + 24 * 3_600_000);
    await c.poll();
    expect(calls).toBe(8);
  });

  it('retryDelayMs as a number → fixed spacing', async () => {
    const work = new InMemoryStorage().work;
    let calls = 0;
    const c = createConsumer(work, 'fixed', () => { calls++; throw new Error('boom'); }, {
      name: 'A', retryDelayMs: 5_000, maxAttempts: 3,
    });
    await emit(work, 'fixed', { id: 'p' }, { id: 'p' });

    await c.poll();
    vi.setSystemTime(4_999);
    await c.poll();
    expect(calls).toBe(1);
    vi.setSystemTime(5_000);
    await c.poll();
    vi.setSystemTime(9_999);
    await c.poll();
    expect(calls).toBe(2); // fixed 5s, not doubled to 10s
    vi.setSystemTime(10_000);
    await c.poll();
    expect(calls).toBe(3);
    expect((await listDeadEvents(work, 'fixed', 'A'))[0]!.status).toBe('quarantined');
  });

  it('retryDelayMs as a function → the caller owns the schedule (attempt number is passed in)', async () => {
    const work = new InMemoryStorage().work;
    const asked: number[] = [];
    let calls = 0;
    const c = createConsumer(work, 'fn', () => { calls++; throw new Error('boom'); }, {
      name: 'A',
      retryDelayMs: (attempt) => { asked.push(attempt); return attempt * 1_000; },
    });
    await emit(work, 'fn', { id: 'p' }, { id: 'p' });

    await c.poll();
    expect(asked).toEqual([1]); // "1 failure so far" → wait before attempt 2
    vi.setSystemTime(1_000);
    await c.poll();
    expect(calls).toBe(2);
    expect(asked).toEqual([1, 2]);
    vi.setSystemTime(1_999);
    await c.poll();
    expect(calls).toBe(2); // second wait is 2s, not 1s
    vi.setSystemTime(3_000);
    await c.poll();
    expect(calls).toBe(3);
  });

  it('retryDelayMs: 0 → back-to-back retries (the pre-backoff behavior, opt-in)', async () => {
    const work = new InMemoryStorage().work;
    let calls = 0;
    const c = createConsumer(work, 'zero', () => { calls++; throw new Error('boom'); }, {
      name: 'A', retryDelayMs: 0, maxAttempts: 4,
    });
    await emit(work, 'zero', { id: 'p' }, { id: 'p' });

    for (let i = 0; i < 4; i++) await c.poll(); // no clock movement at all
    expect(calls).toBe(4);
    expect((await listDeadEvents(work, 'zero', 'A'))[0]!.attempts).toBe(4);
  });

  it('maxAttempts: Infinity keeps retrying on the delay schedule and never quarantines', async () => {
    const work = new InMemoryStorage().work;
    let calls = 0;
    const c = createConsumer(work, 'inf', () => { calls++; throw new Error('boom'); }, {
      name: 'A', maxAttempts: Infinity, retryDelayMs: 1_000,
    });
    await emit(work, 'inf', { id: 'p' }, { id: 'p' });

    for (let i = 1; i <= 12; i++) {
      await c.poll();
      expect(calls).toBe(i);
      vi.setSystemTime(Date.now() + 1_000);
    }
    expect(await listDeadEvents(work, 'inf', 'A')).toEqual([]);
    expect(error).not.toHaveBeenCalled();
  });

  it('a release clears the delay too — a released event is due immediately, not one hour later', async () => {
    const work = new InMemoryStorage().work;
    let broken = true;
    let calls = 0;
    const c = createConsumer(work, 'rel', (p: any) => {
      calls++;
      if (broken) throw new Error('boom');
    }, { name: 'A', maxAttempts: 2, retryDelayMs: 1_000 });
    await emit(work, 'rel', { id: 'p' }, { id: 'p' });

    await c.poll();
    vi.setSystemTime(1_000);
    await c.poll();
    expect(calls).toBe(2);
    expect((await listDeadEvents(work, 'rel', 'A'))[0]!.status).toBe('quarantined');

    broken = false;
    expect(await retryDeadEvent(work, 'rel', 'A', 'p')).toBe(true);
    expect(await c.poll()).toBe(1); // no clock movement — the release is the operator saying "now"
    expect(calls).toBe(3);
  });

  it('tolerates a bare-number attempt counter written by an older build', async () => {
    const work = new InMemoryStorage().work;
    let calls = 0;
    const c = createConsumer(work, 'legacy', () => { calls++; throw new Error('boom'); }, {
      name: 'A', maxAttempts: 5, retryDelayMs: 1_000,
    });
    await emit(work, 'legacy', { id: 'p' }, { id: 'p' });
    await work.put('evtatt:legacy:A:p', 4); // pre-K3 shape: a bare count, no nextAt

    await c.poll(); // no nextAt to honour → due now
    expect(calls).toBe(1);
    const dead = await listDeadEvents(work, 'legacy', 'A');
    expect(dead[0]!.attempts).toBe(5); // 4 + this one → the old count was READ, not discarded
    expect(dead[0]!.status).toBe('quarantined');
  });
});
