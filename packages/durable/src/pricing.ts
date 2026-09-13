// Approximate model pricing table ($/1M tokens). The user can override it (getRunCost opts.pricing).
import type { Journal } from './journal.js';
import { orgParentOf } from './organization.js';

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
 * editable from Studio, pricing is updated without requiring a deploy. Each write increments `version`
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
  const own = await journal.get<PricingDoc>(PRICING_KEY);
  if (own) return own;
  // An organization-scoped journal prefixes every key, so a document written at the root — which is
  // where Studio and the CLI write it, both requiring an unbound platform admin — is invisible from
  // inside a scope. Falling back to the parent makes the global table reachable while leaving room for
  // a per-organization override to win: the scoped read is tried first.
  const parent = orgParentOf(journal);
  return typeof parent?.get === 'function' ? parent.get<PricingDoc>(PRICING_KEY) : undefined;
}

/** Effective pricing table: journal `__pricing__` (if present) > DEFAULT_PRICING (fallback). */
export async function effectivePricingTable(journal: Partial<Journal>): Promise<Record<string, ModelPricing>> {
  const doc = await readPricing(journal);
  if (!doc?.models) return DEFAULT_PRICING;
  // Layered, not replaced — see PricingDoc.replace for why that is the safe default.
  return doc.replace ? doc.models : { ...DEFAULT_PRICING, ...doc.models };
}

/**
 * Whether a table row can actually be multiplied by a token count.
 *
 * The `__pricing__` document is documented as editable through Studio, through `gnl pricing`, OR
 * directly in the journal. Studio's PUT validates every number; a direct write validates nothing, and
 * a row like `{ inputPer1M: 'free' }` is the shape someone reaches for. That row used to be returned
 * as a price, `costOf` multiplied by a string, and every cost downstream became NaN.
 *
 * NaN is the worst possible value here because `NaN > limit` is FALSE: the run does not exceed the
 * ceiling, it stops being comparable to it. Measured, a 10M-token step under `maxCostUsd: 0.01` with
 * `limits.strict: true` threw nothing and warned nothing — while the same run with the model simply
 * ABSENT from the table failed loudly. Writing a broken price was quieter than writing none.
 *
 * Treated as "no price" so the existing unpriced machinery — the strict throw and the fail-open
 * warning in limits.ts — handles it, rather than growing a second, parallel notion of a bad price.
 */
function isUsablePrice(row: unknown): row is ModelPricing {
  const r = row as ModelPricing | undefined;
  if (!r || typeof r !== 'object') return false;
  for (const v of [r.inputPer1M, r.outputPer1M]) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return false;
  }
  // Optional, but if present it is multiplied too, so the same rule applies.
  const cached = r.cachedInputPer1M;
  if (cached !== undefined && (typeof cached !== 'number' || !Number.isFinite(cached) || cached < 0)) return false;
  return true;
}

/** One warning per bad row per process — a broken price must be loud, but not once per step. */
const warnedBadPrice = new Set<string>();

function rejectBadPrice(modelId: string, key: string): undefined {
  if (!warnedBadPrice.has(key)) {
    warnedBadPrice.add(key);
    console.warn(
      `@gnldev/durable: the __pricing__ entry for '${key}' is not a usable price (inputPer1M and ` +
        'outputPer1M must be finite non-negative numbers), so it is being IGNORED' +
        (key === modelId ? '' : ` while pricing '${modelId}'`) +
        '. Fix it via Studio, `gnl pricing set`, or the journal document — until then these steps ' +
        'count as unpriced.',
    );
  }
  return undefined;
}

/**
 * Pricing for modelId: EXACT match FIRST, otherwise a REAL prefix match (`modelId.startsWith(p)` —
 * the previous `includes` was WRONG because it also counted any substring appearing anywhere as a
 * "prefix"). If multiple prefixes match, the LONGEST (most specific) wins (e.g. for 'openai/gpt-4o-mini'
 * with no exact table entry, the 'openai/gpt-4o' prefix wins if it's shorter than the
 * 'openai/gpt-4o-mini-preview' prefix).
 */
export function priceFor(
  modelId: string,
  table: Record<string, ModelPricing> = DEFAULT_PRICING,
): ModelPricing | undefined {
  // `Object.hasOwn`, not truthiness: `table[modelId]` walks the PROTOTYPE chain, so a model id of
  // 'constructor', 'toString', 'valueOf' or '__proto__' returned an inherited function or Object.prototype
  // itself. `costOf` then multiplied by undefined and produced NaN — and `NaN > limit` is false, so the
  // spend ceiling stopped firing entirely. Measured: priceFor('constructor') → a function, costUsd NaN.
  // Contrived as an attack, ordinary as a bug: any id that happens to name an Object member did it.
  // Object.keys already yields own enumerable keys only, so the prefix path was never exposed to this.
  const key = Object.hasOwn(table, modelId)
    ? modelId
    : Object.keys(table)
      .filter((p) => modelId.startsWith(p))
      .sort((a, b) => b.length - a.length)[0];
  if (key === undefined) return undefined;
  // Validated AFTER the row is chosen, deliberately: an unusable row is not skipped so a shorter
  // prefix can win it. The user named a price for this model — charging it at some other row's rate
  // would replace a missing number with a WRONG one, which is harder to notice than an absence.
  return isUsablePrice(table[key]) ? table[key] : rejectBadPrice(modelId, key);
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
