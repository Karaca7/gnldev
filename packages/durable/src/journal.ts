// Journal: the single substrate of durability. Append-only key→value storage.
// The core uses this in-memory; the SQLite/Postgres adapters implement the same interface.

import type { Guard } from './guard.js';
import type { RunLimits } from './limits.js';
import type { Processor } from './processor.js';
import { stableStringify } from './hash.js';
import { isVersionedKey, upgradeFormat } from './format.js';

export type ToolJournalRecord =
  // GOREV W1: toolName — carried so loop detection (checkToolLoop) can match SUCCEEDED records by
  // tool. Optional: absent from old records → checks that require a toolName match (which only run
  // WHEN limits.loopDetection IS ON) simply treat those records as "a different tool" (harmless, breaks the streak).
  //
  // GOREV (time-travel fidelity, args-mode custom idempotencyKey): `resolvedToolCallIds` — every REAL
  // AI SDK toolCallId that has been SERVED this record's output (the winner that produced it, plus any
  // later toolCallId that consumed it via the exactly-once/dedup fast paths — same-turn duplicates,
  // the documented duplicate-toolCallId pattern, or a repeat call that a custom `idempotencyKey` collapses onto the same key). In
  // 'call' mode this is always exactly `[toolCallId]` (the key IS the toolCallId, no other id can ever
  // land here). In 'args' mode it's the ONLY way to know which toolCallId(s) a record resolves when the
  // dedupe key was derived from a custom `idempotencyKey` function — that function lives in the tool
  // definition, not the journal, so reconstructState (pure, journal-only) cannot recompute it (see
  // time-travel.ts). Optional: absent from records written before this field existed → reconstructState
  // falls back to its previous (best-effort) hash-recompute matching for those.
  // GOREV (saga/compensation): `input` — the tool's RAW arguments, stored ONLY for tools that declare
  // a `compensate` hook (opt-in journal cost): the unwind needs the original args (e.g. which
  // reservation to release), and the hash alone can't reproduce them. Absent on other/older records →
  // compensateRun falls back to recovering args from the model steps' tool-call parts.
  | { status: 'succeeded'; output: unknown; argsHash?: string; toolName?: string; input?: unknown; resolvedToolCallIds?: string[] }
  | { status: 'denied'; output: unknown; resolvedToolCallIds?: string[] }
  // GOREV (loop reflection — `loopDetection.onRepeat: 'reflect'`): the call was NOT executed; instead a
  // "reconsider" nudge was returned to the model as this call's tool result (see limits.ts / durable-tool.ts).
  // Terminal like 'denied' (time-travel treats it as resolved: status !== suspended/running), and the
  // nudge output must replay IDENTICALLY on resume → hence a journaled terminal record, not a transient.
  // argsHash/toolName are stamped like on 'succeeded' — seedFromHistory needs them to re-arm the chain's
  // `reflected` flag on the MATCHING chain after an internal-state loss (match-only, see limits.ts).
  | { status: 'reflected'; output: unknown; argsHash?: string; toolName?: string; resolvedToolCallIds?: string[] }
  | { status: 'suspended'; output: unknown }
  // GOREV 4.3: attempts — the number of FAILED attempts made so far for this key (to enforce the
  // retry limit). Optional: absent from old records → durable-tool.ts assumes 1.
  // GOREV (audit C3): `sideEffect` — whether this failed call was a SIDE-EFFECT tool (its execute was
  // actually invoked and may have posted an effect). A failed side-effect ATTEMPT counts toward
  // maxToolCalls (see limits.ts recordToolOutcome/seedFromHistory); a failed read-only tool does not.
  // Stored so seedFromHistory can reconstruct the SAME count from the journal on a first-encounter scan.
  // Optional: absent from old records → treated as not-a-side-effect (harmless, the pre-C3 behavior).
  | { status: 'failed'; error: string; attempts?: number; sideEffect?: boolean }
  | { status: 'running'; startedAt: number }; // M4: atomic claim marker (execute in-flight)

/**
 * GOREV (distributed exactly-once — ADAPTER PARITY MATRIX): every optional concurrency primitive
 * below, per first-party adapter, with its ATOMICITY MECHANISM. All four first-party adapters
 * implement all four primitives ENGINE-ATOMICALLY on their primary paths — the "single-process safe
 * fallback" bounds documented in limits.ts/budget.ts/claim() apply ONLY to custom third-party
 * journals that omit a primitive.
 *
 *   primitive     InMemory        SQLite (multi-process via WAL)     Postgres                        Redis (real ioredis)
 *   ─────────     ────────        ──────────────────────────────     ────────                        ────────────────────
 *   putIfAbsent   sync Map        INSERT ON CONFLICT DO NOTHING      INSERT ON CONFLICT DO NOTHING   SET NX
 *   putIfMatch    sync Map        UPDATE WHERE value=?               UPDATE WHERE value=$            Lua CAS (eval)†
 *   incrBy        sync Map        UPSERT arithmetic                  UPSERT arithmetic               HINCRBYFLOAT
 *   claim (M4)    putIfAbsent     putIfAbsent                        putIfAbsent                     putIfAbsent
 *
 *   † a custom Redis client WITHOUT `eval` degrades putIfMatch to best-effort compare-then-set
 *     (documented, CORE-HARDENING §2.2); real ioredis always takes the atomic Lua path.
 *
 * PROOF, not prose: cross-PROCESS races on SQLite run in EVERY CI (multi-process-race.test.ts — two
 * OS processes, file barrier: run-lock / tool-claim / putIfAbsent grid / putIfMatch takeover / incrBy
 * storm, all exact). The REAL Postgres/Redis twins live in integration-real.test.ts (two pools/two
 * clients, GNL_INTEGRATION=1). Multi-process COLD START is part of the proof too — two booters on the
 * same fresh SQLite file must both survive (busy_timeout-first + OR IGNORE seeding, see sqlite-storage.ts).
 *
 * SCOPE (honest bound): these guarantees hold for ANY number of workers sharing ONE journal store.
 * Independent journals (multi-region active-active) are NOT coordinated — a run lives on exactly one
 * "home" journal; geo-distribution is a ROUTING concern (per-run ownership), not a consensus feature.
 */
