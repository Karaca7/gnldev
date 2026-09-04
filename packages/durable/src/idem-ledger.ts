// FAZ-4 (critical profile) — append-only idempotency CONFLICT ledger. The general path derives its
// 409 reporting from the records that already exist (input/outcome/lock); regulated deployments need
// The refusals THEMSELVES to leave a trace (non-repudiation / reconciliation): "who was told no,
// When, about which run". Entries are PII-FREE by design — codes, hashes and an opaque actor id,
// Never message content.
//
// Key shape: `idem:conflict:<runId>:<at>-<seq>` — runId-scoped for filtering, but note the family is
// NOT under `${runId}:` so a run sweep does NOT erase its own refusal history (an audit trail that
// The subject of the audit can delete is not one). Purge explicitly via
// `journal.deletePrefix('idem:conflict:')` (org deployments: withOrg prefixes these keys like every
// Other, so an org purge sweeps them exactly).
import { randomUUID } from 'node:crypto';
import type { Journal } from './journal.js';

export interface IdemConflictRecord {
  at: number;
  runId: string;
  /** The machine code of the refusal — 'run_busy' | 'run_thread_mismatch' | 'run_input_mismatch' | 'run_actor_mismatch' | 'run_swept'. */
  code: string;
  /** Opaque caller identity when the deployment binds one (RunOptions.actor). */
  actor?: string;
  /** PII-free supporting facts (hashes, owner ids) — NEVER raw input. */
  detail?: Record<string, string | number>;
}

let seq = 0;

/**
 * Best-effort append — a ledger write must never mask or delay the refusal itself
 * (`auditOnReject: 'require'` semantics are a future critical-profile config; today's contract is
 * Documented best-effort). Uses the journal clock when available.
 */
export async function recordIdemConflict(journal: Journal, rec: Omit<IdemConflictRecord, 'at'>): Promise<void> {
  try {
    const at = journal.now ? await journal.now() : Date.now();
    // Seq alone is process-LOCAL — two workers refusing the same runId in the same ms would both
    // Write `<at>-0` and the second put would OVERWRITE the first (record loss in a non-repudiation
    // Ledger). The uuid slice makes the key process-unique; append-only stays append-only.
    await journal.put(`idem:conflict:${rec.runId}:${at}-${seq++}-${randomUUID().slice(0, 8)}`, { ...rec, at });
  } catch (err) {
    console.warn(
      `@gnldev/durable: could not append the idem-conflict ledger entry for '${rec.runId}' (${rec.code}) — ` +
      `the refusal itself was still delivered. Cause: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Reconciliation read: every conflict entry (optionally one run's), newest first. THROWS without
 * `listKeys` — an empty success would read as "no conflicts" when the truth is "cannot enumerate"
 * (heyet şartı: hata, boş başarı değil).
 */
export async function readIdemLedger(
  journal: Journal,
  opts: { runId?: string } = {},
): Promise<IdemConflictRecord[]> {
  if (typeof journal.listKeys !== 'function') {
    throw new Error(
      "@gnldev/durable: readIdemLedger requires the journal to implement `listKeys` — without it the ledger cannot be enumerated (an empty answer would misread as 'no conflicts').",
    );
  }
  const prefix = opts.runId ? `idem:conflict:${opts.runId}:` : 'idem:conflict:';
  const keys = await journal.listKeys(prefix);
  const out: IdemConflictRecord[] = [];
  for (const k of keys) {
    const rec = await journal.get<IdemConflictRecord>(k);
    if (rec) out.push(rec);
  }
  out.sort((a, b) => b.at - a.at);
  return out;
}
