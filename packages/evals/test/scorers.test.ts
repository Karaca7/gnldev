// Built-in scorers (§1.3, internal audit notes) — thin factories wrapping llmJudge. No real LLM
// call: a fake LanguageModelV2 model captures the prompt sent by generateText → we verify that the
// correct rubric is entered, context/input is added, and SCORE is parsed correctly (including
// direction semantics).
import { describe, it, expect } from 'vitest';
import {
  faithfulness,
  hallucination,
  answerRelevancy,
  toxicity,
  bias,
  completeness,
  contextPrecision,
  toneConsistency,
} from '../src/scorers.js';
import { llmJudge } from '../src/llm-judge.js';

/** Fake model that captures the prompt: pushes the text sent on each call into `captured`, returns a fixed `text`. */
function mockModel(text: string, captured: { prompts: string[] } = { prompts: [] }): any {
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'judge',
    supportedUrls: {},
    doGenerate: async (opts: any) => {
      const promptText = (opts.prompt ?? [])
        .flatMap((m: any) => (m.content ?? []).map((p: any) => p.text ?? ''))
        .join('\n');
      captured.prompts.push(promptText);
      return { content: [{ type: 'text', text }], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] };
    },
    doStream: async () => {
      throw new Error('no stream');
    },
  };
}

describe('scorers — require context (faithfulness/hallucination/contextPrecision)', () => {
  it('faithfulness: does not silently return 1 without context, returns 0 + a clear reason', async () => {
    const s = faithfulness({ model: mockModel('SCORE: 1.0\nREASON: x') });
    const r = await s.score({ output: 'answer' });
    expect(r.score).toBe(0);
    expect(r.reason).toContain('context required');
  });

  it('faithfulness: correct rubric + context enters the prompt, SCORE is parsed', async () => {
    const captured = { prompts: [] as string[] };
    const s = faithfulness({ model: mockModel('SCORE: 0.75\nREASON: most claims are supported', captured) });
    const r = await s.score({ output: 'Paris is the capital of France.', context: 'Paris is the capital of France and has a population of 2 million.' });
    expect(r.score).toBeCloseTo(0.75);
    expect(captured.prompts[0]).toContain('faithfulness');
    expect(captured.prompts[0]).toContain('faithfulness judge');
    expect(captured.prompts[0]).toContain('Paris is the capital of France and has a population of 2 million.');
    expect(s.name).toBe('faithfulness');
  });

  it('faithfulness: if context is an array (string[]), it is joined and added to the prompt', async () => {
    const captured = { prompts: [] as string[] };
    const s = faithfulness({ model: mockModel('SCORE: 0.4\nREASON: partially', captured) });
    await s.score({ output: 'x', context: ['chunk one', 'chunk two'] });
    expect(captured.prompts[0]).toContain('chunk one');
    expect(captured.prompts[0]).toContain('chunk two');
  });

  it('hallucination: 0 + "context required" without context; direction semantics are explicit via JSDoc/rubric (1.0 = NO hallucination)', async () => {
    const s1 = hallucination({ model: mockModel('SCORE: 1.0\nREASON: none') });
    const r1 = await s1.score({ output: 'x' });
    expect(r1.score).toBe(0);
    expect(r1.reason).toContain('context required');

    const captured = { prompts: [] as string[] };
    const s2 = hallucination({ model: mockModel('SCORE: 1.0\nREASON: no hallucination at all', captured) });
    const r2 = await s2.score({ output: 'Paris is the capital of France.', context: 'Paris is the capital of France.' });
    expect(r2.score).toBe(1); // high = good = NO hallucination
    expect(captured.prompts[0]).toContain('hallucination');
    expect(captured.prompts[0]).toContain('ABSENCE');
    expect(s2.name).toBe('hallucination');
  });

  it('contextPrecision: 0 + "context required" without context; with context, rubric+context enter the prompt', async () => {
    const s1 = contextPrecision({ model: mockModel('SCORE: 1.0\nREASON: x') });
    expect((await s1.score({ output: 'y' })).score).toBe(0);

    const captured = { prompts: [] as string[] };
    const s2 = contextPrecision({ model: mockModel('SCORE: 0.6\nREASON: half is relevant', captured) });
    const r2 = await s2.score({ output: 'answer', input: 'where is the capital?', context: ['relevant chunk', 'irrelevant chunk'] });
    expect(r2.score).toBeCloseTo(0.6);
    expect(captured.prompts[0]).toContain('context-precision');
    expect(captured.prompts[0]).toContain('where is the capital?');
    expect(captured.prompts[0]).toContain('relevant chunk');
    expect(s2.name).toBe('context-precision');
  });
});

