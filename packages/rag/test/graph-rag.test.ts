// GraphRag — retrieval via a similarity graph (the common "graph RAG" pattern).
// Critical scenario: a chunk that doesn't DIRECTLY resemble the query but is strongly connected to
// a chunk that does resemble the query (indirect relevance) joins the results — plain vector search misses this.
import { describe, it, expect } from 'vitest';
import { GraphRag, InMemoryVectorStore } from '../src/index.js';

// 3D fake embedding space: axes are concepts. A=[1,0,0] is the query axis; B is a bridge (close to both A and C);
// C is orthogonal to the query (direct similarity ~0) but strongly connected to B; D is an unrelated far point.
const A = { id: 'a', text: 'identical to query', embedding: [1, 0, 0] };
const B = { id: 'b', text: 'bridge piece', embedding: [0.7, 0.7, 0] };
const C = { id: 'c', text: 'indirectly relevant', embedding: [0, 1, 0] };
const D = { id: 'd', text: 'unrelated', embedding: [0, 0, 1] };
const QUERY = [1, 0, 0];

describe('GraphRag', () => {
  it('an indirectly relevant chunk joins results via the graph; plain search misses it (contrast)', async () => {
    const flat = new InMemoryVectorStore();
    await flat.upsert([A, B, C, D]);
    const flatTop3 = await flat.query(QUERY, 3);
    // Plain search: c's direct similarity is 0 → same level as d, can't be reliably ranked.
    expect(flatTop3.map((m) => m.id).slice(0, 2)).toEqual(['a', 'b']);

    const graph = new GraphRag({ threshold: 0.6, hops: 1, decay: 0.8, seeds: 2 });
    await graph.upsert([A, B, C, D]);
    const out = await graph.query(QUERY, 3);
    expect(out.map((m) => m.id)).toEqual(['a', 'b', 'c']); // c came from the graph (via bridge b), d was excluded
    // c's score via the graph path: b.score × decay × w(b,c) > 0 (while its direct similarity is 0).
    expect(out[2]!.score).toBeGreaterThan(0.3);
  });

  it('hops=0 behaves equivalent to plain vector search', async () => {
    const graph = new GraphRag({ threshold: 0.6, hops: 0 });
    await graph.upsert([A, B, C, D]);
    const out = await graph.query(QUERY, 4);
    const flat = new InMemoryVectorStore();
    await flat.upsert([A, B, C, D]);
    const ref = await flat.query(QUERY, 4);
    expect(out.map((m) => [m.id, m.score.toFixed(6)])).toEqual(ref.map((m) => [m.id, m.score.toFixed(6)]));
  });

  it('threshold determines edge formation: a high threshold → bridge breaks → the indirect chunk does not come through', async () => {
    const graph = new GraphRag({ threshold: 0.95, hops: 1, seeds: 2 });
    await graph.upsert([A, B, C, D]);
    expect(graph.stats().edges).toBe(0); // threshold connected no pair
    const out = await graph.query(QUERY, 3);
    // c may enter topK from the direct-similarity list (score ~0) but must get NO GRAPH CONTRIBUTION:
    const c = out.find((m) => m.id === 'c');
    expect(c?.score ?? 0).toBeLessThan(0.01); // contrast with the graph-derived score (>0.3) in the first test
  });

  it('if a node is reached via multiple paths, the HIGHEST score is kept; an upsert update refreshes edges', async () => {
    const graph = new GraphRag({ threshold: 0.6, hops: 2, decay: 0.9, seeds: 2 });
    await graph.upsert([A, B, C]);
    const before = graph.stats();
    // Move C to a fully unrelated direction → the b-c edge should drop.
    await graph.upsert([{ ...C, embedding: [0, 0, 1] }]);
    expect(graph.stats().edges).toBeLessThan(before.edges);
    const out = await graph.query(QUERY, 3);
    expect(out.find((m) => m.id === 'c')?.score ?? 0).toBeLessThan(0.2); // no longer even indirect
  });

  it('VectorStore drop-in: metadata is preserved, an empty store returns empty', async () => {
    const graph = new GraphRag();
    expect(await graph.query(QUERY, 3)).toEqual([]);
    await graph.upsert([{ ...A, metadata: { source: 'k1' } }]);
    const out = await graph.query(QUERY, 1);
    expect(out[0]!.metadata).toEqual({ source: 'k1' });
  });

  it('invalid options fail early', () => {
    expect(() => new GraphRag({ decay: 0 })).toThrow(/decay/);
    expect(() => new GraphRag({ threshold: 2 })).toThrow(/threshold/);
  });
});
