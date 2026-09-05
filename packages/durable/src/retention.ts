// Retention/GDPR: PERMANENT deletion helpers from the journal. The one exception to the
// Journal's append-only philosophy — only for legal deletion (PII purge) and retention sweeps.
// Requires the `deletePrefix` port (InMemory/Sqlite/Postgres adapters provide it); otherwise
// Throws a clear error.
import { runKeys, summarizeRun, nestedAgentRunId } from './journal.js';
import type { Journal, JournalReader } from './journal.js';
import { getRunCost } from './cost.js';
import { USAGE_KEY, usageCountedKey } from './budget.js';
import type { OrganizationUsage } from './budget.js';
import type { LogItem } from './durable-log.js';
import { createPollLoop } from './polling.js';
import type { PollLoop } from './polling.js';

function requireDelete(journal: Journal): NonNullable<Journal['deletePrefix']> {
  if (typeof journal.deletePrefix !== 'function') {
    throw new Error("@gnldev/durable: journal must support 'deletePrefix' for purge (InMemory/Sqlite/Postgres provide it)");
  }
  return journal.deletePrefix.bind(journal);
}

function requireListKeys(journal: Journal): NonNullable<Journal['listKeys']> {
  if (typeof journal.listKeys !== 'function') {
    throw new Error("@gnldev/durable: journal must support 'listKeys' for sweep (InMemory/Sqlite/Postgres provide it)");
  }
  return journal.listKeys.bind(journal);
}

/**
 * The workflow run-registry key, derived exactly the way @gnldev/workflow's `statusKey` WRITES it
 * (`wfrun:<runId>`). Mirrored rather than imported: this package stays structurally decoupled from
 * @gnldev/workflow (see registry.ts's WorkflowLike JSDoc), and the same mirroring already happens in
 * registry.ts's FLOW-08 comment and its tests. The record is deliberately NOT under `<runId>:` — a
 * top-level key so ONE prefix scan enumerates every workflow run — which is precisely why the
 * `${runId}:` deletes in purgeRun never reached it.
 */
const workflowStatusKey = (runId: string) => `wfrun:${runId}`;

/**
 * Deletes ONE key on a port that only offers PREFIX deletion. `wfrun:<runId>` ends where the runId
 * ends, so `deletePrefix('wfrun:r-1')` also takes `wfrun:r-10` — a DIFFERENT run's record, and that
 * boundary is the property purge.test.ts exists to protect. Extension neighbors are therefore read
 * back and rewritten around the delete. The rewrite is sound because the value is the one just read
 * and the record is an advisory mirror (@gnldev/workflow's `putStatus` is best-effort; the
 * WorkflowResult return value is the source of truth) — a status transition landing inside the window
 * loses one advisory update, which the run's next transition overwrites.
 *
 * Without listKeys the neighbors cannot be seen at all, so the delete is attempted only when the EXACT
 * record exists: a purge can then never turn a runId that owns no record into a prefix sweep of other
 * runs' records. The remaining case (the record exists AND a longer runId extends it on a journal with
 * no listKeys) is stated, not hidden — every adapter shipped here provides listKeys.
 */
async function deleteExactKey(journal: Journal, key: string): Promise<number> {
  const del = requireDelete(journal);
  if ((await journal.get(key)) === undefined) return 0;
  const lk = journal.listKeys;
  if (typeof lk !== 'function') return del(key);
  const neighbors: Array<[string, unknown]> = [];
  for (const k of await lk.call(journal, key)) {
    if (k === key) continue;
    neighbors.push([k, await journal.get(k)]);
  }
  const deleted = await del(key);
  for (const [k, value] of neighbors) {
    if (value !== undefined) await journal.put(k, value);
  }
  return Math.max(0, deleted - neighbors.length);
}

/**
 * Does a DERIVED child runId actually have a trace? Keys first, because listKeys sees a workflow
 * child's `<runId>:wf:<step>` records and readRun cannot (they are not `:model:`/`:tool:` entries, so
 * parseJournalKey is blind to them by design). The run-registry record is the last probe: a workflow
 * whose steps all live behind a suspend, or one built with no steps at all, has written nothing else.
 */
