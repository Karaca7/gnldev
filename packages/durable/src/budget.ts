// Data-driven budget/quota: limits live in the journal (editable from Studio, the policy.ts pattern),
// Hosts (@gnldev/server) read them LIVE via checkBudget on the write path and return 402 on overrun → a
// Limit change does not require a deploy. Usage is computed post-hoc/exactly from journaled usage (cost.ts).
import type { Journal, JournalReader, RunSummary } from './journal.js';
import { claim } from './journal.js';
import { getRunCost, type RunCost } from './cost.js';
import { withOrg } from './organization.js';

/** Journal key prefix for budget documents: `__budget__:<orgId>` + `__budget__:default`. */
export const BUDGET_PRE = '__budget__:';

/**
 * 1.1: Per-organization INCREMENTAL usage counter — a running-total document. Organization isolation
 * Is INHERITED from journal SCOPING (just like the run/model/tool keys): in the root journal it lives
 * Directly as `__usage__`, in the organization view (withOrg) it physically lives as
 * `org:<orgId>:__usage__` → there's NO NEED to add orgId to the key text,
 * It reads/writes the organization-view already set up by `getOrgUsage` (recordRunUsage is also
 * Called from that same view — see run.ts).
 */
export const USAGE_KEY = '__usage__';

/**
 * H8a combined counter READ: atomic counters (written via incrBy) + the legacy USAGE_KEY value.
 * Migration story: the accumulation from the old deployment stays in legacy, new increments go to
 * Counters; total = the sum of the two (clamped to 0 against negative drift). If neither exists, undefined.
 */
async function readUsageCounter(view: Partial<Journal>): Promise<OrganizationUsage | undefined> {
  const legacy = typeof view.get === 'function' ? await view.get<OrganizationUsage>(USAGE_KEY) : undefined;
  const ctr = typeof view.getCounters === 'function' ? await view.getCounters(USAGE_KEY) : undefined;
  if (!legacy && !ctr) return undefined;
  const sum = (a?: number, b?: number) => Math.max(0, (a ?? 0) + (b ?? 0));
  return {
    runs: sum(legacy?.runs, ctr?.runs),
    tokens: sum(legacy?.tokens, ctr?.tokens),
    costUsd: sum(legacy?.costUsd, ctr?.costUsd),
  };
}

/**
 * H8a combined counter WRITE (delta): if `incrBy` exists it's ENGINE-INTERNAL ATOMIC (lost updates are
 * Impossible, no hot-row read-modify-write); otherwise/on failure it falls back to legacy get→put
 * (single-process safe).
 */
async function addUsage(journal: Partial<Journal>, delta: OrganizationUsage): Promise<void> {
  if (typeof journal.incrBy === 'function') {
    try {
      await journal.incrBy(USAGE_KEY, { runs: delta.runs, tokens: delta.tokens, costUsd: delta.costUsd });
      return;
    } catch {
      // Custom client (e.g. RedisLike without hincrbyfloat) → legacy path
    }
  }
  if (typeof journal.get !== 'function' || typeof journal.put !== 'function') return;
  // (silent under-enforcement): this non-atomic get→put loses concurrent increments under
  // Multi-worker contention (two workers read the same total, both write back → one increment lost, in the
  // Budget-UNDER-count direction). Say so ONCE (same pattern as limits.ts's warnCasFallback / journal.ts's
  // ClaimFallbackWarned) so the degradation is visible instead of discovered when a cap silently overruns.
  warnUsageCasFallback(journal);
  const current = (await journal.get<OrganizationUsage>(USAGE_KEY)) ?? { runs: 0, tokens: 0, costUsd: 0 };
  await journal.put(USAGE_KEY, {
    runs: Math.max(0, current.runs + delta.runs),
    tokens: Math.max(0, current.tokens + delta.tokens),
    costUsd: Math.max(0, current.costUsd + delta.costUsd),
  });
}

