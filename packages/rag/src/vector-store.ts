import { cosineSimilarity } from 'ai';
import { visibleToSubject, vectorWriteBatch, assertSameVectorOwner, vectorDeletePlan, vectorDeleteMatcher, vectorQueryScope, vectorMetadataMatches, vectorItemCopy } from '@gnldev/durable';

export interface VectorDoc {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
  /** 7.2: optional collection/namespace split — isolated data sets within the same store. */
  namespace?: string;
  /** The end user this document belongs to. See `QueryOptions.visibleTo`. */
  owner?: string;
  /** Visible to every end user of the namespace: the organization's general documents. */
  shared?: boolean;
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
  /**
   * Answer on behalf of this end user: only their own documents (`owner`) and everyone's (`shared`).
   * An unlabelled document is neither, so a label forgotten at upload reads as "not found" rather
   * than as "everyone's". `createRagTool` fills it in from the run; omitted means no narrowing.
   */
  visibleTo?: string;
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
  /** Every document of this end user — `owner` is a label, not metadata, so `filter` cannot reach it. */
  owner?: string;
  /** Only documents outside every organization (`org:<id>` namespaces) — see @gnldev/durable `VectorDeleteWhere`. */
  outsideOrganizations?: boolean;
}

export interface VectorStore {
  upsert(items: VectorItem[]): Promise<void>;
  /** 7.2: opts is backward compatible — `query(embedding, topK)` behaves identically to before if not given. */
  query(embedding: number[], topK: number, opts?: QueryOptions): Promise<VectorMatch[]>;
  /** 7.2 (optional): delete by id/filter/namespace, returns the number deleted. */
  delete?(where: DeleteWhere): Promise<number>;
  /** `true` when `delete` honours `outsideOrganizations`; erasure refuses a store that does not say so. */
  readonly deleteOutsideOrganizations?: boolean;
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
  // The one reading, shared with the @gnldev/durable stores (which ignored `filter` until they used it).
  return vectorMetadataMatches(metadata, filter);
}

/** In-memory vector store (cosine similarity). The pgvector adapter implements the same interface for prod. */
export class InMemoryVectorStore implements VectorStore {
  readonly deleteOutsideOrganizations = true;
  private items: VectorItem[] = [];

  async upsert(items: VectorItem[]): Promise<void> {
    // The one write rule every store runs (@gnldev/durable vectorWriteBatch): labels, the owner-id
    // rule, one id twice in a batch. Then the whole batch is checked against what is stored, so a
    // refused batch leaves no half.
    const batch = vectorWriteBatch(items);
    for (const it of batch) assertSameVectorOwner(this.items.find((x) => x.id === it.id), it);
    for (const it of batch) {
      const own = vectorItemCopy(it); // a copy, as the SQL stores keep one
      const i = this.items.findIndex((x) => x.id === it.id);
      if (i >= 0) this.items[i] = own;
      else this.items.push(own);
    }
  }

  async query(embedding: number[], topK: number, opts?: QueryOptions): Promise<VectorMatch[]> {
    const w = opts?.keywordWeight ?? 0;
    const hybrid = w > 0 && !!opts?.text;
    const scope = vectorQueryScope(opts);
    if (scope.none) return [];
    const out: VectorMatch[] = [];
    for (const it of this.items) {
      // 7.2: namespace + metadata narrowing (BEFORE score computation — no wasted work).
      if (scope.namespace !== undefined && it.namespace !== scope.namespace) continue;
      if (!matchesFilter(it.metadata, opts?.filter)) continue;
      if (!visibleToSubject(it, scope.visibleTo)) continue;
      const vec = cosineSimilarity(embedding, it.embedding);
      // 7.2: hybrid → (1-w)·vector + w·keyword; otherwise pure vector (old behavior).
      const score = hybrid ? (1 - w) * vec + w * keywordScore(opts!.text!, it.text) : vec;
      if (opts?.minScore !== undefined && score < opts.minScore) continue;
      out.push({ id: it.id, text: it.text, metadata: it.metadata, namespace: it.namespace, ...(it.owner !== undefined ? { owner: it.owner } : {}), ...(it.shared ? { shared: true } : {}), score });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  async delete(where: DeleteWhere): Promise<number> {
    // No condition (`{}`, `{ ids: [] }`, `{ filter: {} }`) deletes NOTHING — the one rule, vectorDeletePlan.
    const w = vectorDeletePlan(where);
    if (!w) return 0;
    const before = this.items.length;
    // ALL given conditions must match — the one reading, vectorDeleteMatcher.
    const gone = vectorDeleteMatcher(w);
    this.items = this.items.filter((it) => !gone(it));
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
