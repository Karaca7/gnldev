// @gnldev/memory — rich agent memory, durable twist. AgentMemory implements `Memory` (compatible with run.ts)
// + a rich `loadContext` hook. GREENFIELD: storage is split into two ports —
//   • MemoryStore (storage.memory): thread/message/working-memory/observations (derived, queryable).
//   • RunJournal   (storage.runs):   OM's LLM memoization + durable progress (replay is deterministic).
// LoadContext runs BEFORE persistInput, so the whole context freezes into `:input` = replayable.
import { cosineSimilarity } from 'ai';
import { requireCapability, durableProcessorStep } from '@gnldev/durable';
import { PROVENANCE_RECENT_CAP, messagePreview } from '@gnldev/durable';
import type { Storage, RunJournal, MemoryStore, MessageRecord, MessageAppend, ThreadRecord, RecallOptions, MemoryContextProvenance, RecalledMessageRef } from '@gnldev/durable';
import { messageText, hasNorm, type Embed } from './keys.js';
import { deepMerge } from './deep-merge.js';
import { createWorkingMemoryTool, renderWorkingMemorySystem, type WorkingMemoryConfig } from './working-memory.js';
import { observe, reflect, approxTokens, resolveModel, type ObservationalMemoryConfig, type Observation, type OmRecallMatch } from './observational.js';

export type { ThreadRecord, RecallOptions };

export interface MemoryConfig {
  /** Storage (provides RunJournal + MemoryStore). memory capability is required. */
  storage: Storage;
  embed?: Embed;
  /** The last N messages, always included. */
  recentN?: number;
  /**
   * P1.5 flows end-to-end into `store.recall` on every query-driven
   * `getMessages`/`loadContext` call (see `getMessages` below — `{...this.recallDefaults, scope, resourceId}`).
   * `topK`/`threshold`/`scope` were already honored; `messageRange` (expand each hit with before/after
   * Neighbors by seq, deduped) and `filter` (now `$eq`/`$ne`/`$gt`/`$gte`/`$lt`/`$lte`/`$in`/`$nin`
   * Operators, not just bare-value equality — see `@gnldev/durable`'s `matchFilter`) are now honored by
   * Every first-party MemoryStore adapter (in-memory/sqlite/postgres). No default changed here.
   */
  recall?: RecallOptions;
  workingMemory?: WorkingMemoryConfig;
  observationalMemory?: ObservationalMemoryConfig;
  /** Generates a thread title from the first user message (opt.; e.g. via LLM). */
  generateTitle?: (firstUserText: string) => Promise<string | undefined>;
}

export interface LoadedContext {
  messages: any[];
  system?: string;
  tools?: Record<string, any>;
  /** Memory-debugging read model: where each injected piece came from (see @gnldev/durable MemoryContextProvenance). */
  provenance?: MemoryContextProvenance;
}

const HUGE = 1_000_000_000; // "fetch everything" page limit (parity; a real consumer uses pagination)
/**
 * The comment this line used to carry — "contains no ':model:'/':tool:' → clean for the reader" —
 * Was true only while nobody named a thread 'model'. `om:model:observedSeq` parses as run 'om' with a
 * Model step (parseJournalKey is text-based), which puts 'om' in the run index and hands the ENTIRE
 * Observational-memory keyspace to the next retention sweep. Same class as the measured `mem:`
 * Deletion in @gnldev/durable's BasicMemory, same boundary fix: the id is validated where the key is
 * Built.
 */
function assertOmThreadId(tid: string): string {
  // Segment-based, not colon-based: colons in thread ids are long-standing supported behaviour
  // (sweepThreads suffix inference); the collision is a SEGMENT named 'model'/'tool'.
  if (/(^|:)(model|tool)(:|$)/.test(tid)) {
    throw new Error(
      `@gnldev/memory: thread id '${tid}' would collide with the journal's key schema — ` +
      `a ':'-delimited segment named 'model' or 'tool' reads as a run record (see parseJournalKey in @gnldev/durable)`,
    );
  }
  return tid;
}
const omKey = (tid: string, k: string) => `om:${assertOmThreadId(tid)}:${k}`;
/** The pseudo-runId OM's durable steps run under — validated for the same reason as omKey. */
const omRunId = (tid: string) => `om:${assertOmThreadId(tid)}`;

