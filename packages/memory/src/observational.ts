// Track 4 — Observational memory. The Observer summarizes long history into OBSERVATIONS, the Reflector
// compresses observations.
// **Durable twist:** Observer/Reflector LLM calls are journaled via durableProcessorStep → when called
// again with the SAME seq, the LLM does not run, the summary is identical (replayable compaction — most agent-memory implementations don't have this).
// Current: pluggable real tokenizer (`countTokens` hook + `tokenThreshold`, default char/4 `approxTokens`;
// see test/om-tokenizer), async buffering (test/om-async), token-tier model routing (`ModelByTokens`).
// Future (SKIP): time-based/streaming markers, resource-scope OM.
//
// P2-memory — OM retrieval mode, v1 (scoped): each observation now carries the
// source message range it was distilled from (`fromSeq`/`toSeq`/`threadId`, threaded through by
// agent-memory.ts's compactIfNeeded/reflectIfNeeded — see there). `createOmRecallTool` below wraps a
// caller-supplied `recall` closure — v1 bound it to `AgentMemory.recallObservations`, a TEXT/KEYWORD
// (substring) search over stored observations. Matches come back with their range so a caller can
// `expandObservation` back to the raw source messages.
//
// D4-om the promised vector-indexed retrieval now exists — opt-in via
// `ObservationalMemoryConfig.omVectors` (see below). When configured, agent-memory.ts's
// compactIfNeeded/reflectIfNeeded ALSO upsert each new observation into the vector store, and
// `AgentMemory.recallObservationsSemantic` does a real embedding-based search (falling back to the v1
// keyword path when `omVectors` is absent — no behavior change for existing callers).
import { generateText, tool } from 'ai';
import { z } from 'zod';
import { messageText } from './keys.js';

export interface ObservationalMemoryConfig {
  enabled?: boolean;
  /** Observer model OR a token-tiered selector (ModelByTokens). */
  observerModel: any;
  reflectionModel?: any;
  observation?: {
    /** Message-COUNT threshold (v1). */
    messageThreshold?: number;
    /** TOKEN threshold (if given, approximate tokens are used instead of count; char≈token×4). */
    tokenThreshold?: number;
  };
  reflection?: { observationThreshold?: number };
  scope?: 'thread' | 'resource';
  /**
   * Token counter (default: the char/4 heuristic `approxTokens`). For a real tokenizer, give a function
   * like `gpt-tokenizer`/`tokenx`/`js-tiktoken`: `countTokens: (t) => enc.encode(t).length`. Used together with tokenThreshold.
   */
  countTokens?: (text: string) => number;
  /**
   * Async buffering: if true, compaction does NOT run SYNCHRONOUSLY on the read path; when the threshold
   * is exceeded, `onCompact` fires (usually enqueues to @gnldev/queue) → a worker calls `memory.compact(threadId)`.
   * LLM calls (Observer/Reflector) are taken out of the request flow.
   */
  buffering?: boolean;
  onCompact?: (threadId: string) => void | Promise<void>;
  /**
   * D4-om opt-in vector-indexed OM retrieval — the honest follow-up the
   * P2 v1 keyword/substring `recallObservations` promised (see the module header above). When set, EVERY
   * newly (re)computed observation (observe's level-0 AND reflect's level-1) is ALSO upserted into `store`
   * at compaction time (agent-memory.ts's `indexObservationVector`, called from
   * compactIfNeeded/reflectIfNeeded), and `AgentMemory.recallObservationsSemantic` embeds the query and
   * does a real vector search instead of a substring match. Absent (default): behavior is UNCHANGED —
   * `recallObservationsSemantic` transparently falls back to the v1 keyword path, and
   * `createOmRecallTool`'s tool still only does keyword search.
   */
  omVectors?: {
    /**
     * Structural VectorStore (matches `@gnldev/durable`'s `VectorStore` port from packages/durable/src/
     * storage.ts: `upsert(items)` / `query(embedding, topK)` — verified against that port AND its
     * in-memory/sqlite/postgres adapters: NONE of them accept a metadata-filter argument on `query`. So
     * thread-scoping in `recallObservationsSemantic` can't be pushed down to the store — it's done via an
     * OVERFETCH + client-side filter instead (see there for the honest cost note, same spirit as
     * `expandObservation`'s documented O(thread) scan above).
     */
    store: OmVectorStore;
    /** Batched embed (one call may cover several new observations from a single compaction pass). */
    embed: (texts: string[]) => Promise<number[][]>;
  };
}

/** A single vector row (mirrors `@gnldev/durable`'s `VectorItem`/`VectorMatch` shape — kept local so this
 *  package doesn't need a compile-time dependency on `@gnldev/durable`'s exact type, only structural compat). */
export interface OmVectorItem {
  id: string;
  text: string;
  embedding: number[];
  metadata?: Record<string, unknown>;
}
export interface OmVectorMatch {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
  score: number;
}

