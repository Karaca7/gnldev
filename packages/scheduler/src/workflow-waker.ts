// @gnl/scheduler/workflow-waker — P2-waker (AUDIT-R2): closes the "suspend and hope
// someone polls" gap in @gnl/workflow. `sleep(id, untilMs)`/`waitFor` suspend a run and rely on
// someone re-calling `runResumable` to wake it up — this builds a real waker on top of the P0.4
// suspended-run registry (`listWorkflowRuns`) the same way `pollScheduler` drives cron/interval/at
// triggers: a self-rescheduling poll loop (`createPollLoop`, the SAME shared core `createScheduler`
// uses — see index.ts) that scans `wfrun:` for suspended runs and calls the host-supplied `resume`
// for the ones that are actually due.
//
// The waker does NOT know how to rebuild a workflow instance — it has no `workflows: {}` registry.
// `resume(runId, status)` is host-supplied and closes over whatever registry (e.g. `createGnl` /
// a plain `Workflow` map) actually knows how to call `runResumable` again for that run.
import { claim, createPollLoop } from '@gnl/durable';
import type { PollLoop } from '@gnl/durable';
import { listWorkflowRuns } from '@gnl/workflow';
import type { JournalLike, WorkflowRunStatus } from '@gnl/workflow';

/**
 * Per-run wake ticket key. Includes `updatedAt` so a run that later re-suspends (sleep/waitFor
 * rewrite the `wfrun:` record with a fresh `updatedAt` on every suspend) gets a FRESH ticket —
 * the same run at a NEW suspend point is a different wake opportunity, not a repeat of the old one.
 * Bound (honest, low-stakes): `updatedAt` is ms-epoch — two re-suspends of the SAME run within the
 * SAME millisecond share a ticket (one is silently skipped that tick, picked up the next). This only
 * matters for a run that suspends multiple times faster than 1ms apart, which a real `resume()`
 * round-trip never does; it's a cost/politeness bound anyway (see the correctness note below).
 */
const WAKE_TICKET = (runId: string, updatedAt: number) => `wfwake:${runId}:${updatedAt}`;

/** Best-effort narrowing of `WorkflowRunStatus.reason` — see `sleep`/`waitFor`/`waitForResume` in @gnl/workflow. */
function reasonKind(reason: unknown): { kind?: string; untilMs?: number } {
  return reason && typeof reason === 'object' ? (reason as { kind?: string; untilMs?: number }) : {};
}

export interface WorkflowWakerOptions {
  /** Structurally compatible with @gnl/workflow's JournalLike (a superset — @gnl/durable's Journal — also works). */
  journal: JournalLike;
  /**
   * Host-supplied resume: the waker does not know how to rebuild a workflow instance, so it hands
   * the runId + registry record back to the host, which typically calls the matching workflow's
   * `runResumable(input, { runId, journal }, opts)` again (completed steps replay from the journal;
   * the suspended step re-evaluates and either continues or suspends again).
   */
  resume: (runId: string, status: WorkflowRunStatus) => Promise<unknown>;
  /** Poll interval (ms). Default 5000. */
  intervalMs?: number;
  /**
   * Random delay (0..jitterMs) added BEFORE each tick's scan — spreads multiple waker instances'
   * polls apart so they don't all hit the journal in lockstep. Does NOT push a time-based sleep
   * PAST its `untilMs`: the due-check reads `Date.now()` AFTER the jitter delay, so a run only
   * ever wakes at-or-after its scheduled time (may be noticed up to `jitterMs` later, never earlier
   * than what a poll interval would already allow). Default 0 (off).
   */
  jitterMs?: number;
  /**
   * Evented (`waitFor`) and HITL (`waitForResume`) suspends have NO time signal — the waker cannot
   * tell whether the event/payload has arrived. Default (false): SKIP them entirely (only time-based
   * sleeps are woken). Opt-in `true`: resume them too, on every tick they remain suspended. Honest
   * cost: since a still-not-ready evented run gets a FRESH `wfrun:` `updatedAt` (and thus a fresh
   * wake ticket) every time `resume()` re-suspends it, this means one `resume()` round-trip (and
   * whatever `check()`/host work it triggers) PER TICK PER still-suspended evented run, for as long
   * as it stays unresolved — a busy-poll, not a push. Fine for a handful of runs; expensive at scale
   * (prefer delivering the event directly, e.g. `runResumable({ resume })`, when you can).
   */
  wakeEvented?: boolean;
  /**
   * Per-run error hook. Default (omitted): swallowed — `console.warn` ONCE per runId per
   * failure-streak (a success, or the run moving on, resets the streak) so a stuck run doesn't spam
   * logs every tick. The tick loop never dies from a `resume()` throw either way (matches
   * `createPollLoop`'s "the chain doesn't die" contract).
   */
  onError?: (runId: string, error: unknown) => void;
}

