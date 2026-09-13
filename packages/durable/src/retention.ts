// Retention/GDPR: PERMANENT deletion helpers from the journal. The one exception to the
// journal's append-only philosophy — only for legal deletion (PII purge) and retention sweeps.
// Requires the `deletePrefix` port (InMemory/Sqlite/Postgres adapters provide it); otherwise
// throws a clear error.
import { runKeys, summarizeRun, nestedAgentRunId, runIdOfKey } from './journal.js';
import { identityOnlyInput } from './run.js';
import { workKeyHash } from './hash.js';
import type { WorkScopeKind } from './hash.js';
import type { Journal, JournalReader } from './journal.js';

/** What sweepRuns needs off a `:input` record: the freeze stamp, plus whatever identityOnlyInput reads. */
type FrozenInputLike = { at?: number } & Record<string, unknown>;
import type { WorkStore } from './storage.js';
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
  // CRASH WINDOW, stated: between this delete (which takes the neighbours too — delete is a prefix
  // operation) and the re-puts below, a process death loses the neighbours' records with no trace.
  // Accepted for now because the window is a handful of point-writes inside a rare, deliberate
  // operation; closing it for real needs a `deleteExact` port on the adapters (backlog).
  const deleted = await del(key);
  for (const [k, value] of neighbors) {
    if (value !== undefined) await journal.put(k, value);
  }
  return Math.max(0, deleted - neighbors.length);
}

/**
 * Deletes everything under `${runId}:` WITHOUT taking a run whose id extends this one.
 *
 * `${runId}:` looks like a safe prefix because it carries the separator — and against `r-1` vs `r-10`
 * it is (purge.test.ts pins that). The case it does not cover is the one where the neighbour's id
 * IS this id plus more: run `conv` and run `conv:msg1` are two ordinary runs, and every key of the
 * second lives under the prefix of the first. MEASURED on InMemoryJournal and SqliteStorage:
 * `purgeRun('conv')` removed `conv:msg1`'s model record, its tool record, its frozen input and its
 * frozen model choice. That pair is not contrived — @gnldev/chat-adapter DERIVES its per-turn runId as
 * `${conversationId}:${messageId}`, so any host that also runs something under the bare conversation
 * id has it.
 *
 * The fix uses the journal's own answer to "whose key is this": `runIdOfKey` (journal.ts), which is
 * already `_v`-corroborated and already the function the run index trusts. A key under our prefix
 * whose owner is a LONGER runId that starts with our prefix belongs to a neighbour; everything that
 * neighbour owns is then left alone wholesale, not just the three families runIdOfKey can name.
 *
 * TWO honest bounds, both deliberate:
 *  • Without `listKeys` there is nothing to filter on, so the single prefix delete stands — today's
 *    behaviour, stated rather than silently degraded. Every adapter shipped here provides listKeys.
 *  • With listKeys and NO neighbour found — the overwhelmingly common case — this is the old single
 *    `deletePrefix` call plus one key listing and a point-read per `:input` key (the only family
 *    whose owner needs the value; `:model:`/`:tool:` decide from the key text alone). The per-key
 *    delete path only runs when a neighbour actually exists; purge is a rare, deliberate operation
 *    (GDPR erasure / retention sweep), never a request path.
 */
async function purgeOwnNamespace(journal: Journal & Partial<JournalReader>, runId: string): Promise<number> {
  const del = requireDelete(journal);
  const prefix = `${runId}:`;
  const lk = journal.listKeys;
  if (typeof lk !== 'function') return del(prefix);
  const keys = await lk.call(journal, prefix);
  const neighbours = new Set<string>();
  for (const k of keys) {
    // runIdOfKey reads the value only for `:input` keys — a point-read on every key here turned a
    // nightly sweep over a large namespace into O(keys) round-trips for values it never looked at.
    const owner = runIdOfKey(k, k.endsWith(':input') ? await journal.get(k) : undefined);
    if (owner && owner !== runId && owner.startsWith(prefix)) neighbours.add(owner);
  }
  if (neighbours.size === 0) return del(prefix);
  let total = 0;
  for (const k of keys) {
    let foreign = false;
    for (const n of neighbours) if (k === n || k.startsWith(`${n}:`)) { foreign = true; break; }
    if (foreign) continue;
    // deleteExactKey rather than del(k): a key is a prefix too, and one of OUR keys can be a proper
    // prefix of a neighbour's id (`conv:ms` against `conv:msg1`). The same boundary, one level down.
    total += await deleteExactKey(journal, k);
  }
  return total;
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
 * otherwise `__usage__` goes stale after purge — the deleted run's cost keeps being counted as a
 * ghost). Only subtracted if the `usage-counted` marker EXISTS (i.e. it was actually added to the
 * counter) — this avoids mistakenly pushing a never-counted run (e.g. still suspended) into the
 * negative. Best-effort: silently skipped if the journal read surface isn't supported (the purge
 * itself still runs).
 */
