// Paket #4 — the execution axis, measured at the three places that used to MINT a runId by pasting
// text onto another one: fork, rollover and replay. Each of them was written when a runId was just a
// string, so each of them produced a target that `run1_` now refuses (or, worse, would have been
// accepted with the wall clock baked into an identity — §11's explicit ban). This file is the matrix:
// derived source vs raw source, for all three, plus the round-trip of every `#` suffix and the purge
// boundary the suffix creates.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, runKeys, runIdOfKey, parseJournalKey } from '../src/journal.js';
import { assertRunIdSafe } from '../src/run.js';
import { derivedRunId, executionRunId, forkRunId, parseDerivedRunId, isDerivedRunId } from '../src/hash.js';
import { forkRun } from '../src/time-travel.js';
import { rolloverRun } from '../src/rollover.js';
import { replayRun } from '../src/regression.js';
import { purgeRun } from '../src/retention.js';
import { runDurable } from '../src/run.js';
import { createBatch } from '../src/batch.js';
import { writeXid } from '../src/xid.js';
import { createMockModel, finalTextResult } from './mock.js';

const DERIVED = derivedRunId('assistant', 'resource', 'u-1', 'invoice-4471');

/** One tiny finished run under `runId`, so fork/rollover/replay have something to read. */
async function tinyRun(journal: InMemoryJournal, runId: string, text = 'ok') {
  return runDurable({
    runId,
    journal,
    model: createMockModel(async () => finalTextResult(text)),
    prompt: 'hello',
  } as any);
}

describe('paket #4 — fork keeps a derived id inside the namespace', () => {
  it('MEASURED: the old default target (`<src>:fork:<Date.now()>`) is refused for a derived source', () => {
    // Not a hypothetical — this is the exact string time-travel.ts used to build.
    expect(() => assertRunIdSafe(`${DERIVED}:fork:${Date.now()}`)).toThrow(/reserved for engine-derived ids/);
    // …and for a RAW source it was, and stays, perfectly legal.
    expect(() => assertRunIdSafe(`order-1:fork:${Date.now()}`)).not.toThrow();
  });

  it('derived source → `#fork-1`, and the fork is a usable runId', async () => {
    const journal = new InMemoryJournal();
    await tinyRun(journal, DERIVED);
    const f = await forkRun(journal, DERIVED, 1);
    expect(f.newRunId).toBe(`${DERIVED}#fork-1`);
    expect(() => assertRunIdSafe(f.newRunId)).not.toThrow();
    expect(parseDerivedRunId(f.newRunId)).toEqual({ digest: DERIVED.slice('run1_'.length), fork: 1 });
    // the copy really landed under the new id
    expect(await journal.get(runKeys.input(f.newRunId))).toBeDefined();
  });

  it('the fork counter is DETERMINISTIC, not a clock: the second fork of the same run is `#fork-2`', async () => {
    const journal = new InMemoryJournal();
    await tinyRun(journal, DERIVED);
    const a = await forkRun(journal, DERIVED, 1);
    const b = await forkRun(journal, DERIVED, 1);
    expect(a.newRunId).toBe(`${DERIVED}#fork-1`);
    expect(b.newRunId).toBe(`${DERIVED}#fork-2`);
  });

  it('a fork of a fork counts from the BASE, so the axis never chains (`#fork-1#fork-1` is unspellable)', async () => {
    const journal = new InMemoryJournal();
    await tinyRun(journal, DERIVED);
    const a = await forkRun(journal, DERIVED, 1);
    const b = await forkRun(journal, a.newRunId, 1);
    expect(b.newRunId).toBe(`${DERIVED}#fork-2`);
    expect(b.newRunId).not.toContain('#fork-1#');
  });

  it('an execution-axis source (`#2`) forks off ITS OWN base and stays legal', async () => {
    const journal = new InMemoryJournal();
    const second = executionRunId(DERIVED, 2);
    await tinyRun(journal, second);
    const f = await forkRun(journal, second, 1);
    expect(f.newRunId).toBe(`${DERIVED}#fork-1`);
    expect(() => assertRunIdSafe(f.newRunId)).not.toThrow();
  });

  it('RAW source keeps today\'s `:fork:<ts>` spelling, byte for byte', async () => {
    const journal = new InMemoryJournal();
    await tinyRun(journal, 'order-1');
    const f = await forkRun(journal, 'order-1', 1);
    expect(f.newRunId).toMatch(/^order-1:fork:\d+$/);
  });

  it('an explicit newRunId is still honoured on both sides', async () => {
    const journal = new InMemoryJournal();
    await tinyRun(journal, DERIVED);
    const f = await forkRun(journal, DERIVED, 1, 'my-fork');
    expect(f.newRunId).toBe('my-fork');
  });
});

