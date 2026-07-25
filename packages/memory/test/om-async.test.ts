// OM async-buffering: loadContext defers compaction to @gnldev/queue (no LLM on the read path);
// the Observer runs once a worker calls memory.compact().
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { enqueue, createWorker } from '@gnldev/queue';
import { AgentMemory } from '../src/index.js';

const u = (content: string) => ({ role: 'user', content });
function observerModel(counter: { calls: number }): any {
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'obs', supportedUrls: {},
    doGenerate: async () => (counter.calls++, { content: [{ type: 'text', text: 'OBS' }], finishReason: 'stop', usage: {}, warnings: [] }),
    doStream: async () => { throw new Error('no'); },
  };
}

describe('OM async-buffering (@gnldev/queue)', () => {
  it('compaction is taken off the read path → the worker does it', async () => {
    const storage = new InMemoryStorage();
    const counter = { calls: 0 };
    const mem = new AgentMemory({
      storage,
      observationalMemory: {
        enabled: true,
        buffering: true,
        observerModel: observerModel(counter),
        observation: { messageThreshold: 3 },
        onCompact: (tid) => void enqueue(storage.work, 'om-compact', { threadId: tid }),
      },
    });
    for (let i = 0; i < 8; i++) await mem.append('th', [u(`m${i}`)]);

    // loadContext: compaction DEFERRED → Observer was not called, the job was enqueued.
    await mem.loadContext('th', {});
    expect(counter.calls).toBe(0);

    // worker: drain the queue → memory.compact runs.
    const worker = createWorker(storage, { 'om-compact': async (p: any) => mem.compact(p.threadId) });
    await worker.drain();
    expect(counter.calls).toBeGreaterThanOrEqual(1);
    expect((await storage.memory.getObservations('th')).length).toBeGreaterThanOrEqual(1);
  });
});