// Warn ONCE per store when `addUsage` falls back to the non-atomic get→put path (no `incrBy`).
const usageCasFallbackWarned = new WeakSet<object>();
function warnUsageCasFallback(journal: object): void {
  if (usageCasFallbackWarned.has(journal)) return;
  usageCasFallbackWarned.add(journal);
  console.warn(
    '@gnldev/durable: this journal does not implement `incrBy` — the org usage counter fell back to get→put. ' +
      'Safe in single-process usage; in multi-worker/distributed environments concurrent completions can LOSE ' +
      'increments (usage UNDER-counts → the budget can silently OVER-run). Implement `incrBy` (all first-party ' +
      'adapters do — see the parity matrix in journal.ts).',
  );
}

/**
 * The idempotency marker that flags a run as having been added to the counter. Written with the
 * `${runId}:` prefix → is AUTOMATICALLY caught by `purgeRun`'s `${runId}:*` deletion (the marker
 * Goes away too when the run is deleted).
 */
export function usageCountedKey(runId: string): string {
  return `${runId}:usage-counted`;
}

export interface BudgetLimit {
  usdLimit?: number;
  tokenLimit?: number;
}

export interface OrganizationUsage {
  runs: number;
  tokens: number;
  costUsd: number;
}

export interface BudgetCheck {
  /** Limit is defined and usage exceeds it → true (host should return 402). */
  exceeded: boolean;
  usage: OrganizationUsage;
  /** Effective limit (journal > fallback); if there's no limit at all, undefined → exceeded is always false. */
  limit?: BudgetLimit;
}

/**
 * Usage cost cache (optional, SAFETY NET): a completed run's cost doesn't change (journal is
 * Append-only), so it's memoized under the `<orgId>:<runId>` key. As of 1.1 this cache is used ONLY on
 * The FULL-SCAN paths (lazy backfill when there's no counter) — it never enters the hot path while a
 * Counter exists. Suspended runs are ALWAYS recomputed (not yet final).
 */
export type UsageCostCache = Map<string, RunCost>;

/**
 * 1.1 safety net: `UsageCostCache` can also be used as an unbounded `Map` (backward compatible), but
 * Hosts that want a simple LRU cap so it doesn't grow unbounded in multi-organization/multi-run setups
 * Can prefer this instead — the oldest (first-added) entry is evicted once the limit is full.
 */
export class BoundedUsageCostCache extends Map<string, RunCost> {
  constructor(private readonly maxEntries = 5000) {
    super();
  }
  override set(key: string, value: RunCost): this {
    if (!this.has(key) && this.size >= this.maxEntries) {
      const oldest = this.keys().next().value;
      if (oldest !== undefined) this.delete(oldest);
    }
    return super.set(key, value);
  }
}

/** `createBoundedUsageCache(1000)` → a bounded `UsageCostCache` (see `BoundedUsageCostCache`). */
export function createBoundedUsageCache(maxEntries = 5000): UsageCostCache {
  return new BoundedUsageCostCache(maxEntries);
}

type RunLike = Pick<RunSummary, 'runId' | 'status'>;

/**
 * `listRuns()` may return the old contract (an array) OR a paginated one (`{items, nextCursor}`); if
 * Paginated, it walks ALL pages (PHASE 1.1 finding: "don't count only the first page on a paginated
 * Reader" — `@gnldev/server` already bridges this on its own side via `toJournal`, but `getOrgUsage`
 * Should be correct on its own even if the host doesn't provide that — e.g. an embedding that hands
 * Back `storage.runs` directly).
 */
async function listAllRuns(view: Pick<JournalReader, 'listRuns'>): Promise<RunLike[]> {
  const first: unknown = await view.listRuns();
  if (Array.isArray(first)) return first as RunLike[];
  let page = first as { items?: RunLike[]; nextCursor?: string } | undefined;
  const items: RunLike[] = [...(page?.items ?? [])];
  let cursor = page?.nextCursor;
  const listRunsFn = view.listRuns as unknown as (q?: { cursor?: string }) => Promise<unknown>;
  while (cursor) {
    const next: unknown = await listRunsFn({ cursor });
    page = Array.isArray(next) ? { items: next as RunLike[], nextCursor: undefined } : (next as { items?: RunLike[]; nextCursor?: string });
    items.push(...(page?.items ?? []));
    cursor = page?.nextCursor;
  }
  return items;
}

