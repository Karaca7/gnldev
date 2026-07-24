// Sub-batch B — RAG reranking: llmReranker applies the index order; createRagTool rerank + rerankTopK.
import { describe, it, expect } from 'vitest';
import { llmReranker, createRagTool, InMemoryVectorStore, indexDocuments } from '../src/index.js';

function rerankModel(order: string): any {
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'r', supportedUrls: {},
    doGenerate: async () => ({ content: [{ type: 'text', text: order }], finishReason: 'stop', usage: {}, warnings: [] }),
    doStream: async () => { throw new Error('no'); },
  };
}

describe('@gnl/rag reranking', () => {
  it('llmReranker: applies the model index order (+ unmentioned ones go last) + topN', async () => {
    const matches = [
      { id: 'a', text: 'doc A', score: 0.5 },
      { id: 'b', text: 'doc B', score: 0.9 },
      { id: 'c', text: 'doc C', score: 0.7 },
    ];
    const rr = llmReranker({ model: rerankModel('2, 0, 1') });
    expect((await rr.rerank('q', matches)).map((m) => m.id)).toEqual(['c', 'a', 'b']);
    expect((await rr.rerank('q', matches, 2)).map((m) => m.id)).toEqual(['c', 'a']); // topN

    const partial = llmReranker({ model: rerankModel('1') }); // only 1 → the rest go last
    expect((await partial.rerank('q', matches)).map((m) => m.id)).toEqual(['b', 'a', 'c']);
  });

  it('createRagTool rerank + rerankTopK: vector results are reordered + trimmed', async () => {
    const store = new InMemoryVectorStore();
    const embed = async (t: string) => [t.includes('cat') ? 1 : 0, t.includes('dog') ? 1 : 0];
    await indexDocuments(store, embed, [{ id: '1', text: 'about cats' }, { id: '2', text: 'about dogs' }, { id: '3', text: 'cats and dogs' }]);
    const ragTool = createRagTool({ store, embed, topK: 3, rerank: llmReranker({ model: rerankModel('2,1,0') }), rerankTopK: 2 });
    const res = await ragTool.execute!({ query: 'cat' }, { toolCallId: 'x' } as any);
    expect(res).toHaveLength(2); // rerankTopK applied
  });
});
