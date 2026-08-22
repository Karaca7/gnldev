// Independent regression tests for the RAG *scoping* surface: GraphRag.query(opts), namespace-local
// edge construction, createRagTool's forwarding of namespace/filter, and matchesFilter.
//
// Every test here is written to FAIL if the corresponding behaviour is reverted. The angles chosen are
// deliberately the ones a happy-path "two namespaces, ask for one, get one" test cannot distinguish:
//   - an implementation that declares `opts` and ignores it,
//   - an implementation that filters the OUTPUT but still lets excluded items seed/feed the graph walk,
//   - an implementation that builds edges across namespaces (a permanent structure, not a query-time one),
//   - a tool that "supports" namespace by always inventing one.
import { describe, it, expect } from 'vitest';
import { GraphRag, InMemoryVectorStore, createRagTool } from '../src/index.js';
// matchesFilter is NOT re-exported from src/index.ts (checked) — the real entry point is the module.
import { matchesFilter } from '../src/vector-store.js';
import type { VectorStore, VectorItem, VectorMatch, QueryOptions } from '../src/vector-store.js';

// ── 3D fake embedding space ──────────────────────────────────────────────────
// Axis 0 is the query direction. BRIDGE is a strong direct match AND sits above the edge threshold
// next to FAR; FAR is orthogonal to the query (direct cosine 0) so it can only ever arrive by walking
// the graph. That separation is what makes "did the walk leak?" observable at all.
const QUERY = [1, 0, 0];
const BRIDGE_EMB = [0.7, 0.7, 0]; // cos(QUERY) ≈ 0.707, cos(FAR) ≈ 0.707
const FAR_EMB = [0, 1, 0]; //        cos(QUERY) = 0
const GRAPH_OPTS = { threshold: 0.6, hops: 1, decay: 0.8, seeds: 2 } as const;

const ids = (ms: VectorMatch[]) => ms.map((m) => m.id).sort();

describe('GraphRag.query(opts) — namespace narrowing', () => {
  // A two-namespace test cannot catch an implementation that declares `opts` and drops it: asking for
  // one of two populated namespaces still "looks" plausible. Asking for a namespace that was NEVER
  // written to has exactly one correct answer — zero rows — and an ignoring implementation returns the
  // whole corpus instead.
  it('returns ZERO rows for a namespace that was never written to (not the whole corpus)', async () => {
    const graph = new GraphRag(GRAPH_OPTS);
    await graph.upsert([
      { id: 'acme-1', text: 'acme handbook', embedding: QUERY, namespace: 'org:acme' },
      { id: 'globex-1', text: 'globex handbook', embedding: BRIDGE_EMB, namespace: 'org:globex' },
    ]);
    const out = await graph.query(QUERY, 10, { namespace: 'org:never-written' });
    expect(out, 'an unknown namespace must be empty, not the unfiltered corpus').toEqual([]);
  });

  // The same assertion for a namespace filter that eliminates everything via a corpus with a single
  // namespace: `visible.length === 0` must short-circuit rather than fall through to "no narrowing".
  it('returns ZERO rows when the requested namespace excludes every item in a single-namespace corpus', async () => {
    const graph = new GraphRag(GRAPH_OPTS);
    await graph.upsert([{ id: 'a', text: 'only doc', embedding: QUERY, namespace: 'org:acme' }]);
    const out = await graph.query(QUERY, 5, { namespace: 'org:globex' });
    expect(out, 'an empty visible set must not degrade into an unfiltered search').toEqual([]);
  });

  // THE core leakage angle. FAR is a poor DIRECT match (cosine 0) but is above the edge threshold next
  // to BRIDGE, which IS a strong match. Put them in different namespaces and query BRIDGE's namespace:
  // if narrowing happens after scoring/walking (or not at all), FAR rides the walk out of its tenant.
  it('an item in another namespace never arrives via the graph walk, even when strongly connected to a top hit', async () => {
    const graph = new GraphRag(GRAPH_OPTS);
    await graph.upsert([
      { id: 'B-bridge', text: 'globex: strong direct match', embedding: BRIDGE_EMB, namespace: 'org:globex' },
      { id: 'A-far', text: 'acme: SECRET, only reachable by walking', embedding: FAR_EMB, namespace: 'org:acme' },
    ]);
    const out = await graph.query(QUERY, 10, { namespace: 'org:globex' });
    expect(ids(out), 'querying org:globex must not surface an org:acme id').toEqual(['B-bridge']);
    expect(
      out.some((m) => m.id.startsWith('A-') || m.text.includes('SECRET')),
      'no row may carry an id or text belonging to the other namespace',
    ).toBe(false);
  });

  // The control for the test above. Without this, that test could pass for the wrong reason — e.g. the
  // edge never formed, or nothing surfaces at all — and would keep passing after a revert.
  it('the SAME corpus does surface the weakly-matching item when both live in one namespace (control)', async () => {
    const graph = new GraphRag(GRAPH_OPTS);
    await graph.upsert([
      { id: 'B-bridge', text: 'strong direct match', embedding: BRIDGE_EMB, namespace: 'org:globex' },
      { id: 'A-far', text: 'only reachable by walking', embedding: FAR_EMB, namespace: 'org:globex' },
    ]);
    const out = await graph.query(QUERY, 10, { namespace: 'org:globex' });
    expect(ids(out)).toEqual(['A-far', 'B-bridge']);
    // And it arrived by the WALK, not by direct similarity (which is 0 for FAR).
    expect(out.find((m) => m.id === 'A-far')!.score).toBeGreaterThan(0.3);
  });
});

