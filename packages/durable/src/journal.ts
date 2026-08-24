// Journal: the single substrate of durability. Append-only key→value storage.
// The core uses this in-memory; the SQLite/Postgres adapters implement the same interface.

import type { Guard } from './guard.js';
import type { RunLimits } from './limits.js';
import type { Processor } from './processor.js';
import { stableStringify } from './hash.js';
import { isVersionedKey, upgradeFormat } from './format.js';

export type ToolJournalRecord = (
  // ToolName — carried so loop detection (checkToolLoop) can match SUCCEEDED records by
  // Tool. Optional: absent from old records → checks that require a toolName match (which only run
  // WHEN limits.loopDetection IS ON) simply treat those records as "a different tool" (harmless, breaks the streak).
  //
  // `resolvedToolCallIds` — every REAL
  // AI SDK toolCallId that has been SERVED this record's output (the winner that produced it, plus any
  // Later toolCallId that consumed it via the exactly-once/dedup fast paths — same-turn duplicates,
  // The documented duplicate-toolCallId pattern, or a repeat call that a custom `idempotencyKey` collapses onto the same key). In
  // 'call' mode this is always exactly `[toolCallId]` (the key IS the toolCallId, no other id can ever
  // Land here). In 'args' mode it's the ONLY way to know which toolCallId(s) a record resolves when the
  // Dedupe key was derived from a custom `idempotencyKey` function — that function lives in the tool
  // Definition, not the journal, so reconstructState (pure, journal-only) cannot recompute it (see
  // Time-travel.ts). Optional: absent from records written before this field existed → reconstructState
  // Falls back to its previous (best-effort) hash-recompute matching for those.
  // `input` — the tool's RAW arguments, stored ONLY for tools that declare
  // A `compensate` hook (opt-in journal cost): the unwind needs the original args (e.g. which
  // Reservation to release), and the hash alone can't reproduce them. Absent on other/older records →
  // CompensateRun falls back to recovering args from the model steps' tool-call parts.
  | { status: 'succeeded'; output: unknown; argsHash?: string; toolName?: string; input?: unknown; resolvedToolCallIds?: string[] }
  // `toolName` on the NON-success statuses too. A denial is the entry an auditor
  // Most needs to identify — a human refused a tool — and it used to be the one carrying the least:
  // The key holds the toolCallId, the output holds `{__denied, reason}`, and the name appeared
  // Nowhere, so answering "what was refused" meant correlating with the model step. 'suspended' got
  // Away with it only because its sentinel repeats the name inside the output. Stamped at the single
  // Choke point (writeToolTerminal) rather than per call site, so a new terminal path cannot forget.
  // Inert for loop detection: applyToolOutcomeToChain reads toolName only for succeeded/reflected.
  | { status: 'denied'; output: unknown; toolName?: string; resolvedToolCallIds?: string[] }
  // The call was NOT executed; instead a
  // "reconsider" nudge was returned to the model as this call's tool result (see limits.ts / durable-tool.ts).
  // Terminal like 'denied' (time-travel treats it as resolved: status !== suspended/running), and the
  // Nudge output must replay IDENTICALLY on resume → hence a journaled terminal record, not a transient.
  // ArgsHash/toolName are stamped like on 'succeeded' — seedFromHistory needs them to re-arm the chain's
  // `reflected` flag on the MATCHING chain after an internal-state loss (match-only, see limits.ts).
  | { status: 'reflected'; output: unknown; argsHash?: string; toolName?: string; resolvedToolCallIds?: string[] }
  | { status: 'suspended'; output: unknown; toolName?: string }
  // Attempts — the number of FAILED attempts made so far for this key (to enforce the
  // Retry limit). Optional: absent from old records → durable-tool.ts assumes 1.
  // `sideEffect` — whether this failed call was a SIDE-EFFECT tool (its execute was
  // Actually invoked and may have posted an effect). A failed side-effect ATTEMPT counts toward
  // MaxToolCalls (see limits.ts recordToolOutcome/seedFromHistory); a failed read-only tool does not.
  // Stored so seedFromHistory can reconstruct the SAME count from the journal on a first-encounter scan.
  // Optional: absent from old records → treated as not-a-side-effect (harmless, the pre-C3 behavior).
  | { status: 'failed'; error: string; attempts?: number; sideEffect?: boolean; toolName?: string }
  | { status: 'running'; startedAt: number; toolName?: string } // M4: atomic claim marker (execute in-flight)
) & {
  /**
   * Set on a SHADOW copy written under `${runId}:tool:` for a record whose authoritative key is not
   * run-scoped — today only the `cross-run` idempotency window (`xrun:args-…`). Holds that key.
   *
   * The shadow exists because a run with nothing under its own prefix has no history: `readRun` misses
   * the step, `listRuns` cannot derive 'suspended', and Studio's approval inbox shows nothing to click
   * while the run sits waiting for a decision. It is NOT authoritative — the exactly-once read always
   * uses the real key — and nothing consults it to decide whether to execute.
   *
   * It must be invisible to a SINGLE RUN'S UNWIND. A cross-run record is shared: other runs may depend
   * on the action, which is why the record was kept out of the run's key space in the first place.
   * `compensateRun` therefore skips anything carrying this field — without that, mirroring a succeeded
   * record made one run's rollback refund a charge another run was still relying on.
   */
  mirrorOf?: string;
};

