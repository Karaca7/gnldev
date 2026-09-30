# @gnldev/rag

**Vector store + RAG tool** for AI SDK agents. Used as a tool inside `runDurable`, it's automatically
**replayable** (thanks to durableTool the retrieval is journaled: on resume it comes back from the record
instead of running again).

> Install: `pnpm add @gnldev/rag` — or use it from a [repo clone](https://github.com/gnlhq/gnldev): `pnpm install && pnpm -r build`.

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
`options` on) gets the shared documents only.

## One tool per organization

> **Warning.** `visibleTo` separates users, not organizations. A tool built once over the ROOT vector
> store searches every organization's documents. The run knows the caller's organization, but the
> tool does not filter by it. Measured with one root store: a user of `acme` got `globex`'s shared
> document, and the private document of a `globex` user with the same id as theirs.

Give each organization its own tool, over that organization's part of the store
(`withOrgStorage(storage, orgId).vectors`). `tools` on an agent may be a function of the request
context, so the tool can be built per request, for the caller's organization:

```ts
import { createGnl, InMemoryStorage, withOrgStorage, serverIdentityOf } from '@gnldev/durable';
import { createRagTool, indexDocuments } from '@gnldev/rag';
import type { ToolSet } from 'ai';
declare const embed: (text: string) => Promise<number[]>;

const storage = new InMemoryStorage(); // the root storage, shared by every organization

// Index into the organization's part of the store, not into `storage.vectors`.
await indexDocuments(withOrgStorage(storage, 'acme').vectors!, embed, [
  { id: 'handbook', text: 'Leave policy…', shared: true },
]);

const gnl = createGnl({
  storage,
  agents: {
    assistant: {
      model,
      // Called for every run, with the request context the server sealed.
      tools: (ctx): ToolSet => {
        const orgId = serverIdentityOf(ctx).orgId;
        if (!orgId) return {}; // no organization on the request: no knowledge base
        return { search: createRagTool({ store: withOrgStorage(storage, orgId).vectors!, embed }) };
      },
    },
  },
});
```

Read the organization with `serverIdentityOf(ctx)`: the server writes it from the credential, and a
request body cannot set it. A call to `gnl.run` from your own code has no sealed organization, so it
gets no tool here.

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
