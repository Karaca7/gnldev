/**
 * Organization scoping for the WHOLE `Storage` port, not just its journal.
 *
 * `withOrg` scopes a `Journal` — `organization.ts` contains zero occurrences of `Storage` — and that
 * gap is why per-organization instances never actually isolated anything beyond run state. A `Storage`
 * carries six ports and only `runs` was reachable through the journal wrapper; `memory`, `vectors`,
 * `work`, `cache` and `meta` were handed over shared, so every organization read and wrote the same
 * threads, the same corpus, the same queue, the same cache keys and the same metadata. The leaks that
 * kept being found one at a time — knowledge search, the jobs list, the cache invalidate — were all
 * this one hole seen through different routes.
 *
 * THE PREFIX COMES FROM `orgPrefix`, never from string concatenation here. That function already
 * refuses an empty or `:`-bearing id by throwing, and the whole value of a single source is that the
 * refusal cannot be forgotten in one of six places. A wrapper computing its own `` `org:${id}:` `` is
 * exactly how `''` becomes a shared partition that every organization writes into and none notices.
 *
 * WRITE-SIDE PREFIXING WITHOUT READ-SIDE STRIPPING IS THE FAILURE MODE TO WATCH. If `upsertThread`
 * prefixes an id and `getThread` returns the record verbatim, the owner gets back a thread whose id is
 * not the one they asked about, and every id they hand onward is wrong. Nothing leaks and nothing
 * errors — the organization simply cannot recognise its own data. Every method below that prefixes on
 * the way in also strips on the way out, and the two halves are written next to each other so a future
 * edit cannot move one without seeing the other.
 */
import { ORG_SCOPE, orgPrefix, orgScopeOf, withOrg } from './organization.js';
import { toJournal } from './storage.js';
import type {
  CacheStore, CapabilityMatrix, ListQuery, LogRecord, MemoryStore, MessageRecord, MessageAppend, MetaStore,
  Page, RunJournal, Storage, ThreadRecord,
  VectorItem, VectorMatch, VectorQueryOptions, VectorStore, WorkStore,
} from './storage.js';
import type { RunSummary } from './journal.js';

/** Adds the prefix; the inverse of `strip`. */
const add = (p: string, key: string): string => p + key;

/**
 * Removes the prefix, or returns `undefined` when the value does not carry it.
 *
 * `undefined` rather than the value unchanged, deliberately: a row that does not belong to this
 * organization must be dropped, and silently returning it unprefixed would hand it over as if it were
 * the caller's own. Callers below use that to filter.
 */
const strip = (p: string, key: string): string | undefined => (key.startsWith(p) ? key.slice(p.length) : undefined);

/** Marks a storage as already scoped, so double-scoping can be refused the way `withOrg` refuses it. */
const STORAGE_SCOPE = Symbol.for('@gnldev/durable.orgStorageScope');

/** The organization a storage is scoped to, or `undefined` if it is the unscoped root. */
export function orgStorageScopeOf(storage: unknown): string | undefined {
  const v = (storage as Record<symbol, unknown> | null | undefined)?.[STORAGE_SCOPE];
  return typeof v === 'string' ? v : undefined;
}

/**
 * Fills a page with items this organization owns, drawing more from the source as needed.
 *
 * The naive wrapper asks the source for one page and drops the rows that are not ours. `ListQuery`
 * forbids exactly that — "Adapters MUST filter BEFORE slicing to `limit`/`cursor` — filtering after
 * slicing silently drops matching items off a page and desyncs `nextCursor`" — and the consequence is
 * sharper than a short page: with the source ordered so another organization's rows come first, our
 * page comes back EMPTY while our rows sit further down. A client paginating until an empty page stops
 * there and never sees them. No leak, no error, just data the owner cannot reach.
 *
 * We cannot push the prefix into the source — no list method takes one — so the boundary is drawn by
 * draining instead: keep pulling source pages until `limit` of ours are in hand or the source runs
 * out, and report the cursor of the last page actually consumed so the next call resumes where this
 * one stopped.
 *
 * `MAX_DRAW` bounds the work. A source that is overwhelmingly another organization's would otherwise
 * walk the whole table for one page; stopping early returns a short page WITH a cursor, which is a
 * legal `Page` and resumable, rather than an unbounded scan.
 */