async function hasTrace(journal: Journal & Partial<JournalReader>, runId: string): Promise<boolean> {
  const lk = journal.listKeys;
  const rr = journal.readRun;
  if (typeof lk === 'function') {
    if ((await lk.call(journal, `${runId}:`)).length > 0) return true;
  } else if (typeof rr === 'function' && (await rr.call(journal, runId)).length > 0) {
    return true;
  }
  return (await journal.get(workflowStatusKey(runId))) !== undefined;
}

/**
 * 1.1: BEFORE the run is deleted, SUBTRACT any cost that may have been added to the counter (H4:
 * Otherwise `__usage__` goes stale after purge — the deleted run's cost keeps being counted as a
 * Ghost). Only subtracted if the `usage-counted` marker EXISTS (i.e. it was actually added to the
 * Counter) — this avoids mistakenly pushing a never-counted run (e.g. still suspended) into the
 * Negative. Best-effort: silently skipped if the journal read surface isn't supported (the purge
 * Itself still runs).
 */
async function uncountUsage(journal: Journal & Partial<JournalReader>, runId: string): Promise<void> {
  if (typeof journal.get !== 'function' || typeof journal.put !== 'function' || typeof journal.readRun !== 'function') return;
  const marker = usageCountedKey(runId);
  if ((await journal.get(marker)) === undefined) return; // never counted → nothing to subtract
  // H8a fix: usage can live in the legacy USAGE_KEY OR in atomic counters — the old guard, which
  // Only looked at legacy, silently skipped the subtraction in the counter-only case (caught by a test).
  const current = await journal.get<OrganizationUsage>(USAGE_KEY);
  const counters =
    typeof (journal as Journal).getCounters === 'function'
      ? await (journal as Journal).getCounters!(USAGE_KEY)
      : undefined;
  if (!current && !counters) return; // no counter at all → nothing to subtract
  const cost = await getRunCost(journal as unknown as JournalReader, runId);
  // H8a: if incrBy exists, subtract ATOMICALLY with a negative delta (reads are clamped to 0 on
  // The readUsageCounter side); otherwise legacy get→put + clamp (single-process safe).
  if (typeof (journal as Journal).incrBy === 'function') {
    try {
      await (journal as Journal).incrBy!(USAGE_KEY, { runs: -1, tokens: -cost.totalTokens, costUsd: -cost.costUsd });
      return;
    } catch { /* fall back to legacy */ }
  }
  if (!current) return; // no legacy record → no legacy subtraction either
  await journal.put(USAGE_KEY, {
    runs: Math.max(0, current.runs - 1),
    tokens: Math.max(0, current.tokens - cost.totalTokens),
    costUsd: Math.max(0, current.costUsd - cost.costUsd),
  });
}

/**
 * Permanently delete ALL traces of a run: `<runId>:*` (model/tool/input/wf/proc/cfg/net) + memory
 * Marker + its sub-agents' own journals — RECURSIVE cascade (H5):
 *
 * **Network children** (`net:<runId>:<i>`, parent-prefixed): derived from listKeys as SEPARATE
 *   RunIds, each recursed into → their OWN agent-tool children get caught too. If listKeys is
 *   Unavailable, a blanket `net:<runId>:` prefix delete is still applied (at least the direct level).
 * **Agent-tool children** (`agent:<toolCallId>`, NOT parent-prefixed): before deletion, toolCallIds
 *   Are read from the parent's tool entries (readRun), and every `agent:<tcid>` child with a trace in
 *   The journal is recursed into. If readRun is unavailable, this discovery is skipped (best-effort —
 *   Documented legacy behavior).
 * **Workflow-as-tool children** (`wf:<runId>:<tcid>`, registry.ts's buildWorkflowTools): derived from
 *   The SAME tool entries, with the same both-shapes rule. These used to outlive their parent
 *   Entirely — a purged run left the workflow child's step outputs and its `wfrun:` registry record
 *   Behind, advertising a run whose parent no longer exists.
 *
 * **Run-registry record** (`wfrun:<runId>`): top-level by design, so no `<runId>:` prefix delete could
 * Reach it. Deleted for THIS run — which covers nested workflow children too, since the cascade
 * Recurses into them and each recursion deletes its own.
 *
 * Cycle safety: the same runId is processed once per purge chain (`seen`). GDPR implication: parent
 * Purge no longer orphans sub-agent output (which may contain PII) at ANY level.
 */