/**
 * Total usage for an organization (or the orgless root scope).
 * 1.1: reads the incremental counter (`__usage__`) FIRST — if present, no FULL SCAN happens (O(1)).
 * The counter holds only the total of COMPLETED runs (`recordRunUsage` is only called when a run
 * Finishes); the LIVE usage of still-suspended runs is computed separately (only for them) and added
 * To the total.
 * If the counter is MISSING (old data / first use): it computes via the existing full scan AND does a
 * Lazy backfill — it writes + marks the counter ONLY for COMPLETED runs (suspended ones are not
 * Marked → when they finish, `recordRunUsage` adds them the normal way, no double counting).
 *
 * AUDIT (scale finding, budget.ts:~159-171): even WHEN the counter exists, `listAllRuns` (a full page
 * Scan) was being done on every call just to find suspended-run cost — in an organization with 100k
 * Runs of history that's O(N) per run start. The `strictSuspendedCost` parameter separates this out:
 * `true` (DEFAULT, this function's old/only behavior — backward compatible): even when the counter
 *     Exists, a full scan is done to find suspended runs, their live costs are added to the total.
 * Code calling `getOrgUsage` directly (e.g. Studio/reporting) gets the same result UNCHANGED.
 * `false`: when the counter exists, the full scan is SKIPPED ENTIRELY — the returned usage is
 * ONLY the total of COMPLETED runs (from the counter); the not-yet-finished cost of suspended runs
 *     Is NOT included (a documented approximation — once finished, `recordRunUsage` adds it the normal
 *     Way, delayed but exact). `checkBudget`/`assertBudget` use this as the default (see there).
 */
export async function getOrgUsage(
  reader: JournalReader & Partial<Journal>,
  orgId?: string,
  costCache?: UsageCostCache,
  strictSuspendedCost = true,
): Promise<OrganizationUsage> {
  const view = (orgId ? withOrg(reader as unknown as Journal, orgId) : reader) as unknown as JournalReader & Partial<Journal>;
  if (typeof view.listRuns !== 'function') return { runs: 0, tokens: 0, costUsd: 0 };

  const counted = await readUsageCounter(view); // H8a: sum of counters + legacy
  if (counted) {
    if (!strictSuspendedCost) {
      // Fast path: the counter ALONE is considered sufficient → listAllRuns is NEVER entered (O(1)).
      // The live cost of suspended runs is IGNORED this round (recordRunUsage adds it once finished).
      return { runs: counted.runs, tokens: counted.tokens, costUsd: counted.costUsd };
    }
    const runs = await listAllRuns(view);
    let extraTokens = 0;
    let extraCostUsd = 0;
    for (const r of runs) {
      if (r.status === 'completed') continue; // already included in the counter
      const rc = await getRunCost(view, r.runId); // suspended: always live (not final)
      extraTokens += rc.totalTokens;
      extraCostUsd += rc.costUsd;
    }
    return { runs: runs.length, tokens: counted.tokens + extraTokens, costUsd: counted.costUsd + extraCostUsd };
  }

  // No counter → full-scan fallback (old behavior, same result).
  const runs = await listAllRuns(view);
  let tokens = 0;
  let costUsd = 0;
  let backfillRuns = 0;
  let backfillTokens = 0;
  let backfillCostUsd = 0;
  for (const r of runs) {
    const cacheKey = `${orgId ?? ''}:${r.runId}`;
    const completed = r.status === 'completed';
    let rc = completed ? costCache?.get(cacheKey) : undefined;
    if (!rc) {
      rc = await getRunCost(view, r.runId);
      if (completed) costCache?.set(cacheKey, rc); // only final runs are cached
    }
    tokens += rc.totalTokens;
    costUsd += rc.costUsd;
    if (completed) {
      backfillRuns++;
      backfillTokens += rc.totalTokens;
      backfillCostUsd += rc.costUsd;
    }
  }
  // Lazy backfill: populate the counter + mark only completed runs (best-effort; skip if view isn't writable).
  if (typeof view.get === 'function' && typeof view.put === 'function') {
    for (const r of runs) {
      if (r.status !== 'completed') continue;
      const marker = usageCountedKey(r.runId);
      if ((await view.get(marker)) === undefined) await view.put(marker, true);
    }
    await view.put(USAGE_KEY, { runs: backfillRuns, tokens: backfillTokens, costUsd: backfillCostUsd });
  }
  return { runs: runs.length, tokens, costUsd };
}