export interface Journal {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  /**
   * M4 (optional): atomic insert-only. Writes and returns `true` WHEN the key is ABSENT, or returns
   * `false` without touching anything if it exists. Provides exactly-once under concurrency via CAS. If undefined, `claim()` falls back to get+put.
   */
  putIfAbsent?(key: string, value: unknown): Promise<boolean>;
  /** Phase 12 (optional): return keys starting with a prefix (queue/events/cache enumeration). */
  listKeys?(prefix: string): Promise<string[]>;
  /**
   * Retention/GDPR (optional): PERMANENTLY deletes ALL keys starting with a prefix, returns the
   * number deleted. The single exception to the journal's append-only philosophy — only for lawful
   * deletion (PII purge) and retention sweeps; never used in the normal flow.
   */
  deletePrefix?(prefix: string): Promise<number>;
  /**
   * H1 (optional): atomic CONDITIONAL replace (CAS-on-existing). If the key's CURRENT value is
   * SERIALIZED-equal to `expected`, writes `value` and returns `true`; otherwise (different/changed/
   * deleted) returns `false` WITHOUT touching anything. Usage: expired run-lock TAKEOVER — even if two
   * workers read the same expired record, only ONE can replace it (split-brain becomes impossible, see run-lock.ts).
   * The comparison is over the serialized form; a false-negative (mismatch) is the SAFE side: the
   * takeover just doesn't happen this attempt, the next attempt reads the fresh record. If undefined,
   * acquireRunLock falls back to the old best-effort get→put behavior (documented risk, CORE-HARDENING §2.2).
   */
  putIfMatch?(key: string, expected: unknown, value: unknown): Promise<boolean>;
  /**
   * H2 (optional): the storage's OWN clock (epoch ms) — makes lock TTL decisions independent of
   * worker wall-clock skew (Postgres `now()`, Redis `TIME`).
   * If undefined, Date.now is used (no difference on single-machine setups).
   */
  now?(): Promise<number>;
  /**
   * H8a (optional): field-based ATOMIC counter increment — `value = value + delta` inside the engine
   * (SQL UPSERT arithmetic / Redis HINCRBYFLOAT). Kills two ailments of get→put at once: the
   * lost-update race (two workers read the same value and add, one gets overwritten) and the hot-row
   * read-modify-write cost. Negative delta = decrement. budget.ts uses this when supported.
   */
  incrBy?(key: string, fields: Record<string, number>): Promise<void>;
  /** H8a: read counter fields written via incrBy (undefined if absent). */
  getCounters?(key: string): Promise<Record<string, number> | undefined>;
  /**
   * P1.6b (optional): ATOMIC batch — claim (putIfAbsent semantics) + counter increments + plain puts as
   * ONE all-or-nothing unit (SQL transaction / Redis Lua). If `claim` is given and its key EXISTS, the
   * WHOLE batch is a no-op and `false` is returned; otherwise everything applies and `true` is returned.
   * Motivation (metrics.ts recordRunMetrics): with the sequential claim→incrBy path, a crash between the
   * two loses one run's counter contribution forever (documented undercount window). applyBatch closes
   * that window definitively — either the claim marker AND the increments AND the rows all land, or none
   * do. Adapters that can't provide atomicity must NOT implement this (callers fall back to the
   * sequential path rather than getting fake atomicity).
   */
  applyBatch?(batch: JournalBatch): Promise<boolean>;
  /**
   * P1.6b (optional): batch point-read — values for `keys`, ORDER-PRESERVING, `undefined` for misses
   * (SQL `WHERE key IN` / Redis MGET). Kills the N-roundtrip pattern of reading N keys in a loop
   * (studio's /metrics/runs fast-rows). Semantically identical to `Promise.all(keys.map(get))`.
   */
  getMany?<T = unknown>(keys: string[]): Promise<(T | undefined)[]>;
  /**
   * H8b (optional): ids of runs whose last activity is OLDER than `cutoffTs` — reduces sweepRuns's
   * "fetch ALL entries of every run" O(whole-DB) scan to a single indexed query
   * (gnl_runs.updated_at). If `includeSuspended` is not given, suspended runs are NOT RETURNED (the safe side).
   */
  listStaleRuns?(cutoffTs: number, opts?: { includeSuspended?: boolean }): Promise<string[]>;
}

