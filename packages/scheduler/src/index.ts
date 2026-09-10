// @gnldev/scheduler — durable workflow scheduler on top of @gnldev/durable.
// Keeps triggers in the journal (definition immutable, state mutable). The poll loop (now=Date.now())
// Fires due triggers exactly-once (acquireRunLock + per-fireCount runId). The workflow run carries its
// Own durable guarantee. Time = DATA (nextRunAt in the journal) → resolve-then-freeze, replay-safe.
import { acquireRunLock, createPollLoop } from '@gnldev/durable';
import type { Journal } from '@gnldev/durable';
import { nextCronTime } from './cron.js';

export { nextCronTime, parseField } from './cron.js';
export { createWorkflowWaker } from './workflow-waker.js';
export type { WorkflowWaker, WorkflowWakerOptions, WorkflowWakerTickResult } from './workflow-waker.js';

/** Structurally compatible with what createGnl returns — no hard dependency. */
export interface WorkflowRunner {
  runWorkflow(
    name: string,
    input: unknown,
    opts?: { runId?: string },
  ): Promise<{ runId: string; suspended?: boolean; output?: unknown }>;
}

export interface ScheduleSpec {
  /** Trigger id (idempotent record; `name` is used if not given). */
  id?: string;
  /** Workflow name to run (passed to runner.runWorkflow). */
  name: string;
  input?: unknown;
  /** Absolute time (epoch ms) — one-shot. */
  at?: number;
  /** Period (ms) — repeats every interval. */
  every?: number;
  /** 5-field cron (UTC, minute resolution) — repeats on every match. */
  cron?: string;
  /** Max attempts on failure (default 5). */
  maxAttempts?: number;
  /**
   * Policy for missed (misfire) fires — only meaningful for every/cron:
   * 'skip'    (default) — skip missed fires, jump to the next slot aligned to the planned grid (no drift accumulates).
   * 'catchup' — fire each missed occurrence in sequence (one per poll), none are skipped.
   */
  misfire?: MisfirePolicy;
}

export type Kind = 'at' | 'every' | 'cron';
export type MisfirePolicy = 'skip' | 'catchup';
interface TriggerDef {
  name: string;
  input: unknown;
  kind: Kind;
  value: number | string;
  maxAttempts: number;
  misfire: MisfirePolicy;
}
interface TriggerState {
  nextRunAt: number;
  attempts: number;
  fireCount: number;
  status: 'pending' | 'done' | 'failed';
}

const DEF = (id: string) => `sched:def:${id}`;
const STATE = (id: string) => `sched:state:${id}`;
const FAIL = (id: string) => `sched:fail:${id}`;
const BUDGET_SKIP = (id: string) => `sched:budget-skip:${id}`;

/**
 * 1.4: optional budget/quota hook — called BEFORE the trigger starts (before runner.runWorkflow is
 * CALLED). Throws on overage (typically `@gnldev/durable`'s `assertBudget` — `BudgetExceededError`);
 * `pollScheduler` does NOT RUN this trigger (skip + records/logs to `sched:budget-skip:<id>`,
 * `out.skipped` increments), state is DEFERRED to retry after `retryMs` but `attempts` DOES NOT
 * Increase (a budget overage isn't the workflow's fault → doesn't count toward maxAttempts, `status`
 * Stays 'pending'). IF NOT GIVEN (default) behavior is UNCHANGED — no quota check (backward compat).
 * Typical host usage:
 *   BudgetGuard: () => assertBudget(journal, { orgId, fallback })
 * Kept simple: the scheduler does NOT EMBED quota logic itself, the host injects it (same pattern as limits/guard).
 */
export type BudgetGuard = (ctx: { triggerId: string; workflowName: string; input: unknown; now: number }) => Promise<unknown> | unknown;

