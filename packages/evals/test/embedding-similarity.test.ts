// embeddingSimilarity: semantic (cosine) scorer — measures near-meaning instead of exact string match.
import { describe, it, expect } from 'vitest';
import { embeddingSimilarity } from '../src/scorer.js';

// Deterministic fake embedder: a bag-of-words vector over a small vocabulary → cosine works meaningfully.
const VOCAB = ['cat', 'dog', 'pet', 'animal', 'car', 'engine'];
const fakeEmbed = async (text: string): Promise<number[]> => {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  return VOCAB.map((v) => (words.includes(v) ? 1 : 0));
};

describe('@gnl/evals embeddingSimilarity', () => {
  it('overlapping meaning → high similarity (raw score)', async () => {
    const scorer = embeddingSimilarity(fakeEmbed);
    const r = await scorer.score({ output: 'cat pet animal', expected: 'dog pet animal' });
    // 2/3 shared dimensions → cosine = 2/3 ≈ 0.667
    expect(r.score).toBeGreaterThan(0.6);
    expect(r.score).toBeLessThan(0.7);
  });

  it('no shared words → similarity 0', async () => {
    const scorer = embeddingSimilarity(fakeEmbed);
    const r = await scorer.score({ output: 'cat dog', expected: 'car engine' });
    expect(r.score).toBe(0);
  });

  it('threshold → reduces to pass/fail (1/0)', async () => {
    const pass = embeddingSimilarity(fakeEmbed, { threshold: 0.5 });
    const fail = embeddingSimilarity(fakeEmbed, { threshold: 0.9 });
    const sample = { output: 'cat pet animal', expected: 'dog pet animal' };
    expect((await pass.score(sample)).score).toBe(1); // 0.667 ≥ 0.5
    expect((await fail.score(sample)).score).toBe(0); // 0.667 < 0.9
  });
});
