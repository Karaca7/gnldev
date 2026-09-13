// P1.6 materialized metrics layer — Studio's `/metrics` and `/metrics/runs`
// used to re-read EVERY run's full journal on EVERY request (getRunCost does a `readRun` per run) —
// O(runs × entries) per page view, which collapses at a few thousand runs. This file adds INCREMENTAL
// counters written ONCE at run completion, riding the EXISTING optional Journal primitives (incrBy/
// getCounters/putIfAbsent/put/deletePrefix — see the parity matrix in journal.ts) so every first-party
// backend (in-memory/sqlite/postgres/redis) gets it for free — NO new dependency, NO time-series DB.
// Same shape as budget.ts's `__usage__` counter (H8a) and its get→put/warn-once fallback story, just
// bucketed per-day/per-agent instead of a single running total, plus a per-run "fast row" for the
// runs table (avoids readRun+getRunCost for every already-finalized run).
import type { Journal, JournalBatch, JournalReader } from './journal.js';
import { summarizeRun, runKeys, listRunsArray } from './journal.js';
import { getRunCost } from './cost.js';
import { METRICS_SHARDS, shardSuffix, sumShards } from './counter-shard.js';

/**
 * P1.6b: money is accumulated as INTEGER micro-USD (`costUsdMicros = round(usd × 1e6)`) — float
 * counters (SQLite REAL / PG DOUBLE / Redis HINCRBYFLOAT) drift over millions of increments; integers
 * don't. `readMetricsSummary` derives a `costUsd` float back out for consumers (and still folds in a
 * legacy `costUsd` float field if counters predate this switch, so no rebuild is forced).
 */
const USD_MICROS = 1_000_000;

// ── Key schema ──────────────────────────────────────────────────────────
// Three DISTINCT prefixes (deliberately not nested under one another) so `rebuildMetrics` can wipe
// each independently and precisely: the counters (`__metrics__:*`), the per-run fast-path row
// (`__metrics__run:*`), and the exactly-once claim marker (`__metrics__done:*`). Note `__metrics__run:`
// and `__metrics__done:` have NO colon after `__metrics__` — this keeps them OUTSIDE the
// `__metrics__:` counter prefix on purpose (a `deletePrefix('__metrics__:')` must not also nuke the
// claim markers/run rows, since rebuildMetrics deletes each prefix as an explicit, separate step).

/** All-time totals. */
export const METRICS_ALL_KEY = '__metrics__:all';
/** Prefix covering every counter key (`all` + every `d:*` + every `agent:*:d:*`) — used by `rebuildMetrics`. */
export const METRICS_COUNTERS_PRE = '__metrics__:';
/** Prefix for the per-run fast-path row (`__metrics__run:<runId>`). */
export const METRICS_RUN_PRE = '__metrics__run:';
/** Prefix for the exactly-once claim marker (`__metrics__done:<runId>`). */
export const METRICS_DONE_PRE = '__metrics__done:';

/** Per-UTC-day totals key: `__metrics__:d:<YYYY-MM-DD>`. */
export function metricsDayKey(day: string): string {
  return `${METRICS_COUNTERS_PRE}d:${day}`;
}

/**
 * Per-agent per-day totals key: `__metrics__:agent:<agentName>:d:<YYYY-MM-DD>`. `agentName` is
 * sanitized (':' → '_') so it can never fabricate a fake key boundary and stays trivially parseable —
 * same defensive posture as `assertNoColonInToolName` in journal.ts, but sanitize-not-throw (an agent
 * name is caller-supplied display text, not a protocol identifier — throwing here would turn a cosmetic
 * name choice into a run-breaking error on the best-effort metrics path).
 */
export function metricsAgentDayKey(agentName: string, day: string): string {
  const safe = agentName.replace(/:/g, '_');
  return `${METRICS_COUNTERS_PRE}agent:${safe}:d:${day}`;
}

/**
 * Reads ONE logical counter: the sum of its shards plus the unsuffixed key.
 *
 * `METRICS_ALL_KEY` / `metricsDayKey` / `metricsAgentDayKey` name a LOGICAL counter. With sharding on
 * (the default, see counter-shard.ts) its value is spread across several physical rows, so a bare
 * `getCounters(key)` answers for ONE shard and reads as data loss. This is the supported way to read a
 * single bucket — `readMetricsSummary` is the batched form for the dashboard, and there was no
 * equivalent for `metricsAgentDayKey` at all before sharding made the gap visible.
 *
 * Returns `undefined` when no shard holds data, exactly as an unsharded miss did.
 */
