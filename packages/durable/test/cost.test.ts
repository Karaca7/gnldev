// 8.2 cost ledger + trace export — exact cost from the journal (unlike typical approximate cost guards).
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { getRunCost, toTraceSpans } from '../src/cost.js';
import { createMockModel } from './mock.js';

function model() {
  return createMockModel(async () => ({
    content: [{ type: 'text', text: 'hi' }],
    finishReason: 'stop',
    usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
    warnings: [],
  }));
}

describe('cost ledger (8.2)', () => {
  it('getRunCost — exact USD from journaled usage', async () => {
    const journal = new InMemoryJournal();
    await runDurable({ runId: 'c1', journal, model: model(), prompt: 'x' });

    const cost = await getRunCost(journal, 'c1', { modelId: 'gpt-4o-mini' });

    expect(cost.inputTokens).toBe(1000);
    expect(cost.outputTokens).toBe(500);
    expect(cost.totalTokens).toBe(1500);
    expect(cost.modelCalls).toBe(1);
    // gpt-4o-mini: in 0.15, out 0.6 /1M → 1000*0.15/1e6 + 500*0.6/1e6 = 0.00045
    expect(cost.costUsd).toBeCloseTo(0.00045, 8);
    expect(cost.byModel['gpt-4o-mini'].calls).toBe(1);
  });

  it('deterministic: recomputing the same journal gives the same result', async () => {
    const journal = new InMemoryJournal();
    await runDurable({ runId: 'c2', journal, model: model(), prompt: 'x' });
    const a = await getRunCost(journal, 'c2', { modelId: 'gpt-4o' });
    const b = await getRunCost(journal, 'c2', { modelId: 'gpt-4o' });
    expect(a).toEqual(b);
  });

  it('toTraceSpans — OTel gen_ai semantic-convention-compliant', async () => {
    const journal = new InMemoryJournal();
    await runDurable({ runId: 't1', journal, model: model(), prompt: 'x' });
    const spans = await toTraceSpans(journal, 't1');
    expect(spans[0].name).toBe('llm.generate');
    expect(spans[0].attributes['gen_ai.usage.input_tokens']).toBe(1000);
  });
});
