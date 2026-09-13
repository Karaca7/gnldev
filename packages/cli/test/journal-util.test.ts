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

describe('getJournal', async () => {
  // Mirrors the real module: getJournal now also normalizes a directly-configured `journal`, because
  // the documented way to configure one is `journal: new SqliteStorage(...).runs` — a RunJournal whose
  // listRuns answers with a Page, not the array every reader-side command here consumes.
  const { asReaderJournal } = await import('@gnldev/durable');
  const fakeDurable = { toJournal: (runs: unknown) => ({ __fromStorage: runs }), asReaderJournal } as any;

  it('prefers config.storage — wrapped through the CALLER-provided durable instance', () => {
    const runs = { id: 'runs-store' };
    const config = { storage: { runs } } as unknown as GnlDevConfig;
    // must come from the passed-in module, not a statically imported one (same-instance requirement)
    expect(getJournal(config, fakeDurable)).toEqual({ __fromStorage: runs });
  });

  it('falls back to config.journal when there is no storage — untouched if it needs no bridging', () => {
    const journal = { id: 'plain-journal' };
    const config = { journal } as unknown as GnlDevConfig;
    // Identity, not just equality: a journal that already satisfies the reader contract must not be
    // wrapped, or `storage === journal` checks elsewhere would start disagreeing.
    expect(getJournal(config, fakeDurable)).toBe(journal);
  });

  it('bridges a directly-configured journal that answers listRuns with a Page', async () => {
    const { InMemoryStorage } = await import('@gnldev/durable');
    const config = { journal: new InMemoryStorage().runs } as unknown as GnlDevConfig;
    const j = getJournal(config, fakeDurable) as any;
    // `gnl runs` does `[...(await journal.listRuns())].reverse()` — a Page is not iterable, so this
    // threw before the bridge; `gnl sweep` read `.length` off it and swept nothing.
    expect(Array.isArray(await j.listRuns())).toBe(true);
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