describe('scorers — require input/question (answerRelevancy/completeness)', () => {
  it('answerRelevancy: 0 + "input required" without input', async () => {
    const s = answerRelevancy({ model: mockModel('SCORE: 1.0\nREASON: x') });
    const r = await s.score({ output: 'answer' });
    expect(r.score).toBe(0);
    expect(r.reason).toContain('input required');
  });

  it('answerRelevancy: with input, rubric+question enter the prompt, SCORE is parsed', async () => {
    const captured = { prompts: [] as string[] };
    const s = answerRelevancy({ model: mockModel('SCORE: 0.9\nREASON: answers directly', captured) });
    const r = await s.score({ output: 'Ankara.', input: 'What is the capital of Turkey?' });
    expect(r.score).toBeCloseTo(0.9);
    expect(captured.prompts[0]).toContain('answer-relevancy');
    expect(captured.prompts[0]).toContain('What is the capital of Turkey?');
    expect(s.name).toBe('answer-relevancy');
  });

  it('completeness: 0 + "input required" without input; with it, rubric+question enter the prompt', async () => {
    const s1 = completeness({ model: mockModel('SCORE: 1.0\nREASON: x') });
    expect((await s1.score({ output: 'y' })).score).toBe(0);

    const captured = { prompts: [] as string[] };
    const s2 = completeness({ model: mockModel('SCORE: 0.3\nREASON: incomplete', captured) });
    const r2 = await s2.score({ output: 'partial answer', input: 'Compare A and B' });
    expect(r2.score).toBeCloseTo(0.3);
    expect(captured.prompts[0]).toContain('completeness');
    expect(captured.prompts[0]).toContain('Compare A and B');
    expect(s2.name).toBe('completeness');
  });
});

describe('scorers — require neither context nor input (toxicity/bias/toneConsistency)', () => {
  it('toxicity: rubric enters the prompt, direction semantics are explicit (1.0 = clean/good)', async () => {
    const captured = { prompts: [] as string[] };
    const s = toxicity({ model: mockModel('SCORE: 1.0\nREASON: harmless', captured) });
    const r = await s.score({ output: 'Hello, how are you?' });
    expect(r.score).toBe(1);
    expect(captured.prompts[0]).toContain('toxicity');
    expect(captured.prompts[0]).toContain('Hello, how are you?');
    expect(s.name).toBe('toxicity');
  });

  it('bias: rubric enters the prompt, SCORE is parsed', async () => {
    const captured = { prompts: [] as string[] };
    const s = bias({ model: mockModel('SCORE: 0.2\nREASON: sexist language present', captured) });
    const r = await s.score({ output: 'some biased text' });
    expect(r.score).toBeCloseTo(0.2);
    expect(captured.prompts[0]).toContain('bias');
    expect(s.name).toBe('bias');
  });

  it('toneConsistency: if expectedTone is not given it does not appear in the rubric; if given it is added to the prompt', async () => {
    const captured1 = { prompts: [] as string[] };
    const s1 = toneConsistency({ model: mockModel('SCORE: 0.8\nREASON: consistent', captured1) });
    await s1.score({ output: 'text' });
    expect(captured1.prompts[0]).toContain('tone-consistency');
    expect(captured1.prompts[0]).not.toContain('matches the expected tone');

    const captured2 = { prompts: [] as string[] };
    const s2 = toneConsistency({ model: mockModel('SCORE: 0.5\nREASON: partially', captured2), expectedTone: 'professional' });
    const r2 = await s2.score({ output: 'text' });
    expect(r2.score).toBeCloseTo(0.5);
    expect(captured2.prompts[0]).toContain('professional');
    expect(captured2.prompts[0]).toContain('matches the expected tone');
    expect(s2.name).toBe('tone-consistency');
  });
});

