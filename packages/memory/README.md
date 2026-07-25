# @gnldev/memory

Rich semantic-recall memory for `@gnldev/durable` — **journaled, replayable, exactly-once.** One class: `GnlMemory`.

```ts
import { GnlMemory } from '@gnldev/memory';
import { z } from 'zod';

const mem = new GnlMemory({
  journal,
  embed,                                  // text → number[] (AI SDK embed or your own fn)
  recentN: 6,
  recall: { topK: 3, messageRange: 1, threshold: 0.2, scope: 'resource' },
  workingMemory: { schema: z.object({ name: z.string().optional(), tier: z.string().optional() }) },
  observationalMemory: { enabled: true, observerModel, observation: { messageThreshold: 30 } },
});

await runDurable({ runId, journal, model, memory: mem, threadId: 'th-1', resourceId: 'user-42', prompt });
```

## 4 tracks (all common agent-memory features + a durable twist)
- **Rich recall** — `topK` + `messageRange` (context around the hit) + `threshold` + metadata `filter` +
  **`scope:'resource'`** (cross-thread).
- **Schema working memory** — zod/template WM + the `updateWorkingMemory` tool (deep-merge, `null` =
  delete) + `readOnly`. The tool is wrapped with `durableTool` → the merge is journaled.
- **Thread + resource management** — `createThread/getThreadById/listThreads/updateThread/deleteThread/cloneThread`
  (+ ancestry).
- **Observational memory** — the Observer folds old messages into observations, the Reflector compresses
  them. LLM calls are journaled via `durableProcessorStep` → **replayable compaction**.

## Durable twist (not in typical agent-memory implementations)
- **Recall is replayable:** `loadContext` runs before `persistInput` → the recall result **freezes** into
  `:input`; resume replays the same context, embed/query never runs again.
- **WM is exactly-once:** the `updateWorkingMemory` tool is journaled → the merge doesn't repeat on resume
  (no double-write).
- **OM is replayable:** the same `seq` again → the Observer/Reflector LLM is **never called**, the summary
  is reproduced verbatim (survives even a crash mid-compaction).

## Honest caveats
- **Recall freezes on the first run:** resume recalls based on the resource graph from the first run
  (correct for replay determinism). A new turn = new `runId` = fresh recall.
- **WM writes only happen on the first execute** (durableTool short-circuit); resume reads state from the
  first run.
- **OM v1 is minimal:** message-count threshold (not a real tokenizer), synchronous compaction (no async
  buffering), single observer model (no token-tier routing). Future: these + time-based markers +
  resource-scope OM.

## Lite alternative
For anyone who just wants simple topK recall, `SemanticMemory` in `@gnldev/rag` is lighter; it uses the same
`sem:${threadId}:log` shape (cross-readable).
