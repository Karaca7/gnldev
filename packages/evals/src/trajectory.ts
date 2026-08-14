// P1.1 — Trajectory/tool-call scorer: "did the agent call the right tools, in
// The right order, without calling the wrong ones, within budget?" — the scorer at the centre of the
// Governance thesis. Built directly on `buildDecisionSequence` (@gnldev/durable/regression.ts), which was
// PRIVATE until now (exported for exactly this purpose) — no duplicate decision-sequence logic here.
//
// PURE/DETERMINISTIC: no model call, unlike llm-judge. Same decision sequence → same score, always.
//
// Three ways to use it, cheapest-to-richest:
// `createTrajectoryScorer(opts)` — pure core: scores `sample.toolCalls` (string[]) or
//    `sample.decisionPoints` (DecisionPoint[]) directly. No @gnldev/durable I/O — usable in unit tests
//    With a hand-built sequence.
// `scoreTrajectory(reader, runId, opts)` — reads `runId`'s journal via `reader.readRun`, rebuilds
//    The decision sequence, scores it. One-shot, not a Scorer.
// `trajectoryScorerFor(reader, opts)` — Scorer adapter: `score(sample)` reads `sample.runId` and
//    Delegates to `scoreTrajectory`. Drop straight into `scoreRun`/`evalDataset`'s scorer list — both
//    Populate `sample.runId` (see score-run.ts / dataset.ts) so this works with zero extra wiring.
import type { DecisionPoint, JournalReader } from '@gnldev/durable';
import { buildDecisionSequence } from '@gnldev/durable';
import type { Scorer, ScoreResult, ScoreSample } from './scorer.js';

export interface TrajectoryWeights {
  /** Weight of the ordered-subsequence-match dimension (`expectedTools`). */
  order?: number;
  /** Weight of the required-tools-present dimension (`requiredTools`). */
  required?: number;
  /** Weight of the forbidden-tools-absent dimension (`forbiddenTools`). */
  forbidden?: number;
  /** Weight of the tool-call-budget dimension (`maxToolCalls`). */
  budget?: number;
}

export interface TrajectoryScorerOptions {
  /**
   * Ordered SUBSEQUENCE match: do these tools all occur, in this relative order? Extra tool calls in
   * Between (or around) are fine — this is not a strict prefix/exact-sequence match.
   */
  expectedTools?: string[];
  /** Must occur SOMEWHERE in the run, in any order (unlike `expectedTools`, order is not checked). */
  requiredTools?: string[];
  /** Must NOT occur anywhere in the run — a hit degrades the score, in proportion to how many distinct forbidden tools were hit. */
  forbiddenTools?: string[];
  /** Total tool-call budget. Exceeding it degrades the score proportionally (`maxToolCalls / actual`), not a hard 0. */
  maxToolCalls?: number;
  /** Per-dimension weight (default: 1 — i.e. an equal split across whichever dimensions are actually configured). */
  weights?: TrajectoryWeights;
  /** Scorer name override (default `'trajectory'`). */
  name?: string;
}

/** Structural extension of ScoreSample understood by `createTrajectoryScorer`/`trajectoryScorerFor`. */
export interface TrajectorySample extends ScoreSample {
  /** Preferred input for `createTrajectoryScorer`: the ordered tool-call names for this run. */
  toolCalls?: string[];
  /** Alternative input: the raw decision sequence (as returned by `buildDecisionSequence`) — tool names are extracted from it. */
  decisionPoints?: DecisionPoint[];
  /** Input for `trajectoryScorerFor`: the runId to look up via its bound `JournalReader`. */
  runId?: string;
}

interface Dim {
  key: keyof TrajectoryWeights;
  score: number;
  label: string;
}

function dimOrder(toolNames: string[], expected: string[] | undefined): Dim | undefined {
  if (!expected || expected.length === 0) return undefined;
  let j = 0;
  for (const name of toolNames) {
    if (j < expected.length && name === expected[j]) j++;
  }
  const score = j / expected.length;
  const label =
    j === expected.length
      ? `order: ${j}/${expected.length} expected tools matched in sequence`
      : `order: ${j}/${expected.length} matched — diverged before "${expected[j]}"`;
  return { key: 'order', score, label };
}

function dimRequired(toolNames: string[], required: string[] | undefined): Dim | undefined {
  if (!required || required.length === 0) return undefined;
  const present = required.filter((t) => toolNames.includes(t));
  const missing = required.filter((t) => !toolNames.includes(t));
  const score = present.length / required.length;
  const label =
    missing.length === 0
      ? `required: all ${required.length} required tools present`
      : `required: ${present.length}/${required.length} present — missing [${missing.join(', ')}]`;
  return { key: 'required', score, label };
}

function dimForbidden(toolNames: string[], forbidden: string[] | undefined): Dim | undefined {
  if (!forbidden || forbidden.length === 0) return undefined;
  const hit = forbidden.filter((t) => toolNames.includes(t));
  const score = hit.length === 0 ? 1 : 1 - hit.length / forbidden.length;
  const label =
    hit.length === 0
      ? `forbidden: none of ${forbidden.length} forbidden tools called`
      : `forbidden: VIOLATION — [${hit.join(', ')}] called`;
  return { key: 'forbidden', score, label };
}

