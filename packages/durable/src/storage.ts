// @gnldev/durable/storage — Greenfield persistence contracts.
// TYPED store ports + an explicit capability matrix + composite storage, instead of "a single generic journal".
// PRESERVED moat: RunJournal = append-only journal (replay/time-travel). Other concerns are connected to
// Whichever store fits best (composite), as needed. Contracts (pagination/cursor, mandatory CAS) are baked in from day one.
//
// NOTE: this file contains ONLY the INTERFACE + pure helpers (NO storage implementation) → the @gnldev/durable
// Core stays thin; concrete impls (in-memory/sqlite/postgres-storage) implement these ports.

import type { Journal, JournalEntry, RunSummary, JournalReader, RunStatus } from './journal.js';

// ── Common ──────────────────────────────────────────────────────────────────

/** A cursor-based page. If there's no `nextCursor`, it's the last page. (NOT offset → O(log n) on a btree.) */
export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

/** List query — present on every list method from day one (adding it later would be a breaking change). */
export interface ListQuery {
  limit?: number;
  cursor?: string;
  /**
   * P0.3 (RunJournal.listRuns only — MemoryStore/WorkStore ports ignore these):
   * Optional run filters. Semantics MUST match `summarizeRun`'s status derivation (journal.ts:
   * 'suspended' iff the run has ANY tool record with status:'suspended', else 'completed') and the
   * `agent` field `listRuns` already surfaces on `RunSummary` (from the run's invisible `:input`
   * Entry — see the "listRuns surfaces threadId + agent" conformance test). Adapters MUST filter
   * BEFORE slicing to `limit`/`cursor` — filtering after slicing silently drops matching items off a
   * Page and desyncs `nextCursor`.
   */
  status?: RunStatus;
  agent?: string;
  /**
   * WHOSE runs to return — matches `RunSummary.resourceId` exactly (same `:input`-derived field the
   * summary surfaces). Same contract as `agent`: filter BEFORE slicing to `limit`/`cursor`, or a
   * matching item silently falls off a page and `nextCursor` desyncs from what the caller has seen.
   */
  resourceId?: string;
}

// ── 1) RunJournal = the PRESERVED journal ──────────────────────────────────────
// The durable core (run/durable-model/durable-tool/run-lock/time-travel) talks to this.
// ALL replay records live here: <runId>:model/tool/input/wf:*, <runId>:lock, mem-appended:<runId>,
// AND memory's replay-memoization om:<tid>:observe|reflect:<seq>.
// A superset of the existing `Journal` + `JournalReader` → existing adapters satisfy it structurally
// (except for paged listRuns); a RunJournal can be assigned anywhere a `Journal` is expected (putIfAbsent/listKeys are MANDATORY).
export interface RunJournal {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  /** MANDATORY (exactly-once): write+true if the key is absent, don't touch+false if present (atomic CAS). */
  putIfAbsent(key: string, value: unknown): Promise<boolean>;
  /** Keys starting with a given prefix. */
  listKeys(prefix: string): Promise<string[]>;
  /** A run's entries (model/tool), in write order. */
  readRun(runId: string): Promise<JournalEntry[]>;
  /** Runs — PAGINATED (NO full-table scan). */
  listRuns(q?: ListQuery): Promise<Page<RunSummary>>;
}

// ── 2) MemoryStore = derived/queryable conversation artifacts (NOT replay state) ──

