// OM deep-dive (token threshold + token-tier model + public compact) + MessageList.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '@gnl/durable';
import { AgentMemory, ModelByTokens, approxTokens, MessageList } from '../src/index.js';

function observerModel(tag: string, counter: { calls: number }): any {
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: tag, supportedUrls: {},
    doGenerate: async () => (counter.calls++, { content: [{ type: 'text', text: `OBS-${tag}` }], finishReason: 'stop', usage: {}, warnings: [] }),
    doStream: async () => { throw new Error('no'); },
  };
}
const u = (content: string) => ({ role: 'user', content });

describe('OM token threshold + token-tier', () => {
  it('token-based compaction via tokenThreshold', async () => {
    const storage = new InMemoryStorage();
    const counter = { calls: 0 };
    const mem = new AgentMemory({ storage, observationalMemory: { enabled: true, observerModel: observerModel('x', counter), observation: { tokenThreshold: 20 } } });
    for (let i = 0; i < 8; i++) await mem.append('th', [u('a'.repeat(20))]); // each message ~5 tokens → 8×5=40 > 20
    await mem.loadContext('th', {});
    expect(counter.calls).toBeGreaterThanOrEqual(1);
    expect((await storage.memory.getObservations('th')).length).toBeGreaterThanOrEqual(1);
  });

  it('ModelByTokens: selects a model based on block size (token-tier)', () => {
    const cheap = { id: 'cheap' };
    const strong = { id: 'strong' };
    const tier = new ModelByTokens({ 100: cheap, 100000: strong });
    expect(tier.resolve(50)).toBe(cheap);
    expect(tier.resolve(5000)).toBe(strong);
    expect(approxTokens('a'.repeat(40))).toBe(10);
  });

  it('public compact(): callable from a worker job', async () => {
    const storage = new InMemoryStorage();
    const counter = { calls: 0 };
    const mem = new AgentMemory({ storage, observationalMemory: { enabled: true, observerModel: observerModel('x', counter), observation: { messageThreshold: 3 } } });
    for (let i = 0; i < 8; i++) await mem.append('th', [u(`m${i}`)]);
    await mem.compact('th');
    expect(counter.calls).toBeGreaterThanOrEqual(1);
  });
});

describe('MessageList', () => {
  it('source tag + dedup + clean output', () => {
    const ml = new MessageList();
    ml.add([{ role: 'user', content: 'hi', id: '1' }], 'memory');
    ml.add([{ role: 'user', content: 'hi', id: '1' }], 'input');
    ml.add({ role: 'assistant', content: 'yo' }, 'response');
    expect(ml.get()).toHaveLength(2);
    expect(ml.bySource('memory')).toHaveLength(1);
    expect(ml.bySource('response')).toHaveLength(1);
    expect(ml.toModelMessages()[0]).not.toHaveProperty('__source');
  });
});