export function readCounter(journal: Journal, key: string): Promise<Record<string, number> | undefined> {
  if (typeof journal.getCounters !== 'function') return Promise.resolve(undefined);
  return sumShards((k) => journal.getCounters!(k), key, METRICS_SHARDS);
}

/** Fast-path per-run row key: `__metrics__run:<runId>`. */
export function metricsRunKey(runId: string): string {
  return `${METRICS_RUN_PRE}${runId}`;
}

/** Exactly-once claim marker key: `__metrics__done:<runId>`. */
export function metricsDoneKey(runId: string): string {
  return `${METRICS_DONE_PRE}${runId}`;
}

/**
 * P2-skor prefix for `recordRunScores`'s OWN exactly-once claim marker —
 * deliberately SEPARATE from `METRICS_DONE_PRE` (base run metrics). Scores are recorded from
 * registry.ts's C4 block, AFTER `recordRunMetrics` already ran from run.ts's completion choke point
 * (see the recordRunScores JSDoc) — two independent claims let the base counters land even when a run
 * has no scorers (or is sampled out), and let a future re-score attempt be reasoned about on its own
 * exactly-once marker without touching the base-metrics claim at all. Outside `METRICS_COUNTERS_PRE`
 * on purpose (same non-collision reasoning as `METRICS_DONE_PRE` above): `deletePrefix('__metrics__:')`
 * must not also nuke this marker.
 */
export const METRICS_SCORES_DONE_PRE = '__metrics__scores:';

/** Exactly-once claim marker key for `recordRunScores`: `__metrics__scores:<runId>`. */
export function metricsScoresDoneKey(runId: string): string {
  return `${METRICS_SCORES_DONE_PRE}${runId}`;
}

