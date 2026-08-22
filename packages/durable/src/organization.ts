// Multi-organization support: partition the journal by organization. All keys are written/read with the
// `org:<orgId>:` prefix → runs, memory, queue, cache — EVERYTHING is isolated per organization. ALL of
// The journal's optional capabilities (putIfAbsent/listKeys/deletePrefix/putIfMatch/now/incrBy/
// GetCounters/listStaleRuns) and JournalReader's (readRun/listRuns/readRunStats) — if the underlying
// Journal supports them — are bridged → exactly-once/atomic-CAS/atomic-counter guarantees are also
// PRESERVED in the organization view (the same Journal interface). A highly requested feature that has no
// Counterpart in most agent frameworks.
import { listRunsArray } from './journal.js';
import type { Journal, JournalBatch, JournalReader, JournalEntry, RunSummary } from './journal.js';

/** An organization-prefixed key. orgId must not contain ':' (it would break the key schema). */
/**
 * Meta keys the ENGINE writes about the deployment, which `adoptIntoOrg` must never move.
 *
 * `MetaStore` is a port an organization can write through, so most of `gnl_meta` is ordinary data and
 * belongs to whoever is adopting it. `schema_version` is not: every adapter writes it at init to record
 * which schema the file is on. Prefixing it to `org:acme:schema_version` leaves the deployment looking
 * unversioned on the next boot, so the migration would corrupt the thing it is migrating. Caught in a
 * dry run against a real free-tier database, where it was the ONLY meta row present.
 *
 * Shared rather than repeated per adapter: three copies of this list is three chances to add the next
 * engine-level key to two of them.
 */
export const ENGINE_META_KEYS: readonly string[] = ['schema_version'];

/**
 * Reserved `__…__` keys that ARE an organization's data and so may be adopted — measured, not assumed.
 *
 * On a live multi-organization deployment these are the only reserved keys ever seen written under an
 * `org:<id>:` prefix. Everything else in the reserved space is platform-level and must stay at the
 * root: `__org__` (registration records), `__agent_registry__` (is this code-agent allowed to serve at
 * all), `__eeuser__`/`__eetoken__`/`__eeaudit__` (the paid user store), `__budget__` (set BY the
 * operator, keyed by organization id already), `__policy__` and `__pricing__` (platform-admin
 * endpoints).
 *
 * Moving any of those would not be a cosmetic mistake: `__org__:acme` becoming
 * `org:acme:__org__:acme` makes `requireRegistration` reject every organization, and the token rows
 * becoming org-scoped means nobody can authenticate at all.
 *
 * An ALLOW list rather than a deny list, deliberately. A reserved key added later and forgotten here
 * stays where it is — the operator still sees it and nothing breaks — where a forgotten DENY entry
 * would move platform state into one tenant. `adoptIntoOrg` reports what it skipped by name so the
 * decision is visible rather than silent.
 */
export const ADOPTABLE_RESERVED_PREFIXES: readonly string[] = [
  '__usage__', '__metrics__',
  // Managed workflow definitions and managed agent versions. Studio writes both through its
  // ALS-SCOPED reader (`rw.put(WF_STORE_PRE + …)`, the agent store's prefixer), so on a deployment
  // with organizations they are per-organization by construction and read back through the same
  // scope. Left at the root by an upgrade they are not deleted — they are UNREACHABLE, and the
  // operator sees an empty list and concludes the migration dropped them.
  //
  // Both were missing from this list when it was first written, which is the failure mode an allow
  // list has: it leaves data behind. That is the trade it is chosen for — a missing DENY entry moves
  // platform state into one tenant and breaks authentication.
  '__studio_wf__', '__studio_agent__',
];

