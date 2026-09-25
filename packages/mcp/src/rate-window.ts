// The fixed-window call counter behind `rateLimit: { maxCalls, windowMs }`.
//
// It lived inside `createMcpServer`'s closure, which made one of its two halves untestable. The half
// that can go WRONG — evicting a LIVE window, which hands the caller a fresh allowance and stops the
// limit holding — was testable through behaviour and is pinned in server-authorization.test.ts. The
// half that keeps it BOUNDED is not: an expired row and an absent row behave identically, by
// construction, which is exactly why dropping expired rows is safe and also why no observable
// behaviour distinguishes "swept" from "not swept".
//
// Two attempts to measure it from outside failed, and both are recorded rather than retried. A heap
// assertion PASSED with the sweep deleted (so it caught nothing) and then failed on the way back at
// 16.3 MB for 30,000 subjects. A ten-batch soak protocol could not tell the two apart either — 5,000
// rows at ~104 bytes is half a megabyte inside a batch that allocates four times that just making the
// calls. Both were measuring heap, a proxy, when the question is how many rows the table holds.
//
// So the table gets its own module and `size()` answers directly. It is NOT exported from the package
// index: a reader has no reason to construct one, and a surface added for a test is a surface somebody
// depends on. Same move as @gnldev/auth's exposure.ts and @gnldev/durable's agent-stream.ts this round
// — the rule goes where it can be checked.

export interface RateWindowOptions {
  maxCalls: number;
  windowMs: number;
  /**
   * How many rows may accumulate before a `bump` sweeps the expired ones.
   *
   * The sweep is O(rows), so doing it on every call would make a cheap check linear in the number of
   * subjects seen. Crossing a threshold keeps it amortised: one scan per ~1024 new subjects.
   */
  sweepAt?: number;
}

export interface RateWindow {
  /** Count one call for `key`. False means the caller is over its limit for the current window. */
  bump(key: string, now?: number): boolean;
  /** Drop every row whose window has closed. Returns how many went. */
  sweep(now?: number): number;
  /** How many rows the table holds. The reason this module exists. */
  size(): number;
}

export function createRateWindow(opts: RateWindowOptions): RateWindow {
  const sweepAt = opts.sweepAt ?? 1024;
  const rows = new Map<string, { count: number; resetAt: number }>();

  function sweep(now: number = Date.now()): number {
    let dropped = 0;
    // ONLY expired rows. A live row removed here would reset its subject's allowance mid-window, which
    // is the limit silently not holding — worse than the unbounded table this sweep exists to bound.
    for (const [k, row] of rows) {
      if (now < row.resetAt) continue;
      rows.delete(k);
      dropped++;
    }
    return dropped;
  }

  return {
    sweep,
    size: () => rows.size,
    bump(key, now = Date.now()) {
      if (rows.size >= sweepAt) sweep(now);
      const row = rows.get(key);
      // An expired row is replaced rather than mutated, so the window's start is the call that reopened
      // it. Extending `resetAt` in place would slide the window forward on every call and the limit
      // would never reset for an active caller.
      if (!row || now >= row.resetAt) {
        rows.set(key, { count: 1, resetAt: now + opts.windowMs });
        return true;
      }
      if (row.count >= opts.maxCalls) return false;
      row.count += 1;
      return true;
    },
  };
}
