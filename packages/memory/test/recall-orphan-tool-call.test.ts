// Recall can put a tool call into the prompt without the result that answers it.
//
// This needs no concurrency and no crash — one thread, one caller, one turn at a time. It is the same
// provider-level failure the concurrent-append defect produced (`MissingToolResultsError`, surfaced as
// `HTTP 400 "Tool result is missing for tool call …"`), reached from a completely different direction.
//
// Why it can happen at all: `composeTrack1` builds the prompt as
//
//     [...recalled, ...recent]
//
// and nothing checks that a recalled `tool-call` came with its `tool-result`. Recall selects by
// embedding similarity, one message at a time, and messages are only candidates if they have text to
// embed (`AgentMemory.append`: `text && this.embed ? await this.embed(text) : undefined`).
//
// That last detail decides who is exposed. A `tool` message carries only a `tool-result` part, so
// `messageText` returns undefined, so it never has an embedding and can never be recalled — measured
// on a real corpus: 541 of 541 tool messages had no text. An assistant message that carries ONLY a
// tool call is in the same position. But an assistant message carrying TEXT AND a tool call — "Let me
// look that up" followed by the call, which is what real providers emit constantly — does have text,
// does get an embedding, and can be recalled entirely on its own. Its answer cannot follow it.
//
// The load harness never produced this because its mock model emits either a tool call or text, never
// both. That is a property of the fixture, not of the product.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { AgentMemory } from '../src/index.js';

/** Two dimensions, so similarity is decided by one keyword and the test stays deterministic. */
const embed = async (text: string): Promise<number[]> =>
  (/aurora/i.test(text) ? [1, 0] : [0, 1]);

const user = (content: string) => ({ role: 'user', content });
/** What a real provider emits: a sentence AND the call, in one message. */
const speaksAndCalls = (id: string, text: string) => ({
  role: 'assistant',
  content: [{ type: 'text', text }, { type: 'tool-call', toolCallId: id, toolName: 'lookup', input: {} }],
});
const answers = (id: string) => ({
  role: 'tool',
  content: [{ type: 'tool-result', toolCallId: id, toolName: 'lookup', output: { type: 'json', value: { ok: true } } }],
});

function toolIds(messages: any[]): { called: string[]; answered: string[] } {
  const called: string[] = [], answered: string[] = [];
  for (const m of messages) {
    for (const part of Array.isArray(m?.content) ? m.content : []) {
      if (part?.type === 'tool-call') called.push(part.toolCallId);
      if (part?.type === 'tool-result') answered.push(part.toolCallId);
    }
  }
  return { called, answered };
}

describe('recall and tool-call/result pairing', () => {
  it('never hands the model a recalled tool call without its result', async () => {
    const storage = new InMemoryStorage();
    // recentN 4: small enough that the interesting pair falls out of the window and only recall can
    // bring it back. `topK: 1` keeps the selection unambiguous.
    const mem = new AgentMemory({ storage, embed, recentN: 4, recall: { topK: 1, threshold: 0, scope: 'thread' } });
    await storage.memory.upsertThread({ id: 't', resourceId: 'u', createdAt: 1, updatedAt: 1 });

    // The turn worth remembering, then enough ordinary traffic to push it out of the recent window.
    await mem.append('t', [
      // The keyword lives ONLY on the assistant message, so recall elects that one unambiguously.
      // With it on the user turn too the two tie on similarity and the user message wins the slot,
      // which is how the first version of this test passed while the defect was sitting right there.
      user('what is that thing called?'),
      speaksAndCalls('tc-1', 'Let me look up the aurora project.'),
      answers('tc-1'),
      user('thanks'),
    ]);
    for (let i = 0; i < 40; i++) await mem.append('t', [user(`unrelated ${i}`)]);

    // A query about the same subject: recall reaches back for the assistant message that mentions it.
    const messages = await mem.getMessages('t', { query: 'tell me about aurora again' });

    // 40 filler turns, so the pair sits far from both ends of the thread: a repair that only looked
    // at the thread's first few messages would find nothing here and silently fall back to dropping.
    const { called, answered } = toolIds(messages);
    expect(called).toEqual(['tc-1']);   // the memory is kept, not thrown away
    // Every call the model is shown must be answered in the same prompt. An unanswered one is refused
    // by the AI SDK before the request is even sent, so the turn fails and the next one fails the same
    // way as long as recall keeps electing that message.
    expect([...called].sort()).toEqual([...answered].sort());
  });
});

