// H13 — JOURNAL FORMAT VERSIONING: the insurance policy for the "weeks-long running" promise.
//
// PROBLEM: the SHAPE of input/model/tool records in the journal is tied to AI SDK v5's output
// Format. When SDK v6 changes that shape, old runs left suspended would become unable to replay —
// And SILENTLY at that (a wrongly-shaped record, unpredictable behavior). This module defuses that bomb:
//
// ON WRITE → every versioned record gets an `_v: JOURNAL_FORMAT_VERSION` stamp (stampFormat).
// ON READ  → upgradeFormat: an unstamped record = v1 (ALL data written to date was written with
//              This version); an old version → converted to the current shape via the registered
//              Upgrader chain; an unconvertible one → a clear JournalFormatError INSTEAD OF SILENT CORRUPTION.
//
// WHEN SDK v6 DAY ARRIVES, do this (one place, one pattern):
//   1. Bump JOURNAL_FORMAT_VERSION to 2.
//   2. Write registerFormatUpgrade(1, (oldRecord) => newShape) — converts v5 output to v6 shape.
// Old (unstamped and _v:1) records transparently upgrade to v2 at read time; suspended runs survive.
//
// SCOPE DELIBERATELY NARROW: only record kinds tied to the AI-SDK shape are versioned (input,
// Model:N, tool:callId). Lock records are NEVER stamped/upgraded — run-lock takeover works via
// BYTE equality with `putIfMatch` (see journal.ts H1); any intervening transformation would break
// It. proc:/counter/budget records are GNL's own simple shapes — versioned separately if the need arises.

/** An unreadable/unconvertible journal record — stops replay by name instead of silently breaking it. */
export class JournalFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JournalFormatError';
  }
}

/** The format version this GNL version WRITES and natively READS (AI SDK v5 record shapes = 1). */
export const JOURNAL_FORMAT_VERSION = 1;

type FormatUpgrader = (value: Record<string, unknown>) => Record<string, unknown>;
const upgraders = new Map<number, FormatUpgrader>();

/**
 * Registers the upgrader that converts a record at version `from` into the `from+1` shape. The
 * Converter must be PURE (must not mutate the input) and must itself place the `_v: from+1` stamp
 * On the output (if it doesn't, the chain still advances — upgradeFormat assumes version from+1).
 * The returned function undoes the registration (for test/temporary scenarios).
 */
export function registerFormatUpgrade(from: number, up: FormatUpgrader): () => void {
  upgraders.set(from, up);
  return () => { upgraders.delete(from); };
}

/** Write stamp: adds `_v` to a copy of the record (does NOT MUTATE the caller's object — the model
 *  Result is also returned to the caller after being written to the journal; we don't leak _v into it). */
export function stampFormat<T extends object>(value: T): T {
  return { ...(value as Record<string, unknown>), _v: JOURNAL_FORMAT_VERSION } as T;
}

/** Is this key of a versioned kind? (input / model:N / tool:callId — runIds may contain ':',
 *  So it's checked with a SUFFIX pattern.) Lock/proc/counter keys are deliberately EXCLUDED. */
export function isVersionedKey(key: string): boolean {
  return key.endsWith(':input') || /:model:\d+$/.test(key) || /:tool:[^:]*$/.test(key);
}

/**
 * Read-time upgrade: brings the record to the current format shape and STRIPS the `_v` stamp (the
 * Stamp is a storage detail, it does not leak into the replay result/user objects).
 *
 * Rules:
 * null/primitive/array → as-is (an unstamped pre-GNL/free-form value).
 * unstamped object → considered v1 (all real data written up to today).
 * `_v` > current → this journal was written by a NEWER GNL → JournalFormatError ("upgrade GNL").
 * `_v` < current → the upgrader chain is applied step by step; a missing link → JournalFormatError.
 *
 * `target` is test-only (to exercise the chain without moving the constant).
 */
export function upgradeFormat<T>(value: T, key?: string, target: number = JOURNAL_FORMAT_VERSION): T {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  let rec = value as Record<string, unknown>;
  let ver = typeof rec._v === 'number' ? (rec._v as number) : 1;
  const at = key ? ` (${key})` : '';
  if (ver > target) {
    throw new JournalFormatError(
      `journal record${at} was written by a newer GNL (format v${ver}; this version reads v${target}). ` +
        `Upgrade the GNL in this process — the record is not corrupted, this version just cannot read it.`,
    );
  }
  while (ver < target) {
    const up = upgraders.get(ver);
    if (!up) {
      throw new JournalFormatError(
        `journal record${at} is format v${ver}, current is v${target} — no v${ver}→v${ver + 1} upgrader is registered. ` +
          `Register a converter with registerFormatUpgrade(${ver}, ...) (see the format.ts header).`,
      );
    }
    rec = up(rec);
    ver = typeof rec._v === 'number' ? (rec._v as number) : ver + 1;
  }
  if ('_v' in rec) {
    const { _v: _ignored, ...rest } = rec;
    return rest as T;
  }
  return rec as T;
}
