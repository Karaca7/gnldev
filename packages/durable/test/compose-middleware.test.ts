// withDurableModel can be stacked with ANOTHER LanguageModelV2Middleware.
// AI-SDK-based agent frameworks wrap the model with their own middleware → our layer is added on top of/below it.
import { describe, it, expect } from 'vitest';
import { generateText, stepCountIs, wrapLanguageModel } from 'ai';
import type { LanguageModelV2Middleware } from '@ai-sdk/provider';
import { InMemoryJournal } from '../src/journal.js';
import { withDurableModel } from '../src/durable-model.js';
import { createMockModel, finalTextResult } from './mock.js';

describe('composability — withDurableModel + another middleware', () => {
  it('the underlying transformParams middleware runs, the durable layer doesn\'t break it', async () => {
    const journal = new InMemoryJournal();
    let transformed = false;
    const tagging: LanguageModelV2Middleware = {
      transformParams: async ({ params }) => {
        transformed = true;
        return params;
      },
    };
    const base = createMockModel(async () => finalTextResult('hi'));
    const tagged = wrapLanguageModel({ model: base, middleware: tagging });
    const durable = withDurableModel(tagged, { journal, runId: 'c1' });

    const res = await generateText({ model: durable, prompt: 'x', stopWhen: stepCountIs(2) });

    expect(transformed).toBe(true); // the underlying middleware was triggered
    expect(res.text).toBe('hi');
  });
});