/**
 * P1.6b: the unit applied atomically by `Journal.applyBatch` — see its JSDoc for the contract.
 * `claim` is optional: without it the batch always applies (still atomically).
 */
export interface JournalBatch {
  /** Gate with putIfAbsent semantics: key EXISTS → the whole batch is a no-op (returns false). */
  claim?: { key: string; value: unknown };
  /** incrBy-semantics counter increments (applied only when the claim wins / is absent). */
  incrs?: Array<{ key: string; fields: Record<string, number> }>;
  /** Plain puts (applied only when the claim wins / is absent). */
  puts?: Array<{ key: string; value: unknown }>;
}

// ── Typed key schema ────────────────────────────────────────────────────
// The journal key format is a CONTRACT: parseJournalKey + the adapters + time-travel all read by it.
// Use these builders instead of hand-rolled template strings → a single source of truth, the format changes in one place.

/**
 * GOREV (cross-run dedup): both `toolByArgs` and `toolCrossRun` embed `toolName` VERBATIM into a key
 * that is later parsed by matching the LITERAL `:tool:`/`:model:` substrings (parseJournalKey) — a
 * toolName containing ':' could fabricate a fake `:tool:`/`:model:` boundary and corrupt the runId
 * parse (toolByArgs) or accidentally masquerade as run-scoped (toolCrossRun, which relies on NOT
 * containing that pattern to stay invisible — see toolCrossRun below). Guarded identically in both builders.
 */
function assertNoColonInToolName(toolName: string): void {
  if (toolName.includes(':')) {
    throw new Error(`@gnldev/durable: tool name '${toolName}' must not contain ':' — it would break the journal key schema (see runKeys.toolByArgs/toolCrossRun in journal.ts)`);
  }
}

export const runKeys = {
  /** Run input (prompt/messages/system) — invisible to parseJournalKey. */
  input: (runId: string) => `${runId}:input`,
  /** LLM step record (deterministic replay). step: a number; may come as a string in fork copies. */
  model: (runId: string, step: number | string) => `${runId}:model:${step}`,
  /** Tool call record (exactly-once; the key is the AI SDK toolCallId). */
  tool: (runId: string, toolCallId: string) => `${runId}:tool:${toolCallId}`,
  /**
   * GOREV (args-based idempotency, opt-in `idempotency: 'args'`): the journal key is NOT the
   * toolCallId, but a `hash` derived from the tool arguments (or the user's `idempotencyKey`).
   * To PRESERVE the `${runId}:tool:${toolCallId}` format CONTRACT (parseJournalKey + the adapters +
   * time-travel), the dedupeId has NO ':' INSIDE it (an 'args-' prefix, joined with dashes) →
   * parseJournalKey parses it unchanged without corrupting the runId. Even if the model produces a
   * NEW toolCallId with the SAME arguments (the documented duplicate-toolCallId pattern), it still lands on the SAME key → a
   * single execution (used by durable-tool.ts).
   */
  toolByArgs: (runId: string, toolName: string, hash: string) => {
    assertNoColonInToolName(toolName);
    return `${runId}:tool:args-${toolName}-${hash}`;
  },
  /**
   * GOREV (cross-run dedup, opt-in `idempotencyWindow: 'cross-run'`): like `toolByArgs`, but WITHOUT a
   * `${runId}:` prefix — the dedup window SPANS RUNS instead of being scoped to one. Because the key
   * does NOT contain the `:tool:`/`:model:` pattern, it is INVISIBLE to `parseJournalKey` (and therefore
   * to the reader/time-travel/forkRun) — INTENTIONAL: this record isn't part of any single run's
   * timeline. `withOrg` still prefixes it like every other key (`get`/`put`/`putIfAbsent` prefix
   * UNCONDITIONALLY, no runId-shaped pattern assumed) → organization isolation is preserved
   * AUTOMATICALLY. Cleanup: since it's NOT runId-scoped, run-retention/sweep does NOT touch it —
   * purge explicitly via `journal.deletePrefix('xrun:')`.
   */
  toolCrossRun: (toolName: string, hash: string) => {
    assertNoColonInToolName(toolName);
    return `xrun:args-${toolName}-${hash}`;
  },
  /** Non-deterministic processor step — invisible to parseJournalKey. */
  proc: (runId: string, name: string) => `${runId}:proc:${name}`,
  /** Memory append idempotency marker — resume/retry doesn't double-write. Two-phase record (see run.ts
   *  claimMemoryAppend/markMemoryAppendDone): `{status:'pending', startedAt}` (claimed but not yet
   *  finished — taken over via self-heal if stale) → promoted to `true` (done) once the append succeeds. */
  memAppended: (runId: string) => `mem-appended:${runId}`,
  /** WRITE-AHEAD user-message append marker (see run.ts writeAheadIncoming): the run's `incoming`
   *  user message(s) are appended to memory BEFORE the first model call — a run that dies before its
   *  first token no longer leaves a titled-but-EMPTY thread (the thread row itself was already
   *  write-ahead via ensureThreadIndexed; this closes the asymmetry). Same two-phase record shape as
   *  memAppended above; the completion-time append then persists only the PRODUCED messages. */
  memUserAppended: (runId: string) => `mem-user-appended:${runId}`,
  /**
   * Memory-context provenance (`:memctx` — invisible to parseJournalKey, and the `${runId}:` purge
   * prefix covers it). Written ONCE per run next to `:input` (first attempt wins, same freeze
   * semantics): the frozen input says WHAT the model saw, this record says WHERE each part came from
   * — recall hits with similarity, recent-window count, OM observations, WM injection, and the
   * echo-trim/incoming counts run.ts adds. Read by studio's GET /runs/:id/memory-context.
   */
  memoryContext: (runId: string) => `${runId}:memctx`,
  /** Frozen model selection (the fallback winner) — invisible to parseJournalKey, resume sticks to the same model. */
  cfgModel: (runId: string) => `${runId}:cfg:model`,
  /**
   * AUDIT B2: the run's `limits` (RunLimits — plain serializable numbers/strings/booleans) frozen at run
   * start. `limits` is a runtime RunOptions value, not part of AgentConfig, so `resumeRun`/the CLI
   * `resume` command have no source to re-supply it — a resumed run would silently lose
   * maxCost/maxTokens/loopDetection/taintedSideEffects/sideEffectDuplicates. Persisting it here lets
   * resume recover it when the caller doesn't pass `limits`. Outside the `:model:`/`:tool:` pattern →
   * invisible to parseJournalKey (like input/proc/cfgModel), doesn't affect step counting. */
  cfgLimits: (runId: string) => `${runId}:cfg:limits`,
  /**
   * AUDIT (approval first-class): the human approval decision (result of require-approval). Outside
   * the `':approval:'` pattern (model|tool) → invisible to parseJournalKey (doesn't leak into the
   * reader/time-travel, just like `input`/`proc`/`cfgModel`). run.ts writes this to the journal
   * INDEPENDENTLY of the `approvals` parameter (claim; first decision wins) → in the 'approved but
   * crashed before the tool ran' scenario, the next resume reads the decision from the journal and
   * applies it even if the `approvals` parameter isn't given.
   */
  approval: (runId: string, toolCallId: string) => `${runId}:approval:${toolCallId}`,
} as const;

