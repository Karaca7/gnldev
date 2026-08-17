// 7.2 — VectorStore deepening: metadata filter + delete + namespace + minScore + hybrid.
// InMemoryVectorStore fully covered (pg implements the same interface; hybrid not in pg — documented).
import { describe, it, expect } from 'vitest';
import { InMemoryVectorStore, keywordScore, tokenize, type VectorItem } from '../src/index.js';

// Simple 2D embeddings — so cosine direction can be checked.
const item = (id: string, emb: number[], extra?: Partial<VectorItem>): VectorItem => ({
  id, text: extra?.text ?? id, embedding: emb, metadata: extra?.metadata, namespace: extra?.namespace,
});

describe('7.2 keywordScore / tokenize (pure)', () => {
  it('tokenize splits on lowercase + alphanumeric', () => {
    expect(tokenize('Hello, World! 42')).toEqual(['hello', 'world', '42']);
  });
  it('keeps non-ASCII words whole, in any language', () => {
    // The old character class was ASCII plus the six Turkish letters, so every other language was cut
    // at its accents: 'Grüße' became ['gr', 'e'] and scored against fragments — silently, on any
    // non-English corpus.
    expect(tokenize('Grüße, München!')).toEqual(['grüße', 'münchen']);
    expect(tokenize('français mañana')).toEqual(['français', 'mañana']);
    expect(tokenize('Ölçüm yapıldı')).toEqual(['ölçüm', 'yapıldı']);
    expect(tokenize('日本語 テスト')).toEqual(['日本語', 'テスト']);
  });
  it('keywordScore therefore matches a non-ASCII term', () => {
    expect(keywordScore('münchen', 'reise nach münchen')).toBe(1);
  });
  it('keywordScore is the ratio of query terms matched', () => {
    expect(keywordScore('cat dog', 'cat and bird')).toBe(0.5); // 1/2 terms present
    expect(keywordScore('cat dog', 'cat dog fish')).toBe(1);
    expect(keywordScore('', 'everything')).toBe(0); // empty query → 0
  });
});

describe('7.2 InMemoryVectorStore', () => {
  it('metadata filter returns only matching records', async () => {
    const s = new InMemoryVectorStore();
    await s.upsert([
      item('a', [1, 0], { metadata: { lang: 'tr' } }),
      item('b', [1, 0], { metadata: { lang: 'en' } }),
    ]);
    const r = await s.query([1, 0], 10, { filter: { lang: 'tr' } });
    expect(r.map((m) => m.id)).toEqual(['a']);
  });

  it('namespace isolates', async () => {
    const s = new InMemoryVectorStore();
    await s.upsert([
      item('a', [1, 0], { namespace: 'kb1' }),
      item('b', [1, 0], { namespace: 'kb2' }),
    ]);
    expect((await s.query([1, 0], 10, { namespace: 'kb1' })).map((m) => m.id)).toEqual(['a']);
    expect((await s.query([1, 0], 10)).length).toBe(2); // all if ns not given
  });

  it('minScore filters out below threshold', async () => {
    const s = new InMemoryVectorStore();
    await s.upsert([
      item('near', [1, 0]),
      item('orthogonal', [0, 1]), // cosine 0 → should be filtered
    ]);
    const r = await s.query([1, 0], 10, { minScore: 0.5 });
    expect(r.map((m) => m.id)).toEqual(['near']);
  });

  it('hybrid: keyword blending changes ranking (vector tied, keyword breaks the tie)', async () => {
    const s = new InMemoryVectorStore();
    // Two records with the SAME embedding (vector score tied) → keyword should tie-break.
    await s.upsert([
      item('unrelated', [1, 0], { text: 'a completely different topic' }),
      item('related', [1, 0], { text: 'return policy and refund' }),
    ]);
    const r = await s.query([1, 0], 10, { text: 'return policy', keywordWeight: 0.5 });
    expect(r[0]!.id).toBe('related'); // keyword signal pushed it to the top
  });

  it('keywordWeight 0 (default) → pure vector, old behavior', async () => {
    const s = new InMemoryVectorStore();
    await s.upsert([item('a', [1, 0], { text: 'x' })]);
    const withText = await s.query([1, 0], 10, { text: 'text that never matches' });
    expect(withText[0]!.score).toBeCloseTo(1); // keyword ignored → pure cosine
  });

  it('delete: deletes by id / filter / namespace, empty where deletes nothing', async () => {
    const s = new InMemoryVectorStore();
    await s.upsert([
      item('a', [1, 0], { metadata: { t: 'x' }, namespace: 'n1' }),
      item('b', [1, 0], { metadata: { t: 'y' }, namespace: 'n1' }),
      item('c', [1, 0], { namespace: 'n2' }),
    ]);
    expect(await s.delete({})).toBe(0); // empty where → safe, deletes nothing
    expect(await s.delete({ ids: ['a'] })).toBe(1);
    expect(await s.delete({ namespace: 'n2' })).toBe(1);
    const left = await s.query([1, 0], 10);
    expect(left.map((m) => m.id)).toEqual(['b']);
  });

  it('backward compat: query(embedding, topK) without opts is identical to old behavior', async () => {
    const s = new InMemoryVectorStore();
    await s.upsert([item('a', [1, 0]), item('b', [0, 1])]);
    const r = await s.query([1, 0], 1);
    expect(r.length).toBe(1);
    expect(r[0]!.id).toBe('a');
  });
});
