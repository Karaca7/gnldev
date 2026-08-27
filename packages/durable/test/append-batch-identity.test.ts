// A retry after a stale append marker must not write the turn a second time.
//
// The marker in run.ts is two writes to two stores: the messages go to the memory port, the "done"
// flag to the journal, and a process that dies between them leaves the flag unset. The next retry
// then finds a stale claim, takes it over, and appends everything again — measured through the full
// run path at 25 stored messages becoming 50, with the same `toolCallId` present twice. The AI SDK
// passes that through; Anthropic and OpenAI reject a duplicate `tool_use` id, so the thread is broken
// from then on. The old code called this "the safer side" against losing history, which it is, but
// safer is not harmless.
//
// A store that can write the batch identity in the SAME transaction as the rows removes the window
// rather than narrowing it: "appended but not marked" stops being a reachable state. That is what
// `appendMessagesOnce` is, and these tests pin both halves of it — the duplicate is refused, and a
// batch that genuinely never landed is still written.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '../src/index.js';
import { runDurable } from '../src/run.js';
import { runKeys } from '../src/journal.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { AgentMemory } from '../../memory/src/index.js';

const rows = (threadId: string, texts: string[]) =>
  texts.map((t) => ({ threadId, role: 'user', text: t, ts: 1, message: { role: 'user', content: t } }));

describe('appendMessagesOnce — batch identity beside the messages', () => {
  it('refuses a batch whose key already landed, and writes nothing', async () => {
    const s = new InMemoryStorage();
    await s.memory.upsertThread({ id: 't', resourceId: 'u', createdAt: 1, updatedAt: 1 });

    expect(await s.memory.appendMessagesOnce!('t', rows('t', ['q', 'a']), 'r1:produced')).toBe(true);
    // Same key again: this is the retry after a stale marker. It must not add a second copy.
    expect(await s.memory.appendMessagesOnce!('t', rows('t', ['q', 'a']), 'r1:produced')).toBe(false);

    const stored = (await s.memory.getMessages('t', { limit: 100 })).items;
    expect(stored.map((m) => m.text)).toEqual(['q', 'a']);
  });

  it('keeps different batches of the same run apart', async () => {
    const s = new InMemoryStorage();
    await s.memory.upsertThread({ id: 't', resourceId: 'u', createdAt: 1, updatedAt: 1 });
    // One turn is two batches — the question written before the model, the answer after.
    expect(await s.memory.appendMessagesOnce!('t', rows('t', ['q']), 'r1:incoming')).toBe(true);
    expect(await s.memory.appendMessagesOnce!('t', rows('t', ['a']), 'r1:produced')).toBe(true);
    expect((await s.memory.getMessages('t', { limit: 100 })).items.map((m) => m.text)).toEqual(['q', 'a']);
  });

  it('lets a thread that was deleted accept the same key again', async () => {
    const s = new InMemoryStorage();
    await s.memory.upsertThread({ id: 't', resourceId: 'u', createdAt: 1, updatedAt: 1 });
    await s.memory.appendMessagesOnce!('t', rows('t', ['q']), 'r1:incoming');
    await s.memory.deleteThread('t');

    // The thread comes back — `deleteThread` is a soft delete on the thread and a hard one on its
    // messages, and `upsertThread` can revive the id. A marker left behind would answer this
    // legitimate batch with "already applied" and drop it in silence.
    await s.memory.upsertThread({ id: 't', resourceId: 'u', createdAt: 1, updatedAt: 2 });
    expect(await s.memory.appendMessagesOnce!('t', rows('t', ['q']), 'r1:incoming')).toBe(true);
    expect((await s.memory.getMessages('t', { limit: 100 })).items.map((m) => m.text)).toEqual(['q']);
  });

  it('lets a truncated turn be regenerated under its own key', async () => {
    const s = new InMemoryStorage();
    await s.memory.upsertThread({ id: 't', resourceId: 'u', createdAt: 1, updatedAt: 1 });
    await s.memory.appendMessagesOnce!('t', rows('t', ['q']), 'turn-1');
    await s.memory.appendMessagesOnce!('t', rows('t', ['a']), 'turn-2');

    // Edit & resend: everything after the question is cut. The marker for the cut batch has to go with
    // it, or regenerating that turn is refused as a duplicate — measured at 1 message written where 3
    // were expected.
    await s.memory.deleteMessagesAfter!('t', 0);
    expect(await s.memory.appendMessagesOnce!('t', rows('t', ['a2']), 'turn-2')).toBe(true);
    expect((await s.memory.getMessages('t', { limit: 100 })).items.map((m) => m.text)).toEqual(['q', 'a2']);
  });
});

// The defect itself, through the real run path rather than through the port.
//
// The stale marker is written directly because that is the state a crash leaves: the messages landed,
// the "done" flag did not, and the TTL has since expired. What happens next is the whole question.

const replyModel: any = {
  specificationVersion: 'v4', provider: 'm', modelId: 'm', supportedUrls: {},
  doGenerate: async () => ({
    content: [{ type: 'text', text: 'reply' }], finishReason: { unified: 'stop', raw: 'stop' },
    usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } }, warnings: [],
  }),
  doStream: async () => { throw new Error('not used'); },
};

async function turnThenStaleRetry(withIdentity: boolean): Promise<{ first: number; second: number }> {
  const st = new SqliteStorage(':memory:');
  const mem = new AgentMemory({ storage: st as never });
  // Removing the method is how a store without batch identity behaves — a third-party adapter, or
  // any of ours before this existed.
  if (!withIdentity) delete (Object.getPrototypeOf(mem) as { appendOnce?: unknown }).appendOnce;
  await st.memory.upsertThread({ id: 'th', resourceId: 'u', createdAt: 1, updatedAt: 1 });

  await runDurable({ runId: 'r1', journal: st.runs, memory: mem as never, threadId: 'th', model: replyModel, prompt: 'hello' });
  const first = (await st.memory.getMessages('th', { limit: 999 })).items.length;

  for (const k of [runKeys.memUserAppended('r1'), runKeys.memAppended('r1')]) {
    await st.runs.put(k, { status: 'pending', startedAt: Date.now() - 61_000 });
  }
  await runDurable({ runId: 'r1', journal: st.runs, memory: mem as never, threadId: 'th', model: replyModel, prompt: 'hello' });
  return { first, second: (await st.memory.getMessages('th', { limit: 999 })).items.length };
}

describe('a retry after a stale append marker', () => {
  it('does not repeat the turn when the store carries batch identity', async () => {
    const { first, second } = await turnThenStaleRetry(true);
    expect(second).toBe(first);
  });

  it('still repeats it without one — which is why the identity exists', async () => {
    // Pinned deliberately. If this ever stops duplicating, the fallback path changed and the claim
    // above ("the identity is what closes the window") needs re-checking rather than trusting.
    const { first, second } = await turnThenStaleRetry(false);
    expect(second).toBe(first * 2);
  });
});