/**
 * Every optional concurrency primitive
 * Below, per first-party adapter, with its ATOMICITY MECHANISM. All four first-party adapters
 * Implement all four primitives ENGINE-ATOMICALLY on their primary paths — the "single-process safe
 * Fallback" bounds documented in limits.ts/budget.ts/claim() apply ONLY to custom third-party
 * Journals that omit a primitive.
 *
 *   Primitive     InMemory        SQLite (multi-process via WAL)     Postgres                        Redis (real ioredis)
 *   ─────────     ────────        ──────────────────────────────     ────────                        ────────────────────
 *   PutIfAbsent   sync Map        INSERT ON CONFLICT DO NOTHING      INSERT ON CONFLICT DO NOTHING   SET NX
 *   PutIfMatch    sync Map        UPDATE WHERE value=?               UPDATE WHERE value=$            Lua CAS (eval)†
 *   IncrBy        sync Map        UPSERT arithmetic                  UPSERT arithmetic               HINCRBYFLOAT
 *   Claim (M4)    putIfAbsent     putIfAbsent                        putIfAbsent                     putIfAbsent
 *
 *   † a custom Redis client WITHOUT `eval` degrades putIfMatch to best-effort compare-then-set
 *     (documented, the core-hardening review); real ioredis always takes the atomic Lua path.
 *
 * PROOF, not prose: cross-PROCESS races on SQLite run in EVERY CI (multi-process-race.test.ts — two
 * OS processes, file barrier: run-lock / tool-claim / putIfAbsent grid / putIfMatch takeover / incrBy
 * Storm, all exact). The REAL Postgres/Redis twins live in integration-real.test.ts (two pools/two
 * Clients, GNL_INTEGRATION=1). Multi-process COLD START is part of the proof too — two booters on the
 * Same fresh SQLite file must both survive (busy_timeout-first + OR IGNORE seeding, see sqlite-storage.ts).
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
   * Number deleted. The single exception to the journal's append-only philosophy — only for lawful
   * Deletion (PII purge) and retention sweeps; never used in the normal flow.
   */
  deletePrefix?(prefix: string): Promise<number>;
  /**
   * H1 (optional): atomic CONDITIONAL replace (CAS-on-existing). If the key's CURRENT value is
   * SERIALIZED-equal to `expected`, writes `value` and returns `true`; otherwise (different/changed/
   * Deleted) returns `false` WITHOUT touching anything. Usage: expired run-lock TAKEOVER — even if two
   * Workers read the same expired record, only ONE can replace it (split-brain becomes impossible, see run-lock.ts).
   * The comparison is over the serialized form; a false-negative (mismatch) is the SAFE side: the
   * Takeover just doesn't happen this attempt, the next attempt reads the fresh record. If undefined,
   * AcquireRunLock falls back to the old best-effort get→put behavior (documented risk, the core-hardening review).
   */
  putIfMatch?(key: string, expected: unknown, value: unknown): Promise<boolean>;
  /**
   * H2 (optional): the storage's OWN clock (epoch ms) — makes lock TTL decisions independent of
   * Worker wall-clock skew (Postgres `now()`, Redis `TIME`).
   * If undefined, Date.now is used (no difference on single-machine setups).
   */
  now?(): Promise<number>;
  /**
   * H8a (optional): field-based ATOMIC counter increment — `value = value + delta` inside the engine
   * (SQL UPSERT arithmetic / Redis HINCRBYFLOAT). Kills two ailments of get→put at once: the
   * Lost-update race (two workers read the same value and add, one gets overwritten) and the hot-row
   * Read-modify-write cost. Negative delta = decrement. budget.ts uses this when supported.
   */
  incrBy?(key: string, fields: Record<string, number>): Promise<void>;
  /** H8a: read counter fields written via incrBy (undefined if absent). */
  getCounters?(key: string): Promise<Record<string, number> | undefined>;
  /**
   * P1.6b (optional): ATOMIC batch — claim (putIfAbsent semantics) + counter increments + plain puts as
   * ONE all-or-nothing unit (SQL transaction / Redis Lua). If `claim` is given and its key EXISTS, the
   * WHOLE batch is a no-op and `false` is returned; otherwise everything applies and `true` is returned.
   * Motivation (metrics.ts recordRunMetrics): with the sequential claim→incrBy path, a crash between the
   * Two loses one run's counter contribution forever (documented undercount window). applyBatch closes
   * That window definitively — either the claim marker AND the increments AND the rows all land, or none
   * Do. Adapters that can't provide atomicity must NOT implement this (callers fall back to the
   * Sequential path rather than getting fake atomicity).
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
 * Both `toolByArgs` and `toolCrossRun` embed `toolName` VERBATIM into a key
 * That is later parsed by matching the LITERAL `:tool:`/`:model:` substrings (parseJournalKey) — a
 * ToolName containing ':' could fabricate a fake `:tool:`/`:model:` boundary and corrupt the runId
 * Parse (toolByArgs) or accidentally masquerade as run-scoped (toolCrossRun, which relies on NOT
 * Containing that pattern to stay invisible — see toolCrossRun below). Guarded identically in both builders.
 */
function assertNoColonInToolName(toolName: string): void {
  if (toolName.includes(':')) {
    throw new Error(`@gnldev/durable: tool name '${toolName}' must not contain ':' — it would break the journal key schema (see runKeys.toolByArgs/toolCrossRun in journal.ts)`);
  }
}

/**
 * The runId of a sub-agent run, derived from its PARENT.
 *
 * A toolCallId is unique within one completion, NOT across runs — so the original `agent:${toolCallId}`
 * Meant two unrelated parents whose provider minted the same id shared one nested run, and the second
 * Read the first's answer as its own. Naming the parent removes that.
 *
 * This MUST stay a pure function of (parentRunId, toolCallId): limits.ts (`sumSubRuns`, fan-out cost
 * Inheritance) and retention.ts (purge cascade) do not observe the child being created — they
 * RE-DERIVE its id from the parent's tool entries. Anything else here (an idempotencyKey, say) is
 * Unreproducible there, and in the 'cross-run' window the idempotencyKey drops the runId entirely,
 * Which is the very collision this exists to prevent.
 *
 * `parentRunId` is undefined only on a bare AI SDK loop with no durableTool wrapper; there the raw
 * ToolCallId is all there is and its uniqueness is the caller's to guarantee. That is also the LEGACY
 * Shape, so both derivation sites check it as a fallback for journals written before this change.
 */
