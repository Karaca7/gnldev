// Track 1 rich recall: messageRange + threshold + metadata filter + resource scope + freeze.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, runDurable } from '@gnldev/durable';
import { AgentMemory } from '../src/index.js';

const DIMS = ['refund', 'shipping', 'weather', 'joke'];
const embed = async (text: string): Promise<number[]> => {
  const t = text.toLowerCase();
  return DIMS.map((k) => t.split(k).length - 1);
};
const u = (content: string, metadata?: any) => ({ role: 'user', content, ...(metadata ? { metadata } : {}) });

describe('Track 1 rich recall', () => {
  it('messageRange: returns the hit + its neighbors', async () => {
    const storage = new InMemoryStorage();
    const mem = new AgentMemory({ storage, embed, recentN: 2, recall: { topK: 1 } });
    await mem.append('t', [u('refund policy here'), u('filler one'), u('filler two'), u('shipping details'), u('recent a'), u('recent b')]);

    const noRange = await mem.getMessages('t', { query: 'refund' });
    expect(JSON.stringify(noRange)).not.toContain('filler one');

    const withRange = new AgentMemory({ storage, embed, recentN: 2, recall: { topK: 1, messageRange: 1 } });
    const r = await withRange.getMessages('t', { query: 'refund' });
    expect(JSON.stringify(r)).toContain('refund policy');
    expect(JSON.stringify(r)).toContain('filler one');
  });

  it('threshold: filters out weak matches', async () => {
    const storage = new InMemoryStorage();
    const memLow = new AgentMemory({ storage, embed, recentN: 1, recall: { topK: 5, threshold: 0 } });
    await memLow.append('t', [u('refund only'), u('refund shipping combo'), u('filler'), u('recent')]);
    const all = await memLow.getMessages('t', { query: 'refund shipping' });
    expect(JSON.stringify(all)).toContain('refund only');

    const strict = new AgentMemory({ storage, embed, recentN: 1, recall: { topK: 5, threshold: 0.99 } });
    const few = await strict.getMessages('t', { query: 'refund shipping' });
    expect(JSON.stringify(few)).toContain('refund shipping combo');
    expect(JSON.stringify(few)).not.toContain('refund only');
  });

  it('metadata filter: only matching metadata gets recalled', async () => {
    const mem = new AgentMemory({ storage: new InMemoryStorage(), embed, recentN: 1, recall: { topK: 5, filter: { lang: 'tr' } } });
    await mem.append('t', [u('refund turkce', { lang: 'tr' }), u('refund english', { lang: 'en' }), u('filler'), u('recent')]);
    const r = await mem.getMessages('t', { query: 'refund' });
    expect(JSON.stringify(r)).toContain('refund turkce');
    expect(JSON.stringify(r)).not.toContain('refund english');
  });

  // P1.5 (AUDIT-R2): operator filters ($in/$gt) flow end-to-end (AgentMemory → store.recall →
  // shared matchFilter), not just the pre-existing bare-value $eq sugar.
  it('metadata filter operators ($in/$gt) flow end-to-end through AgentMemory', async () => {
    const mem = new AgentMemory({ storage: new InMemoryStorage(), embed, recentN: 1, recall: { topK: 5, filter: { tier: { $in: [1, 3] } } } });
    await mem.append('t', [
      u('refund one', { tier: 1 }),
      u('refund two', { tier: 2 }),
      u('refund three', { tier: 3 }),
      u('recent'),
    ]);
    const r = await mem.getMessages('t', { query: 'refund' });
    expect(JSON.stringify(r)).toContain('refund one');
    expect(JSON.stringify(r)).toContain('refund three');
    expect(JSON.stringify(r)).not.toContain('refund two');

    const gtMem = new AgentMemory({ storage: new InMemoryStorage(), embed, recentN: 1, recall: { topK: 5, filter: { priority: { $gt: 4 } } } });
    await gtMem.append('t', [
      u('refund low', { priority: 1 }),
      u('refund high', { priority: 9 }),
      u('recent'),
    ]);
    const r2 = await gtMem.getMessages('t', { query: 'refund' });
    expect(JSON.stringify(r2)).toContain('refund high');
    expect(JSON.stringify(r2)).not.toContain('refund low');
  });

  it('resource scope: cross-thread recalls another thread\'s message', async () => {
    const mem = new AgentMemory({ storage: new InMemoryStorage(), embed, recentN: 2 });
    await mem.createThread({ id: 't1', resourceId: 'u1' });
    await mem.createThread({ id: 't2', resourceId: 'u1' });
    await mem.append('t1', [u('weather chat'), u('joke time'), u('another joke')]);
    await mem.append('t2', [u('refund policy in t2')]);

    const thread = await mem.getMessages('t1', { query: 'refund', scope: 'thread' });
    expect(JSON.stringify(thread)).not.toContain('refund policy in t2');

    const resource = await mem.getMessages('t1', { query: 'refund', scope: 'resource', resourceId: 'u1' });
    expect(JSON.stringify(resource)).toContain('refund policy in t2');
  });

  it('freeze: recall freezes into runDurable :input (resume replay)', async () => {
    const storage = new InMemoryStorage();
    const mem = new AgentMemory({ storage, embed, recentN: 1, recall: { topK: 1 } });
    await mem.append('th', [u('refund policy old'), u('filler'), u('filler2')]);
    const model = () => ({
      specificationVersion: 'v2' as const, provider: 'mock', modelId: 'm', supportedUrls: {},
      doGenerate: async () => ({ content: [{ type: 'text', text: 'ok' }], finishReason: 'stop' as const, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] }),
      doStream: async () => { throw new Error('no'); },
    });
    await runDurable({ runId: 'r', journal: storage.runs, model: model(), memory: mem, threadId: 'th', prompt: 'about refund' });
    const input1 = await storage.runs.get<any>('r:input');
    await runDurable({ runId: 'r', journal: storage.runs, model: model(), memory: mem, threadId: 'th', prompt: 'about refund' });
    const input2 = await storage.runs.get<any>('r:input');
    expect(input2).toEqual(input1);
  });
});
