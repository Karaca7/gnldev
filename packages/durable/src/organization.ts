// Multi-organization support: partition the journal by organization. All keys are written/read with the
// `org:<orgId>:` prefix → runs, memory, queue, cache — EVERYTHING is isolated per organization. ALL of
// the journal's optional capabilities (putIfAbsent/listKeys/deletePrefix/putIfMatch/now/incrBy/
// getCounters/listStaleRuns) and JournalReader's (readRun/listRuns/readRunStats) — if the underlying
// journal supports them — are bridged → exactly-once/atomic-CAS/atomic-counter guarantees are also
// PRESERVED in the organization view (the same Journal interface). A highly requested feature that has no
// counterpart in most agent frameworks.
import type { Journal, JournalBatch, JournalReader, JournalEntry, RunSummary } from './journal.js';

/** An organization-prefixed key. orgId must not contain ':' (it would break the key schema). */
function orgPrefix(orgId: string): string {
  if (!orgId || orgId.includes(':')) {
    throw new Error(`@gnldev/durable: invalid orgId '${orgId}' — must be non-empty and must not contain ':'`);
  }
  return `org:${orgId}:`; // the 'org:' journal prefix
}

/**
 * Scope a journal to an organization. The returned journal implements the same interface (putIfAbsent/
 * listKeys/readRun/listRuns are bridged if present) → it's handed as-is to runDurable/createGnl/
 * BasicMemory/queue. Organizations CANNOT SEE each other's keys; the same runId is independent across
 * different organizations.
 */
