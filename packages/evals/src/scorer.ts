// Scorer interface + rule-based built-ins (deterministic → same sample, same score).

export interface ScoreSample {
  /** The output being scored (usually the agent's final text). */
  output: string;
  /** Expected/reference value (for exactMatch/contains). */
  expected?: string;
  /** Optional extra context. */
  input?: string;
  /**
   * CONVENTION: the RAG/retrieval context read by context-based LLM-judge scorers (see `scorers.ts` —
   * Faithfulness, hallucination, contextPrecision). Can be a single string or multiple retrieved
   * Chunks (string[]). If this field is missing/empty, those scorers do NOT silently return 1.0 —
   * They return score 0 + "context required" in the reason.
   */
  context?: string | string[];
  /**
   * CONVENTION (P1.1): the durable runId this sample was produced from, if any.
   * Populated automatically by `scoreRun` and `evalDataset` (see score-run.ts/dataset.ts) — lets
   * Journal-backed scorers (e.g. `trajectoryScorerFor` in trajectory.ts) look the run back up without
   * Every caller having to thread it through by hand.
   */
  runId?: string;
  [k: string]: unknown;
}

export interface ScoreResult {
  /** 0.0–1.0. */
  score: number;
  reason?: string;
}

export interface Scorer {
  name: string;
  score(sample: ScoreSample): Promise<ScoreResult> | ScoreResult;
}

/** Is the output exactly equal to expected (trimmed)? */
export function exactMatch(): Scorer {
  return {
    name: 'exact-match',
    score: (s) => {
      const ok = (s.output ?? '').trim() === (s.expected ?? '').trim();
      return { score: ok ? 1 : 0, reason: ok ? 'exactly equal' : 'not equal' };
    },
  };
}

/** Does the output contain the given substring (or expected, if not given)? */
export function contains(substr?: string): Scorer {
  return {
    name: 'contains',
    score: (s) => {
      const needle = substr ?? s.expected ?? '';
      const ok = needle.length > 0 && (s.output ?? '').includes(needle);
      return { score: ok ? 1 : 0, reason: ok ? `"${needle}" found` : `"${needle}" missing` };
    },
  };
}

/** Does the output match the regex? */
export function regexScore(re: RegExp): Scorer {
  return {
    name: 'regex',
    score: (s) => {
      const ok = new RegExp(re.source, re.flags).test(s.output ?? '');
      return { score: ok ? 1 : 0, reason: ok ? 'regex matched' : 'regex did not match' };
    },
  };
}

/** Cosine similarity between two vectors (clamped to 0..1; 0 for a zero vector). */
function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  const sim = dot / (Math.sqrt(na) * Math.sqrt(nb));
  return sim < 0 ? 0 : sim > 1 ? 1 : sim;
}

/**
 * Semantic similarity scorer: vectorizes output and expected with `embed` and returns their cosine
 * Similarity as the score — catches near-meaning matches that exact string matching would miss.
 * `embed` is provider-agnostic: e.g. for the AI SDK, `(t) => embed({ model, value: t }).then(r => r.embedding)`.
 * If `threshold` is given, `score` is 0 below / 1 above that threshold (pass-fail); otherwise the raw
 * Similarity (0..1).
 */
export function embeddingSimilarity(
  embed: (text: string) => Promise<number[]>,
  opts?: { threshold?: number },
): Scorer {
  return {
    name: 'embedding-similarity',
    score: async (s) => {
      const [ov, ev] = await Promise.all([embed(s.output ?? ''), embed(s.expected ?? '')]);
      const sim = cosine(ov, ev);
      if (opts?.threshold !== undefined) {
        const ok = sim >= opts.threshold;
        return { score: ok ? 1 : 0, reason: `similarity ${sim.toFixed(3)} ${ok ? '≥' : '<'} threshold ${opts.threshold}` };
      }
      return { score: sim, reason: `cosine similarity ${sim.toFixed(3)}` };
    },
  };
}