let idCounter = 0;
function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${(idCounter++).toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export class AgentMemory {
  /** Storage (shared by tests/cli). */
  readonly storage: Storage;
  protected runs: RunJournal;
  protected store: MemoryStore;
  protected embed?: Embed;
  protected recentN: number;
  protected recallDefaults: RecallOptions;
  protected wm?: WorkingMemoryConfig;
  protected om?: ObservationalMemoryConfig;
  protected titleGen?: (firstUserText: string) => Promise<string | undefined>;

  constructor(config: MemoryConfig) {
    requireCapability(config.storage, 'memory');
    this.storage = config.storage;
    this.runs = config.storage.runs;
    this.store = config.storage.memory!;
    this.embed = config.embed;
    this.recentN = config.recentN ?? 6;
    this.recallDefaults = { topK: 3, threshold: 0, messageRange: 0, scope: 'thread', ...config.recall };
    this.wm = config.workingMemory;
    this.om = config.observationalMemory;
    this.titleGen = config.generateTitle;
  }

  protected async allMessages(threadId: string): Promise<MessageRecord[]> {
    return (await this.store.getMessages(threadId, { limit: HUGE })).items;
  }

  /**
   * The store assigns `seq`. This method must NOT.
   *
   * It used to open with `const existing = await this.allMessages(threadId); let seq = existing.length`
   * — read the whole thread, take its length as the next position, write there. Two runs answering one
   * thread both read the same length, both claimed the same positions, and the adapters' `(threadId,
   * seq)` CAS silently discarded the loser. Measured against real Postgres: a third of all messages
   * gone, and when the drop covered only PART of a batch it left a tool-call with no tool-result,
   * which fails later turns on that thread at the provider until it slides out of the memory window
   * (measured: 5 consecutive failures with the default `chat` preset).
   *
   * Deleting the read also deletes a quadratic: `allMessages` is `getMessages(limit: HUGE)`, i.e. a
   * COUNT plus a full-history SELECT, and it ran twice per turn on a thread that only grows. Measured
   * at saturation, this method got 1.44x faster, and the cost of an append stopped scaling with depth
   * (0.75ms -> 1.67ms across 14..400 messages became a flat 0.37ms). Roughly 85% of that came from
   * removing this read, not from the batching around it.
   *
   * Embedding still happens HERE, before the store call, and that placement is load-bearing: the store
   * takes a per-thread lock for the duration of its transaction, and a remote embedding provider inside
   * that lock would hold it for the length of a network round trip per message. Measured with a 200ms
   * provider: 8 concurrent writers went from 44ms to 1624ms when the embed sat inside the lock.
   */
  async append(threadId: string, messages: any[]): Promise<void> {
    const rows: MessageAppend[] = [];
    for (const message of messages) {
      const text = messageText(message);
      const embedding = text && this.embed ? await this.embed(text) : undefined;
      rows.push({ threadId, role: message?.role ?? 'user', text, embedding, metadata: message?.metadata, ts: Date.now(), message });
    }
    await this.store.appendMessages(threadId, rows);
  }

  /**
   * A recalled `tool-call` must arrive with the `tool-result` that answers it, or not arrive at all.
   *
   * Recall selects one message at a time, by embedding similarity, and a `tool` message has no text to
   * embed — `messageText` returns undefined for a pure `tool-result`, so it never becomes a candidate.
   * An assistant message that carries TEXT AND a tool call does have text, so it can be elected alone.
   * Real providers emit that shape constantly ("Let me look that up" plus the call). The result is a
   * prompt holding a call nothing answers, which the AI SDK refuses to send —
   * `MissingToolResultsError`, seen by the caller as `HTTP 400 "Tool result is missing for tool call"`.
   * No concurrency, no crash, one caller: the same provider-level failure as the concurrent-append
   * defect, reached from the opposite direction.
   *
   * REPAIR FIRST, DROP SECOND. The answer is almost always the very next message in the thread, so
   * fetching it costs one read and keeps the memory that recall judged relevant. Only when it cannot be
   * found — truncated, or the run died between the call and its result — is the message dropped, which
   * loses a memory but can never produce a prompt the provider rejects.
   *
   * Calls already answered inside the recent window need nothing: the window is appended after these,
   * so the pair is intact in the final prompt.
   */
  protected async pairRecalledToolCalls(
    injected: MessageRecord[],
    recent: MessageRecord[],
  ): Promise<{ injected: MessageRecord[]; dropped: MessageRecord[] }> {
    /** Tags a row with why it was left out, so provenance can say more than "it is not here". */
    const mark = (r: MessageRecord, reason: 'unanswered-tool-call' | 'duplicate-tool-call-id') =>
      ({ ...r, reason } as MessageRecord & { reason: string });
    const callIds = (m: any): string[] =>
      (Array.isArray(m?.content) ? m.content : [])
        .filter((p: any) => p?.type === 'tool-call').map((p: any) => String(p.toolCallId));
    const resultIds = (m: any): string[] =>
      (Array.isArray(m?.content) ? m.content : [])
        .filter((p: any) => p?.type === 'tool-result').map((p: any) => String(p.toolCallId));

    if (!injected.some((r) => callIds(r.message).length > 0)) return { injected, dropped: [] };

    const answered = new Set<string>();
    for (const m of [...injected, ...recent]) for (const id of resultIds(m.message)) answered.add(id);

    // ONE read per THREAD, not one per candidate. `allMessages` used to sit inside the loop below, so
    // a `topK` of 5 unanswered hits cost five full-thread reads on top of the one `composeTrack1`
    // already did — measured at 30ms on an 800-message thread, which is more than double what removing
    // the read from `append` saved in the same change. A Map rather than a single hoisted read because
    // resource-scoped recall returns rows from OTHER threads, and one hoist would read the wrong one.
    const threads = new Map<string, MessageRecord[]>();
    const readThread = async (tid: string): Promise<MessageRecord[]> => {
      let rows = threads.get(tid);
      if (!rows) { rows = await this.allMessages(tid); threads.set(tid, rows); }
      return rows;
    };

    const out: MessageRecord[] = [];
    const dropped: MessageRecord[] = [];
    // Deduplicate on BOTH sides. A thread that took a stale-marker retry (see F7 in the durability
    // risk audit) holds the same turn twice, at different `seq`, so recall can elect BOTH copies and
    // the `${threadId}:${seq}` dedupe above cannot see it — measured: `topK: 3` put `tc-1` in the
    // prompt as two calls AND two results, before any repair ran. Two blocks sharing a `toolCallId`
    // are not a valid prompt whichever way they got there.
    const seenCall = new Set<string>();
    const seenResult = new Set<string>();
    const claim = (set: Set<string>, ids: string[]) =>
      ids.length > 0 && ids.every((id) => !set.has(id)) && (ids.forEach((id) => set.add(id)), true);

    for (const r of injected) {
      const ids = callIds(r.message);
      if (ids.length === 0) {
        // Not a call. Still guard the result side: a duplicated turn can put the same answer twice.
        const rIds = resultIds(r.message);
        if (rIds.length > 0 && !claim(seenResult, rIds)) { dropped.push(mark(r, 'duplicate-tool-call-id')); continue; }
        out.push(r);
        continue;
      }
      if (!claim(seenCall, ids)) { dropped.push(mark(r, 'duplicate-tool-call-id')); continue; }

      const missing = ids.filter((id) => !answered.has(id));
      if (missing.length === 0) { out.push(r); continue; }

      // NEAREST-AFTER, not first-anywhere. When the same id appears twice, taking the earliest result
      // can hand the model the answer to a DIFFERENT call — a wrong answer is worse than a refused
      // prompt. Searching forward from the call is safe because a batch is written atomically and
      // contiguously under the per-thread lock, so a result never precedes its own call unless a
      // caller placed it there with explicit `seq`, which is that caller's own contract.
      const rows = await readThread(r.threadId);
      const repair: MessageRecord[] = [];
      for (const id of missing) {
        const hit = rows.find((m) => m.seq > r.seq && resultIds(m.message).includes(id));
        if (hit) repair.push(hit);
      }
      const found = new Set(repair.flatMap((m) => resultIds(m.message)));
      if (!missing.every((id) => found.has(id))) { dropped.push(mark(r, 'unanswered-tool-call')); continue; }

      const fresh = repair.filter((m) => claim(seenResult, resultIds(m.message)));
      out.push(r, ...fresh);
      for (const id of found) answered.add(id);
    }
    return { injected: out, dropped };
  }

  /**
   * The observed/unobserved cut moved back to where it does not split a turn.
   *
   * `observedSeq` is a high-water mark that compaction advances by message count or token budget, and
   * neither of those knows what a turn is. Land the cut on the assistant message that made a call and
   * the window opens with the ANSWER to a call the model was never shown — which Anthropic and OpenAI
   * both reject, the same way they reject the mirror-image case recall used to produce.
   *
   * Moving the boundary back rather than dropping the orphan: the result is worth nothing without the
   * call, and the call is one message away. Extending is cheap and preserves what compaction was
   * summarising around; dropping would hide a turn's outcome from the model while its question stayed
   * visible. Only the messages actually needed are pulled in — a window that already starts on a
   * boundary is returned untouched.
   */
  protected windowFromTurnBoundary(all: MessageRecord[], observedSeq: number): MessageRecord[] {
    const idsIn = (m: any, type: string): string[] =>
      (Array.isArray(m?.content) ? m.content : [])
        .filter((p: any) => p?.type === type).map((p: any) => String(p.toolCallId));

    const window = all.filter((m) => m.seq > observedSeq);
    if (window.length === 0) return window;

    const shown = new Set(window.flatMap((m) => idsIn(m.message, 'tool-call')));
    const orphans = new Set(window.flatMap((m) => idsIn(m.message, 'tool-result')).filter((id) => !shown.has(id)));
    if (orphans.size === 0) return window;

    // The call sits before the cut. Take the earliest one that is needed and start there.
    let start = observedSeq;
    for (const m of all) {
      if (m.seq > observedSeq) break;
      if (idsIn(m.message, 'tool-call').some((id) => orphans.has(id))) { start = m.seq - 1; break; }
    }
    return all.filter((m) => m.seq > start);
  }

  /**
   * `append`, but at most once for a given `batchKey` — present only when the store can write the
   * batch identity in the same transaction as the rows. Absent stores leave run.ts on its marker.
   *
   * Embedding still happens before the store call, for the reason given on `append`: the store holds a
   * per-thread lock across its transaction, and a remote embedding provider inside it would hold that
   * lock for a network round trip per message.
   */
  async appendOnce(threadId: string, messages: any[], batchKey: string): Promise<boolean> {
    if (!this.store.appendMessagesOnce) { await this.append(threadId, messages); return true; }
    const rows: MessageAppend[] = [];
    for (const message of messages) {
      const text = messageText(message);
      const embedding = text && this.embed ? await this.embed(text) : undefined;
      rows.push({ threadId, role: message?.role ?? 'user', text, embedding, metadata: message?.metadata, ts: Date.now(), message });
    }
    return this.store.appendMessagesOnce(threadId, rows, batchKey);
  }

  /** Track 1: last N + query-based topK recall. */
  async getMessages(threadId: string, opts?: { query?: string; resourceId?: string; scope?: 'thread' | 'resource' }): Promise<any[]> {
    return (await this.composeTrack1(threadId, opts)).messages;
  }

  /**
   * Track 1 with PROVENANCE: the shared core of getMessages and loadContext's non-OM branch.
   * Behavior of `messages` is byte-for-byte the old getMessages; `recalled`/`recentCount` are the
   * New read-model — which records semantic recall injected (hits with their similarity, range
   * Neighbors unscored — see MessageRecord.score) vs how many came from the recent window.
   */
  /** MessageRecord → provenance ref. Preview: stored text first; when the message is STRUCTURAL
      (tool-call/tool-result — no text parts), the shared messagePreview renders it structurally
      instead of leaving an empty "—" row. */
  protected static toRef(r: MessageRecord): RecalledMessageRef {
    const textual = (r.text ?? messageText(r.message) ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    return {
      threadId: r.threadId,
      seq: r.seq,
      role: r.role,
      preview: textual || messagePreview(r.message),
      ...(r.score !== undefined ? { score: r.score } : {}),
    };
  }

  protected async composeTrack1(
    threadId: string,
    opts?: { query?: string; resourceId?: string; scope?: 'thread' | 'resource' },
  ): Promise<{ messages: any[]; recalled: RecalledMessageRef[]; recent: RecalledMessageRef[]; recentCount: number; dropped?: RecalledMessageRef[]; droppedCount?: number }> {
    const all = await this.allMessages(threadId);
    const recent = all.slice(-this.recentN);
    // The "it all fits in the recent window, so there is nothing left to recall" short-circuit is
    // sound for thread scope and WRONG for resource scope: `all` is THIS thread's history, while a
    // resource-scoped recall reaches the user's OTHER threads. Applying it to both meant cross-thread
    // recall never fired on a new conversation — exactly the turns it exists for. With the shipped
    // `assistant` preset (recentN: 8) that silently disabled the feature for the first four exchanges.
    const effectiveScope = opts?.scope ?? this.recallDefaults.scope;
    const fitsInWindow = all.length <= this.recentN && effectiveScope !== 'resource';
    if (!opts?.query || !this.embed || fitsInWindow) {
      const window = all.length <= this.recentN ? all : recent;
      return {
        messages: window.map((e) => e.message),
        recalled: [],
        recent: window.slice(-PROVENANCE_RECENT_CAP).map((e) => AgentMemory.toRef(e)),
        recentCount: window.length,
      };
    }
    const qEmb = await this.embed(opts.query);
    const recalled = await this.store.recall(threadId, qEmb, {
      ...this.recallDefaults,
      scope: opts.scope ?? this.recallDefaults.scope,
      resourceId: opts.resourceId,
    });
    const recentSeqs = new Set(recent.map((e) => e.seq));
    const deduped = recalled.filter((r) => !(r.threadId === threadId && recentSeqs.has(r.seq)));
    const paired = await this.pairRecalledToolCalls(deduped, recent);
    // A row recall chose but pairing pulled in is marked `origin: 'repair'` so the inspector can tell
    // it from a similarity hit; a row pairing left out goes to `dropped`, never to `recalled`.
    const chosen = new Set(deduped.map((r) => `${r.threadId}:${r.seq}`));
    return {
      messages: [...paired.injected.map((r) => r.message), ...recent.map((e) => e.message)],
      recalled: paired.injected.map((r) => {
        const ref = AgentMemory.toRef(r);
        return chosen.has(`${r.threadId}:${r.seq}`) ? ref : { ...ref, origin: 'repair' as const };
      }),
      dropped: paired.dropped.length
        ? paired.dropped.slice(0, PROVENANCE_RECENT_CAP).map((r) => ({
          ...AgentMemory.toRef(r),
          ...(({ reason: (r as MessageRecord & { reason?: string }).reason }) as { reason?: any }),
        }))
        : undefined,
      droppedCount: paired.dropped.length || undefined,
      recent: recent.slice(-PROVENANCE_RECENT_CAP).map((e) => AgentMemory.toRef(e)),
      recentCount: recent.length,
    };
  }

  /**
   * FLOW-10: truncate a thread's message history at `afterIndex` — the message AT `afterIndex` is
   * KEPT, everything AFTER it is permanently deleted from the store. Delegates to the (optional)
   * `MemoryStore.deleteMessagesAfter(threadId, afterSeq)` port method, converting the caller-facing
   * INDEX to the store's `seq`.
   *
   * INDEX BASE: `afterIndex` indexes into the SAME array `getMessages(threadId)` (no `opts`) would
   * Return — i.e. exactly what Studio's `GET /threads/:id/messages` route shows (it calls
   * `resolvedMemory.getMessages(threadId)` with no query, see `packages/studio/src/server.ts`). Note
   * This is NOT always the thread's full history: per `getMessages` above, when the thread has more
   * Than `recentN` messages, the no-query path returns only the LAST `recentN` — `afterIndex` is
   * Relative to that same (possibly windowed) list, matching what a Studio user actually sees.
   *
   * `afterIndex === -1` is a special sentinel meaning "clear this thread's entire message history"
   * (from the very first message, seq 0 onward) — NOT just the displayed window's start. This bypasses
   * The windowed-index mapping above entirely (maps straight to the store's "afterSeq < min seq ⇒
   * Removes all" boundary).
   *
   * Any other out-of-range `afterIndex` (< -1, or >= the displayed list's length) is a no-op: returns
   * `0`, mirroring the port's own "afterSeq >= max seq → 0" boundary contract, rather than throwing.
   *
   * Returns `null` — distinct from `0` — when the underlying `MemoryStore` doesn't implement
   * `deleteMessagesAfter` at all (adapter capability gap), so a caller (e.g. Studio's route) can
   * Answer "not supported" (501) instead of reporting a silent no-op.
   *
   * NOT touched: observation records (`store.getObservations`/`putObservations`). After a truncation,
   * An existing observation's `fromSeq`/`toSeq` range may now point partly or wholly at deleted
   * Messages (`expandObservation` would then return a partial/empty slice for that range). Reconciling
   * Observations with a truncated history is out of scope here.
   */
  async truncateMessagesAfter(threadId: string, afterIndex: number): Promise<number | null> {
    const del = this.store.deleteMessagesAfter;
    if (!del) return null;
    if (afterIndex === -1) return del.call(this.store, threadId, -1);
    if (!Number.isInteger(afterIndex) || afterIndex < -1) return 0;
    const all = await this.allMessages(threadId);
    const displayed = all.length <= this.recentN ? all : all.slice(-this.recentN);
    if (afterIndex >= displayed.length) return 0;
    const seq = displayed[afterIndex]!.seq;
    return del.call(this.store, threadId, seq);
  }

  /** Rich context hook (run.ts feature-detects it). */
  async loadContext(threadId: string, opts: { query?: string; resourceId?: string; incoming?: any[] }): Promise<LoadedContext> {
    if (opts.resourceId) {
      const fu = (opts.incoming ?? []).find((m: any) => m?.role === 'user');
      await this.ensureThreadIndexed(threadId, opts.resourceId, fu ? messageText(fu) : undefined);
    }
    let messages: any[];
    const provenance: MemoryContextProvenance = { recalled: [], recentCount: 0 };
    if (this.om?.enabled) {
      if (this.om.buffering) {
        if (this.om.onCompact && (await this.needsCompaction(threadId))) await this.om.onCompact(threadId);
      } else {
        await this.compactIfNeeded(threadId);
      }
      const obs = (await this.store.getObservations(threadId)).filter((o) => !o.condensed);
      const observedSeq = (await this.runs.get<number>(omKey(threadId, 'observedSeq'))) ?? -1;
      const unobservedRecs = this.windowFromTurnBoundary(await this.allMessages(threadId), observedSeq);
      const unobserved = unobservedRecs.map((m) => m.message);
      messages = obs.length
        ? [{ role: 'system', content: `# Observations\n${obs.map((o) => o.text).join('\n')}` }, ...unobserved]
        : unobserved;
      provenance.recentCount = unobserved.length;
      provenance.recent = unobservedRecs.slice(-PROVENANCE_RECENT_CAP).map((m) => AgentMemory.toRef(m));
      provenance.observationCount = obs.length;
    } else {
      const t1 = await this.composeTrack1(threadId, { query: opts.query, resourceId: opts.resourceId });
      messages = t1.messages;
      provenance.recalled = t1.recalled;
      provenance.recent = t1.recent;
      provenance.recentCount = t1.recentCount;
      // Forward the pairing outcome too. Assembling provenance field-by-field here is what let the
      // first version of these fields exist in `composeTrack1` and never reach a caller.
      if (t1.droppedCount) { provenance.droppedCount = t1.droppedCount; provenance.dropped = t1.dropped; }
    }
    const out: LoadedContext = { messages, provenance };
    if (this.wm) {
      out.system = renderWorkingMemorySystem(await this.readWM(threadId, opts.resourceId), this.wm);
      if (out.system) provenance.workingMemoryChars = out.system.length;
      if (!this.wm.readOnly) {
        out.tools = createWorkingMemoryTool({ apply: (patch) => this.applyWorkingMemoryUpdate(threadId, patch, opts.resourceId), schema: this.wm.schema });
      }
    }
    return out;
  }

  // ── Track 4: observational memory (durable, RunJournal-memoized) ───────────────
  protected async compactIfNeeded(threadId: string): Promise<void> {
    if (!this.om?.enabled) return;
    const obsCfg = this.om.observation ?? {};
    const tokenMode = obsCfg.tokenThreshold != null;
    const threshold = tokenMode ? obsCfg.tokenThreshold! : (obsCfg.messageThreshold ?? 30);
    const keepBudget = Math.floor(threshold / 2);
    const tok = this.om.countTokens ?? approxTokens;
    const sizeOf = (m: MessageRecord) => (tokenMode ? tok(messageText(m.message) ?? '') : 1);

    for (let guard = 0; guard < 50; guard++) {
      const all = await this.allMessages(threadId);
      const observedSeq = (await this.runs.get<number>(omKey(threadId, 'observedSeq'))) ?? -1;
      const unobserved = all.filter((m) => m.seq > observedSeq);
      const total = unobserved.reduce((n, m) => n + sizeOf(m), 0);
      if (total <= threshold) break;
      const seq = (await this.runs.get<number>(omKey(threadId, 'observeSeq'))) ?? 0;
      let remaining = total;
      const block: MessageRecord[] = [];
      for (const m of unobserved) {
        if (remaining <= keepBudget) break;
        block.push(m);
        remaining -= sizeOf(m);
      }
      if (!block.length) block.push(unobserved[0]!);
      const blockTokens = block.reduce((n, m) => n + tok(messageText(m.message) ?? ''), 0);
      // JOURNALED (RunJournal): the same seq again → the LLM does not run, identical summary (replayable). Observer token-tier.
      const summary = await durableProcessorStep(
        this.runs as any, omRunId(threadId), `observe:${seq}`,
        () => observe(resolveModel(this.om!.observerModel, blockTokens), block.map((m) => m.message)),
      );
      const newObserved = block.reduce((mx, m) => Math.max(mx, m.seq), observedSeq);
      await this.runs.put(omKey(threadId, 'observedSeq'), newObserved);
      // Explicit `Observation[]` (the LOCAL, P2-extended shape — see observational.ts): the durable
      // MemoryStore port's own Observation type has no fromSeq/toSeq/threadId; every durable Observation
      // Structurally satisfies the local (superset, all-optional-extras) type, so this widens the read
      // Without touching @gnldev/durable.
      const obs: Observation[] = await this.store.getObservations(threadId);
      // P2-memory `block` is a seq-ascending prefix of `unobserved` (pushed in
      // Order until keepBudget) → its first/last entries ARE the min/max seq — no extra scan needed.
      const fromSeq = block[0]!.seq;
      const toSeq = block[block.length - 1]!.seq;
      const newObs: Observation = { id: `obs-${seq}`, text: summary, createdAt: Date.now(), sourceIds: block.map((m) => String(m.seq)), level: 0, fromSeq, toSeq, threadId };
      obs.push(newObs);
      await this.store.putObservations(threadId, obs);
      await this.runs.put(omKey(threadId, 'observeSeq'), seq + 1);
      // D4-om opt-in vector indexing — no-op when omVectors isn't configured.
      await this.indexObservationVector(threadId, 0, seq, newObs);
      await this.reflectIfNeeded(threadId);
    }
  }

  /** Public compaction — callable from an async buffering worker. */
  async compact(threadId: string): Promise<void> {
    return this.compactIfNeeded(threadId);
  }

  /** Without making an LLM call: has the threshold been exceeded (buffering decision). */
  protected async needsCompaction(threadId: string): Promise<boolean> {
    if (!this.om?.enabled) return false;
    const obsCfg = this.om.observation ?? {};
    const tokenMode = obsCfg.tokenThreshold != null;
    const threshold = tokenMode ? obsCfg.tokenThreshold! : (obsCfg.messageThreshold ?? 30);
    const tok = this.om.countTokens ?? approxTokens;
    const observedSeq = (await this.runs.get<number>(omKey(threadId, 'observedSeq'))) ?? -1;
    const unobserved = (await this.allMessages(threadId)).filter((m) => m.seq > observedSeq);
    const total = tokenMode ? unobserved.reduce((n, m) => n + tok(messageText(m.message) ?? ''), 0) : unobserved.length;
    return total > threshold;
  }

  protected async reflectIfNeeded(threadId: string): Promise<void> {
    const obsThreshold = this.om?.reflection?.observationThreshold ?? 40;
    const obs: Observation[] = await this.store.getObservations(threadId);
    const active = obs.filter((o) => !o.condensed);
    if (active.length <= obsThreshold) return;
    const seq = (await this.runs.get<number>(omKey(threadId, 'reflectSeq'))) ?? 0;
    const condensedText = await durableProcessorStep(
      this.runs as any, omRunId(threadId), `reflect:${seq}`,
      () => reflect(this.om!.reflectionModel ?? this.om!.observerModel, active),
    );
    for (const o of obs) if (!o.condensed) o.condensed = true;
    // P2-memory a reflect-level observation still covers a real source range —
    // The min/max over the ranges of the observations it condenses. Pre-P2 (range-less) inputs are
    // Skipped so a partial mix never fabricates a bogus range.
    const ranged = active.filter((o) => o.fromSeq != null && o.toSeq != null);
    const range = ranged.length ? { fromSeq: Math.min(...ranged.map((o) => o.fromSeq!)), toSeq: Math.max(...ranged.map((o) => o.toSeq!)), threadId } : {};
    const newObs: Observation = { id: `obs-r${seq}`, text: condensedText, createdAt: Date.now(), sourceIds: active.map((o) => o.id), level: 1, ...range };
    obs.push(newObs);
    await this.store.putObservations(threadId, obs);
    await this.runs.put(omKey(threadId, 'reflectSeq'), seq + 1);
    // D4-om opt-in vector indexing — no-op when omVectors isn't configured.
    await this.indexObservationVector(threadId, 1, seq, newObs);
  }

  /**
   * D4-om opt-in vector indexing of a freshly (re)computed observation
   * (called right after `compactIfNeeded`'s observe step [level 0] and `reflectIfNeeded`'s reflect step
   * [level 1] — see both above). No-op if `om.omVectors` isn't configured (the v1 keyword path in
   * `recallObservations` stays the only retrieval mode).
   *
   * EXACTLY-ONCE / idempotency: the embed call is journal-memoized the SAME way observe/reflect already
   * Are — `durableProcessorStep` under the SAME `om:<threadId>` runId, keyed `vec:<level>:<seqKey>` — so a
   * Replay that re-enters this seq (e.g. the "durable twist" cross-instance-replay scenario tested above)
   * Does NOT re-embed (no duplicate embedding cost/non-determinism). The vector id handed to
   * `store.upsert` is DETERMINISTIC (`om:<threadId>:<level>:<seqKey>`, stable across re-compactions of the
   * SAME observation) so even if `upsert` itself ran twice (e.g. a crash between the memoized embed
   * Completing and the upsert landing, then a retry) it OVERWRITES the same row rather than creating a
   * Duplicate. Compaction as a whole is already only memoized at the coarser observe/reflect-text level,
   * Not specifically for indexing — but that's fine BY CONSTRUCTION here: memoized compute + a
   * Deterministic-id upsert is idempotent without any extra CAS/dedup machinery, so there's nothing
   * Further to journal.
   */
  protected async indexObservationVector(threadId: string, level: number, seqKey: number, o: Observation): Promise<void> {
    const ov = this.om?.omVectors;
    if (!ov) return;
    const id = `${omRunId(threadId)}:${level}:${seqKey}`;
    const [embedding] = await durableProcessorStep(
      this.runs as any, omRunId(threadId), `vec:${level}:${seqKey}`,
      () => ov.embed([o.text]),
    );
    await ov.store.upsert([{ id, text: o.text, embedding: embedding!, metadata: { threadId, level, fromSeq: o.fromSeq, toSeq: o.toSeq, obsId: o.id } }]);
  }

  /**
   * P2-memory — OM retrieval mode, v1 (scoped): case-insensitive substring/keyword
   * Match over a thread's stored observations (NO vector index — see observational.ts's module header for
   * The honest follow-up). Returns each match with its source `range` (only present when the observation
   * Carries `fromSeq`/`toSeq`/`threadId` — pre-P2 records won't). Empty/blank query → `[]`.
   */
  async recallObservations(threadId: string, query: string): Promise<OmRecallMatch[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const obs: Observation[] = await this.store.getObservations(threadId);
    return obs
      .filter((o) => o.text.toLowerCase().includes(q))
      .map((o) => ({
        ...o,
        range: o.fromSeq != null && o.toSeq != null && o.threadId ? { threadId: o.threadId, fromSeq: o.fromSeq, toSeq: o.toSeq } : undefined,
      }));
  }

  /**
   * D4-om — OM retrieval mode, vector-indexed: embeds `query` via the
   * SAME `omVectors.embed` used at indexing time, vector-searches `omVectors.store`, and maps hits back to
   * Their stored `Observation` (via the `obsId` carried in each vector's metadata — see
   * `indexObservationVector`), returning them WITH their source `range` exactly like v1's
   * `recallObservations`. FALLS BACK to the v1 keyword/substring match when `om.omVectors` isn't
   * Configured — no behavior change for existing callers who never set it up.
   *
   * Thread scoping: the `@gnldev/durable` `VectorStore` port's `query(embedding, topK)` has no metadata
   * Filter parameter (see `omVectors.store`'s doc in observational.ts), so `{threadId}` narrowing can't be
   * Pushed down to the store — this OVERFETCHES (`max(topK×20, 100)`) and filters by
   * `metadata.threadId === threadId` client-side before slicing to `topK`. Fine for the scoped v1 (small
   * Corpora, same spirit as `expandObservation`'s documented O(thread) scan below); a real filter
   * Push-down on the VectorStore port would be the natural follow-up if this becomes a hot path.
   *
   * A hit whose `obsId` no longer resolves to a stored observation (e.g. condensed/removed since
   * Indexing) is silently skipped rather than fabricating a partial match.
   */
  async recallObservationsSemantic(threadId: string, query: string, opts?: { topK?: number; threshold?: number }): Promise<OmRecallMatch[]> {
    const q = query.trim();
    if (!q) return [];
    if (!this.om?.omVectors) return this.recallObservations(threadId, query); // v1 fallback (documented — no behavior change)
    const topK = opts?.topK ?? 5;
    const threshold = opts?.threshold ?? 0;
    const [qEmbedding] = await this.om.omVectors.embed([q]);
    const overfetch = Math.max(topK * 20, 100);
    const hits = await this.om.omVectors.store.query(qEmbedding!, overfetch);
    const obsById = new Map((await this.store.getObservations(threadId)).map((o) => [o.id, o as Observation]));
    const scoped = hits
      .filter((h) => h.metadata?.threadId === threadId && h.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
    const out: OmRecallMatch[] = [];
    for (const h of scoped) {
      const o = obsById.get(h.metadata?.obsId as string);
      if (!o) continue;
      out.push({ ...o, range: o.fromSeq != null && o.toSeq != null && o.threadId ? { threadId: o.threadId, fromSeq: o.fromSeq, toSeq: o.toSeq } : undefined });
    }
    return out;
  }

  /**
   * Expand an observation's source range back into the raw messages it was distilled from (inclusive
   * `seq` bounds, ascending order). v1 cost note: the MemoryStore port has no per-thread seq-range read —
   * Only a paginated full listing (`getMessages(threadId, {limit, cursor})`, see @gnldev/durable's
   * Storage.ts) — so this filters the thread's FULL message list client-side: O(thread size), not
   * O(range size). Fine for the scoped v1; a real seq-range read on MemoryStore would be the natural
   * Follow-up if this becomes a hot path on long threads.
   */
  async expandObservation(threadId: string, fromSeq: number, toSeq: number): Promise<unknown[]> {
    const all = await this.allMessages(threadId);
    return all.filter((m) => m.seq >= fromSeq && m.seq <= toSeq).map((m) => m.message);
  }

  // ── Track 2: schema working memory ──────────────────────────────────────────
  protected wmKey(threadId: string, resourceId?: string): string {
    return this.wm?.scope === 'resource' && resourceId ? `res:${resourceId}` : threadId;
  }
  protected async readWM(threadId: string, resourceId?: string): Promise<Record<string, unknown>> {
    const v = await this.store.getWorkingMemory(this.wmKey(threadId, resourceId));
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  }

  /**
   * P2-memory per-scopeId promise-chain mutex. `applyWorkingMemoryUpdate` does a
   * Read-merge-write with `await`s in between — two CONCURRENT calls for the same scope (two live WM tool
   * Calls racing in-process, e.g. parallel tool-calls in one step or two overlapping runs on one thread)
   * Could interleave and lose one update (classic read-modify-write race). This map holds, per scopeId,
   * A promise chain: each call awaits the previous link before running its own critical section, so
   * Concurrent updates to the SAME scope serialize; different scopeIds have independent chains and never
   * Wait on each other. Each entry is GC'd once its chain drains (see the `.finally` below) — no unbounded
   * Map growth across the process lifetime.
   *
   * HONEST LIMIT: this is IN-PROCESS ONLY. It does nothing for two separate processes/instances updating
   * The same scope at the same time — that race is already partially mitigated by the durable WM tool path
   * (`createWorkingMemoryTool` marks the tool `idempotent: true` in working-memory.ts, so a *replayed*
   * Update from the SAME run doesn't double-apply), but a true cross-process compare-and-swap on working
   * Memory would need storage-level CAS support (MemoryStore has none today — `setWorkingMemory` is a
   * Plain overwrite). Not silently claimed solved here; a real cross-process fix is future work.
   */
  private wmLocks = new Map<string, Promise<void>>();
  private withWmLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.wmLocks.get(key) ?? Promise.resolve();
    const run = prior.then(fn, fn); // run after prior settles, regardless of prior's own outcome
    const tail = run.then(() => undefined, () => undefined); // chain link must never reject (or the queue stalls)
    this.wmLocks.set(key, tail);
    tail.finally(() => {
      if (this.wmLocks.get(key) === tail) this.wmLocks.delete(key); // GC: only if nobody chained after us
    });
    return run;
  }

  async applyWorkingMemoryUpdate(threadId: string, patch: any, resourceId?: string): Promise<Record<string, unknown>> {
    const key = this.wmKey(threadId, resourceId);
    return this.withWmLock(key, async () => {
      const merged = deepMerge(await this.readWM(threadId, resourceId), patch);
      await this.store.setWorkingMemory(key, merged);
      return merged;
    });
  }
  async getWorkingMemory(threadId: string): Promise<string | undefined> {
    const data = await this.store.getWorkingMemory(threadId);
    if (data === undefined) return undefined;
    return typeof data === 'string' ? data : JSON.stringify(data);
  }
  async setWorkingMemory(threadId: string, value: string): Promise<void> {
    await this.store.setWorkingMemory(threadId, value);
  }

  // ── Track 3: thread + resource management ─────────────────────────────────────
  async getThreadResource(threadId: string): Promise<string | undefined> {
    return (await this.store.getThread(threadId))?.resourceId;
  }
  async createThread(input: { id?: string; resourceId: string; title?: string; metadata?: Record<string, unknown> }): Promise<ThreadRecord> {
    const id = input.id ?? genId('th');
    const now = Date.now();
    const rec: ThreadRecord = { id, resourceId: input.resourceId, title: input.title, metadata: input.metadata, createdAt: now, updatedAt: now };
    await this.store.upsertThread(rec);
    return rec;
  }
  async getThreadById(threadId: string): Promise<ThreadRecord | undefined> {
    return this.store.getThread(threadId);
  }
  /** A resource's threads (createdAt ASC — parity). */
  /** Newest conversation first (createdAt DESC) — the thread-list contract Studio's sidebar renders as-is. */
  async listThreads(opts: { resourceId: string }): Promise<ThreadRecord[]> {
    const page = await this.store.listThreads({ resourceId: opts.resourceId, limit: HUGE });
    return page.items.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  }
  /** All threads (studio global) — same createdAt DESC contract as listThreads, independent of adapter order. */
  async listAllThreads(): Promise<ThreadRecord[]> {
    return (await this.store.listThreads({ limit: HUGE })).items
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  }
  async updateThread(threadId: string, patch: { title?: string; metadata?: Record<string, unknown> }): Promise<ThreadRecord> {
    const rec = await this.store.getThread(threadId);
    if (!rec) throw new Error(`thread '${threadId}' does not exist`);
    const next: ThreadRecord = { ...rec, ...patch, updatedAt: Date.now() };
    await this.store.upsertThread(next);
    return next;
  }
  async deleteThread(threadId: string): Promise<void> {
    await this.store.deleteThread(threadId);
  }
  /** COPY a thread (messages/WM/OM) into a new thread (common thread-clone semantics + ancestry). */
  async cloneThread(srcThreadId: string, opts: { newThreadId?: string; resourceId?: string } = {}): Promise<ThreadRecord> {
    const src = await this.store.getThread(srcThreadId);
    const resourceId = opts.resourceId ?? src?.resourceId ?? 'default';
    const dst = opts.newThreadId ?? genId('th');
    const msgs = (await this.store.getMessages(srcThreadId, { limit: HUGE })).items;
    if (msgs.length) await this.store.appendMessages(dst, msgs.map((m) => ({ ...m, threadId: dst })));
    const wm = await this.store.getWorkingMemory(srcThreadId);
    if (wm !== undefined) await this.store.setWorkingMemory(dst, wm);
    const obs = await this.store.getObservations(srcThreadId);
    if (obs.length) await this.store.putObservations(dst, obs);
    // Also copy the OM RunJournal counters (observedSeq/observeSeq/reflectSeq). Otherwise the clone
    // Would re-observe the already-copied observations from scratch (double observation) AND the `obs-${seq}`
    // Ids would collide with the copied observations (observeSeq/reflectSeq start at 0 but the obs array is already full).
    for (const k of ['observedSeq', 'observeSeq', 'reflectSeq']) {
      const v = await this.runs.get<number>(omKey(srcThreadId, k));
      if (v !== undefined) await this.runs.put(omKey(dst, k), v);
    }
    const now = Date.now();
    const rec: ThreadRecord = { id: dst, resourceId, title: src?.title, metadata: src?.metadata, parentThreadId: srcThreadId, createdAt: now, updatedAt: now };
    await this.store.upsertThread(rec);
    return rec;
  }

  /** Minimal record + optional title for an implicit thread (run without calling createThread). */
  protected async ensureThreadIndexed(threadId: string, resourceId: string, firstText?: string): Promise<void> {
    const existing = await this.store.getThread(threadId);
    if (existing) return;
    const now = Date.now();
    const title = firstText ? firstText.replace(/\s+/g, ' ').trim().slice(0, 80) : undefined;
    await this.store.upsertThread({ id: threadId, resourceId, title, createdAt: now, updatedAt: now });
    if (this.titleGen && firstText) {
      void Promise.resolve(this.titleGen(firstText))
        .then((t) => { const s = (t ?? '').trim(); return s ? this.updateThread(threadId, { title: s.slice(0, 80) }) : undefined; })
        .catch(() => {});
    }
  }
}
