import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '../src/in-memory-storage.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import type { RunJournal } from '../src/storage.js';

async function seed(j: RunJournal): Promise<void> {
  // run "order-1": 2 model steps + 1 successful tool
  await j.put('order-1:model:0', { content: [], finishReason: 'tool-calls' });
  await j.put('order-1:tool:call-a', { status: 'succeeded', output: { ok: true } });
  await j.put('order-1:model:1', { content: [], finishReason: 'stop' });
  // run "chat:t0" (runId contains a COLON): 1 model + 1 suspended tool
  await j.put('chat:t0:model:0', { content: [] });
  await j.put('chat:t0:tool:call-b', { status: 'suspended', output: {} });
}

describe.each([
  ['InMemoryStorage', () => new InMemoryStorage().runs],
  ['SqliteStorage', () => new SqliteStorage(':memory:').runs],
])('RunJournal reader — %s', (_name, make) => {
  it('listRuns + readRun (parses correctly even when runId contains a colon)', async () => {
    const j = make();
    await seed(j);

    const runs = (await j.listRuns()).items;
    const byId = Object.fromEntries(runs.map((r) => [r.runId, r]));
    expect(Object.keys(byId).sort()).toEqual(['chat:t0', 'order-1']);
    expect(byId['order-1']).toMatchObject({ status: 'completed', modelSteps: 2, toolCalls: 1 });
    expect(byId['chat:t0']).toMatchObject({ status: 'suspended', modelSteps: 1, toolCalls: 1 });

    const entries = await j.readRun('chat:t0');
    expect(entries.map((e) => e.kind)).toEqual(['model', 'tool']);
    expect(entries.every((e) => e.runId === 'chat:t0')).toBe(true);
  });
});
