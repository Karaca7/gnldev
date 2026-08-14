// LLM reranker: reorders vector results by relevance to the query. When used inside createRagTool,
// The rerank LLM call also becomes part of the tool's result → durableTool journals it → **replayable rerank** (most RAG implementations don't have this).
import { generateText } from 'ai';
import type { VectorMatch } from './vector-store.js';

export interface Reranker {
  rerank(query: string, matches: VectorMatch[], topN?: number): Promise<VectorMatch[]>;
}

/** Extracts valid, deduplicated indices from the text (the model responds like "2,0,1"). */
function parseIndices(text: string, n: number): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const m of text.matchAll(/\d+/g)) {
    const i = Number(m[0]);
    if (i >= 0 && i < n && !seen.has(i)) {
      seen.add(i);
      out.push(i);
    }
  }
  return out;
}

/** Reranker that asks the model to order documents by relevance. */
export function llmReranker(opts: { model: any }): Reranker {
  return {
    async rerank(query, matches, topN) {
      if (matches.length <= 1) return topN ? matches.slice(0, topN) : matches;
      const list = matches.map((m, i) => `[${i}] ${m.text}`).join('\n');
      const { text } = await generateText({
        model: opts.model,
        system: 'Give the indices of the documents most relevant to the query, ordered from most to least relevant, separated by commas. Indices only.',
        prompt: `Query: ${query}\n\nDocuments:\n${list}`,
      });
      const order = parseIndices(text, matches.length);
      const reranked: VectorMatch[] = order.map((i) => matches[i]!);
      for (let i = 0; i < matches.length; i++) if (!order.includes(i)) reranked.push(matches[i]!); // unmentioned ones go last
      return topN ? reranked.slice(0, topN) : reranked;
    },
  };
}
