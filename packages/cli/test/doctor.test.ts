// `gnl doctor` — the stamps it reads out of a journal, and what `--share` is allowed to contain.
//
// The stamp logic is a pure function of (journal, durable), so it is driven against a real in-memory
// storage rather than a mock: the thing being tested is whether the ordering contracts hold (runs
// ascending, entries ascending) and a mock would just restate the assumption.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, toJournal, recordIncident } from '@gnldev/durable';
import type * as Durable from '@gnldev/durable';
import { doctorStamps, doctorGhostRuns, humanDuration, shareBlock } from '../src/commands/doctor.js';

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

// The orphan count `gnl doctor` prints. Driven through the exported function rather than the command
// body for the same reason `doctorStamps` is: the command loads a config, a project's own durable and
// a journal, and none of that is what this line is about. What IS pinned is the property that makes
// it safe to call from a diagnostic at all — it reports without deleting. `sweepThreads` answers the
// same question and purges on the way, so a doctor that called IT would erase data to print a number.
describe('listOrphanThreadState — the read-only half of the orphan report', () => {
  it('reports thread state no erasure request can reach, and leaves the journal untouched', async () => {
    const d = await import('@gnldev/durable');
    const journal = freshJournal();
    // Thread state with no `mem:` owner — what a run with no resourceId leaves behind.
    await journal.put('xthr:th-orphan:sem-pay-h1', { v: 1, canonical: 'pay: iban-tr55' });
    // …and a thread the memory port DOES know, which must not be reported.
    await journal.put('mem:th-known:messages', [{ role: 'user', content: 'x', ts: 1 }]);
    await journal.put('xthr:th-known:sem-pay-h2', { v: 1, canonical: 'pay: other' });

    const before = await journal.listKeys!('');
    const orphans = await d.listOrphanThreadState(journal);
    const after = await journal.listKeys!('');

    expect(orphans.threadIds).toEqual(['th-orphan']);
    expect(after, 'a diagnostic read deleted keys').toEqual(before);
  });

  it('says nothing when every thread has an owner', async () => {
    const d = await import('@gnldev/durable');
    const journal = freshJournal();
    await journal.put('mem:th-known:messages', [{ role: 'user', content: 'x', ts: 1 }]);
    await journal.put('xthr:th-known:sem-pay-h1', { v: 1, canonical: 'pay: x' });
    // A count that is always non-zero is a banner, not a signal — doctor prints the block only when
    // this is non-empty, so the empty case is the one that keeps the report readable.
    expect((await d.listOrphanThreadState(journal)).threadIds).toEqual([]);
  });
});

describe('doctorGhostRuns', () => {
  // A run row that no run ever wrote. `parseJournalKey` claims any key with a `:model:`/`:tool:`
  // SEGMENT, whatever namespace it started in, and every adapter derives its run index from that on
  // WRITE — so a thread named 'model' mints a row called 'mem', and the next sweep purges that
  // "run" by prefix. Measured elsewhere in this repo: two unrelated users, one sweep, nothing left.
  //
  // The poison is already in the index by the time anyone looks, which is why this reports instead
  // of repairing: the operator has to see whose data sits under the prefix first.
  const j = () => toJournal(new InMemoryStorage().runs) as any;

  it('names the phantom, and shows what a sweep would take with it', async () => {
    const journal = j();
    await journal.put('mem:alice:messages', [{ role: 'user', content: 'hi' }]);
    await journal.put('mem:bob:messages', [{ role: 'user', content: 'hi' }]);
    await journal.put('mem:model:working', 'the poison');

    const r = await doctorGhostRuns(journal);
    expect(r.ghosts.map((g) => g.runId)).toEqual(['mem']);
    // The list is the point: "mem is a ghost" tells an operator nothing they can act on, while
    // "these two users' threads are what disappears" does.
    expect(r.ghosts[0]!.wouldDelete).toContain('mem:alice:messages');
    expect(r.ghosts[0]!.wouldDelete).toContain('mem:bob:messages');
  });

  it('a run that died before its first model step is NOT a ghost', async () => {
    // THE FALSE POSITIVE THIS EXISTS TO AVOID. An upstream 401, a guard rejection, a limit tripped
    // at step 0 — the run wrote `:input` and nothing else, and it is a real run whose prompt is real
    // data. Reporting it would invite an operator to delete one.
    //
    // `:input` is the rule rather than a heuristic because run.ts writes it unconditionally before
    // the first model call, which is the same property runIdOfKey leans on.
    const journal = j();
    await journal.put('r-early:input', { _v: 2, prompt: 'never got a reply' });

    const r = await doctorGhostRuns(journal);
    expect(r.ghosts, 'an early-death run is a run').toEqual([]);
    expect(r.runsScanned).toBe(1);
  });

  it('CONTROL: a healthy journal reports nothing at all', async () => {
    // A detector that always finds something is a detector nobody reads.
    const journal = j();
    await journal.put('r1:input', { _v: 2, prompt: 'x' });
    await journal.put('r1:model:0', { _v: 2, text: 'hi' });

    const r = await doctorGhostRuns(journal);
    expect(r.ghosts).toEqual([]);
    expect(r.truncated).toBe(false);
  });

  it('stops at the cap and SAYS so — "we did not look further" is not "there is nothing"', async () => {
    const journal = j();
    for (let i = 0; i < 4; i++) await journal.put(`ns${i}:model:x`, { v: 1 });
    const r = await doctorGhostRuns(journal, 2);
    expect(r.runsScanned).toBe(2);
    expect(r.truncated).toBe(true);
  });
});
