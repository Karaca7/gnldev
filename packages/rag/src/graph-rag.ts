// GraphRAG — retrieval over a similarity GRAPH between chunks (the common "graph RAG" pattern).
// Catches what plain vector search misses: chunks that don't directly resemble the query but are
// STRONGLY connected to chunks that do resemble the query (indirect relevance) join the results.
//
// Design: implements the `VectorStore` interface → DROP-IN for `createRagTool`/`indexDocuments`.
// The graph is in-memory and built from upserted chunks (the common graph-RAG approach also works in-memory
// over chunks); for a persistent corpus, keeping chunks in a persistent store and rebuilding
// GraphRAG as a query-time layer is the user's pattern. Since it runs durable inside `createRagTool`,
// the query RESULT is journaled → the graph isn't retraversed on resume/replay (exactly-once RAG preserved).
import { cosineSimilarity } from 'ai';
import type { VectorStore, VectorItem, VectorMatch } from './vector-store.js';

export interface GraphRagOptions {
  /** Edge threshold: two chunks become neighbors in the graph if their cosine similarity exceeds this. Default 0.75. */
  threshold?: number;
  /** Neighbor expansion depth (hops). 0 = plain vector search. Default 1. */
  hops?: number;
  /** Score decay factor per hop: neighbor's score = source's score × decay × edge weight. Default 0.7. */
  decay?: number;
  /** Number of direct results seeding the expansion (independent of query topK). Default 4. */
  seeds?: number;
}

/**
 * VectorStore that traverses a similarity graph. Edges are built incrementally on upsert (a new
 * item is compared against all existing ones — O(n) / item). Query: the best `seeds` direct results
 * are taken, each seed's neighbors join with a `decay`-attenuated score (for `hops` rounds), the
 * combined list is sorted by score and `topK` is returned. If a node is reached via multiple paths,
 * the HIGHEST score is kept.
 */
export class GraphRag implements VectorStore {
  private items: VectorItem[] = [];
  private byId = new Map<string, number>(); // id → items index
  private edges = new Map<string, { id: string; w: number }[]>(); // id → neighbors (edge weight = similarity)
  private readonly threshold: number;
  private readonly hops: number;
  private readonly decay: number;
  private readonly seeds: number;

  constructor(opts: GraphRagOptions = {}) {
    this.threshold = opts.threshold ?? 0.75;
    this.hops = opts.hops ?? 1;
    this.decay = opts.decay ?? 0.7;
    this.seeds = opts.seeds ?? 4;
    if (this.threshold < -1 || this.threshold > 1) throw new Error('@gnldev/rag GraphRag: threshold must be in the range [-1,1]');
    if (this.decay <= 0 || this.decay > 1) throw new Error('@gnldev/rag GraphRag: 0 < decay <= 1 must hold');
  }

  async upsert(newItems: VectorItem[]): Promise<void> {
    for (const it of newItems) {
      const existing = this.byId.get(it.id);
      if (existing !== undefined) {
        this.items[existing] = it;
        this.rebuildEdgesFor(it.id); // embedding may have changed → refresh edges
        continue;
      }
      this.byId.set(it.id, this.items.length);
      this.items.push(it);
      this.edges.set(it.id, []);
      // Incremental edge building: the new item is scored once against everyone existing.
      for (const other of this.items) {
        if (other.id === it.id) continue;
        const w = cosineSimilarity(it.embedding, other.embedding);
        if (w >= this.threshold) {
          this.edges.get(it.id)!.push({ id: other.id, w });
          this.edges.get(other.id)!.push({ id: it.id, w });
        }
      }
    }
  }

  private rebuildEdgesFor(id: string): void {
    // Strip the old edges from both directions and recompute (upsert-update path; rare).
    for (const [k, list] of this.edges) {
      if (k === id) continue;
      this.edges.set(k, list.filter((e) => e.id !== id));
    }
    const it = this.items[this.byId.get(id)!]!;
    const mine: { id: string; w: number }[] = [];
    for (const other of this.items) {
      if (other.id === id) continue;
      const w = cosineSimilarity(it.embedding, other.embedding);
      if (w >= this.threshold) {
        mine.push({ id: other.id, w });
        this.edges.get(other.id)!.push({ id, w });
      }
    }
    this.edges.set(id, mine);
  }

  async query(embedding: number[], topK: number): Promise<VectorMatch[]> {
    if (this.items.length === 0) return [];
    // 1) Direct similarity: everyone is scored (in-memory corpus; same cost as InMemoryVectorStore).
    const direct = this.items
      .map((it) => ({ id: it.id, score: cosineSimilarity(embedding, it.embedding) }))
      .sort((a, b) => b.score - a.score);

    // 2) Graph expansion: walk from the best `seeds` seeds to their neighbors; score = source × decay × edge.
    const best = new Map<string, number>(direct.map((d) => [d.id, d.score])); // id → best known score
    let frontier = direct.slice(0, this.seeds).map((d) => ({ id: d.id, score: d.score }));
    for (let hop = 0; hop < this.hops; hop++) {
      const next: { id: string; score: number }[] = [];
      for (const node of frontier) {
        for (const e of this.edges.get(node.id) ?? []) {
          const s = node.score * this.decay * e.w;
          if (s > (best.get(e.id) ?? -Infinity)) {
            best.set(e.id, s);
            next.push({ id: e.id, score: s });
          }
        }
      }
      frontier = next;
      if (frontier.length === 0) break;
    }

    // 3) Combined ranking → topK.
    return [...best.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)) // deterministic tie-break by id on equal score
      .slice(0, topK)
      .map(([id, score]) => {
        const it = this.items[this.byId.get(id)!]!;
        return { id, text: it.text, metadata: it.metadata, score };
      });
  }

  /** Observability/test: graph statistics (node/edge count). */
  stats(): { nodes: number; edges: number } {
    let e = 0;
    for (const list of this.edges.values()) e += list.length;
    return { nodes: this.items.length, edges: e / 2 }; // stored bidirectionally
  }
}