async function uncountUsage(journal: Journal & Partial<JournalReader>, runId: string): Promise<void> {
  if (typeof journal.get !== 'function' || typeof journal.put !== 'function' || typeof journal.readRun !== 'function') return;
  const marker = usageCountedKey(runId);
  if ((await journal.get(marker)) === undefined) return; // never counted → nothing to subtract
  // H8a fix: usage can live in the legacy USAGE_KEY OR in atomic counters — the old guard, which
  // only looked at legacy, silently skipped the subtraction in the counter-only case (caught by a test).
  const current = await journal.get<OrganizationUsage>(USAGE_KEY);
  const counters =
    typeof (journal as Journal).getCounters === 'function'
      ? await (journal as Journal).getCounters!(USAGE_KEY)
      : undefined;
  if (!current && !counters) return; // no counter at all → nothing to subtract
  const cost = await getRunCost(journal as unknown as JournalReader, runId);
  // H8a: if incrBy exists, subtract ATOMICALLY with a negative delta (reads are clamped to 0 on
  // the readUsageCounter side); otherwise legacy get→put + clamp (single-process safe).
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
 * marker + its sub-agents' own journals — RECURSIVE cascade (H5):
 *
 * **Network children** (`net:<runId>:<i>`, parent-prefixed): derived from listKeys as SEPARATE
 *   runIds, each recursed into → their OWN agent-tool children get caught too. If listKeys is
 *   unavailable, a blanket `net:<runId>:` prefix delete is still applied (at least the direct level).
 * **Agent-tool children** (`agent:<toolCallId>`, NOT parent-prefixed): before deletion, toolCallIds
 *   are read from the parent's tool entries (readRun), and every `agent:<tcid>` child with a trace in
 *   the journal is recursed into. If readRun is unavailable, this discovery is skipped (best-effort —
 *   documented legacy behavior).
 * **Workflow-as-tool children** (`wf:<runId>:<tcid>`, registry.ts's buildWorkflowTools): derived from
 *   The SAME tool entries, with the same both-shapes rule. These used to outlive their parent
 *   Entirely — a purged run left the workflow child's step outputs and its `wfrun:` registry record
 *   Behind, advertising a run whose parent no longer exists.
 *
 * **Run-registry record** (`wfrun:<runId>`): top-level by design, so no `<runId>:` prefix delete could
 * reach it. Deleted for THIS run — which covers nested workflow children too, since the cascade
 * recurses into them and each recursion deletes its own.
 *
 * Cycle safety: the same runId is processed once per purge chain (`seen`). GDPR implication: parent
 * purge no longer orphans sub-agent output (which may contain PII) at ANY level.
 *
 * NEIGHBOUR BOUND (see purgeOwnNamespace): a run whose id EXTENDS this one — `conv:msg1` under
 * `conv` — is a different run and is left alone. On a journal with `listKeys` that is enforced; on
 * one without, the `${runId}:` prefix delete still takes it, which is the bound stated rather than
 * assumed away. Every adapter shipped here has listKeys.
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
      // they use now, and the bare legacy one still in journals written before it was scoped — a purge
      // that misses any of them leaves orphaned PII.
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

  total += await purgeOwnNamespace(journal, runId);
  // MEASURED, on both InMemoryJournal and SqliteStorage: `del('mem-appended:r-1')` also removed
  // `mem-appended:r-10`. These two keys are the one family here that ends where the runId ends —
  // every other delete in this function carries a trailing ':' and therefore cannot run past its own
  // run. "Full key = its own prefix" was true and beside the point; a prefix that is a PROPER prefix
  // of the neighbour's key is exactly the wfrun: boundary deleteExactKey was written for, and it was
  // never applied to the two keys sitting right next to it.
  total += await deleteExactKey(journal, runKeys.memAppended(runId));
  total += await deleteExactKey(journal, runKeys.memUserAppended(runId)); // write-ahead marker — same lifecycle
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
/**
 * KİŞİ-bazlı silme yüzeyi (GDPR/KVKK md.17): bir resource'un (kullanıcının) kalıcı kimlik ailelerini
 * süpürür — `xid:res:<rid>:` (kanallar-arası iş kimlikleri: düz-metin kimlik + tutar + ilk-koşum
 * referansı) ve `lesson:res:<rid>:` (HERMES kişisel dersleri). Denetçi K27-EK: bu yüzey, xid
 * ailesinin doğduğu diff'te 'yorumda reçete' olarak kalmıştı — çağrılabilir hali budur.
 * `sugg:` kayıtları resource-önekli DEĞİL (id-anahtarlı) — kişinin önerileri suggestions API'siyle
 * listelenip tek tek silinir; buradaki dönüş sayısına dahil değildir (belgeli sınır).
 */
/**
 * BATCH ailesinin silme yüzeyi (denetçi bloker — K27/EK-2): `batch:<batchId>:` tek süpürmede plan
 * (itemKeys = İŞ REFERANSLARI — PII-komşusu), report (itemKey+detail) ve TÜM item-run kayıtlarını
 * (args = tam item verisi) alır. SWEEP GÖRÜNMEZLİĞİ, belgeli: batch item-run'ları `:outcome`/`:status`
 * yazmaz → sweepRuns/listStaleRuns bu aileyi HİÇ görmez; retention'ı olan bir kurulum batch'leri
 * kendi takvimiyle bu fonksiyonla süpürmelidir (ör. rapor arşivlendikten sonra).
 */
export async function purgeBatch(journal: Journal, batchId: string): Promise<number> {
  if (batchId.includes(':')) throw new Error(`@gnldev/durable: purgeBatch('${batchId}') — batchId must not contain ':' (prefix boundary)`);
  const del = requireDelete(journal);
  return del(`batch:${batchId}:`);
}

/**
 * Erases a person's footprint.
 *
 * WHAT IT USED TO MISS, and why that mattered more than the missing families themselves: the three
 * prefixes below are the ones whose KEY names the person, so a prefix sweep finds them. Everything a
 * person actually DID lives under their RUNS — the suspended tool record with the raw args, the
 * frozen `:input` (prompt + resourceId), the approval decisions, the override trail, the incidents.
 * None of those keys mention the resourceId, so no prefix reaches them: after a deletion request the
 * person's orders, prompts and human answers all stayed in the journal.
 *
 * The tool to find them already existed — `listRunsPaged({ resourceId })` — and it reads the very
 * `:input` field this sweep needs. So the gap was never "we cannot"; it was "nobody wired it". That
 * is also why the birth paths matter here: a run that never recorded an owner (delegation, network,
 * workflow, batch, rollover — all fixed alongside this) is invisible to this enumeration, so the
 * deletion is silently partial. An erasure that quietly skips half a person is worse than one that
 * refuses: nobody goes looking for what the report said was gone.
 *
 * HONEST BOUNDS, stated because this is a legal surface:
 *  - `__audit__` is NOT swept per person — an audit trail that a data subject can erase is not an
 *    audit trail. It is swept by AGE (`sweepLog`), which is the retention answer for it.
 *  - Threads are swept only through the runs found here (their `:input.threadId`). A thread the
 *    person owns but never ran anything in is unreachable from this side — `purgeThread` is the
 *    surface for that, and the caller knows the thread ids.
 *  - Needs `listKeys`+`listRunsPaged`; an adapter without them keeps today's three-prefix behaviour
 *    rather than silently reporting a fuller erasure than it performed.
 */
export async function purgeResource(journal: Journal, resourceId: string): Promise<number> {
  const del = requireDelete(journal);
  // `suggstats:` carries the FULL lesson key (`suggstats:lesson:res:<rid>:<id>`) — the injection
  // counter's key itself names the person, so it must die with them (GDPR brief audit, K27 EK-3).
  // deletePrefix sweeps counter rows since P1.6, so this reaches HINCRBY-backed adapters too.
  let total =
    (await del(`xid:res:${resourceId}:`)) +
    (await del(`lesson:res:${resourceId}:`)) +
    (await del(`suggstats:lesson:res:${resourceId}:`));

  // The person's RUNS — enumerated by the same field the ownership gates read.
  // Structural read: `listRunsPaged` lives on JournalReader, and a Journal usually IS one (the
  // storage bridge delegates it straight through) — but a bare custom Journal may not be, and this
  // must degrade to the three-prefix behaviour rather than throw on a deletion request.
  const paged = (journal as unknown as {
    listRunsPaged?: (q: { resourceId: string; limit: number; cursor?: string }) => Promise<{ items: Array<{ runId: string; threadId?: string }>; nextCursor?: string }>;
  }).listRunsPaged;
  if (typeof paged !== 'function') return total;
  const threads = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await paged.call(journal, { resourceId, limit: 200, ...(cursor ? { cursor } : {}) })
      .catch(() => ({ items: [] as Array<{ runId: string; threadId?: string }>, nextCursor: undefined as string | undefined }));
    for (const r of page.items) {
      if (r.threadId) threads.add(r.threadId);
      total += await purgeRun(journal, r.runId);
    }
    cursor = page.nextCursor;
  } while (cursor);
  // Thread-scoped state the runs pointed at (memory, thread dedup window, semantic tombstones).
  for (const t of threads) total += await purgeThread(journal, t);
  return total;
}

export async function purgeThread(journal: Journal, threadId: string): Promise<number> {
  const del = requireDelete(journal);
  // FAZ-3: the thread owns its dedup state too — `idempotencyWindow: 'thread'` records and
  // thread-scoped duplicate markers both live under `xthr:<threadId>:` PRECISELY so this one sweep
  // reclaims them with the thread (the cross-run family's immortal-key problem does not recur here).
  return (await del(`mem:${threadId}:`)) + (await del(`xthr:${threadId}:`));
}

/**
 * GDPR/KVKK deletion runbook, as ONE function — permanently deletes EVERYTHING an organization owns
 * in the ROOT journal: because `withOrg` prefixes every key unconditionally, ONE
 * `deletePrefix('org:<id>:')` covers the org's runs + journals + memory + usage/budget
 * counters (`gnl_counters`/`ctr:` — swept since the P1.6 deletePrefix fix; this function is the reason
 * that fix was load-bearing) + materialized metrics + workflow registry records (`org:<id>:wfrun:*`) +
 * cross-run dedup keys (`org:<id>:xrun:*`).
 *
 * PREFIX-BOUNDARY SAFETY: the trailing ':' makes the sweep exact — org 'acme' can never catch org
 * 'acme2' (`org:acme2:` does not start with `org:acme:`). Callers MUST reject org ids containing ':'
 * (the studio org-delete route already does).
 *
 * NOT DELETED BY THIS FUNCTION, but no longer a gap: everything `@gnldev/queue` and `@gnldev/events`
 * write lives in the WorkStore (`gnl_work_log` / `gnl_work_kv`, `wl:` / `wk:` on redis), a different
 * port from the Journal this function sweeps. `purgeOrganizationWork(storage.work, orgId)` is the
 * matching surface — call BOTH, in either order, to erase an organization completely. They stay two
 * calls on purpose: a deployment can hold the two stores on different backends (that is what
 * `composite` is for), so one function cannot honestly promise to reach both.
 *
 * DELIBERATELY NOT DELETED (the honest rest of the runbook):
 * Root `__audit__` entries that carry this org as a PAYLOAD field: the audit trail is a root-level
 *    record with its own (usually legally-mandated) retention — sweep it on ITS schedule via
 *    `sweepLog(journal, '__audit__', ...)`, don't couple it to org deletion.
 * Orgless/shared-scope data: if the deployment ran this org's work OUTSIDE withOrg (no prefix),
 *    this function cannot attribute it — that is a deployment-model choice, not a sweep gap.
 * EE user records (auth-ee's own store) — studio's DELETE /organizations/:id removes members when
 *    `opts.users` is wired; call that surface (or the user store directly) alongside this.
 * (Covered, for the record: HERMES `sugg:`/`lesson:`/`suggstats:` families ARE swept by this
 *    function — withOrg prefixes them like every other key. The gap for them is per-PERSON deletion,
 *    documented on purgeThread.)
 */
/**
 * The WorkStore half of an organization's erasure — queue jobs, their markers, and the event log.
 *
 * `withOrg` prefixes every work namespace AND every work key, so one prefix sweep is the whole
 * footprint. Same boundary rule as `purgeOrganization`: the trailing ':' keeps org 'acme' from
 * catching 'acme2'.
 *
 * THROWS on a WorkStore without `deletePrefix` rather than returning 0. This function exists because
 * an erasure runbook promised something the framework could not do; answering "deleted nothing"
 * with a success would recreate exactly that problem in a quieter form.
 */
export async function purgeOrganizationWork(work: WorkStore, orgId: string): Promise<number> {
  if (orgId.includes(':')) throw new Error(`@gnldev/durable: purgeOrganizationWork('${orgId}') — org id must not contain ':' (it would break the org:<id>: prefix boundary)`);
  if (typeof work.deletePrefix !== 'function') {
    throw new Error(
      "@gnldev/durable: this WorkStore does not implement `deletePrefix`, so an organization's queue and event records cannot be erased through it (the first-party in-memory/sqlite/postgres/redis adapters all do). Sweep those tables directly, or the erasure is incomplete.",
    );
  }
  return work.deletePrefix(`org:${orgId}:`);
}

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
   * sweepable — the answer to "suspended runs accumulate forever" (retention deliberately protects
   * them; layers 2-3 raise the suspend volume, so an expiry arm stopped being optional). Uses the
   * SLOW scan (the indexed fast path cannot age suspended runs separately). Undefined = today's
   * behavior: suspended runs are never swept.
   */
  suspendedTtlMs?: number;
  /**
   * FAZ-4: write a `${runId}:swept` TOMBSTONE after purging each run. A late retry of that runId can
   * then be REFUSED under `tombstonePolicy: 'reject'` (the critical profile) instead of silently
   * re-running side effects whose dedup window died with the journal. LIFECYCLE, stated honestly:
   * Under 'reject' the tombstone is effectively PERMANENT: after the purge the run's only key is the
   * tombstone itself, which no sweep scan lists (it is invisible to the run readers) — removal only
   * happens on the 'ignore'+re-run+second-sweep chain. The safe direction, but know it. The REAL
   * contract is and remains: retention window >= client retry horizon.
   *
   * WHAT THE MARKER HOLDS (§10.3): the sweep instant, plus — if the run had declared one — the HASH
   * of its workKey and the KIND of its scope. Never the workKey text, and never the scope value. See
   * `tombstoneFor` for why a permanent record is the last place a business name may survive.
   */
  tombstones?: boolean;
  /** Testability: "now" (default Date.now()). */
  now?: number;
}

