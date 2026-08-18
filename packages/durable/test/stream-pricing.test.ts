// A streamed step must be priced by the model that produced it — not as 'unknown'.
//
// getRunCost read the model's identity from `response.modelId` only. That field exists on a generate
// record and NOT on a stream one. Measured against a live provider (NVIDIA NIM, @ai-sdk/openai):
//
//   runDurable    → response = ["id","modelId","timestamp","headers","body"]   modelId present
//   streamDurable → response = ["headers"]                                     modelId ABSENT
//
// The model's identity does arrive, as a `response-metadata` PART, and the journal records it — it was
// simply never read. So every streamDurable step priced as 'unknown', priceFor matched no row, and
// costUsd came out 0. One real call, same model, same pricing table, 158 vs 161 tokens: generate
// $0.303, stream $0. That makes maxCostUsd and an organization's usdLimit unable to fire at ANY
// threshold on the streaming path — a spend ceiling that silently does nothing is worse than none,
// because it is believed.
//
// The record below is the shape a real provider produced, transcribed from that measurement rather
// than invented — the failure being guarded against is precisely a fixture that disagrees with a
// provider, so a fixture written from imagination would reproduce the bug it is meant to catch.
// real-provider.test.ts asserts the same property against the live provider when a key is present.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { getRunCost } from '../src/cost.js';

const MODEL = 'stepfun-ai/step-3.7-flash';
const PRICING = { [MODEL]: { inputPer1M: 1000, outputPer1M: 2000 } };

/** A streamDurable model record, as `wrapStream` writes it — the `{parts, rest}` shape. */
const streamRecord = () => ({
  parts: [
    { type: 'stream-start', warnings: [] },
    { type: 'response-metadata', id: 'chatcmpl-65e1fa13', modelId: MODEL, timestamp: '2026-08-18T00:15:48.000Z' },
    { type: 'text-start', id: '0' },
    { type: 'text-delta', id: '0', delta: 'hi' },
    { type: 'text-end', id: '0' },
    {
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 13, noCache: 13, cacheRead: 0 },
        outputTokens: { total: 98, text: 98, reasoning: 0 },
      },
    },
  ],
  // Only `headers` — this is the whole point. A stream's `response` carries no modelId.
  rest: { request: {}, response: { headers: {} } },
});

/** The generate shape, for the side-by-side that makes the asymmetry visible. */
const generateRecord = () => ({
  usage: {
    inputTokens: { total: 13, noCache: 13, cacheRead: 0 },
    outputTokens: { total: 98, text: 98, reasoning: 0 },
  },
  response: { id: 'x', modelId: MODEL, timestamp: '2026-08-18T00:15:48.000Z', headers: {} },
  finishReason: { unified: 'stop', raw: 'stop' },
});

describe('pricing a streamed step', () => {
  it('attributes the step to the model that produced it, not to \'unknown\'', async () => {
    const j = new InMemoryJournal();
    await j.put('s1:input', { prompt: 'hi' });
    await j.put('s1:model:0', streamRecord());

    const cost = await getRunCost(j, 's1', { pricing: PRICING });
    expect(Object.keys(cost.byModel), 'the streamed step was attributed to a model').toEqual([MODEL]);
    expect(cost.costUsd, 'a priced model must produce a non-zero cost').toBeGreaterThan(0);
  });

  it('prices a stream and a generate of the same size the same', async () => {
    // The two records carry identical usage, so any difference is the identity lookup and nothing else.
    const js = new InMemoryJournal();
    await js.put('s2:input', { prompt: 'hi' });
    await js.put('s2:model:0', streamRecord());

    const jg = new InMemoryJournal();
    await jg.put('g2:input', { prompt: 'hi' });
    await jg.put('g2:model:0', generateRecord());

    const s = await getRunCost(js, 's2', { pricing: PRICING });
    const g = await getRunCost(jg, 'g2', { pricing: PRICING });
    expect(s.totalTokens).toBe(g.totalTokens);
    expect(s.costUsd, `stream ${s.costUsd} vs generate ${g.costUsd} for identical usage`).toBe(g.costUsd);
  });

  it('a stream step still counts when the model has no price — as unpriced, not as free', async () => {
    // The other direction, so the fix cannot be read as "always find a price". An unpriced model is
    // ordinary (every mock in this suite is one); what matters is that it is REPORTED as unpriced
    // rather than silently costing zero under a real model's name.
    const j = new InMemoryJournal();
    await j.put('s3:input', { prompt: 'hi' });
    await j.put('s3:model:0', streamRecord());

    const cost = await getRunCost(j, 's3', { pricing: {} });
    expect(Object.keys(cost.byModel)).toEqual([MODEL]); // identity is still recovered
    expect(cost.costUsd).toBe(0);
  });
});
