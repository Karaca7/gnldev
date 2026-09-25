// The window table, asserted at its owner — including the half no behaviour could reach.
//
// `server-authorization.test.ts` covers the half that can go wrong (a live window must never be
// evicted, proven by a mutation). This file covers the half that keeps the table BOUNDED, which was
// untestable while the Map lived in a closure: an expired row and an absent row behave identically, so
// nothing observable told "swept" from "not swept".
//
// Two attempts to measure it from outside are recorded in rate-window.ts's header rather than repeated
// here: a heap assertion that PASSED with the sweep deleted, and a ten-batch soak protocol whose two
// series were indistinguishable. Both measured heap. This measures rows.
import { describe, it, expect } from 'vitest';
import { createRateWindow } from '../src/rate-window.js';

describe('the table stays bounded', () => {
  it('THE REASON THIS FILE EXISTS — expired rows are actually dropped', async () => {
    // 30,000 one-shot subjects on a 1 ms window. Without the sweep this is 30,000 live rows; the
    // assertion is on the ROW COUNT, which is the thing the fix changes, rather than on a heap reading.
    const w = createRateWindow({ maxCalls: 5, windowMs: 1, sweepAt: 1024 });
    for (let i = 0; i < 30_000; i++) w.bump(`one-shot-${i}`, Date.now() + i * 2);
    expect(w.size(), 'the table must not hold a row per subject ever seen').toBeLessThan(1024 + 1);
  });

  it('and the sweep reports what it dropped', () => {
    const w = createRateWindow({ maxCalls: 5, windowMs: 1_000, sweepAt: 1_000_000 });
    for (let i = 0; i < 50; i++) w.bump(`k${i}`, 1_000);
    expect(w.size()).toBe(50);
    expect(w.sweep(1_500), 'still inside the window — nothing is expired').toBe(0);
    expect(w.size()).toBe(50);
    expect(w.sweep(2_001), 'every window has closed').toBe(50);
    expect(w.size()).toBe(0);
  });

  it('THE DANGEROUS HALF — a live row survives a sweep, at its own count', () => {
    // Asserted here too, on the row count rather than through the server: evicting a live row resets its
    // subject's allowance mid-window, which is the limit silently not holding.
    const w = createRateWindow({ maxCalls: 2, windowMs: 10_000, sweepAt: 1_000_000 });
    expect(w.bump('live', 1_000)).toBe(true);
    expect(w.bump('live', 1_100)).toBe(true);
    for (let i = 0; i < 100; i++) w.bump(`old-${i}`, 1_000);
    expect(w.sweep(2_000), 'nothing has expired yet, so nothing may go').toBe(0);
    w.sweep(11_500); // 'live' resets at 11_000 — it and the old rows all expire together here
    expect(w.bump('live', 11_600), 'a fresh window after a real expiry is correct').toBe(true);

    // The inverse: sweeping while 'live' is still inside its window must not restore its allowance.
    const v = createRateWindow({ maxCalls: 2, windowMs: 10_000, sweepAt: 1_000_000 });
    v.bump('live', 1_000);
    v.bump('live', 1_100);
    for (let i = 0; i < 2_000; i++) v.bump(`old-${i}`, 500); // crosses any plausible threshold
    v.sweep(1_200);
    expect(v.bump('live', 1_300), 'still out of budget — the sweep must not have reset it').toBe(false);
  });
});

describe('the count itself', () => {
  it('allows exactly maxCalls, then refuses', () => {
    const w = createRateWindow({ maxCalls: 3, windowMs: 10_000 });
    expect([w.bump('a', 0), w.bump('a', 1), w.bump('a', 2), w.bump('a', 3), w.bump('a', 4)])
      .toEqual([true, true, true, false, false]);
  });

  it('each subject has its own budget', () => {
    const w = createRateWindow({ maxCalls: 1, windowMs: 10_000 });
    expect(w.bump('a', 0)).toBe(true);
    expect(w.bump('b', 0), 'b has not spent anything').toBe(true);
    expect(w.bump('a', 1), 'and a is still out').toBe(false);
  });

  it('the window reopens at its edge, not before', () => {
    const w = createRateWindow({ maxCalls: 1, windowMs: 1_000 });
    expect(w.bump('a', 1_000)).toBe(true);
    expect(w.bump('a', 1_999), 'one millisecond early').toBe(false);
    expect(w.bump('a', 2_000), 'exactly at resetAt').toBe(true);
  });

  it('a reopened window starts from the call that reopened it', () => {
    // The trap: extending `resetAt` in place instead of replacing the row. The window would then slide
    // forward on every call and never reset for an active caller.
    const w = createRateWindow({ maxCalls: 2, windowMs: 1_000 });
    w.bump('a', 0);
    w.bump('a', 500);
    expect(w.bump('a', 900), 'out of budget inside the first window').toBe(false);
    expect(w.bump('a', 1_000), 'the window closed, so this is a new one').toBe(true);
    expect(w.bump('a', 1_500), 'and it has its full budget').toBe(true);
    expect(w.bump('a', 1_900), 'which is then spent').toBe(false);
  });

  it('the sweep threshold does not change any answer', () => {
    // Amortisation must be invisible: the same call sequence gives the same answers whether the sweep
    // runs every call or never.
    const seq = (sweepAt: number) => {
      const w = createRateWindow({ maxCalls: 2, windowMs: 1_000, sweepAt });
      const out: boolean[] = [];
      for (let t = 0; t < 3_000; t += 200) out.push(w.bump('a', t));
      return out;
    };
    expect(seq(1)).toEqual(seq(1_000_000));
  });
});
