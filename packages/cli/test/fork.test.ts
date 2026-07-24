// gnl fork: forkRunCore (pure) — copies a run's prefix into a new, live-continuable runId.
import { describe, it, expect } from 'vitest';
import * as Durable from '@gnl/durable';
import { InMemoryJournal, runDurable } from '@gnl/durable';
import { forkRunCore } from '../src/commands/fork.js';
import { agentModel } from './helpers.js';

async function seedTwoStepRun(journal: InMemoryJournal, runId: string): Promise<void> {
  await runDurable({
    runId,
    journal,
    model: agentModel('t', 'c1', { x: 1 }, 'final answer'),
    tools: { t: { execute: async () => ({ ok: true }) } },
    prompt: 'go',
  });
}

describe('forkRunCore', () => {
  it('produces a new runId with the same content, and does not mutate the source', async () => {
    const journal = new InMemoryJournal();
    await seedTwoStepRun(journal, 'src-1');
    const before = await journal.readRun('src-1');

    const result = await forkRunCore({ journal } as any, Durable, 'src-1', { to: 'src-1-fork' });
    expect(result.newRunId).toBe('src-1-fork');
    expect(result.copiedModel).toBeGreaterThan(0);

    const after = await journal.readRun('src-1');
    expect(after).toEqual(before); // source untouched

    const forked = await journal.readRun('src-1-fork');
    expect(forked.length).toBeGreaterThan(0);
  });

  it('auto-generates a runId if --to is not given', async () => {
    const journal = new InMemoryJournal();
    await seedTwoStepRun(journal, 'src-2');
    const result = await forkRunCore({ journal } as any, Durable, 'src-2');
    expect(result.newRunId).not.toBe('src-2');
    expect(result.newRunId).toContain('src-2');
  });

  it('rejects an out-of-range --step', async () => {
    const journal = new InMemoryJournal();
    await seedTwoStepRun(journal, 'src-3');
    await expect(forkRunCore({ journal } as any, Durable, 'src-3', { step: 999 })).rejects.toThrow(/out of range/);
  });

  it('unknown runId -> not found', async () => {
    await expect(forkRunCore({ journal: new InMemoryJournal() } as any, Durable, 'ghost')).rejects.toThrow(/run not found/);
  });
});
