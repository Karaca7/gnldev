// Track 2: deepMerge (null=delete) + updateWorkingMemory tool round-trip (journaled exactly-once) + system + readOnly.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { InMemoryStorage, runDurable } from '@gnl/durable';
import { AgentMemory, deepMerge } from '../src/index.js';

describe('Track 2 deepMerge', () => {
  it('merges recursively, null deletes, array is replaced', () => {
    expect(deepMerge({ a: 1, b: { c: 2, d: 3 } }, { b: { c: 9, d: null }, e: 5 })).toEqual({ a: 1, b: { c: 9 }, e: 5 });
    expect(deepMerge({ list: [1, 2] }, { list: [9] })).toEqual({ list: [9] });
  });
});

const schema = z.object({ name: z.string().optional(), tier: z.string().optional() });

function wmModel(captureSystem?: (s: string) => void): any {
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
    doGenerate: async ({ prompt }: any) => {
      if (captureSystem) {
        const sys = (prompt ?? []).filter((m: any) => m.role === 'system').map((m: any) => (typeof m.content === 'string' ? m.content : '')).join('\n');
        captureSystem(sys);
      }
      const done = (prompt ?? []).filter((m: any) => m.role === 'tool').length;
      const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
      if (done === 0) return { content: [{ type: 'tool-call', toolCallId: 'wm1', toolName: 'updateWorkingMemory', input: JSON.stringify({ name: 'Ada' }) }], finishReason: 'tool-calls', usage, warnings: [] };
      return { content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage, warnings: [] };
    },
    doStream: async () => { throw new Error('no'); },
  };
}

describe('Track 2 working memory tool', () => {
  it('the updateWorkingMemory tool round-trip writes WM; the next turn sees it in system', async () => {
    const storage = new InMemoryStorage();
    const mem = new AgentMemory({ storage, workingMemory: { schema } });
    await runDurable({ runId: 'r1', journal: storage.runs, model: wmModel(), memory: mem, threadId: 'th', prompt: 'save' });
    expect(await storage.memory.getWorkingMemory('th')).toEqual({ name: 'Ada' });

    let seenSystem = '';
    await runDurable({ runId: 'r2', journal: storage.runs, model: wmModel((s) => (seenSystem = s)), memory: mem, threadId: 'th', prompt: 'again' });
    expect(seenSystem).toContain('Ada');
    expect(seenSystem).toContain('working_memory');
  });

  it('resume: WM is not double-written (durableTool short-circuit)', async () => {
    const storage = new InMemoryStorage();
    const mem = new AgentMemory({ storage, workingMemory: { schema } });
    await runDurable({ runId: 'r', journal: storage.runs, model: wmModel(), memory: mem, threadId: 'th', prompt: 'save' });
    expect(await storage.memory.getWorkingMemory('th')).toEqual({ name: 'Ada' });
    await runDurable({ runId: 'r', journal: storage.runs, model: wmModel(), memory: mem, threadId: 'th', prompt: 'save' });
    expect(await storage.memory.getWorkingMemory('th')).toEqual({ name: 'Ada' });
  });

  it('readOnly: the tool is not registered but WM is injected into system', async () => {
    const storage = new InMemoryStorage();
    const mem = new AgentMemory({ storage, workingMemory: { schema, readOnly: true } });
    await mem.applyWorkingMemoryUpdate('th', { name: 'Eve' });
    const ctx = await mem.loadContext('th', {});
    expect(ctx.tools).toBeUndefined();
    expect(ctx.system).toContain('Eve');
  });
});

// P2-memory (AUDIT-R2): per-scopeId mutex around applyWorkingMemoryUpdate's read-merge-write.
describe('Track 2 working memory mutex', () => {
  it('two concurrent updates to the SAME scope both land (merged, no lost update)', async () => {
    const storage = new InMemoryStorage();
    const mem = new AgentMemory({ storage, workingMemory: { schema } });
    // Without the lock this races: both read {} before either writes → one update is lost.
    await Promise.all([
      mem.applyWorkingMemoryUpdate('th', { name: 'Ada' }),
      mem.applyWorkingMemoryUpdate('th', { tier: 'gold' }),
    ]);
    expect(await storage.memory.getWorkingMemory('th')).toEqual({ name: 'Ada', tier: 'gold' });
  });

  it('sequential updates still apply in order (unchanged behavior)', async () => {
    const storage = new InMemoryStorage();
    const mem = new AgentMemory({ storage, workingMemory: { schema } });
    await mem.applyWorkingMemoryUpdate('th', { name: 'Ada' });
    await mem.applyWorkingMemoryUpdate('th', { tier: 'gold' });
    expect(await storage.memory.getWorkingMemory('th')).toEqual({ name: 'Ada', tier: 'gold' });
  });

  it('different scopeIds do not serialize each other', async () => {
    const storage = new InMemoryStorage();
    const mem = new AgentMemory({ storage, workingMemory: { schema } });
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((r) => (releaseSlow = r));
    const origGet = storage.memory.getWorkingMemory.bind(storage.memory);
    (storage.memory as any).getWorkingMemory = async (scopeId: string) => {
      if (scopeId === 'slow') await slowGate;
      return origGet(scopeId);
    };

    const slowPromise = mem.applyWorkingMemoryUpdate('slow', { name: 'Slow' });
    let fastDone = false;
    const fastPromise = mem.applyWorkingMemoryUpdate('fast', { name: 'Fast' }).then(() => { fastDone = true; });

    // 'fast' must finish WITHOUT waiting on 'slow' — if scopes shared one global lock this would hang
    // until releaseSlow() is called below, and the test would time out.
    await fastPromise;
    expect(fastDone).toBe(true);

    releaseSlow();
    await slowPromise;
    expect(await storage.memory.getWorkingMemory('fast')).toEqual({ name: 'Fast' });
    expect(await storage.memory.getWorkingMemory('slow')).toEqual({ name: 'Slow' });
  });
});
