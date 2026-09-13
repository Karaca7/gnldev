import { durableProcessorStep } from '@gnldev/durable';
import type { JournalReader, Journal, JournalEntry } from '@gnldev/durable';
import type { Scorer, ScoreResult, ScoreSample } from './scorer.js';

export interface ScoreRunResult {
  runId: string;
  output: string;
  scores: Record<string, ScoreResult>;
}

/** Extracts the output to be scored from the journal trace (the text of the last model entry). */
function extractFinalText(entries: JournalEntry[]): string {
  const models = entries.filter((e) => e.kind === 'model');
  const last = models[models.length - 1];
  const content = ((last?.value as any)?.content ?? []) as any[];
  return content.filter((p) => p?.type === 'text').map((p) => p.text).join('');
}

/**
 * Scores a run from its JOURNAL TRACE (post-execution, deterministic). Same journal → same
 * output → same score for rule-based scorers. If the journal is writable, each scorer result is
 * memoized under `${runId}:proc:eval:${name}` → even llmJudge returns the SAME score on resume
 * (something most eval frameworks don't have: journal-based replayable scoring). Can be disabled with `memo:false`.
 */
export async function scoreRun(
  reader: JournalReader,
  runId: string,
  scorers: Scorer[],
  opts: { expected?: string; memo?: boolean } = {},
): Promise<ScoreRunResult> {
  const entries = await reader.readRun(runId);
  const output = extractFinalText(entries);
  // runId is included so trajectory-style scorers (see trajectory.ts's trajectoryScorerFor) can look
  // this run's decision sequence back up without any extra wiring at the call site (P1.1).
  const sample: ScoreSample = { output, expected: opts.expected, runId };

  const j = reader as Partial<Journal>;
  const canMemo = opts.memo !== false && typeof j.get === 'function' && typeof j.put === 'function';

  const scores: Record<string, ScoreResult> = {};
  for (const s of scorers) {
    scores[s.name] = canMemo
      ? await durableProcessorStep(j as Journal, runId, `eval:${s.name}`, () => s.score(sample))
      : await s.score(sample);
  }
  return { runId, output, scores };
}
