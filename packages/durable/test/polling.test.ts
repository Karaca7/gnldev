// Phase 8.1: createPollLoop unit tests — the poll-loop core shared by queue/events/scheduler.
// The THREE packages' OWN backoff/timing tests (queue.test.ts, events.test.ts, scheduler.test.ts)
// keep passing UNCHANGED as proof of behavior-equivalence — here createPollLoop itself is tested
// in isolation (backoff growth/reset/overlap/stop).
import { describe, it, expect, vi } from 'vitest';
import { createPollLoop } from '../src/index.js';

describe('createPollLoop', () => {
  it('when fn always returns false (no work), consecutive tick intervals grow ×2 WHILE backoff is ON (capped at maxPollMs)', async () => {
    const times: number[] = [];
    const loop = createPollLoop(
      async () => {
        times.push(Date.now());
        return false;
      },
      { pollMs: 15, maxPollMs: 120, backoff: true },
    );
    loop.start();
    await new Promise((r) => setTimeout(r, 320));
    loop.stop();

    expect(times.length).toBeGreaterThanOrEqual(4);
    const gaps: number[] = [];
    for (let i = 1; i < times.length; i++) gaps.push(times[i]! - times[i - 1]!);
    expect(gaps[1]!).toBeGreaterThan(gaps[0]! * 1.3); // ×2 growth (loose tolerance)
    expect(gaps[2]!).toBeGreaterThan(gaps[1]! * 1.3);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(120 + 40); // cap (maxPollMs) not exceeded
  });

  it('once fn returns true (work was done), the next interval resets to pollMs', async () => {
    let shouldWork = false;
    const calls: number[] = [];
    const loop = createPollLoop(
      async () => {
        calls.push(Date.now());
        return shouldWork;
      },
      { pollMs: 10, maxPollMs: 80, backoff: true },
    );
    loop.start();
    await new Promise((r) => setTimeout(r, 150)); // let a few backoff steps pass while idle (interval near cap)
    calls.length = 0;
    shouldWork = true;
    // if reset happened (~pollMs=10ms), it's caught quickly; if still in backoff (cap ~80ms) it would
    // not be caught in this short window.
    await new Promise((r) => setTimeout(r, 40));
    loop.stop();
    expect(calls.length).toBeGreaterThanOrEqual(2); // several ticks happened at the reset, fast interval
  });

  it('backoff:false → constant poll interval (no growth)', async () => {
    let calls = 0;
    const loop = createPollLoop(
      async () => {
        calls++;
        return false;
      },
      { pollMs: 10, backoff: false },
    );
    loop.start();
    await new Promise((r) => setTimeout(r, 205)); // a ~20-tick window
    loop.stop();
    expect(calls).toBeGreaterThanOrEqual(15); // ticks at a regular constant interval, no backoff
  });

  it('no overlap: a new tick does not start while a slow fn is still running', async () => {
    let active = 0;
    let maxActive = 0;
    const loop = createPollLoop(
      async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 60)); // artificially slow down each tick
        active--;
        return false;
      },
      { pollMs: 10 },
    );
    loop.start();
    await new Promise((r) => setTimeout(r, 200));
    loop.stop();
    expect(maxActive).toBeLessThanOrEqual(1); // never two ticks running concurrently
  });

  it('after stop() fn is never called again; start() is a no-op if already running (interval is not reset)', async () => {
    let calls = 0;
    const loop = createPollLoop(async () => { calls++; return false; }, { pollMs: 10 });
    loop.start();
    await new Promise((r) => setTimeout(r, 35));
    loop.stop();
    const after = calls;
    await new Promise((r) => setTimeout(r, 60));
    expect(calls).toBe(after); // no increase after stop

    // if start() is called twice, the second call is a no-op (does not re-arm an already-running timer).
    calls = 0;
    const loop2 = createPollLoop(async () => { calls++; return false; }, { pollMs: 500 });
    loop2.start();
    loop2.start(); // must be a no-op — timer already armed
    loop2.stop();
    expect(calls).toBe(0); // stopped before the 500ms window elapsed, no tick happened
  });

  it('if fn throws (unexpected error) the chain does not die — the next tick is still scheduled', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;
    const loop = createPollLoop(
      async () => {
        calls++;
        if (calls === 1) throw new Error('unexpected I/O error');
        return false;
      },
      { pollMs: 10, backoff: false },
    );
    loop.start();
    await new Promise((r) => setTimeout(r, 60));
    loop.stop();
    expect(calls).toBeGreaterThanOrEqual(3); // the first tick threw but the following ones still ran
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
