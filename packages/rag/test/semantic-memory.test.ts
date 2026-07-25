// Phase 13A — SemanticMemory: given a query, recalls the relevant OLD message (even if outside recentN);
// without a query, only the last N. Embeddings live in the journal (durable).
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { SemanticMemory } from '../src/semantic-memory.js';

// Deterministic keyword embed: each dimension is the count of one keyword.
const DIMS = ['refund', 'shipping', 'weather', 'joke'];
const embed = async (text: string): Promise<number[]> => {
  const t = text.toLowerCase();
  return DIMS.map((k) => t.split(k).length - 1);
};

describe('@gnldev/rag SemanticMemory', () => {
  it('recall: query brings back the old-but-relevant message; without a query, only the last N', async () => {
    const journal = new InMemoryJournal();
    const mem = new SemanticMemory({ journal, embed, recentN: 2, topK: 1 });

    await mem.append('t1', [
      { role: 'user', content: 'I want a refund for my order' }, // 0 — relevant, OLD
      { role: 'assistant', content: 'our shipping is fast' }, // 1
      { role: 'user', content: 'what is the weather' }, // 2
      { role: 'assistant', content: 'tell me a joke then' }, // 3
      { role: 'user', content: 'haha nice joke' }, // 4 (recent)
      { role: 'assistant', content: 'glad you liked the joke' }, // 5 (recent)
    ]);

    // Without a query → only the last 2.
    const plain = await mem.getMessages('t1');
    expect(plain).toHaveLength(2);
    expect(JSON.stringify(plain)).not.toContain('refund');

    // 'refund' query → recalls the old refund message + last 2.
    const recalled = await mem.getMessages('t1', { query: 'how do I get a refund?' });
    expect(recalled).toHaveLength(3); // 1 recall + 2 recent
    expect(JSON.stringify(recalled[0])).toContain('refund'); // recall comes first (chronological)
    expect(JSON.stringify(recalled)).toContain('liked the joke'); // recent is preserved
  });

  // P1.5 (AUDIT-R2): messageRange + metadata filter, wired the same way MemoryStore.recall
  // honors them (filter BEFORE topK, then expand hits with before/after neighbors, dedup vs. `recent`).
  it('P1.5: messageRange expands the hit with its neighbors (older portion only, no dup with recent)', async () => {
    const journal = new InMemoryJournal();
    const mem = new SemanticMemory({ journal, embed, recentN: 2, topK: 1 });
    await mem.append('t1', [
      { role: 'user', content: 'filler zero' }, // 0
      { role: 'user', content: 'refund policy here' }, // 1 — hit
      { role: 'user', content: 'filler two' }, // 2
      { role: 'user', content: 'recent a' }, // 3 (recent)
      { role: 'user', content: 'recent b' }, // 4 (recent)
    ]);
    const noRange = await mem.getMessages('t1', { query: 'refund' });
    expect(JSON.stringify(noRange)).not.toContain('filler');

    const r = await mem.getMessages('t1', { query: 'refund', messageRange: 1 });
    expect(JSON.stringify(r)).toContain('filler zero');
    expect(JSON.stringify(r)).toContain('filler two');
    expect(JSON.stringify(r)).toContain('refund policy');
  });

  it('P1.5: metadata filter — filtered-out hit does not consume the topK slot', async () => {
    const journal = new InMemoryJournal();
    const mem = new SemanticMemory({ journal, embed, recentN: 1, topK: 1 });
    await mem.append('t1', [
      { role: 'user', content: 'refund only', metadata: { lang: 'en' } }, // strongest match, wrong lang
      { role: 'user', content: 'refund shipping combo', metadata: { lang: 'tr' } }, // weaker match, right lang
      { role: 'user', content: 'recent' },
    ]);
    const filtered = await mem.getMessages('t1', { query: 'refund', filter: { lang: 'tr' } });
    expect(JSON.stringify(filtered)).toContain('refund shipping combo');
    expect(JSON.stringify(filtered)).not.toContain('refund only');
  });

  it('P1.5: threshold filters out weak matches', async () => {
    const journal = new InMemoryJournal();
    const mem = new SemanticMemory({ journal, embed, recentN: 1, topK: 5 });
    await mem.append('t1', [
      { role: 'user', content: 'refund only' },
      { role: 'user', content: 'refund shipping combo' },
      { role: 'user', content: 'recent' },
    ]);
    const strict = await mem.getMessages('t1', { query: 'refund shipping', threshold: 0.99 });
    expect(JSON.stringify(strict)).toContain('refund shipping combo');
    expect(JSON.stringify(strict)).not.toContain('refund only');
  });

  it('embeddings persist in the journal (durable) + working memory delegation', async () => {
    const journal = new InMemoryJournal();
    const mem = new SemanticMemory({ journal, embed, recentN: 1, topK: 2 });
    await mem.append('t2', [{ role: 'user', content: 'refund please' }]);
    const log = await journal.get<any[]>('sem:t2:log');
    expect(log?.[0].embedding).toEqual([1, 0, 0, 0]); // embed lives in the journal
    await mem.setWorkingMemory('t2', 'VIP customer');
    expect(await mem.getWorkingMemory('t2')).toBe('VIP customer');
  });
});
