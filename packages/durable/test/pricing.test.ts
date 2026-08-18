// Pricing table lives in the journal (policy/budget pattern) + priceFor's real exact/prefix matching.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import {
  DEFAULT_PRICING, priceFor, costOf, PRICING_KEY, readPricing, effectivePricingTable,
  type PricingDoc,
} from '../src/pricing.js';
import { getRunCost } from '../src/cost.js';
import { runDurable } from '../src/run.js';
import { createMockModel } from './mock.js';

describe('priceFor — exact/prefix matching (5.3)', () => {
  it('exact match always wins first', () => {
    expect(priceFor('gpt-4o')).toEqual(DEFAULT_PRICING['gpt-4o']);
    expect(priceFor('gpt-4o-mini')).toEqual(DEFAULT_PRICING['gpt-4o-mini']);
  });

  it('when no exact match, REAL prefix (startsWith) matching — NOT includes/substring', () => {
    const table = {
      'openai/gpt-4o': { inputPer1M: 2.5, outputPer1M: 10 },
    };
    // 'openai/gpt-4o-mini' has no exact entry in the table but 'openai/gpt-4o' is its REAL prefix → should match.
    expect(priceFor('openai/gpt-4o-mini', table)).toEqual(table['openai/gpt-4o']);
    // If modelId does NOT START WITH the prefix (only contains it), it must not match (the former `includes` bug).
    expect(priceFor('my-custom-openai/gpt-4o-clone', table)).toBeUndefined();
  });

  it('when multiple prefixes match, the LONGEST (most specific) wins', () => {
    const table = {
      'gpt-4o': { inputPer1M: 2.5, outputPer1M: 10 },
      'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.6 },
    };
    // 'gpt-4o-mini-2024-07-18' starts with both 'gpt-4o' and 'gpt-4o-mini' → the longer 'gpt-4o-mini' must win.
    expect(priceFor('gpt-4o-mini-2024-07-18', table)).toEqual(table['gpt-4o-mini']);
  });

  it('returns undefined when there is no match at all', () => {
    expect(priceFor('unknown-model-xyz', { 'gpt-4o': DEFAULT_PRICING['gpt-4o'] })).toBeUndefined();
  });
});

describe('readPricing / effectivePricingTable — journal-backed versioned pricing document (5.3)', () => {
  it('effectivePricingTable falls back to DEFAULT_PRICING when the journal is empty', async () => {
    const j = new InMemoryJournal();
    expect(await readPricing(j)).toBeUndefined();
    expect(await effectivePricingTable(j)).toBe(DEFAULT_PRICING);
  });

  it('once __pricing__ is written to the journal, the effective table is read from the journal document (deploy-less update)', async () => {
    const j = new InMemoryJournal();
    const doc: PricingDoc = {
      version: 1,
      models: { 'gpt-4o-mini': { inputPer1M: 0.1, outputPer1M: 0.4 } },
      updatedAt: Date.now(),
    };
    await j.put(PRICING_KEY, doc);

    expect(await readPricing(j)).toEqual(doc);
    const table = await effectivePricingTable(j);
    // The document LAYERS over DEFAULT_PRICING rather than replacing it. This assertion used to be
    // `toEqual(doc.models)`, i.e. the document was the whole table — which meant correcting one price
    // silently un-priced every other model, and an un-priced model costs 0, so a maxCostUsd ceiling
    // stopped capping as a side effect of fixing a maxCostUsd ceiling. Changing it was safe because
    // NOTHING in the product read this document: `effectivePricingTable` had no callers outside its own
    // module and the docs, so no deployment could have depended on either behaviour. `replace: true`
    // keeps the old semantics for anyone who genuinely wants only their own prices.
    expect(table['gpt-4o-mini']).toEqual({ inputPer1M: 0.1, outputPer1M: 0.4 }); // the override applies
    expect(table['gpt-4o'], 'an untouched model lost its price').toEqual(DEFAULT_PRICING['gpt-4o']);
  });

  it('replace: true restores the whole-table semantics', async () => {
    const j = new InMemoryJournal();
    await j.put(PRICING_KEY, {
      version: 1,
      replace: true,
      models: { 'gpt-4o-mini': { inputPer1M: 0.1, outputPer1M: 0.4 } },
    } as PricingDoc);
    const table = await effectivePricingTable(j);
    expect(table).toEqual({ 'gpt-4o-mini': { inputPer1M: 0.1, outputPer1M: 0.4 } });
  });

  it('once journal pricing is updated (version bumped), getRunCost can use the new table', async () => {
    const j = new InMemoryJournal();
    const model = createMockModel(async () => ({
      content: [{ type: 'text', text: 'hi' }],
      finishReason: 'stop',
      usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
      warnings: [],
    }));
    await runDurable({ runId: 'p1', journal: j, model, prompt: 'x' });

    // Custom/current pricing in the journal: gpt-4o-mini → in 1.0 out 2.0 /1M
    await j.put(PRICING_KEY, {
      version: 1,
      models: { 'gpt-4o-mini': { inputPer1M: 1, outputPer1M: 2 } },
    } satisfies PricingDoc);

    const table = await effectivePricingTable(j);
    const cost = await getRunCost(j, 'p1', { modelId: 'gpt-4o-mini', pricing: table });
    // 1000*1/1e6 + 500*2/1e6 = 0.002
    expect(cost.costUsd).toBeCloseTo(0.002, 8);
  });
});

describe('costOf — backward compatibility (existing behavior unchanged)', () => {
  it('cached tokens are priced separately when present, otherwise inputPer1M is used', () => {
    const pricing = { inputPer1M: 2, outputPer1M: 4, cachedInputPer1M: 0.5 };
    const cost = costOf({ inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 200_000 }, pricing);
    // input (800k normal @2) + cached (200k @0.5)
    expect(cost).toBeCloseTo(0.8 * 2 + 0.2 * 0.5, 8);
  });
});