export function nestedAgentRunId(
  parentRunId: string | undefined,
  toolCallId: string,
  prefix: 'agent' | 'wf' = 'agent',
): string {
  return parentRunId ? `${prefix}:${parentRunId}:${toolCallId}` : `${prefix}:${toolCallId}`;
}

export const runKeys = {
  /** Run input (prompt/messages/system) — invisible to parseJournalKey. */
  input: (runId: string) => `${runId}:input`,
  /** LLM step record (deterministic replay). step: a number; may come as a string in fork copies. */
  model: (runId: string, step: number | string) => `${runId}:model:${step}`,
  /** Tool call record (exactly-once; the key is the AI SDK toolCallId). */
  tool: (runId: string, toolCallId: string) => `${runId}:tool:${toolCallId}`,
  /**
   * The journal key is NOT the
   * ToolCallId, but a `hash` derived from the tool arguments (or the user's `idempotencyKey`).
   * To PRESERVE the `${runId}:tool:${toolCallId}` format CONTRACT (parseJournalKey + the adapters +
   * Time-travel), the dedupeId has NO ':' INSIDE it (an 'args-' prefix, joined with dashes) →
   * ParseJournalKey parses it unchanged without corrupting the runId. Even if the model produces a
   * NEW toolCallId with the SAME arguments (the documented duplicate-toolCallId pattern), it still lands on the SAME key → a
   * Single execution (used by durable-tool.ts).
   */
  toolByArgs: (runId: string, toolName: string, hash: string) => {
    assertNoColonInToolName(toolName);
    return `${runId}:tool:args-${toolName}-${hash}`;
  },
  /**
   * Like `toolByArgs`, but WITHOUT a
   * `${runId}:` prefix — the dedup window SPANS RUNS instead of being scoped to one. Because the key
   * Does NOT contain the `:tool:`/`:model:` pattern, it is INVISIBLE to `parseJournalKey` (and therefore
   * To the reader/time-travel/forkRun) — INTENTIONAL: this record isn't part of any single run's
   * Timeline. `withOrg` still prefixes it like every other key (`get`/`put`/`putIfAbsent` prefix
   * UNCONDITIONALLY, no runId-shaped pattern assumed) → organization isolation is preserved
   * AUTOMATICALLY. Cleanup: since it's NOT runId-scoped, run-retention/sweep does NOT touch it —
   * Purge explicitly via `journal.deletePrefix('xrun:')`.
   */
  toolCrossRun: (toolName: string, hash: string) => {
    assertNoColonInToolName(toolName);
    return `xrun:args-${toolName}-${hash}`;
  },
  /** Non-deterministic processor step — invisible to parseJournalKey. */
  proc: (runId: string, name: string) => `${runId}:proc:${name}`,
  /** Memory append idempotency marker — resume/retry doesn't double-write. Two-phase record (see run.ts
   *  ClaimMemoryAppend/markMemoryAppendDone): `{status:'pending', startedAt}` (claimed but not yet
   *  Finished — taken over via self-heal if stale) → promoted to `true` (done) once the append succeeds. */
  memAppended: (runId: string) => `mem-appended:${runId}`,
  /** WRITE-AHEAD user-message append marker (see run.ts writeAheadIncoming): the run's `incoming`
   *  User message(s) are appended to memory BEFORE the first model call — a run that dies before its
   *  First token no longer leaves a titled-but-EMPTY thread (the thread row itself was already
   *  Write-ahead via ensureThreadIndexed; this closes the asymmetry). Same two-phase record shape as
   *  MemAppended above; the completion-time append then persists only the PRODUCED messages. */
  memUserAppended: (runId: string) => `mem-user-appended:${runId}`,
  /**
   * Memory-context provenance (`:memctx` — invisible to parseJournalKey, and the `${runId}:` purge
   * Prefix covers it). Written ONCE per run next to `:input` (first attempt wins, same freeze
   * Semantics): the frozen input says WHAT the model saw, this record says WHERE each part came from
   * recall hits with similarity, recent-window count, OM observations, WM injection, and the
   * Echo-trim/incoming counts run.ts adds. Read by studio's GET /runs/:id/memory-context.
   */
  memoryContext: (runId: string) => `${runId}:memctx`,
  /** Frozen model selection (the fallback winner) — invisible to parseJournalKey, resume sticks to the same model. */
  cfgModel: (runId: string) => `${runId}:cfg:model`,
  /**
   * The run's `limits` (RunLimits — plain serializable numbers/strings/booleans) frozen at run
   * Start. `limits` is a runtime RunOptions value, not part of AgentConfig, so `resumeRun`/the CLI
   * `resume` command have no source to re-supply it — a resumed run would silently lose
   * MaxCost/maxTokens/loopDetection/taintedSideEffects/sideEffectDuplicates. Persisting it here lets
   * Resume recover it when the caller doesn't pass `limits`. Outside the `:model:`/`:tool:` pattern →
   * Invisible to parseJournalKey (like input/proc/cfgModel), doesn't affect step counting. */
  cfgLimits: (runId: string) => `${runId}:cfg:limits`,
  /**
   * AUDIT (approval first-class): the human approval decision (result of require-approval). Outside
   * The `':approval:'` pattern (model|tool) → invisible to parseJournalKey (doesn't leak into the
   * Reader/time-travel, just like `input`/`proc`/`cfgModel`). run.ts writes this to the journal
   * INDEPENDENTLY of the `approvals` parameter (claim; first decision wins) → in the 'approved but
   * Crashed before the tool ran' scenario, the next resume reads the decision from the journal and
   * Applies it even if the `approvals` parameter isn't given.
   */
  approval: (runId: string, toolCallId: string) => `${runId}:approval:${toolCallId}`,
  /**
   * How the run ENDED. Written once at each terminal boundary — 'completed' on the success path,
   * 'failed' when the run threw — and OVERWRITTEN (a plain put, not a claim) so a resume that finally
   * Succeeds clears an earlier failure rather than carrying it forever.
   *
   * Suffix-anchored like `:input`, which is what keeps runIdOfKey able to claim it safely, and outside
   * The `:model:`/`:tool:` pattern → invisible to parseJournalKey, so replay and time-travel are
   * Unaffected. Purged with the run by the `${runId}:` prefix.
   */
  outcome: (runId: string) => `${runId}:outcome`,
} as const;

