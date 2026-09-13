# @gnldev/memory

Rich semantic-recall memory for `@gnldev/durable` — **journaled and replayable**; a write already recorded is replayed rather than applied again ([at-most-once for side effects](../durable/README.md#what-never-charged-twice-actually-means)). One class: `AgentMemory`.

```ts
import { AgentMemory } from '@gnldev/memory';
import { z } from 'zod';

const mem = new AgentMemory({
  storage,                                // the Storage, not storage.runs — memory needs its own port
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
- **WM merge is recorded, not repeated:** the `updateWorkingMemory` tool is journaled → on resume the merge
  comes back from the record instead of being applied a second time (no double-write).
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
- **Concurrent turns on one thread are safe, but not ordered:** two runs appending to the same thread
  at once both land. The store assigns `seq` inside the write, serialised per thread, so nothing is
  dropped — this was NOT true before: a lockless read-then-write lost messages, silently, and a
  dropped `tool-result` broke the thread until the orphan slid out of the recent-message window (five
  consecutive failures, measured). What concurrency still costs is
  adjacency: messages land in SEND order and answers in COMPLETION order, so two racing turns
  interleave as `[A, B, ansA, ansB]`. If a turn must not begin while another is in flight, serialise
  at your own entry point — gnl holds no thread-level lock.
- **Writing your own `MemoryStore`:** `appendMessages` receives `MessageAppend[]`, where `seq` is
  optional and normally ABSENT. An adapter must assign the next positions itself, in the same
  transaction that writes the rows, serialised per thread, and must write the batch all-or-nothing —
  a half-written batch can leave a `tool-call` without its `tool-result`. Rows that DO carry `seq`
  are written exactly there and keep the idempotent CAS form (`cloneThread`, transcript import); a
  batch that mixes the two throws.

## Lite alternative
For anyone who just wants simple topK recall, `SemanticMemory` in `@gnldev/rag` is lighter; it uses the same
`sem:${threadId}:log` shape (cross-readable).

## License

Apache-2.0 — see [LICENSE](./LICENSE).
