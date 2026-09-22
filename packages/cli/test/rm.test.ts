// gnl rm: purgeRunCore (pure delete) + rmCommand.run's confirmation gate (refuses without --yes
// when not interactive — the test runner's stdin/stdout are not a TTY, so this exercises that path).
import { describe, it, expect } from 'vitest';
import * as Durable from '@gnldev/durable';
import { InMemoryJournal, runDurable } from '@gnldev/durable';
import { purgeRunCore, rmCommand } from '../src/commands/rm.js';
import { agentModel } from './helpers.js';

describe('purgeRunCore', () => {
  it('deletes a run and returns the number of deleted entries', async () => {
    const journal = new InMemoryJournal();
    await runDurable({ runId: 'r1', journal, model: agentModel('t', 'c1', {}, 'done'), tools: { t: { execute: async () => ({}) } }, prompt: 'p' });
    const before = await journal.readRun('r1');
    expect(before.length).toBeGreaterThan(0);

    const deleted = await purgeRunCore({ journal } as any, Durable, 'r1');
    expect(deleted).toBeGreaterThan(0);
    expect((await journal.readRun('r1')).length).toBe(0);
  });

  it('a row that no run wrote is REFUSED — and the neighbours it would have taken survive', async () => {
    // The index can hold a row for something that never ran: `parseJournalKey` claims any key with
    // a `:model:`/`:tool:` SEGMENT, so a thread named `model` gives `mem:model:working`, which reads
    // as a run called `mem`. It then LISTS as an ordinary run — `completed, 1 model step` — and this
    // command deletes by PREFIX, which here is every thread in the journal.
    //
    // The old `readRun(id).length === 0` check cannot catch it: readRun DOES return that record,
    // so the ghost walked straight through the only gate this command had. Measured before the
    // guard: `purgeRunCore(..., 'mem')` deleted three keys and two unrelated users' threads with
    // them.
    const journal = new InMemoryJournal();
    await journal.put('mem:alice:messages', [{ role: 'user', content: 'ALICE' }]);
    await journal.put('mem:bob:messages', [{ role: 'user', content: 'BOB' }]);
    await journal.put('mem:model:working', 'the poison');

    expect((await journal.readRun('mem')).length, 'the old gate passes it').toBeGreaterThan(0);
    await expect(purgeRunCore({ journal } as any, Durable, 'mem')).rejects.toThrow(/no run ever wrote/);

    expect(await journal.get('mem:alice:messages')).toEqual([{ role: 'user', content: 'ALICE' }]);
    expect(await journal.get('mem:bob:messages')).toEqual([{ role: 'user', content: 'BOB' }]);
  });

  it('CONTROL: a run that died before its first model step is still deletable', async () => {
    // The guard reads `:input`, which run.ts writes before the first model call — so a run that
    // never got one is a real run with real data and must stay removable. A gate that refuses those
    // would leave an operator unable to clean up exactly the runs most worth cleaning up.
    const journal = new InMemoryJournal();
    await journal.put('r-early:input', { _v: 2, prompt: 'never got a reply' });
    await journal.put('r-early:model:0', { _v: 2, content: [] });

    expect(await purgeRunCore({ journal } as any, Durable, 'r-early')).toBeGreaterThan(0);
    expect(await journal.get('r-early:input')).toBeUndefined();
  });

  it('unknown runId -> not found (refuses to silently no-op)', async () => {
    await expect(purgeRunCore({ journal: new InMemoryJournal() } as any, Durable, 'ghost')).rejects.toThrow(/run not found/);
  });
});

describe('rmCommand.run', () => {
  it('refuses to delete without --yes when not running interactively (confirmation gate runs before loadConfig)', async () => {
    await expect(rmCommand.run({ argv: ['some-run-id'] })).rejects.toThrow(/refusing to delete.*without confirmation/);
  });
});
