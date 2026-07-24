// P1.3 (AUDIT-R2) — 4 free, deterministic, model-free text scorers. Each is checked for the
// standard shape: identical ≈ 1, disjoint ≈ 0, partial strictly in between, and determinism across
// repeated calls on the same sample.
import { describe, it, expect } from 'vitest';
import { contentSimilarity, keywordCoverage, textualDifference, answerSimilarity } from '../src/index.js';

describe('@gnl/evals contentSimilarity (Dice bigram)', () => {
  it('identical strings → 1', () => {
    const r: any = contentSimilarity().score({ output: 'the quick brown fox', expected: 'the quick brown fox' });
    expect(r.score).toBe(1);
  });

  it('completely disjoint content (no shared bigrams) → 0', () => {
    const r: any = contentSimilarity().score({ output: 'ab', expected: 'zq' });
    expect(r.score).toBe(0);
  });

  it('partially overlapping content → strictly between 0 and 1', () => {
    const r: any = contentSimilarity().score({ output: 'the quick brown fox', expected: 'the slow brown ox' });
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThan(1);
  });

  it('deterministic across repeated calls', () => {
    const scorer = contentSimilarity();
    const sample = { output: 'hello world', expected: 'hello there world' };
    const r1: any = scorer.score(sample);
    const r2: any = scorer.score(sample);
    expect(r1.score).toBe(r2.score);
  });
});

describe('@gnl/evals keywordCoverage', () => {
  it('all expected keywords present → 1', () => {
    const r: any = keywordCoverage().score({ output: 'Paris is the capital of France', expected: 'Paris capital France' });
    expect(r.score).toBe(1);
  });

  it('none of the expected keywords present → 0', () => {
    const r: any = keywordCoverage().score({ output: 'totally unrelated sentence here', expected: 'Paris capital France' });
    expect(r.score).toBe(0);
  });

  it('partial keyword coverage → strictly between 0 and 1, reason lists missing', () => {
    const r: any = keywordCoverage().score({ output: 'Paris is nice', expected: 'Paris capital France' });
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThan(1);
    expect(r.reason).toContain('missing');
  });

  it('opts.keywords overrides sample.expected-derived keywords', () => {
    const r: any = keywordCoverage({ keywords: ['foo', 'bar'] }).score({ output: 'foo baz', expected: 'irrelevant text' });
    expect(r.score).toBe(0.5);
  });

  it('no keywords available (no opts.keywords, no expected) → 0 with a clear reason, not vacuous 1', () => {
    const r: any = keywordCoverage().score({ output: 'anything' });
    expect(r.score).toBe(0);
    expect(r.reason).toContain('no keywords');
  });

  it('deterministic across repeated calls', () => {
    const scorer = keywordCoverage();
    const sample = { output: 'Paris is nice', expected: 'Paris capital France' };
    expect((scorer.score(sample) as any).score).toBe((scorer.score(sample) as any).score);
  });
});

describe('@gnl/evals textualDifference (1 - normalized Levenshtein)', () => {
  it('identical strings → 1', () => {
    const r: any = textualDifference().score({ output: 'hello world', expected: 'hello world' });
    expect(r.score).toBe(1);
  });

  it('both empty → 1', () => {
    const r: any = textualDifference().score({ output: '', expected: '' });
    expect(r.score).toBe(1);
  });

  it('maximally different same-length strings → 0', () => {
    const r: any = textualDifference().score({ output: 'aaaa', expected: 'zzzz' });
    expect(r.score).toBe(0);
  });

  it('partial edit distance → strictly between 0 and 1', () => {
    const r: any = textualDifference().score({ output: 'hello world', expected: 'hallo world' });
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThan(1);
  });

  it('deterministic across repeated calls', () => {
    const scorer = textualDifference();
    const sample = { output: 'hello world', expected: 'hallo warld' };
    const r1: any = scorer.score(sample);
    const r2: any = scorer.score(sample);
    expect(r1.score).toBe(r2.score);
  });
});

describe('@gnl/evals answerSimilarity (token-overlap F1)', () => {
  it('identical token sets → 1', () => {
    const r: any = answerSimilarity().score({ output: 'the capital of France is Paris', expected: 'the capital of France is Paris' });
    expect(r.score).toBe(1);
  });

  it('completely disjoint tokens → 0', () => {
    const r: any = answerSimilarity().score({ output: 'foo bar baz', expected: 'qux quux corge' });
    expect(r.score).toBe(0);
  });

  it('partial token overlap → strictly between 0 and 1', () => {
    const r: any = answerSimilarity().score({ output: 'the capital of France is Paris', expected: 'Paris is the capital city of France' });
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThan(1);
  });

  it('robust to reordering: same tokens, different order → 1 (unlike exact match)', () => {
    const r: any = answerSimilarity().score({ output: 'Paris France capital the', expected: 'the capital France Paris' });
    expect(r.score).toBe(1);
  });

  it('deterministic across repeated calls', () => {
    const scorer = answerSimilarity();
    const sample = { output: 'the capital of France is Paris', expected: 'Paris is the capital city of France' };
    const r1: any = scorer.score(sample);
    const r2: any = scorer.score(sample);
    expect(r1.score).toBe(r2.score);
  });
});