const MAX_DRAW = 50;
async function drainOwned<T>(
  fetch: (q: ListQuery) => Promise<Page<T>>,
  own: (item: T) => T | undefined,
  q: ListQuery | undefined,
): Promise<Page<T>> {
  const limit = q?.limit;
  const items: T[] = [];
  let cursor = q?.cursor;
  for (let draw = 0; draw < MAX_DRAW; draw++) {
    const page = await fetch({ ...q, ...(cursor !== undefined ? { cursor } : {}) });
    for (const it of page.items) {
      const mine = own(it);
      if (mine !== undefined) items.push(mine);
    }
    cursor = page.nextCursor;
    // Source exhausted, or we have what was asked for. `limit === undefined` means "everything", so it
    // only stops when the source does.
    if (cursor === undefined || (limit !== undefined && items.length >= limit)) break;
  }
  const out = limit === undefined ? items : items.slice(0, limit);
  return { items: out, ...(cursor !== undefined ? { nextCursor: cursor } : {}) };
}

/**
 * Scopes the run journal by DELEGATING to `withOrg`, rather than prefixing the six `RunJournal`
 * methods here.
 *
 * This was hand-written first, and it silently dropped every capability beyond the declared interface.
 * A concrete store's `runs` carries optional methods `RunJournal` does not name — `incrBy`,
 * `getCounters`, `applyBatch`, `getMany`, `putIfMatch`, `deletePrefix`, `now`, `listStaleRuns` — and
 * rebuilding the object as a literal kept none of them. Measured: `withOrgStorage(storage,'a').runs.incrBy`
 * was `undefined` where the old `withOrg(toJournal(runs),'a')` path had it as a function.
 *
 * That is not a cosmetic loss. `incrBy` is the ATOMIC counter the organization usage total is built on;
 * without it the runtime falls back to get→put, which loses increments under concurrency — so usage
 * under-counts and a budget silently over-runs. An isolation feature would have broken budget
 * enforcement.
 *
 * Delegating rather than re-listing is the point. `withOrg` already bridges each of those, and a second
 * hand-maintained list is a list that goes stale the next time one is added — the same shape as every
 * other defect this file exists to prevent.
 */
function scopedRuns(runs: RunJournal, p: string, orgId: string): RunJournal {
  // `withOrg` supplies the prefixing and EVERY optional capability, but its reader half answers the
  // older array contract: `withOrg(...).listRuns()` returns `RunSummary[]` where `RunJournal.listRuns`
  // must return a `Page`. Returning it verbatim produced a `runs` that is not a `RunJournal`, and the
  // server's `toJournal()` around it then yielded `undefined` — measured as `GET /runs` showing an
  // organization NONE of its own runs. The capability bridging is kept; the two reader methods are
  // re-stated in this port's own contract.
  // THE CAPABILITY SURFACE IS NOT IDENTICAL, in both directions, and a caller that feature-detects will
  // see the difference:
  //
  //   countRunsByStatus   base=function   scoped=undefined   deliberate — organization.ts:152 explains
  //                                                          why it is not bridged, and studio
  //                                                          feature-detects it on the RAW reader
  //   listRunsPaged       base=undefined  scoped=function    synthesised by `toJournal`, and correct
  //
  // Both answers are right; they are just not the same answer. Left as-is rather than trimmed, because
  // removing a working capability to make two surfaces match is a worse trade than documenting it.
  const bridged = withOrg(toJournal(runs), orgId) as unknown as Record<string, unknown>;
  return {
    ...bridged,
    readRun: (runId: string) => runs.readRun(add(p, runId)),
    listRuns: (q?: ListQuery) => drainOwned(
      (qq) => runs.listRuns(qq),
      (r: RunSummary) => { const id = strip(p, r.runId); return id === undefined ? undefined : { ...r, runId: id }; },
      q,
    ),
  } as unknown as RunJournal;
}

