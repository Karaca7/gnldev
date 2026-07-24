// @gnl/durable/polling — shared poll-loop core (Phase 8.1 review finding: the tick/backoff/"polling"
// flag loop in @gnl/queue, @gnl/events, @gnl/scheduler was nearly THREE identical copies). This module
// consolidates those three copies into ONE place — external behavior (tick timing, backoff
// growth/reset, overlap protection) is preserved exactly; calling packages only pass their own
// `backoff` default already RESOLVED (queue/events ON, scheduler OFF) — this module doesn't impose its own default.
//
// A self-rescheduling setTimeout chain: the next tick is never scheduled until the previous fn()
// FULLY finishes → the overlap risk that exists with setInterval is structurally absent. The
// `polling` flag is still extra insurance against possible externally (manually) triggered overlaps.
// If fn() returns true ("work was done") the interval resets to pollMs; if false ("empty poll") the
// interval grows ×2 (capped at maxPollMs) WHEN backoff IS ON, or stays fixed at pollMs WHEN it's OFF.

export interface PollLoopOptions {
  /** Tick interval (ms). Default 200. */
  pollMs?: number;
  /** When fn() returns false (no work), grow the interval ×2 (capped at maxPollMs). Default true. */
  backoff?: boolean;
  /** Backoff cap (only meaningful while backoff !== false). Default pollMs*32. */
  maxPollMs?: number;
}

export interface PollLoop {
  start(): void;
  stop(): void;
}

/**
 * `fn` returns whether work was done in a tick (true/false). Errors (if fn() didn't swallow them
 * internally) are caught and logged here — the chain NEVER dies (the next tick is always scheduled).
 */
export function createPollLoop(fn: () => Promise<boolean>, opts: PollLoopOptions = {}): PollLoop {
  const pollMs = opts.pollMs ?? 200;
  const backoffOn = opts.backoff ?? true;
  const maxPollMs = opts.maxPollMs ?? pollMs * 32;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let polling = false; // overlap protection: a new tick doesn't start before the previous one finishes
  let currentPollMs = pollMs;

  async function tick() {
    if (polling) return;
    polling = true;
    let progressed = false;
    try {
      progressed = await fn();
    } catch (err) {
      // fn() usually swallows its own work/handler errors internally; this is the last resort only
      // for unexpected (e.g. storage I/O) errors — it matters that the chain NOT DIE (the next tick can still be scheduled).
      console.warn('@gnl/durable: poll-loop tick failed (chain continues):', err);
    } finally {
      polling = false;
    }
    currentPollMs = !backoffOn ? pollMs : progressed ? pollMs : Math.min(currentPollMs * 2, maxPollMs);
    if (timer !== undefined) timer = setTimeout(tick, currentPollMs); // don't reschedule if stop() set timer to undefined in the meantime
  }

  return {
    start() {
      if (timer !== undefined) return; // already running
      currentPollMs = pollMs;
      timer = setTimeout(tick, currentPollMs);
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