describe('GraphRag — edges are built namespace-locally (structure, not just query-time filtering)', () => {
  // Path 1: plain upsert of a brand-new id. Edge weight 0.707 clears the 0.6 threshold, so the ONLY
  // reason for 0 edges is the namespace guard in the incremental edge-building loop.
  it('upsert of a new item creates NO edge to an above-threshold neighbour in a different namespace', async () => {
    const graph = new GraphRag(GRAPH_OPTS);
    await graph.upsert([
      { id: 'b', text: 'bridge', embedding: BRIDGE_EMB, namespace: 'org:globex' },
      { id: 'f', text: 'far', embedding: FAR_EMB, namespace: 'org:acme' },
    ]);
    expect(graph.stats(), 'a cross-namespace edge is a permanent leak path').toEqual({ nodes: 2, edges: 0 });
  });

  // Same corpus, same similarity, one namespace → the edge MUST exist. Pins that the assertion above
  // is about the namespace and not about the threshold being unreachable.
  it('the same pair in one namespace DOES create an edge (control for the threshold)', async () => {
    const graph = new GraphRag(GRAPH_OPTS);
    await graph.upsert([
      { id: 'b', text: 'bridge', embedding: BRIDGE_EMB, namespace: 'org:globex' },
      { id: 'f', text: 'far', embedding: FAR_EMB, namespace: 'org:globex' },
    ]);
    expect(graph.stats()).toEqual({ nodes: 2, edges: 1 });
  });

  // Path 2: the per-item edge REBUILD path (upsert of an id that already exists → rebuildEdgesFor).
  // This is a second, independent copy of the namespace rule; reverting only this one leaves the
  // upsert-path test above green. Here the update makes the two embeddings IDENTICAL (cosine 1.0),
  // so any missing guard produces an edge immediately.
  it('the edge-rebuild path (re-upsert of an existing id) creates no edge across namespaces even at cosine 1.0', async () => {
    const graph = new GraphRag(GRAPH_OPTS);
    await graph.upsert([
      { id: 'b', text: 'bridge', embedding: BRIDGE_EMB, namespace: 'org:globex' },
      { id: 'f', text: 'far', embedding: FAR_EMB, namespace: 'org:acme' },
    ]);
    // Re-upsert 'f' with the exact embedding of 'b' — still a different namespace.
    await graph.upsert([{ id: 'f', text: 'far, moved', embedding: BRIDGE_EMB, namespace: 'org:acme' }]);
    expect(graph.stats(), 'rebuildEdgesFor must apply the same namespace rule as upsert').toEqual({ nodes: 2, edges: 0 });
    const out = await graph.query(QUERY, 10, { namespace: 'org:globex' });
    expect(ids(out), 'a rebuilt edge must not become a cross-tenant path either').toEqual(['b']);
  });

  // The rebuild path must also TEAR DOWN an edge when an item moves out of a shared namespace. Without
  // the namespace rule on rebuild, the pre-existing same-namespace edge would simply be recomputed and
  // survive the move — a stale cross-tenant edge, which is exactly what the walk guard has to catch.
  it('re-upserting an item into a different namespace drops the edge it had inside the old one', async () => {
    const graph = new GraphRag(GRAPH_OPTS);
    await graph.upsert([
      { id: 'b', text: 'bridge', embedding: BRIDGE_EMB, namespace: 'org:globex' },
      { id: 'f', text: 'far', embedding: FAR_EMB, namespace: 'org:globex' },
    ]);
    expect(graph.stats().edges).toBe(1);
    await graph.upsert([{ id: 'f', text: 'far', embedding: FAR_EMB, namespace: 'org:acme' }]); // moved out
    expect(graph.stats(), 'moving an item out of a namespace must remove its edges there').toEqual({ nodes: 2, edges: 0 });
  });
});