function scopedMemory(memory: MemoryStore, p: string): MemoryStore {
  /**
   * Puts a message row into the underlying store's terms; `outMsg` is the exact inverse.
   *
   * The unprefixed `threadId` the caller used is passed in rather than derived, so a row that arrives
   * carrying some OTHER thread's id cannot smuggle itself into that thread: the row always lands in the
   * thread the caller named.
   */
  const inMsg = (r: MessageAppend, threadId: string): MessageAppend => ({ ...r, threadId: add(p, threadId) });
  /**
   * Strips a row's OWN `threadId`, and drops the row when it does not carry this prefix.
   *
   * This began as `({ ...r, threadId })` — stamping the caller's argument onto whatever came back —
   * and that turned the id fix into a disguise. `recall` accepts `{ scope: 'resource', resourceId }`,
   * and a resource id is a USER, not an organization: two organizations whose threads share one recall each
   * other's messages. Measured, with the stamping version:
   *
   *   acme.recall('t-1', q, { scope: 'resource', resourceId: 'u-shared' })
   *     -> ['ACME-SECRET', 'GLOBEX-SECRET'], and the foreign row came back labelled `t-1`
   *
   * so nothing in the result marked it as somebody else's. Filtering on the row's own id is what
   * `outThread` already did, and the difference between mapping and filtering was the whole defect.
   */
  const outMsg = (r: MessageRecord): MessageRecord | undefined => {
    const threadId = strip(p, r.threadId);
    return threadId === undefined ? undefined : { ...r, threadId };
  };

  const outThread = (rec: ThreadRecord): ThreadRecord | undefined => {
    const id = strip(p, rec.id);
    if (id === undefined) return undefined;
    // `parentThreadId` is an id this organization will hand back to us, so it has to come out
    // unprefixed too. Left prefixed, a caller following the parent link would ask for
    // `org:acme:org:acme:t` and get nothing — a broken thread tree with no error anywhere.
    const parent = rec.parentThreadId === undefined ? undefined : strip(p, rec.parentThreadId);
    return { ...rec, id, ...(rec.parentThreadId !== undefined ? { parentThreadId: parent ?? rec.parentThreadId } : {}) };
  };
  const scoped: MemoryStore = {
    upsertThread: (rec) => memory.upsertThread({
      ...rec,
      id: add(p, rec.id),
      ...(rec.parentThreadId !== undefined ? { parentThreadId: add(p, rec.parentThreadId) } : {}),
    }),
    getThread: async (id) => {
      const rec = await memory.getThread(add(p, id));
      return rec === undefined ? undefined : outThread(rec);
    },
    // Drained rather than filtered in place — see `drainOwned`. Filtering one source page produced an
    // EMPTY page for this organization whenever another organization's rows happened to sort first,
    // which stops a client that paginates until empty.
    listThreads: (q) => drainOwned((qq) => memory.listThreads({ ...q, ...qq }), outThread, q),
    deleteThread: (id) => memory.deleteThread(add(p, id)),
    // A `MessageRecord` carries its own `threadId`, so the message methods have a second id to keep in
    // step with the key — and getting only the key right is invisible until someone uses the value.
    // Measured before this existed: `getMessages('t-1')` returned rows whose `threadId` read
    // `org:acme:t-1`, and passing that back in resolved to `org:acme:org:acme:t-1` — zero rows, no
    // error. The owner was handed an identifier for nobody's thread, which is the cemented failure this
    // whole file's header warns about, on the one shape that carries an id in its BODY rather than in
    // its argument.
    appendMessages: (threadId, rows) => memory.appendMessages(add(p, threadId), rows.map((r) => inMsg(r, threadId))),
    // The THIRD argument matters. Dropping it here would leave batch identity silently disabled under
    // org isolation — which is the configuration multi-tenant deployments actually run, and exactly
    // the shape of the optional-method loss this file's header warns about.
    ...(memory.appendMessagesOnce ? {
      appendMessagesOnce: (threadId: string, rows: MessageAppend[], batchKey: string) =>
        memory.appendMessagesOnce!(add(p, threadId), rows.map((r) => inMsg(r, threadId)), batchKey),
    } : {}),
    getMessages: (threadId, q) => drainOwned((qq) => memory.getMessages(add(p, threadId), qq), outMsg, q),
    // `recall` returns rows from OTHER threads under `scope: 'resource'`, so it filters rather than
    // maps — see `outMsg`. Not paginated, so it drops in place rather than draining.
    recall: async (threadId, queryEmbedding, opts) =>
      (await memory.recall(add(p, threadId), queryEmbedding, opts))
        .map(outMsg).filter((r): r is MessageRecord => r !== undefined),
    getWorkingMemory: (scopeId) => memory.getWorkingMemory(add(p, scopeId)),
    setWorkingMemory: (scopeId, data) => memory.setWorkingMemory(add(p, scopeId), data),
    getObservations: (threadId) => memory.getObservations(add(p, threadId)),
    putObservations: (threadId, obs) => memory.putObservations(add(p, threadId), obs),
  };
  // OPTIONAL method: forwarded only when the underlying store has it. Defining it unconditionally
  // would make `typeof store.deleteMessagesAfter === 'function'` true for an adapter that cannot do it,
  // and the documented contract is that callers treat an absent method as "capability unavailable".
  if (memory.deleteMessagesAfter) {
    scoped.deleteMessagesAfter = (threadId, afterSeq) => memory.deleteMessagesAfter!(add(p, threadId), afterSeq);
  }
  return scoped;
}