/**
 * Is this write the run's outcome record, and does it say the run failed?
 *
 * Adapters index `failed` as a COLUMN rather than filtering on the serialized value, because the
 * Obvious shortcut — `WHERE value LIKE '%failed%'` — matches any run whose error MESSAGE happens to
 * Contain the word, which for a failure record is close to all of them.
 *
 * Returns null for every other key, so a caller can use it as "is this an outcome write at all".
 */
export function outcomeStatusOf(key: string, value: unknown): 'running' | 'failed' | 'canceled' | 'completed' | null {
  if (!key.endsWith(':outcome')) return null;
  // The key suffix alone is not proof: `appendLog(journal, ns, payload, 'outcome')` writes
  // `${ns}:outcome` with a caller's payload. Only the engine's own record — whose status is exactly
  // One of the four lifecycle values — is treated as an outcome.
  const status = (value as { status?: unknown } | null)?.status;
  return status === 'failed' || status === 'completed' || status === 'running' || status === 'canceled' ? status : null;
}

/** What was recorded at a run's terminal boundary. `error` is present only on a failure. */
export interface RunOutcomeRecord {
  /**
   * 'running' is the WRITE-AHEAD half: recorded when a run STARTS, overwritten by the terminal
   * Verdict when it ends. Its purpose is the crash between the two — a run SIGKILLed mid-work used
   * To read back as 'completed', because "no terminal record" and "ended fine" were the same absence.
   * A run that never said it ended now never claims it did; it stays 'running', visibly stale by its
   * `at`, until a resume finishes it or retention sweeps it.
   *
   * 'canceled' is the operator's own ending, written by `cancelAgentRun` at the moment it journals the
   * Durable cancel flag. Before it, a cancel recorded NOTHING — `classifyRunError` calls
   * RunCanceledError a not-a-failure, so an in-flight run that stopped at its next model step left
   * Whatever was already there, and a run canceled before it ever started read 'completed'. Deliberate
   * Cancellation and success were the same answer, which is the one distinction an operator ordering a
   * Cancel actually needs.
   */
  status: 'completed' | 'failed' | 'running' | 'canceled';
  at: number;
  error?: string;
}

// AUDIT (silent fallback → vocal): custom journals that don't offer `putIfAbsent` fall back to
// Get→put — this is SAFE in a single process but exactly-once is NOT ATOMICALLY guaranteed under
// Multiple workers (two concurrent `claim` calls can both see `get` as undefined at the same time and
// Both `put`). This used to be SILENT — a user writing a custom journal would not notice this risk.
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
 * Otherwise compute and write via `claim` — the loser of the race DISCARDS its own result and reads
 * The winner's record (a single truth under multi-worker). Difference from `durableProcessorStep` in
 * Processor.ts: not get+put but CAS → two concurrent workers can't produce different results for the same decision.
 *
 * RECORD FORMAT CONTRACT: the value is written wrapped as `{ v }` — this makes `undefined` results
 * Distinguishable from "no record". This format is compatible with old records in the journal
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
  /**
   * Set by callers that have NO approvals channel — `withIdempotency` runs outside runDurable, and the
   * toolCallId it names is a fresh one on every attempt, so `approvals[id] = true` could never have
   * been pre-supplied. Refusal messages use it to avoid naming a remedy the caller cannot reach.
   */
  noApprovals?: boolean;
  journal: Journal;
  runId: string;
  /**
   * (thread-scoped taint): the run's threadId, when the caller gave one (runDurable/
   * StreamDurable pass it through). Pure infra on its own — durable-tool only USES it when
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
  /** W1 (opt-in): per-run cost ceiling + loop detection. If not given, no check runs. */
  limits?: RunLimits;
  /**
   * H10b (opt-in production mode): 'strict' → every tool MUST DECLARE ITS SIDE-EFFECT INTENT
   * (at least one of idempotent | sideEffect | recover). An undeclared tool is caught with a clear
   * Error AT THE START of the run (not surprised mid-run) — ends the "developer forgot to mark it" class of bug.
   */
  toolPolicy?: 'strict';
  /**
   * K1 (internal — set by runDurable/streamDurable): because the AI SDK's `executeTools` swallows
   * Errors THROWN from tool.execute and converts them to 'tool-error', throwing block errors inside
   * The loop (SideEffectRetryBlocked/RetryLimit/RunBusy) PIERCES the protection: the run doesn't stop,
   * The model sees the error text and may produce a NEW toolCallId with the SAME arguments → a fresh
   * Key → a duplicate side effect. While true, durable-tool returns a `__gnl_blocked` sentinel instead
   * Of throwing (same mechanism as limits' `__gnl_limit_exceeded` pattern): composeStopWhen stops the
   * Loop, runDurableInner converts the sentinel into a properly typed error and throws it. Behavior is
   * UNCHANGED for direct durableTool users (MCP server, manual wrapping): throw.
   */
  blockedAsSentinel?: boolean;
  /** Y1 (opt-in): default tool execute timeout (ms) — tool.timeoutMs overrides per tool. */
  toolTimeoutMs?: number;
  /** Y3 (opt-in): default 'running' claim staleness threshold (ms) — tool.claimTtlMs overrides per tool. */
  claimTtlMs?: number;
  /**
   * AUDIT TASK (opt-in): a processor chain that runs AFTER tool execute (prompt-injection flagging,
   * Redaction). Only processors defining `processToolResult` are applied in sequence; the transformed
   * Output is written to the journal as 'succeeded' (see processor.ts processToolResult, durable-tool.ts).
   */
  toolResultProcessors?: Processor[];
}

