import { describe, it, expect } from 'vitest';
import { InMemoryVectorStore, indexDocuments, createRagTool } from '../src/index.js';

// Deterministic fake embedder (no API key): vector based on word presence.
const embed = async (t: string) => [
  t.includes('cat') ? 1 : 0,
  t.includes('dog') ? 1 : 0,
  t.includes('car') ? 1 : 0,
];

describe('@gnldev/rag', () => {
  it('index + retrieve returns the most relevant document', async () => {
    const store = new InMemoryVectorStore();
    await indexDocuments(store, embed, [
      { id: '1', text: 'cat is a lovable animal' },
      { id: '2', text: 'dog is a loyal friend' },
      { id: '3', text: 'car goes fast' },
    ]);

    const t = createRagTool({ store, embed, topK: 1 });
    const res: any = await t.execute!({ query: 'information about cat' }, { toolCallId: 'x', messages: [] } as any);

    expect(res).toHaveLength(1);
    expect(res[0].text).toContain('cat');
  });
});
