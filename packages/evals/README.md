# @gnldev/evals

**Scorers + LLM judge** for `@gnldev/durable` runs. `scoreRun` reads from the journal trace → deterministic &
replayable scores (memoized if the journal is writable → same score on resume). `evalDataset` runs a
resumable suite (picks up where it left off if interrupted).

```bash
npm i @gnldev/evals   # peer: @gnldev/durable, ai
```

```ts
import { scoreRun, contains, llmJudge, evalDataset } from '@gnldev/evals';

// Score a single run.
const s = await scoreRun(journal, 'order-1', [contains('Charged'), llmJudge(model, { criteria: 'is it polite?' })]);

// Dataset suite (resumable).
const r = await evalDataset({
  journal,
  dataset: { id: 'd1', cases: [{ id: 'c1', input: 'x', expected: 'echo:x' }] },
  run: async (input) => `echo:${input}`,
  scorers: [contains('echo')],
});
```

## API
- Rule-based scorers: `exactMatch`, `contains`, `regexScore`, `embeddingSimilarity`
- `llmJudge({ model, rubric })` — general-purpose LLM judge (parses SCORE/REASON)
- Ready-made LLM-judge scorers (thin factories wrapping `llmJudge`, take `{ model }`): `faithfulness`,
  `hallucination`, `answerRelevancy`, `toxicity`, `bias`, `completeness`, `contextPrecision`,
  `toneConsistency`. For all of them, a higher SCORE = better. The ones that need context
  (`faithfulness`/`hallucination`/`contextPrecision`) read `sample.context` (string | string[]); the ones
  that need a question (`answerRelevancy`/`completeness`) read `sample.input` — if it's missing they don't
  silently return 1, they return 0 + a clear reason.
- `scoreRun(journal, runId, scorers) → ScoreRunResult`
- `evalDataset({ journal, dataset, run, scorers }) → EvalDatasetResult` (resumable)

## How it works
Since scores are written to the journal, the eval suite is idempotent; long suites continue after a crash,
and the same input produces the same score.