describe('recall pairing: what it leaves out, and whether it says so', () => {
  const build = async () => {
    const storage = new InMemoryStorage();
    const mem = new AgentMemory({ storage, embed, recentN: 4, recall: { topK: 3, threshold: 0, scope: 'thread' } });
    await storage.memory.upsertThread({ id: 't', resourceId: 'u', createdAt: 1, updatedAt: 1 });
    return { storage, mem };
  };

  it('drops a call whose result was never written, and reports the drop', async () => {
    const { storage, mem } = await build();
    // The result never lands — the shape a crash between a call and its answer leaves behind.
    await mem.append('t', [user('what is that?'), speaksAndCalls('tc-1', 'Looking up the aurora project.')]);
    for (let i = 0; i < 6; i++) await mem.append('t', [user(`unrelated ${i}`)]);

    const ctx = await mem.loadContext('t', { query: 'aurora again', resourceId: 'u' });
    expect(toolIds(ctx.messages).called).toEqual([]);          // nothing unanswered reached the model
    // ...and the omission is visible. Before this, a drop was indistinguishable from recall finding
    // nothing at all, which is what a user experiences as "the model forgets sometimes".
    expect(ctx.provenance?.droppedCount).toBe(1);
    expect(ctx.provenance?.dropped?.[0]?.reason).toBe('unanswered-tool-call');
    expect(ctx.provenance?.recalled.some((r) => r.seq === 1)).toBe(false);
  });

  it('marks a repaired row so it is not read as a similarity hit', async () => {
    const { storage, mem } = await build();
    await mem.append('t', [user('what is that?'), speaksAndCalls('tc-1', 'Looking up the aurora project.'), answers('tc-1')]);
    for (let i = 0; i < 6; i++) await mem.append('t', [user(`unrelated ${i}`)]);

    const ctx = await mem.loadContext('t', { query: 'aurora again', resourceId: 'u' });
    const repaired = ctx.provenance?.recalled.filter((r) => r.origin === 'repair') ?? [];
    expect(repaired.length).toBe(1);
    expect(repaired[0].role).toBe('tool');
    // The hit itself stays unmarked: it was chosen, not pulled along.
    expect(ctx.provenance?.recalled.find((r) => r.role === 'assistant')?.origin).toBeUndefined();
  });

  it('never puts the same toolCallId in the prompt twice', async () => {
    const { storage, mem } = await build();
    // The shape a stale-marker retry leaves (F7): the same turn appended twice, at different seq. The
    // `${threadId}:${seq}` dedupe cannot see it, so recall can elect BOTH copies.
    const turn = [user('what is that?'), speaksAndCalls('tc-1', 'Looking up the aurora project.'), answers('tc-1')];
    await mem.append('t', turn);
    await mem.append('t', turn);
    for (let i = 0; i < 6; i++) await mem.append('t', [user(`unrelated ${i}`)]);

    const ctx = await mem.loadContext('t', { query: 'aurora again', resourceId: 'u' });
    const { called, answered } = toolIds(ctx.messages);
    expect(called).toEqual(['tc-1']);        // one call, not two
    expect(answered).toEqual(['tc-1']);      // one answer, not two
    expect(ctx.provenance?.dropped?.some((r) => r.reason === 'duplicate-tool-call-id')).toBe(true);
  });
});
