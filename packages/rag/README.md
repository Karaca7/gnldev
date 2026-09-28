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

When a run is on behalf of an end user, `createRagTool` answers from the shared documents and that
user's own. You don't pass anything for this: the tool reads whose run it is from the engine's identity
channel (`identityOf(options)` in `@gnldev/durable`), the same value the run's owner record comes from.

| Document | Ayşe's search | Mehmet's search | Staff / system | Identity lost (`unknown`) |
|---|---|---|---|---|
| `shared: true` | ✅ | ✅ | ✅ | ✅ |
| `owner: 'ayse'` | ✅ | ❌ | ✅ | ❌ |
| no label | ❌ | ❌ | ✅ | ❌ |

A document with no label is visible to no end user. A forgotten label shows up as "not found", never as
a leak. A call that lost its identity (called by hand, or by another tool that did not pass its
`options` on) gets the shared documents only. Organizations stay apart as before: use a store from
`withOrgStorage`.

Every store (`InMemoryVectorStore`, `GraphRag`, `PostgresVectorStore` and the `@gnldev/durable`
storages) applies the same write rule, before anything is written:

- `owner` must be an id an end user can carry: not empty, at most 200 characters, no control
  characters, no staff prefix such as `operator:` (`ownerIdProblem` in `@gnldev/durable`, the same rule
  as `subjectIdProblem` in `@gnldev/auth`). Otherwise the upsert throws `OwnerIdError`.
- `shared` is `true`, `false` or absent; `namespace` is a non-empty string or absent.
- An upsert **updates** a document; it does not move it to another owner or label. Upserting an
  existing id with a different `owner`/`shared` (or namespace) fails with `VectorOwnerConflictError`,
  so one user cannot take over another's document or replace a shared one. The same id twice in one
  batch under two owners fails the same way, and nothing of the batch is written. To relabel, `delete`
  it first.

`delete({ owner })` removes one person's documents; `eraseSubject(storage, userId)` in
`@gnldev/durable` does it for the storage's vector store as part of erasing them. A `delete` with no condition (`{}`, `{ ids: [] }`,
`{ filter: {} }`) removes nothing.

Your own `VectorStore` gets the same request as `QueryOptions.visibleTo`. Return only documents with
`shared: true` or `owner === visibleTo`, and filter **before** taking the top K.

## How it works
Since RAG is a tool, it naturally fits into the durable agent loop: retrieval + rerank are journaled once
and replayed rather than repeated. For cross-run reuse, it can be combined with `@gnldev/cache`.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
