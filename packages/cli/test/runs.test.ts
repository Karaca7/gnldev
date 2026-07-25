// gnl runs: listRunsCore (pure) + runsCommand.run's --json output shape.
import { describe, it, expect } from 'vitest';
import * as Durable from '@gnldev/durable';
import { InMemoryJournal, runDurable } from '@gnldev/durable';
import { listRunsCore } from '../src/commands/runs.js';
import { mkModel, finalText, agentModel, captureLog } from './helpers.js';

async function seed(journal: InMemoryJournal) {
  await runDurable({ runId: 'run-a', journal, model: mkModel(async () => finalText('a done')), prompt: 'a' });
  await runDurable({
    runId: 'run-b',
    journal,
    model: agentModel('t', 'c1', {}, 'b done'),
    tools: { t: { execute: async () => ({ ok: true }) } },
    prompt: 'b',
  });
  // Suspended: a guard that always requires approval, never approved here.
  await runDurable({
    runId: 'run-c',
    journal,
    model: agentModel('t', 'c2', {}),
    tools: { t: { execute: async () => ({ ok: true }) } },
    guard: () => ({ action: 'require-approval' }),
    prompt: 'c',
  });
}

describe('listRunsCore', () => {
  it('lists newest-first, with status/steps/cost/threadId', async () => {
    const journal = new InMemoryJournal();
    await seed(journal);
    const rows = await listRunsCore({ journal } as any, Durable);
    expect(rows.map((r) => r.runId)).toEqual(['run-c', 'run-b', 'run-a']);
    expect(rows.find((r) => r.runId === 'run-c')!.status).toBe('suspended');
    expect(rows.find((r) => r.runId === 'run-a')!.status).toBe('completed');
    expect(rows.find((r) => r.runId === 'run-b')!.toolCalls).toBe(1);
  });

  it('--status filters, --limit caps', async () => {
    const journal = new InMemoryJournal();
    await seed(journal);
    const suspended = await listRunsCore({ journal } as any, Durable, { status: 'suspended' });
    expect(suspended.map((r) => r.runId)).toEqual(['run-c']);
    const limited = await listRunsCore({ journal } as any, Durable, { limit: 1 });
    expect(limited).toHaveLength(1);
  });

  it('empty journal -> empty list', async () => {
    const rows = await listRunsCore({ journal: new InMemoryJournal() } as any, Durable);
    expect(rows).toEqual([]);
  });
});

describe('runsCommand --json', () => {
  it('prints a JSON array matching listRunsCore', async () => {
    const journal = new InMemoryJournal();
    await seed(journal);
    // runsCommand.run() calls loadConfig(path); point --config at nothing usable is not testable here
    // without a real file, so we exercise listRunsCore -> JSON.stringify directly (the same code path
    // runsCommand.run takes right after loadConfig resolves) via captureLog on a hand-built shim.
    const lines = await captureLog(async () => {
      const rows = await listRunsCore({ journal } as any, Durable, { status: 'completed' });
      console.log(JSON.stringify(rows, null, 2));
    });
    const parsed = JSON.parse(lines.join('\n'));
    expect(parsed.every((r: any) => r.status === 'completed')).toBe(true);
  });
});
