// M4 — Run-level advisory lock. Prevents two concurrent resumes of the same runId (so the live
// tail doesn't run twice). Opt-in: only kicks in when `runDurable({ lock })` is given.
//
// 4.2 (fencing): since the lock is advisory, a takeover after TTL is possible — if the old owner
// still calls `release()` with the `RunLock` reference it's holding, without a fencing token this
// call would blindly overwrite the new (takeover) owner's record (a half-release). On every
// acquisition a unique `token` is generated and written to the journal; `release()` writes ONLY IF
// the current record's token in the journal matches its own token — a stale (superseded) owner can no longer release it.
import { randomUUID } from 'node:crypto';
import { claim } from './journal.js';
import type { Journal } from './journal.js';

export interface RunLock {
  runId: string;
  owner: string;
  /**
   * 8.2: unique fencing token for this acquisition (the same token is written to the journal's
   * LockRecord). Exposed read-only for consumers who want to build their own in-engine CAS fencing
   * chain in THEIR OWN store (outside RunJournal, e.g. @gnldev/queue's WorkStore) — see @gnldev/queue's
   * createWorker: on terminal writes (qdone/qfail/qatt), WorkStore.putIfMatch uses this token to verify "I'm still the owner".
   */
  readonly token: string;
  /**
   * Y2 (heartbeat): extends the duration of the lock we own (`expires = now + ttlMs`).
   * If the fencing token in the current record is NOT this acquisition's token — a takeover
   * happened, the record is gone, or the lock was released — returns `false`: a lost/released lock
   * is NEVER renewed. `true` = the lock is still ours and the duration was extended. Long-running
   * jobs (a queue handler) should call this at an interval shorter than the ttl to prevent the lock
   * from expiring at TTL end (double execution).
   */
  renew(ttlMs: number): Promise<boolean>;
  release(): Promise<void>;
}

interface LockRecord {
  owner: string;
  expires: number;
  /** Fencing token: a unique identity for this acquisition. release() compares it against the current record. */
  token: string;
}

const lockKey = (runId: string) => `${runId}:lock`; // ':lock' does not match parseJournalKey → invisible to the reader

/**
 * Tries to acquire the lock atomically (`claim`/putIfAbsent). Acquires it → `RunLock` if it's free
 * or expired; returns `null` if a live lock belongs to someone else. Every successful acquisition
 * comes with a new fencing token (including on takeover) — so the old owner's handle is invalidated.
 *
 * H1 (takeover atomicity): if the journal supports `putIfMatch`, taking over an expired record is
 * done via CAS — even if two workers read the same expired record, only ONE can change it (NO
 * split-brain). If unsupported, falls back to the old best-effort get→put behavior (a documented
 * risk, the core-hardening review).
 * H2 (clock-skew): if `now` isn't given and the journal supports `now()`, the TTL decision is made
 * with the storage's own clock → wall-clock skew between workers can't disrupt takeover timing.
 */
export async function acquireRunLock(
  journal: Journal,
  runId: string,
  owner: string,
  ttlMs: number,
  now?: number,
): Promise<RunLock | null> {
  const key = lockKey(runId);
  const token = randomUUID();
  const at = now ?? (journal.now ? await journal.now() : Date.now());
  const rec: LockRecord = { owner, expires: at + ttlMs, token };

  if (await claim(journal, key, rec)) return mkLock(journal, runId, owner, token);

  const cur = await journal.get<LockRecord>(key);
  if (cur && cur.expires >= at) return null; // a live lock belongs to someone else

  if (!cur) {
    // The claim was lost but the record couldn't be read either (raced with purge/deletion) → try atomically once more.
    return (await claim(journal, key, rec)) ? mkLock(journal, runId, owner, token) : null;
  }

  // Expired → take over. If putIfMatch is available it's ATOMIC: change it if the expired record we
  // read is still in place; if another worker acted first, false → null (the loser doesn't run).
  // A new token is written → the old owner's handle cannot release/write (see mkLock: no-op on token mismatch).
  if (journal.putIfMatch) {
    return (await journal.putIfMatch(key, cur, rec)) ? mkLock(journal, runId, owner, token) : null;
  }
  // Fallback (adapter without putIfMatch): best-effort get→put — sufficient for single-process
  // resume, split-brain risk in multi-worker is documented (the core-hardening review).
  await journal.put(key, rec);
  return mkLock(journal, runId, owner, token);
}

function mkLock(journal: Journal, runId: string, owner: string, token: string): RunLock {
  const key = lockKey(runId);
  return {
    runId,
    owner,
    token,
    // Y2 (heartbeat): SAME owner-check (fencing) logic as release() — if the current record no
    // longer carries THIS acquisition's token (a takeover happened / no record / lock released),
    // returns `false`, the record is NOT TOUCHED (showing a lost lock as "alive" would hide a
    // split-brain). If it matches, moves `expires` to `now + ttlMs` — the token DOES NOT CHANGE (same acquisition, just the duration is extended).
    renew: async (ttlMs: number) => {
      const cur = await journal.get<LockRecord>(key);
      if (!cur || cur.token !== token) return false; // stale owner → rejected, record is not renewed
      const at = journal.now ? await journal.now() : Date.now();
      const next: LockRecord = { owner, expires: at + ttlMs, token };
      // SAME philosophy as the takeover CAS in acquireRunLock: atomic if putIfMatch is available
      // (change it if the record we read is still in place — if a takeover happened in between,
      // returns false, the record is not corrupted). Otherwise falls back to best-effort get→put
      // (sufficient for single-process, the core-hardening review).
      if (journal.putIfMatch) return journal.putIfMatch(key, cur, next);
      await journal.put(key, next);
      return true;
    },
    // The journal has no delete → release by moving expires into the past (the next acquire takes over).
    // Owner-check (fencing): if the current record no longer carries THIS acquisition's token (a
    // takeover happened or there's no record at all), release is a no-op — it never overwrites another owner's lock.
    release: async () => {
      const cur = await journal.get<LockRecord>(key);
      if (!cur || cur.token !== token) return; // stale owner → rejected, silent no-op
      await journal.put(key, { owner, expires: 0, token });
    },
  };
}