// AUDIT (silent fallback → vocal): custom journals that don't offer `putIfAbsent` fall back to
// get→put — this is SAFE in a single process but exactly-once is NOT ATOMICALLY guaranteed under
// multiple workers (two concurrent `claim` calls can both see `get` as undefined at the same time and
// both `put`). This used to be SILENT — a user writing a custom journal would not notice this risk.
// Warn explicitly ONCE PER journal object (WeakSet — doesn't prevent GC) via `console.warn`; DOES NOT
// THROW (doesn't BREAK existing single-process custom adapter users, only makes it visible).
const claimFallbackWarned = new WeakSet<Journal>();

/**
 * Atomic claim: use `putIfAbsent` if available (CAS), otherwise get+put fallback (single-process safe).
 * Returns `true` if this call created the key.
 */
export async function claim(journal: Journal, key: string, value: unknown): Promise<boolean> {
  if (journal.putIfAbsent) return journal.putIfAbsent(key, value);
  if (!claimFallbackWarned.has(journal)) {
    claimFallbackWarned.add(journal);
    console.warn(
      '@gnldev/durable: this journal does not implement `putIfAbsent` — atomic claim fell back to get→put. ' +
        'This is safe in single-process usage; in multi-worker/distributed environments exactly-once is ' +
        'NOT guaranteed ATOMICALLY (double-claim is possible in the contention window). Implementing ' +
        '`putIfAbsent(key, value)` is recommended (see the Journal interface in journal.ts).',
    );
  }
  if ((await journal.get(key)) !== undefined) return false;
  await journal.put(key, value);
  return true;
}

/**
 * CAS-frozen memoize (general primitive): if a record exists, return it (compute NEVER runs);
 * otherwise compute and write via `claim` — the loser of the race DISCARDS its own result and reads
 * the winner's record (a single truth under multi-worker). Difference from `durableProcessorStep` in
 * processor.ts: not get+put but CAS → two concurrent workers can't produce different results for the same decision.
 *
 * RECORD FORMAT CONTRACT: the value is written wrapped as `{ v }` — this makes `undefined` results
 * distinguishable from "no record". This format is compatible with old records in the journal
 * (network `net:route`/`net:step` records were always written this way); DO NOT CHANGE.
 */
export async function frozenGet<T>(journal: Journal, key: string, compute: () => Promise<T>): Promise<T> {
  const hit = await journal.get<{ v: T }>(key);
  if (hit !== undefined) return hit.v;
  const v = await compute();
  if (await claim(journal, key, { v })) return v;
  const winner = await journal.get<{ v: T }>(key);
  if (winner === undefined) throw new Error(`@gnldev/durable: claim was lost but the record could not be read (${key})`);
  return winner.v;
}

