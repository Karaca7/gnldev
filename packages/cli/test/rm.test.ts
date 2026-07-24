// gnl rm: purgeRunCore (pure delete) + rmCommand.run's confirmation gate (refuses without --yes
// when not interactive — the test runner's stdin/stdout are not a TTY, so this exercises that path).
import { describe, it, expect } from 'vitest';
import * as Durable from '@gnl/durable';
import { InMemoryJournal, runDurable } from '@gnl/durable';
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

  it('unknown runId -> not found (refuses to silently no-op)', async () => {
    await expect(purgeRunCore({ journal: new InMemoryJournal() } as any, Durable, 'ghost')).rejects.toThrow(/run not found/);
  });
});

describe('rmCommand.run', () => {
  it('refuses to delete without --yes when not running interactively (confirmation gate runs before loadConfig)', async () => {
    await expect(rmCommand.run({ argv: ['some-run-id'] })).rejects.toThrow(/refusing to delete.*without confirmation/);
  });
});
