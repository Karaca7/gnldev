import { cosineSimilarity } from 'ai';

export interface VectorDoc {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
  /** 7.2: optional collection/namespace split — isolated data sets within the same store. */
  namespace?: string;
}
export interface VectorItem extends VectorDoc {
  embedding: number[];
}
export interface VectorMatch extends VectorDoc {
  score: number;
}

/** 7.2: query narrowing/blending options (all optional → old behavior if not given). */
export interface QueryOptions {
  /** Only items in this namespace (matches item.namespace from upsert). All items if not given. */
  namespace?: string;
  /** Metadata SHALLOW equality filter: EVERY given key must match item.metadata with the SAME value. */
  filter?: Record<string, unknown>;
  /** Score threshold: matches whose final score falls BELOW this value are FILTERED OUT (cosine ~0..1). */
  minScore?: number;
  /** Hybrid search: if given, the keyword score (BM25-lite) is blended with the vector score. */
  text?: string;
  /** Hybrid weight w (0..1): final = (1-w)·vector + w·keyword. Default 0 → vector only (old behavior). */
  keywordWeight?: number;
}

/** 7.2: delete condition — id list and/or metadata filter and/or namespace. */
export interface DeleteWhere {
  ids?: string[];
  filter?: Record<string, unknown>;
  namespace?: string;
}

export interface VectorStore {
  upsert(items: VectorItem[]): Promise<void>;
  /** 7.2: opts is backward compatible — `query(embedding, topK)` behaves identically to before if not given. */
  query(embedding: number[], topK: number, opts?: QueryOptions): Promise<VectorMatch[]>;
  /** 7.2 (optional): delete by id/filter/namespace, returns the number deleted. */
  delete?(where: DeleteWhere): Promise<number>;
}

/** text → embedding function. Wired to the AI SDK `embed` in prod; faked in tests. */
export type Embed = (text: string) => Promise<number[]>;

// ── 7.2 Hybrid helpers (pure, testable) ──────────────────────────

/**
 * Simple tokenization: lowercase, then keep runs of letters and digits.
 *
 * Unicode-aware on purpose. The previous character class was `[^a-z0-9çğıöşü]`, i.e. ASCII plus the
 * six Turkish letters — so `Grüße`, `français` and `mañana` were each split at the accent and scored
 * against fragments, silently, on any non-English corpus. @gnldev/evals' tokenizer one package over
 * already used \p{L}/\p{N}; this is the same reading. ASCII behaviour is unchanged.
 */
export function tokenize(s: string): string[] {
  return (s ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * BM25-lite keyword score (0..1): the ratio of query terms MATCHED in the document.
 * Not full BM25 (no IDF/length normalization) — deliberately simple, "lite": a cheap,
 * deterministic keyword signal meant to be blended with the vector score. 0 if the query is empty.
 */
export function keywordScore(query: string, doc: string): number {
  const q = tokenize(query);
  if (q.length === 0) return 0;
  const d = new Set(tokenize(doc));
  let hit = 0;
  for (const t of q) if (d.has(t)) hit++;
  return hit / q.length;
}

/**
 * Metadata shallow equality: does EVERY key in filter exist in item.metadata with the same value.
 *
 * Exported so the other in-repo `VectorStore` implementations narrow the same way. GraphRag used to
 * implement none of this — the second copy of a filtering rule is where the copies start to differ.
 */
export function matchesFilter(metadata: Record<string, unknown> | undefined, filter?: Record<string, unknown>): boolean {
  if (!filter) return true;
  const m = metadata ?? {};
  for (const [k, v] of Object.entries(filter)) {
    if (m[k] !== v) return false;
  }
  return true;
}

/** In-memory vector store (cosine similarity). The pgvector adapter implements the same interface for prod. */
export class InMemoryVectorStore implements VectorStore {
  private items: VectorItem[] = [];

  async upsert(items: VectorItem[]): Promise<void> {
    for (const it of items) {
      const i = this.items.findIndex((x) => x.id === it.id);
      if (i >= 0) this.items[i] = it;
      else this.items.push(it);
    }
  }

  async query(embedding: number[], topK: number, opts?: QueryOptions): Promise<VectorMatch[]> {
    const w = opts?.keywordWeight ?? 0;
    const hybrid = w > 0 && !!opts?.text;
    const out: VectorMatch[] = [];
    for (const it of this.items) {
      // 7.2: namespace + metadata narrowing (BEFORE score computation — no wasted work).
      if (opts?.namespace !== undefined && it.namespace !== opts.namespace) continue;
      if (!matchesFilter(it.metadata, opts?.filter)) continue;
      const vec = cosineSimilarity(embedding, it.embedding);
      // 7.2: hybrid → (1-w)·vector + w·keyword; otherwise pure vector (old behavior).
      const score = hybrid ? (1 - w) * vec + w * keywordScore(opts!.text!, it.text) : vec;
      if (opts?.minScore !== undefined && score < opts.minScore) continue;
      out.push({ id: it.id, text: it.text, metadata: it.metadata, namespace: it.namespace, score });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  async delete(where: DeleteWhere): Promise<number> {
    const before = this.items.length;
    const ids = where.ids ? new Set(where.ids) : undefined;
    this.items = this.items.filter((it) => {
      // Should it be deleted? ALL given conditions must match (ids ∧ filter ∧ namespace).
      if (ids && !ids.has(it.id)) return true;
      if (where.namespace !== undefined && it.namespace !== where.namespace) return true;
      if (where.filter && !matchesFilter(it.metadata, where.filter)) return true;
      // If no condition was given (empty where), delete NOTHING (safe side).
      if (!ids && where.namespace === undefined && !where.filter) return true;
      return false; // delete
    });
    return before - this.items.length;
  }
}

/** Embeds documents and writes them to the store (namespace carried over via VectorDoc). */
export async function indexDocuments(store: VectorStore, embed: Embed, docs: VectorDoc[]): Promise<void> {
  const items: VectorItem[] = await Promise.all(
    docs.map(async (d) => ({ ...d, embedding: await embed(d.text) })),
  );
  await store.upsert(items);
}