/** Structural VectorStore port — see `omVectors.store`'s doc above for why there's no filter param. */
export interface OmVectorStore {
  upsert(items: OmVectorItem[]): Promise<void>;
  query(embedding: number[], topK: number): Promise<OmVectorMatch[]>;
}

/** Approximate token count (not a real tokenizer; the char/4 heuristic). */
export function approxTokens(s: string): number {
  return Math.ceil((s?.length ?? 0) / 4);
}

/** Token-tiered model selector: returns a model based on the input token count (cheap↔strong). */
export class ModelByTokens {
  constructor(private tiers: Record<number, any>) {}
  resolve(tokens: number): any {
    const sorted = Object.keys(this.tiers).map(Number).sort((a, b) => a - b);
    for (const t of sorted) if (tokens <= t) return this.tiers[t];
    return this.tiers[sorted[sorted.length - 1]!];
  }
}

/** Resolve if it's a ModelByTokens, otherwise return the model as-is. */
export function resolveModel(model: any, tokens: number): any {
  return model instanceof ModelByTokens ? model.resolve(tokens) : model;
}

export interface Observation {
  id: string;
  text: string;
  createdAt: number;
  sourceIds: string[];
  level: number;
  condensed?: boolean;
  /**
   * P2-memory the source message range this observation was distilled from
   * (inclusive `seq` bounds within `threadId`). Set by the compaction path (agent-memory.ts:
   * compactIfNeeded for level-0 observe, reflectIfNeeded for level-1 reflect — a merged min/max over the
   * active observations it condenses). BACKWARD-COMPATIBLE: absent on pre-P2 records — always guard with
   * `!= null` / optional-chaining, never assume presence.
   */
  fromSeq?: number;
  toSeq?: number;
  threadId?: string;
}

/** An observation as returned by `recallObservations` — the stored fields plus a normalized `range` (only
 *  present when the observation carries `fromSeq`/`toSeq`/`threadId`; see `Observation` above). */
export interface OmRecallMatch extends Observation {
  range?: { threadId: string; fromSeq: number; toSeq: number };
}

/**
 * OM recall tool (P2-memory v1 + D4-om follow-up): an AI SDK tool wrapping
 * caller-supplied recall/expand functions (mirrors `createWorkingMemoryTool`'s `apply`-closure shape — the
 * caller binds `threadId` via `AgentMemory.recallObservations`/`recallObservationsSemantic`/
 * `expandObservation`, this stays store-agnostic — it never touches `AgentMemory` or storage directly).
 * Bind `recall` to `recallObservationsSemantic` to get the semantic path AUTOMATICALLY whenever
 * `observationalMemory.omVectors` is configured (it falls back to the v1 keyword/substring match on its
 * own when `omVectors` is absent — see agent-memory.ts) — this tool doesn't need to know which mode is
 * active. Pass `expand: true` to also fetch each match's original source messages via `expand`.
 */
export function createOmRecallTool(opts: {
  recall: (query: string) => Promise<OmRecallMatch[]>;
  expand: (fromSeq: number, toSeq: number) => Promise<unknown[]>;
}): Record<string, any> {
  return {
    recallObservations: tool({
      description:
        'Search past observations (persistent summaries distilled from older conversation). Uses vector-indexed semantic search when configured, otherwise falls back to a keyword/substring match. Set expand=true to also fetch the original source messages for each match.',
      inputSchema: z.object({
        query: z.string(),
        expand: z.boolean().optional(),
      }),
      execute: async (input: any) => {
        const { query, expand } = input ?? {};
        const matches = await opts.recall(query);
        if (!expand) return { matches };
        const withSource = await Promise.all(
          matches.map(async (m) => ({ ...m, source: m.range ? await opts.expand(m.range.fromSeq, m.range.toSeq) : undefined })),
        );
        return { matches: withSource };
      },
    }),
  };
}

function renderMessages(messages: any[]): string {
  return messages.map((m) => `${m?.role ?? '?'}: ${messageText(m) ?? ''}`).join('\n');
}

/** Observer: summarize a block of messages into persistent observations. */
export async function observe(model: any, messages: any[]): Promise<string> {
  const { text } = await generateText({
    model,
    system:
      'Summarize the following conversation messages into persistent, short OBSERVATIONS (names, preferences, status, open tasks). Write only the observations as bullet points.',
    prompt: renderMessages(messages),
  });
  return text;
}

/** Reflector: compress observations into a single, higher-level, non-contradictory summary. */
export async function reflect(model: any, observations: Observation[]): Promise<string> {
  const { text } = await generateText({
    model,
    system: 'Compress the following observations into a single, higher-level, non-contradictory, and short summary.',
    prompt: observations.map((o) => o.text).join('\n'),
  });
  return text;
}