export interface ThreadRecord {
  id: string;
  resourceId: string;
  title?: string;
  metadata?: Record<string, unknown>;
  parentThreadId?: string;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

/** A single message row (NOT a blob log → per-message atomic insert). */
export interface MessageRecord {
  threadId: string;
  seq: number;
  role: string;
  text?: string;
  embedding?: number[];
  metadata?: Record<string, unknown>;
  ts: number;
  /** The raw AI SDK message object. */
  message: unknown;
  /**
   * Recall provenance (set ONLY on records returned by `recall()`, and only on the actual similarity
   * HITS — `messageRange` context neighbors ride along unscored). Never persisted: the adapters stamp
   * It on the per-call copy so callers can answer "WHY did this message enter the context" (see
   * MemoryContextProvenance in memory.ts / the `:memctx` journal record). Before this, every adapter
   * Computed the cosine score, used it to rank, and dropped it at the return boundary.
   */
  score?: number;
}

export interface Observation {
  id: string;
  text: string;
  createdAt: number;
  sourceIds: string[];
  level: number;
  condensed?: boolean;
}

export interface RecallOptions {
  topK?: number;
  threshold?: number;
  /**
   * P1.5 expand each recalled hit with its surrounding messages BY SEQ within the
   * Same thread — `n` is sugar for `{before: n, after: n}` (asymmetric windows supported). Adapters
   * (in-memory/sqlite/postgres-storage) apply this AFTER topK selection, dedup overlapping windows, and
   * Return the union in seq order.
   */
  messageRange?: number | { before: number; after: number };
  /**
   * P1.5 metadata filter, applied BEFORE topK selection (a filtered-out message
   * Must not consume a topK slot). `{field: value}` is sugar for `{field: {$eq: value}}`. See
   * `matchFilter` for the full operator subset ($eq/$ne/$gt/$gte/$lt/$lte/$in/$nin).
   */
  filter?: Record<string, unknown>;
  scope?: 'thread' | 'resource';
  resourceId?: string;
}

/**
 * P1.5 metadata filter matcher shared by in-memory/sqlite/postgres-storage's
 * `MemoryStore.recall` (previously three independent copies of a plain exact-equality matcher — unified
 * Here so the operator set can't drift between adapters). ALL top-level fields in `filter` must match
 * (AND). A bare value is sugar for `$eq`: `{lang: 'tr'}` === `{lang: {$eq: 'tr'}}`.
 * Operators: $eq, $ne, $gt, $gte, $lt, $lte, $in, $nin (a common filter-operator subset — the two extra
 * Operators some other implementations have beyond this, $contains/$exists, are deferred; not table-stakes per the P1.5 audit finding).
 */
export function matchFilter(meta: Record<string, unknown> | undefined, filter: Record<string, unknown>): boolean {
  if (!meta) return false;
  return Object.entries(filter).every(([field, spec]) => {
    const val = meta[field];
    if (spec !== null && typeof spec === 'object' && !Array.isArray(spec)) {
      return Object.entries(spec as Record<string, unknown>).every(([op, target]) => matchFilterOp(val, op, target));
    }
    return val === spec;
  });
}

function matchFilterOp(val: unknown, op: string, target: unknown): boolean {
  switch (op) {
    case '$eq': return val === target;
    case '$ne': return val !== target;
    case '$gt': return comparable(val, target) && (val as any) > (target as any);
    case '$gte': return comparable(val, target) && (val as any) >= (target as any);
    case '$lt': return comparable(val, target) && (val as any) < (target as any);
    case '$lte': return comparable(val, target) && (val as any) <= (target as any);
    case '$in': return Array.isArray(target) && target.includes(val);
    case '$nin': return Array.isArray(target) && !target.includes(val);
    default: return false; // unknown operator → fail closed (never silently treated as a pass-through match)
  }
}
// $gt/$gte/$lt/$lte only make sense between values of the SAME orderable type (number/string) — a type
// Mismatch (e.g. comparing a string field against a number target) is a non-match, not a coerced compare.
function comparable(a: unknown, b: unknown): boolean {
  return (typeof a === 'number' || typeof a === 'string') && typeof a === typeof b;
}

export interface MemoryStore {
  upsertThread(rec: ThreadRecord): Promise<void>;
  getThread(id: string): Promise<ThreadRecord | undefined>;
  /** If resourceId is given, that user's threads; otherwise global (studio). PAGINATED. */
  listThreads(q: { resourceId?: string } & ListQuery): Promise<Page<ThreadRecord>>;
  deleteThread(id: string): Promise<void>;

  /** Append messages — per-message idempotent (CAS); a concurrent append neither loses nor double-writes. */
  appendMessages(threadId: string, rows: MessageRecord[]): Promise<void>;
  /** Thread messages — PAGINATED (NO blob loading). */
  getMessages(threadId: string, q?: ListQuery): Promise<Page<MessageRecord>>;
  /** Vector recall (thread or resource scope). */
  recall(threadId: string, queryEmbedding: number[], opts: RecallOptions): Promise<MessageRecord[]>;