/**
 * Replay-aware get: if present in the snapshot, serve it from there (consume-once), otherwise fall through to the journal.
 * Each replay key is read once on the hot path; once served it's dropped from the cache →
 * The next read (e.g. re-get after claim) always goes to the real journal.
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
 * First run there are no entries → returns `undefined` (no cache). On resume, fetches all model/tool entries in one query.
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
      // Stats failed → normal path (behavior unchanged)
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

/**
 * 'failed' exists because its absence was a lie: a run killed at step 0 by a 401, or stopped by a cost
 * Ceiling, was reported as 'completed' — and exportRun sent it to OTel with SpanStatusCode.OK. Nothing
 * Recorded that a run had ENDED BADLY, so nothing could say so.
 *
 * Derivation order is fixed and must be identical in every adapter: 'canceled' first (see
 * DeriveRunStatus for why it outranks even 'suspended'), then 'suspended' (a run waiting on a human is
 * A LIVE state, and it is derived from tool records that outlive any outcome), then the rest of the
 * Recorded outcome, then 'completed'. A run with no outcome record — every run written before this
 * Existed — reads exactly as it did before.
 */
export type RunStatus = 'completed' | 'suspended' | 'failed' | 'running' | 'canceled';

export interface RunSummary {
  runId: string;
  status: RunStatus;
  modelSteps: number;
  toolCalls: number;
  /**
   * AUDIT (threadId first-class): derived from the run's invisible `:input` entry (stamped by durable
   * `persistInput`, see run.ts). Only present on runs that WERE GIVEN a threadId — if not given, the
   * Field is absent entirely (falls into the ungrouped bucket). `listRuns` surfaces this within each
   * Adapter's OWN read; studio (or any other consumer) must NOT do a separate N+1 `:input` read.
   */
  threadId?: string;
  /**
   * The agent's registry name — derived from the SAME invisible `:input` entry as threadId (stamped by
   * Durable `persistInput`). Lets studio /runs LABEL each run with its agent with NO per-run N+1 read.
   * Absent on runs created before this field existed / runs invoked directly (no agent name given).
   */
  agent?: string;
  /**
   * WHOSE run this is — the subject, from the same invisible `:input` entry as `threadId`/`agent`
   * (stamped by durable `persistInput`). `ThreadRecord.resourceId` is a required field and the memory
   * layer keys working memory by it, so conversations already had an owner while runs did not: a
   * caller could ask for one user's threads and not their runs. Absent on runs started without one.
   */
  resourceId?: string;
}

/** Journal read surface (timeline / time-travel / studio). */
export interface JournalReader {
  listRuns(): Promise<RunSummary[]>;
  /**
   * ORDERING CONTRACT (Decision #4): records are returned in ASCENDING write-time order; ties at the
   * Same timestamp are broken deterministically by `key`. limits.ts (loop counting) and
   * Regression.ts (diff) rely on this order — adapters must apply `ORDER BY created_at, key` (or an equivalent).
   */
  readRun(runId: string): Promise<JournalEntry[]>;
  /**
   * H8c (optional): CHEAP statistics for a run (COUNT + SUM(length(value)) — without transferring data).
   * LoadReplayCache uses this for threshold checking: it checks the ledger's size before pulling it
   * Fully into RAM; if over the threshold, the bulk cache is SKIPPED (replay falls back to
   * Point-reads — same correctness, bounded memory).
   */
  readRunStats?(runId: string): Promise<{ entries: number; bytes: number }>;
  /**
   * P1.6b (optional): push-down status aggregate — `{ completed: n, suspended: m, ... }` computed by the
   * ENGINE (SQL `GROUP BY status` over the indexed gnl_runs summary), NOT by materializing every run
   * Summary in the caller. Studio's /metrics uses this to get total/byStatus in O(distinct statuses)
   * Instead of listRuns()'s O(all runs). Deliberately a reader capability (derived data, no write-path
   * Bookkeeping → cannot drift, unlike status-transition counters would). Adapters without a cheap
   * Aggregate (e.g. a pure-KV backend) simply leave it undefined — callers fall back to listRuns.
   */
  countRunsByStatus?(): Promise<Record<string, number>>;
  /**
   * P0.3 a PAGINATED + FILTERED sibling of `listRuns()`
   * Above. The array method stays exactly as-is (used EVERYWHERE — studio, budget.ts, toJournal's own
   * Array bridge — turning it paginated would be a breaking change to every caller); this is an
   * ADDITIVE capability for consumers (server's GET /runs) that want a real page + filters instead of
   * Materializing every run.
   * FILTER SEMANTICS (must match exactly, so a filtered page and an unfiltered scan never disagree):
   * `status` matches `summarizeRun`'s derivation — 'suspended' iff the run has ANY tool record with
   *     Status:'suspended', else 'completed'.
   * `agent` matches the SAME `RunSummary.agent` field `listRuns()` already surfaces (from the run's
   *     Invisible `:input` entry) — an exact string match.
   * Filtering MUST happen BEFORE pagination slicing (never filter-after-slice — that silently drops
   * Items off a page and desyncs `nextCursor` from what the caller thinks they've seen).
   * NOTE (import-cycle avoidance): the query/page shapes below are a structural MIRROR of storage.ts's
   * `ListQuery`/`Page<T>` (same fields) rather than an import — storage.ts already imports
   * Journal/JournalReader/RunSummary FROM this file, so importing back would create a cycle. Any
   * RunJournal (storage.ts) satisfies this signature structurally via its own `listRuns(q)` — see
   * Storage.ts's `toJournal()` bridge, which delegates this straight through.
   * OPTIONAL: a bare custom JournalReader that only implements the legacy array `listRuns()` simply
   * Leaves this undefined — callers fall back to the array + in-memory filter/slice path.
   */
  listRunsPaged?(q?: {
    limit?: number;
    cursor?: string;
    status?: RunStatus;
    agent?: string;
    /** WHOSE runs — matches `RunSummary.resourceId`; same filter-before-slice contract as `agent`. */
    resourceId?: string;
  }): Promise<{ items: RunSummary[]; nextCursor?: string }>;
}