/** Context of a durable run: journal, run, optional policy and approvals. */
export interface DurableCtx {
  journal: Journal;
  runId: string;
  /**
   * AUDIT A4 (thread-scoped taint): the run's threadId, when the caller gave one (runDurable/
   * streamDurable pass it through). Pure infra on its own — durable-tool only USES it when
   * `limits.taintScope === 'thread'` (to write the thread taint key alongside the per-run mark).
   */
  threadId?: string;
  guard?: Guard;
  /** require-approval decisions: toolCallId → whether approved (passed on resume). */
  approvals?: Record<string, boolean>;
  /**
   * Replay determinism mode (M2). 'lenient' (default): on drift, only warns, returns the recorded output.
   * 'strict': throws `DivergenceError` if tool-args drift is detected during replay.
   */
  replay?: 'strict' | 'lenient';
  /**
   * C2 (optional): replay snapshot (key→value) populated via `readRun` at the start of the run.
   * Reduces hot replay reads (model/tool) to a single SQL query → 1 round-trip instead of N on Postgres.
   * Consume-once: a key is dropped once served, the next read goes to the real journal
   * (concurrency/new writes are always read from the live journal).
   */
  replayCache?: Map<string, unknown>;
  /** GOREV W1 (opt-in): per-run cost ceiling + loop detection. If not given, no check runs. */
  limits?: RunLimits;
  /**
   * H10b (opt-in production mode): 'strict' → every tool MUST DECLARE ITS SIDE-EFFECT INTENT
   * (at least one of idempotent | sideEffect | recover). An undeclared tool is caught with a clear
   * error AT THE START of the run (not surprised mid-run) — ends the "developer forgot to mark it" class of bug.
   */
  toolPolicy?: 'strict';
  /**
   * K1 (internal — set by runDurable/streamDurable): because the AI SDK's `executeTools` swallows
   * errors THROWN from tool.execute and converts them to 'tool-error', throwing block errors inside
   * the loop (SideEffectRetryBlocked/RetryLimit/RunBusy) PIERCES the protection: the run doesn't stop,
   * the model sees the error text and may produce a NEW toolCallId with the SAME arguments → a fresh
   * key → a duplicate side effect. While true, durable-tool returns a `__gnl_blocked` sentinel instead
   * of throwing (same mechanism as limits' `__gnl_limit_exceeded` pattern): composeStopWhen stops the
   * loop, runDurableInner converts the sentinel into a properly typed error and throws it. Behavior is
   * UNCHANGED for direct durableTool users (MCP server, manual wrapping): throw.
   */
  blockedAsSentinel?: boolean;
  /** Y1 (opt-in): default tool execute timeout (ms) — tool.timeoutMs overrides per tool. */
  toolTimeoutMs?: number;
  /** Y3 (opt-in): default 'running' claim staleness threshold (ms) — tool.claimTtlMs overrides per tool. */
  claimTtlMs?: number;
  /**
   * AUDIT TASK (opt-in): a processor chain that runs AFTER tool execute (prompt-injection flagging,
   * redaction). Only processors defining `processToolResult` are applied in sequence; the transformed
   * output is written to the journal as 'succeeded' (see processor.ts processToolResult, durable-tool.ts).
   */
  toolResultProcessors?: Processor[];
}

/**
 * Replay-aware get: if present in the snapshot, serve it from there (consume-once), otherwise fall through to the journal.
 * Each replay key is read once on the hot path; once served it's dropped from the cache →
 * the next read (e.g. re-get after claim) always goes to the real journal.
 */
export async function ctxGet<T = unknown>(ctx: DurableCtx, key: string): Promise<T | undefined> {
  const cache = ctx.replayCache;
  if (cache && cache.has(key)) {
    const v = cache.get(key);
    cache.delete(key);
    // H13: both the replay-cache path and the journal path go through the SAME format gate (single choke point).
    return isVersionedKey(key) ? upgradeFormat(v as T, key) : (v as T);
  }
  const v = await ctx.journal.get<T>(key);
  return v !== undefined && isVersionedKey(key) ? upgradeFormat(v, key) : v;
}

/**
 * C2: load the replay snapshot at the start of a run (if the journal supports `readRun`). On the
 * first run there are no entries → returns `undefined` (no cache). On resume, fetches all model/tool entries in one query.
 */
export const REPLAY_CACHE_MAX_BYTES = 32 * 1024 * 1024; // 32MB — H8c default threshold

export async function loadReplayCache(
  journal: Journal,
  runId: string,
  opts: { maxBytes?: number } = {},
): Promise<Map<string, unknown> | undefined> {
  const rr = (journal as Partial<JournalReader>).readRun;
  if (typeof rr !== 'function') return undefined;
  // H8c RAM guardrail: if the adapter provides cheap statistics, measure the ledger before pulling it into memory.
  const stats = (journal as Partial<JournalReader>).readRunStats;
  if (typeof stats === 'function') {
    try {
      const st = await stats.call(journal, runId);
      const cap = opts.maxBytes ?? REPLAY_CACHE_MAX_BYTES;
      if (st.bytes > cap) {
        console.warn(
          `@gnldev/durable: '${runId}' journal ~${Math.round(st.bytes / 1048576)}MB > replay-cache threshold ` +
            `(${Math.round(cap / 1048576)}MB) — bulk cache is skipped (point-read replay). ` +
            `For long-lived runs, epoch handover via rolloverRun is recommended.`,
        );
        return undefined; // ctxGet falls through to the journal → same correctness, bounded memory
      }
    } catch {
      // stats failed → normal path (behavior unchanged)
    }
  }
  try {
    const entries = await rr.call(journal, runId);
    if (!entries || entries.length === 0) return undefined;
    const m = new Map<string, unknown>();
    for (const e of entries) m.set(e.key, e.value);
    return m;
  } catch {
    return undefined;
  }
}

