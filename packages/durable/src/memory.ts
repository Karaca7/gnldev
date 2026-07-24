import type { Journal } from './journal.js';

// Conversation (thread) + working memory. Journal-backed → durable & replayable by construction.
// (Rich memory like semantic recall / observational memory lives in a separate @gnl/memory package in the future.)

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
   * Rich path (optional — provided by @gnl/memory's AgentMemory): composes recall + working memory +
   * observational memory + the WM tool in ONE call. If defined, runDurable/streamDurable use this
   * instead of `getMessages`/`getWorkingMemory`.
   */
  loadContext?(
    threadId: string,
    opts: { query?: string; resourceId?: string; incoming?: any[] },
  ): Promise<{ messages?: any[]; system?: string; tools?: Record<string, any> }>;
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