describe('GraphRag.query(opts) — metadata filter narrowing', () => {
  // Filtering must happen BEFORE the walk. Both items are in ONE namespace and genuinely connected by
  // an edge (the namespace rule cannot help here), so the only thing keeping the silver item out is the
  // filter being applied to the visible/allowed set rather than to the final rows.
  it('a filtered-out item does not arrive via a graph edge from a filtered-in neighbour', async () => {
    const graph = new GraphRag(GRAPH_OPTS);
    await graph.upsert([
      { id: 'gold-bridge', text: 'gold doc', embedding: BRIDGE_EMB, namespace: 'ns', metadata: { tier: 'gold' } },
      { id: 'silver-far', text: 'silver doc', embedding: FAR_EMB, namespace: 'ns', metadata: { tier: 'silver' } },
    ]);
    expect(graph.stats().edges, 'the pair must actually be connected for this test to mean anything').toBe(1);

    const unfiltered = await graph.query(QUERY, 10, { namespace: 'ns' });
    expect(ids(unfiltered)).toEqual(['gold-bridge', 'silver-far']); // control: the walk does reach it

    const filtered = await graph.query(QUERY, 10, { namespace: 'ns', filter: { tier: 'gold' } });
    expect(ids(filtered), 'filter must narrow the walk, not just the returned rows').toEqual(['gold-bridge']);
  });

  // A filter key the item's metadata simply does not have must EXCLUDE it (missing ≠ wildcard).
  it('an item whose metadata lacks the filter key is excluded, not treated as a wildcard match', async () => {
    const graph = new GraphRag(GRAPH_OPTS);
    await graph.upsert([
      { id: 'has-key', text: 'has region', embedding: QUERY, metadata: { region: 'eu' } },
      { id: 'lacks-key', text: 'no region key', embedding: QUERY, metadata: { tier: 'gold' } },
    ]);
    const out = await graph.query(QUERY, 10, { filter: { region: 'eu' } });
    expect(ids(out), 'a missing metadata key must not satisfy a filter on it').toEqual(['has-key']);
  });

  // metadata absent entirely (undefined) + a non-empty filter → excluded. Separate from the case above
  // because `undefined` metadata takes a different branch inside matchesFilter.
  it('an item with NO metadata at all is excluded by a non-empty filter', async () => {
    const graph = new GraphRag(GRAPH_OPTS);
    await graph.upsert([
      { id: 'with-meta', text: 'tagged', embedding: QUERY, metadata: { tier: 'gold' } },
      { id: 'no-meta', text: 'untagged', embedding: QUERY },
    ]);
    const out = await graph.query(QUERY, 10, { filter: { tier: 'gold' } });
    expect(ids(out), 'undefined metadata must not pass a non-empty filter').toEqual(['with-meta']);
  });

  // ...but an EMPTY filter object narrows nothing — otherwise `filter: {}` silently empties a tenant's
  // results, and callers build filters dynamically.
  it('an empty filter object narrows nothing (every item still returned)', async () => {
    const graph = new GraphRag(GRAPH_OPTS);
    await graph.upsert([
      { id: 'with-meta', text: 'tagged', embedding: QUERY, metadata: { tier: 'gold' } },
      { id: 'no-meta', text: 'untagged', embedding: QUERY },
    ]);
    const out = await graph.query(QUERY, 10, { filter: {} });
    expect(ids(out)).toEqual(['no-meta', 'with-meta']);
  });

  // Value mismatch on a present key, combined with namespace: both conditions are ANDed, not ORed.
  it('namespace and filter are ANDed: matching only one of the two is not enough', async () => {
    const graph = new GraphRag(GRAPH_OPTS);
    await graph.upsert([
      { id: 'right-ns-wrong-tier', text: 'a', embedding: QUERY, namespace: 'ns-a', metadata: { tier: 'silver' } },
      { id: 'wrong-ns-right-tier', text: 'b', embedding: QUERY, namespace: 'ns-b', metadata: { tier: 'gold' } },
      { id: 'both-right', text: 'c', embedding: QUERY, namespace: 'ns-a', metadata: { tier: 'gold' } },
    ]);
    const out = await graph.query(QUERY, 10, { namespace: 'ns-a', filter: { tier: 'gold' } });
    expect(ids(out), 'namespace ∧ filter — never ∨').toEqual(['both-right']);
  });
});