// ── Read-API (for studio / observability) ─────────────────────────────────

export type JournalEntryKind = 'model' | 'tool';

export interface JournalEntry {
  key: string;
  runId: string;
  kind: JournalEntryKind;
  value: unknown; // model: doGenerate result · tool: ToolJournalRecord
  seq: number; // order within the run
  ts?: number; // write time (created_at) — for OTEL trace timing (undefined if absent)
}

export interface RunSummary {
  runId: string;
  status: 'completed' | 'suspended';
  modelSteps: number;
  toolCalls: number;
  /**
   * AUDIT (threadId first-class): derived from the run's invisible `:input` entry (stamped by durable
   * `persistInput`, see run.ts). Only present on runs that WERE GIVEN a threadId — if not given, the
   * field is absent entirely (falls into the ungrouped bucket). `listRuns` surfaces this within each
   * adapter's OWN read; studio (or any other consumer) must NOT do a separate N+1 `:input` read.
   */
  threadId?: string;
  /**
   * The agent's registry name — derived from the SAME invisible `:input` entry as threadId (stamped by
   * durable `persistInput`). Lets studio /runs LABEL each run with its agent with NO per-run N+1 read.
   * Absent on runs created before this field existed / runs invoked directly (no agent name given).
   */
  agent?: string;
}

/** Journal read surface (timeline / time-travel / studio). */
export interface JournalReader {
  listRuns(): Promise<RunSummary[]>;
  /**
   * ORDERING CONTRACT (Decision #4): records are returned in ASCENDING write-time order; ties at the
   * same timestamp are broken deterministically by `key`. limits.ts (loop counting) and
   * regression.ts (diff) rely on this order — adapters must apply `ORDER BY created_at, key` (or an equivalent).
   */
  readRun(runId: string): Promise<JournalEntry[]>;
  /**
   * H8c (optional): CHEAP statistics for a run (COUNT + SUM(length(value)) — without transferring data).
   * loadReplayCache uses this for threshold checking: it checks the ledger's size before pulling it
   * fully into RAM; if over the threshold, the bulk cache is SKIPPED (replay falls back to
   * point-reads — same correctness, bounded memory).
   */
  readRunStats?(runId: string): Promise<{ entries: number; bytes: number }>;
  /**
   * P1.6b (optional): push-down status aggregate — `{ completed: n, suspended: m, ... }` computed by the
   * ENGINE (SQL `GROUP BY status` over the indexed gnl_runs summary), NOT by materializing every run
   * summary in the caller. Studio's /metrics uses this to get total/byStatus in O(distinct statuses)
   * instead of listRuns()'s O(all runs). Deliberately a reader capability (derived data, no write-path
   * bookkeeping → cannot drift, unlike status-transition counters would). Adapters without a cheap
   * aggregate (e.g. a pure-KV backend) simply leave it undefined — callers fall back to listRuns.
   */
  countRunsByStatus?(): Promise<Record<string, number>>;
  /**
   * P0.3 (AUDIT-R2, optional capability): a PAGINATED + FILTERED sibling of `listRuns()`
   * above. The array method stays exactly as-is (used EVERYWHERE — studio, budget.ts, toJournal's own
   * array bridge — turning it paginated would be a breaking change to every caller); this is an
   * ADDITIVE capability for consumers (server's GET /runs) that want a real page + filters instead of
   * materializing every run.
   * FILTER SEMANTICS (must match exactly, so a filtered page and an unfiltered scan never disagree):
   *   - `status` matches `summarizeRun`'s derivation — 'suspended' iff the run has ANY tool record with
   *     status:'suspended', else 'completed'.
   *   - `agent` matches the SAME `RunSummary.agent` field `listRuns()` already surfaces (from the run's
   *     invisible `:input` entry) — an exact string match.
   * Filtering MUST happen BEFORE pagination slicing (never filter-after-slice — that silently drops
   * items off a page and desyncs `nextCursor` from what the caller thinks they've seen).
   * NOTE (import-cycle avoidance): the query/page shapes below are a structural MIRROR of storage.ts's
   * `ListQuery`/`Page<T>` (same fields) rather than an import — storage.ts already imports
   * Journal/JournalReader/RunSummary FROM this file, so importing back would create a cycle. Any
   * RunJournal (storage.ts) satisfies this signature structurally via its own `listRuns(q)` — see
   * storage.ts's `toJournal()` bridge, which delegates this straight through.
   * OPTIONAL: a bare custom JournalReader that only implements the legacy array `listRuns()` simply
   * leaves this undefined — callers fall back to the array + in-memory filter/slice path.
   */
  listRunsPaged?(q?: {
    limit?: number;
    cursor?: string;
    status?: 'completed' | 'suspended';
    agent?: string;
  }): Promise<{ items: RunSummary[]; nextCursor?: string }>;
}