export interface WorkflowWakerTickResult {
  /** Runs whose `resume()` was called AND won the wake ticket (or the CAS-less fallback let through). */
  resumed: number;
  /** Runs not due yet, evented/HITL runs skipped (wakeEvented off), or runs that lost the wake-ticket race. */
  skipped: number;
  /** `resume()` calls that threw (swallowed — see `onError`). Included in `resumed` (the call WAS made). */
  errored: number;
}

export interface WorkflowWaker {
  /** One scan+wake pass. Exposed directly for tests/manual driving (mirrors pollScheduler/poll). */
  tick(now?: number): Promise<WorkflowWakerTickResult>;
  start(): void;
  stop(): void;
}

/**
 * Creates a durable sleep/event waker for @gnl/workflow suspended runs. `start()`/`stop()` mirror
 * `createScheduler`'s lifecycle (a self-rescheduling `setTimeout` chain via `createPollLoop` — no
 * dangling timer after `stop()`).
 */
export function createWorkflowWaker(opts: WorkflowWakerOptions): WorkflowWaker {
  const { journal, resume } = opts;
  const intervalMs = opts.intervalMs ?? 5000;
  const jitterMs = opts.jitterMs ?? 0;
  const wakeEvented = opts.wakeEvented ?? false;
  const onError = opts.onError;
  // Warn-once-per-failure-streak bookkeeping (default onError path only) — a run that starts
  // succeeding (or stops showing up as suspended) drops out of the map, so a LATER failure streak
  // warns again.
  const failStreak = new Map<string, number>();

  async function tick(now: number = Date.now()): Promise<WorkflowWakerTickResult> {
    const runs = await listWorkflowRuns(journal, { status: 'suspended' });
    const out: WorkflowWakerTickResult = { resumed: 0, skipped: 0, errored: 0 };

    for (const run of runs) {
      const reason = reasonKind(run.reason);
      const due =
        reason.kind === 'time'
          ? reason.untilMs !== undefined && now >= reason.untilMs
          : reason.kind === 'event' || reason.kind === 'resume'
            ? wakeEvented
            : false; // unknown reason shape — conservatively don't wake it
      if (!due) {
        out.skipped++;
        continue;
      }

      // Cost/politeness optimization ONLY — correctness does NOT depend on this CAS. `runResumable`
      // is idempotent by construction (completed steps replay from the journal), so even if two
      // waker instances both win this race (e.g. the journal lacks `putIfAbsent` and falls back to
      // the documented get+put race window), both `resume()` calls are harmless — at most one of
      // them actually advances the run.
      const ticketKey = WAKE_TICKET(run.runId, run.updatedAt);
      const gotTicket = await claim(journal, ticketKey, { at: now });
      if (!gotTicket) {
        out.skipped++;
        continue;
      }

      out.resumed++;
      try {
        await resume(run.runId, run);
        failStreak.delete(run.runId);
      } catch (err) {
        out.errored++;
        if (onError) {
          onError(run.runId, err);
        } else {
          const streak = (failStreak.get(run.runId) ?? 0) + 1;
          failStreak.set(run.runId, streak);
          if (streak === 1) {
            console.warn(`@gnl/scheduler: workflow-waker resume('${run.runId}') failed (chain continues):`, err);
          }
        }
      }
    }
    return out;
  }

  const loop: PollLoop = createPollLoop(
    async () => {
      if (jitterMs > 0) await new Promise((r) => setTimeout(r, Math.floor(Math.random() * jitterMs)));
      const r = await tick();
      return r.resumed > 0;
    },
    { pollMs: intervalMs, backoff: false }, // sleep waking is timing-critical, same rationale as createScheduler's default
  );

  return {
    tick,
    start: loop.start,
    stop: loop.stop,
  };
}