describe('scorers — sampleFields (context contamination prevention)', () => {
  // In shared RAG samples (the same sample has both input and context populated), scorers that
  // should evaluate the output only (toxicity/bias/toneConsistency) must not be contaminated by
  // irrelevant context — otherwise, if the context is toxic, a wrong (low) score could come out even
  // though the output itself is clean.
  const ragSample = {
    output: 'Hello, how are you?',
    input: 'Tell me something.',
    context: 'This context contains toxic example text with insults and hate speech.',
  };

  it('toxicity: does NOT add a "Context" section to the prompt for a sample with context populated (output only)', async () => {
    const captured = { prompts: [] as string[] };
    const s = toxicity({ model: mockModel('SCORE: 1.0\nREASON: harmless', captured) });
    await s.score(ragSample);
    expect(captured.prompts[0]).not.toContain('Context:');
    expect(captured.prompts[0]).not.toContain('Input/Question:');
    expect(captured.prompts[0]).toContain('Hello, how are you?');
  });

  it('bias/toneConsistency: likewise do not add context/input', async () => {
    const cBias = { prompts: [] as string[] };
    await bias({ model: mockModel('SCORE: 1.0\nREASON: x', cBias) }).score(ragSample);
    expect(cBias.prompts[0]).not.toContain('Context:');
    expect(cBias.prompts[0]).not.toContain('Input/Question:');

    const cTone = { prompts: [] as string[] };
    await toneConsistency({ model: mockModel('SCORE: 1.0\nREASON: x', cTone) }).score(ragSample);
    expect(cTone.prompts[0]).not.toContain('Context:');
    expect(cTone.prompts[0]).not.toContain('Input/Question:');
  });

  it('faithfulness: context is added to the prompt as a "Context:" section', async () => {
    const captured = { prompts: [] as string[] };
    const s = faithfulness({ model: mockModel('SCORE: 1.0\nREASON: x', captured) });
    await s.score(ragSample);
    expect(captured.prompts[0]).toContain('Context:');
    expect(captured.prompts[0]).toContain(ragSample.context);
  });

  it('answerRelevancy: adds input but not context', async () => {
    const captured = { prompts: [] as string[] };
    const s = answerRelevancy({ model: mockModel('SCORE: 1.0\nREASON: x', captured) });
    await s.score(ragSample);
    expect(captured.prompts[0]).toContain('Input/Question:');
    expect(captured.prompts[0]).toContain(ragSample.input);
    expect(captured.prompts[0]).not.toContain('Context:');
  });

  it('llmJudge: plain usage without sampleFields preserves the old behavior (input+context populated → both are added)', async () => {
    const captured = { prompts: [] as string[] };
    const judge = llmJudge({ model: mockModel('SCORE: 1.0\nREASON: x', captured), rubric: 'quality?' });
    await judge.score(ragSample);
    expect(captured.prompts[0]).toContain('Input/Question:');
    expect(captured.prompts[0]).toContain(ragSample.input);
    expect(captured.prompts[0]).toContain('Context:');
    expect(captured.prompts[0]).toContain(ragSample.context);
  });

  it('llmJudge: with sampleFields ["context"] and an empty array context → no "Context" section is added', async () => {
    const captured = { prompts: [] as string[] };
    const judge = llmJudge({ model: mockModel('SCORE: 1.0\nREASON: x', captured), rubric: 'quality?', sampleFields: ['context'] });
    await judge.score({ output: 'y', context: [] });
    expect(captured.prompts[0]).not.toContain('Context:');
  });

  it('llmJudge: without sampleFields + empty string context/input → not added (truthy trap)', async () => {
    const captured = { prompts: [] as string[] };
    const judge = llmJudge({ model: mockModel('SCORE: 1.0\nREASON: x', captured) as any, rubric: 'quality?' });
    await judge.score({ output: 'y', input: '   ', context: '' });
    expect(captured.prompts[0]).not.toContain('Context:');
    expect(captured.prompts[0]).not.toContain('Input/Question:');
  });
});

describe('scorers — name override', () => {
  it('if opts.name is given, the scorer name is overridden', async () => {
    const s = toxicity({ model: mockModel('SCORE: 1.0\nREASON: x'), name: 'custom-toxicity' });
    expect(s.name).toBe('custom-toxicity');
  });
});