export async function purgeRun(
  journal: Journal & Partial<JournalReader>,
  runId: string,
  seen: Set<string> = new Set(),
): Promise<number> {
  const del = requireDelete(journal);
  if (seen.has(runId)) return 0; // cycle/repeat safety
  seen.add(runId);
  await uncountUsage(journal, runId); // BEFORE deletion (so getRunCost can still read it)
  let total = 0;

  // Child discovery BEFORE deletion (readRun/listKeys go empty once deleted).
  const rr = journal.readRun;
  const lk = journal.listKeys;
  if (typeof rr === 'function') {
    for (const e of await rr.call(journal, runId)) {
      if (e.kind !== 'tool') continue;
      const tcid = e.key.slice(e.key.lastIndexOf(':tool:') + ':tool:'.length);
      // Both KINDS of nested run (sub-agent and workflow-as-tool) in both SHAPES: the parent-scoped id
      // They use now, and the bare legacy one still in journals written before it was scoped — a purge
      // That misses any of them leaves orphaned PII.
      for (const child of new Set([
        nestedAgentRunId(runId, tcid),
        `agent:${tcid}`,
        nestedAgentRunId(runId, tcid, 'wf'),
        `wf:${tcid}`,
      ])) {
        if (await hasTrace(journal, child)) total += await purgeRun(journal, child, seen);
      }
    }
  }
  if (typeof lk === 'function') {
    const kids = new Set<string>();
    for (const k of await lk.call(journal, `net:${runId}:`)) {
      const restStr = k.slice(`net:${runId}:`.length);
      const cut = restStr.indexOf(':');
      if (cut > 0) kids.add(`net:${runId}:${restStr.slice(0, cut)}`);
    }
    for (const kid of kids) total += await purgeRun(journal, kid, seen);
  }

  total += await del(`${runId}:`);
  total += await del(runKeys.memAppended(runId)); // full key = its own prefix
  total += await del(runKeys.memUserAppended(runId)); // write-ahead marker — same lifecycle as memAppended
  total += await del(`net:${runId}:`); // blanket cascade for journals without listKeys (direct level)
  total += await deleteExactKey(journal, workflowStatusKey(runId)); // top-level, so the prefixes above miss it
  return total;
}

/** Permanently delete a thread's BasicMemory trace (`mem:<threadId>:*`). Rich memory stores use their
 *  Own deletion API (AgentMemory.deleteThread) — this helper is for journal-based memory.
 *
 *  HERMES CAVEAT (honest-inventory line, denetçi K12): `sugg:`/`lesson:` records are NOT swept here —
 *  they are owned by the RESOURCE (user), not the thread. But a suggestion's evidence entries carry
 *  `threadId` (and `runId`) as provenance fields, and those entries survive both this sweep and
 *  purgeRun. A deployment erasing a person should purge their suggestion surface too:
 *  `deletePrefix('sugg:')` filtered by resourceId is not expressible — sweep
 *  `lesson:res:<resourceId>:` directly and delete their `sugg:` records via the suggestions API/list. */
export async function purgeThread(journal: Journal, threadId: string): Promise<number> {
  const del = requireDelete(journal);
  // FAZ-3: the thread owns its dedup state too — `idempotencyWindow: 'thread'` records and
  // Thread-scoped duplicate markers both live under `xthr:<threadId>:` PRECISELY so this one sweep
  // Reclaims them with the thread (the cross-run family's immortal-key problem does not recur here).
  return (await del(`mem:${threadId}:`)) + (await del(`xthr:${threadId}:`));
}

