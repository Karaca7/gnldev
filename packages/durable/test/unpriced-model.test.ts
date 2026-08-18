// A $ ceiling over a model with no price is not a ceiling.
//
// DEFAULT_PRICING only ever covers the models that existed when it was written, and `priceFor`
// returns undefined for anything else — which getRunCost turned into costUsd: 0. That is
// indistinguishable from a genuinely free step, so `costUsd > maxCostUsd` stayed false however much
// the run actually spent. The failure fires precisely on an upgrade to the newest (usually
// priciest) model, and it reads as green: the ceiling is configured, nothing throws, nothing warns.
//
// Same family as the nested-usage break — a spend guard that silently stops guarding.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { getRunCost } from '../src/cost.js';
import { usageAndCostFromModelValue } from '../src/cost.js';
import { priceFor, DEFAULT_PRICING } from '../src/pricing.js';
import { createMockModel, finalTextResult } from './mock.js';

afterEach(() => vi.restoreAllMocks());

// A shape a provider really could hand us, chosen so it can never become priced. This was
// `claude-opus-5` — true when written, and it turned the test into a lock: adding that model to the
// table (which the table needed) failed here, so the file quietly argued against its own premise. A
// test for the unpriced path must not depend on a specific model STAYING unpriced.
const UNKNOWN = 'acme-internal/finetune-2026-08';
const step = (modelId: string) => ({
  content: [{ type: 'text', text: 'ok' }],
  finishReason: 'stop',
  usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 },
  response: { modelId },
});

describe('unpriced models', () => {
  it('the shipped table really does not price it — the premise of the rest of this file', () => {
    expect(priceFor(UNKNOWN, DEFAULT_PRICING)).toBeUndefined();
    // ...while a model it does carry still prices, so the table is not simply broken.
    expect(priceFor('claude-opus-4', DEFAULT_PRICING)).toBeDefined();
  });

  it('an unpriced step is marked unpriced rather than passing as a $0 step, and stays quiet', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const u = usageAndCostFromModelValue(step(UNKNOWN))!;
    expect(u.costUsd).toBe(0);
    expect(u.priced, 'a $0 cost that nothing could compute must not look like a free step').toBe(false);
    // Reporting a cost is not a risk, so this funnel says nothing: every mock model in a test suite
    // is unpriced. The warning belongs to the ceiling, which is what the next two cases cover.
    expect(warn, 'plain cost reporting must not write to stderr').not.toHaveBeenCalled();

    const known = usageAndCostFromModelValue(step('claude-opus-4'))!;
    expect(known.priced).toBe(true);
    expect(known.costUsd).toBeGreaterThan(0);
  });

  it('maxCostUsd + an unpriced model warns that the ceiling is not capping the run', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const journal = new InMemoryJournal();
    await journal.put('r1:model:0', step(UNKNOWN));

    await runDurable({
      runId: 'r1', journal,
      model: createMockModel(async () => finalTextResult('done')),
      prompt: 'x',
      limits: { maxCostUsd: 0.01 },
    } as never);

    const said = warn.mock.calls.flat().join(' ');
    expect(said, 'the operator is never told the ceiling went quiet').toContain('maxCostUsd');
    expect(said).toContain(UNKNOWN);
  });

  it('limits.strict turns that silence into a thrown error', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const journal = new InMemoryJournal();
    await journal.put('r2:model:0', step(UNKNOWN));

    await expect(runDurable({
      runId: 'r2', journal,
      model: createMockModel(async () => finalTextResult('done')),
      prompt: 'x',
      limits: { maxCostUsd: 0.01, strict: true },
    } as never)).rejects.toThrow(new RegExp(`no pricing entry exists for ${UNKNOWN}`));
  });

  it('a priced run is unaffected: no warning, and the ceiling still fires', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const journal = new InMemoryJournal();
    await journal.put('r3:model:0', step('claude-opus-4'));

    await expect(runDurable({
      runId: 'r3', journal,
      model: createMockModel(async () => finalTextResult('done')),
      prompt: 'x',
      limits: { maxCostUsd: 0.01 },
    } as never)).rejects.toThrow(/exceeded the maxCostUsd limit/);
    expect(warn.mock.calls.flat().join(' ')).not.toContain('no pricing entry');
  });

  it('getRunCost still reports the tokens it could count', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const journal = new InMemoryJournal();
    await journal.put('r4:model:0', step(UNKNOWN));
    const cost = await getRunCost(journal as never, 'r4');
    expect(cost.totalTokens).toBe(2_000_000);
    expect(cost.costUsd).toBe(0);
  });
});
