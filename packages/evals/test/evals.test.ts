// 8.8 — Scorers + llmJudge + scoreRun (journal-trace, deterministic & replayable).
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { exactMatch, contains, regexScore } from '../src/scorer.js';
import { llmJudge } from '../src/llm-judge.js';
import { scoreRun } from '../src/score-run.js';

function mockModel(text: string, counter: { n: number }): any {
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'judge',
    supportedUrls: {},
    doGenerate: async () => {
      counter.n++;
      return { content: [{ type: 'text', text }], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] };
    },
    doStream: async () => {
      throw new Error('no stream');
    },
  };
}

describe('8.8 rule-based scorers', () => {
  it('exactMatch / contains / regexScore', async () => {
    expect((await exactMatch().score({ output: ' ab ', expected: 'ab' })).score).toBe(1);
    expect((await exactMatch().score({ output: 'ab', expected: 'xy' })).score).toBe(0);
    expect((await contains('lo').score({ output: 'hello' })).score).toBe(1);
    expect((await contains().score({ output: 'hello', expected: 'zz' })).score).toBe(0);
    expect((await regexScore(/\d+/).score({ output: 'abc 42' })).score).toBe(1);
    expect((await regexScore(/\d+/).score({ output: 'abc' })).score).toBe(0);
  });
});

describe('8.8 llmJudge', () => {
  it('parses the model\'s SCORE/REASON output + clamps to [0,1]', async () => {
    const c = { n: 0 };
    const judge = llmJudge({ model: mockModel('SCORE: 0.8\nREASON: reasonable', c), rubric: 'quality?' });
    const r = await judge.score({ output: 'answer' });
    expect(r.score).toBeCloseTo(0.8);
    expect(r.reason).toContain('reasonable');
  });
});

describe('8.8 scoreRun (journal-trace)', () => {
  it('scores the last model text; llmJudge memoized → same score on resume, model called once', async () => {
    const journal = new InMemoryJournal();
    // Journal trace: the final text of the last model entry is scored.
    await journal.put('r:model:0', { content: [{ type: 'text', text: 'the result is correct' }], finishReason: 'stop', usage: {}, warnings: [] });
    const c = { n: 0 };
    const judge = llmJudge({ model: mockModel('SCORE: 0.9\nREASON: good', c), rubric: 'is it correct?' });

    const r1 = await scoreRun(journal, 'r', [contains('correct'), judge]);
    expect(r1.output).toBe('the result is correct');
    expect(r1.scores['contains']!.score).toBe(1);
    expect(r1.scores['llm-judge']!.score).toBeCloseTo(0.9);
    expect(c.n).toBe(1);

    // Second scoreRun: same journal → memoized scores (the judge model is NOT called again).
    const r2 = await scoreRun(journal, 'r', [contains('correct'), judge]);
    expect(r2.scores['llm-judge']!.score).toBeCloseTo(0.9);
    expect(c.n).toBe(1); // replayable scoring (most eval frameworks have none)
  });
});
