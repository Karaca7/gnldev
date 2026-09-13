// @gnldev/scheduler — durable workflow scheduler on top of @gnldev/durable.
// Keeps triggers in the journal (definition immutable, state mutable). The poll loop (now=Date.now())
// fires due triggers exactly-once (acquireRunLock + per-fireCount runId). The workflow run carries its
// own durable guarantee. Time = DATA (nextRunAt in the journal) → resolve-then-freeze, replay-safe.
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
const BUSY_SKIP = (id: string) => `sched:busy-skip:${id}`;

/**
 * THE FIRE LOCK'S KEY — deliberately NOT the runId.
 *
 * This lock answers "is another POLLER firing this occurrence?". The runId's own lock answers "is
 * this RUN executing anywhere?". Two different questions, and for a long time they were written to
 * the same place: `acquireRunLock(journal, runId, …)` produces `<runId>:lock`, so a poller holding
 * the fire lock was holding the run's lock too.
 *
 * That was invisible until a run started taking its own lock. Measured, in a `preset: 'critical'`
 * app: the poller locked `sched:saglik-5dk:0:lock`, then called `runWorkflow` with that same runId,
 * and the critical preset's run-lock (registry.ts) found the key occupied and refused —
 * `RunBusyError`, "already running, locked by another process". The other process was the caller.
 * Five polls, five refusals, `status: 'failed'`, and not one step ever ran. Nothing raced; it simply
 * could not work.
 *
 * The two locks now live on separate keys and are free to be held at the same time, which is the
 * correct arrangement: they nest rather than compete. Fire exclusivity is unchanged (the key is still
 * per-occurrence and still CAS-claimed).
 *
 * SUFFIXED rather than moved to a `sched:fire:…` namespace of its own, and that is not a style
 * choice. `<runId>:fire:lock` stays UNDER the run's own key prefix, which is the prefix `purgeRun` /
 * `sweepRuns` delete by — a sibling namespace would have left one small orphan record per fire
 * behind forever, and a five-minute trigger fires a hundred thousand times a year. `parseJournalKey`
 * still ignores it (it claims only `:model:`/`:tool:`), so it stays invisible to replay exactly as
 * `<runId>:lock` always has.
 *
 * MIXED-VERSION NOTE, honestly: during a rolling deploy an old poller and a new one hold DIFFERENT
 * keys for the same occurrence, so both can start the fire. That window is covered by what already
 * covers every other lock loss here — the state write is a CAS (`commit`), so only one poller's
 * result is recorded, and under the critical preset the run's own lock refuses the second executor
 * outright. UNDER THE CRITICAL PRESET it degrades to documented takeover behaviour, not to a double
 * side effect; a non-critical preset has no run lock, so two executors in this window CAN each run a
 * side-effecting tool once — drain the pollers over an upgrade if that matters to the workflow.
 */
const FIRE_LOCK = (runId: string) => `${runId}:fire`;

/**
 * "Somebody else is already running this exact run" — the durable engine's refusal AT LOCK
 * ACQUISITION, before the run did anything (`registry.ts` for the critical workflow path,
 * `run.ts` for the agent paths; both stamp `atLockAcquisition`).
 *
 * This is NOT a failed attempt. Nothing was tried and nothing went wrong: the work is in flight
 * somewhere else, and the only sane response is to come back later. Counting it against
 * `maxAttempts` is how a busy minute becomes a permanently dead trigger — which is exactly what the
 * live finding was, five deferrals spent as five failures.
 *
 * Deliberately narrower than durable's own `classifyRunError`: that helper also calls a compensated
 * or cancelled run "not a failure", and it is right to, but those are TERMINAL — deferring them
 * would retry them forever. A MID-FLIGHT `RunBusyError` (no `atLockAcquisition`: this poller got in,
 * ran, and was fenced out by a concurrent executor) is left as an ordinary failure for the same
 * reason: something did happen, and it is worth a retry budget.
 *
 * Matched by NAME, not `instanceof`: `@gnldev/durable` is a peer dependency here, and a host with
 * two resolved copies of it would silently fail every `instanceof` check — a lock refusal is not
 * where a version skew should get to change the behaviour.
 */
