// Observational memory cuts its window by count, not by turn — so the cut can land between a tool
// call and the result that answers it.
//
// The recall path was taught to keep those two together (`pairRecalledToolCalls`). This is the other
// half of the same invariant, and it was left open: `loadContext`'s OM branch never goes through
// `composeTrack1`, so it never reaches that step. What it builds instead is
//
//     [observations, ...messages with seq > observedSeq]
//
// and `observedSeq` is a high-water mark that compaction advances by message count or token budget.
// Nothing in that arithmetic knows what a turn is. Land it on the assistant message that made a call
// and the window opens with the answer to a call the model was never shown — the mirror image of the
// recall defect, rejected by providers for the same reason.
//
// The watermark is set directly here rather than driven through a real compaction: compaction's job is
// to choose a number, and this test is about what happens once it has chosen one. Any threshold that
// puts the cut inside a turn produces this state.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { AgentMemory } from '../src/index.js';

const user = (content: string) => ({ role: 'user', content });
const callsTool = (id: string) => ({
  role: 'assistant',
  content: [{ type: 'text', text: 'Looking that up.' }, { type: 'tool-call', toolCallId: id, toolName: 'lookup', input: {} }],
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

/** An observer that is never actually called — compaction is driven by the watermark below. */
const observerModel: any = {
  specificationVersion: 'v2', provider: 'mock', modelId: 'obs', supportedUrls: {},
  doGenerate: async () => ({ content: [{ type: 'text', text: 'OBS' }], finishReason: 'stop', usage: {}, warnings: [] }),
  doStream: async () => { throw new Error('no'); },
};

describe('observational memory and tool-call pairing', () => {
  it('never opens its window on a tool result whose call was cut away', async () => {
    const storage = new InMemoryStorage();
    const mem = new AgentMemory({
      storage,
      observationalMemory: { enabled: true, observerModel, observation: { messageThreshold: 1_000_000 } },
    });
    await storage.memory.upsertThread({ id: 't', resourceId: 'u', createdAt: 1, updatedAt: 1 });

    // seq 0 user | 1 assistant+call | 2 tool result | 3 assistant text
    await mem.append('t', [user('what is the aurora project?'), callsTool('tc-1'), answers('tc-1'), user('and then?')]);

    // Compaction stopped mid-turn: everything up to and including the CALL is observed, so the window
    // starts at the result. A threshold counted in messages has no reason not to land here.
    await storage.runs.put('om:t:observedSeq', 1);

    const ctx = await mem.loadContext('t', { resourceId: 'u' });
    const { called, answered } = toolIds(ctx.messages);
    // Every result shown must belong to a call shown alongside it. Anthropic and OpenAI both reject a
    // `tool_result` with no matching `tool_use`, so this fails the turn before a token is spent.
    expect(answered.filter((id) => !called.includes(id))).toEqual([]);
  });

  it('leaves a window that already starts on a turn boundary alone', async () => {
    const storage = new InMemoryStorage();
    const mem = new AgentMemory({
      storage,
      observationalMemory: { enabled: true, observerModel, observation: { messageThreshold: 1_000_000 } },
    });
    await storage.memory.upsertThread({ id: 't', resourceId: 'u', createdAt: 1, updatedAt: 1 });
    await mem.append('t', [user('first'), callsTool('tc-1'), answers('tc-1'), user('second')]);

    // Cut after the whole turn: nothing needs repairing, and nothing extra should be dragged in.
    await storage.runs.put('om:t:observedSeq', 2);

    const ctx = await mem.loadContext('t', { resourceId: 'u' });
    expect(ctx.messages.map((m: any) => m.role)).toEqual(['user']);
  });
});