export function withOrg(journal: Journal, orgId: string): Journal & Partial<JournalReader> {
  const prefix = orgPrefix(orgId);
  const out: Journal & Partial<JournalReader> = {
    get: <T = unknown>(key: string) => journal.get<T>(prefix + key),
    put: (key: string, value: unknown) => journal.put(prefix + key, value),
  };
  if (journal.putIfAbsent) {
    out.putIfAbsent = (key, value) => journal.putIfAbsent!(prefix + key, value);
  }
  if (journal.listKeys) {
    out.listKeys = async (p) => (await journal.listKeys!(prefix + p)).map((k) => k.slice(prefix.length));
  }
  if (journal.deletePrefix) {
    out.deletePrefix = (p) => journal.deletePrefix!(prefix + p); // an organization can only delete its own scope
  }
  // H1 (atomic conditional replace): the prefixed key, expected/value are delegated as-is — run-lock.ts's
  // expired-lock takeover CAS also stays atomic in the org view (if not bridged it would fall back to
  // best-effort get→put, creating a split-brain risk in a multi-tenant scenario).
  if (journal.putIfMatch) {
    out.putIfMatch = (key, expected, value) => journal.putIfMatch!(prefix + key, expected, value);
  }
  // H2 (storage clock): NO prefix — time isn't organization-specific, delegated as-is.
  if (journal.now) {
    out.now = () => journal.now!();
  }
  // H8a (atomic counter): the key is prefixed → budget.ts:incrBy/getOrgUsage also use an
  // engine-internal atomic increment in the org view (would fall back to legacy get→put if not bridged).
  if (journal.incrBy) {
    out.incrBy = (key, fields) => journal.incrBy!(prefix + key, fields);
  }
  if (journal.getCounters) {
    out.getCounters = (key) => journal.getCounters!(prefix + key);
  }
  // P1.6b: atomic batch — every key inside `batch` (claim/incrs/puts) is prefixed the SAME way put()/
  // incrBy() prefix their own single key, so the org isolation guarantee carries over unchanged.
  if (journal.applyBatch) {
    out.applyBatch = (batch: JournalBatch) => journal.applyBatch!({
      ...(batch.claim ? { claim: { key: prefix + batch.claim.key, value: batch.claim.value } } : {}),
      ...(batch.incrs ? { incrs: batch.incrs.map((i) => ({ key: prefix + i.key, fields: i.fields })) } : {}),
      ...(batch.puts ? { puts: batch.puts.map((p) => ({ key: prefix + p.key, value: p.value })) } : {}),
    });
  }
  // P1.6b: batch point-read — keys prefixed the same way get() prefixes a single key; order preserved (contract).
  if (journal.getMany) {
    out.getMany = (keys: string[]) => journal.getMany!(keys.map((k) => prefix + k));
  }
  // P1.6b: `countRunsByStatus` is DELIBERATELY NOT bridged here (unlike every other optional capability
  // above) — it's an ENGINE-LEVEL aggregate over the WHOLE underlying store (e.g. SQL `GROUP BY` on
  // `gnl_runs`), with NO per-organization filter parameter to push the `org:<id>:` prefix into. Bridging
  // it naively would leak EVERY organization's counts into this one's view (a real cross-tenant data
  // leak) — so it's left undefined; callers (studio's /metrics) fall back to the already org-safe
  // `listRuns`-based count.
  // H8b (stale run scan): the underlying result physically comes back as `org:<orgId>:<runId>`
  // (parseJournalKey counts the ENTIRE prefixed key as the runId — see the run_id column/ZSET member in
  // sqlite/postgres/redis-storage.ts). ONLY the ones belonging to THIS organization are FILTERED and the
  // prefix is STRIPPED before returning — the same isolation pattern as readRun/listRuns (other
  // organizations' runs don't leak).
  if (journal.listStaleRuns) {
    out.listStaleRuns = async (cutoffTs, opts) =>
      (await journal.listStaleRuns!(cutoffTs, opts))
        .filter((runId) => runId.startsWith(prefix))
        .map((runId) => runId.slice(prefix.length));
  }
  const reader = journal as unknown as Partial<JournalReader>;
  if (typeof reader.readRun === 'function') {
    out.readRun = async (runId: string): Promise<JournalEntry[]> =>
      (await reader.readRun!.call(journal, prefix + runId)).map((e) => ({
        ...e,
        key: e.key.startsWith(prefix) ? e.key.slice(prefix.length) : e.key,
        runId: e.runId.startsWith(prefix) ? e.runId.slice(prefix.length) : e.runId,
      }));
  }
  if (typeof reader.listRuns === 'function') {
    out.listRuns = async (): Promise<RunSummary[]> =>
      (await reader.listRuns!.call(journal))
        .filter((r) => r.runId.startsWith(prefix))
        .map((r) => ({ ...r, runId: r.runId.slice(prefix.length) }));
  }
  /**
   * P0.3 (AUDIT-R2): the underlying `listRunsPaged` has NO concept of "this organization" —
   * keys are prefixed BEFORE reaching it (see get/put above), so its own gnl_runs-style index mixes
   * EVERY organization's runs in ONE keyspace. Unlike the unpaged `listRuns` bridge just above (which
   * can safely filter-then-strip because it always reads EVERYTHING, no slicing involved), a single
   * underlying PAGE can't just be filtered-then-returned: doing so would either under-fill the caller's
   * requested `limit` (silently returning fewer items than exist) or — if combined with the underlying
   * page's own `nextCursor` — skip over this organization's runs that happened to fall in an
   * underlying page dominated by OTHER organizations (exactly the "filter after slicing" bug the
   * whole P0.3 filter contract exists to avoid). So this WALKS the underlying store's pages forward
   * (relying on the numeric cursor-as-offset convention every adapter's `offset()`/`paginate()` helper
   * already uses — see sqlite/postgres/redis/in-memory-storage.ts), accumulating only this
   * organization's (prefix-stripped) runs, until either `limit` is reached or the underlying store is
   * exhausted. Honest cost: an organization holding a small slice of a large shared keyspace pays for
   * walking through every OTHER organization's runs along the way — a real Postgres/SQL fix would push
   * an explicit key-prefix filter into RunJournal.listRuns itself (out of scope for P0.3).
   */
  if (typeof reader.listRunsPaged === 'function') {
    out.listRunsPaged = async (q) => {
      const limit = q?.limit ?? 50;
      const chunk = Math.max(limit, 50); // read the underlying (mixed-org) store in reasonably sized chunks
      let pos = q?.cursor ? Number(q.cursor) || 0 : 0;
      const items: RunSummary[] = [];
      let nextCursor: string | undefined;
      for (;;) {
        const page = await reader.listRunsPaged!.call(journal, { ...q, cursor: String(pos), limit: chunk });
        let consumed = 0;
        for (const r of page.items) {
          consumed++;
          if (r.runId.startsWith(prefix)) {
            items.push({ ...r, runId: r.runId.slice(prefix.length) });
            if (items.length >= limit) { nextCursor = String(pos + consumed); break; }
          }
        }
        if (items.length >= limit) break;
        if (!page.nextCursor) { nextCursor = undefined; break; } // underlying store exhausted
        pos += page.items.length;
      }
      return { items, nextCursor };
    };
  }
  // H8c (run size statistics): runId is prefixed, the result (entries/bytes) is independent of the
  // organization — returned as-is. If not bridged, retention/budget's stats path would silently disappear in the org view.
  if (typeof reader.readRunStats === 'function') {
    out.readRunStats = (runId: string) => reader.readRunStats!.call(journal, prefix + runId);
  }
  return out;
}