describe('GraphRag.query — backward compatibility of the 2-argument form', () => {
  // Adding `opts` must not have made namespace MANDATORY: the pre-existing 2-arg call has to keep
  // returning the whole corpus across every namespace.
  it('query(embedding, topK) with no opts still returns items from every namespace', async () => {
    const graph = new GraphRag(GRAPH_OPTS);
    await graph.upsert([
      { id: 'a', text: 'acme', embedding: QUERY, namespace: 'org:acme' },
      { id: 'b', text: 'globex', embedding: BRIDGE_EMB, namespace: 'org:globex' },
      { id: 'c', text: 'no namespace', embedding: FAR_EMB },
    ]);
    const out = await graph.query(QUERY, 10);
    expect(ids(out)).toEqual(['a', 'b', 'c']);
  });

  // Same for an explicitly undefined opts / empty opts object — "no narrowing requested" must mean
  // "no narrowing", not "namespace === undefined is a value to match on".
  it('query with an empty opts object behaves identically to the 2-argument form', async () => {
    const graph = new GraphRag(GRAPH_OPTS);
    const corpus: VectorItem[] = [
      { id: 'a', text: 'acme', embedding: QUERY, namespace: 'org:acme' },
      { id: 'b', text: 'globex', embedding: BRIDGE_EMB, namespace: 'org:globex' },
    ];
    await graph.upsert(corpus);
    const twoArg = await graph.query(QUERY, 10);
    const emptyOpts = await graph.query(QUERY, 10, {});
    expect(emptyOpts.map((m) => [m.id, m.score.toFixed(6)])).toEqual(twoArg.map((m) => [m.id, m.score.toFixed(6)]));
  });

  // A corpus with no namespaces at all must behave exactly as it did before the feature: graph walk
  // included. (Guards against "namespace-local edges" being implemented as "undefined never connects".)
  it('items with NO namespace still connect to each other and still surface via the walk', async () => {
    const graph = new GraphRag(GRAPH_OPTS);
    await graph.upsert([
      { id: 'b', text: 'bridge', embedding: BRIDGE_EMB },
      { id: 'f', text: 'far', embedding: FAR_EMB },
    ]);
    expect(graph.stats(), 'undefined === undefined — namespace-less items are one group').toEqual({ nodes: 2, edges: 1 });
    const out = await graph.query(QUERY, 10);
    expect(out.find((m) => m.id === 'f')!.score).toBeGreaterThan(0.3); // arrived by the walk
  });

  // Requesting a namespace must NOT match items that have none — "no namespace" is not a wildcard.
  it('a namespace-less item is NOT returned when a specific namespace is requested', async () => {
    const graph = new GraphRag(GRAPH_OPTS);
    await graph.upsert([
      { id: 'ns-less', text: 'global doc', embedding: QUERY },
      { id: 'ns-acme', text: 'acme doc', embedding: QUERY, namespace: 'org:acme' },
    ]);
    const out = await graph.query(QUERY, 10, { namespace: 'org:acme' });
    expect(ids(out), 'an item without a namespace must not leak into a scoped query').toEqual(['ns-acme']);
  });
});

// Records the exact third argument createRagTool hands to the store — the only way to tell
// "forwarded what was configured" from "forwarded something that happens to work".
class RecordingStore implements VectorStore {
  calls: { embedding: number[]; topK: number; opts: QueryOptions | undefined }[] = [];
  async upsert(_items: VectorItem[]): Promise<void> {}
  async query(embedding: number[], topK: number, opts?: QueryOptions): Promise<VectorMatch[]> {
    this.calls.push({ embedding, topK, opts });
    return [];
  }
}

