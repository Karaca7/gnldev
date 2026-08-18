// Prices a user can change without waiting for us to ship a release.
//
// DEFAULT_PRICING is a table compiled into this package. Providers change their list prices on their
// own schedule and add models constantly, so that table is stale the moment it is written — and an
// unpriced model costs 0, which makes maxCostUsd unable to fire at any threshold. Correcting it by
// editing our source and publishing is the wrong loop for someone whose ceiling is mispriced today.
//
// The intended escape already existed on paper: a `__pricing__` document in the journal, with
// `readPricing` and `effectivePricingTable` exported and named in the docs — and in the error message
// the ceiling itself prints ("supply prices via the `pricing` option or the journal's __pricing__
// document"). Nothing in the product ever called them. Measured: a `__pricing__` doc naming a model
// still produced costUsd 0, so half of that sentence was false and the documented workaround did not
// work at all.
//
// Both readers now resolve it: getRunCost for reporting, and enforceStepLimits for the ceiling. The
// ceiling is the half that matters — a report that is wrong is visible, a ceiling that never fires is
// not.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { getRunCost } from '../src/cost.js';
import { PRICING_KEY } from '../src/pricing.js';
import { runDurable } from '../src/run.js';
import { RunLimitExceededError } from '../src/limits.js';
import { createMockModel, finalTextResult } from './mock.js';

/** A model id that is deliberately NOT in DEFAULT_PRICING — the case the document exists for. */
const NEW_MODEL = 'some-provider/model-released-yesterday';

const step = (modelId: string, tokens = 1_000_000) => ({
  content: [{ type: 'text', text: 'ok' }],
  finishReason: 'stop',
  usage: { inputTokens: tokens, outputTokens: tokens, totalTokens: tokens * 2 },
  response: { modelId },
});

describe('the journal\'s __pricing__ document', () => {
  it('prices a model the shipped table has never heard of', async () => {
    const j = new InMemoryJournal();
    await j.put(PRICING_KEY, { models: { [NEW_MODEL]: { inputPer1M: 10, outputPer1M: 30 } } });
    await j.put('r1:input', { prompt: 'x' });
    await j.put('r1:model:0', step(NEW_MODEL));

    const cost = await getRunCost(j, 'r1');
    // 1M in @ $10 + 1M out @ $30
    expect(cost.costUsd, 'the document was ignored — this is the pre-fix behaviour').toBe(40);
    expect(cost.byModel[NEW_MODEL].costUsd).toBe(40);
  });

  it('makes maxCostUsd fire for that model — the half that actually matters', async () => {
    const j = new InMemoryJournal();
    await j.put(PRICING_KEY, { models: { [NEW_MODEL]: { inputPer1M: 100_000, outputPer1M: 200_000 } } });

    const model = createMockModel(async () => ({
      ...finalTextResult('ok'),
      usage: { inputTokens: 1000, outputTokens: 1000, totalTokens: 2000 },
      response: { modelId: NEW_MODEL },
    }) as never);

    await expect(runDurable({
      runId: 'r2', journal: j, model, prompt: 'x', limits: { maxCostUsd: 0.01 },
    } as never)).rejects.toBeInstanceOf(RunLimitExceededError);
  });

  it('without the document that same run is uncapped — the failure being fixed', async () => {
    // The same model, the same ceiling, no document: the step prices at 0 and nothing stops it. Stated
    // as a test rather than left implicit, because this is what every user of a current model got.
    const j = new InMemoryJournal();
    const model = createMockModel(async () => ({
      ...finalTextResult('ok'),
      usage: { inputTokens: 1000, outputTokens: 1000, totalTokens: 2000 },
      response: { modelId: NEW_MODEL },
    }) as never);

    await expect(runDurable({
      runId: 'r3', journal: j, model, prompt: 'x', limits: { maxCostUsd: 0.01 },
    } as never)).resolves.toBeDefined();
  });

  it('an explicit `pricing` option still wins over the document', async () => {
    const j = new InMemoryJournal();
    await j.put(PRICING_KEY, { models: { [NEW_MODEL]: { inputPer1M: 10, outputPer1M: 30 } } });
    await j.put('r4:input', { prompt: 'x' });
    await j.put('r4:model:0', step(NEW_MODEL));

    const cost = await getRunCost(j, 'r4', { pricing: { [NEW_MODEL]: { inputPer1M: 1, outputPer1M: 1 } } });
    expect(cost.costUsd).toBe(2);
  });

  it('LAYERS over the shipped table — adding one model does not un-price the rest', async () => {
    // The document used to REPLACE the table (`doc.models ?? DEFAULT_PRICING`), so adding a price for
    // one new model silently removed it for every other. An un-priced model costs 0, so the symptom
    // would not have been an error but a ceiling that quietly stopped capping gpt-4o — the exact
    // failure the document exists to fix, caused by using it.
    const j = new InMemoryJournal();
    await j.put(PRICING_KEY, { models: { [NEW_MODEL]: { inputPer1M: 10, outputPer1M: 30 } } });
    await j.put('r5:input', { prompt: 'x' });
    await j.put('r5:model:0', step('gpt-4o'));
    await j.put('r5:model:1', step(NEW_MODEL));

    const cost = await getRunCost(j, 'r5');
    expect(cost.byModel['gpt-4o'].costUsd, 'gpt-4o lost its price because another model was added').toBe(12.5);
    expect(cost.byModel[NEW_MODEL].costUsd).toBe(40);
  });

  it('replace: true still gives the whole table to the caller', async () => {
    // The escape hatch for someone who really wants only their own prices — opt-in, not the default.
    const j = new InMemoryJournal();
    await j.put(PRICING_KEY, { replace: true, models: { [NEW_MODEL]: { inputPer1M: 10, outputPer1M: 30 } } });
    await j.put('r7:input', { prompt: 'x' });
    await j.put('r7:model:0', step('gpt-4o'));

    const cost = await getRunCost(j, 'r7');
    expect(cost.costUsd).toBe(0);
  });

  it('no document, no behaviour change: the shipped table still applies', async () => {
    const j = new InMemoryJournal();
    await j.put('r6:input', { prompt: 'x' });
    await j.put('r6:model:0', step('gpt-4o'));
    const cost = await getRunCost(j, 'r6');
    expect(cost.costUsd).toBe(12.5); // 1M in @ $2.50 + 1M out @ $10
  });
});
