// P1.3 — 4 free, deterministic, model-free text scorers (parity with the common
// Non-LLM-judge scorer set). Zero deps, zero I/O, same {name, score} Scorer shape as scorer.ts/
// Scorers.ts. Every scorer here is a pure function of (output, expected) → same inputs, same score,
// Every call — unlike llm-judge, there is no cost and no non-determinism to worry about.
import type { Scorer } from './scorer.js';

// ── shared primitives ───────────────────────────────────────────────────────

/** Word/number tokens, lower-cased, Unicode-aware (\p{L}/\p{N} — not just ASCII). */
function tokenize(text: string): string[] {
  return (text ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function countMap(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

/** Character bigrams (multiset, via a count map — repeated bigrams count more than once, Dice-style). */
function bigramCounts(s: string): Map<string, number> {
  const t = s.toLowerCase();
  const m = new Map<string, number>();
  for (let i = 0; i < t.length - 1; i++) {
    const bg = t.slice(i, i + 2);
    m.set(bg, (m.get(bg) ?? 0) + 1);
  }
  return m;
}

/**
 * Sørensen–Dice coefficient over character bigrams: 2*|intersection| / (|A|+|B|) (bigram multisets).
 * CHOSEN OVER Levenshtein for `contentSimilarity` because: (1) it's already bounded to [0,1] with no
 * Extra normalization step (Levenshtein needs distance/maxLen, which itself is a judgment call — see
 * `textualDifference` below, which uses Levenshtein deliberately, for contrast); (2) O(n+m) via two
 * Count maps vs Levenshtein's O(n*m) DP; (3) bigram overlap is more forgiving of reordering/insertions
 * (a moved clause barely moves the score), which suits "is this roughly the same content" better than
 * Character-edit-distance, which is more suited to "how many edits away" (textualDifference's job).
 */
function diceBigramSimilarity(a: string, b: string): number {
  const A = (a ?? '').trim();
  const B = (b ?? '').trim();
  if (A === B) return 1;
  if (A.length < 2 || B.length < 2) return A.toLowerCase() === B.toLowerCase() ? 1 : 0;
  const bgA = bigramCounts(A);
  const bgB = bigramCounts(B);
  let intersection = 0;
  let totalA = 0;
  for (const [bg, c] of bgA) {
    totalA += c;
    const other = bgB.get(bg);
    if (other) intersection += Math.min(c, other);
  }
  let totalB = 0;
  for (const c of bgB.values()) totalB += c;
  const total = totalA + totalB;
  return total === 0 ? 0 : (2 * intersection) / total;
}

/** Classic Levenshtein edit distance (single-row DP, O(n*m) time / O(min(n,m)) space). */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j]!;
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j]!, dp[j - 1]!);
      prev = tmp;
    }
  }
  return dp[n]!;
}

// ── scorers ──────────────────────────────────────────────────────────────

/**
 * Content similarity: Dice's coefficient over character bigrams between `output` and `expected` (see
 * `diceBigramSimilarity` for why Dice over Levenshtein was picked here). 1.0 = identical/near-identical
 * Content, 0.0 = no shared bigrams at all. Model-free, deterministic.
 */
export function contentSimilarity(opts?: { name?: string }): Scorer {
  const name = opts?.name ?? 'content-similarity';
  return {
    name,
    score: (s) => {
      const sim = diceBigramSimilarity(s.output ?? '', s.expected ?? '');
      return { score: sim, reason: `dice bigram similarity ${sim.toFixed(3)}` };
    },
  };
}

export interface KeywordCoverageOptions {
  /** Explicit keyword list. If omitted, keywords are derived from `sample.expected` (tokenized, deduped). */
  keywords?: string[];
  name?: string;
}

/**
 * Keyword coverage: fraction of expected keywords found (case-insensitive substring match) anywhere
 * In `output`. Keywords come from `opts.keywords` if given, else from `sample.expected` (tokenized —
 * See `tokenize`). 1.0 = every keyword present, 0.0 = none. 0 keywords available (no `opts.keywords`
 * AND no/empty `sample.expected`) → score 0 with a clear reason (not vacuously 1).
 */