/**
 * 1.1: ADD the cost to the counter once a run COMPLETES (no interrupts). Called from the run-finish
 * Path of `runDurable`/`streamDurable` (same pattern as memAppended). Exactly-once: if the
 * `${runId}:usage-counted` marker EXISTS, it's a no-op (resume/replay doesn't double count). The
 * Marker is placed AFTER the incremented total is WRITTEN — if a crash happens BETWEEN the put and
 * The marker, there is a narrow window where the increment could be lost; this is the SAME accepted
 * Boundary as the existing memory-append idempotency (`runKeys.memAppended`).
 * `journal` is used AS GIVEN (root OR scoped via `withOrg`) → there's no need to separately know the
 * OrgId, isolation is inherited from journal scoping (`getOrgUsage` reads the same scoping).
 * Best-effort: silently skipped if the journal doesn't support `get`/`put`/`readRun` (the counter is optional).
 */
export async function recordRunUsage(journal: Journal & Partial<JournalReader>, runId: string): Promise<void> {
  if (typeof journal.get !== 'function' || typeof journal.put !== 'function') return;
  if (typeof journal.readRun !== 'function') return;
  const marker = usageCountedKey(runId);
  // H8a ordering fix: MARKER FIRST (atomic claim) — the old order (write counter → write marker) would
  // DOUBLE COUNT on retry if it crashed BETWEEN the two writes. Now: whoever doesn't win the marker
  // Never counts; a crash AFTER the marker = an undercount (the safe side for budget — never overbills).
  if (!(await claim(journal as Journal, marker, true))) return; // already counted / lost the race
  const cost = await getRunCost(journal as JournalReader, runId);
  await addUsage(journal, { runs: 1, tokens: cost.totalTokens, costUsd: cost.costUsd });
}

/**
 * Read the budget limit from the journal (from the ROOT journal — the budget is managed by the
 * Operator, it cannot be written/read from within the organization view): `__budget__:<id>` first,
 * `__budget__:default` if absent.
 */
export async function readBudget(journal: Partial<Journal>, orgId?: string): Promise<BudgetLimit | undefined> {
  if (typeof journal.get !== 'function') return undefined;
  const own = orgId ? await journal.get<BudgetLimit>(BUDGET_PRE + orgId) : undefined;
  if (own && (own.usdLimit != null || own.tokenLimit != null)) return own;
  const def = await journal.get<BudgetLimit>(BUDGET_PRE + 'default');
  return def && (def.usdLimit != null || def.tokenLimit != null) ? def : undefined;
}

/** Plain overrun check. */
export function isBudgetExceeded(usage: OrganizationUsage, limit?: BudgetLimit): boolean {
  if (!limit) return false;
  return (limit.usdLimit != null && usage.costUsd > limit.usdLimit)
    || (limit.tokenLimit != null && usage.tokens > limit.tokenLimit);
}

/**
 * Write-path budget gate: effective limit = journal (`__budget__:*`) > `fallback` (host config).
 * If there's no limit, usage is NOT COMPUTED (a zero-cost early exit) → a budget-less setup isn't slowed down.
 *
 * (concurrent/in-flight bypass): the `__usage__` counter accrues ONLY on completion
 * (`recordRunUsage`), so gating against the counter alone lets N concurrent runs each pass the check
 * (completed total = $0) and collectively blow past the cap before any completes. The gate must see
 * The LIVE cost of still-suspended/in-flight runs — so `strictSuspendedCost` here now DEFAULTS to
 * `true`: when the counter exists it is topped up with the live cost of every non-completed run (via
 * `getOrgUsage`'s scan). This is the ONLY-STRICTER / fail-safe direction for a budget (it can reject
 * Earlier, never later).
 *
 * PERF TRADE-OFF (was the reason for the old `false` default): this scans runs on the write path —
 * In an org with a large run history that is O(N) per run start (the previous fast path was O(1) off
 * The counter). A host that has measured this and knowingly accepts the concurrent-overrun window can
 * Opt back into the O(1) fast path with `strictSuspendedCost: false` (e.g.
 * `assertBudget(reader, { ..., strictSuspendedCost: false })`); it then enforces ONLY against the
 * Total of COMPLETED runs and the live cost of suspended runs is excluded until they finish.
 */