  getWorkingMemory(scopeId: string): Promise<unknown>;
  setWorkingMemory(scopeId: string, data: unknown): Promise<void>;

  /** ONLY final/derived observation texts (LLM-memoization stays in RunJournal). */
  getObservations(threadId: string): Promise<Observation[]>;
  putObservations(threadId: string, obs: Observation[]): Promise<void>;

  /**
   * FLOW-10 (optional capability): truncate a thread's tail — deletes every message with
   * `seq > afterSeq`; `afterSeq` itself, and everything before it, is KEPT (afterSeq is EXCLUSIVE
   * As a delete boundary, INCLUSIVE as a keep boundary). Anchored on `MessageRecord.seq` — a stable
   * Per-thread sequence number — rather than a list index, because an index can shift under a
   * Concurrent append while `seq` cannot.
   * Use case: "edit & resend" / "regenerate" in a chat UI. Today those flows only truncate the
   * CLIENT's view; the server-side thread keeps both the abandoned and the corrected turn, so the
   * Next run replays both back to the model. This method lets a caller make the server's history
   * Match what the user sees after such an edit.
   * Returns the number of messages actually removed, so a caller can surface e.g. "6 messages
   * Removed" to the user.
   * Boundary behavior: unknown/nonexistent threadId → 0, never throws. `afterSeq` at or above the
   * Thread's highest existing seq (nothing to remove) → 0. `afterSeq` below the thread's lowest
   * Existing seq → removes ALL of the thread's messages and returns that count.
   * OPTIONAL: adapters that don't implement this leave the method `undefined`. Callers MUST treat an
   * Absent method as "capability not available" (e.g. respond 501 / fall back) — never call it
   * Unconditionally.
   */
  deleteMessagesAfter?(threadId: string, afterSeq: number): Promise<number>;
}

// ── 3) VectorStore = RAG corpus (structurally compatible with the rag package) ─

export interface VectorDoc {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
  /**
   * Partition this document belongs to. Documents in different namespaces never see each other.
   *
   * `undefined` is its own partition — the un-namespaced one — and is NOT a wildcard. That asymmetry is
   * the point: a store written before namespaces existed keeps every document in it, and a caller that
   * asks for namespace `x` must never be answered from it. See `VectorQueryOptions.namespace`.
   */
  namespace?: string;
}
export interface VectorItem extends VectorDoc {
  embedding: number[];
}
export interface VectorMatch extends VectorDoc {
  score: number;
}
/** Narrows which documents a query may be answered from — see `VectorStore.query`. */
export interface VectorQueryOptions {
  /**
   * Only documents in this namespace are eligible. Omitted means "no restriction" and searches
   * everything, which is the pre-existing behaviour and the only backwards-compatible default.
   *
   * `withOrgStorage` supplies it on every call, so an organization-scoped store cannot be queried
   * without one. That is deliberate: an optional filter defaulting to unrestricted is safe as a port
   * contract and unsafe as an isolation mechanism, so the isolation lives in the wrapper — which
   * always passes it — rather than in this default.
   */
  namespace?: string;
}

export interface VectorStore {
  upsert(items: VectorItem[]): Promise<void>;
  /**
   * Nearest `topK` documents to `embedding`, most similar first.
   *
   * `opts` FILTERS BEFORE RANKING, in every implementation. Filtering afterwards would return the top
   * `topK` across all namespaces and then discard most of them, so a caller asking for 4 results from
   * its own namespace would get however few of the global top 4 happened to be its own — while looking
   * entirely correct. There would be no leak and no error; the answer would just quietly be worse for
   * every organization but the busiest one.
   */
  query(embedding: number[], topK: number, opts?: VectorQueryOptions): Promise<VectorMatch[]>;
}

// ── 4) WorkStore = queue + events + scheduler primitive (has its OWN namespace; doesn't pollute RunJournal) ──

export interface LogRecord<T = unknown> {
  id: string;
  payload: T;
  ts: number;
}

export interface WorkStore {
  /** Idempotent append to an append-only log (same id → a single record). Returns eventId/jobId. */
  append(ns: string, payload: unknown, id?: string): Promise<string>;
  /** List a log namespace — PAGINATED. */
  list<T = unknown>(ns: string, q?: ListQuery): Promise<Page<LogRecord<T>>>;
  /** Work-scope KV (markers like qdone/qfail/qatt, sched:def — NOT in RunJournal). */
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  /** Exactly-once consumer ack (CAS): true on the first call, false on subsequent ones. */
  ackOnce(key: string): Promise<boolean>;
  /**
   * 8.2 (optional): atomic CONDITIONAL replace — the SAME spirit as RunJournal.putIfMatch (H1), adapted to
   * WorkStore's OWN KV schema (in WorkStore there's no separate ns+key parameter, just a single flat
   * `key` — the same addressing as get/put/ackOnce). If the key's CURRENT value matches `expected`, it
   * Writes `value` + returns `true`; otherwise (different/changed/absent) it returns `false` WITHOUT
   * Touching anything.
   * Usage: @gnldev/queue's terminal writes (qdone/qfail/qatt). Until now these writes were a PLAIN
   * Overwrite via `put` — there was NO fencing (only the client-side `lockLost` flag, a DELAYED
   * Approximation on the order of the heartbeat tick). `putIfMatch` provides an engine-internal
   * (engine-level) CAS: when a worker claims a job it writes the lock's fencing token to WorkStore;
   * RIGHT BEFORE the terminal write, this method verifies on the same key "am I still the owner" — if
   * Ownership has been taken over, the write is SKIPPED (the new owner will already write its own
   * Result). If undefined (an old/custom WorkStore implementation) the queue falls back to the old
   * `lockLost` approximation (a documented risk, the same the core-hardening review philosophy).
   */
  putIfMatch?(key: string, expected: unknown, value: unknown): Promise<boolean>;
}

// ── 5) CacheStore = content-addressed cache (optional TTL) ────────────────────

export interface CacheStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, opts?: { ttlMs?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

// ── 6) MetaStore = schema_version / capability persistence ────────────────────

export interface MetaStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

// ── Storage (composite) + Capability ───────────────────────────────────────

/** A port's level of support in a storage. `none` = this store must be overridden with another storage. */
export type CapabilityLevel = 'full' | 'scan' | 'ttl' | 'none';

export interface CapabilityMatrix {
  runs: CapabilityLevel; // always 'full' for a usable storage
  memory: CapabilityLevel;
  vectors: CapabilityLevel;
  work: CapabilityLevel;
  cache: CapabilityLevel;
}

/** A unit that carries all the store ports + its capability. A single storage does NOT have to provide every port. */
export interface Storage {
  readonly name: string;
  readonly capabilities: CapabilityMatrix;
  readonly runs: RunJournal;
  readonly memory?: MemoryStore;
  readonly vectors?: VectorStore;
  readonly work?: WorkStore;
  readonly cache?: CacheStore;
  readonly meta: MetaStore;
  /** Schema/table setup (idempotent). Called automatically once the storage is handed to the registry. */
  init?(): Promise<void>;
  close?(): Promise<void>;
  /**
   * H12 (optional): reclaiming DELETED space back to DISK (compaction). purge/sweep rows are logically
   * Deleted but the engine does NOT RETURN empty pages to the OS (it reuses them → doesn't grow
   * Unbounded, but the file doesn't shrink after a big purge). `compact` reclaims this space: SQLite
   * `wal_checkpoint(TRUNCATE)` + `VACUUM`; Postgres's default `VACUUM` (non-locking, returns free space
   * To the freelist — for OS-level reclaiming use `{ full: true }` → `VACUUM FULL`, which LOCKS the
   * Table, only during a maintenance window). Should be called rarely, via cron (NOT on every write).
   * `reclaimedBytes` is the approximate disk reclaimed (-1 if unknown).
   */
  compact?(opts?: { full?: boolean }): Promise<{ reclaimedBytes: number }>;
  /**
   * Moves data written BEFORE organizations were configured into `orgId`.
   *
   * A deployment that ran without `org` wrote unprefixed keys. Turning organizations on does not
   * migrate them, so every one of those rows becomes invisible to organization-bound identities while
   * remaining visible to an unscoped operator — measured on a real free-tier database: the operator
   * still saw its runs, `acme` saw none. Nothing is lost and nothing leaks, but to the people using it
   * their entire history has disappeared, which is the same "the owner cannot reach their own data"
   * failure the scoping itself is written to avoid.
   *
   * ENGINE-LEVEL on purpose. The ports cannot express this: `vectors` has only `upsert`/`query`,
   * `cache` only `get`/`set`/`delete`, `meta` only `get`/`set` — none of them can enumerate what they
   * hold, so a migration written against the port interfaces could reach the run journal and the
   * conversation store and nothing else. Each adapter knows its own key layout and can move all of it.
   *
   * Only rows that are NOT already organization-prefixed are touched, so it is idempotent: running it
   * twice moves nothing the second time, and it can never nest `org:a:org:b:`. Call it ONCE, with the
   * deployment stopped — an upgrade is not a live operation, and this does not coordinate with writers.
   *
   * REFUSES an organization that is not registered (`__org__:<id>` absent), because the mistake it
   * prevents is irreversible: adopting into a mistyped id moves every row under that prefix, and
   * running it again with the correct name skips them as `alreadyScoped`. `allowUnregistered: true`
   * opts out for a deployment with no registration path.
   *
   * REFUSES while a run is still executing. Measured on SQLite with a live model call: the migration
   * moved three of the run's keys and the run wrote its next one at the root, leaving the same
   * exactly-once claim marker in two places — no error, no whole record. The transaction protects the
   * migration from failing halfway; it does not stop anything else writing meanwhile.
   * `allowInFlight: true` opts out for runs known to be abandoned.
   *
   * `dryRun` reports the same counts without writing.
   */
  adoptIntoOrg?(orgId: string, opts?: { dryRun?: boolean; allowUnregistered?: boolean; allowInFlight?: boolean }): Promise<AdoptIntoOrgResult>;
}

/** What `Storage.adoptIntoOrg` moved, or would move under `dryRun` — one entry per store it touched. */
export interface AdoptIntoOrgResult {
  orgId: string;
  dryRun: boolean;
  /**
   * Rows moved into the organization, by store. A store the engine does not have is absent, not zero.
   *
   * ROWS, not logical keys, and the two differ by engine. SQLite and Postgres materialise a per-run
   * summary row (`gnl_runs`) alongside the journal entries, so they report one more than the
   * key-value engines do for the same data — measured: 5 against in-memory and Redis's 4. Nothing is
   * lost either way; a migration rehearsed on one engine simply reports a different figure than
   * production, and an operator counting with `listKeys` afterwards will find the key-value number.
   */
  moved: Record<string, number>;
  /** Rows left alone because they already carried an organization prefix. */
  alreadyScoped: number;
  /**
   * Platform-level keys deliberately NOT moved, by name — `__org__`, `__agent_registry__`, the paid
   * user store, budgets, policy, pricing. Reported rather than silent: an operator running a migration
   * is entitled to see what it decided not to touch, and this is the list that would break
   * authentication and organization registration if it were ever wrong.
   */
  skippedPlatformKeys: string[];
}

export type StoreName = keyof CapabilityMatrix;

/**
 * Wraps a RunJournal into the old `Journal & JournalReader` contract (array `listRuns` + get/put) — a
 * Bridge for consumers like studio that expect a non-paginated reader. get/put/putIfAbsent/listKeys are
 * Forwarded → studio sees it as "writable" (fork/resume works). (A true paginated studio integration is a later step.)
 */
export function toJournal(runs: RunJournal): Journal & JournalReader {
  const j: Journal & JournalReader = {
    get: (k) => runs.get(k),
    put: (k, v) => runs.put(k, v),
    putIfAbsent: (k, v) => runs.putIfAbsent(k, v),
    listKeys: (p) => runs.listKeys(p),
    readRun: (runId) => runs.readRun(runId),
    listRuns: async () => (await runs.listRuns({ limit: 1_000_000_000 })).items,
    // P0.3: RunJournal.listRuns is MANDATORY (unlike the optional methods forwarded in the loop below)
    // → this bridge is unconditional. Delegates straight through — every RunJournal (in-memory/sqlite/
    // Postgres/redis) already implements the filter+pagination contract itself (see each adapter's
    // ListRuns), so there's nothing extra to do here beyond exposing it under the paged capability name.
    listRunsPaged: (q) => runs.listRuns(q),
  };
  // Bug: previously the optional Journal methods (deletePrefix/putIfMatch/now/incrBy/getCounters/
  // ListStaleRuns/readRunStats) were NOT forwarded → even if the underlying SqliteStorage/Postgres
  // Provided them, the reader capabilities wrapped by toJournal were SILENTLY DROPPED (studio
  // Organization-deletion, retention/purge, budget incrBy, CAS-based paths were falling back to
  // 501/fallback). Forward every existing optional method at runtime (leave it alone if absent — old behavior preserved).
  const anyJ = j as unknown as Record<string, unknown>;
  const anyRuns = runs as unknown as Record<string, unknown>;
  // P1.6b: applyBatch/getMany/countRunsByStatus forwarded the SAME way — SqliteRunJournal/PgRunJournal/
  // RedisRunJournal expose them as EXTRA (non-RunJournal-interface) methods; without this they'd be
  // Silently dropped here exactly like the other optional methods were before the bug fix above.
  for (const m of ['deletePrefix', 'putIfMatch', 'now', 'incrBy', 'getCounters', 'listStaleRuns', 'readRunStats', 'applyBatch', 'getMany', 'countRunsByStatus']) {
    if (typeof anyRuns[m] === 'function') anyJ[m] = (...args: unknown[]) => (anyRuns[m] as (...a: unknown[]) => unknown).call(runs, ...args);
  }
  return j;
}

/** Missing/insufficient capability → a clear error at wiring time (never a silent `[]`/throw mix-up). */
export class CapabilityError extends Error {
  constructor(
    readonly store: StoreName,
    readonly have: CapabilityLevel,
    readonly hint?: string,
  ) {
    super(
      `@gnldev: storage does not support the '${store}' store (capability='${have}').` +
        (hint ? ` ${hint}` : ` Override this store with a suitable storage via composite().`),
    );
    this.name = 'CapabilityError';
  }
}

/** Require a store to be present at at least the 'scan' level (throws CapabilityError otherwise). */
export function requireCapability(storage: Storage, store: StoreName): void {
  const level = storage.capabilities[store];
  if (level === 'none' || storage[storePortKey(store)] == null) {
    throw new CapabilityError(store, level);
  }
}

function storePortKey(store: StoreName): keyof Storage {
  // Capability name → Storage port field (all under the same name; a helper for narrowing the type).
  return store as keyof Storage;
}

// ── composite(): default storage + per-store override ────────────────────────

export interface CompositeConfig {
  /** The main storage that provides every undefined port (runs + meta come from here). */
  default: Storage;
  /** Route specific ports to another storage (e.g. cache: redis()). */
  overrides?: Partial<Record<Exclude<StoreName, 'runs'>, Storage>>;
}

/**
 * Composite storage: takes each port from override?.[port] ?? default; recomputes the capability matrix.
 * Runs + meta always come from default (replay must live in a single RunJournal). The init/close of an
 * Overridden port is also called (init: all of them; close: unique storages, once each).
 */
export function composite(cfg: CompositeConfig): Storage {
  const ov = cfg.overrides ?? {};
  const pick = <K extends Exclude<StoreName, 'runs'>>(k: K): Storage => ov[k] ?? cfg.default;

  const memStorage = pick('memory');
  const vecStorage = pick('vectors');
  const workStorage = pick('work');
  const cacheStorage = pick('cache');

  const storages = new Set<Storage>([cfg.default, memStorage, vecStorage, workStorage, cacheStorage]);

  const capabilities: CapabilityMatrix = {
    runs: cfg.default.capabilities.runs,
    memory: memStorage.capabilities.memory,
    vectors: vecStorage.capabilities.vectors,
    work: workStorage.capabilities.work,
    cache: cacheStorage.capabilities.cache,
  };

  return {
    name: `composite(${cfg.default.name})`,
    capabilities,
    runs: cfg.default.runs,
    meta: cfg.default.meta,
    memory: memStorage.memory,
    vectors: vecStorage.vectors,
    work: workStorage.work,
    cache: cacheStorage.cache,
    async init() {
      for (const b of storages) await b.init?.();
    },
    async close() {
      for (const b of storages) await b.close?.();
    },
  };
}