/** What a `${runId}:swept` marker holds. `at` is the sweep instant; the rest is package #2's addition. */
export interface RunTombstone {
  at: number;
  /** 16 hex of sha256 over the swept run's declared workKey — see `workKeyHash` for the pseudonym caveat. */
  workKeyHash?: string;
  /** Which kind of address that name lived in. The VALUE (a resourceId, an orgId) is not kept. */
  workScope?: WorkScopeKind;
}

/**
 * The marker a swept run leaves behind — READ BEFORE THE PURGE, because after it there is nothing
 * left to read.
 *
 * A tombstone is the one record that deliberately outlives an erasure (under
 * `tombstonePolicy: 'reject'` it is effectively permanent — see SweepOptions.tombstones), which makes
 * what goes into it a privacy decision rather than a debugging convenience. §10.3 settles it: the
 * HASH of the workKey, never the text. A workKey is a business name ('invoice-4471'), it is the kind
 * of string that names a person's affairs, and a deletion that keeps it forever in a marker nobody
 * enumerates is a deletion in name only.
 *
 * The hash is for DIAGNOSIS, not matching: nothing looks a run up by it, and it is deliberately not
 * `workDigest` (that one is an identity, with an agent and a scope hashed around it — a matching key
 * in a place that must not enable matching). The scope KIND rides along for the same diagnostic
 * reason and its VALUE does not: 'resource' tells an operator what kind of job died, the resourceId
 * would name whose.
 *
 * The other half of the honesty is elsewhere: the `run_swept` refusal reflects the caller's workKey
 * from the REQUEST, not from here (§10.3, packages #3/#5). The caller already knows their own name —
 * the error can still speak while the deletion stays deleted.
 */