/**
 * GDPR/KVKK deletion runbook, as ONE function — permanently deletes EVERYTHING an organization owns
 * In the ROOT journal: because `withOrg` prefixes every key unconditionally, ONE
 * `deletePrefix('org:<id>:')` covers the org's runs + journals + memory + usage/budget
 * Counters (`gnl_counters`/`ctr:` — swept since the P1.6 deletePrefix fix; this function is the reason
 * That fix was load-bearing) + materialized metrics + workflow registry records (`org:<id>:wfrun:*`) +
 * Cross-run dedup keys (`org:<id>:xrun:*`).
 *
 * PREFIX-BOUNDARY SAFETY: the trailing ':' makes the sweep exact — org 'acme' can never catch org
 * 'acme2' (`org:acme2:` does not start with `org:acme:`). Callers MUST reject org ids containing ':'
 * (the studio org-delete route already does).
 *
 * NOT DELETED, AND THIS ONE IS A GAP RATHER THAN A CHOICE: everything `@gnldev/queue` and
 * `@gnldev/events` write. Those live in the WorkStore (`gnl_work_log` / `gnl_work_kv`, `wl:` / `wk:`
 * on redis), and this function deletes through the *Journal* — measured on all four adapters, an
 * org's work rows survive the purge. A deployment that runs queues or an event bus under `withOrg`
 * and needs a real erasure has to sweep those tables itself; there is no framework surface for it
 * (`WorkStore` has no delete at all). Do not read the paragraph above as covering them.
 *
 * DELIBERATELY NOT DELETED (the honest rest of the runbook):
 * Root `__audit__` entries that carry this org as a PAYLOAD field: the audit trail is a root-level
 *    Record with its own (usually legally-mandated) retention — sweep it on ITS schedule via
 *    `sweepLog(journal, '__audit__', ...)`, don't couple it to org deletion.
 * Orgless/shared-scope data: if the deployment ran this org's work OUTSIDE withOrg (no prefix),
 *    This function cannot attribute it — that is a deployment-model choice, not a sweep gap.
 * EE user records (auth-ee's own store) — studio's DELETE /organizations/:id removes members when
 *    `opts.users` is wired; call that surface (or the user store directly) alongside this.
 * (Covered, for the record: HERMES `sugg:`/`lesson:`/`suggstats:` families ARE swept by this
 *    function — withOrg prefixes them like every other key. The gap for them is per-PERSON deletion,
 *    documented on purgeThread.)
 */
export async function purgeOrganization(journal: Journal, orgId: string, now = Date.now()): Promise<number> {
  if (orgId.includes(':')) throw new Error(`@gnldev/durable: purgeOrganization('${orgId}') — org id must not contain ':' (it would break the org:<id>: prefix boundary)`);
  const del = requireDelete(journal);
  const n = await del(`org:${orgId}:`);
  // A boundary marker, because the audit log is NOT org-prefixed and therefore survives this.
  //
  // Org ids are strings a human chooses — 'acme', a company slug — so the same id being handed to a
  // different organization later is ordinary, not exotic. Measured before this: purge removed the org's
  // data and left every `__audit__` record tagged `org: 'acme'` in place, so the NEXT holder of that id
  // opened /audit and read who did what in the previous tenancy.
  //
  // The records are not deleted. An audit log that can be erased by the operation it is meant to
  // record is not an audit log, and the operator's own view still needs the whole history — including
  // the purge. What changes is the org-SCOPED view: it starts at the org's current tenancy.
  await journal.put(orgPurgedKey(orgId), { at: now });
  return n;
}

/** Marks when an org id was last purged; an org-scoped audit view starts after this. */
export function orgPurgedKey(orgId: string): string {
  return `__org_purged__:${orgId}`;
}

