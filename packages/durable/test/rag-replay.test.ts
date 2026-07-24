// Proof of "durability-infused parity": when RAG is given as a tool, durableTool journals it →
// embed+query are NOT called AGAIN on resume/replay (replayable/exactly-once RAG). Most RAG implementations don't have this.
import { describe, it, expect } from 'vitest';
import { stepCountIs } from 'ai';
import { InMemoryVectorStore, indexDocuments, createRagTool } from '../../rag/src/index.js';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

describe('replayable RAG (free with durableTool)', () => {
  it('2nd run with the same runId → embed/query is not called again', async () => {
    const journal = new InMemoryJournal();
    const store = new InMemoryVectorStore();
    let embedCalls = 0;
    const embed = async (t: string) => {
      embedCalls++;
      return [t.includes('cat') ? 1 : 0, 0, 0];
    };
    await indexDocuments(store, embed, [{ id: '1', text: 'cat meows' }]);
    const afterIndex = embedCalls;

    const ragTool = createRagTool({ store, embed, topK: 1 });
    const model = () =>
      createMockModel(async ({ prompt }: any) => {
        const done = countToolResults(prompt);
        if (done === 0) return toolCallResult('searchKnowledge', 'call-rag', { query: 'cat' });
        return finalTextResult('I found information about cats.');
      });

    const r1 = await runDurable({
      runId: 'rag1', journal, model: model(), tools: { searchKnowledge: ragTool },
      prompt: 'what is a cat', stopWhen: stepCountIs(6),
    });
    expect(r1.text).toContain('cat');
    const afterRun1 = embedCalls;
    expect(afterRun1).toBeGreaterThan(afterIndex); // RAG embed was called during run1

    const r2 = await runDurable({
      runId: 'rag1', journal, model: model(), tools: { searchKnowledge: ragTool },
      prompt: 'what is a cat', stopWhen: stepCountIs(6),
    });
    expect(r2.text).toContain('cat');
    expect(embedCalls).toBe(afterRun1); // DID NOT increase → RAG was replayed from the journal (exactly-once)
  });
});