export type RunListQuery = {
  limit?: number;
  cursor?: string;
  status?: RunStatus;
  agent?: string;
  resourceId?: string;
};

/**
 * Read EVERY run as an array, from a view whose `listRuns` may return either shape.
 *
 * `JournalReader.listRuns()` is declared as an array, but every first-party adapter's RunJournal
 * (`storage.runs`) returns a `Page` — and `journal: new SqliteStorage(...).runs` is what the README's
 * Own quickstart teaches. `toJournal()` bridges the two, but only a host that passes `storage` gets it;
 * A host that passes `journal` directly hands the raw Page shape to every array-assuming caller.
 *
 * Walking `nextCursor` matters: a single page is capped, so treating `page.items` as "all runs" quietly
 * Undercounts — which for a usage/quota caller means a budget that never trips.
 */
export async function listRunsArray(
  view: { listRuns: (q?: RunListQuery) => Promise<unknown> },
): Promise<RunSummary[]> {
  const first: unknown = await view.listRuns();
  if (Array.isArray(first)) return first as RunSummary[];
  let page = first as { items?: RunSummary[]; nextCursor?: string } | undefined;
  const items: RunSummary[] = [...(page?.items ?? [])];
  let cursor = page?.nextCursor;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor); // a backend that returns a fixed cursor must not spin forever
    const next: unknown = await view.listRuns({ cursor });
    page = Array.isArray(next) ? { items: next as RunSummary[], nextCursor: undefined } : (next as { items?: RunSummary[]; nextCursor?: string });
    items.push(...(page?.items ?? []));
    cursor = page?.nextCursor;
  }
  return items;
}

/** Filter + slice an array of runs with the SAME semantics listRunsPaged specifies. */
function pageFromArray(all: RunSummary[], q?: RunListQuery): { items: RunSummary[]; nextCursor?: string } {
  const filtered = all.filter(
    (r) => (q?.status ? r.status === q.status : true) && (q?.agent ? r.agent === q.agent : true)
      && (q?.resourceId ? r.resourceId === q.resourceId : true),
  );
  const start = q?.cursor ? Number(q.cursor) || 0 : 0;
  const lim = q?.limit ?? 50;
  const next = start + lim;
  return { items: filtered.slice(start, next), nextCursor: next < filtered.length ? String(next) : undefined };
}

/**
 * Accept a journal in EITHER shape and present the `JournalReader` contract: an array `listRuns()`
 * Plus a real `listRunsPaged()`.
 *
 * This exists because the two shapes are indistinguishable by structure — a RunJournal and a bare
 * Legacy JournalReader both have `listRuns` and neither has `listRunsPaged` — so the only honest test
 * Is to call it and look at what comes back. Hence the per-call check rather than a guess at
 * Construction. A journal that ALREADY has `listRunsPaged` (e.g. `toJournal`'s output) is returned
 * Untouched.
 *
 * A Proxy rather than a spread or `Object.create`: adapters hold private state, and `this` must stay
 * Bound to the original instance or a `#field` access throws.
 */