/** True when a root-level key belongs to the platform and `adoptIntoOrg` must leave it alone. */
export function isPlatformKey(key: string): boolean {
  if (!key.startsWith('__')) return false;                       // ordinary data — adoptable
  return !ADOPTABLE_RESERVED_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * The key prefix for an organization, and the single place an organization id is validated.
 *
 * EXPORTED so `withOrgStorage` shares this guard rather than computing its own prefix. Six ports
 * each deriving `` `org:${id}:` `` inline is six places the empty-string check can be forgotten, and
 * `''` produces `org::` — one shared partition that every organization writes into and none notices.
 */
export function orgPrefix(orgId: string): string {
  if (!orgId || orgId.includes(':')) {
    throw new Error(`@gnldev/durable: invalid orgId '${orgId}' — must be non-empty and must not contain ':'`);
  }
  return `org:${orgId}:`; // the 'org:' journal prefix
}

/**
 * Scope a journal to an organization. The returned journal implements the same interface (putIfAbsent/
 * ListKeys/readRun/listRuns are bridged if present) → it's handed as-is to runDurable/createGnl/
 * BasicMemory/queue. Organizations CANNOT SEE each other's keys; the same runId is independent across
 * Different organizations.
 */
/**
 * Marks a journal as scoped to an organization, so code holding only the `Journal` can still tell.
 *
 * Needed because org isolation is implemented as a key prefix captured in a closure: everything
 * downstream sees a plain `Journal` and cannot know an org is in play. That is fine for storage —
 * the prefix does the isolating — but NOT for a value that leaves this process. The cross-run
 * idempotency key is handed to the PROVIDER (Stripe et al.), and without the org in it two isolated
 * orgs charging the same orderId produce the same provider key, so the second charge is deduped
 * against the first: org B is told it succeeded, org A paid, and both journals record success.
 * Money-shaped and silent. Read by durable-tool.ts.
 */
export const ORG_SCOPE = Symbol.for('@gnldev/durable.orgScope');

/**
 * The journal a scoped view wraps.
 *
 * `withOrg` prefixes EVERY key, with no exemptions, which is right for run data and wrong for the few
 * documents that are deliberately global. `__pricing__` is one: Studio's PUT requires a platform admin
 * (an unbound identity, so no scope) and writes it at the root, while a multi-org runtime reads through
 * a scoped journal and therefore looks for `org:<id>:__pricing__`. Measured: the document was written,
 * and `effectivePricingTable` on a scoped journal did not see it — so the spend ceiling a customer just
 * configured went on counting $0 in exactly the deployments that have organizations.
 *
 * Exposing the parent lets a global-document reader fall back without needing the caller to thread a
 * second journal through every call site. `__policy__` has the same shape and is not changed here —
 * naming it so the next person knows it is the same question, not a different one.
 */
export const ORG_PARENT = Symbol.for('@gnldev/durable.orgParent');

/** The unscoped journal behind a `withOrg` view, or undefined if this journal is not a scoped view. */
export function orgParentOf(journal: unknown): Partial<Journal> | undefined {
  return (journal as Record<symbol, Partial<Journal>> | null | undefined)?.[ORG_PARENT];
}

/** The organization a journal is scoped to, if any. */
export function orgScopeOf(journal: unknown): string | undefined {
  const v = (journal as Record<symbol, unknown> | null | undefined)?.[ORG_SCOPE];
  return typeof v === 'string' ? v : undefined;
}

export function withOrg(journal: Journal, orgId: string): Journal & Partial<JournalReader> {
  // Refuse to scope a journal that is ALREADY scoped. Nesting produces `org:acme:org:globex:<key>`:
  // the marker says 'globex' and the data sits inside acme, so acme can list, read and DELETE it —
  // measured, including `acme.deletePrefix('')` sweeping globex's rows. That is the exact opposite of
  // this module's contract ("Organizations CANNOT SEE each other's keys"), and the provider-facing
  // idempotency key would carry only `org:globex:` while the record lives under acme.
  //
  // No first-party code nests (studio and server both wrap the root journal). It became reachable as a
  // PATTERN because a test wrote `withOrg({ ...withOrg(base, 'acme') }, 'globex')` and asserted only
  // that the label had changed. Detecting it costs one line now that the marker is readable, and a
  // caller that wants a different organization should scope the ROOT journal again.
  const already = orgScopeOf(journal);
  if (already !== undefined) {
    throw new Error(
      `@gnldev/durable: this journal is already scoped to organization '${already}' — scoping it again ` +
      `as '${orgId}' would nest the prefixes (org:${already}:org:${orgId}:…), leaving the data inside ` +
      `'${already}' where that organization can read and delete it. Scope the unscoped journal instead.`,
    );
  }
  const prefix = orgPrefix(orgId);
  const out: Journal & Partial<JournalReader> = {
    get: <T = unknown>(key: string) => journal.get<T>(prefix + key),
    put: (key: string, value: unknown) => journal.put(prefix + key, value),
  };
  // Enumerable, deliberately — and this used to be `enumerable: false` on the reasoning that a marker
  // for in-process code "must not appear in a spread, a JSON round-trip, or a key listing". Two of
  // those three are free: this is a SYMBOL, and symbols are invisible to JSON.stringify, Object.keys
  // and for-in whatever their enumerability. Only the spread was actually affected — and there,
  // hiding it is the dangerous direction. `{ ...journal, put: log(journal.put) }` is the obvious way
  // to wrap a journal, and with a hidden marker it silently returns an org-scoped journal that no
  // longer reports its org: durable-tool then builds the provider-facing idempotency key WITHOUT the
  // `org:<id>:` part, and two isolated orgs charging the same orderId collide at the provider. That
  // is the money-shaped failure this symbol exists to prevent, reintroduced by the wrapper.
  //
  // Carrying it through a spread cannot produce the opposite mistake: re-wrapping with withOrg
  // defines its own value over the copy, so a journal never keeps a stale org.
  Object.defineProperty(out, ORG_SCOPE, { value: orgId, enumerable: true, configurable: true });
  // Same enumerability, same reason: a wrapper built by spreading this object must keep both markers or
  // it silently becomes a journal that cannot answer where its global documents live.
  Object.defineProperty(out, ORG_PARENT, { value: journal, enumerable: true, configurable: true });
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
  // Expired-lock takeover CAS also stays atomic in the org view (if not bridged it would fall back to
  // Best-effort get→put, creating a split-brain risk in a multi-tenant scenario).
  if (journal.putIfMatch) {
    out.putIfMatch = (key, expected, value) => journal.putIfMatch!(prefix + key, expected, value);
  }
  // H2 (storage clock): NO prefix — time isn't organization-specific, delegated as-is.
  if (journal.now) {
    out.now = () => journal.now!();
  }
  // H8a (atomic counter): the key is prefixed → budget.ts:incrBy/getOrgUsage also use an
  // Engine-internal atomic increment in the org view (would fall back to legacy get→put if not bridged).
  if (journal.incrBy) {
    out.incrBy = (key, fields) => journal.incrBy!(prefix + key, fields);
  }
  if (journal.getCounters) {
    out.getCounters = (key) => journal.getCounters!(prefix + key);
  }
  // P1.6b: atomic batch — every key inside `batch` (claim/incrs/puts) is prefixed the SAME way put()/
  // IncrBy() prefix their own single key, so the org isolation guarantee carries over unchanged.
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
  // Above) — it's an ENGINE-LEVEL aggregate over the WHOLE underlying store (e.g. SQL `GROUP BY` on
  // `gnl_runs`), with NO per-organization filter parameter to push the `org:<id>:` prefix into. Bridging
  // It naively would leak EVERY organization's counts into this one's view (a real cross-tenant data
  // Leak) — so it's left undefined; callers (studio's /metrics) fall back to the already org-safe
  // `listRuns`-based count.
  // H8b (stale run scan): the underlying result physically comes back as `org:<orgId>:<runId>`
  // (parseJournalKey counts the ENTIRE prefixed key as the runId — see the run_id column/ZSET member in
  // Sqlite/postgres/redis-storage.ts). ONLY the ones belonging to THIS organization are FILTERED and the
  // Prefix is STRIPPED before returning — the same isolation pattern as readRun/listRuns (other
  // Organizations' runs don't leak).
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
    // listRunsArray, not a direct `.filter`: the underlying reader may hand back a Page (every
    // First-party `storage.runs` does, and that is what the README's quickstart passes as `journal`).
    // Calling `.filter` on it threw, which took the ORG USAGE/quota path down with it.
    out.listRuns = async (): Promise<RunSummary[]> =>
      (await listRunsArray({ listRuns: (q) => (reader.listRuns as (qq?: unknown) => Promise<unknown>).call(journal, q) }))
        .filter((r) => r.runId.startsWith(prefix))
        .map((r) => ({ ...r, runId: r.runId.slice(prefix.length) }));
  }
  /**
   * P0.3 the underlying `listRunsPaged` has NO concept of "this organization" —
   * Keys are prefixed BEFORE reaching it (see get/put above), so its own gnl_runs-style index mixes
   * EVERY organization's runs in ONE keyspace. Unlike the unpaged `listRuns` bridge just above (which
   * Can safely filter-then-strip because it always reads EVERYTHING, no slicing involved), a single
   * Underlying PAGE can't just be filtered-then-returned: doing so would either under-fill the caller's
   * Requested `limit` (silently returning fewer items than exist) or — if combined with the underlying
   * Page's own `nextCursor` — skip over this organization's runs that happened to fall in an
   * Underlying page dominated by OTHER organizations (exactly the "filter after slicing" bug the
   * Whole P0.3 filter contract exists to avoid). So this WALKS the underlying store's pages forward
   * (relying on the numeric cursor-as-offset convention every adapter's `offset()`/`paginate()` helper
   * Already uses — see sqlite/postgres/redis/in-memory-storage.ts), accumulating only this
   * Organization's (prefix-stripped) runs, until either `limit` is reached or the underlying store is
   * Exhausted. Honest cost: an organization holding a small slice of a large shared keyspace pays for
   * Walking through every OTHER organization's runs along the way — a real Postgres/SQL fix would push
   * An explicit key-prefix filter into RunJournal.listRuns itself (out of scope for P0.3).
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
  // Organization — returned as-is. If not bridged, retention/budget's stats path would silently disappear in the org view.
  if (typeof reader.readRunStats === 'function') {
    out.readRunStats = (runId: string) => reader.readRunStats!.call(journal, prefix + runId);
  }
  return out;
}

/**
 * The exclusive upper bound of a prefix range, for a store that orders strings by BYTES.
 *
 * Every prefix scan here is `key >= prefix AND key < bound`. The bound used to be `prefix + U+FFFF`,
 * on the assumption that U+FFFF sorts above anything that can follow the prefix. In UTF-16 (what JS
 * string comparison uses) it does — an astral character is a surrogate pair starting at U+D800, which
 * is below U+FFFF. In UTF-8, which is what SQLite and Postgres actually compare, it does NOT: U+FFFF
 * encodes as EF BF BF and any astral character starts with F0 or higher.
 *
 * Measured on SQLite, three keys under `org:acme:` where one run id begins with an emoji:
 *   listKeys('org:acme:')   → 2 of 3
 *   deletePrefix('org:acme:') → deleted 2, returned 2, and the third key was still there
 *
 * So an organization purge or a GDPR erasure reported success while leaving rows behind, for run ids
 * that are perfectly legal — the same silent, "succeeded" shape as the collation bug, reached through
 * a different door.
 *
 * Incrementing the prefix's last code point is exact rather than a taller sentinel: no suffix can sort
 * at or above it, because any key that did would no longer start with the prefix.
 */
export function prefixUpperBound(prefix: string): string | undefined {
  // An empty prefix means EVERY key, so there is no upper bound to compute — and returning '' was a
  // regression: `key < ''` is never true, so `listKeys('')` returned nothing and `deletePrefix('')`
  // deleted nothing while reporting 0. Measured on SQLite: 0 of 2 keys. That is the same silent-success
  // shape this function exists to remove, reintroduced at the one input that means "all of it".
  // `undefined` forces the caller to omit the upper bound rather than compare against a sentinel.
  if (!prefix) return undefined;
  const cps = Array.from(prefix);
  const last = cps.pop()!;
  let next = last.codePointAt(0)! + 1;
  // Lone surrogates are not valid scalar values and do not survive a UTF-8 round trip.
  if (next >= 0xD800 && next <= 0xDFFF) next = 0xE000;
  if (next > 0x10FFFF) {
    // The prefix ends at the highest code point there is, so nothing can be incremented. Fall back to
    // appending the maximum character: the range is then everything from `prefix` up to
    // `prefix + U+10FFFF`, which covers every suffix except one that begins with U+10FFFF itself.
    return prefix + '\u{10FFFF}';
  }
  return cps.join('') + String.fromCodePoint(next);
}