export interface SweepOptions {
  /** Runs older than this (ms) are deleted. Age = the run's LAST entry time (last activity). */
  olderThanMs: number;
  /** Suspended (awaiting-approval) runs are preserved (default true) — pending work isn't silently deleted. */
  keepSuspended?: boolean;
  /**
   * FAZ-4: even with keepSuspended, a suspended run older than THIS (ms, by last activity) becomes
   * Sweepable — the answer to "suspended runs accumulate forever" (retention deliberately protects
   * Them; layers 2-3 raise the suspend volume, so an expiry arm stopped being optional). Uses the
   * SLOW scan (the indexed fast path cannot age suspended runs separately). Undefined = today's
   * Behavior: suspended runs are never swept.
   */
  suspendedTtlMs?: number;
  /**
   * FAZ-4: write a `${runId}:swept` TOMBSTONE after purging each run. A late retry of that runId can
   * Then be REFUSED under `tombstonePolicy: 'reject'` (the critical profile) instead of silently
   * Re-running side effects whose dedup window died with the journal. LIFECYCLE, stated honestly:
   * Under 'reject' the tombstone is effectively PERMANENT: after the purge the run's only key is the
   * Tombstone itself, which no sweep scan lists (it is invisible to the run readers) — removal only
   * Happens on the 'ignore'+re-run+second-sweep chain. The safe direction, but know it. The REAL
   * Contract is and remains: retention window >= client retry horizon.
   */
  tombstones?: boolean;
  /** Testability: "now" (default Date.now()). */
  now?: number;
}

export interface SweepResult {
  scanned: number;
  /** Deleted runIds. */
  purged: string[];
  /** Number of suspended runs skipped due to keepSuspended. */
  keptSuspended: number;
  /** Number of runs whose age couldn't be measured (and were thus preserved) due to missing timestamps. */
  keptNoTs: number;
  deletedEntries: number;
}

/**
 * Retention sweep: permanently deletes runs whose last activity is older than `olderThanMs`.
 * Safety defaults: suspended runs and runs without a timestamp are NOT deleted.
 * Requires a reader (listRuns/readRun) + deletePrefix.
 */
export async function sweepRuns(journal: Journal & Partial<JournalReader>, opts: SweepOptions): Promise<SweepResult> {
  requireDelete(journal);
  if (typeof journal.listRuns !== 'function' || typeof journal.readRun !== 'function') {
    throw new Error("@gnldev/durable: sweepRuns requires a journal read surface (listRuns/readRun)");
  }
  const now = opts.now ?? Date.now();
  const keepSuspended = opts.keepSuspended !== false;

  // H8b FAST PATH: if the adapter provides an indexed age query (gnl_runs.updated_at), get stale
  // Ids directly without pulling ALL of every run's entries (the old O(entire-DB) scan). The result
  // Contract is the same; keptSuspended/keptNoTs are reported as 0 by definition on this path
  // (SQL already filtered).
  // FAZ-4: suspendedTtlMs needs the slow scan — the indexed query cannot age suspended runs on a
  // SEPARATE cutoff (it either includes them at the general cutoff or not at all).
  if (typeof (journal as Journal).listStaleRuns === 'function' && opts.suspendedTtlMs === undefined) {
    const cutoff = now - opts.olderThanMs;
    const stale = await (journal as Journal).listStaleRuns!(cutoff, { includeSuspended: !keepSuspended });
    const fast: SweepResult = { scanned: stale.length, purged: [], keptSuspended: 0, keptNoTs: 0, deletedEntries: 0 };
    for (const runId of stale) {
      fast.deletedEntries += await purgeRun(journal, runId);
      if (opts.tombstones) await journal.put(`${runId}:swept`, { at: now });
      fast.purged.push(runId);
    }
    return fast;
  }

  const listed = await journal.listRuns();
  const runs = Array.isArray(listed) ? listed : (listed as { items: { runId: string }[] }).items;
  const result: SweepResult = { scanned: 0, purged: [], keptSuspended: 0, keptNoTs: 0, deletedEntries: 0 };

  for (const r of runs) {
    result.scanned++;
    const entries = await journal.readRun(r.runId);
    const summary = summarizeRun(r.runId, entries);
    const stamps = entries.map((e) => e.ts).filter((t): t is number => t != null);
    const lastActivity = stamps.length ? Math.max(...stamps) : undefined;
    if (keepSuspended && summary.status === 'suspended') {
      // FAZ-4 expiry arm: a suspended run past suspendedTtlMs stops being protected — nobody is
      // Coming to approve it, and layers 2-3 made suspends routine enough that "forever" leaks.
      const expired = opts.suspendedTtlMs !== undefined && lastActivity !== undefined && now - lastActivity > opts.suspendedTtlMs;
      if (!expired) {
        result.keptSuspended++;
        continue;
      }
    }
    if (lastActivity === undefined) {
      result.keptNoTs++; // age can't be measured → safe side: preserve
      continue;
    }
    if (now - lastActivity > opts.olderThanMs || (summary.status === 'suspended' && opts.suspendedTtlMs !== undefined && now - lastActivity > opts.suspendedTtlMs)) {
      result.deletedEntries += await purgeRun(journal, r.runId);
      if (opts.tombstones) await journal.put(`${r.runId}:swept`, { at: now });
      result.purged.push(r.runId);
    }
  }
  return result;
}

