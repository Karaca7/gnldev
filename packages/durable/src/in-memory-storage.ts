// @gnldev/durable/in-memory-storage — Reference (Map) implementation of all store ports.
// Zero-infra test storage (moat): per-storage bundles mimic this behavior.
// Correctness matters, not perf (naive filter/sort). Date.now/Math.random are free to use here (runtime code).
import { cosineSimilarity } from 'ai';
import { InMemoryJournal } from './journal.js';
import { stableStringify } from './hash.js';
import type { JournalEntry, RunSummary } from './journal.js';
import { matchFilter } from './storage.js';
import type {
  Storage, CapabilityMatrix, Page, ListQuery,
  RunJournal, MemoryStore, VectorStore, WorkStore, CacheStore, MetaStore,
  ThreadRecord, MessageRecord, Observation, RecallOptions,
  VectorItem, VectorMatch, LogRecord,
} from './storage.js';

let idc = 0;
function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${(idc++).toString(36)}`;
}

/** Offset-cursor pagination (in-memory reference; real storages use a keyset cursor). */
function paginate<T>(items: T[], q?: ListQuery): Page<T> {
  const start = q?.cursor ? Number(q.cursor) || 0 : 0;
  const limit = q?.limit ?? 50;
  const slice = items.slice(start, start + limit);
  const next = start + limit;
  return { items: slice, nextCursor: next < items.length ? String(next) : undefined };
}

// P1.5 (AUDIT-R2): matchFilter is now shared (storage.ts) — see its JSDoc for the operator
// subset ($eq/$ne/$gt/$gte/$lt/$lte/$in/$nin). Import above (was a local exact-equality-only copy).
function normRange(r?: number | { before: number; after: number }): { before: number; after: number } {
  if (r == null) return { before: 0, after: 0 };
  return typeof r === 'number' ? { before: r, after: r } : r;
}
const hasNorm = (v?: number[]): v is number[] => !!v && v.some((x) => x !== 0);

// ── RunJournal: wrap the existing InMemoryJournal, add paged listRuns ───────────────
class InMemoryRunJournal implements RunJournal {
  constructor(readonly journal = new InMemoryJournal()) {}
  get<T = unknown>(k: string) { return this.journal.get<T>(k); }
  put(k: string, v: unknown) { return this.journal.put(k, v); }
  putIfAbsent(k: string, v: unknown) { return this.journal.putIfAbsent(k, v); }
  /** H1: delegates to InMemoryJournal.putIfMatch (stableStringify comparison, structurally atomic). */
  putIfMatch(k: string, e: unknown, v: unknown) { return this.journal.putIfMatch(k, e, v); }
  listKeys(p: string) { return this.journal.listKeys(p); }
  readRun(runId: string): Promise<JournalEntry[]> { return this.journal.readRun(runId); }
  // Capability parity with the real adapters (sqlite/postgres expose these as extra methods and
  // toJournal forwards whatever exists): the inner InMemoryJournal always had them, but this wrapper
  // silently HID them — so recordRunMetrics bailed at its incrBy/applyBatch gate and InMemoryStorage
  // users got NO materialized metrics rows at all (caught by metrics-stream.test.ts).
  incrBy(k: string, f: Record<string, number>) { return this.journal.incrBy(k, f); }
  getCounters(k: string) { return this.journal.getCounters(k); }
  applyBatch(b: Parameters<InMemoryJournal['applyBatch']>[0]) { return this.journal.applyBatch(b); }
  countRunsByStatus() { return this.journal.countRunsByStatus(); }
  listStaleRuns(cutoffTs: number, opts?: { includeSuspended?: boolean }) { return this.journal.listStaleRuns(cutoffTs, opts); }
  readRunStats(runId: string) { return this.journal.readRunStats(runId); }
  deletePrefix(prefix: string) { return this.journal.deletePrefix(prefix); }
  // P0.3 (AUDIT-R2): filter BEFORE paginate() slices — same "filter before slicing, not
  // after" rule the real adapters follow (sqlite/postgres/redis-storage.ts), so a filtered page never
  // desyncs from an unfiltered scan or drops matching items off a page boundary.
  async listRuns(q?: ListQuery): Promise<Page<RunSummary>> {
    let all = await this.journal.listRuns();
    if (q?.status) all = all.filter((r) => r.status === q.status);
    if (q?.agent) all = all.filter((r) => r.agent === q.agent);
    return paginate(all, q);
  }
}

// ── MemoryStore ───────────────────────────────────────────────────────────────
class InMemoryMemoryStore implements MemoryStore {
  private threads = new Map<string, ThreadRecord>();
  private messages = new Map<string, MessageRecord[]>(); // threadId → seq-ordered rows
  private wm = new Map<string, unknown>();
  private obs = new Map<string, Observation[]>();

  async upsertThread(rec: ThreadRecord) { this.threads.set(rec.id, { ...rec }); }
  async getThread(id: string) {
    const t = this.threads.get(id);
    return t && !t.deletedAt ? { ...t } : undefined;
  }
  async listThreads(q: { resourceId?: string } & ListQuery): Promise<Page<ThreadRecord>> {
    const all = [...this.threads.values()]
      .filter((t) => !t.deletedAt && (q.resourceId == null || t.resourceId === q.resourceId))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return paginate(all, q);
  }
  async deleteThread(id: string) {
    const t = this.threads.get(id);
    if (t) this.threads.set(id, { ...t, deletedAt: Date.now() });
    this.messages.delete(id);
    this.wm.delete(id);
    this.obs.delete(id);
  }

  async appendMessages(threadId: string, rows: MessageRecord[]) {
    const log = this.messages.get(threadId) ?? [];
    const seen = new Set(log.map((m) => m.seq));
    for (const r of rows) {
      if (seen.has(r.seq)) continue; // per-message idempotent (CAS equivalent)
      log.push({ ...r, threadId });
      seen.add(r.seq);
    }
    log.sort((a, b) => a.seq - b.seq);
    this.messages.set(threadId, log);
  }
  async getMessages(threadId: string, q?: ListQuery): Promise<Page<MessageRecord>> {
    return paginate(this.messages.get(threadId) ?? [], q);
  }
  async recall(threadId: string, query: number[], opts: RecallOptions): Promise<MessageRecord[]> {
    if (!hasNorm(query)) return [];
    const byThread = new Map<string, MessageRecord[]>();
    if (opts.scope === 'resource' && opts.resourceId) {
      for (const [tid, rows] of this.messages) {
        const t = this.threads.get(tid);
        if (t && !t.deletedAt && t.resourceId === opts.resourceId) byThread.set(tid, rows);
      }
    } else {
      byThread.set(threadId, this.messages.get(threadId) ?? []);
    }
    const threshold = opts.threshold ?? 0;
    const cand: { m: MessageRecord; tid: string; idx: number; score: number }[] = [];
    for (const [tid, rows] of byThread) {
      rows.forEach((m, idx) => {
        if (!hasNorm(m.embedding)) return;
        const score = cosineSimilarity(query, m.embedding);
        if (score > 0 && score >= threshold) cand.push({ m, tid, idx, score });
      });
    }
    let scored = cand;
    if (opts.filter) scored = scored.filter((c) => matchFilter(c.m.metadata, opts.filter!));
    scored.sort((a, b) => b.score - a.score);
    const hits = scored.slice(0, opts.topK ?? 3);
    const range = normRange(opts.messageRange);
    const picked = new Map<string, MessageRecord>();
    for (const h of hits) {
      const rows = byThread.get(h.tid)!;
      const lo = Math.max(0, h.idx - range.before);
      const hi = Math.min(rows.length - 1, h.idx + range.after);
      for (let i = lo; i <= hi; i++) picked.set(`${h.tid}:${rows[i]!.seq}`, rows[i]!);
    }
    // Provenance parity with sqlite-storage.ts — the spread copy also keeps the STORED record
    // unmutated (this adapter returns direct references for neighbors).
    for (const h of hits) picked.set(`${h.tid}:${h.m.seq}`, { ...h.m, score: h.score });
    return [...picked.values()].sort((a, b) => a.ts - b.ts || a.seq - b.seq);
  }

  async getWorkingMemory(scopeId: string) { return this.wm.get(scopeId); }
  async setWorkingMemory(scopeId: string, data: unknown) { this.wm.set(scopeId, data); }
  async getObservations(threadId: string) { return [...(this.obs.get(threadId) ?? [])]; }
  async putObservations(threadId: string, obs: Observation[]) { this.obs.set(threadId, [...obs]); }

  /** FLOW-10 (reference behavior — see storage.ts JSDoc): keep seq <= afterSeq, drop the rest. */
  async deleteMessagesAfter(threadId: string, afterSeq: number): Promise<number> {
    const log = this.messages.get(threadId);
    if (!log || log.length === 0) return 0;
    const kept = log.filter((m) => m.seq <= afterSeq);
    const removed = log.length - kept.length;
    if (removed > 0) this.messages.set(threadId, kept);
    return removed;
  }
}

// ── VectorStore (cosine, same behavior as rag's InMemoryVectorStore) ───────────
class InMemoryVectorStore implements VectorStore {
  private items: VectorItem[] = [];
  async upsert(items: VectorItem[]) {
    for (const it of items) {
      const i = this.items.findIndex((x) => x.id === it.id);
      if (i >= 0) this.items[i] = it; else this.items.push(it);
    }
  }
  async query(embedding: number[], topK: number): Promise<VectorMatch[]> {
    return this.items
      .map((it) => ({ id: it.id, text: it.text, metadata: it.metadata, score: cosineSimilarity(embedding, it.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}

// ── WorkStore (append-log + KV + CAS ack) ─────────────────────────────────────
class InMemoryWorkStore implements WorkStore {
  private logs = new Map<string, LogRecord[]>();
  private kv = new Map<string, unknown>();
  async append(ns: string, payload: unknown, id?: string): Promise<string> {
    const log = this.logs.get(ns) ?? [];
    const eid = id ?? genId(ns);
    if (!log.some((r) => r.id === eid)) { log.push({ id: eid, payload, ts: Date.now() }); this.logs.set(ns, log); }
    return eid;
  }
  async list<T = unknown>(ns: string, q?: ListQuery): Promise<Page<LogRecord<T>>> {
    return paginate((this.logs.get(ns) ?? []) as LogRecord<T>[], q);
  }
  async get<T = unknown>(key: string) { return this.kv.has(key) ? (this.kv.get(key) as T) : undefined; }
  async put(key: string, value: unknown) { this.kv.set(key, value); }
  async ackOnce(key: string): Promise<boolean> {
    if (this.kv.has(key)) return false;
    this.kv.set(key, true);
    return true;
  }
  /** 8.2: SAME pattern as RunJournal.putIfMatch (stableStringify comparison) — there is NO await
   *  between has→compare→set → structurally atomic in single-threaded JS. */
  async putIfMatch(key: string, expected: unknown, value: unknown): Promise<boolean> {
    if (!this.kv.has(key)) return false;
    if (stableStringify(this.kv.get(key)) !== stableStringify(expected)) return false;
    this.kv.set(key, value);
    return true;
  }
}

// ── CacheStore (with TTL) ───────────────────────────────────────────────────────
class InMemoryCacheStore implements CacheStore {
  private m = new Map<string, { v: unknown; exp?: number }>();
  async get<T = unknown>(key: string): Promise<T | undefined> {
    const e = this.m.get(key);
    if (!e) return undefined;
    if (e.exp != null && e.exp <= Date.now()) { this.m.delete(key); return undefined; }
    return e.v as T;
  }
  async set(key: string, value: unknown, opts?: { ttlMs?: number }) {
    this.m.set(key, { v: value, exp: opts?.ttlMs != null ? Date.now() + opts.ttlMs : undefined });
  }
  async delete(key: string) { this.m.delete(key); }
}

class InMemoryMetaStore implements MetaStore {
  private m = new Map<string, string>();
  async get(key: string) { return this.m.get(key); }
  async set(key: string, value: string) { this.m.set(key, value); }
}

const ALL_FULL: CapabilityMatrix = { runs: 'full', memory: 'full', vectors: 'full', work: 'full', cache: 'full' };

/** Reference storage providing all ports on top of Map. For tests and dev. */
export class InMemoryStorage implements Storage {
  readonly name = 'in-memory';
  readonly capabilities = ALL_FULL;
  readonly runs = new InMemoryRunJournal();
  readonly memory = new InMemoryMemoryStore();
  readonly vectors = new InMemoryVectorStore();
  readonly work = new InMemoryWorkStore();
  readonly cache = new InMemoryCacheStore();
  readonly meta = new InMemoryMetaStore();
  /** Access to the underlying journal for replay/time-travel tests. */
  get journal() { return this.runs.journal; }
}
