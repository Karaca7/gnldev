// Which row a real, dated model id actually resolves to.
//
// `priceFor` matches by LONGEST PREFIX, so the table's keys are not independent: a short key silently
// covers every longer id in its family. That is the mechanism that lets `claude-haiku-4-5-20251001`
// resolve at all — and the same mechanism that had `claude-opus-4` (list price $15/$75) handing out
// Opus 4.5's $5/$25 to everything from Opus 4 onward. A spend ceiling reading that number was a third
// of the truth.
//
// So the guard is not "the table has N rows" but "these ids resolve to these prices". Ids are written
// the way providers emit them, dates included, because the dated form is what actually arrives in a
// journal record and the undated form is the easy case.
import { describe, it, expect } from 'vitest';
import { priceFor, DEFAULT_PRICING } from '../src/pricing.js';

/** id → [input $/1M, output $/1M] as listed by the vendor on 2026-08-18. */
const RESOLVES: Array<[string, number, number]> = [
  // The split that was wrong. Opus 4 and 4.1 are the expensive, retired generation; 4.5 onward is not.
  ['claude-opus-4-20250514', 15, 75],
  ['claude-opus-4-1-20250805', 15, 75],
  ['claude-opus-4-5-20251101', 5, 25],
  ['claude-opus-4-6', 5, 25],
  ['claude-opus-4-7', 5, 25],
  ['claude-opus-4-8', 5, 25],
  ['claude-opus-5', 5, 25],
  // Sonnet 5 is CHEAPER than Sonnet 4 — a family where the newer model must not inherit the older row.
  ['claude-sonnet-4-20250514', 3, 15],
  ['claude-sonnet-4-5-20250929', 3, 15],
  ['claude-sonnet-4-6', 3, 15],
  ['claude-sonnet-5', 2, 10],
  ['claude-haiku-3-5-20241022', 0.8, 4],
  ['claude-haiku-4-5-20251001', 1, 5],
  ['claude-fable-5', 10, 50],
  ['claude-mythos-5', 10, 50],
  // OpenAI: every one of these is a longer id that must NOT fall back to its shorter sibling.
  ['gpt-4o-2024-08-06', 2.5, 10],
  ['gpt-4o-mini-2024-07-18', 0.15, 0.6],
  ['gpt-4.1', 2, 8],
  ['gpt-4.1-mini', 0.4, 1.6],
  ['gpt-4.1-nano', 0.1, 0.4],
  ['gpt-5', 1.25, 10],
  ['gpt-5-mini', 0.25, 2],
  ['gpt-5-nano', 0.05, 0.4],
  ['gpt-5-pro', 15, 120],
  ['gpt-5.1', 1.25, 10],
  ['gpt-5.2', 1.75, 14],
  ['gpt-5.4', 2.5, 15],
  ['gpt-5.5', 5, 30],
  ['gpt-5.6-luna', 0.2, 1.2],
  ['o1', 15, 60],
  ['o1-pro', 150, 600],
  ['o3', 2, 8],
  ['o3-mini', 1.1, 4.4],
  ['o3-pro', 20, 80],
  ['o4-mini', 1.1, 4.4],
];

describe('DEFAULT_PRICING resolution', () => {
  for (const [id, input, output] of RESOLVES) {
    it(`${id} → $${input}/$${output}`, () => {
      const p = priceFor(id, DEFAULT_PRICING);
      expect(p, `${id} resolves to no row — a ceiling over it silently does nothing`).toBeDefined();
      expect(p!.inputPer1M, `${id} input`).toBe(input);
      expect(p!.outputPer1M, `${id} output`).toBe(output);
    });
  }

  it('a model outside the table resolves to nothing rather than to a neighbour', () => {
    // The other direction: prefix matching must not be so eager that an unrelated id picks up a price.
    // `unpriced-model.test.ts` covers what the runtime then does about it.
    expect(priceFor('mistral-large-2411', DEFAULT_PRICING)).toBeUndefined();
    expect(priceFor('llama-3.3-70b', DEFAULT_PRICING)).toBeUndefined();
    expect(priceFor('acme-internal/finetune-2026-08', DEFAULT_PRICING)).toBeUndefined();
  });

  it('every row prices both directions and never negative', () => {
    for (const [id, p] of Object.entries(DEFAULT_PRICING)) {
      expect(p.inputPer1M, `${id} input`).toBeGreaterThan(0);
      expect(p.outputPer1M, `${id} output`).toBeGreaterThan(0);
      // Output costs more than input on every model either vendor sells; a row where that flipped
      // would almost certainly be a transcription slip.
      expect(p.outputPer1M, `${id}: output cheaper than input — check the transcription`).toBeGreaterThan(p.inputPer1M);
      if (p.cachedInputPer1M !== undefined) {
        expect(p.cachedInputPer1M, `${id} cache read`).toBeGreaterThan(0);
        expect(p.cachedInputPer1M, `${id}: a cache hit must not cost more than fresh input`).toBeLessThanOrEqual(p.inputPer1M);
      }
    }
  });
});