async function tombstoneFor(journal: Journal, runId: string, at: number): Promise<RunTombstone> {
  const tomb: RunTombstone = { at };
  // Best-effort, like every other read on the deletion path: a journal that cannot answer must not
  // stop the sweep from finishing (a run half-purged is worse than a marker missing a hash).
  const frozen = await journal.get<{ workKey?: unknown; workScope?: { kind?: unknown } }>(runKeys.input(runId)).catch(() => undefined);
  if (typeof frozen?.workKey === 'string' && frozen.workKey.length > 0) tomb.workKeyHash = workKeyHash(frozen.workKey);
  const kind = frozen?.workScope?.kind;
  if (kind === 'resource' || kind === 'org') tomb.workScope = kind;
  return tomb;
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
  // ids directly without pulling ALL of every run's entries (the old O(entire-DB) scan). The result
  // contract is the same; keptSuspended/keptNoTs are reported as 0 by definition on this path
  // (SQL already filtered).
  // FAZ-4: suspendedTtlMs needs the slow scan — the indexed query cannot age suspended runs on a
  // SEPARATE cutoff (it either includes them at the general cutoff or not at all).
  if (typeof (journal as Journal).listStaleRuns === 'function' && opts.suspendedTtlMs === undefined) {
    const cutoff = now - opts.olderThanMs;
    const stale = await (journal as Journal).listStaleRuns!(cutoff, { includeSuspended: !keepSuspended });
    const fast: SweepResult = { scanned: stale.length, purged: [], keptSuspended: 0, keptNoTs: 0, deletedEntries: 0 };
    for (const runId of stale) {
      // BEFORE the purge — `tombstoneFor` reads the run's own `:input`, which the next line deletes.
      const tomb = opts.tombstones ? await tombstoneFor(journal, runId, now) : undefined;
      fast.deletedEntries += await purgeRun(journal, runId);
      if (tomb) await journal.put(`${runId}:swept`, tomb);
      fast.purged.push(runId);
    }
    return fast;
  }

  // SAYFALAMA — `listRuns()` argümansız çağrıldığında üç adaptörün üçünde de varsayılan `limit=50`.
  // Yani süpürme, journal'da kaç koşum olursa olsun EN FAZLA 50 tanesine bakıyordu ve bunu hiçbir
  // yerde söylemiyordu: 51'inci koşumdan sonrası hiç süpürülmüyor, sessizce büyüyordu.
  // Bugüne kadar gizli kalmasının sebebi, hızlı yolun (`suspendedTtlMs === undefined`) bu bloğa hiç
  // girmemesiydi — yani tam da TTL'i açan, süpürmeye en çok ihtiyaç duyan kurulum tavana çarpıyordu.
  const paged = (journal as unknown as {
    listRunsPaged?: (q: { limit: number; cursor?: string }) => Promise<{ items: { runId: string }[]; nextCursor?: string }>;
  }).listRunsPaged;
  const runs: { runId: string }[] = [];
  if (typeof paged === 'function') {
    let cursor: string | undefined;
    do {
      const page = await paged.call(journal, { limit: 500, ...(cursor ? { cursor } : {}) });
      runs.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
  } else {
    // Sayfalamayan bir adaptör: eski davranış aynen korunur (yaptığından fazlasını iddia etmemek).
    const listed = await journal.listRuns();
    runs.push(...(Array.isArray(listed) ? listed : (listed as { items: { runId: string }[] }).items));
  }
  const result: SweepResult = { scanned: 0, purged: [], keptSuspended: 0, keptNoTs: 0, deletedEntries: 0 };

  for (const r of runs) {
    result.scanned++;
    const entries = await journal.readRun(r.runId);
    const summary = summarizeRun(r.runId, entries);
    const stamps = entries.map((e) => e.ts).filter((t): t is number => t != null);
    let lastActivity = stamps.length ? Math.max(...stamps) : undefined;
    // A NAME TAG IS ALSO A RECORD, and it used to be an immortal one. A workflow/batch/network run
    // writes only an identity record to `<runId>:input` (claimIdentityInput) — enough for listRuns to
    // report the run, but `:input` is invisible to parseJournalKey so readRun hands back NOTHING.
    // Age therefore could not be measured, keptNoTs preserved it "on the safe side", and the safe
    // side turned out to be forever: the one record class that carries a subject's name (resourceId,
    // threadId, the workflow's own name) sat outside every retention window.
    // Narrow on purpose — only a record that NAMES ITSELF as identity-only (the same predicate the
    // agent door refuses on, run.ts's identityOnlyInput) is dated this way. An entry-less run with a
    // genuine frozen input is still undateable and still kept: `at` describes when the input was
    // frozen, and for a real run that is a start time, not a last activity.
    if (lastActivity === undefined) {
      const frozen = await journal.get<FrozenInputLike>(runKeys.input(r.runId));
      if (identityOnlyInput(frozen as never) && typeof frozen?.at === 'number') lastActivity = frozen.at;
    }
    if (keepSuspended && summary.status === 'suspended') {
      // FAZ-4 expiry arm: a suspended run past suspendedTtlMs stops being protected — nobody is
      // coming to approve it, and layers 2-3 made suspends routine enough that "forever" leaks.
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
      const tomb = opts.tombstones ? await tombstoneFor(journal, r.runId, now) : undefined; // BEFORE the purge
      result.deletedEntries += await purgeRun(journal, r.runId);
      if (tomb) await journal.put(`${r.runId}:swept`, tomb);
      result.purged.push(r.runId);
    }
  }
  return result;
}

// ── Journal-based append-log + BasicMemory sweeping (the core-hardening review) ─────────────
// Run-focused retention (sweepRuns above) does NOT see durable-log namespaces (`${ns}:${id}`,
// e.g. studio `__audit__`/`__alert__`) or BasicMemory threads (`mem:<threadId>:*`) — these grow
// unbounded in a long-lived deployment. The two helpers below close that gap.
// Same safety philosophy as sweepRuns: a record whose age can't be measured is NOT deleted, and
// is counted in the report.

export interface LogSweepOptions {
  /** Log entries older than this (ms) are deleted. Age = the entry's `at` field (written by appendLog). */
  olderThanMs: number;
  /**
   * Consume marker key(s) belonging to the deleted entry. HONEST NOTE: in journal-based durable-log,
   * the marker schema is NOT FIXED — `consumeOnce(journal, marker)` leaves the marker key entirely up
   * to the caller (qdone/evtack-like schemas live in the WorkStore layer, see @gnldev/queue, @gnldev/events).
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
 * appendLog) is older than the threshold. Requires listKeys + deletePrefix (requireDelete pattern).
 * Safe side: entries without/with malformed `at` are not deleted (counted in keptNoTs).
 */
export async function sweepLog(journal: Journal, ns: string, opts: LogSweepOptions): Promise<LogSweepResult> {
  const del = requireDelete(journal);
  const list = requireListKeys(journal);
  const now = opts.now ?? Date.now();
  const prefix = `${ns}:`;
  // Ordered scan: the journal has no single-key `delete`, deletion is done via deletePrefix(fullKey).
  // A key can be a PREFIX of another key (custom ids, e.g. `approval:<runId>:<tc>` — one can be a
  // prefix of another). In lexicographic order, a key's extensions come right after it → if one of
  // the extensions is NOT going to be deleted, deletePrefix on the short key is unsafe, so that entry
  // is skipped.
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
    // deletePrefix(fullKey): extension-neighbors are also expired → deleting them together is
    // correct behavior; when the loop reaches them, del returns 0 → deleted isn't double-counted.
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
// threadId itself may contain ':' → the extraction is done via known-suffix matching, NOT split.
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
 * permanently deleted via purgeThread (`mem:<threadId>:` prefix — messages + working together).
 * Safe side: threads whose ts can't be read (untimestamped messages or no messages at all) are NOT deleted.
 * Requires listKeys + deletePrefix (requireDelete pattern).
 */
export async function sweepThreads(journal: Journal, opts: ThreadSweepOptions): Promise<ThreadSweepResult> {
  requireDelete(journal);
  const list = requireListKeys(journal);
  const now = opts.now ?? Date.now();

  // Extract the thread set from keys under `mem:`. Keys with unrecognized suffixes don't contribute
  // a threadId to the set (safe: only the recognized schema is swept), but if they belong to a
  // recognized thread they still go with it via purgeThread's prefix delete.
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
// sweepRuns/sweepLog/sweepThreads/compact were all called MANUALLY (from Studio or a script) —
// none of them were triggered automatically. The helper below sets up a periodic sweep round
// using @gnldev/durable/polling's createPollLoop (the SAME scheduler core SHARED with queue/events/scheduler).
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
   * for multiple namespaces — e.g. `__audit__` + `__alert__` can be swept in the same round).
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
 * intervals. Uses createPollLoop with backoff DISABLED — retention should have a fixed cadence;
 * postponing the next round (backoff growth) just because "nothing was deleted this round" would
 * go against retention's purpose (we don't want a delayed scan of data accumulated after a long
 * quiet period). It does NOT start anything AUTOMATICALLY — no scan happens until the returned
 * object's `start()` is called.
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