export async function checkBudget(
  reader: JournalReader & Partial<Journal>,
  orgId?: string,
  fallback?: BudgetLimit,
  costCache?: UsageCostCache,
  strictSuspendedCost = true,
): Promise<BudgetCheck> {
  const limit = (await readBudget(reader, orgId)) ?? fallback;
  if (!limit || (limit.usdLimit == null && limit.tokenLimit == null)) {
    return { exceeded: false, usage: { runs: 0, tokens: 0, costUsd: 0 } };
  }
  // C5: a budget IS configured — if it can't be enforced (no `listRuns`), say so loudly (once) instead of
  // Silently returning `exceeded: false` off zero usage.
  if (!budgetsEnforceable(reader)) warnBudgetUnenforceable(reader);
  const usage = await getOrgUsage(reader, orgId, costCache, strictSuspendedCost);
  return { exceeded: isBudgetExceeded(usage, limit), usage, limit };
}

/** Can the budget be enforced? If the journal can't list runs, usage can't be computed → limits fail open. */
export function budgetsEnforceable(reader: Partial<JournalReader>): boolean {
  return typeof reader.listRuns === 'function';
}

// (budget fails OPEN when `listRuns` is missing): `getOrgUsage` returns zero usage on a reader
// Without `listRuns`, so `isBudgetExceeded` is always false — a configured budget silently never fires.
// Mirror C4's loud one-time warn (WeakSet like journal.ts's claimFallbackWarned): a fail-open this
// Consequential must be SAID once, not discovered when the bill arrives. Warn only — no throw, no behavior change.
const budgetFailOpenWarned = new WeakSet<object>();
function warnBudgetUnenforceable(reader: object): void {
  if (budgetFailOpenWarned.has(reader)) return;
  budgetFailOpenWarned.add(reader);
  console.warn(
    '@gnldev/durable: a budget/quota limit is configured but this journal does not implement `listRuns` — ' +
      'usage CANNOT be computed, so the budget is SILENTLY NOT ENFORCED (never exceeded). Use a journal that ' +
      'implements `listRuns` (all first-party adapters do), or remove the budget to avoid a false sense of a cap.',
  );
}

/** Thrown when the budget/quota is exceeded → HTTP hosts turn it into 402, other paths
 *  (queue/scheduler/a2a) convert it into their own error flow. `check` carries the usage+limit at the time of overrun. */
export class BudgetExceededError extends Error {
  constructor(readonly check: BudgetCheck) {
    super('budget/quota exceeded — execution rejected');
    this.name = 'BudgetExceededError';
  }
}

/**
 * Shareable enforcement primitive: called BEFORE a run starts; throws BudgetExceededError on overrun,
 * Otherwise returns a BudgetCheck. @gnldev/server's write path uses it in HTTP; **non-HTTP paths
 * (@gnldev/queue worker, @gnldev/scheduler cron, @gnldev/a2a, direct runDurable/createGnl embedders) do NOT
 * AUTOMATICALLY ENFORCE the quota** — if quota enforcement is needed, they must call this function
 * Themselves before the run (example: `await assertBudget(reader, { orgId, fallback })` inside the
 * Worker handler). If there's no limit it exits at zero cost.
 * By default (audit C2) the live cost of suspended/in-flight runs IS included in the budget (via a
 * Scan) so concurrent runs can't collectively overrun the cap; pass `strictSuspendedCost: false` to
 * Opt back into the O(1) counter-only fast path (completed cost only) — see `checkBudget`.
 */
export async function assertBudget(
  reader: JournalReader & Partial<Journal>,
  opts: { orgId?: string; fallback?: BudgetLimit; costCache?: UsageCostCache; strictSuspendedCost?: boolean } = {},
): Promise<BudgetCheck> {
  const check = await checkBudget(reader, opts.orgId, opts.fallback, opts.costCache, opts.strictSuspendedCost);
  if (check.exceeded) throw new BudgetExceededError(check);
  return check;
}
