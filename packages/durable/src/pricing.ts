// Approximate model pricing table ($/1M tokens). The user can override it (getRunCost opts.pricing).
import type { Journal } from './journal.js';

export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
  cachedInputPer1M?: number;
}

export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  'claude-opus-4': { inputPer1M: 5, outputPer1M: 25, cachedInputPer1M: 0.5 },
  'claude-sonnet-4': { inputPer1M: 3, outputPer1M: 15, cachedInputPer1M: 0.3 },
  'claude-haiku-4': { inputPer1M: 1, outputPer1M: 5, cachedInputPer1M: 0.1 },
  'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.6 },
  'gpt-4o': { inputPer1M: 2.5, outputPer1M: 10 },
  'gpt-4.1-mini': { inputPer1M: 0.4, outputPer1M: 1.6 },
  'o4-mini': { inputPer1M: 1.1, outputPer1M: 4.4 },
};

/**
 * A VERSIONED pricing document living in the journal (same pattern as policy.ts/budget.ts) —
 * Editable from Studio, pricing is updated without requiring a deploy. Each write increments `version`
 * (full history via audit, see PolicyDoc).
 */
export interface PricingDoc {
  version: number;
  models: Record<string, ModelPricing>;
  updatedAt?: number;
}

/** The journal key for the pricing document — invisible to parseJournalKey (same pattern as policy/budget). */
export const PRICING_KEY = '__pricing__';

/** Reads the pricing document from the journal LIVE (undefined if absent — caller falls back to DEFAULT_PRICING). */
export async function readPricing(journal: Partial<Journal>): Promise<PricingDoc | undefined> {
  if (typeof journal.get !== 'function') return undefined;
  return journal.get<PricingDoc>(PRICING_KEY);
}

/** Effective pricing table: journal `__pricing__` (if present) > DEFAULT_PRICING (fallback). */
export async function effectivePricingTable(journal: Partial<Journal>): Promise<Record<string, ModelPricing>> {
  const doc = await readPricing(journal);
  return doc?.models ?? DEFAULT_PRICING;
}

/**
 * Pricing for modelId: EXACT match FIRST, otherwise a REAL prefix match (`modelId.startsWith(p)` —
 * The previous `includes` was WRONG because it also counted any substring appearing anywhere as a
 * "prefix"). If multiple prefixes match, the LONGEST (most specific) wins (e.g. for 'openai/gpt-4o-mini'
 * With no exact table entry, the 'openai/gpt-4o' prefix wins if it's shorter than the
 * 'openai/gpt-4o-mini-preview' prefix).
 */
export function priceFor(
  modelId: string,
  table: Record<string, ModelPricing> = DEFAULT_PRICING,
): ModelPricing | undefined {
  if (table[modelId]) return table[modelId];
  const key = Object.keys(table)
    .filter((p) => modelId.startsWith(p))
    .sort((a, b) => b.length - a.length)[0];
  return key ? table[key] : undefined;
}

/** The USD cost of a usage record (cached tokens are priced separately). */
export function costOf(usage: any, pricing: ModelPricing): number {
  const cached = usage?.cachedTokens ?? 0;
  const input = Math.max(0, (usage?.inputTokens ?? 0) - cached);
  const output = usage?.outputTokens ?? 0;
  return (
    (input / 1e6) * pricing.inputPer1M +
    (cached / 1e6) * (pricing.cachedInputPer1M ?? pricing.inputPer1M) +
    (output / 1e6) * pricing.outputPer1M
  );
}