// ── Journal-based append-log + BasicMemory sweeping (the core-hardening review) ─────────────
// Run-focused retention (sweepRuns above) does NOT see durable-log namespaces (`${ns}:${id}`,
// E.g. studio `__audit__`/`__alert__`) or BasicMemory threads (`mem:<threadId>:*`) — these grow
// Unbounded in a long-lived deployment. The two helpers below close that gap.
// Same safety philosophy as sweepRuns: a record whose age can't be measured is NOT deleted, and
// Is counted in the report.

export interface LogSweepOptions {
  /** Log entries older than this (ms) are deleted. Age = the entry's `at` field (written by appendLog). */
  olderThanMs: number;
  /**
   * Consume marker key(s) belonging to the deleted entry. HONEST NOTE: in journal-based durable-log,
   * The marker schema is NOT FIXED — `consumeOnce(journal, marker)` leaves the marker key entirely up
   * To the caller (qdone/evtack-like schemas live in the WorkStore layer, see @gnldev/queue, @gnldev/events).
   * Because of this, markers can't be auto-discovered; declare your own schema via this callback
   * (e.g. `(it) => \`ack:worker1:\${it.id}\``) — the markers of every deleted entry get cleaned up too.
   */
  markerFor?: (item: LogItem) => string | string[] | undefined;
  /** Testability: "now" (default Date.now()). */
  now?: number;
}

export interface LogSweepResult {
  scanned: number;
  /** Number of deleted log entries. */
  deleted: number;
  /** Number of entries whose age couldn't be measured (and were thus preserved) because the `at` field was missing/unreadable. */
  keptNoTs: number;
  /** Number of consume-marker keys cleaned up via markerFor. */
  deletedMarkers: number;
}

/**
 * Sweeps a durable-log namespace: permanently deletes entries whose `at` (the epoch-ms written by
 * AppendLog) is older than the threshold. Requires listKeys + deletePrefix (requireDelete pattern).
 * Safe side: entries without/with malformed `at` are not deleted (counted in keptNoTs).
 */