function firstRunAt(spec: ScheduleSpec, now: number): number {
  if (spec.at != null) return spec.at;
  if (spec.every != null) return now + spec.every;
  if (spec.cron != null) return nextCronTime(spec.cron, now);
  throw new Error('scheduleWorkflow: one of at | every | cron is required');
}
/**
 * Computes the next fire time. `prevSlot` = the PLANNED slot that just fired (state.nextRunAt) —
 * NOT `now` (poll time). This aligns the 'every' calculation to the planned grid rather than the actual
 * Elapsed time → poll delay doesn't accumulate drift (part b). Missed occurrences are skipped or caught
 * Up in sequence depending on policy (part a).
 */
function computeNext(def: TriggerDef, prevSlot: number, now: number): number {
  if (def.kind === 'every') {
    const interval = def.value as number;
    if (def.misfire === 'catchup') return prevSlot + interval; // next missed occurrence — may be due again immediately
    const missed = Math.floor((now - prevSlot) / interval); // number of fully missed intervals (0 = on time)
    return prevSlot + interval * (missed + 1); // aligned to the planned grid, the first slot right after now
  }
  // Cron: nextCronTime already works off the absolute time grid (no drift). The policy difference is
  // Where the scan starts from: 'catchup' starts from the last planned slot (finds the next missed one,
  // May be due immediately), 'skip' starts from the current time (skips everything missed, jumps to the
  // Next future match).
  return def.misfire === 'catchup' ? nextCronTime(def.value as string, prevSlot) : nextCronTime(def.value as string, now);
}
function backoff(attempts: number): number {
  return Math.min(1000 * 2 ** (attempts - 1), 60_000);
}

/** Schedules a workflow (at | every | cron). Idempotent: repeating with the same id = no-op. Returns the id. */
export async function scheduleWorkflow(journal: Journal, spec: ScheduleSpec, now: number = Date.now()): Promise<string> {
  const id = spec.id ?? spec.name;
  if ((await journal.get(DEF(id))) === undefined) {
    const kind: Kind = spec.at != null ? 'at' : spec.every != null ? 'every' : 'cron';
    const value: number | string = spec.at ?? spec.every ?? spec.cron!;
    const def: TriggerDef = {
      name: spec.name,
      input: spec.input,
      kind,
      value,
      maxAttempts: spec.maxAttempts ?? 5,
      misfire: spec.misfire ?? 'skip',
    };
    await journal.put(DEF(id), def);
    const state: TriggerState = { nextRunAt: firstRunAt(spec, now), attempts: 0, fireCount: 0, status: 'pending' };
    await journal.put(STATE(id), state);
  }
  return id;
}

export interface PollResult {
  fired: number;
  rescheduled: number;
  failed: number;
  /** 1.4: number of triggers NOT RUN because `budgetGuard` was given and threw on overage (always 0 without a guard). */
  skipped: number;
}

/**
 * Fires triggers that are due ('pending' && now≥nextRunAt). Double-firing is prevented via the run-lock;
 * The real exactly-once guarantee comes from the durable workflow run (per-fireCount runId).
 *
 * Y2: the lock is kept alive by a heartbeat while the workflow runs (`lockTtlMs`, default 60s, renewed
 * Every ttl/3) — a long workflow no longer lets a second poller take the fire over. And EVERY state
 * Write is a CAS (`putIfMatch`) against the state read at the start of the fire, so even if a takeover
 * Does happen the late poller cannot write its stale result back.
 */
