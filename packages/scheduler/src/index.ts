// @gnl/scheduler — durable workflow scheduler on top of @gnl/durable.
// Keeps triggers in the journal (definition immutable, state mutable). The poll loop (now=Date.now())
// fires due triggers exactly-once (acquireRunLock + per-fireCount runId). The workflow run carries its
// own durable guarantee. Time = DATA (nextRunAt in the journal) → resolve-then-freeze, replay-safe.
import { acquireRunLock, createPollLoop } from '@gnl/durable';
import type { Journal } from '@gnl/durable';
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
 * CALLED). Throws on overage (typically `@gnl/durable`'s `assertBudget` — `BudgetExceededError`);
 * `pollScheduler` does NOT RUN this trigger (skip + records/logs to `sched:budget-skip:<id>`,
 * `out.skipped` increments), state is DEFERRED to retry after `retryMs` but `attempts` DOES NOT
 * increase (a budget overage isn't the workflow's fault → doesn't count toward maxAttempts, `status`
 * stays 'pending'). IF NOT GIVEN (default) behavior is UNCHANGED — no quota check (backward compat).
 * Typical host usage:
 *   budgetGuard: () => assertBudget(journal, { orgId, fallback })
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
 * elapsed time → poll delay doesn't accumulate drift (part b). Missed occurrences are skipped or caught
 * up in sequence depending on policy (part a).
 */
function computeNext(def: TriggerDef, prevSlot: number, now: number): number {
  if (def.kind === 'every') {
    const interval = def.value as number;
    if (def.misfire === 'catchup') return prevSlot + interval; // next missed occurrence — may be due again immediately
    const missed = Math.floor((now - prevSlot) / interval); // number of fully missed intervals (0 = on time)
    return prevSlot + interval * (missed + 1); // aligned to the planned grid, the first slot right after now
  }
  // cron: nextCronTime already works off the absolute time grid (no drift). The policy difference is
  // where the scan starts from: 'catchup' starts from the last planned slot (finds the next missed one,
  // may be due immediately), 'skip' starts from the current time (skips everything missed, jumps to the
  // next future match).
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
 * the real exactly-once guarantee comes from the durable workflow run (per-fireCount runId).
 */
export async function pollScheduler(
  journal: Journal,
  runner: WorkflowRunner,
  now: number = Date.now(),
  opts: { owner?: string; retryMs?: number; budgetGuard?: BudgetGuard } = {},
): Promise<PollResult> {
  if (!journal.listKeys) throw new Error('@gnl/scheduler: journal.listKeys is required (trigger enumeration)');
  const owner = opts.owner ?? `sched-${Math.random().toString(36).slice(2, 8)}`;
  const retryMs = opts.retryMs ?? 30_000;
  const out: PollResult = { fired: 0, rescheduled: 0, failed: 0, skipped: 0 };

  const defKeys = await journal.listKeys('sched:def:');
  for (const dkey of defKeys) {
    const id = dkey.slice('sched:def:'.length);
    const def = await journal.get<TriggerDef>(DEF(id));
    const state = await journal.get<TriggerState>(STATE(id));
    if (!def || !state || state.status !== 'pending' || now < state.nextRunAt) continue;

    const runId = `sched:${id}:${state.fireCount}`;
    const lock = await acquireRunLock(journal, runId, owner, 60_000, now);
    if (!lock) continue; // another poller holds this fire
    try {
      // 1.4: optional budget/quota hook — checked before runner.runWorkflow is CALLED.
      if (opts.budgetGuard) {
        try {
          await opts.budgetGuard({ triggerId: id, workflowName: def.name, input: def.input, now });
        } catch (e) {
          await journal.put(STATE(id), { ...state, nextRunAt: now + retryMs }); // attempts DOES NOT increase
          await journal.put(BUDGET_SKIP(id), { error: String((e as any)?.message ?? e), at: now });
          out.skipped++;
          continue;
        }
      }
      let result: { suspended?: boolean; output?: unknown };
      try {
        result = await runner.runWorkflow(def.name, def.input, { runId });
      } catch (e) {
        const attempts = state.attempts + 1;
        if (attempts >= def.maxAttempts) {
          await journal.put(STATE(id), { ...state, attempts, status: 'failed' });
          await journal.put(FAIL(id), { error: String((e as any)?.message ?? e), at: now });
          out.failed++;
        } else {
          await journal.put(STATE(id), { ...state, attempts, nextRunAt: now + backoff(attempts) });
          out.rescheduled++;
        }
        continue;
      }

      if (result.suspended) {
        // workflow suspended → the same runId should be resumed later (fireCount unchanged).
        await journal.put(STATE(id), { ...state, nextRunAt: now + retryMs });
        out.rescheduled++;
      } else if (def.kind === 'at') {
        await journal.put(STATE(id), { ...state, status: 'done' });
        out.fired++;
      } else {
        await journal.put(STATE(id), {
          nextRunAt: computeNext(def, state.nextRunAt, now),
          attempts: 0,
          fireCount: state.fireCount + 1,
          status: 'pending',
        });
        out.fired++;
      }
    } finally {
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
 * as `pollScheduler`; does NOT change any state, does not take a lock, does not run a workflow. Returns
 * results sorted alphabetically by id (stable list order).
 */
export async function listTriggers(journal: Journal): Promise<TriggerInfo[]> {
  if (!journal.listKeys) throw new Error('@gnl/scheduler: listTriggers requires journal.listKeys (trigger enumeration)');
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
 * @gnl/queue's createWorker. `backoff` (default OFF — timing is the scheduler's core contract, see the
 * trade-off below): IF ENABLED, when a poll fires NO triggers at all (`fired === 0`) the next poll
 * interval grows ×2 (cap: `maxPollMs ?? pollMs*32`) → prevents tens of thousands of empty queries per
 * second (poll storm) on an empty schedule table; the interval resets to `pollMs` once a trigger fires.
 * Trade-off: `backoff: true` cuts idle poll load by ~32x but can delay a trigger that becomes due after
 * a quiet period by up to `maxPollMs` — for timing-critical use (e.g. minute-level cron) the default
 * should stay OFF; only enable it for deployments with many idle-poller instances that can tolerate delay.
 */
export function createScheduler(
  journal: Journal,
  runner: WorkflowRunner,
  opts: { pollMs?: number; owner?: string; retryMs?: number; backoff?: boolean; maxPollMs?: number; budgetGuard?: BudgetGuard } = {},
): Scheduler {
  const pollMs = opts.pollMs ?? 1000;
  const backoffOn = opts.backoff ?? false;
  const maxPollMs = opts.maxPollMs ?? pollMs * 32;
  const poll = (now: number = Date.now()) =>
    pollScheduler(journal, runner, now, { owner: opts.owner, retryMs: opts.retryMs, budgetGuard: opts.budgetGuard });

  // Phase 8.1: the tick/backoff/"polling" flag loop now lives in @gnl/durable's shared createPollLoop
  // (it used to be triplicated across queue/events/scheduler) — behavior is identical: pollScheduler only
  // catches runWorkflow errors internally; the rest (journal I/O etc.) are logged and swallowed by
  // createPollLoop (the chain doesn't die). While `fired === 0` and backoffOn, the interval grows ×2
  // (cap maxPollMs); it resets to pollMs once something fires. Default backoff is OFF (see the comment
  // above — timing-critical).
  const loop = createPollLoop(async () => (await poll()).fired > 0, { pollMs, backoff: backoffOn, maxPollMs });

  return {
    poll,
    start: loop.start,
    stop: loop.stop,
  };
}