function isRunBusyAtAcquisition(e: unknown): boolean {
  return (e as { name?: string } | null)?.name === 'RunBusyError'
    && (e as { atLockAcquisition?: boolean }).atLockAcquisition === true;
}

/**
 * 1.4: optional budget/quota hook — called BEFORE the trigger starts (before runner.runWorkflow is
 * CALLED). Throws on overage (typically `@gnldev/durable`'s `assertBudget` — `BudgetExceededError`);
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

/**
 * Where a REPAIRED trigger's fire counter has to start, and why it is not zero.
 *
 * `fireCount` is not bookkeeping: it is part of the run's id (`sched:<id>:<fireCount>`), and a
 * durable run is exactly-once PER ID. A repair that started the counter at 0 would point the first
 * fire at a run that already completed — the engine would hand back the recorded answer, no step
 * would execute, the counter would tick to 1 and do it again. The trigger would look alive on every
 * dashboard and do nothing, which is the same silence this repair exists to end.
 *
 * So the journal is asked what it already knows: the highest `<n>` that ever appeared under this
 * trigger's own key prefix, plus one. Every fire leaves something there — the run's entries, and the
 * fire lock even when the run itself was swept — so the answer is a floor, not a guess.
 *
 * WITHOUT `listKeys` there is no honest answer and it returns 0, which is the historical behaviour of
 * a fresh trigger. That is stated rather than hidden: `pollScheduler` already REQUIRES `listKeys`, so
 * a journal that lacks it cannot run this scheduler at all, and this path is reachable only by a host
 * that schedules through one journal and polls through another.
 */
async function fireCountAfterLoss(journal: Journal, id: string): Promise<number> {
  if (!journal.listKeys) return 0;
  const prefix = `sched:${id}:`;
  let highest = -1;
  try {
    for (const key of await journal.listKeys(prefix)) {
      const n = /^(\d+)(?::|$)/.exec(key.slice(prefix.length));
      if (n) highest = Math.max(highest, Number(n[1]));
    }
  } catch {
    return 0; // a reader that cannot answer is not evidence that nothing ever fired — but see the warn
  }
  return highest + 1;
}

/** Schedules a workflow (at | every | cron). Idempotent: repeating with the same id = no-op. Returns the id. */
export async function scheduleWorkflow(journal: Journal, spec: ScheduleSpec, now: number = Date.now()): Promise<string> {
  const id = spec.id ?? spec.name;
  if ((await journal.get(DEF(id))) !== undefined) {
    /**
     * THE DEFINITION EXISTS. That used to end the function — and it was reading only half the record.
     *
     * A trigger is two entries written together, `sched:def:<id>` and `sched:state:<id>`, and only the
     * second one can be lost on its own: the definition is immutable and nothing rewrites it, while
     * the state is written on every fire and is what a too-wide purge or a retention sweep takes. Once
     * it is gone the trigger is not broken loudly, it is INVISIBLE — `pollScheduler` skips it on its
     * `!state` branch, `listTriggers` drops it as a "partial record" so it is absent from Studio, and
     * this function said "already scheduled" to every restart. Nothing fires and nothing complains.
     * Measured in production: the discovery was somebody noticing that work had not happened.
     *
     * The repair belongs HERE because this is the only place that still holds the spec. `firstRunAt`
     * needs `at | every | cron`, and neither the poller nor a listing has them — they have a def, but
     * a def that has already lost its state has no honest "next time" either. Hosts already call this
     * on every boot (that is the idempotency promise), so the trigger for the repair is free.
     *
     * DEF + STATE BOTH PRESENT: nothing is written, not even the definition. A running trigger's
     * schedule is not silently redefined by a redeploy — that is today's behaviour and it stays.
     */
    if ((await journal.get(STATE(id))) === undefined) {
      const state: TriggerState = {
        nextRunAt: firstRunAt(spec, now),
        attempts: 0,
        fireCount: await fireCountAfterLoss(journal, id),
        status: 'pending',
      };
      await journal.put(STATE(id), state);
      // LOUD, and deliberately not a debug line. A system that heals itself in silence never shows
      // the operator the thing that keeps breaking it — and what breaks this is usually a purge or a
      // retention rule that runs again next week. `attempts` is reset because the previous attempt
      // history is genuinely gone; the trigger is honestly starting over.
      console.warn(
        `[scheduler] orphaned trigger state repaired (trigger ${id}, workflow ${spec.name}) — the definition was in the journal but 'sched:state:${id}' was missing, so the trigger was invisible to the poller AND to listTriggers, and could not have fired again. A fresh state was written: nextRunAt=${state.nextRunAt}, attempts=0, fireCount=${state.fireCount}. Find out what deleted it (a too-wide purge or a retention sweep is the usual cause) — this will happen again otherwise.`,
      );
    }
    return id;
  }
  // A trigger nobody has seen before: both halves are written here, and only here.
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
  return id;
}