export async function pollScheduler(
  journal: Journal,
  runner: WorkflowRunner,
  now: number = Date.now(),
  opts: { owner?: string; retryMs?: number; budgetGuard?: BudgetGuard; lockTtlMs?: number } = {},
): Promise<PollResult> {
  if (!journal.listKeys) throw new Error('@gnldev/scheduler: journal.listKeys is required (trigger enumeration)');
  const owner = opts.owner ?? `sched-${Math.random().toString(36).slice(2, 8)}`;
  const retryMs = opts.retryMs ?? 30_000;
  const lockTtlMs = opts.lockTtlMs ?? 60_000;
  const out: PollResult = { fired: 0, rescheduled: 0, failed: 0, skipped: 0 };

  const defKeys = await journal.listKeys('sched:def:');
  for (const dkey of defKeys) {
    const id = dkey.slice('sched:def:'.length);
    const def = await journal.get<TriggerDef>(DEF(id));
    const state = await journal.get<TriggerState>(STATE(id));
    if (!def || !state || state.status !== 'pending' || now < state.nextRunAt) continue;

    const runId = `sched:${id}:${state.fireCount}`;
    const lock = await acquireRunLock(journal, runId, owner, lockTtlMs, now);
    if (!lock) {
      // SESSİZ DEĞİL: bu dal `out.skipped`'a da yazmıyordu, log da basmıyordu — yani zamanlanmış bir
      // tetik atlandığında hiçbir iz kalmıyordu. Atlama DOĞRU (başka bir poller o ateşlemeyi tutuyor),
      // ama görünmez olması "sessiz-VE-görünmez hiçbir şey olamaz" kuralının ihlali: operatör
      // "tetik çalışmadı mı, atlandı mı, çakıştı mı" sorusunu cevaplayamıyordu.
      out.skipped++;
      continue;
    }

    // Y2 (heartbeat): the lock TTL used to be a FIXED 60s that was never renewed — a workflow running
    // Longer than that let the lock expire, a second poller took it over and fired the SAME trigger
    // Again. The core's `RunLock.renew()` (run-lock.ts) exists exactly for this: "long-running jobs
    // Should call this at an interval shorter than the ttl". We renew every ttl/3 for as long as the
    // Trigger is in flight — the same pattern as @gnldev/queue's createWorker.
    // A renew returning FALSE (a real takeover) or THROWING (a transient journal hiccup) is only
    // LOGGED here: it deliberately does NOT gate the STATE WRITES below, because those are already
    // Gated by something stronger and exact — see `commit`. A `lockLost` flag (the queue's approach)
    // Would be a delayed approximation for that job and can be flipped by a mere network blip.
    // KNOWN LIMIT — the CAS covers the WRITE, not the EXECUTION: when renew() returns false the
    // Workflow this poller already started KEEPS RUNNING to completion, so during a takeover window
    // The same runId can be in flight in two pollers at once (only one of them can commit). The
    // Durable run's own per-runId guarantee is what keeps that convergent; making the poller actually
    // STOP would need runWorkflow's AbortSignal to be plumbed through from here — it is not, today.
    // A `lockLost` flag would not have fixed this either (the workflow is already running).
    const heartbeat = setInterval(() => {
      lock
        .renew(lockTtlMs)
        .then((ok) => {
          if (!ok) console.warn(`[scheduler] the lock was taken over (trigger ${id}, run ${runId}) — the CAS on the state write will decide the result.`);
        })
        .catch((err) => console.warn(`[scheduler] renew transient error (trigger ${id}), the next tick will retry:`, err));
    }, Math.max(1, Math.floor(lockTtlMs / 3)));

    // Fencing: every state write is a CAS against the state we read AT THE START of this fire
    // (`expected = state`). CAS — not a "do I still hold the lock?" hunch — is the AUTHORITY FOR THE
    // WRITE (and only for the write; execution is not fenced, see the KNOWN LIMIT above): the
    // Lock is advisory and any ownership check is inherently a read at a point in time (it can go
    // Stale between the check and the write), whereas putIfMatch decides ATOMICALLY at write time,
    // Inside the journal. If somebody else advanced the trigger (took the fire over and wrote its
    // Own result), our record no longer matches and this write is REJECTED — a late poller can no
    // Longer roll fireCount/nextRunAt back or resurrect `attempts`. The write of the poller that
    // Genuinely holds the lock always matches, so a correct poller is never blocked.
    // A journal WITHOUT putIfMatch falls back to an unconditional put (old behavior, documented risk
    // — the same fallback as run-lock.ts / claim()).
    const commit = async (next: TriggerState, what: string): Promise<boolean> => {
      if (!journal.putIfMatch) {
        await journal.put(STATE(id), next);
        return true;
      }
      if (await journal.putIfMatch(STATE(id), state, next)) return true;
      console.warn(`[scheduler] stale state write rejected (trigger ${id}, ${what}) — another poller advanced this trigger; this poller's result is DISCARDED.`);
      return false;
    };

    try {
      // 1.4: optional budget/quota hook — checked before runner.runWorkflow is CALLED.
      if (opts.budgetGuard) {
        try {
          await opts.budgetGuard({ triggerId: id, workflowName: def.name, input: def.input, now });
        } catch (e) {
          // attempts DOES NOT increase; the diagnostic record is only written if the CAS was won (a
          // Stale poller must not leave a budget-skip note on someone else's fire either).
          if (await commit({ ...state, nextRunAt: now + retryMs }, 'budget-skip')) {
            await journal.put(BUDGET_SKIP(id), { error: String((e as any)?.message ?? e), at: now });
            out.skipped++;
          }
          continue;
        }
      }
      let result: { suspended?: boolean; output?: unknown };
      try {
        result = await runner.runWorkflow(def.name, def.input, { runId });
      } catch (e) {
        const attempts = state.attempts + 1;
        if (attempts >= def.maxAttempts) {
          if (await commit({ ...state, attempts, status: 'failed' }, 'failed')) {
            await journal.put(FAIL(id), { error: String((e as any)?.message ?? e), at: now });
            out.failed++;
          }
        } else if (await commit({ ...state, attempts, nextRunAt: now + backoff(attempts) }, 'retry')) {
          out.rescheduled++;
        }
        continue;
      }

      if (result.suspended) {
        // Workflow suspended → the same runId should be resumed later (fireCount unchanged).
        if (await commit({ ...state, nextRunAt: now + retryMs }, 'suspended')) out.rescheduled++;
      } else if (def.kind === 'at') {
        if (await commit({ ...state, status: 'done' }, 'done')) out.fired++;
      } else {
        const next: TriggerState = {
          nextRunAt: computeNext(def, state.nextRunAt, now),
          attempts: 0,
          fireCount: state.fireCount + 1,
          status: 'pending',
        };
        if (await commit(next, 'reschedule')) out.fired++;
      }
    } finally {
      // MUST run BEFORE release(): release() keeps the SAME fencing token (it only pushes `expires`
      // Into the past), so a heartbeat tick that survives this fire would find its own token still in
      // The record and RESURRECT the lock it just released (expires: 0 → now+ttl) — blocking every
      // Later poll of the same runId (a suspended trigger's resume, most visibly). Pinned by test.
      clearInterval(heartbeat);
      // If the lock was genuinely taken over, release() is a no-op anyway (the fencing token no
      // Longer matches — run-lock.ts mkLock.release), so we never free somebody else's lock.
      await lock.release();
    }
  }
  return out;
}