const runTool = (t: ReturnType<typeof createRagTool>, query: string) =>
  t.execute!({ query }, { toolCallId: 'tc', messages: [] } as any);

describe('createRagTool — forwarding of namespace/filter to store.query', () => {
  const embed = async (_t: string) => QUERY;

  // Pins that the configured values reach the store VERBATIM as the 3rd argument (deep equality, so a
  // renamed key, a dropped filter, or a partially-copied object all fail).
  it('forwards the configured namespace and filter verbatim as store.query 3rd argument', async () => {
    const store = new RecordingStore();
    const filter = { tier: 'gold', region: 'eu' };
    const t = createRagTool({ store, embed, topK: 3, namespace: 'org:acme', filter });
    await runTool(t, 'anything');

    expect(store.calls).toHaveLength(1);
    expect(store.calls[0]!.topK).toBe(3);
    expect(store.calls[0]!.opts, 'the tool is the only documented RAG path — scoping must reach the store').toEqual({
      namespace: 'org:acme',
      filter: { tier: 'gold', region: 'eu' },
    });
  });

  // The other half: with neither configured, the tool must not INVENT keys. `{ namespace: undefined }`
  // is not the same as no key — a store that checks `'namespace' in opts` (or serialises opts) behaves
  // differently. Asserted on Object.keys, so undefined-valued keys are caught.
  it('passes NO namespace key and NO filter key when neither is configured', async () => {
    const store = new RecordingStore();
    const t = createRagTool({ store, embed });
    await runTool(t, 'anything');

    const opts = store.calls[0]!.opts!;
    expect(Object.keys(opts), 'unconfigured scoping must be absent, not undefined-valued').toEqual([]);
    expect('namespace' in opts).toBe(false);
    expect('filter' in opts).toBe(false);
  });

  // Each half independently: configuring only one must not drag the other along as an undefined key.
  it('passes only the namespace key when filter is not configured (and vice versa)', async () => {
    const nsOnly = new RecordingStore();
    await runTool(createRagTool({ store: nsOnly, embed, namespace: 'org:acme' }), 'q');
    expect(Object.keys(nsOnly.calls[0]!.opts!).sort()).toEqual(['namespace']);

    const filterOnly = new RecordingStore();
    await runTool(createRagTool({ store: filterOnly, embed, filter: { tier: 'gold' } }), 'q');
    expect(Object.keys(filterOnly.calls[0]!.opts!).sort()).toEqual(['filter']);
  });

  // Two tools over ONE store must not share scope — the documented "one tool per tenant" pattern.
  it('two tools over the same store forward their own distinct namespaces', async () => {
    const store = new RecordingStore();
    await runTool(createRagTool({ store, embed, namespace: 'org:acme' }), 'q');
    await runTool(createRagTool({ store, embed, namespace: 'org:globex' }), 'q');
    expect(store.calls.map((c) => c.opts!.namespace)).toEqual(['org:acme', 'org:globex']);
  });
});