/** UTC day bucket (`YYYY-MM-DD`) for a given epoch-ms timestamp. */
function dayKeyFor(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Exactly one duration-histogram field per run — mirrors common latency-bucket dashboards without a new dependency. */
function durationBucketField(durationMs: number): 'durLt1s' | 'durLt5s' | 'durLt15s' | 'durLt60s' | 'durGte60s' {
  if (durationMs < 1_000) return 'durLt1s';
  if (durationMs < 5_000) return 'durLt5s';
  if (durationMs < 15_000) return 'durLt15s';
  if (durationMs < 60_000) return 'durLt60s';
  return 'durGte60s';
}

/**
 * P2-skor: score is accumulated as INTEGER milli-score (`round(score * 1000)`) — same float-drift
 * rationale as `costUsdMicros` above (see USD_MICROS). `readMetricsSummary` derives the float `avg`
 * back out per scorer.
 */
const SCORE_MILLI = 1_000;

/** Exactly one score-histogram bucket per (run, scorer) — mirrors `durationBucketField`'s shape. */
function scoreBucketField(score: number): 'lt25' | 'lt50' | 'lt75' | 'gte75' {
  if (score < 0.25) return 'lt25';
  if (score < 0.5) return 'lt50';
  if (score < 0.75) return 'lt75';
  return 'gte75';
}

/** Sanitizes a scorer name the same way `metricsAgentDayKey` sanitizes agent names (':' → '_') — a
 *  scorer name is caller-supplied display text (ScorerLike.name), not a protocol identifier, and must
 *  never fabricate a fake `score:<name>:<field>` key-schema boundary. */
function sanitizeScorerName(name: string): string {
  return name.replace(/:/g, '_');
}

/** Extracts a finite numeric score from a scorer's result — `ScorerLike.score()` returns
 *  `{ score: number; [k: string]: unknown }`, but callers may also pass a bare number (see
 *  `recordRunScores`'s JSDoc) — `undefined` for anything else (non-numeric/NaN, missing `.score`). */
function extractNumericScore(raw: number | { score: number } | unknown): number | undefined {
  const n = typeof raw === 'number' ? raw : raw && typeof raw === 'object' && typeof (raw as { score?: unknown }).score === 'number'
    ? (raw as { score: number }).score
    : undefined;
  return n !== undefined && Number.isFinite(n) ? n : undefined;
}

/** The per-run fast-path row written by `recordRunMetrics` (read directly by Studio's `/metrics/runs` — no readRun/getRunCost needed for finalized runs). */
export interface MetricsRunRow {
  runId: string;
  agentName?: string;
  /**
   * The verdict the settled cost below BELONGS TO — the status observed at finalize time, NOT the run's
   * current status. Deliberately narrower than `RunStatus`: `recordRunMetrics` is only ever called from
   * run.ts's success choke points (inside `interrupts.length === 0`) and from `backfillMetrics` (which
   * skips everything that isn't 'completed'), and it summarizes WITHOUT the outcome record — so this can
   * only ever hold 'completed' or 'suspended'. Typing it `RunStatus` advertised three values
   * ('failed' | 'running' | 'canceled') no producer can ever write, which is how the row came to be read
   * as if it were the run's status (see below).
   *
   * Passing the outcome into `summarizeRun` here would NOT make the field carry those three honestly, it
   * would make it WRONG: at both call sites `recordRunMetrics` runs BEFORE `runSucceeded` (run.ts), so
   * the outcome record still carries this attempt's write-ahead 'running' — measured: a successful run
   * would have been recorded as 'running'.
   *
   * NEVER read this to display a run's status. The row is written ONCE per runId (exactly-once claim), so
   * a run that succeeded and was later re-run and failed keeps a row saying 'completed' — that is the
   * D5 disagreement between GET /metrics/runs and GET /runs. Status is living state whose one source of
   * truth is the journal (`listRuns`/`deriveRunStatus`); cost and tokens are settled history and stay
   * materialized here. Studio's /metrics/runs serves `RunSummary.status` and takes only the cost/token
   * fields from this row (see server.ts). The field keeps its name because rows already persisted in
   * customer journals carry it.
   */
  status: 'completed' | 'suspended';
  costUsd: number;
  totalTokens: number;
  modelSteps: number;
  toolCalls: number;
  startTs: number | null;
  durationMs: number;
  finalizedAt: number;
}

/**
 * Records ONE completed run's contribution to the materialized counters — called from the run-completion
 * hook (registry.ts `run()`, right after the C4 scorers block) and from `backfillMetrics`.
 *
 * CONTRACT: the journal (readRun/getRunCost) is always the source of truth; this is the derived aggregate.
 * P1.6b — TWO write paths, chosen by capability:
 * `applyBatch` (all first-party journals): claim marker + counter increments + fast-row land as ONE
 *    all-or-nothing unit (SQL transaction / Redis Lua / in-memory sync block) → NO loss window at all.
 * Sequential fallback (third-party journals without applyBatch): claim FIRST (`putIfAbsent` CAS,
 *    exactly-once under concurrency), then incrBy. A crash between the two loses that ONE run's
 *    contribution (marker-first = UNDERCOUNTS, never overcounts — the safe direction; same accepted
 *    window as budget.ts's `recordRunUsage`). `rebuildMetrics` is the deterministic repair either way.
 *
 * Returns `false` (no-op) when:
 * the journal doesn't implement `incrBy`/`putIfAbsent` (no atomic primitives → the legacy full-scan
 *    stays the story for this backend; a custom third-party journal without these is unaffected/unbroken),
 * the reader doesn't implement `readRun` (can't compute per-run stats),
 * the run was already recorded (claim lost — idempotent, not an error).
 */
export async function recordRunMetrics(
  journal: Journal,
  reader: JournalReader,
  runId: string,
  opts: { agentName?: string } = {},
): Promise<boolean> {
  const hasBatch = typeof journal.applyBatch === 'function';
  if (!hasBatch && (typeof journal.incrBy !== 'function' || typeof journal.putIfAbsent !== 'function')) return false;
  if (typeof reader.readRun !== 'function') return false;

  // Cheap pre-check on the common already-recorded path (avoids computing stats just to lose the claim).
  // NOT the exactly-once guarantee itself — that stays with the atomic claim below (batch or CAS).
  if ((await journal.get(metricsDoneKey(runId))) !== undefined) return false;

  if (!hasBatch) {
    const claimed = await journal.putIfAbsent!(metricsDoneKey(runId), { at: Date.now() });
    if (!claimed) return false; // already recorded (exactly-once) — not an error
  }

  const entries = await reader.readRun(runId);
  const summary = summarizeRun(runId, entries);
  const cost = await getRunCost(reader, runId);
  const tsValues = entries.map((e) => e.ts).filter((t): t is number => t != null);
  // TRUE start = the ':input' freeze instant (persistInput stamps `at` before the first model call).
  // The visible-entry minimum LIES for streamed runs: a step's `model:N` row is written when the step
  // finishes, so a single-step stream has one row at the very end (duration read 0ms) and multi-step
  // runs swallowed the whole first step. Runs recorded before the stamp fall back to the old span.
  const inputAt = (await journal.get<{ at?: number }>(runKeys.input(runId)))?.at;
  const startTs = inputAt ?? (tsValues.length ? Math.min(...tsValues) : null);
  const endTs = tsValues.length ? Math.max(...tsValues) : null;
  const durationMs = startTs != null && endTs != null ? Math.max(0, endTs - startTs) : 0;

  const now = (await journal.now?.()) ?? Date.now();
  const day = dayKeyFor(now);
  const bucketField = durationBucketField(durationMs);

  const fields: Record<string, number> = {
    runs: 1,
    costUsdMicros: Math.round(cost.costUsd * USD_MICROS), // integer money — see the USD_MICROS note
    tokens: cost.totalTokens,
    modelSteps: summary.modelSteps,
    toolCalls: summary.toolCalls,
    durMs: durationMs,
    [bucketField]: 1,
  };
  // P3.1: the shard is chosen by runId, so a run always lands on the same row and a retry cannot
  // double-count across two shards (the claim marker still decides IF it counts at all).
  const sfx = shardSuffix(runId, METRICS_SHARDS);
  const incrs: JournalBatch['incrs'] = [
    { key: METRICS_ALL_KEY + sfx, fields },
    { key: metricsDayKey(day) + sfx, fields },
    ...(opts.agentName ? [{ key: metricsAgentDayKey(opts.agentName, day) + sfx, fields }] : []),
  ];

  const row: MetricsRunRow = {
    runId,
    ...(opts.agentName ? { agentName: opts.agentName } : {}),
    // Narrowed at runtime rather than cast: `summarizeRun` without an outcome can only answer
    // 'suspended' or 'completed' (deriveRunStatus), and if that ever stops being true this row must
    // still not start claiming a live verdict it does not track — see MetricsRunRow.status.
    status: summary.status === 'suspended' ? 'suspended' : 'completed',
    costUsd: cost.costUsd, // the row is a plain record, not an accumulating counter — exact float is fine here
    totalTokens: cost.totalTokens,
    modelSteps: summary.modelSteps,
    toolCalls: summary.toolCalls,
    startTs,
    durationMs,
    finalizedAt: now,
  };

  if (hasBatch) {
    // Atomic path: claim + increments + row are all-or-nothing → no loss window (see the contract note).
    return journal.applyBatch!({
      claim: { key: metricsDoneKey(runId), value: { at: Date.now() } },
      incrs,
      puts: [{ key: metricsRunKey(runId), value: row }],
    });
  }

  for (const i of incrs) await journal.incrBy!(i.key, i.fields);
  await journal.put(metricsRunKey(runId), row);
  return true;
}

/**
 * P2-skor records ONE completed run's C4 scorer output as a SECOND, ADDITIVE
 * incrBy pass onto the SAME day/agent/all counter keys `recordRunMetrics` writes to (`METRICS_ALL_KEY`,
 * `metricsDayKey`, `metricsAgentDayKey`) — new `score:<name>:*` fields alongside the existing
 * runs/tokens/cost fields. Called from registry.ts's C4 block, AFTER scoring completes — scores are
 * NOT available at `recordRunMetrics`'s call site (run.ts's completion choke points), which runs before
 * the registry ever computes them (see the block's own comment in registry.ts).
 *
 * KEY SCHEMA (per scorer, sanitized name — see `sanitizeScorerName`):
 * `score:<name>:sumMilli` — integer `round(score * 1000)`, summed (float-drift-free, same reasoning
 *    as `costUsdMicros`). `readMetricsSummary` derives `score:<name>:avg` = sumMilli / 1000 / count.
 * `score:<name>:count` — number of runs that contributed a valid numeric score for this scorer
 *    (the derivation denominator — also the honest way to see how many runs actually got scored).
 * `score:<name>:lt25` / `:lt50` / `:lt75` / `:gte75` — exactly one bucket per (run, scorer).
 *
 * SAMPLING BIAS (see AgentConfig.scorerSampling / shouldSampleScorers in registry.ts): this is only
 * ever called on the sampled-IN path — a sampled-out run contributes NOTHING to these counters (no
 * scorers ran, so there is nothing to record). The resulting `score:<name>:avg` therefore reflects only
 * the SAMPLED SUBSET of runs, not the full population — `score:<name>:count` makes that denominator
 * explicit so a dashboard can show it next to the average instead of implying full coverage.
 *
 * NON-NUMERIC SCORES: a scorer result that isn't a finite number (and isn't `{ score: number, ... }`
 * either) is silently skipped for THAT scorer name only — it contributes no field at all (not even a
 * zero) and does not fail the batch; every other scorer in the same `scores` object is still recorded.
 * There is no per-name return signal for this (best-effort telemetry, not a correctness-critical path —
 * same posture as the `.catch(() => {})` at the registry.ts call site).
 *
 * Exactly-once via ITS OWN claim marker (`metricsScoresDoneKey`, distinct from `recordRunMetrics`'s
 * `metricsDoneKey` — see that key's JSDoc for why). Same two write paths as `recordRunMetrics`
 * (applyBatch when available, sequential putIfAbsent+incrBy fallback otherwise) and the same
 * `false`-means-no-op contract (already recorded, or the journal lacks the atomic primitives).
 *
 * REPAIR PATH (closed in the same round, review finding): `backfillMetrics` restores score counters
 * from the per-run `proc:eval:<name>` memoization records (they ARE the journaled ground truth for
 * scores), and `rebuildMetrics` wipes `METRICS_SCORES_DONE_PRE` alongside the other prefixes — so
 * "rebuild = deterministic repair" holds for score aggregates too, not just the base run counters.
 * Requires `listKeys` for the per-run eval scan; without it, score restoration is skipped (base
 * metrics still rebuild) — documented in backfillMetrics.
 */
export async function recordRunScores(
  journal: Journal,
  runId: string,
  agentName: string | undefined,
  scores: Record<string, number | { score: number }>,
): Promise<boolean> {
  const hasBatch = typeof journal.applyBatch === 'function';
  if (!hasBatch && (typeof journal.incrBy !== 'function' || typeof journal.putIfAbsent !== 'function')) return false;

  // Cheap pre-check — mirrors recordRunMetrics (not the exactly-once guarantee itself, see below).
  if ((await journal.get(metricsScoresDoneKey(runId))) !== undefined) return false;

  if (!hasBatch) {
    const claimed = await journal.putIfAbsent!(metricsScoresDoneKey(runId), { at: Date.now() });
    if (!claimed) return false; // already recorded (exactly-once) — not an error
  }

  const now = (await journal.now?.()) ?? Date.now();
  const day = dayKeyFor(now);

  const fields: Record<string, number> = {};
  for (const [rawName, rawScore] of Object.entries(scores)) {
    const numeric = extractNumericScore(rawScore);
    if (numeric === undefined) continue; // non-numeric/NaN — skip THIS scorer only, see the JSDoc
    const name = sanitizeScorerName(rawName);
    fields[`score:${name}:sumMilli`] = (fields[`score:${name}:sumMilli`] ?? 0) + Math.round(numeric * SCORE_MILLI);
    fields[`score:${name}:count`] = (fields[`score:${name}:count`] ?? 0) + 1;
    const bucketField = `score:${name}:${scoreBucketField(numeric)}`;
    fields[bucketField] = (fields[bucketField] ?? 0) + 1;
  }

  // P3.1: same shard as this run's own metrics pass — score fields live on the SAME counter keys.
  const sfx = shardSuffix(runId, METRICS_SHARDS);
  const incrs: JournalBatch['incrs'] = [
    { key: METRICS_ALL_KEY + sfx, fields },
    { key: metricsDayKey(day) + sfx, fields },
    ...(agentName ? [{ key: metricsAgentDayKey(agentName, day) + sfx, fields }] : []),
  ];

  if (hasBatch) {
    return journal.applyBatch!({
      claim: { key: metricsScoresDoneKey(runId), value: { at: Date.now() } },
      incrs,
    });
  }

  for (const i of incrs) await journal.incrBy!(i.key, i.fields);
  return true;
}

/**
 * One-time (or periodic) catch-up: records every COMPLETED run that hasn't been recorded yet.
 * Suspended runs are skipped (not yet final — `recordRunMetrics` will pick them up once they complete
 * and are re-run through the normal completion hook). Self-deduplicating: re-running this after a
 * previous (partial or full) backfill only records runs that are still missing their claim marker —
 * everything else is counted as `skipped`.
 */
export async function backfillMetrics(
  journal: Journal,
  reader: JournalReader,
): Promise<{ recorded: number; skipped: number; scoresRestored: number }> {
  const runs = await listRunsArray(reader as { listRuns: (q?: unknown) => Promise<unknown> });
  let recorded = 0;
  let skipped = 0;
  let scoresRestored = 0;
  for (const r of runs) {
    if (r.status !== 'completed') {
      skipped++;
      continue;
    }
    const ok = await recordRunMetrics(journal, reader, r.runId, r.agent ? { agentName: r.agent } : {});
    if (ok) recorded++;
    else skipped++;
    // P2-skor repair (review finding): scorer results are journaled (`<runId>:proc:eval:<name>` — the
    // C4 memoization records, `{v: {score,...}}` shape per durableProcessorStep), so the score counters
    // are RE-DERIVABLE — without this, `rebuildMetrics`' wipe lost score aggregates permanently while
    // claiming to be "the deterministic repair". Needs listKeys (prefix scan); silently skipped without
    // it (base metrics still backfill — scores just stay unrestored, same as pre-P2 behavior).
    // Attempted independently of `ok`: the scores claim is SEPARATE (metricsScoresDoneKey), so a run
    // whose base metrics were already recorded but whose score counters were wiped still restores.
    if (typeof journal.listKeys === 'function') {
      const evalKeys = await journal.listKeys(`${r.runId}:proc:eval:`);
      if (evalKeys.length) {
        const scores: Record<string, number | { score: number }> = {};
        for (const k of evalKeys) {
          const rec = await journal.get<{ v: { score?: number } }>(k);
          const name = k.slice(`${r.runId}:proc:eval:`.length);
          if (rec?.v !== undefined && name) scores[name] = rec.v as { score: number };
        }
        if (Object.keys(scores).length && (await recordRunScores(journal, r.runId, r.agent, scores))) scoresRestored++;
      }
    }
  }
  return { recorded, skipped, scoresRestored };
}

/**
 * Deterministic repair: wipes every materialized-metrics key (counters + run rows + claim markers) and
 * recomputes them from the journal via `backfillMetrics` — the journal is the source of truth (see the
 * trade-off note on `recordRunMetrics`), so this always converges to the exact values regardless of any
 * prior undercount/drift. Requires `deletePrefix` (throws a clear error otherwise — no silent partial rebuild).
 *
 * ADAPTER CONTRACT: `deletePrefix` wiping a counter written via `incrBy` requires the adapter to treat
 * counter keys as ordinary keys of the prefix space (the deletePrefix contract in journal.ts: ALL keys).
 * All four first-party adapters honor this — InMemoryJournal (fixed alongside this file; see the bugfix
 * note on its `keys`/`listKeys`/`deletePrefix`) and SQLite/Postgres/Redis (fixed in the same round:
 * their deletePrefix now also sweeps `gnl_counters` / the Redis `ctr:` sub-namespace — which was ALSO a
 * pre-existing GDPR-purge gap: org deletion used to leave `org:<id>:__usage__` counters behind). A
 * third-party Journal that stores counters outside its deletePrefix scan would break this contract —
 * verified by the storage conformance suite (test/storage-backend.test.ts).
 */
export async function rebuildMetrics(
  journal: Journal,
  reader: JournalReader,
): Promise<{ recorded: number; skipped: number; scoresRestored: number }> {
  if (typeof journal.deletePrefix !== 'function') {
    throw new Error(
      "@gnldev/durable: rebuildMetrics requires the journal to implement `deletePrefix` (see the Journal interface in journal.ts) — without it there is no safe way to wipe the existing aggregate before recomputing it.",
    );
  }
  await journal.deletePrefix(METRICS_COUNTERS_PRE);
  await journal.deletePrefix(METRICS_DONE_PRE);
  await journal.deletePrefix(METRICS_RUN_PRE);
  // P2-skor repair: the scores claim markers must be wiped too — otherwise backfillMetrics' score
  // restoration (see its P2-skor block) would lose the claim and skip every run, leaving the score
  // fields (which live on the SAME counter keys wiped above) permanently empty after a rebuild.
  await journal.deletePrefix(METRICS_SCORES_DONE_PRE);
  return backfillMetrics(journal, reader);
}

/** One day's (or all-time's) materialized counter fields, as read back via `getCounters` (undefined = no data yet for that bucket). */
export interface MetricsDayEntry {
  day: string;
  fields: Record<string, number> | undefined;
}

/**
 * Reads the materialized summary: all-time totals + the last `opts.days` (default 14, clamped 1..90)
 * UTC day buckets, oldest first. Pure `getCounters` point-reads (`all` + N explicit day keys) — NO
 * `listKeys` scan needed, so this is O(1 + days) regardless of run-history size. Returns `all: undefined`
 * (and an empty `byDay`) if the journal doesn't implement `getCounters` at all — the caller (Studio) uses
 * that to fall back to the legacy full-scan story (`source: 'scan'`).
 */
export async function readMetricsSummary(
  journal: Journal,
  opts: { days?: number } = {},
): Promise<{ all: Record<string, number> | undefined; byDay: MetricsDayEntry[] }> {
  if (typeof journal.getCounters !== 'function') return { all: undefined, byDay: [] };
  /**
   * `days: 0` asks for the `all` bucket and nothing else — for a caller that wants the running
   * totals and never looks at the daily series.
   *
   * The cost is the reason it exists. Every bucket is `1 + METRICS_SHARDS` point reads (17 at the
   * default), so the standard 14-day summary is 255 of them. The organization list wanted `tokens`
   * and `costUsd` from `all` and threw the other 238 away — per organization, on every page load:
   * 50 organizations came to 12,750 reads to use 850 of them.
   *
   * The floor used to be 1, which quietly rounded a request for "no days" up to one day. Zero is a
   * meaningful answer here and 0 reads is a meaningful cost.
   */
  const days = Math.max(0, Math.min(90, opts.days ?? 14));
  const all = withDerivedScores(withDerivedCost(await sumShards((k) => journal.getCounters!(k), METRICS_ALL_KEY, METRICS_SHARDS)));
  const byDay: MetricsDayEntry[] = [];
  const nowMs = Date.now();
  const msPerDay = 24 * 60 * 60 * 1000;
  for (let i = days - 1; i >= 0; i--) {
    const day = dayKeyFor(nowMs - i * msPerDay);
    const fields = withDerivedScores(withDerivedCost(await sumShards((k) => journal.getCounters!(k), metricsDayKey(day), METRICS_SHARDS)));
    byDay.push({ day, fields });
  }
  return { all, byDay };
}

/**
 * P1.6b: expose `costUsd` (float) DERIVED from the integer `costUsdMicros` counter, folding in a legacy
 * float `costUsd` field if the counters predate the micro-USD switch (mixed data adds up correctly —
 * no forced rebuild). Consumers keep reading `costUsd`; the raw `costUsdMicros` stays visible too.
 */
function withDerivedCost(fields: Record<string, number> | undefined): Record<string, number> | undefined {
  if (!fields) return undefined;
  const micros = fields.costUsdMicros ?? 0;
  const legacy = fields.costUsd ?? 0;
  return { ...fields, costUsd: legacy + micros / USD_MICROS };
}

/** Matches a `score:<name>:sumMilli` field key — `<name>` (group 1) drives the `score:<name>:avg` lookup below. */
const SCORE_SUM_FIELD_RE = /^score:(.+):sumMilli$/;

/**
 * P2-skor: expose `score:<name>:avg` (float) DERIVED from the integer `score:<name>:sumMilli` /
 * `score:<name>:count` counter pair, for every scorer name present in the fields — same
 * derive-on-read posture as `withDerivedCost`'s `costUsd`. A scorer with `count === 0` (should not
 * happen — `recordRunScores` never writes a `sumMilli` field without also incrementing `count`) is
 * skipped rather than dividing by zero.
 */
function withDerivedScores(fields: Record<string, number> | undefined): Record<string, number> | undefined {
  if (!fields) return undefined;
  const out = { ...fields };
  for (const key of Object.keys(fields)) {
    const m = SCORE_SUM_FIELD_RE.exec(key);
    if (!m) continue;
    const name = m[1];
    const count = fields[`score:${name}:count`] ?? 0;
    if (count > 0) out[`score:${name}:avg`] = fields[key] / SCORE_MILLI / count;
  }
  return out;
}
