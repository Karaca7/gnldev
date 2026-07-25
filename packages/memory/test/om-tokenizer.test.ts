// Pluggable real tokenizer: the countTokens hook drives the compaction threshold (instead of the default char/4).
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { AgentMemory } from '../src/index.js';

function observerModel(counter: { calls: number }): any {
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'obs', supportedUrls: {},
    doGenerate: async () => (counter.calls++, { content: [{ type: 'text', text: 'OBS' }], finishReason: 'stop', usage: {}, warnings: [] }),
    doStream: async () => { throw new Error('no'); },
  };
}
const u = (c: string) => ({ role: 'user', content: c });

describe('OM pluggable countTokens', () => {
  it('a custom tokenizer drives the threshold (each message=100 tokens → 2 messages > 150 threshold)', async () => {
    const storage = new InMemoryStorage();
    const counter = { calls: 0 };
    const mem = new AgentMemory({
      storage,
      observationalMemory: { enabled: true, observerModel: observerModel(counter), observation: { tokenThreshold: 150 }, countTokens: () => 100 },
    });
    await mem.append('th', [u('a'), u('b'), u('c')]); // 3×100=300 > 150
    await mem.loadContext('th', {});
    expect(counter.calls).toBeGreaterThanOrEqual(1);
    expect((await storage.memory.getObservations('th')).length).toBeGreaterThanOrEqual(1);
  });

  it('countTokens=()=>0 → the threshold is never exceeded → no compaction', async () => {
    const storage = new InMemoryStorage();
    const counter = { calls: 0 };
    const mem = new AgentMemory({
      storage,
      observationalMemory: { enabled: true, observerModel: observerModel(counter), observation: { tokenThreshold: 10 }, countTokens: () => 0 },
    });
    for (let i = 0; i < 20; i++) await mem.append('th', [u('long message '.repeat(20))]);
    await mem.loadContext('th', {});
    expect(counter.calls).toBe(0);
  });
});
