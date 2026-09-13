// FAZ-4 (critical profile) — append-only idempotency CONFLICT ledger. The general path derives its
// 409 reporting from the records that already exist (input/outcome/lock); regulated deployments need
// the refusals THEMSELVES to leave a trace (non-repudiation / reconciliation): "who was told no,
// when, about which run". Entries are PII-FREE by design — codes, hashes and an opaque actor id,
// never message content.
//
// Key shape: `idem:conflict:<runId>:<at>-<seq>` — runId-scoped for filtering, but note the family is
// NOT under `${runId}:` so a run sweep does NOT erase its own refusal history (an audit trail that
// the subject of the audit can delete is not one). Purge explicitly via
// `journal.deletePrefix('idem:conflict:')` (org deployments: withOrg prefixes these keys like every
// other, so an org purge sweeps them exactly).
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
 * Ledger append. `mode: 'best-effort'` (default): the write must never mask or delay the refusal —
 * A failure warns. `mode: 'require'` (FAZ-7, RunOptions.auditOnReject): the append is a PRECONDITION
 * of the refusal and its failure PROPAGATES — never refuse unrecorded. Journal clock when available.
 */
export async function recordIdemConflict(journal: Journal, rec: Omit<IdemConflictRecord, 'at'>, mode: 'best-effort' | 'require' = 'best-effort'): Promise<void> {
  // FAZ-7 `mode: 'require'` (auditOnReject): the ledger append happens BEFORE the refusal is
  // delivered and its failure PROPAGATES — a regulated deployment that must never refuse
  // unrecorded prefers a 500-shaped audit error over an unauditable 409. Default stays best-effort.
  // ONE key builder for both modes — a literal copy per branch is scheme-drift waiting to happen.
  // Seq alone is process-LOCAL (same-ms twin workers would collide and overwrite — record loss in a
  // non-repudiation ledger); the uuid slice makes the key process-unique.
  const append = async () => {
    const at = journal.now ? await journal.now() : Date.now();
    await journal.put(`idem:conflict:${rec.runId}:${at}-${seq++}-${randomUUID().slice(0, 8)}`, { ...rec, at });
  };
  if (mode === 'require') {
    await append();
    return;
  }
  try {
    await append();
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
