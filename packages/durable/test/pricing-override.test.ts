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
import { withOrg } from '../src/organization.js';
import { getRunCost } from '../src/cost.js';
import { PRICING_KEY, effectivePricingTable } from '../src/pricing.js';
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

  it('is visible from an ORGANIZATION-SCOPED journal — where the ceiling actually runs', async () => {
    // withOrg prefixes every key, so a document written at the root (which is where both Studio and the
    // CLI write it — both require an unbound platform admin) was invisible from inside a scope. Measured
    // before the fix: the doc existed and effectivePricingTable on a scoped journal returned defaults, so
    // "the ceiling now sees your prices" was true single-org and false in exactly the deployments that
    // have organizations.
    const base = new InMemoryJournal();
    await base.put(PRICING_KEY, { models: { [NEW_MODEL]: { inputPer1M: 10, outputPer1M: 30 } } });
    const acme = withOrg(base, 'acme');

    const table = await effectivePricingTable(acme as never);
    expect(table[NEW_MODEL], 'the global table is invisible inside an organization').toEqual({ inputPer1M: 10, outputPer1M: 30 });
  });

  it('an organization\'s OWN document wins over the global one', async () => {
    const base = new InMemoryJournal();
    await base.put(PRICING_KEY, { models: { [NEW_MODEL]: { inputPer1M: 10, outputPer1M: 30 } } });
    const acme = withOrg(base, 'acme');
    await acme.put(PRICING_KEY, { models: { [NEW_MODEL]: { inputPer1M: 999, outputPer1M: 1 } } });

    expect((await effectivePricingTable(acme as never))[NEW_MODEL].inputPer1M).toBe(999);
    // ...and it does not leak upward into everyone else's prices.
    expect((await effectivePricingTable(base))[NEW_MODEL].inputPer1M).toBe(10);
  });

  it('survives the wrapper spread, like the org marker does', async () => {
    const base = new InMemoryJournal();
    await base.put(PRICING_KEY, { models: { [NEW_MODEL]: { inputPer1M: 7, outputPer1M: 7 } } });
    const wrapped = { ...withOrg(base, 'acme') };
    expect((await effectivePricingTable(wrapped as never))[NEW_MODEL].inputPer1M).toBe(7);
  });

  it('the CEILING fires under an organization scope, not just the cost report', async () => {
    // Two different code paths read the table: getRunCost (reporting) and enforceStepLimits (the ceiling).
    // Fixing the reader without checking the ceiling would have left the half that matters broken, and
    // the symptom is silence — a ceiling that never fires looks exactly like a run under budget.
    const base = new InMemoryJournal();
    await base.put(PRICING_KEY, { models: { [NEW_MODEL]: { inputPer1M: 100_000, outputPer1M: 200_000 } } });

    const model = () => createMockModel(async () => ({
      ...finalTextResult('ok'),
      usage: { inputTokens: 1000, outputTokens: 1000, totalTokens: 2000 },
      response: { modelId: NEW_MODEL },
    }) as never);

    // Root: the baseline.
    await expect(runDurable({
      runId: 'ceil-root', journal: base, model: model(), prompt: 'x', limits: { maxCostUsd: 0.01 },
    } as never)).rejects.toBeInstanceOf(RunLimitExceededError);

    // Organization-scoped: the same document, reached through the parent.
    await expect(runDurable({
      runId: 'ceil-org', journal: withOrg(base, 'acme'), model: model(), prompt: 'x', limits: { maxCostUsd: 0.01 },
    } as never)).rejects.toBeInstanceOf(RunLimitExceededError);
  });

  it('the TOOL path seeds the counters with the same table the ceiling uses', async () => {
    // The counters are additive and never recomputed, so whichever table seeds them decides the recorded
    // cost of every earlier step for the rest of the run. `checkToolGate` and `recordToolOutcome` seeded
    // with empty options — DEFAULT_PRICING only — so a model priced solely by the `__pricing__` document
    // was written down at $0 permanently. enforceStepLimits resolving the table correctly afterwards
    // cannot undo it, and the "no price for this model" warning did not fire either because the unpriced
    // set stayed empty. Measured: a step the document prices at $300 left a $0.01 ceiling unenforced.
    const { checkToolGate, enforceStepLimits } = await import('../src/limits.js');
    const j = new InMemoryJournal();
    await j.put(PRICING_KEY, { models: { [NEW_MODEL]: { inputPer1M: 100_000, outputPer1M: 200_000 } } });
    await j.put('seed-1:input', { prompt: 'x' });
    await j.put('seed-1:model:0', step(NEW_MODEL, 1000));

    // The tool gate runs FIRST and seeds. This is the ordering the bug needed.
    await checkToolGate(j as never, 'seed-1', 'someTool', 'hash1', { maxToolCalls: 10 } as never);

    await expect(
      enforceStepLimits(j as never, 'seed-1', { maxCostUsd: 0.01 } as never, {}),
    ).rejects.toBeInstanceOf(RunLimitExceededError);
  });
});
