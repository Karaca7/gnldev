import { generateText } from 'ai';
import type { Scorer, ScoreSample } from './scorer.js';

export interface LlmJudgeOptions {
  /** AI SDK model (the judge). */
  model: any;
  /** Evaluation criteria (the instruction given to the model). */
  rubric: string;
  name?: string;
  /**
   * Controls which extra fields (beyond `sample.output`) are added to the prompt.
   * DEFAULT (if not given): existing behavior is preserved for backward compatibility — if
   * `sample.input` and `sample.context` are non-empty (excluding empty string/empty array), both are
   * added.
   * Scorers that should evaluate the OUTPUT ONLY (e.g. toxicity/bias/toneConsistency in `scorers.ts`)
   * should pass `[]` — otherwise, in shared RAG samples (where input/context are populated), they can
   * get contaminated by irrelevant context and produce a wrong score (e.g. if the context is toxic,
   * the toxicity score could come out low even though the output itself is clean).
   */
  sampleFields?: ('input' | 'context')[];
}

function hasInput(sample: ScoreSample): boolean {
  return typeof sample.input === 'string' && sample.input.trim().length > 0;
}

function hasContext(sample: ScoreSample): boolean {
  const c = sample.context;
  if (c == null) return false;
  if (Array.isArray(c)) return c.some((x) => typeof x === 'string' && x.trim().length > 0);
  return typeof c === 'string' && c.trim().length > 0;
}

/**
 * LLM-judge scorer: asks the model to score the output 0.0–1.0 against `rubric`.
 * When called via `scoreRun`, it's memoized in the journal → the SAME score on resume (no duplicate
 * judge call).
 *
 * Whether `sample.input` (question/input) and `sample.context` (RAG context, string | string[] — see
 * ScoreSample.context in `scorer.ts`) are added to the prompt is controlled by `opts.sampleFields`
 * (see `LlmJudgeOptions.sampleFields`); the built-in scorers in `scorers.ts`
 * (faithfulness/hallucination/answerRelevancy/etc.) declare this mechanism according to their needs.
 */
export function llmJudge(opts: LlmJudgeOptions): Scorer {
  return {
    name: opts.name ?? 'llm-judge',
    score: async (sample) => {
      const fields = opts.sampleFields ?? ['input', 'context'];
      const parts = [opts.rubric];
      if (fields.includes('input') && hasInput(sample)) parts.push(`Input/Question:\n${sample.input}`);
      if (fields.includes('context') && hasContext(sample)) {
        const ctx = Array.isArray(sample.context) ? sample.context.join('\n---\n') : sample.context;
        parts.push(`Context:\n${ctx}`);
      }
      parts.push(`Output:\n${sample.output}`);
      parts.push('Respond ONLY in this format:\nSCORE: <number between 0.0-1.0>\nREASON: <brief justification>');
      const prompt = parts.join('\n\n');
      const { text } = await generateText({ model: opts.model, prompt });
      const sm = /SCORE:\s*([0-9]*\.?[0-9]+)/i.exec(text);
      const rm = /REASON:\s*([\s\S]*)/i.exec(text);
      const raw = sm ? parseFloat(sm[1]!) : 0;
      return { score: Math.max(0, Math.min(1, Number.isFinite(raw) ? raw : 0)), reason: rm?.[1]?.trim() };
    },
  };
}
