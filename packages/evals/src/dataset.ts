// Batch eval over a dataset: run an agent on N test cases + score + aggregate. **Durable twist:**
// each case is a durable run (`run` wraps runDurable) + the case result is memoized in the journal →
// a **resumable eval suite** (crash mid-suite → completed cases are skipped, the rest run). Most eval
// frameworks have no such determinism/resume.
//
// P1.4 concurrency/timeout/retry. `concurrency` defaults to 1 — EXACTLY the
// previous sequential `for` loop's behaviour (same order, same one-at-a-time journal writes). Raising
// it runs cases through a small in-house promise pool; per-case journal memoization is UNAFFECTED
// because each case's `durableProcessorStep` key (`case:${c.id}`) is disjoint — concurrent cases never
// contend on the same journal key, so "a completed case is skipped on the next run" still holds
// exactly, at any concurrency.
import { durableProcessorStep } from '@gnldev/durable';
import type { Journal } from '@gnldev/durable';
import type { Scorer, ScoreResult } from './scorer.js';

export interface DatasetCase {
  id: string;
  input: any;
  expected?: string;
  metadata?: Record<string, unknown>;
}

export interface Dataset {
  id: string;
  cases: DatasetCase[];
}

export type EvalRunner = (input: any, ctx: { runId: string; caseId: string }) => Promise<{ output: string } | string>;

export interface EvalCaseResult {
  caseId: string;
  output: string;
  scores: Record<string, ScoreResult>;
  /**
   * P1.4: present only if the case FAILED (timed out, or threw on every attempt including retries).
   * The case still gets an entry in `EvalCaseResult[]` (`output: ''`, `scores: {}`) — a failing case
   * does NOT abort the suite, it degrades that case's contribution to `aggregate` to 0 per scorer
   * (see `evalDataset`'s aggregate loop, which already defaults a missing score to 0).
   */
  error?: string;
}

export interface EvalDatasetResult {
  datasetId: string;
  cases: EvalCaseResult[];
  /** Scorer name → average score. */
  aggregate: Record<string, number>;
}

export interface EvalDatasetOptions {
  dataset: Dataset;
  run: EvalRunner;
  scorers: Scorer[];
  /** If given, case results are memoized → resumable suite. */
  journal?: Journal;
  /**
   * Memoization scope (default `dataset.id`). If you're going to run the SAME dataset multiple times
   * under DIFFERENT conditions (experiment/model), give each run a different scope — otherwise the
   * second run replays the first run's journaled case results (DatasetsManager's runExperiment does
   * this automatically per experiment).
   */
  scope?: string;
  /**
   * P1.4: how many cases run in parallel. Default 1 — identical to the original sequential `for` loop
   * (same order, same one-case-at-a-time journal writes). Values >1 run cases through a small
   * in-house promise pool; `EvalCaseResult[]` stays in `dataset.cases` order regardless of completion
   * order.
   */
  concurrency?: number;
  /** P1.4: per-case wall-clock timeout (covers `run` + all scorers for that case). No timeout by default. */
  itemTimeoutMs?: number;
  /** P1.4: extra attempts per case after the first failure/timeout. Default 0 (no retry — current behavior). */
  maxRetries?: number;
  /** P1.4: cooperative cancellation — no NEW cases are started once `signal.aborted` is true; in-flight cases finish normally. */
  signal?: AbortSignal;
}

const RETRY_BACKOFF_MS = 25; // fixed, small — no exponential backoff (keeps suite runtime/tests deterministic-ish)

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class EvalCaseTimeoutError extends Error {
  constructor(ms: number) {
    super(`eval case timed out after ${ms}ms`);
    this.name = 'EvalCaseTimeoutError';
  }
}

function withTimeout<T>(p: Promise<T>, ms: number | undefined): Promise<T> {
  if (!ms) return p;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new EvalCaseTimeoutError(ms)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** A small promise pool: runs `worker` over `items` with at most `concurrency` in flight, results stay index-aligned to `items`. */
async function runPool<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const n = Math.max(1, Math.min(concurrency, items.length) || 1);
  const runners = Array.from({ length: n }, async () => {
    for (;;) {
      if (signal?.aborted) return;
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]!, i);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function evalDataset(opts: EvalDatasetOptions): Promise<EvalDatasetResult> {
  const { dataset, run, scorers, journal, itemTimeoutMs, signal } = opts;
  const scope = opts.scope ?? dataset.id;
  const maxAttempts = 1 + Math.max(0, opts.maxRetries ?? 0);
  const concurrency = opts.concurrency ?? 1;

  const attemptCase = async (c: DatasetCase): Promise<EvalCaseResult> => {
    const runId = `eval:${scope}:${c.id}`;
    const r = await run(c.input, { runId, caseId: c.id });
    const output = typeof r === 'string' ? r : r.output;
    const scores: Record<string, ScoreResult> = {};
    // runId is threaded into the sample so journal-backed scorers (e.g. trajectory.ts's
    // TrajectoryScorerFor) can be dropped into `scorers` with no extra wiring (P1.1).
    for (const s of scorers) scores[s.name] = await s.score({ output, expected: c.expected, runId });
    return { caseId: c.id, output, scores };
  };

  // Retries (P1.4) happen INSIDE evalCase, before journal memoization ever sees the result: a case
  // only reaches durableProcessorStep once it has either succeeded or exhausted maxAttempts, and
  // either way that final outcome (success or failure) is what gets memoized/skipped on resume —
  // exactly like every other case result.
  const evalCase = async (c: DatasetCase): Promise<EvalCaseResult> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await withTimeout(attemptCase(c), itemTimeoutMs);
      } catch (err) {
        lastError = err;
        if (attempt < maxAttempts - 1) await sleep(RETRY_BACKOFF_MS);
      }
    }
    const error = lastError instanceof Error ? lastError.message : String(lastError);
    return { caseId: c.id, output: '', scores: {}, error };
  };

  const worker = async (c: DatasetCase): Promise<EvalCaseResult> =>
    // resumable: a completed case returns from the journal (run + scoring do not run again).
    journal ? await durableProcessorStep(journal, `evalds:${scope}`, `case:${c.id}`, () => evalCase(c)) : await evalCase(c);

  const cases = await runPool(dataset.cases, concurrency, worker, signal);

  // aggregation: average per scorer (a failed/timed-out case contributes 0 for every scorer it never scored)
  const aggregate: Record<string, number> = {};
  for (const s of scorers) {
    const vals = cases.map((c) => c.scores[s.name]?.score ?? 0);
    aggregate[s.name] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  }

  return { datasetId: dataset.id, cases, aggregate };
}
