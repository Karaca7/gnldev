// A time-bounded lease: exactly one process does the unattended work.
//
// The problem it solves is dull and expensive. A nightly job that costs real model calls runs on
// Every instance that has it enabled, so two instances means two bills and two sets of results that
// Disagree about which was "the" nightly run. "Enable it on one instance" is a documented workaround
// And workarounds are what people forget during a scale-up.
//
// Built on the same CAS primitives as the run-lock (`putIfAbsent` / `putIfMatch`), for the same
// Reason: an election that is not atomic elects two leaders under exactly the load that made you
// Want an election.
import { claim } from './journal.js';
import type { Journal } from './journal.js';

export interface Lease {
  owner: string;
  /** Wall clock. See the clock-skew note on `acquireLease`. */
  expiresAt: number;
}

const noCasWarned = new WeakSet<object>();

/**
 * Tries to hold `key` for `ttlMs`. Returns true when this owner may do the work.
 *
 * Four cases, and only one of them is a race:
 *
 *   · nobody holds it        → claim it (atomic insert; the loser is simply told no)
 *   · this owner holds it    → renew, so long work does not lose its own lease mid-flight
 *   · somebody's has EXPIRED → take it over by CAS on the exact expired value. Two contenders both
 *     See the same stale lease; only the one whose compare-and-set lands wins, which is the whole
 *     Point of doing it this way rather than "read, decide, write".
 *   · somebody holds a live one → false. Not an error: it means the work is already being done.
 *
 * TTL: make it comfortably longer than the interval between attempts — an expiry that lands while
 * The holder is mid-run hands the work to a second process, which is the thing being prevented. A
 * Lease is wall-clock and therefore skew-sensitive across machines; the ttl has to absorb the skew
 * You actually have, and the exported bound below is a starting point, not a guarantee.
 */
export async function acquireLease(
  journal: Journal,
  key: string,
  owner: string,
  ttlMs: number,
  now: number = Date.now(),
): Promise<boolean> {
  const next: Lease = { owner, expiresAt: now + ttlMs };
  const cur = (await journal.get<Lease>(key).catch(() => undefined)) ?? undefined;

  if (!cur || typeof cur.expiresAt !== 'number') return claim(journal, key, next);
  if (cur.owner !== owner && cur.expiresAt > now) return false;

  // Renewal and takeover are the same operation: replace THIS exact value, or lose.
  if (typeof journal.putIfMatch === 'function') return journal.putIfMatch(key, cur, next);

  if (!noCasWarned.has(journal)) {
    noCasWarned.add(journal);
    console.warn(
      '@gnldev/durable: this journal does not implement `putIfMatch` — lease renewal/takeover fell back ' +
        'to a plain write. Safe in single-process usage; with several instances two of them can believe ' +
        'they hold the same lease at the moment one expires, and the leased work runs twice. Implement ' +
        '`putIfMatch(key, expected, value)` (all first-party adapters do — see the parity matrix in journal.ts).',
    );
  }
  await journal.put(key, next);
  return true;
}

/** Gives the lease up early, so a clean shutdown does not leave the work parked until the TTL. */
export async function releaseLease(journal: Journal, key: string, owner: string): Promise<void> {
  const cur = (await journal.get<Lease>(key).catch(() => undefined)) ?? undefined;
  // Only ever release YOUR OWN. Releasing somebody else's is how two processes end up running.
  if (!cur || cur.owner !== owner) return;
  if (typeof journal.putIfMatch === 'function') await journal.putIfMatch(key, cur, { owner, expiresAt: 0 });
  else await journal.put(key, { owner, expiresAt: 0 } satisfies Lease);
}

/** Who holds it, if anyone — for a status endpoint, never for deciding whether to act. */
export async function readLease(journal: Journal, key: string, now: number = Date.now()): Promise<Lease | undefined> {
  const cur = (await journal.get<Lease>(key).catch(() => undefined)) ?? undefined;
  if (!cur || typeof cur.expiresAt !== 'number' || cur.expiresAt <= now) return undefined;
  return cur;
}