/** Introspection view of a single trigger (for the Studio Scheduler view). */
export interface TriggerInfo {
  id: string;
  name: string;
  kind: Kind;
  /** kind='at' → absolute time (epoch ms); kind='every' → period (ms); kind='cron' → 5-field cron expression. */
  value: number | string;
  input?: unknown;
  /** Next (planned) fire time, epoch ms — if in the past, the trigger is due/overdue. */
  nextRunAt: number;
  attempts: number;
  maxAttempts: number;
  fireCount: number;
  status: 'pending' | 'done' | 'failed';
  misfire: MisfirePolicy;
  /** Last error if status='failed' (if any, from `sched:fail:<id>`). */
  lastError?: string;
  lastErrorAt?: number;
}

/**
 * READ-ONLY trigger listing from the journal, WITHOUT needing a scheduler INSTANCE or a runner (for
 * Studio introspection). Reads the SAME `sched:def:`/`sched:state:` keys (+ `sched:fail:` for 'failed')
 * As `pollScheduler`; does NOT change any state, does not take a lock, does not run a workflow. Returns
 * Results sorted alphabetically by id (stable list order).
 */
export async function listTriggers(journal: Journal): Promise<TriggerInfo[]> {
  if (!journal.listKeys) throw new Error('@gnldev/scheduler: listTriggers requires journal.listKeys (trigger enumeration)');
  const defKeys = await journal.listKeys('sched:def:');
  const out: TriggerInfo[] = [];
  for (const dkey of defKeys) {
    const id = dkey.slice('sched:def:'.length);
    const def = await journal.get<TriggerDef>(DEF(id));
    const state = await journal.get<TriggerState>(STATE(id));
    if (!def || !state) continue; // inconsistent/partial record (theoretical) — skip
    const info: TriggerInfo = {
      id,
      name: def.name,
      kind: def.kind,
      value: def.value,
      input: def.input,
      nextRunAt: state.nextRunAt,
      attempts: state.attempts,
      maxAttempts: def.maxAttempts,
      fireCount: state.fireCount,
      status: state.status,
      misfire: def.misfire,
    };
    if (state.status === 'failed') {
      const fail = await journal.get<{ error: string; at: number }>(FAIL(id));
      if (fail) {
        info.lastError = fail.error;
        info.lastErrorAt = fail.at;
      }
    }
    out.push(info);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export interface Scheduler {
  poll(now?: number): Promise<PollResult>;
  start(): void;
  stop(): void;
}

/**
 * Scheduler that manages the poll loop (a self-rescheduling setTimeout chain) — the same pattern as
 * @gnldev/queue's createWorker. `backoff` (default OFF — timing is the scheduler's core contract, see the
 * Trade-off below): IF ENABLED, when a poll fires NO triggers at all (`fired === 0`) the next poll
 * Interval grows ×2 (cap: `maxPollMs ?? pollMs*32`) → prevents tens of thousands of empty queries per
 * Second (poll storm) on an empty schedule table; the interval resets to `pollMs` once a trigger fires.
 * Trade-off: `backoff: true` cuts idle poll load by ~32x but can delay a trigger that becomes due after
 * A quiet period by up to `maxPollMs` — for timing-critical use (e.g. minute-level cron) the default
 * Should stay OFF; only enable it for deployments with many idle-poller instances that can tolerate delay.
 */
export function createScheduler(
  journal: Journal,
  runner: WorkflowRunner,
  opts: { pollMs?: number; owner?: string; retryMs?: number; backoff?: boolean; maxPollMs?: number; budgetGuard?: BudgetGuard; lockTtlMs?: number } = {},
): Scheduler {
  const pollMs = opts.pollMs ?? 1000;
  const backoffOn = opts.backoff ?? false;
  const maxPollMs = opts.maxPollMs ?? pollMs * 32;
  const poll = (now: number = Date.now()) =>
    pollScheduler(journal, runner, now, { owner: opts.owner, retryMs: opts.retryMs, budgetGuard: opts.budgetGuard, lockTtlMs: opts.lockTtlMs });

  // Phase 8.1: the tick/backoff/"polling" flag loop now lives in @gnldev/durable's shared createPollLoop
  // (it used to be triplicated across queue/events/scheduler) — behavior is identical: pollScheduler only
  // Catches runWorkflow errors internally; the rest (journal I/O etc.) are logged and swallowed by
  // CreatePollLoop (the chain doesn't die). While `fired === 0` and backoffOn, the interval grows ×2
  // (cap maxPollMs); it resets to pollMs once something fires. Default backoff is OFF (see the comment
  // Above — timing-critical).
  const loop = createPollLoop(async () => (await poll()).fired > 0, { pollMs, backoff: backoffOn, maxPollMs });

  return {
    poll,
    start: loop.start,
    stop: loop.stop,
  };
}