describe('paket #4 — rollover hands the period over on the execution axis', () => {
  it('derived source → `#2`, `#3`; raw source keeps `@N`', async () => {
    const journal = new InMemoryJournal();
    await tinyRun(journal, DERIVED);
    const r1 = await rolloverRun(journal, DERIVED);
    expect(r1.newRunId).toBe(`${DERIVED}#2`);
    expect(() => assertRunIdSafe(r1.newRunId)).not.toThrow();

    const r2 = await rolloverRun(journal, r1.newRunId);
    expect(r2.newRunId).toBe(`${DERIVED}#3`);

    const jr = new InMemoryJournal();
    await tinyRun(jr, 'agent');
    expect((await rolloverRun(jr, 'agent')).newRunId).toBe('agent@2');
  });

  it('the handover carries workKey + workScope into the new period\'s seed', async () => {
    const journal = new InMemoryJournal();
    await runDurable({
      runId: DERIVED,
      journal,
      model: createMockModel(async () => finalTextResult('p1')),
      prompt: 'hello',
      resourceId: 'u-1',
      workKey: 'invoice-4471',
      workScope: { kind: 'resource', value: 'u-1' },
    } as any);
    const r = await rolloverRun(journal, DERIVED);
    const seed = await journal.get<{ workKey?: string; workScope?: unknown; resourceId?: string }>(runKeys.input(r.newRunId));
    expect(seed?.workKey).toBe('invoice-4471');
    expect(seed?.workScope).toEqual({ kind: 'resource', value: 'u-1' });
    expect(seed?.resourceId).toBe('u-1'); // the identity carry that P2 already added stays
  });
});