describe('createRagTool — end-to-end tenant isolation over real stores', () => {
  // 4D space: [refund, policy, acme, globex]. The two tenants' documents are similar enough
  // (cosine ≈ 0.667 > the 0.6 threshold) that they WOULD be graph neighbours if edges crossed
  // namespaces — the corpus is built to make a leak possible, not to make it impossible.
  const embed = async (t: string) => {
    const s = t.toLowerCase();
    return [s.includes('refund') ? 1 : 0, s.includes('policy') ? 1 : 0, s.includes('acme') ? 1 : 0, s.includes('globex') ? 1 : 0];
  };
  const corpus = async (): Promise<VectorItem[]> => [
    { id: 'acme-1', text: 'acme refund policy: 30 days, no questions', embedding: await embed('acme refund policy'), namespace: 'org:acme' },
    { id: 'globex-1', text: 'globex refund policy: 7 days, receipt required', embedding: await embed('globex refund policy'), namespace: 'org:globex' },
  ];

  it('a GraphRag-backed tool scoped to tenant A never returns tenant B text', async () => {
    const store = new GraphRag(GRAPH_OPTS);
    await store.upsert(await corpus());
    const t = createRagTool({ store, embed, topK: 10, namespace: 'org:acme' });
    const hits: any[] = await runTool(t, 'refund policy');

    expect(hits.length).toBeGreaterThan(0); // guard: must not pass because nothing came back
    expect(hits.map((h) => h.text), 'tenant A tool returned tenant B document text').toEqual([
      'acme refund policy: 30 days, no questions',
    ]);
    expect(hits.some((h) => h.text.toLowerCase().includes('globex')), 'no hit may mention the other tenant').toBe(false);
  });

  it('an InMemoryVectorStore-backed tool scoped to tenant B never returns tenant A text', async () => {
    const store = new InMemoryVectorStore();
    await store.upsert(await corpus());
    const t = createRagTool({ store, embed, topK: 10, namespace: 'org:globex' });
    const hits: any[] = await runTool(t, 'refund policy');

    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((h) => h.text), 'tenant B tool returned tenant A document text').toEqual([
      'globex refund policy: 7 days, receipt required',
    ]);
    expect(hits.some((h) => h.text.toLowerCase().includes('acme')), 'no hit may mention the other tenant').toBe(false);
  });

  // Control: the SAME unscoped tool over the SAME corpus returns both tenants. Without this, the two
  // tests above could pass simply because retrieval returns one row for unrelated reasons.
  it('an unscoped tool over the same corpus returns BOTH tenants (control)', async () => {
    const store = new GraphRag(GRAPH_OPTS);
    await store.upsert(await corpus());
    const t = createRagTool({ store, embed, topK: 10 });
    const hits: any[] = await runTool(t, 'refund policy');
    expect(hits).toHaveLength(2);
  });

  // Scoping must survive a metadata filter layered on top, through the tool.
  it('a tool configured with both namespace and filter narrows by both end-to-end', async () => {
    const store = new GraphRag(GRAPH_OPTS);
    const base = await corpus();
    await store.upsert([
      { ...base[0]!, metadata: { visibility: 'public' } },
      { ...base[0]!, id: 'acme-2', text: 'acme internal refund policy draft', metadata: { visibility: 'internal' } },
      base[1]!,
    ]);
    const t = createRagTool({ store, embed, topK: 10, namespace: 'org:acme', filter: { visibility: 'public' } });
    const hits: any[] = await runTool(t, 'refund policy');
    expect(hits.map((h) => h.text), 'internal and cross-tenant docs must both be excluded').toEqual([
      'acme refund policy: 30 days, no questions',
    ]);
  });
});

describe('matchesFilter', () => {
  // The rule GraphRag and InMemoryVectorStore now share. Each case below is a branch that a rewrite
  // could get wrong in isolation.
  it('returns true when no filter is given (undefined)', () => {
    expect(matchesFilter({ tier: 'gold' }, undefined)).toBe(true);
    expect(matchesFilter(undefined, undefined)).toBe(true);
  });

  it('returns true for an empty filter object (vacuous truth, not "match nothing")', () => {
    expect(matchesFilter({ tier: 'gold' }, {})).toBe(true);
    expect(matchesFilter(undefined, {})).toBe(true);
  });

  it('returns false when a filter key is missing from the metadata', () => {
    expect(matchesFilter({ tier: 'gold' }, { region: 'eu' }), 'a missing key must not match').toBe(false);
  });

  it('returns false when a present key has a different value', () => {
    expect(matchesFilter({ tier: 'silver' }, { tier: 'gold' })).toBe(false);
  });

  it('returns false for undefined metadata with a non-empty filter', () => {
    expect(matchesFilter(undefined, { tier: 'gold' }), 'no metadata must never satisfy a real filter').toBe(false);
  });

  it('requires EVERY filter key to match (AND, not OR)', () => {
    const meta = { tier: 'gold', region: 'eu' };
    expect(matchesFilter(meta, { tier: 'gold', region: 'eu' })).toBe(true);
    expect(matchesFilter(meta, { tier: 'gold', region: 'us' }), 'one mismatching key must fail the whole filter').toBe(false);
  });

  it('compares by strict equality: a matching string does not match a number and objects are not deep-compared', () => {
    expect(matchesFilter({ n: 1 }, { n: '1' as unknown as number })).toBe(false);
    expect(matchesFilter({ o: { a: 1 } }, { o: { a: 1 } }), 'shallow equality — a structurally equal object is a different reference').toBe(false);
  });
});
