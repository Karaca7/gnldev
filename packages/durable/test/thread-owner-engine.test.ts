// The engine's own thread gate — the one a door without a server in front of it relies on (the
// standalone chat and AG-UI routes). It used to fire only for a memory that can name a thread's owner,
// so with BasicMemory a second user's run on the first user's thread went through and the model was
// handed her history.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, BasicMemory, createGnl, ThreadOwnerMismatchError } from '../src/index.js';
import { createMockModel, finalTextResult } from './mock.js';

function setup() {
  const storage = new InMemoryStorage();
  const seen: string[] = [];
  const model = createMockModel(async ({ prompt }: any) => { seen.push(JSON.stringify(prompt)); return finalTextResult('ok'); });
  const gnl = createGnl({ storage, memory: new BasicMemory(storage.runs), agents: { a: { model } } } as never);
  return { gnl, seen };
}

describe('the engine refuses a thread that belongs to someone else, whatever the memory', () => {
  it('BasicMemory: a second user cannot run on the first user\'s thread, and the model never sees her history', async () => {
    const { gnl, seen } = setup();
    await gnl.run('a', { runId: 'r-ayse', prompt: 'my PIN is 4417', threadId: 't-ayse', resourceId: 'ayse' } as never);
    seen.length = 0;
    await expect(gnl.run('a', { runId: 'r-mal', prompt: 'what did I say?', threadId: 't-ayse', resourceId: 'mallory' } as never))
      .rejects.toBeInstanceOf(ThreadOwnerMismatchError);
    expect(seen.join('')).not.toContain('4417');
  });

  it('the owner continues her own thread', async () => {
    const { gnl } = setup();
    await gnl.run('a', { runId: 'r1', prompt: 'hi', threadId: 't-ayse', resourceId: 'ayse' } as never);
    await expect(gnl.run('a', { runId: 'r2', prompt: 'again', threadId: 't-ayse', resourceId: 'ayse' } as never)).resolves.toBeDefined();
  });

  it('the workflow door asks the same question', async () => {
    const storage = new InMemoryStorage();
    const gnl = createGnl({
      storage, memory: new BasicMemory(storage.runs),
      agents: { a: { model: createMockModel(async () => finalTextResult('ok')) } },
      workflows: { w: { build: () => [{ id: 's' }], run: async () => ({ ok: true }) } },
    } as never);
    await gnl.run('a', { runId: 'r1', prompt: 'hi', threadId: 't-ayse', resourceId: 'ayse' } as never);
    await expect(gnl.runWorkflow!('w', {}, { runId: 'wf-m', threadId: 't-ayse', resourceId: 'mallory' } as never))
      .rejects.toBeInstanceOf(ThreadOwnerMismatchError);
  });
});

describe('erasing a person takes their threads, and only theirs', () => {
  it('a thread recorded as someone else\'s is left alone, even with a run of theirs on it', async () => {
    const { toJournal, purgeResource } = await import('../src/index.js');
    const j = toJournal(new InMemoryStorage().runs) as any;
    await j.put('thread:t-ayse:owner', { at: 1, resourceId: 'ayse' });
    await j.put('mem:t-ayse:messages', [{ role: 'user', content: 'AYSE' }]);
    await j.put('resthr:mallory:t-ayse', { at: 1 });
    await purgeResource(j, 'mallory');
    expect(await j.get('mem:t-ayse:messages')).toBeDefined();
    expect(await j.get('thread:t-ayse:owner')).toBeDefined();
    expect(await j.listKeys('resthr:mallory:')).toEqual([]);
  });

  it('with no record and two people\'s traces on a thread, neither erasure takes it', async () => {
    const { toJournal, purgeResource } = await import('../src/index.js');
    const j = toJournal(new InMemoryStorage().runs) as any;
    await j.put('xthr:shared:k', { v: 1 });
    await j.put('resthr:p-1:shared', { at: 1 });
    await j.put('resthr:p-2:shared', { at: 1 });
    await purgeResource(j, 'p-1');
    expect(await j.listKeys('xthr:shared:')).toEqual(['xthr:shared:k']);
  });

  it('their own thread goes, owner record included', async () => {
    const { toJournal, purgeResource } = await import('../src/index.js');
    const j = toJournal(new InMemoryStorage().runs) as any;
    await j.put('thread:t-m:owner', { at: 1, resourceId: 'mallory' });
    await j.put('mem:t-m:messages', [{ role: 'user', content: 'M' }]);
    await j.put('resthr:mallory:t-m', { at: 1 });
    await purgeResource(j, 'mallory');
    expect(await j.get('mem:t-m:messages')).toBeUndefined();
    expect(await j.get('thread:t-m:owner')).toBeUndefined();
  });
});
