// @gnldev/evals — scorer + LLM-judge for @gnldev/durable runs. scoreRun produces
// deterministic & replayable scores from the journal trace (if the journal is writable, memoized → same score on resume).
export { exactMatch, contains, regexScore, embeddingSimilarity } from './scorer.js';
export type { Scorer, ScoreSample, ScoreResult } from './scorer.js';
export { llmJudge } from './llm-judge.js';
export type { LlmJudgeOptions } from './llm-judge.js';
export {
  faithfulness,
  hallucination,
  answerRelevancy,
  toxicity,
  bias,
  completeness,
  contextPrecision,
  toneConsistency,
} from './scorers.js';
export type { JudgeScorerOptions, ToneConsistencyOptions } from './scorers.js';
export { scoreRun } from './score-run.js';
export type { ScoreRunResult } from './score-run.js';
export { evalDataset } from './dataset.js';
export type { Dataset, DatasetCase, EvalRunner, EvalCaseResult, EvalDatasetResult, EvalDatasetOptions } from './dataset.js';
export { createDatasetsManager } from './datasets-manager.js';
export type { DatasetVersion, ExperimentRecord, ExperimentDiff, RunExperimentOptions } from './datasets-manager.js';
// P1.1 (AUDIT-R2): trajectory/tool-call scorer — scores a run's decision sequence
// (buildDecisionSequence, @gnldev/durable) against expected/required/forbidden tools + a call budget.
export { createTrajectoryScorer, scoreTrajectory, trajectoryScorerFor, scoreToolSequence } from './trajectory.js';
export type { TrajectoryScorerOptions, TrajectoryWeights, TrajectorySample } from './trajectory.js';
// P1.3 (AUDIT-R2): 4 free, deterministic, model-free text scorers (no llm-judge cost).
export { contentSimilarity, keywordCoverage, textualDifference, answerSimilarity } from './text-scorers.js';
export type { KeywordCoverageOptions } from './text-scorers.js';
