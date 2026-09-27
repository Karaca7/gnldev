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
await indexDocuments(store, embed, [{ id: 'p1', text: 'Return policy: 30 days…', shared: true }]);

const searchPolicy = createRagTool({
  store, embed, topK: 3,
  rerank: llmReranker({ model }), rerankTopK: 2,   // optional LLM reranker
});

await runDurable({ runId: 'r1', journal, model, tools: { searchPolicy }, prompt: '…' });
```

## API
- `InMemoryVectorStore` · `indexDocuments(store, embed, docs)` · `VectorStore` interface (plug in your own
  backend)
- `createRagTool({ store, embed, topK?, namespace?, filter?, rerank?, rerankTopK?, description? })` → AI SDK tool
- `llmReranker({ model })` → `Reranker`
- `SemanticMemory` — vector-based recall (memory integration)

## General documents and each user's own

One knowledge base can hold both: documents for everyone in the organization, and documents that belong
to one end user. Label each document when you index it:

```ts
import { InMemoryVectorStore, indexDocuments } from '@gnldev/rag';
declare const embed: (text: string) => Promise<number[]>;

const store = new InMemoryVectorStore();
await indexDocuments(store, embed, [
  { id: 'handbook', text: 'Leave policy…', shared: true },     // everyone's
  { id: 'inv-17', text: 'Invoice 17…', owner: 'ayse' },         // Ayşe's only
]);
```

When a run is on behalf of an end user (it has a `resourceId`), `createRagTool` answers from the shared
documents and that user's own. You don't pass anything for this; the run tells the tool whose it is.

| Document | Ayşe's search | Mehmet's search | Staff / system (no `resourceId`) |
|---|---|---|---|
| `shared: true` | ✅ | ✅ | ✅ |
| `owner: 'ayse'` | ✅ | ❌ | ✅ |
| no label | ❌ | ❌ | ✅ |

A document with no label is visible to no end user. A forgotten label shows up as "not found", never as
a leak. Organizations stay apart as before: use a store from `withOrgStorage`.

Your own `VectorStore` gets the same request as `QueryOptions.visibleTo`. Return only documents with
`shared: true` or `owner === visibleTo`, and filter **before** taking the top K.

## How it works
Since RAG is a tool, it naturally fits into the durable agent loop: retrieval + rerank are journaled once
and replayed rather than repeated. For cross-run reuse, it can be combined with `@gnldev/cache`.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
