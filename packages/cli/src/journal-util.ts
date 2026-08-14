// Shared "which journal does this storage command read/write" resolution — the SAME pattern the
// Studio/dev commands already use: config.storage ? toJournal(storage.runs) : config.journal.
// Also: duration parsing for `gnl sweep --older-than`.
import type * as Durable from '@gnldev/durable';
import type { Journal, JournalReader } from '@gnldev/durable';
import type { GnlDevConfig } from './config.js';

/** Resolves the journal a storage command reads/writes. NET error if neither storage nor journal is configured
 *  (loadConfig already checks this at load time; this is a second, command-local guard for a clear message).
 *  `d` is the caller's already project-resolved @gnldev/durable module (see runtime.ts) — toJournal must
 *  Come from the SAME @gnldev/durable instance the journal/storage objects themselves were built with. */
export function getJournal(config: GnlDevConfig, d: typeof Durable): Journal & JournalReader {
  if (config.storage) return d.toJournal(config.storage.runs);
  // A host that configures `journal` directly almost always passes `storage.runs` (that is what the
  // README's quickstart shows) — a RunJournal, whose listRuns returns a Page, not the array every
  // Reader-side caller here expects. asReaderJournal presents the reader contract for either shape.
  if (config.journal) return d.asReaderJournal(config.journal) as Journal & JournalReader;
  throw new Error("gnl.config has no 'storage' or 'journal' — this command needs one to read/write runs.");
}

const DURATION_UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parses '30d' / '24h' / '90m' / '45s' / '500ms' into milliseconds. */
export function parseDuration(input: string): number {
  const m = /^(\d+)(ms|s|m|h|d)$/.exec(input.trim());
  if (!m) throw new Error(`invalid duration '${input}' — expected e.g. '30d', '24h', '90m', '45s'`);
  return Number(m[1]) * DURATION_UNITS[m[2]!]!;
}
