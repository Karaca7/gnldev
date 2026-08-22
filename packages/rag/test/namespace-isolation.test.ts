// `namespace` is the only mechanism this package has for keeping two data sets apart, and one of its
// three `VectorStore` implementations did not implement it at all.
//
// `GraphRag.query` declared `(embedding, topK)` — the `opts` parameter simply was not there. TypeScript
// accepted the class as a `VectorStore` regardless, because a function of fewer parameters is
// assignable to a type that declares more. Measured before the fix:
//
//   query(q, 5, { namespace: 'org:acme' })       -> acme-1, globex-1
//   query(q, 5, { namespace: 'does-not-exist' }) -> 2 rows
//   GraphRag.prototype.query.length = 2          vs InMemoryVectorStore = 3
//
// And `createRagTool` — the one documented way to reach a store from an agent — passed no `opts` at
// all, so the mechanism was unreachable through the shipped path even where it worked.
//
// The three probes below are ordered by strength. Arity is cheap and exact. Two-namespaces-same-content
// is the real gate. A namespace that was NEVER WRITTEN is the one that catches an implementation which
// declares the parameter correctly and then forgets to use it — the arity probe cannot see that, and a
// happy-path test never asks.
import { describe, it, expect } from 'vitest';
import { InMemoryVectorStore, GraphRag, createRagTool } from '../src/index.js';
import type { VectorStore } from '../src/index.js';

/** Deterministic, no model: identical text → identical vector, so both tenants score the same. */
const embed = async (text: string): Promise<number[]> => {
  const v = [0, 0, 0, 0];
  for (let i = 0; i < text.length; i++) v[i % 4]! += text.charCodeAt(i) / 1000;
  return v;
};

const SECRET = 'quarterly revenue figures';

async function seedTwoTenants(store: VectorStore): Promise<void> {
  await store.upsert([
    { id: 'acme-1', text: `ACME ${SECRET}`, namespace: 'org:acme', embedding: await embed(SECRET) },
    { id: 'globex-1', text: `GLOBEX ${SECRET}`, namespace: 'org:globex', embedding: await embed(SECRET) },
  ]);
}

const STORES: Array<[string, () => VectorStore]> = [
  ['InMemoryVectorStore', () => new InMemoryVectorStore()],
  ['GraphRag', () => new GraphRag()],
];

describe.each(STORES)('%s honours namespace', (_name, make) => {
  it('declares the parameter — a shorter signature silently drops the isolation', () => {
    // `Function.length` counts parameters before the first optional/rest one, so an implementation
    // that omits `opts` reports 2 where the contract says 3. This is the only probe that can run
    // without any data, and the only one `tsc` cannot do for us.
    expect(make().query.length, 'the query implementation omits a parameter the interface declares').toBe(3);
  });

  it('does not return another namespace\'s document', async () => {
    const store = make();
    await seedTwoTenants(store);

    const acme = await store.query(await embed(SECRET), 5, { namespace: 'org:acme' });
    expect(acme.map((m) => m.id), 'a query scoped to one tenant returned another tenant\'s row')
      .toEqual(['acme-1']);
  });

  it('returns nothing for a namespace that was never written', async () => {
    // The probe that catches a store which takes `opts`, types it correctly, and then never applies
    // it. Both other probes pass for such a store; this one cannot.
    const store = make();
    await seedTwoTenants(store);

    const none = await store.query(await embed(SECRET), 5, { namespace: 'org:nobody' });
    expect(none, 'an unwritten namespace matched existing rows').toEqual([]);
  });
});

describe('GraphRag builds its graph within a namespace', () => {
  it('creates no edge between two tenants\' documents', async () => {
    // Asserted on the GRAPH, not on query output — because query output does not discriminate here.
    // Measured: removing the namespace check from edge construction leaves every query assertion in
    // this file green, since the walk refuses to traverse into a row the caller cannot see anyway.
    //
    // So this rule is defence in depth rather than the thing that closes the leak, and the honest way
    // to test it is to look at what it actually builds. It still earns its place: a corpus upserted
    // before the rule existed carries cross-tenant edges into every later query, and a graph that
    // spends its edges on rows no caller can reach is wrong on its own terms.
    const store = new GraphRag({ threshold: 0, hops: 2, seeds: 4 });
    await seedTwoTenants(store);

    expect(store.stats(), 'the two tenants\' documents were linked in the graph')
      .toEqual({ nodes: 2, edges: 0 });
  });

  it('still links documents inside one namespace', async () => {
    // The other half — a namespace-partitioned graph must still be a graph.
    const store = new GraphRag({ threshold: 0, hops: 2, seeds: 4 });
    await store.upsert([
      { id: 'a-1', text: 'one', namespace: 'org:acme', embedding: await embed('one') },
      { id: 'a-2', text: 'two', namespace: 'org:acme', embedding: await embed('two') },
    ]);
    expect(store.stats().edges, 'partitioning the graph left it with no edges at all').toBeGreaterThan(0);
  });
});

describe('createRagTool', () => {
  it('passes its namespace to the store, instead of searching everything', async () => {
    // The tool passed no options at all, so every agent built from it searched the whole corpus —
    // including every shipped example.
    const store = new InMemoryVectorStore();
    await seedTwoTenants(store);

    const scoped = createRagTool({ store, embed, topK: 5, namespace: 'org:acme' });
    const hits = await scoped.execute!({ query: SECRET }, { toolCallId: 'c1', messages: [] });

    expect(hits.map((h) => h.text), 'the tool retrieved another tenant\'s document')
      .toEqual([`ACME ${SECRET}`]);
  });

  it('still searches the whole store when no namespace is given', async () => {
    // The single-tenant default must not change: one corpus, no namespaces, everything visible.
    const store = new InMemoryVectorStore();
    await seedTwoTenants(store);

    const all = createRagTool({ store, embed, topK: 5 });
    const hits = await all.execute!({ query: SECRET }, { toolCallId: 'c1', messages: [] });
    expect(hits).toHaveLength(2);
  });
});