export interface PollResult {
  fired: number;
  rescheduled: number;
  failed: number;
  /**
   * Triggers that were NOT RUN and are NOT a failure — the three deferral reasons, counted together
   * because they mean the same thing to a caller ("nothing happened, come back later"):
   *   - another poller holds the fire lock for this occurrence (no record; the lock IS the record),
   *   - `budgetGuard` was given and threw on overage (`sched:budget-skip:<id>`),
   *   - the run is already in flight elsewhere (`sched:busy-skip:<id>`).
   * None of them consume an attempt. Without a guard and without contention this stays 0.
   */
  skipped: number;
}

/**
 * Fires triggers that are due ('pending' && now≥nextRunAt). Double-firing is prevented via the run-lock;
 * the real exactly-once guarantee comes from the durable workflow run (per-fireCount runId).
 *
 * Y2: the lock is kept alive by a heartbeat while the workflow runs (`lockTtlMs`, default 60s, renewed
 * every ttl/3) — a long workflow no longer lets a second poller take the fire over. And EVERY state
 * write is a CAS (`putIfMatch`) against the state read at the start of the fire, so even if a takeover
 * does happen the late poller cannot write its stale result back.
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
    // The fire lock, on its OWN key — see FIRE_LOCK. `runId` below is the RUN's name and is passed to
    // the runner untouched; the two must not be the same lock.
    const lock = await acquireRunLock(journal, FIRE_LOCK(runId), owner, lockTtlMs, now);
    if (!lock) {
      // SESSİZ DEĞİL: bu dal `out.skipped`'a da yazmıyordu, log da basmıyordu — yani zamanlanmış bir
      // tetik atlandığında hiçbir iz kalmıyordu. Atlama DOĞRU (başka bir poller o ateşlemeyi tutuyor),
      // ama görünmez olması "sessiz-VE-görünmez hiçbir şey olamaz" kuralının ihlali: operatör
      // "tetik çalışmadı mı, atlandı mı, çakıştı mı" sorusunu cevaplayamıyordu.
      out.skipped++;
      continue;
    }

    // Y2 (heartbeat): the lock TTL used to be a FIXED 60s that was never renewed — a workflow running
    // longer than that let the lock expire, a second poller took it over and fired the SAME trigger
    // again. The core's `RunLock.renew()` (run-lock.ts) exists exactly for this: "long-running jobs
    // should call this at an interval shorter than the ttl". We renew every ttl/3 for as long as the
    // trigger is in flight — the same pattern as @gnldev/queue's createWorker.
    // A renew returning FALSE (a real takeover) or THROWING (a transient journal hiccup) is only
    // LOGGED here: it deliberately does NOT gate the STATE WRITES below, because those are already
    // gated by something stronger and exact — see `commit`. A `lockLost` flag (the queue's approach)
    // would be a delayed approximation for that job and can be flipped by a mere network blip.
    // KNOWN LIMIT — the CAS covers the WRITE, not the EXECUTION: when renew() returns false the
    // workflow this poller already started KEEPS RUNNING to completion, so during a takeover window
    // the same runId can be in flight in two pollers at once (only one of them can commit). The
    // durable run's own per-runId guarantee is what keeps that convergent; making the poller actually
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
    // lock is advisory and any ownership check is inherently a read at a point in time (it can go
    // stale between the check and the write), whereas putIfMatch decides ATOMICALLY at write time,
    // inside the journal. If somebody else advanced the trigger (took the fire over and wrote its
    // own result), our record no longer matches and this write is REJECTED — a late poller can no
    // longer roll fireCount/nextRunAt back or resurrect `attempts`. The write of the poller that
    // genuinely holds the lock always matches, so a correct poller is never blocked.
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
          // stale poller must not leave a budget-skip note on someone else's fire either).
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
        // DEFERRAL, not attempt: the run is already in flight elsewhere (see isRunBusyAtAcquisition).
        // `attempts` is untouched, `status` stays 'pending', and — this is the half that cost the live
        // investigation its diagnosis — NOTHING is written to `sched:fail:`. That record is where an
        // operator reads WHY a trigger died, and a run-busy message answers a question nobody asked
        // while burying the answer to the one they did (the live record said "already running"; the
        // real reason the workflow could not run was never written down anywhere).
        //
        // Not silent, though: a deferral that repeats forever is a trigger that never fires, so the
        // record carries a RUNNING TOTAL (never reset — a lifetime count is the number an operator can
        // compare against `fireCount`). There is no cap on purpose: "wait for the other holder" has no
        // honest deadline, and the other side is already bounded by its own lock TTL.
        if (isRunBusyAtAcquisition(e)) {
          if (await commit({ ...state, nextRunAt: now + retryMs }, 'run-busy-skip')) {
            const prev = await journal.get<{ deferrals?: number }>(BUSY_SKIP(id));
            await journal.put(BUSY_SKIP(id), {
              error: String((e as any)?.message ?? e),
              at: now,
              runId,
              deferrals: (prev?.deferrals ?? 0) + 1,
            });
            out.skipped++;
          }
          continue;
        }
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
        // workflow suspended → the same runId should be resumed later (fireCount unchanged).
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
      // into the past), so a heartbeat tick that survives this fire would find its own token still in
      // the record and RESURRECT the lock it just released (expires: 0 → now+ttl) — blocking every
      // later poll of the same runId (a suspended trigger's resume, most visibly). Pinned by test.
      clearInterval(heartbeat);
      // If the lock was genuinely taken over, release() is a no-op anyway (the fencing token no
      // longer matches — run-lock.ts mkLock.release), so we never free somebody else's lock.
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
  /**
   * How many times this trigger was DEFERRED because the run was already in flight elsewhere
   * (`sched:busy-skip:<id>`, lifetime total). Absent when it has never happened.
   *
   * On this list a deferred trigger is otherwise indistinguishable from a healthy one — 'pending',
   * with a nextRunAt in the near future, forever. That is the shape of a trigger that has not run in
   * a week and looks fine, so the count is here rather than only in the journal. Compare it against
   * `fireCount`: a number that keeps climbing while fireCount does not is a trigger that is being
   * refused, not one that is waiting.
   */
  deferrals?: number;
  lastDeferralAt?: number;
}

