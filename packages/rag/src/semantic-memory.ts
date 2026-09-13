// SemanticMemory — the semantic-recall version of @gnldev/durable's Memory. Embeds past messages and
// stores them in the journal; when a new turn (query) arrives, retrieves relevant OLD messages via
// vector search. Durable/replayable: the recall result falls into runDurable's input journaling
// (frozen on resume); embeddings persist in the journal. (Most semantic-recall implementations don't come with these guarantees.)
import { cosineSimilarity } from 'ai';
import { matchFilter } from '@gnldev/durable';
import type { Memory, Journal } from '@gnldev/durable';
import type { Embed } from './vector-store.js';

export interface SemanticMemoryOptions {
  journal: Journal;
  embed: Embed;
  /** The most recent N messages always included (default 6). */
  recentN?: number;
  /** Number of relevant old messages recalled based on the query (default 3). */
  topK?: number;
}

/**
 * P1.5 the same recall knobs @gnldev/durable's `RecallOptions` exposes, wired
 * through SemanticMemory's local (journal-backed) cosine recall — `Memory.getMessages`'s `opts` is
 * structurally wider here than the base interface (bivariant method params), so this is call-compatible
 * with plain `{query}` callers.
 */
export interface SemanticGetMessagesOptions {
  query?: string;
  /** Minimum cosine similarity to be a candidate (default 0 — any positive score). */
  threshold?: number;
  /** Expand each hit with its before/after neighbors BY LOG POSITION; `n` is sugar for `{before:n,after:n}`. */
  messageRange?: number | { before: number; after: number };
  /** Metadata filter (same operator subset as `@gnldev/durable`'s `matchFilter`), applied BEFORE topK selection. */
  filter?: Record<string, unknown>;
}

interface LogEntry {
  message: any;
  text?: string;
  embedding?: number[];
  metadata?: Record<string, unknown>;
}

function normRange(r?: number | { before: number; after: number }): { before: number; after: number } {
  if (r == null) return { before: 0, after: 0 };
  return typeof r === 'number' ? { before: r, after: r } : r;
}

function messageText(m: any): string | undefined {
  if (typeof m?.content === 'string') return m.content || undefined;
  if (Array.isArray(m?.content)) {
    const t = m.content.filter((p: any) => typeof p?.text === 'string').map((p: any) => p.text).join(' ');
    return t || undefined;
  }
  return undefined;
}

const hasNorm = (v?: number[]): v is number[] => !!v && v.some((x) => x !== 0);

export class SemanticMemory implements Memory {
  private journal: Journal;
  private embed: Embed;
  private recentN: number;
  private topK: number;

  constructor(opts: SemanticMemoryOptions) {
    this.journal = opts.journal;
    this.embed = opts.embed;
    this.recentN = opts.recentN ?? 6;
    this.topK = opts.topK ?? 3;
  }

  private key(threadId: string) {
    return `sem:${threadId}:log`;
  }
  private async load(threadId: string): Promise<LogEntry[]> {
    return (await this.journal.get<LogEntry[]>(this.key(threadId))) ?? [];
  }

  async getMessages(threadId: string, opts?: SemanticGetMessagesOptions): Promise<any[]> {
    const log = await this.load(threadId);
    if (log.length <= this.recentN) return log.map((e) => e.message);
    const recentStart = log.length - this.recentN;
    const recent = log.slice(recentStart);

    if (!opts?.query) return recent.map((e) => e.message);
    const q = await this.embed(opts.query);
    if (!hasNorm(q)) return recent.map((e) => e.message);

    // P1.5 threshold + filter apply BEFORE topK slicing (a filtered-out /
    // below-threshold candidate must not consume a topK slot) — same order as MemoryStore.recall.
    const threshold = opts.threshold ?? 0;
    let scored = log
      .map((e, i) => ({ i, e, score: hasNorm(e.embedding) ? cosineSimilarity(q, e.embedding!) : -1 }))
      .filter((s) => s.i < recentStart) // candidates come from the OLDER portion only (unchanged from before P1.5)
      .filter((s) => s.score > 0 && s.score >= threshold);
    if (opts.filter) scored = scored.filter((s) => matchFilter(s.e.metadata, opts.filter!));
    scored.sort((a, b) => b.score - a.score);
    const hits = scored.slice(0, this.topK);

    // messageRange: expand each hit with its before/after neighbors BY LOG POSITION, dedup overlapping
    // windows, exclude anything already covered by `recent` (avoid duplicating a message twice).
    const range = normRange(opts.messageRange);
    const picked = new Map<number, LogEntry>();
    for (const h of hits) {
      const lo = Math.max(0, h.i - range.before);
      const hi = Math.min(log.length - 1, h.i + range.after);
      for (let idx = lo; idx <= hi && idx < recentStart; idx++) picked.set(idx, log[idx]!);
    }
    const recalled = [...picked.entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => e.message);

    return [...recalled, ...recent.map((e) => e.message)];
  }

  async append(threadId: string, messages: any[]): Promise<void> {
    const log = await this.load(threadId);
    for (const message of messages) {
      const text = messageText(message);
      const embedding = text ? await this.embed(text) : undefined;
      log.push({ message, text, embedding, metadata: message?.metadata });
    }
    await this.journal.put(this.key(threadId), log);
  }

  async getWorkingMemory(threadId: string): Promise<string | undefined> {
    return this.journal.get<string>(`mem:${threadId}:working`);
  }
  async setWorkingMemory(threadId: string, value: string): Promise<void> {
    await this.journal.put(`mem:${threadId}:working`, value);
  }
}
