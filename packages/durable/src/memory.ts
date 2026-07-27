import type { Journal } from './journal.js';

// Conversation (thread) + working memory. Journal-backed → durable & replayable by construction.
// (Rich memory like semantic recall / observational memory lives in a separate @gnldev/memory package in the future.)

/**
 * One recalled message, as provenance: WHERE it came from and WHY it was selected. `score` is present
 * only on actual similarity hits — a `messageRange` context neighbor rides along unscored. `preview`
 * is a truncated text sample (the full message is already visible in the thread itself); keeping it
 * short keeps the `:memctx` journal record small.
 */
export interface RecalledMessageRef {
  threadId: string;
  seq: number;
  role: string;
  preview: string;
  score?: number;
}

/**
 * "What did memory inject into this turn's context, and why" — assembled by the rich memory's
 * loadContext (recall/OM/WM breakdown) and journaled per run by runDurable/streamDurable under
 * `runKeys.memoryContext` (run.ts). This is the read-model for memory debugging: the frozen `:input`
 * says WHAT the model saw; this record says WHERE each part came from. Every field is a count or a
 * short ref — never full message bodies.
 */
export interface MemoryContextProvenance {
  /** Semantic-recall selections (hits scored, neighbors unscored). Empty when recall didn't run. */
  recalled: RecalledMessageRef[];
  /** Messages injected from the recent window (or OM's unobserved tail). */
  recentCount: number;
  /**
   * The recent-window messages THEMSELVES, as refs (capped at PROVENANCE_RECENT_CAP — `recentCount`
   * stays the true count). This is the "WHAT went to the model" half the counts alone couldn't
   * answer; absent on records written before the field existed (readers fall back to the count).
   */
  recent?: RecalledMessageRef[];
  /** OM path only: number of non-condensed observations injected as a system message. */
  observationCount?: number;
  /** Length of the working-memory system injection (absent = no WM text was injected). */
  workingMemoryChars?: number;
}

/** Ref cap for `provenance.recent` — keeps the ':memctx' record small on long windows. */
export const PROVENANCE_RECENT_CAP = 24;

export interface Memory {
  /**
   * A thread's prior messages (AI SDK ModelMessage[]). If `opts.query` is given, semantic memory
   * implementations may recall relevant (old but similar) messages; simple memory ignores the query.
   * `resourceId`/`scope` (Phase 14): for resource-scope recall (a user's entire threads); simple memory ignores this.
   */
  getMessages(threadId: string, opts?: { query?: string; resourceId?: string; scope?: 'thread' | 'resource' }): Promise<any[]>;
  /** Append new messages to a thread. */
  append(threadId: string, messages: any[]): Promise<void>;
  /** Persistent free-text working memory (optional). */
  getWorkingMemory?(threadId: string): Promise<string | undefined>;
  setWorkingMemory?(threadId: string, value: string): Promise<void>;
  /** The resource (user) id a thread belongs to (optional; enables rich memory). */
  getThreadResource?(threadId: string): Promise<string | undefined>;
  /**
   * Rich path (optional — provided by @gnldev/memory's AgentMemory): composes recall + working memory +
   * observational memory + the WM tool in ONE call. If defined, runDurable/streamDurable use this
   * instead of `getMessages`/`getWorkingMemory`. `provenance` (optional, additive) is the memory-side
   * half of the `:memctx` record — see MemoryContextProvenance above.
   */
  loadContext?(
    threadId: string,
    opts: { query?: string; resourceId?: string; incoming?: any[] },
  ): Promise<{ messages?: any[]; system?: string; tools?: Record<string, any>; provenance?: MemoryContextProvenance }>;
}

/**
 * Memory on top of the journal: messages are stored in the journal → durable via SqliteJournal, crash-resistant.
 * Give it the SAME journal as the run; this way memory is also part of durable state.
 */
export class BasicMemory implements Memory {
  constructor(private readonly journal: Journal) {}

  async getMessages(threadId: string): Promise<any[]> {
    return (await this.journal.get<any[]>(`mem:${threadId}:messages`)) ?? [];
  }

  async append(threadId: string, messages: any[]): Promise<void> {
    const current = await this.getMessages(threadId);
    await this.journal.put(`mem:${threadId}:messages`, [...current, ...messages]);
  }

  async getWorkingMemory(threadId: string): Promise<string | undefined> {
    return this.journal.get<string>(`mem:${threadId}:working`);
  }

  async setWorkingMemory(threadId: string, value: string): Promise<void> {
    await this.journal.put(`mem:${threadId}:working`, value);
  }
}
