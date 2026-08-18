// Approximate model pricing table ($/1M tokens). The user can override it (getRunCost opts.pricing).
import type { Journal } from './journal.js';

export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
  cachedInputPer1M?: number;
}

/**
 * List prices in USD per 1M tokens, transcribed from the vendors' own pricing pages on 2026-08-18:
 * platform.claude.com/docs/en/about-claude/pricing and developers.openai.com/api/docs/pricing.
 *
 * A ceiling is only as good as this table. `priceFor` returns undefined for a model that is not here,
 * `costOf` is never called, and the step costs 0 — so `maxCostUsd` and an organization's usdLimit
 * silently do not fire. The table previously stopped at the generation that existed when it was
 * written, which meant every current model fell through that hole: the ceiling was decorative for
 * essentially every real deployment. It also priced `claude-opus-4` at $5/$25 — that is Opus 4.5's
 * price; Opus 4 and 4.1 list at $15/$75, so a run on them was billed to the caller at a third of what
 * it cost, in the one number a spend limit reads.
 *
 * Keys are matched by LONGEST PREFIX (see `priceFor`), which is what lets a dated id like
 * `claude-haiku-4-5-20251001` or `gpt-4o-2024-08-06` resolve. It also means a shorter key silently
 * covers every longer one, so a family whose versions are priced differently needs a row per version:
 * `claude-opus-4` covers Opus 4 and 4.1 at $15/$75, and 4.5 through 4.8 each say $5/$25 themselves.
 * pricing.test.ts pins that resolution so a new row cannot quietly capture a neighbour.
 *
 * `cachedInputPer1M` is the cache READ (hit) rate. Cache WRITES cost more than base input on Anthropic
 * (1.25x for 5m, 2x for 1h) and are not modelled here — an accepted under-count, not an oversight.
 *
 * These are list prices: they ignore batch (-50%), data-residency (1.1x) and negotiated discounts, and
 * they go stale when a vendor changes them. For billing, override with `getRunCost({ pricing })` or the
 * journal's `__pricing__` document rather than trusting this.
 */
export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  // ── Anthropic ────────────────────────────────────────────────────────────────
  'claude-opus-4': { inputPer1M: 15, outputPer1M: 75, cachedInputPer1M: 1.5 }, // Opus 4 and 4.1
  'claude-opus-4-5': { inputPer1M: 5, outputPer1M: 25, cachedInputPer1M: 0.5 },
  'claude-opus-4-6': { inputPer1M: 5, outputPer1M: 25, cachedInputPer1M: 0.5 },
  'claude-opus-4-7': { inputPer1M: 5, outputPer1M: 25, cachedInputPer1M: 0.5 },
  'claude-opus-4-8': { inputPer1M: 5, outputPer1M: 25, cachedInputPer1M: 0.5 },
  'claude-opus-5': { inputPer1M: 5, outputPer1M: 25, cachedInputPer1M: 0.5 },
  'claude-sonnet-4': { inputPer1M: 3, outputPer1M: 15, cachedInputPer1M: 0.3 }, // Sonnet 4, 4.5, 4.6
  'claude-sonnet-5': { inputPer1M: 2, outputPer1M: 10, cachedInputPer1M: 0.2 },
  'claude-haiku-3-5': { inputPer1M: 0.8, outputPer1M: 4, cachedInputPer1M: 0.08 },
  'claude-haiku-4': { inputPer1M: 1, outputPer1M: 5, cachedInputPer1M: 0.1 }, // Haiku 4.5
  'claude-fable-5': { inputPer1M: 10, outputPer1M: 50, cachedInputPer1M: 1 },
  'claude-mythos-5': { inputPer1M: 10, outputPer1M: 50, cachedInputPer1M: 1 },
  // ── OpenAI ───────────────────────────────────────────────────────────────────
  'gpt-4o': { inputPer1M: 2.5, outputPer1M: 10, cachedInputPer1M: 1.25 },
  'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.6, cachedInputPer1M: 0.075 },
  'gpt-4.1': { inputPer1M: 2, outputPer1M: 8, cachedInputPer1M: 0.5 },
  'gpt-4.1-mini': { inputPer1M: 0.4, outputPer1M: 1.6, cachedInputPer1M: 0.1 },
  'gpt-4.1-nano': { inputPer1M: 0.1, outputPer1M: 0.4, cachedInputPer1M: 0.025 },
  'gpt-5': { inputPer1M: 1.25, outputPer1M: 10, cachedInputPer1M: 0.125 },
  'gpt-5-mini': { inputPer1M: 0.25, outputPer1M: 2, cachedInputPer1M: 0.025 },
  'gpt-5-nano': { inputPer1M: 0.05, outputPer1M: 0.4, cachedInputPer1M: 0.005 },
  'gpt-5-pro': { inputPer1M: 15, outputPer1M: 120 },
  'gpt-5.1': { inputPer1M: 1.25, outputPer1M: 10, cachedInputPer1M: 0.125 },
  'gpt-5.2': { inputPer1M: 1.75, outputPer1M: 14, cachedInputPer1M: 0.175 },
  'gpt-5.4': { inputPer1M: 2.5, outputPer1M: 15, cachedInputPer1M: 0.25 },
  'gpt-5.5': { inputPer1M: 5, outputPer1M: 30, cachedInputPer1M: 0.5 },
  'gpt-5.6-luna': { inputPer1M: 0.2, outputPer1M: 1.2, cachedInputPer1M: 0.02 },
  'o1': { inputPer1M: 15, outputPer1M: 60, cachedInputPer1M: 7.5 },
  'o1-pro': { inputPer1M: 150, outputPer1M: 600 },
  'o3': { inputPer1M: 2, outputPer1M: 8, cachedInputPer1M: 0.5 },
  'o3-mini': { inputPer1M: 1.1, outputPer1M: 4.4, cachedInputPer1M: 0.55 },
  'o3-pro': { inputPer1M: 20, outputPer1M: 80 },
  'o4-mini': { inputPer1M: 1.1, outputPer1M: 4.4, cachedInputPer1M: 0.275 },
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
  /**
   * Use `models` as the WHOLE table instead of layering it over DEFAULT_PRICING. Off by default.
   *
   * Layering is the default because the realistic edit is "the provider released a model the shipped
   * table has never heard of, or changed one price". Replacing on every write turns that one edit into
   * silently un-pricing every other model — and an un-priced model costs 0, so the visible symptom is
   * not an error but a spend ceiling that quietly stops working. Anyone who genuinely wants only their
   * own prices can say so here.
   */
  replace?: boolean;
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
  if (!doc?.models) return DEFAULT_PRICING;
  // Layered, not replaced — see PricingDoc.replace for why that is the safe default.
  return doc.replace ? doc.models : { ...DEFAULT_PRICING, ...doc.models };
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
  // Callers hand this the FLATTENED usage (see sdk-compat.flattenUsage), so `cachedTokens` here is
  // gnl's own normalised field — not the SDK's. Reading the SDK object directly is what made the
  // cache discount dead code on every version: no AI SDK release has ever had `usage.cachedTokens`.
  const cached = usage?.cachedTokens ?? 0;
  const input = Math.max(0, (usage?.inputTokens ?? 0) - cached);
  const output = usage?.outputTokens ?? 0;
  return (
    (input / 1e6) * pricing.inputPer1M +
    (cached / 1e6) * (pricing.cachedInputPer1M ?? pricing.inputPer1M) +
    (output / 1e6) * pricing.outputPer1M
  );
}