export function asReaderJournal<T extends object>(journal: T): T {
  const j = journal as unknown as { listRuns?: (q?: RunListQuery) => Promise<unknown>; listRunsPaged?: unknown };
  if (typeof j.listRuns !== 'function' || typeof j.listRunsPaged === 'function') return journal;
  return new Proxy(journal, {
    get(target, prop, receiver) {
      if (prop === 'listRuns') return () => listRunsArray(j as { listRuns: (q?: RunListQuery) => Promise<unknown> });
      if (prop === 'listRunsPaged') {
        return async (q?: RunListQuery) => {
          // A RunJournal applies the filters itself and hands back a real page; a legacy array reader
          // Ignores the query, so the same semantics are applied here instead.
          const res: unknown = await j.listRuns!(q);
          return Array.isArray(res) ? pageFromArray(res as RunSummary[], q) : (res as { items: RunSummary[]; nextCursor?: string });
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
    has(target, prop) {
      return prop === 'listRunsPaged' || Reflect.has(target, prop);
    },
  });
}

/** Parse a `<runId>:model:<step>` / `<runId>:tool:<toolCallId>` key (runId may contain colons). */
export function parseJournalKey(key: string): { runId: string; kind: JournalEntryKind } | null {
  const m = /^(.*):(model|tool):.+$/.exec(key);
  return m ? { runId: m[1]!, kind: m[2] as JournalEntryKind } : null;
}

/**
 * Which run does this key belong to — INDEPENDENT of whether it is a replayable journal entry.
 *
 * `parseJournalKey` answers a narrower question: is this a `:model:`/`:tool:` record, the two kinds
 * ReadRun/reconstructState/time-travel replay. Every OTHER run-scoped key (`:input`, `:proc:`,
 * `:memctx`, `:cfg:`, `:approval:`) is deliberately invisible to it, so those must NEVER gain a `kind`.
 *
 * But "not a journal entry" is not the same as "not part of a run", and the adapters conflated the
 * Two: they derived the run index from parseJournalKey alone, so a run that died before its first
 * Model step — an upstream 401, a guard rejection, a limit tripped at step 0 — wrote only `:input`
 * And a claim marker and therefore produced NO run row at all. It was invisible to `listRuns`, to
 * `gnl runs`, and (the part that actually costs something) to `sweepRuns`: the prompt it had already
 * Persisted sat outside every retention window, indefinitely.
 *
 * DELIBERATELY NARROW, and the narrowness is the safety property. This function's answer feeds the
 * Run index, and sweepRuns purges an indexed run by `${runId}:` PREFIX — so a key wrongly claimed for
 * A run means DELETING a namespace that was never one.
 *
 * The key text alone cannot decide this, which cost a round to learn. `<runId>:proc:<name>` was
 * Rejected early because `mem:<threadId>:messages` shares its shape. The two-segment families looked
 * Unambiguous and were not: `appendLog(journal, ns, payload, id)` writes `${ns}:${id}` with a
 * CALLER-SUPPLIED id, so an audit entry logged as `id: 'input'` produced `__audit__:input` — read as a
 * Run called `__audit__`, whose next retention sweep deleted the entire audit namespace. Measured, not
 * Imagined; see early-failure-visibility.test.ts.
 *
 * So the record corroborates the key. A run's frozen input is a VERSIONED journal record — see
 * IsVersionedKey, which has always counted `:input` as one — and stampFormat gives every versioned
 * Record a `_v`. Nothing else written under some `<x>:input` key carries it. That is a property of the
 * Format rather than a guess about naming, which is what makes it safe to purge on.
 *
 * The two replayable kinds need no corroboration: `:model:`/`:tool:` are the adapters' own index
 * Domain already, and `parseJournalKey` has always claimed exactly those.
 *
 * `:input` is also the one that is always there — run.ts writes it unconditionally, before the first
 * Model call, for every run — so nothing is lost by refusing to guess from any other family.
 *
 * Greedy prefix, matching parseJournalKey's own convention, so a runId containing ':' resolves the
 * Same way in both.
 */
export function runIdOfKey(key: string, value?: unknown): string | null {
  const withTail = /^(.*):(model|tool):.+$/.exec(key);
  if (withTail) return withTail[1]!;
  const asInput = /^(.*):input$/.exec(key);
  return asInput && isVersionedRecord(value) ? asInput[1]! : null;
}

/** Carries stampFormat's version marker → written by the journal itself, not by a caller's payload. */
function isVersionedRecord(value: unknown): boolean {
  return typeof value === 'object' && value !== null && '_v' in (value as Record<string, unknown>);
}

/**
 * The ONE status rule. Every adapter derives status from its own storage shape, and four separate
 * Copies of `suspended ? 'suspended' : 'completed'` is exactly how a third value silently becomes a
 * Second value in three of them.
 */
export function deriveRunStatus(suspended: boolean, outcome?: Pick<RunOutcomeRecord, 'status'> | null): RunStatus {
  // Canceled outranks even 'suspended', which is the one precedence call here that is not obvious.
  // 'suspended' is derived from tool records, and those outlive the cancel: a run canceled while it
  // waited on a human still has its suspended tool record, so it would keep advertising an approval
  // that can never be applied — runDurableGuarded (and resumeRun, which goes through it) calls
  // assertNotCanceled and refuses, and cancel.ts states there is deliberately no uncancel. Every other
  // status describes a run that could still move; a canceled one is terminally over.
  if (outcome?.status === 'canceled') return 'canceled';
  if (suspended) return 'suspended';
  if (outcome?.status === 'failed') return 'failed';
  // The write-ahead half: a run that recorded a start and never recorded an end has NOT completed —
  // saying 'completed' here was the lie the vocabulary used to force. A journal with NO outcome at
  // all (written before outcomes existed) still reads 'completed', exactly as it always did.
  if (outcome?.status === 'running') return 'running';
  return 'completed';
}

/**
 * Derive a summary from a run's entries.
 *
 * `outcome` is optional and separate because it is NOT an entry — it lives in the invisible `:outcome`
 * Key, exactly like threadId lives in `:input`. Callers that have it pass it; callers that do not get
 * The pre-outcome behaviour, which is what every already-written run needs.
 */
export function summarizeRun(
  runId: string,
  entries: JournalEntry[],
  outcome?: Pick<RunOutcomeRecord, 'status'> | null,
): RunSummary {
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
  return { runId, status: deriveRunStatus(suspended, outcome), modelSteps, toolCalls };
}

/**
 * In-memory journal for test/dev. To simulate a real crash, it's enough to keep the same instance
 * Alive across two calls (in real prod, SQLite/Postgres make this durable).
 */
export class InMemoryJournal implements Journal, JournalReader {
  private store = new Map<string, unknown>();
  /** @internal — key renaming for `Storage.adoptIntoOrg`. Not part of the Journal port.
   *  `undefined` from `rename` leaves the entry where it is, which is how platform keys stay put. */
  rekey(rename: (k: string) => string | undefined): number {
    let n = 0;
    for (const k of this.keys()) {
      const to = rename(k);
      if (to === undefined || to === k) continue;
      if (this.store.has(k)) { this.store.set(to, this.store.get(k)!); this.store.delete(k); }
      // Counters live in their own map and `keys()` reports them, so a rekey that skipped them would
      // leave an organization's usage totals stranded at the root while its runs moved.
      if (this.counters.has(k)) { this.counters.set(to, this.counters.get(k)!); this.counters.delete(k); }
      if (this.times.has(k)) { this.times.set(to, this.times.get(k)!); this.times.delete(k); }
      n++;
    }
    return n;
  }
  private times = new Map<string, number>(); // key → first write time (OTEL timing)

  async get<T = unknown>(key: string): Promise<T | undefined> {
    if (!this.store.has(key)) return undefined;
    return structuredClone(this.store.get(key)) as T;
  }

  async put(key: string, value: unknown): Promise<void> {
    if (!this.times.has(key)) this.times.set(key, Date.now());
    this.store.set(key, structuredClone(value));
  }

  // No await between has→set → structurally atomic in single-threaded JS.
  async putIfAbsent(key: string, value: unknown): Promise<boolean> {
    if (this.store.has(key)) return false;
    this.times.set(key, Date.now());
    this.store.set(key, structuredClone(value));
    return true;
  }

  // H1: conditional replace — comparison via stableStringify (in the same spirit as the SQL
  // Adapters' serialize() string equality); NO await between get→compare→set → structurally atomic.
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
  // Single-threaded JS (the same argument as putIfAbsent/putIfMatch above). Mirrors the SQL-transaction/
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
  // Write-path bookkeeping → cannot drift; in RAM this is as cheap as it gets).
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
      // A run's age is the age of its NEWEST key — including the non-entry ones. A run that died
      // Before its first model step has only those, and skipping them left it undateable and so
      // Never swept: its persisted prompt outlived every retention window.
      const owner = p ? p.runId : runIdOfKey(key, value);
      if (!owner) continue;
      const ts = this.times.get(key) ?? 0;
      const cur = last.get(owner) ?? { ts: 0, suspended: false };
      cur.ts = Math.max(cur.ts, ts);
      if (p?.kind === 'tool' && (value as ToolJournalRecord | undefined)?.status === 'suspended') cur.suspended = true;
      last.set(owner, cur);
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

  // P1.6 `keys()`/`listKeys()`/`deletePrefix()` used to only see
  // `this.store` — a key written EXCLUSIVELY via `incrBy` (the `this.counters` map, H8a) never showed
  // Up here and could never be wiped by `deletePrefix`, even though `get`/`getCounters` treat it as the
  // SAME key namespace (the Journal interface doc for `deletePrefix` promises "deletes ALL keys starting
  // With a prefix" — no carve-out for counter-only keys). This surfaced as a real bug: metrics.ts's
  // `rebuildMetrics` deletes `__metrics__:*` counters before recomputing them, and without this fix the
  // Stale counter survives the "wipe" and the recompute silently ADDS ON TOP of it. All three counter keys
  // Are included below wherever store keys are.
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
      if (!p) {
        // Not a replayable entry, but possibly still part of a run. Register the run with NO entries
        // Rather than skipping it, or a run that died before its first model step (which wrote only
        // `:input` and a claim marker) never appears here — and so is never reached by sweepRuns,
        // Leaving its persisted prompt outside every retention window. summarizeRun stays pure: the
        // Entry list it is handed is genuinely empty.
        const owner = runIdOfKey(key, value);
        if (owner && !byRun.has(owner)) byRun.set(owner, []);
        // The write-ahead can be a run's FIRST key — it registers the run even before `:input` does.
        const oc = outcomeStatusOf(key, value);
        if (oc !== null) {
          const runId = key.slice(0, -':outcome'.length);
          if (!byRun.has(runId)) byRun.set(runId, []);
        }
        continue;
      }
      const list = byRun.get(p.runId) ?? [];
      list.push({ key, runId: p.runId, kind: p.kind, value, seq: seq++ });
      byRun.set(p.runId, list);
    }
    // AUDIT (threadId first-class): summarizeRun stays PURE (doesn't see `:input`) — we separately
    // MERGE threadId from the run's invisible `:input` entry. Map.get is O(1) — NOT N+1
    // (doesn't make a separate pass like readRun/listRuns, it's a single point-read from the store we already have).
    return [...byRun.entries()].map(([runId, entries]) => {
      // Same O(1) point-read as `:input` below — the outcome is not an entry, so summarizeRun cannot
      // See it on its own.
      const out = this.store.get(`${runId}:outcome`) as { status?: RunOutcomeRecord['status'] } | undefined;
      const s = summarizeRun(runId, entries, out as never);
      const inp = this.store.get(`${runId}:input`) as { threadId?: string; agent?: string; resourceId?: string } | undefined;
      return {
        ...s,
        ...(inp?.threadId ? { threadId: inp.threadId } : {}),
        ...(inp?.agent ? { agent: inp.agent } : {}),
        ...(inp?.resourceId ? { resourceId: inp.resourceId } : {}),
      };
    });
  }

  /**
   * P0.3 paginated + filtered sibling of `listRuns()` above — see the
   * `JournalReader.listRunsPaged` JSDoc for the filter-semantics contract. In-memory reference
   * Implementation: derive the full array (already O(store size), same cost `listRuns()` pays), filter,
   * Then offset-paginate — mirroring the numeric cursor-as-offset convention every adapter's own
   * `offset()`/`paginate()` helper uses (sqlite-storage.ts/postgres-storage.ts/redis-storage.ts/
   * In-memory-storage.ts), so a cursor produced by one path is interchangeable with the others.
   */
  async listRunsPaged(q?: RunListQuery): Promise<{ items: RunSummary[]; nextCursor?: string }> {
    let all = await this.listRuns();
    if (q?.status) all = all.filter((r) => r.status === q.status);
    if (q?.agent) all = all.filter((r) => r.agent === q.agent);
    if (q?.resourceId) all = all.filter((r) => r.resourceId === q.resourceId);
    const start = q?.cursor ? Number(q.cursor) || 0 : 0;
    const limit = q?.limit ?? 50;
    const items = all.slice(start, start + limit);
    const next = start + limit;
    return { items, nextCursor: next < all.length ? String(next) : undefined };
  }
}
