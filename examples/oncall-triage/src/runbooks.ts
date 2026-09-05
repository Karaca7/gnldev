// The runbooks the agent reads before it does anything.
//
// This is the part that makes the example a real one rather than a demo: an on-call agent that
// improvises is worse than no agent. It must answer "what does THIS organisation do about this
// alert", and that answer lives in prose someone wrote at 3am after it happened last time.
//
// Embeddings are deterministic and local — no API key. `@gnldev/cache` wraps them so the same text is
// embedded once across every run, which matters here because the corpus is re-indexed on boot.
import { InMemoryVectorStore, indexDocuments, createRagTool } from '@gnldev/rag';
import { createCache } from '@gnldev/cache';

const RUNBOOKS = [
  {
    id: 'rb-memory',
    text:
      'RUNBOOK — memory saturation. Applies when memory_rss_mb exceeds 1800 for more than 5 minutes. ' +
      'Read the service log first; a leak shows as steadily rising RSS with flat request volume. ' +
      'If the pattern matches, restart the service. A restart is disruptive: it needs SRE approval. ' +
      'After restarting, watch for 30 minutes — a leak that returns within that window is a code bug, ' +
      'not a capacity problem, and must be escalated rather than restarted again.',
  },
  {
    id: 'rb-latency',
    text:
      'RUNBOOK — latency regression. Applies when p99 exceeds 2000ms. Do NOT restart. Latency is ' +
      'almost always downstream: check the database first, then the cache hit rate. Restarting a ' +
      'service under latency pressure moves the queue, it does not shorten it, and it drops the ' +
      'in-flight requests that were about to succeed.',
  },
  {
    id: 'rb-disk',
    text:
      'RUNBOOK — disk pressure. Applies when disk_used_pct exceeds 90. Rotate logs before anything ' +
      'else; in most incidents the growth is log volume, not data. Never delete data files to free ' +
      'space during an incident.',
  },
  {
    id: 'rb-escalation',
    text:
      'RUNBOOK — escalation. Page the on-call engineer once and only once per incident. A second page ' +
      'for the same incident trains people to ignore the first. If a second opinion is needed, ask the ' +
      'database specialist rather than paging again.',
  },
];

/** Deterministic local embedding — character histogram, normalised. Good enough to rank four docs. */
function rawEmbed(text: string): number[] {
  const v = new Array(32).fill(0);
  for (const ch of text.toLowerCase()) v[ch.charCodeAt(0) % 32] += 1;
  const len = Math.hypot(...v) || 1;
  return v.map((n) => n / len);
}

export async function buildRunbooks(cacheStore: any) {
  const store = new InMemoryVectorStore();
  const cache = createCache(cacheStore, 'embed');
  const embed = async (t: string) => cache.getOrCompute(t, async () => rawEmbed(t));
  await indexDocuments(store, embed, RUNBOOKS);
  const searchRunbook = createRagTool({
    store,
    embed,
    topK: 1,
    description: 'Finds the runbook for an alert. Always read this before acting.',
  });
  return { searchRunbook, embed };
}