/** Parse a `<runId>:model:<step>` / `<runId>:tool:<toolCallId>` key (runId may contain colons). */
export function parseJournalKey(key: string): { runId: string; kind: JournalEntryKind } | null {
  const m = /^(.*):(model|tool):.+$/.exec(key);
  return m ? { runId: m[1]!, kind: m[2] as JournalEntryKind } : null;
}

/** Derive a summary from a run's entries. */
export function summarizeRun(runId: string, entries: JournalEntry[]): RunSummary {
  let modelSteps = 0;
  let toolCalls = 0;
  let suspended = false;
  for (const e of entries) {
    if (e.kind === 'model') modelSteps++;
    else {
      toolCalls++;
      if ((e.value as ToolJournalRecord | undefined)?.status === 'suspended') suspended = true;
    }
  }
  return { runId, status: suspended ? 'suspended' : 'completed', modelSteps, toolCalls };
}

/**
 * In-memory journal for test/dev. To simulate a real crash, it's enough to keep the same instance
 * alive across two calls (in real prod, SQLite/Postgres make this durable).
 */
export class InMemoryJournal implements Journal, JournalReader {
  private store = new Map<string, unknown>();
  private times = new Map<string, number>(); // key → first write time (OTEL timing)

  async get<T = unknown>(key: string): Promise<T | undefined> {
    if (!this.store.has(key)) return undefined;
    return structuredClone(this.store.get(key)) as T;
  }

  async put(key: string, value: unknown): Promise<void> {
    if (!this.times.has(key)) this.times.set(key, Date.now());
    this.store.set(key, structuredClone(value));
  }

  // no await between has→set → structurally atomic in single-threaded JS.
  async putIfAbsent(key: string, value: unknown): Promise<boolean> {
    if (this.store.has(key)) return false;
    this.times.set(key, Date.now());
    this.store.set(key, structuredClone(value));
    return true;
  }

  // H1: conditional replace — comparison via stableStringify (in the same spirit as the SQL
  // adapters' serialize() string equality); NO await between get→compare→set → structurally atomic.
  async putIfMatch(key: string, expected: unknown, value: unknown): Promise<boolean> {
    if (!this.store.has(key)) return false;
    if (stableStringify(this.store.get(key)) !== stableStringify(expected)) return false;
    this.store.set(key, structuredClone(value));
    return true;
  }

  // H8a: structurally atomic counter in single-threaded JS.
  private counters = new Map<string, Record<string, number>>();
  async incrBy(key: string, fields: Record<string, number>): Promise<void> {
    const cur = this.counters.get(key) ?? {};
    for (const [f, d] of Object.entries(fields)) cur[f] = (cur[f] ?? 0) + d;
    this.counters.set(key, cur);
  }
  async getCounters(key: string): Promise<Record<string, number> | undefined> {
    const c = this.counters.get(key);
    return c ? { ...c } : undefined;
  }

  // P1.6b: atomic batch — no await between the claim check and the writes → structurally atomic in
  // single-threaded JS (the same argument as putIfAbsent/putIfMatch above). Mirrors the SQL-transaction/
  // Redis-Lua semantics of the real adapters: claim exists → NOTHING is applied.
  async applyBatch(batch: JournalBatch): Promise<boolean> {
    if (batch.claim) {
      if (this.store.has(batch.claim.key)) return false;
      this.times.set(batch.claim.key, Date.now());
      this.store.set(batch.claim.key, structuredClone(batch.claim.value));
    }
    for (const { key, fields } of batch.incrs ?? []) {
      const cur = this.counters.get(key) ?? {};
      for (const [f, d] of Object.entries(fields)) cur[f] = (cur[f] ?? 0) + d;
      this.counters.set(key, cur);
    }
    for (const { key, value } of batch.puts ?? []) {
      if (!this.times.has(key)) this.times.set(key, Date.now());
      this.store.set(key, structuredClone(value));
    }
    return true;
  }

  // P1.6b: batch point-read — order-preserving, undefined for misses (getMany contract).
  async getMany<T = unknown>(keys: string[]): Promise<(T | undefined)[]> {
    return keys.map((k) => (this.store.has(k) ? (structuredClone(this.store.get(k)) as T) : undefined));
  }

  // P1.6b: push-down status aggregate — derived per call from the same source listRuns uses (no
  // write-path bookkeeping → cannot drift; in RAM this is as cheap as it gets).
  async countRunsByStatus(): Promise<Record<string, number>> {
    const runs = await this.listRuns();
    const out: Record<string, number> = {};
    for (const r of runs) out[r.status] = (out[r.status] ?? 0) + 1;
    return out;
  }

