// journal-util: `gnl sweep --older-than` duration parsing + the storage/journal resolution every
// storage command shares. Both were previously only exercised indirectly through commands, so a
// malformed duration or a missing-config guard could regress unnoticed (coverage was 45%).
import { describe, it, expect } from 'vitest';
import { getJournal, parseDuration } from '../src/journal-util.js';
import type { GnlDevConfig } from '../src/config.js';

describe('parseDuration', () => {
  it('parses every supported unit into milliseconds', () => {
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('45s')).toBe(45_000);
    expect(parseDuration('90m')).toBe(5_400_000);
    expect(parseDuration('24h')).toBe(86_400_000);
    expect(parseDuration('30d')).toBe(2_592_000_000);
  });

  it('tolerates surrounding whitespace (argv values often carry it)', () => {
    expect(parseDuration('  7d  ')).toBe(604_800_000);
  });

  it("'0' is a legitimate amount (sweep everything) — not confused with a parse failure", () => {
    expect(parseDuration('0d')).toBe(0);
  });

  it('rejects malformed input with a message that shows the expected shape', () => {
    for (const bad of ['30', 'd', '30 d', '1.5h', '-5m', '30w', '', 'abc']) {
      expect(() => parseDuration(bad)).toThrow(/invalid duration/);
    }
    // the error text carries examples so the CLI user knows what to type
    expect(() => parseDuration('30w')).toThrow(/'30d', '24h'/);
  });

  it('unit matching is exact: `m` is minutes and `ms` is milliseconds (no prefix collision)', () => {
    expect(parseDuration('1m')).toBe(60_000);
    expect(parseDuration('1ms')).toBe(1);
  });
});

describe('getJournal', () => {
  const fakeDurable = { toJournal: (runs: unknown) => ({ __fromStorage: runs }) } as any;

  it('prefers config.storage — wrapped through the CALLER-provided durable instance', () => {
    const runs = { id: 'runs-store' };
    const config = { storage: { runs } } as unknown as GnlDevConfig;
    // must come from the passed-in module, not a statically imported one (same-instance requirement)
    expect(getJournal(config, fakeDurable)).toEqual({ __fromStorage: runs });
  });

  it('falls back to config.journal when there is no storage', () => {
    const journal = { id: 'plain-journal' };
    const config = { journal } as unknown as GnlDevConfig;
    expect(getJournal(config, fakeDurable)).toBe(journal);
  });

  it('storage wins when BOTH are configured', () => {
    const runs = { id: 'runs-store' };
    const config = { storage: { runs }, journal: { id: 'ignored' } } as unknown as GnlDevConfig;
    expect(getJournal(config, fakeDurable)).toEqual({ __fromStorage: runs });
  });

  it('neither configured → a clear error naming both options', () => {
    expect(() => getJournal({} as GnlDevConfig, fakeDurable)).toThrow(/no 'storage' or 'journal'/);
  });
});