function dimBudget(toolNames: string[], maxToolCalls: number | undefined): Dim | undefined {
  if (maxToolCalls === undefined) return undefined;
  const n = toolNames.length;
  const score = n <= maxToolCalls ? 1 : maxToolCalls / n;
  const label =
    n <= maxToolCalls
      ? `budget: ${n}/${maxToolCalls} tool calls (within budget)`
      : `budget: EXCEEDED — ${n}/${maxToolCalls} tool calls`;
  return { key: 'budget', score, label };
}

/**
 * Scoring core (pure function, no Scorer wrapper) — shared by `createTrajectoryScorer` and
 * `scoreTrajectory`. Composite = weighted average over whichever dimensions are configured in `opts`
 * (a dimension not configured does not enter the composite at all — it's not "vacuously 1", it's
 * Simply absent, which is why omitted dimensions don't skew the weighted average). `reason` lists
 * Every active dimension's contribution + violations, joined by ` | `.
 */
export function scoreToolSequence(toolNames: string[], opts: TrajectoryScorerOptions): ScoreResult {
  const dims = [
    dimOrder(toolNames, opts.expectedTools),
    dimRequired(toolNames, opts.requiredTools),
    dimForbidden(toolNames, opts.forbiddenTools),
    dimBudget(toolNames, opts.maxToolCalls),
  ].filter((d): d is Dim => d !== undefined);

  if (dims.length === 0) {
    return { score: 1, reason: 'trajectory: no constraints configured (expectedTools/requiredTools/forbiddenTools/maxToolCalls) — vacuously 1' };
  }

  const weights = opts.weights ?? {};
  const rawWeights = dims.map((d) => weights[d.key] ?? 1);
  const totalWeight = rawWeights.reduce((a, b) => a + b, 0) || 1;

  let composite = 0;
  const parts: string[] = [];
  for (let i = 0; i < dims.length; i++) {
    const d = dims[i]!;
    const w = rawWeights[i]! / totalWeight;
    composite += d.score * w;
    parts.push(`${d.label} [score=${d.score.toFixed(2)}, weight=${w.toFixed(2)}]`);
  }
  parts.push(`=> composite ${composite.toFixed(3)}`);
  return { score: composite, reason: parts.join(' | ') };
}

function toolNamesFromDecisionPoints(points: DecisionPoint[]): string[] {
  return points.filter((p) => p.kind === 'tool' && p.toolName).map((p) => p.toolName!);
}

function toolNamesOf(sample: TrajectorySample): string[] | undefined {
  if (Array.isArray(sample.toolCalls)) return sample.toolCalls;
  if (Array.isArray(sample.decisionPoints)) return toolNamesFromDecisionPoints(sample.decisionPoints);
  return undefined;
}

/**
 * Pure/deterministic trajectory Scorer — NO model call, NO journal I/O. Reads `sample.toolCalls`
 * (ordered tool-call names, preferred) or `sample.decisionPoints` (raw `DecisionPoint[]`, e.g. from
 * `buildDecisionSequence`). Use this directly when you already have the tool sequence in hand (tests,
 * Hand-built trajectories); use `scoreTrajectory`/`trajectoryScorerFor` to score from a run's journal.
 */
export function createTrajectoryScorer(opts: TrajectoryScorerOptions = {}): Scorer {
  const name = opts.name ?? 'trajectory';
  return {
    name,
    score: (sample: TrajectorySample) => {
      const toolNames = toolNamesOf(sample);
      if (!toolNames) {
        return {
          score: 0,
          reason: `${name}: sample.toolCalls (string[]) or sample.decisionPoints (DecisionPoint[]) required — see createTrajectoryScorer`,
        };
      }
      return scoreToolSequence(toolNames, opts);
    },
  };
}

/**
 * Reads `runId`'s journal trace (`reader.readRun`), rebuilds its decision sequence
 * (`buildDecisionSequence`), extracts the ordered tool-call names, scores them against `opts`. Not a
 * Scorer itself — a one-shot function; see `trajectoryScorerFor` for the Scorer adapter.
 */
export async function scoreTrajectory(reader: JournalReader, runId: string, opts: TrajectoryScorerOptions = {}): Promise<ScoreResult> {
  const entries = await reader.readRun(runId);
  const points = buildDecisionSequence(entries);
  return scoreToolSequence(toolNamesFromDecisionPoints(points), opts);
}

/**
 * Scorer adapter over `scoreTrajectory`: `score(sample)` reads `sample.runId` (populated
 * Automatically by `scoreRun` and `evalDataset` — see score-run.ts/dataset.ts) and looks the run up in
 * `reader`. Drop into any `Scorer[]` list (`scoreRun`, `evalDataset`) alongside llm-judge/rule-based
 * Scorers — no special-casing needed at the call site.
 */
export function trajectoryScorerFor(reader: JournalReader, opts: TrajectoryScorerOptions = {}): Scorer {
  const name = opts.name ?? 'trajectory';
  return {
    name,
    score: async (sample: TrajectorySample) => {
      const runId = sample.runId;
      if (typeof runId !== 'string' || runId.length === 0) {
        return { score: 0, reason: `${name}: sample.runId required — see trajectoryScorerFor (scoreRun/evalDataset populate it automatically)` };
      }
      return scoreTrajectory(reader, runId, opts);
    },
  };
}