/**
 * READ-ONLY trigger listing from the journal, WITHOUT needing a scheduler INSTANCE or a runner (for
 * Studio introspection). Reads the SAME `sched:def:`/`sched:state:` keys (+ `sched:fail:` for 'failed')
 * as `pollScheduler`; does NOT change any state, does not take a lock, does not run a workflow. Returns
 * results sorted alphabetically by id (stable list order).
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
    // Read on EVERY status, not just 'failed': a deferred trigger is 'pending' by definition, so
    // gating this the way `lastError` is gated would hide it on exactly the rows that carry it.
    const busy = await journal.get<{ at: number; deferrals?: number }>(BUSY_SKIP(id));
    if (busy?.deferrals) {
      info.deferrals = busy.deferrals;
      info.lastDeferralAt = busy.at;
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
  opts: { pollMs?: number; owner?: string; retryMs?: number; backoff?: boolean; maxPollMs?: number; budgetGuard?: BudgetGuard; lockTtlMs?: number } = {},
): Scheduler {
  const pollMs = opts.pollMs ?? 1000;
  const backoffOn = opts.backoff ?? false;
  const maxPollMs = opts.maxPollMs ?? pollMs * 32;
  const poll = (now: number = Date.now()) =>
    pollScheduler(journal, runner, now, { owner: opts.owner, retryMs: opts.retryMs, budgetGuard: opts.budgetGuard, lockTtlMs: opts.lockTtlMs });

  // Phase 8.1: the tick/backoff/"polling" flag loop now lives in @gnldev/durable's shared createPollLoop
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
