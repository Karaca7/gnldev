// The first-encounter seed reconstructs a run's tool budget from its history. A shadow is a copy of a
// record whose authoritative key is NOT run-scoped, so counting it charges a run for work it did not
// do — and the run it charges is the one that DEDUPED, i.e. the one that executed nothing at all.
//
// These probes go at `seedFromHistory` through its real entry point (`checkToolGate`, which is what
// durable-tool.ts calls before a tool truly runs) with a hand-seeded history, so each case is exactly
// one record shape and the two directions can be separated:
//
//   * a shadow must NOT count      — the change under test;
//   * a NON-shadow must STILL count — the guard against an over-broad skip. `if (true) continue`
//     silently disables budget reconstruction for every run in the product, and a test that only
//     asserts the first direction stays green while it happens.
//
// The loop-detection chain is reconstructed by the same scan and is asserted for the same two
// directions, because it is the half a maxToolCalls-only test does not touch.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, runKeys } from '../src/index.js';
import { checkToolGate } from '../src/limits.js';

const ARGS_HASH = 'h-abc';
const XRUN_KEY = 'xrun:args-charge-h-abc';

/** One succeeded tool record under the run's own prefix. `mirrorOf` set ⇒ it is a shadow. */
async function seedToolRecord(
  journal: InMemoryJournal,
  runId: string,
  toolCallId: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await journal.put(runKeys.tool(runId, toolCallId), {
    status: 'succeeded',
    output: { charged: 100 },
    toolName: 'charge',
    argsHash: ARGS_HASH,
    resolvedToolCallIds: [toolCallId],
    ...extra,
  });
}

const gate = (journal: InMemoryJournal, runId: string, limits: object, toolName = 'charge', hash = ARGS_HASH) =>
  checkToolGate(journal as never, runId, toolName, hash, limits as never);

describe('maxToolCalls, seeded from a run whose history holds ONE record', () => {
  // The live rule only fires from `writeToolTerminal`. A cross-run dedup hit returns from the journal
  // without writing a terminal, so it increments nothing — but it does leave a shadow. Counting it
  // made the seed disagree with the live path, and the run died having executed zero tools.
  it('a shadow does not spend the budget', async () => {
    const journal = new InMemoryJournal();
    await seedToolRecord(journal, 'runB', 'call-B', { mirrorOf: XRUN_KEY });

    const breach = await gate(journal, 'runB', { maxToolCalls: 1 }, 'other', 'h-other');
    expect(breach, 'the run was charged for a call it never executed').toBeUndefined();
  });

  // The other direction, and the one that catches an over-broad skip.
  it('a real tool record still does', async () => {
    const journal = new InMemoryJournal();
    await seedToolRecord(journal, 'runA', 'call-A'); // no mirrorOf

    const breach = await gate(journal, 'runA', { maxToolCalls: 1 }, 'other', 'h-other');
    expect(breach?.kind, 'budget reconstruction is disabled — a resumed run gets its whole budget back')
      .toBe('maxToolCalls');
  });

  // A pre-mirror journal has no `mirrorOf` on anything. Its runs must be reconstructed exactly as
  // before, or this change is a silent budget grant to every existing deployment.
  it('a legacy record written before shadows existed still does', async () => {
    const journal = new InMemoryJournal();
    await journal.put(runKeys.tool('old', 'call-old'), { status: 'succeeded', output: { ok: true } });

    const breach = await gate(journal, 'old', { maxToolCalls: 1 }, 'other', 'h-other');
    expect(breach?.kind).toBe('maxToolCalls');
  });

  // The skip tests the VALUE, not the presence of the key: a record that merely mentions the field as
  // undefined is not a shadow. Pinned because `'mirrorOf' in v` reads as an equivalent rewrite and is
  // not one. (A `!!v?.mirrorOf` rewrite is NOT distinguished by this test and cannot be — an
  // authoritative key is never the empty string, so no realistic record separates the two.)
  it('a record carrying `mirrorOf: undefined` is not a shadow', async () => {
    const journal = new InMemoryJournal();
    await seedToolRecord(journal, 'runU', 'call-U', { mirrorOf: undefined });

    const breach = await gate(journal, 'runU', { maxToolCalls: 1 }, 'other', 'h-other');
    expect(breach?.kind).toBe('maxToolCalls');
  });

  // Mixed history: the real call is counted, the shadow is not. A skip that also dropped the real
  // record would leave the budget untouched and this test would fail.
  it('counts only the real record when both shapes are present', async () => {
    const journal = new InMemoryJournal();
    await seedToolRecord(journal, 'mix', 'call-real');
    await seedToolRecord(journal, 'mix', 'call-shadow', { mirrorOf: XRUN_KEY });

    expect(await gate(journal, 'mix', { maxToolCalls: 2 }, 'other', 'h-other'),
      'the shadow was counted — the run is one call short of its budget').toBeUndefined();

    const fresh = new InMemoryJournal();
    await seedToolRecord(fresh, 'mix2', 'call-real');
    await seedToolRecord(fresh, 'mix2', 'call-shadow', { mirrorOf: XRUN_KEY });
    expect((await gate(fresh, 'mix2', { maxToolCalls: 1 }, 'other', 'h-other'))?.kind,
      'the real call was skipped too').toBe('maxToolCalls');
  });
});

describe('loop detection, seeded from the same scan', () => {
  // The chain is rebuilt by the same loop over the same entries, so shadows feed it too. Three
  // shadows of one shared cross-run action look identical to three real repeats.
  it('shadows do not build a repeat chain', async () => {
    const journal = new InMemoryJournal();
    for (const id of ['s-1', 's-2', 's-3']) await seedToolRecord(journal, 'runB', id, { mirrorOf: XRUN_KEY });

    const breach = await gate(journal, 'runB', { loopDetection: { maxRepeats: 2 } });
    expect(breach, 'a run was accused of looping on a tool it never called').toBeUndefined();
  });

  it('real repeats still do', async () => {
    const journal = new InMemoryJournal();
    for (const id of ['r-1', 'r-2', 'r-3']) await seedToolRecord(journal, 'runA', id);

    const breach = await gate(journal, 'runA', { loopDetection: { maxRepeats: 2 } });
    expect(breach?.kind, 'loop detection no longer survives a state-key loss').toBe('loop');
  });
});
