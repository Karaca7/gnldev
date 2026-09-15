# @gnldev/rag

**Vector store + RAG tool** for AI SDK agents. Used as a tool inside `runDurable`, it's automatically
**replayable** (thanks to durableTool the retrieval is journaled: on resume it comes back from the record
instead of running again).

> Install: `pnpm add @gnldev/rag` — or use it from a [repo clone](https://github.com/Karaca7/gnldev): `pnpm install && pnpm -r build`.

```bash
npm i @gnldev/rag   # peer: @gnldev/durable, ai, zod
```

```ts
import { InMemoryVectorStore, indexDocuments, createRagTool, llmReranker } from '@gnldev/rag';

const store = new InMemoryVectorStore();
await indexDocuments(store, embed, [{ id: 'p1', text: 'Return policy: 30 days…' }]);

const searchPolicy = createRagTool({
  store, embed, topK: 3,
  rerank: llmReranker({ model }), rerankTopK: 2,   // optional LLM reranker
});

await runDurable({ runId: 'r1', journal, model, tools: { searchPolicy }, prompt: '…' });
```

## API
- `InMemoryVectorStore` · `indexDocuments(store, embed, docs)` · `VectorStore` interface (plug in your own
  backend)
- `createRagTool({ store, embed, topK?, rerank?, rerankTopK?, description? })` → AI SDK tool
- `llmReranker({ model })` → `Reranker`
- `SemanticMemory` — vector-based recall (memory integration)

## How it works
Since RAG is a tool, it naturally fits into the durable agent loop: retrieval + rerank are journaled once
and replayed rather than repeated. For cross-run reuse, it can be combined with `@gnldev/cache`.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