  // H8b: in-memory last-activity scan (test/dev — already in RAM).
  async listStaleRuns(cutoffTs: number, opts?: { includeSuspended?: boolean }): Promise<string[]> {
    const last = new Map<string, { ts: number; suspended: boolean }>();
    for (const [key, value] of this.store) {
      const p = parseJournalKey(key);
      if (!p) continue;
      const ts = this.times.get(key) ?? 0;
      const cur = last.get(p.runId) ?? { ts: 0, suspended: false };
      cur.ts = Math.max(cur.ts, ts);
      if (p.kind === 'tool' && (value as ToolJournalRecord | undefined)?.status === 'suspended') cur.suspended = true;
      last.set(p.runId, cur);
    }
    return [...last.entries()]
      .filter(([, v]) => v.ts < cutoffTs && (opts?.includeSuspended ? true : !v.suspended))
      .map(([runId]) => runId);
  }

  // H8c: cheap statistics (stableStringify length ~ serialized size).
  async readRunStats(runId: string): Promise<{ entries: number; bytes: number }> {
    let entries = 0;
    let bytes = 0;
    for (const [key, value] of this.store) {
      const p = parseJournalKey(key);
      if (p && p.runId === runId) {
        entries++;
        bytes += stableStringify(value).length;
      }
    }
    return { entries, bytes };
  }

  // P1.6 (AUDIT-R2, bugfix): `keys()`/`listKeys()`/`deletePrefix()` used to only see
  // `this.store` — a key written EXCLUSIVELY via `incrBy` (the `this.counters` map, H8a) never showed
  // up here and could never be wiped by `deletePrefix`, even though `get`/`getCounters` treat it as the
  // SAME key namespace (the Journal interface doc for `deletePrefix` promises "deletes ALL keys starting
  // with a prefix" — no carve-out for counter-only keys). This surfaced as a real bug: metrics.ts's
  // `rebuildMetrics` deletes `__metrics__:*` counters before recomputing them, and without this fix the
  // stale counter survives the "wipe" and the recompute silently ADDS ON TOP of it. All three counter keys
  // are included below wherever store keys are.
  keys(): string[] {
    return [...new Set([...this.store.keys(), ...this.counters.keys()])];
  }

  async listKeys(prefix: string): Promise<string[]> {
    return this.keys().filter((k) => k.startsWith(prefix));
  }

  async deletePrefix(prefix: string): Promise<number> {
    let deleted = 0;
    for (const k of [...this.store.keys()]) {
      if (k.startsWith(prefix)) {
        this.store.delete(k);
        this.times.delete(k);
        deleted++;
      }
    }
    for (const k of [...this.counters.keys()]) {
      if (k.startsWith(prefix)) {
        this.counters.delete(k);
        deleted++;
      }
    }
    return deleted;
  }

  async readRun(runId: string): Promise<JournalEntry[]> {
    const out: JournalEntry[] = [];
    let seq = 0;
    for (const [key, value] of this.store) {
      const p = parseJournalKey(key);
      if (p && p.runId === runId) {
        out.push({ key, runId, kind: p.kind, value: structuredClone(value), seq: seq++, ts: this.times.get(key) });
      }
    }
    return out;
  }

  async listRuns(): Promise<RunSummary[]> {
    const byRun = new Map<string, JournalEntry[]>();
    let seq = 0;
    for (const [key, value] of this.store) {
      const p = parseJournalKey(key);
      if (!p) continue;
      const list = byRun.get(p.runId) ?? [];
      list.push({ key, runId: p.runId, kind: p.kind, value, seq: seq++ });
      byRun.set(p.runId, list);
    }
    // AUDIT (threadId first-class): summarizeRun stays PURE (doesn't see `:input`) — we separately
    // MERGE threadId from the run's invisible `:input` entry. Map.get is O(1) — NOT N+1
    // (doesn't make a separate pass like readRun/listRuns, it's a single point-read from the store we already have).
    return [...byRun.entries()].map(([runId, entries]) => {
      const s = summarizeRun(runId, entries);
      const inp = this.store.get(`${runId}:input`) as { threadId?: string; agent?: string } | undefined;
      return {
        ...s,
        ...(inp?.threadId ? { threadId: inp.threadId } : {}),
        ...(inp?.agent ? { agent: inp.agent } : {}),
      };
    });
  }

  /**
   * P0.3 (AUDIT-R2): paginated + filtered sibling of `listRuns()` above — see the
   * `JournalReader.listRunsPaged` JSDoc for the filter-semantics contract. In-memory reference
   * implementation: derive the full array (already O(store size), same cost `listRuns()` pays), filter,
   * then offset-paginate — mirroring the numeric cursor-as-offset convention every adapter's own
   * `offset()`/`paginate()` helper uses (sqlite-storage.ts/postgres-storage.ts/redis-storage.ts/
   * in-memory-storage.ts), so a cursor produced by one path is interchangeable with the others.
   */
  async listRunsPaged(q?: {
    limit?: number;
    cursor?: string;
    status?: 'completed' | 'suspended';
    agent?: string;
  }): Promise<{ items: RunSummary[]; nextCursor?: string }> {
    let all = await this.listRuns();
    if (q?.status) all = all.filter((r) => r.status === q.status);
    if (q?.agent) all = all.filter((r) => r.agent === q.agent);
    const start = q?.cursor ? Number(q.cursor) || 0 : 0;
    const limit = q?.limit ?? 50;
    const items = all.slice(start, start + limit);
    const next = start + limit;
    return { items, nextCursor: next < all.length ? String(next) : undefined };
  }
}
