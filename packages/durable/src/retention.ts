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
      // Both shapes: the parent-scoped id a sub-agent uses now, and the bare legacy one still in
      // Journals written before it was scoped — a purge that misses either leaves orphaned PII.
      for (const child of new Set([nestedAgentRunId(runId, tcid), `agent:${tcid}`])) {
        const exists =
          typeof lk === 'function'
            ? (await lk.call(journal, `${child}:`)).length > 0
            : (await rr.call(journal, child)).length > 0;
        if (exists) total += await purgeRun(journal, child, seen);
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
  return total;
}

/** Permanently delete a thread's BasicMemory trace (`mem:<threadId>:*`). Rich memory stores use their
 *  Own deletion API (AgentMemory.deleteThread) — this helper is for journal-based memory. */
export async function purgeThread(journal: Journal, threadId: string): Promise<number> {
  const del = requireDelete(journal);
  return del(`mem:${threadId}:`);
}

/**
 * GDPR/KVKK deletion runbook, as ONE function — permanently deletes EVERYTHING an organization owns
 * In the ROOT journal: because `withOrg` prefixes every key unconditionally, ONE
 * `deletePrefix('org:<id>:')` covers the org's runs + journals + memory + queue/events + usage/budget
 * Counters (`gnl_counters`/`ctr:` — swept since the P1.6 deletePrefix fix; this function is the reason
 * That fix was load-bearing) + materialized metrics + workflow registry records (`org:<id>:wfrun:*`) +
 * Cross-run dedup keys (`org:<id>:xrun:*`).
 *
 * PREFIX-BOUNDARY SAFETY: the trailing ':' makes the sweep exact — org 'acme' can never catch org
 * 'acme2' (`org:acme2:` does not start with `org:acme:`). Callers MUST reject org ids containing ':'
 * (the studio org-delete route already does).
 *
 * DELIBERATELY NOT DELETED (the honest rest of the runbook):
 * Root `__audit__` entries that carry this org as a PAYLOAD field: the audit trail is a root-level
 *    Record with its own (usually legally-mandated) retention — sweep it on ITS schedule via
 *    `sweepLog(journal, '__audit__', ...)`, don't couple it to org deletion.
 * Orgless/shared-scope data: if the deployment ran this org's work OUTSIDE withOrg (no prefix),
 *    This function cannot attribute it — that is a deployment-model choice, not a sweep gap.
 * EE user records (auth-ee's own store) — studio's DELETE /organizations/:id removes members when
 *    `opts.users` is wired; call that surface (or the user store directly) alongside this.
 */
export async function purgeOrganization(journal: Journal, orgId: string): Promise<number> {
  if (orgId.includes(':')) throw new Error(`@gnldev/durable: purgeOrganization('${orgId}') — org id must not contain ':' (it would break the org:<id>: prefix boundary)`);
  const del = requireDelete(journal);
  return del(`org:${orgId}:`);
}

export interface SweepOptions {
  /** Runs older than this (ms) are deleted. Age = the run's LAST entry time (last activity). */
  olderThanMs: number;
  /** Suspended (awaiting-approval) runs are preserved (default true) — pending work isn't silently deleted. */
  keepSuspended?: boolean;
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
  if (typeof (journal as Journal).listStaleRuns === 'function') {
    const cutoff = now - opts.olderThanMs;
    const stale = await (journal as Journal).listStaleRuns!(cutoff, { includeSuspended: !keepSuspended });
    const fast: SweepResult = { scanned: stale.length, purged: [], keptSuspended: 0, keptNoTs: 0, deletedEntries: 0 };
    for (const runId of stale) {
      fast.deletedEntries += await purgeRun(journal, runId);
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
    if (keepSuspended && summary.status === 'suspended') {
      result.keptSuspended++;
      continue;
    }
    const stamps = entries.map((e) => e.ts).filter((t): t is number => t != null);
    if (stamps.length === 0) {
      result.keptNoTs++; // age can't be measured → safe side: preserve
      continue;
    }
    const lastActivity = Math.max(...stamps);
    if (now - lastActivity > opts.olderThanMs) {
      result.deletedEntries += await purgeRun(journal, r.runId);
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