describe('paket #4 — replay drops the wall clock', () => {
  it('derived source → `#replay-<seq>`; raw source → `:replay:<seq>` with NO timestamp', async () => {
    const journal = new InMemoryJournal();
    await tinyRun(journal, DERIVED);
    const rep = await replayRun({
      journal,
      runId: DERIVED,
      model: createMockModel(async () => finalTextResult('again')),
    } as any);
    expect(rep.newRunId).toMatch(new RegExp(`^${DERIVED}#replay-\\d+$`));
    expect(() => assertRunIdSafe(rep.newRunId)).not.toThrow();

    const jr = new InMemoryJournal();
    await tinyRun(jr, 'order-1');
    const rep2 = await replayRun({
      journal: jr,
      runId: 'order-1',
      model: createMockModel(async () => finalTextResult('again')),
    } as any);
    expect(rep2.newRunId).toMatch(/^order-1:replay:\d+$/);
    // the ban this test exists for: no millisecond clock inside an identity
    expect(rep2.newRunId).not.toMatch(/1[6-9]\d{11}/);
  });

  it('a derived replay of a replay counts off the BASE (one suffix, never a chain)', async () => {
    const journal = new InMemoryJournal();
    await tinyRun(journal, DERIVED);
    const a = await replayRun({ journal, runId: DERIVED, model: createMockModel(async () => finalTextResult('a')) } as any);
    const b = await replayRun({ journal, runId: a.newRunId, model: createMockModel(async () => finalTextResult('b')) } as any);
    expect(isDerivedRunId(b.newRunId)).toBe(true);
    expect(b.newRunId.match(/#/g)).toHaveLength(1);
  });
});

describe('paket #4 — the `#` suffixes round-trip', () => {
  it('every suffix the engine can mint parses back to exactly what minted it', () => {
    const digest = DERIVED.slice('run1_'.length);
    expect(parseDerivedRunId(DERIVED)).toEqual({ digest });
    expect(parseDerivedRunId(executionRunId(DERIVED, 7))).toEqual({ digest, execution: 7 });
    expect(parseDerivedRunId(forkRunId(DERIVED, 3))).toEqual({ digest, fork: 3 });
    expect(parseDerivedRunId(`${DERIVED}#replay-0`)).toEqual({ digest, replaySeq: 0 });
  });

  it('the spellings the axis forbids stay forbidden', () => {
    for (const bad of [`${DERIVED}#fork-0`, `${DERIVED}#fork-`, `${DERIVED}#fork-1#fork-2`, `${DERIVED}#1`, `${DERIVED}#fork-01`]) {
      expect(parseDerivedRunId(bad), bad).toBeUndefined();
      expect(() => assertRunIdSafe(bad), bad).toThrow();
    }
  });

  it('forkRunId refuses a chain and a raw base, the same way executionRunId does', () => {
    expect(() => forkRunId(`${DERIVED}#2`, 1)).toThrow(/execution axis/);
    expect(() => forkRunId('order-1', 1)).toThrow(/run1_ namespace/);
    expect(() => forkRunId(DERIVED, 0)).toThrow(/≥ 1/);
  });

  it('journal keys of a `#` id parse back to the `#` id — the suffix is part of the RUN, not of the record', () => {
    const second = executionRunId(DERIVED, 2);
    const forked = forkRunId(DERIVED, 1);
    expect(parseJournalKey(runKeys.model(second, 0))).toEqual({ runId: second, kind: 'model' });
    expect(parseJournalKey(runKeys.tool(second, 'c1'))).toEqual({ runId: second, kind: 'tool' });
    // `:input` needs the format stamp to corroborate the key (see runIdOfKey) — the `#` is what is
    // under test here, not the corroboration rule.
    expect(runIdOfKey(runKeys.input(second), { _v: 1 })).toBe(second);
    expect(runIdOfKey(runKeys.input(forked), { _v: 1 })).toBe(forked);
    // and a `#` id shows up in the run index like any other run
    expect(runIdOfKey(runKeys.model(forked, 0))).toBe(forked);
  });
});

describe('paket #4 — the runId-text readers that deliberately STAY', () => {
  // `batch:<id>:<item>` is an engine composite (§7's exception row), so batch.ts's self-filter keeps
  // reading a runId as text. What is pinned here is that the exception is CLOSED: a derived id can
  // never satisfy that prefix, so a cross-channel warning written by a run1_ run is still reported
  // (a false positive here is silent — the operator simply never sees the warning).
  it('the batch self-filter is not fooled by a derived runId in the XID', async () => {
    const journal = new InMemoryJournal();
    const tool = {
      description: 'pay',
      sideEffect: true,
      recover: async () => ({ done: false as const }),
      semanticIdentity: { keys: ['ref'], amountFields: ['amount'] },
      effectClass: 'transactional' as const,
      execute: async () => ({ paid: true }),
    };
    const batch = createBatch(journal, {
      tool, toolName: 'pay', itemKey: (i: unknown) => (i as { ref: string }).ref, resourceId: 'acct-1',
    } as never);

    // The same work already happened elsewhere, under a DERIVED runId.
    await writeXid(
      journal,
      { resourceId: 'acct-1', toolName: 'pay', identity: { ref: 'f-7' }, amounts: { amount: 70 }, channel: 'chat' },
      `${DERIVED}#2`,
      'tc-chat',
    );
    const p = await batch.preflight('b-1', [{ ref: 'F-7', amount: 70 }] as never);
    expect(p.xidHits.map((r) => r.itemKey)).toEqual(['F-7']); // reported, NOT self-filtered away

    // …and the filter it DOES exist for still fires: another item of this same batch.
    await writeXid(
      journal,
      { resourceId: 'acct-1', toolName: 'pay', identity: { ref: 'f-8' }, amounts: { amount: 80 } },
      'batch:b-1:F-0',
      'item:F-0',
    );
    const p2 = await batch.preflight('b-1', [{ ref: 'F-8', amount: 80 }] as never);
    expect(p2.xidHits).toHaveLength(0);
  });
});

describe('paket #4 — `#2` is a DIFFERENT run, and purge must treat it as one', () => {
  it('purging the base leaves the second execution alone, and vice versa', async () => {
    const journal = new InMemoryJournal();
    const second = executionRunId(DERIVED, 2);
    await tinyRun(journal, DERIVED, 'first');
    await tinyRun(journal, second, 'second');

    await purgeRun(journal, DERIVED);
    expect(await journal.get(runKeys.input(DERIVED))).toBeUndefined();
    expect(await journal.get(runKeys.input(second))).toBeDefined(); // NOT swept along

    await purgeRun(journal, second);
    expect(await journal.get(runKeys.input(second))).toBeUndefined();
  });

  it('and the same holds for a fork suffix', async () => {
    const journal = new InMemoryJournal();
    await tinyRun(journal, DERIVED);
    const f = await forkRun(journal, DERIVED, 1);
    await purgeRun(journal, f.newRunId);
    expect(await journal.get(runKeys.input(f.newRunId))).toBeUndefined();
    expect(await journal.get(runKeys.input(DERIVED))).toBeDefined();
  });
});
