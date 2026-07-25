// gnl inspect: inspectRunCore (pure) — the CLI view of time-travel (reconstructState at step N).
import { describe, it, expect } from 'vitest';
import * as Durable from '@gnldev/durable';
import { InMemoryJournal, runDurable } from '@gnldev/durable';
import { inspectRunCore } from '../src/commands/inspect.js';
import { agentModel } from './helpers.js';

async function seedTwoStepRun(journal: InMemoryJournal): Promise<void> {
  await runDurable({
    runId: 'ts-1',
    journal,
    model: agentModel('t', 'c1', { x: 1 }, 'final answer'),
    tools: { t: { execute: async () => ({ ok: true }) } },
    prompt: 'go',
  });
}

describe('inspectRunCore', () => {
  it('step 0 shows just the seed (empty materialized state — nothing journaled yet)', async () => {
    const journal = new InMemoryJournal();
    await seedTwoStepRun(journal);
    const { state, max } = await inspectRunCore({ journal } as any, Durable, 'ts-1', 0);
    expect(state.step).toBe(0);
    expect(state.messages).toEqual([]);
    expect(max).toBeGreaterThan(0);
  });

  it('step == max shows the full materialized state (final text present)', async () => {
    const journal = new InMemoryJournal();
    await seedTwoStepRun(journal);
    const entries = await journal.readRun('ts-1');
    const atMax = await inspectRunCore({ journal } as any, Durable, 'ts-1', entries.length);
    expect(atMax.max).toBe(entries.length);
    const hasFinal = atMax.state.messages.some((m: any) => m.content?.some?.((p: any) => p.type === 'text' && p.text === 'final answer'));
    expect(hasFinal).toBe(true);
  });

  it('rejects an out-of-range step', async () => {
    const journal = new InMemoryJournal();
    await seedTwoStepRun(journal);
    await expect(inspectRunCore({ journal } as any, Durable, 'ts-1', 999)).rejects.toThrow(/out of range/);
    await expect(inspectRunCore({ journal } as any, Durable, 'ts-1', -1)).rejects.toThrow(/out of range/);
  });

  it('unknown runId -> not found', async () => {
    await expect(inspectRunCore({ journal: new InMemoryJournal() } as any, Durable, 'ghost', 0)).rejects.toThrow(/run not found/);
  });
});
