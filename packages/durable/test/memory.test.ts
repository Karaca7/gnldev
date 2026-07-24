// 8.1 Memory: journal-backed thread + working memory. Carries history across turns;
// durable + idempotent append (resume/retry doesn't double-write). Common memory-API parity + our correctness.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { BasicMemory } from '../src/memory.js';
import { runDurable } from '../src/run.js';
import { createMockModel } from './mock.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

// Model that reports the number of user messages in the conversation → proves memory carries history.
function echoUserCount() {
  return createMockModel(async ({ prompt }: any) => {
    const userMsgs = (prompt ?? []).filter((m: any) => m.role === 'user').length;
    return { content: [{ type: 'text', text: `user message: ${userMsgs}` }], finishReason: 'stop', usage, warnings: [] };
  });
}

describe('memory (8.1)', () => {
  it('same threadId across consecutive turns carries history', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);

    const r1 = await runDurable({ runId: 'r1', journal, memory, threadId: 'th1', model: echoUserCount(), prompt: 'hello' });
    expect(r1.text).toContain('1');

    const r2 = await runDurable({ runId: 'r2', journal, memory, threadId: 'th1', model: echoUserCount(), prompt: 'how are you' });
    expect(r2.text).toContain('2'); // history (1) + new (1) = 2 user messages

    const msgs = await memory.getMessages('th1');
    expect(msgs.length).toBeGreaterThanOrEqual(4); // 2 user + 2 assistant
  });

  it('threadId is stamped onto the run\'s input (:input) entry; if not given, the field is absent', async () => {
    // studio /runs reads this and groups runs by thread. Sits in the invisible `:input` entry.
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    await runDurable({ runId: 'rt', journal, memory, threadId: 'th-x', model: echoUserCount(), prompt: 'hi' });
    expect((await journal.get<{ threadId?: string }>('rt:input'))?.threadId).toBe('th-x');

    // run without threadId → field is not stamped (falls into the ungrouped bucket)
    await runDurable({ runId: 'rt2', journal, model: echoUserCount(), prompt: 'hi' });
    expect((await journal.get<{ threadId?: string }>('rt2:input'))?.threadId).toBeUndefined();
  });

  it('idempotent append: same runId again → memory doesn\'t double-write', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);

    await runDurable({ runId: 'dup', journal, memory, threadId: 'th2', model: echoUserCount(), prompt: 'x' });
    const n1 = (await memory.getMessages('th2')).length;
    await runDurable({ runId: 'dup', journal, memory, threadId: 'th2', model: echoUserCount(), prompt: 'x' });
    const n2 = (await memory.getMessages('th2')).length;

    expect(n2).toBe(n1); // no double-append thanks to the marker
  });

  it('working memory is injected into the system prompt', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    await memory.setWorkingMemory('th3', 'User name: Ada');

    let seenSystem = '';
    const model: any = {
      specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
      doStream: async () => { throw new Error('no'); },
      doGenerate: async ({ prompt }: any) => {
        seenSystem = (prompt ?? []).filter((m: any) => m.role === 'system').map((m: any) => m.content).join('\n');
        return { content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage, warnings: [] };
      },
    };

    await runDurable({ runId: 'wm1', journal, memory, threadId: 'th3', model, prompt: 'hi' });
    expect(seenSystem).toContain('Ada');
  });
});