function scopedVectors(vectors: VectorStore, p: string): VectorStore {
  // The vector port is namespaced rather than key-prefixed, because `query` ranks: an id prefix could
  // only be applied after the store had already chosen its top K globally. See `VectorStore.query`.
  //
  // The namespace is the prefix WITHOUT its trailing colon — `org:acme` — so it reads as an identifier
  // in a namespace column rather than as a key fragment.
  const ns = p.endsWith(':') ? p.slice(0, -1) : p;
  const stripNs = (m: VectorMatch): VectorMatch => { const { namespace: _n, ...rest } = m; return rest; };
  return {
    // The caller's own `namespace` is deliberately overwritten, not merged or respected. This wrapper
    // is the organization boundary; a document that could choose its own namespace could choose
    // another organization's.
    upsert: (items: VectorItem[]) => vectors.upsert(items.map((it) => ({ ...it, namespace: ns }))),
    // `opts.namespace` is likewise ignored rather than honoured — same reason, in the read direction.
    query: async (embedding: number[], topK: number, opts?: VectorQueryOptions) =>
      (await vectors.query(embedding, topK, { ...opts, namespace: ns })).map(stripNs),
  };
}

function scopedWork(work: WorkStore, p: string): WorkStore {
  const scoped: WorkStore = {
    append: (ns, payload, id) => work.append(add(p, ns), payload, id),
    list: <T = unknown>(ns: string, q?: ListQuery) => work.list<T>(add(p, ns), q) as Promise<Page<LogRecord<T>>>,
    get: <T = unknown>(key: string) => work.get<T>(add(p, key)),
    put: (key, value) => work.put(add(p, key), value),
    ackOnce: (key) => work.ackOnce(add(p, key)),
  };
  if (work.putIfMatch) {
    scoped.putIfMatch = (key, expected, value) => work.putIfMatch!(add(p, key), expected, value);
  }
  return scoped;
}

const scopedCache = (cache: CacheStore, p: string): CacheStore => ({
  get: <T = unknown>(key: string) => cache.get<T>(add(p, key)),
  set: (key, value, opts) => cache.set(add(p, key), value, opts),
  delete: (key) => cache.delete(add(p, key)),
});

const scopedMeta = (meta: MetaStore, p: string): MetaStore => ({
  get: (key) => meta.get(add(p, key)),
  set: (key, value) => meta.set(add(p, key), value),
});

/**
 * Returns a `Storage` whose every port is confined to `orgId`.
 *
 * Refuses a storage that is already scoped, for the reason `withOrg` refuses a scoped journal: nesting
 * produces `org:acme:org:globex:<key>`, where the label says globex and the bytes sit inside acme —
 * so acme can read and delete them. Scope the unscoped root again instead.
 *
 * `init`, `close` and `compact` are NOT forwarded. They act on the whole store — creating tables,
 * closing the connection, vacuuming the file — and none of that is an organization's to do. An
 * organization calling `close()` on what it thinks is its own storage would take the process down for
 * every other one.
 */
export function withOrgStorage(storage: Storage, orgId: string): Storage {
  const already = orgStorageScopeOf(storage);
  if (already !== undefined) {
    throw new Error(
      `@gnldev/durable: this storage is already scoped to organization '${already}' — scoping it again ` +
      `as '${orgId}' would nest the prefixes (org:${already}:org:${orgId}:…), leaving the data inside ` +
      `'${already}' where that organization can read and delete it. Scope the unscoped storage instead.`,
    );
  }
  // Throws on an empty or `:`-bearing id — the single guard, shared with `withOrg`.
  const p = orgPrefix(orgId);

  const out: Storage = {
    name: storage.name,
    // Capabilities describe what the ENGINE can do, and scoping does not change that. Copied rather
    // than aliased so a caller mutating the returned matrix cannot reach the root storage's.
    capabilities: { ...storage.capabilities } as CapabilityMatrix,
    runs: scopedRuns(storage.runs, p, orgId),
    meta: scopedMeta(storage.meta, p),
    ...(storage.memory ? { memory: scopedMemory(storage.memory, p) } : {}),
    ...(storage.vectors ? { vectors: scopedVectors(storage.vectors, p) } : {}),
    ...(storage.work ? { work: scopedWork(storage.work, p) } : {}),
    ...(storage.cache ? { cache: scopedCache(storage.cache, p) } : {}),
  };
  // Enumerable for the same reason `withOrg`'s marker is: a scope you cannot see is a scope nobody
  // debugs. `Symbol.for` keys never appear in `Object.keys`, a spread, or `JSON.stringify`.
  Object.defineProperty(out, STORAGE_SCOPE, { value: orgId, enumerable: true, configurable: true });
  return out;
}

/** Re-exported so a caller can ask the same question of either wrapper. */
export { ORG_SCOPE, orgScopeOf };