export async function sweepLog(journal: Journal, ns: string, opts: LogSweepOptions): Promise<LogSweepResult> {
  const del = requireDelete(journal);
  const list = requireListKeys(journal);
  const now = opts.now ?? Date.now();
  const prefix = `${ns}:`;
  // Ordered scan: the journal has no single-key `delete`, deletion is done via deletePrefix(fullKey).
  // A key can be a PREFIX of another key (custom ids, e.g. `approval:<runId>:<tc>` — one can be a
  // Prefix of another). In lexicographic order, a key's extensions come right after it → if one of
  // The extensions is NOT going to be deleted, deletePrefix on the short key is unsafe, so that entry
  // Is skipped.
  const keys = (await list(prefix)).sort();
  const result: LogSweepResult = { scanned: 0, deleted: 0, keptNoTs: 0, deletedMarkers: 0 };

  // First collect everyone's decision (expired?), then delete — so prefix-neighbor checks can see the decisions.
  const records = new Map<string, { rec: any; expired: boolean }>();
  for (const key of keys) {
    result.scanned++;
    const rec = await journal.get<any>(key);
    if (rec === undefined) continue; // vanished between scan and read → nothing to do
    const at = rec && typeof rec === 'object' ? rec.at : undefined;
    if (typeof at !== 'number' || !Number.isFinite(at)) {
      result.keptNoTs++; // age can't be measured → safe side: preserve (same philosophy as sweepRuns keptNoTs)
      continue;
    }
    records.set(key, { rec, expired: now - at > opts.olderThanMs });
  }

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const entry = records.get(key);
    if (!entry?.expired) continue;
    // Prefix-neighbor guard: don't delete if one of the neighbors that extends this key is staying.
    let unsafe = false;
    for (let j = i + 1; j < keys.length && keys[j].startsWith(key); j++) {
      if (!records.get(keys[j])?.expired) { unsafe = true; break; }
    }
    if (unsafe) continue;
    // DeletePrefix(fullKey): extension-neighbors are also expired → deleting them together is
    // Correct behavior; when the loop reaches them, del returns 0 → deleted isn't double-counted.
    const n = await del(key);
    result.deleted += n;
    if (n > 0 && opts.markerFor) {
      const item: LogItem = { id: entry.rec.id ?? key.slice(prefix.length), key, payload: entry.rec.payload, at: entry.rec.at };
      const markers = opts.markerFor(item);
      for (const m of Array.isArray(markers) ? markers : markers ? [markers] : []) {
        result.deletedMarkers += await del(m);
      }
    }
  }
  return result;
}

export interface ThreadSweepOptions {
  /** Threads whose last message is older than this (ms) are deleted. */
  olderThanMs: number;
  /** Testability: "now" (default Date.now()). */
  now?: number;
}

export interface ThreadSweepResult {
  scanned: number;
  /** threadIds deleted via purgeThread. */
  purged: string[];
  /** Number of threads whose age couldn't be measured (and were thus preserved) because none of their messages had a recognized ts field. */
  keptNoTs: number;
}

// BasicMemory's known key suffixes (memory.ts schema): `mem:<threadId>:messages|:working`.
// ThreadId itself may contain ':' → the extraction is done via known-suffix matching, NOT split.
const MEM_PREFIX = 'mem:';
const MEM_SUFFIXES = [':messages', ':working'] as const;

/** Reads a timestamp from a message. HONEST NOTE: BasicMemory doesn't timestamp messages itself
 *  (AI SDK's ModelMessage has no ts field) — only common fields added by the caller are recognized
 *  (`ts`/`at`/`createdAt`, an epoch-ms number or a parseable date string/Date). */