export function keywordCoverage(opts?: KeywordCoverageOptions): Scorer {
  const name = opts?.name ?? 'keyword-coverage';
  return {
    name,
    score: (s) => {
      const keywords = opts?.keywords && opts.keywords.length > 0 ? opts.keywords : Array.from(new Set(tokenize(s.expected ?? '')));
      if (keywords.length === 0) {
        return { score: 0, reason: `${name}: no keywords — pass opts.keywords or a non-empty sample.expected` };
      }
      const outputLower = (s.output ?? '').toLowerCase();
      const present = keywords.filter((k) => outputLower.includes(k.toLowerCase()));
      const missing = keywords.filter((k) => !present.includes(k));
      const score = present.length / keywords.length;
      const reason =
        missing.length === 0
          ? `all ${keywords.length} keywords present`
          : `${present.length}/${keywords.length} present — missing [${missing.join(', ')}]`;
      return { score, reason };
    },
  };
}

/**
 * Textual difference: `1 - normalized Levenshtein distance` between `output` and `expected`
 * (distance / max(len(output), len(expected))). Deliberately edit-distance-based rather than
 * Bigram-overlap-based (see `diceBigramSimilarity`'s JSDoc) — this scorer is meant to answer "how many
 * Character-level edits away is this", which penalizes reordering/shifts that bigram overlap can mask.
 * 1.0 = identical, 0.0 = maximally different (edit distance ≥ max length). Both empty → 1.0.
 */
export function textualDifference(opts?: { name?: string }): Scorer {
  const name = opts?.name ?? 'textual-difference';
  return {
    name,
    score: (s) => {
      const a = s.output ?? '';
      const b = s.expected ?? '';
      const maxLen = Math.max(a.length, b.length);
      if (maxLen === 0) return { score: 1, reason: 'both output and expected are empty' };
      const dist = levenshtein(a, b);
      const ratio = Math.min(1, dist / maxLen);
      const score = 1 - ratio;
      return { score, reason: `levenshtein distance ${dist}/${maxLen} (ratio ${ratio.toFixed(3)}) → score ${score.toFixed(3)}` };
    },
  };
}

/**
 * Answer similarity: token-overlap F1 between `output` and `expected` (precision = overlap/|output
 * Tokens|, recall = overlap/|expected tokens|, score = harmonic mean). THE CI ground-truth scorer —
 * Cheap/deterministic stand-in for "does this answer match the reference answer" without needing an
 * LLM judge or exact string match (robust to reordering/paraphrasing at the token-multiset level,
 * Unlike `exactMatch`). Both empty → 1.0; exactly one empty → 0.0.
 */
export function answerSimilarity(opts?: { name?: string }): Scorer {
  const name = opts?.name ?? 'answer-similarity';
  return {
    name,
    score: (s) => {
      const outTokens = tokenize(s.output ?? '');
      const expTokens = tokenize(s.expected ?? '');
      if (outTokens.length === 0 && expTokens.length === 0) {
        return { score: 1, reason: 'both output and expected have no tokens' };
      }
      if (outTokens.length === 0 || expTokens.length === 0) {
        return { score: 0, reason: 'one of output/expected has no tokens to compare' };
      }
      const outCounts = countMap(outTokens);
      const expCounts = countMap(expTokens);
      let overlap = 0;
      for (const [tok, c] of outCounts) {
        const e = expCounts.get(tok);
        if (e) overlap += Math.min(c, e);
      }
      const precision = overlap / outTokens.length;
      const recall = overlap / expTokens.length;
      const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
      return { score: f1, reason: `token F1 ${f1.toFixed(3)} (precision ${precision.toFixed(3)}, recall ${recall.toFixed(3)}, overlap ${overlap})` };
    },
  };
}
