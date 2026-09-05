// What happens around the incident: how alerts arrive, and what watches after the restart.
//
// This file exists because of one sentence in rb-memory:
//
//   "After restarting, watch for 30 minutes — a leak that returns within that window is a code bug,
//    not a capacity problem, and must be escalated rather than restarted again."
//
// That is a promise about a moment thirty minutes from now, made by a process that will very likely
// be redeployed before then. Keeping it with `setTimeout` means keeping it only if nothing restarts.
// The three packages below are the difference between remembering and intending to remember:
//
//   @gnldev/queue      alerts arrive as JOBS. A crash mid-triage leaves the job pending, so it is
//                      picked up again instead of being lost with the process that held it.
//   @gnldev/events     the restart publishes a fact. Whoever cares subscribes. The triage agent does
//                      not need to know that a watch exists.
//   @gnldev/scheduler  the watch is a row in the journal with a time on it. It survives the deploy.
import { enqueue, createWorker, type JobCtx } from '@gnldev/queue';
import { emit, createConsumer } from '@gnldev/events';
import { scheduleWorkflow, pollScheduler, listTriggers, type WorkflowRunner } from '@gnldev/scheduler';
import type { Alert } from './workflow.js';

export const ALERT_JOB = 'alert';
export const RESTARTED_TOPIC = 'service.restarted';
export const WATCH_WORKFLOW = 'post-restart-watch';

/** 30 minutes. Overridable so the example's own test does not have to wait half an hour. */
export const WATCH_MS = Number(process.env.WATCH_MS ?? 30 * 60 * 1000);

/** Alerts come in as durable jobs rather than as function calls. */
export const submitAlert = (work: any, alert: Alert) =>
  // The job id IS the incident id: a monitoring system that fires the same alert three times (they
  // Do) enqueues one job. Dedup at the door is cheaper than dedup at every step behind it.
  enqueue(work, ALERT_JOB, alert, { id: `alert:${alert.incidentId}` });

/** Announces that a service was restarted. The watch is scheduled by a listener, not by the agent. */
export const announceRestart = (work: any, incidentId: string, service: string) =>
  emit(work, RESTARTED_TOPIC, { incidentId, service }, { id: `restarted:${incidentId}` });

/**
 * Wires the three together.
 *
 * `runner` is what actually executes a workflow by name — `createGnl`'s return value is structurally
 * compatible with it, which is why the scheduler package does not depend on durable.
 */
export function buildOps(storage: any, runner: WorkflowRunner, handleAlert: (a: Alert) => Promise<void>) {
  // TWO STORES, and mixing them up is a runtime error rather than a type error: queue and events
  // Append to the WORK store, while the scheduler keeps triggers in the JOURNAL (it needs listKeys
  // For trigger enumeration, which the work store does not have). Both live in the same SQLite file.
  const work = storage.work;
  const journal = storage.runs;

  const worker = createWorker(storage, {
    [ALERT_JOB]: async (payload: unknown, _ctx: JobCtx) => {
      await handleAlert(payload as Alert);
    },
  });

  // The consumer is the only thing that knows a restart implies a watch. Moving that rule out of the
  // Agent is what lets you change the follow-up policy without touching the prompt.
  const watcher = createConsumer(
    work,
    RESTARTED_TOPIC,
    async (payload: any) => {
      await scheduleWorkflow(journal, {
        // The trigger id is derived from the incident, and `scheduleWorkflow` is idempotent on it —
        // So a redelivered event schedules one watch, not one per delivery.
        id: `watch:${payload.incidentId}`,
        name: WATCH_WORKFLOW,
        input: { incidentId: payload.incidentId, service: payload.service },
        at: Date.now() + WATCH_MS,
      });
    },
    { name: 'post-restart-watcher' },
  );

  return {
    worker,
    watcher,
    /** Fires any watch whose time has come. A deployment runs this on a timer; the demo calls it. */
    tick: (now?: number) => pollScheduler(journal, runner, now),
    pendingWatches: () => listTriggers(journal),
  };
}