function readMessageTs(msg: any): number | undefined {
  if (!msg || typeof msg !== 'object') return undefined;
  for (const field of ['ts', 'at', 'createdAt']) {
    const v = msg[field];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (v instanceof Date && Number.isFinite(v.getTime())) return v.getTime();
    if (typeof v === 'string') {
      const parsed = Date.parse(v);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

/**
 * Sweeps BasicMemory threads: threads whose last message ts is older than the threshold are
 * Permanently deleted via purgeThread (`mem:<threadId>:` prefix — messages + working together).
 * Safe side: threads whose ts can't be read (untimestamped messages or no messages at all) are NOT deleted.
 * Requires listKeys + deletePrefix (requireDelete pattern).
 */
export async function sweepThreads(journal: Journal, opts: ThreadSweepOptions): Promise<ThreadSweepResult> {
  requireDelete(journal);
  const list = requireListKeys(journal);
  const now = opts.now ?? Date.now();

  // Extract the thread set from keys under `mem:`. Keys with unrecognized suffixes don't contribute
  // A threadId to the set (safe: only the recognized schema is swept), but if they belong to a
  // Recognized thread they still go with it via purgeThread's prefix delete.
  const threadIds = new Set<string>();
  for (const key of await list(MEM_PREFIX)) {
    const rest = key.slice(MEM_PREFIX.length);
    for (const suffix of MEM_SUFFIXES) {
      if (rest.endsWith(suffix) && rest.length > suffix.length) {
        threadIds.add(rest.slice(0, -suffix.length));
        break;
      }
    }
  }

  const result: ThreadSweepResult = { scanned: 0, purged: [], keptNoTs: 0 };
  for (const threadId of threadIds) {
    result.scanned++;
    const messages = (await journal.get<any[]>(`${MEM_PREFIX}${threadId}:messages`)) ?? [];
    const stamps = messages.map(readMessageTs).filter((t): t is number => t !== undefined);
    if (stamps.length === 0) {
      result.keptNoTs++; // age can't be measured → safe side: preserve
      continue;
    }
    const lastActivity = Math.max(...stamps);
    if (now - lastActivity > opts.olderThanMs) {
      await purgeThread(journal, threadId);
      result.purged.push(threadId);
    }
  }
  return result;
}

// ── Phase 8.3: opt-in automatic retention scheduling ────────────────────────────────────────
// SweepRuns/sweepLog/sweepThreads/compact were all called MANUALLY (from Studio or a script) —
// None of them were triggered automatically. The helper below sets up a periodic sweep round
// Using @gnldev/durable/polling's createPollLoop (the SAME scheduler core SHARED with queue/events/scheduler).
// It does NOT start anything AUTOMATICALLY — the user must explicitly call `start()`.

export interface LogSweepTarget extends LogSweepOptions {
  /** The durable-log namespace to sweep (appendLog's first argument, e.g. `__audit__`). */
  ns: string;
}

export interface RetentionSweeperOptions {
  /** Sweep round interval (ms). Default 1 hour — retention isn't urgent, no need for frequent scans. */
  intervalMs?: number;
  /** Options passed to sweepRuns (olderThanMs required). */
  sweep: SweepOptions;
  /**
   * If given, sweepLog also runs after sweepRuns on every round (a single namespace or an array
   * For multiple namespaces — e.g. `__audit__` + `__alert__` can be swept in the same round).
   */
  logSweep?: LogSweepTarget | LogSweepTarget[];
  /** An error from a round (sweepRuns or sweepLog) is reported here — the chain doesn't die, the next round retries. */
  onError?: (err: unknown) => void;
}

export interface RetentionSweepSummary {
  /** Number of runs deleted via purgeRun this round. */
  purgedRuns: number;
  /** Total number of log entries deleted this round (if logSweep was given). */
  deletedLog: number;
}

export interface RetentionSweeper extends PollLoop {
  /** A single manual sweep round (tests / manual trigger) — can be called without waiting on start(). */
  runOnce(): Promise<RetentionSweepSummary>;
}

/**
 * Opt-in periodic retention sweeper: runs `sweepRuns` (+ `sweepLog` if given) at `intervalMs`
 * Intervals. Uses createPollLoop with backoff DISABLED — retention should have a fixed cadence;
 * Postponing the next round (backoff growth) just because "nothing was deleted this round" would
 * Go against retention's purpose (we don't want a delayed scan of data accumulated after a long
 * Quiet period). It does NOT start anything AUTOMATICALLY — no scan happens until the returned
 * Object's `start()` is called.
 */
export function createRetentionSweeper(
  journal: Journal & Partial<JournalReader>,
  opts: RetentionSweeperOptions,
): RetentionSweeper {
  const intervalMs = opts.intervalMs ?? 60 * 60_000;
  const logTargets = opts.logSweep ? (Array.isArray(opts.logSweep) ? opts.logSweep : [opts.logSweep]) : [];

  async function runOnce(): Promise<RetentionSweepSummary> {
    let purgedRuns = 0;
    let deletedLog = 0;
    try {
      const res = await sweepRuns(journal, opts.sweep);
      purgedRuns = res.purged.length;
    } catch (err) {
      opts.onError?.(err);
    }
    for (const target of logTargets) {
      try {
        const { ns, ...logOpts } = target;
        const res = await sweepLog(journal as Journal, ns, logOpts);
        deletedLog += res.deleted;
      } catch (err) {
        opts.onError?.(err);
      }
    }
    return { purgedRuns, deletedLog };
  }

  const loop = createPollLoop(
    async () => {
      const summary = await runOnce();
      return summary.purgedRuns + summary.deletedLog > 0;
    },
    { pollMs: intervalMs, backoff: false },
  );

  return { runOnce, start: loop.start, stop: loop.stop };
}
