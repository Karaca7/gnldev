// `gnl doctor` — the stamps it reads out of a journal, and what `--share` is allowed to contain.
//
// The stamp logic is a pure function of (journal, durable), so it is driven against a real in-memory
// storage rather than a mock: the thing being tested is whether the ordering contracts hold (runs
// ascending, entries ascending) and a mock would just restate the assumption.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, toJournal, recordIncident } from '@gnldev/durable';
import type * as Durable from '@gnldev/durable';
import { doctorStamps, humanDuration, shareBlock } from '../src/commands/doctor.js';

function freshJournal(): Durable.Journal & Durable.JournalReader {
  return toJournal(new InMemoryStorage().runs) as Durable.Journal & Durable.JournalReader;
}

/** A run with one model record, so `listRuns` sees it and `readRun` has something to timestamp. */
async function seedRun(journal: Durable.Journal, runId: string): Promise<void> {
  await journal.put(`${runId}:model:0`, { text: 'ok' });
}

const incident = (over: Partial<Durable.RunIncident> = {}): Durable.RunIncident => ({
  at: Date.now(),
  source: 'duplicate-guard',
  action: 'warn',
  toolName: 'charge',
  toolCallId: 'call-1',
  message: 'a duplicate was caught',
  ...over,
});

describe('doctorStamps', () => {
  it('an empty journal reports nothing rather than guessing', async () => {
    const s = await doctorStamps(freshJournal(), await import('@gnldev/durable'));
    expect(s.runsScanned).toBe(0);
    expect(s.firstRunAt).toBeUndefined();
    expect(s.firstGuardAt).toBeUndefined();
  });

  it('finds the first run and the first guard firing, and they are different moments', async () => {
    const d = await import('@gnldev/durable');
    const journal = freshJournal();
    const before = Date.now();
    await seedRun(journal, 'r-1');
    await seedRun(journal, 'r-2');
    const firedAt = before + 60_000;
    await recordIncident(journal, 'r-2', incident({ at: firedAt }));

    const s = await doctorStamps(journal, d);
    expect(s.firstRunAt, 'the adapter records write times, so this must be a number').toBeTypeOf('number');
    expect(s.firstRunAt!).toBeGreaterThanOrEqual(before);
    expect(s.firstGuardAt).toBe(firedAt);
    expect(s.firstGuardSource).toBe('duplicate-guard');
  });

  it('walks runs in age order, so the EARLIEST firing wins', async () => {
    // The whole point of the number is "how long until this protected me", which is wrong if it
    // reports whichever incident happened to be found first.
    const d = await import('@gnldev/durable');
    const journal = freshJournal();
    await seedRun(journal, 'r-old');
    await seedRun(journal, 'r-new');
    await recordIncident(journal, 'r-new', incident({ at: 3_000_000 }));
    await recordIncident(journal, 'r-old', incident({ at: 1_000_000 }));

    expect((await doctorStamps(journal, d)).firstGuardAt).toBe(1_000_000);
  });

  it('ignores incidents that are not about a duplicate', async () => {
    // A tool-call ceiling and a loop detector are real guards, and neither one means "a repeat was
    // caught" — which is the claim `time to first protected run` is making.
    const d = await import('@gnldev/durable');
    const journal = freshJournal();
    await seedRun(journal, 'r-1');
    await recordIncident(journal, 'r-1', incident({ source: 'max-tool-calls' }));
    await recordIncident(journal, 'r-1', incident({ source: 'loop-detection', toolCallId: 'call-2' }));

    const s = await doctorStamps(journal, d);
    expect(s.firstGuardAt).toBeUndefined();
    expect(s.runsScanned, 'the run was still examined').toBe(1);
  });

  it('counts the semantic layer too — it is the same question, answered differently', async () => {
    const d = await import('@gnldev/durable');
    const journal = freshJournal();
    await seedRun(journal, 'r-1');
    await recordIncident(journal, 'r-1', incident({ source: 'semantic-guard', action: 'suspend', at: 42 }));
    expect((await doctorStamps(journal, d)).firstGuardSource).toBe('semantic-guard');
  });

  it('runs with no incidents report never — not an error, and not a zero', async () => {
    const d = await import('@gnldev/durable');
    const journal = freshJournal();
    for (const id of ['a', 'b', 'c']) await seedRun(journal, id);
    const s = await doctorStamps(journal, d);
    expect(s.firstGuardAt).toBeUndefined();
    expect(s.truncated, 'three runs is nowhere near the scan cap').toBe(false);
    expect(s.runsScanned).toBe(3);
  });
});

describe('humanDuration', () => {
  it('reads as a duration, at every scale', () => {
    expect(humanDuration(0)).toBe('0ms');
    expect(humanDuration(8_000)).toBe('8s');
    expect(humanDuration(12 * 60_000)).toBe('12m');
    expect(humanDuration(3 * 86_400_000 + 4 * 3_600_000)).toBe('3d 4h');
    // Two units, never five — `3d 4h 12m 8s 400ms` is a number, not an answer.
    expect(humanDuration(3 * 86_400_000 + 4 * 3_600_000 + 12 * 60_000 + 8_000).split(' ')).toHaveLength(2);
  });
});

describe('--share', () => {
  // The marks are `describeProtections`'s own vocabulary ('on' | 'off' | 'dev-only' | 'unknown'), not
  // the ✓/○ glyphs the formatter renders. Words, on purpose: this block is pasted into issues, chats
  // and terminals that mangle box-drawing characters, and `off` survives all of them.
  const rows = [
    { id: 'journal', mark: 'on', label: 'journal', value: 'PostgresStorage', from: 'explicit' },
    { id: 'dedup', mark: 'on', label: 'dedup profile', value: 'critical', from: 'explicit' },
    { id: 'identity', mark: 'off', label: 'identity', value: 'not bound — runs are born ownerless', from: 'default' },
  ];
  const stamps = { firstRunAt: 1_000_000, firstGuardAt: 1_000_000 + 90_000, runsScanned: 4, truncated: false, timesUnavailable: false };

  it('carries every row, as an id and a mark', () => {
    const block = shareBlock(rows, stamps).join('\n');
    for (const r of rows) expect(block).toContain(r.id);
    expect(block).toMatch(/^  on +journal$/m);
    expect(block).toMatch(/^  off +identity$/m);
  });

  it('and the two stamps plus the gap between them', () => {
    const block = shareBlock(rows, stamps).join('\n');
    expect(block).toContain('first run');
    expect(block).toContain('first guard firing');
    expect(block).toContain('time to first protected run  1m 30s');
  });

  it('carries NO value from the config — the shape, never the contents', () => {
    // The rule the command promises. `PostgresStorage` says something about somebody's
    // infrastructure; the row's mark says everything a question about a protection needs.
    const block = shareBlock(rows, stamps).join('\n');
    for (const leak of ['PostgresStorage', 'critical', 'born ownerless', 'explicit']) {
      expect(block, `the share block leaked '${leak}'`).not.toContain(leak);
    }
  });

  it('says `never` rather than inventing a stamp it does not have', () => {
    const block = shareBlock(rows, { runsScanned: 0, truncated: false, timesUnavailable: false }).join('\n');
    expect(block).toContain('never');
    expect(block).not.toContain('time to first protected run');
  });

  it('is a fenced block, because it exists to be pasted', () => {
    const lines = shareBlock(rows, stamps);
    expect(lines[0]).toBe('```');
    expect(lines[lines.length - 1]).toBe('```');
  });
});
