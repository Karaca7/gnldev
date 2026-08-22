import { tool } from 'ai';
import type { Tool } from 'ai';
import { z } from 'zod';
import type { VectorStore, Embed } from './vector-store.js';
import type { Reranker } from './rerank.js';

/** One retrieved document as the tool reports it. Named so the tool's public type can be declared. */
export interface RagHit {
  text: string;
  score: number;
  metadata?: Record<string, unknown>;
}

/**
 * RAG tool that an agent can call. When used inside `runDurable`, `durableTool` journals its result
 * → **replayable & exactly-once RAG** (same documents on resume; no new embed/query call).
 * Most RAG implementations don't give this guarantee. If `rerank` is provided, vector results are reordered
 * By the LLM (the rerank call is also journaled → replayable).
 */
export function createRagTool(opts: {
  store: VectorStore;
  embed: Embed;
  topK?: number;
  description?: string;
  /** LLM reranker: reorders the initially fetched `topK` results. */
  rerank?: Reranker;
  /** Number of results to keep after rerank. */
  rerankTopK?: number;
  /**
   * The slice of the corpus this tool may retrieve from.
   *
   * There was no way to express this, and the tool never passed `QueryOptions` to the store at all —
   * so `namespace`, the only isolation mechanism the store layer has, was unreachable through the one
   * documented RAG path. Every agent built from this tool searched the whole index, and every shipped
   * example (README, both GUIDEs, the scaffold recipe, the docs-mcp entry) does exactly that.
   *
   * Build one tool per tenant with their namespace, or pass a function to resolve it per call.
   */
  namespace?: string;
  /** Metadata narrowing, applied by the store alongside `namespace`. */
  filter?: Record<string, unknown>;
// Declared, not inferred: inference makes the emitted .d.ts name a pnpm-internal provider-utils
// path (TS2742) — a package this one neither declares nor should. `Tool` comes from `ai`, the peer
// we already require.
}): Tool<{ query: string }, RagHit[]> & { idempotent: boolean } {
  // H7: read-only search — safe to re-run → idempotent (keeps retry/reclaim smooth).
  return Object.assign(tool({
    description: opts.description ?? 'Retrieves documents relevant to the query from the knowledge base',
    inputSchema: z.object({ query: z.string().describe('search query') }),
    execute: async ({ query }) => {
      const embedding = await opts.embed(query);
      let matches = await opts.store.query(embedding, opts.topK ?? 4, {
        ...(opts.namespace !== undefined ? { namespace: opts.namespace } : {}),
        ...(opts.filter !== undefined ? { filter: opts.filter } : {}),
      });
      if (opts.rerank) matches = await opts.rerank.rerank(query, matches, opts.rerankTopK);
      return matches.map((m): RagHit => ({
        text: m.text,
        score: Number(m.score.toFixed(4)),
        ...(m.metadata ? { metadata: m.metadata } : {}),
      }));
    },
  }), { idempotent: true });
}
