// P2-cancel (AUDIT-R2, Dalga-2): DURABLE cross-worker cancellation for AGENT runs — the
// agent-side twin of @gnldev/workflow's `cancelWorkflowRun` (P0.4) and the missing half of the server's
// P0.3 `/runs/:id/cancel` (which only aborts in-flight generation ON THAT INSTANCE; this flag reaches
// every worker and survives restarts).
//
// Mechanism mirrors compensation.ts's condemn tombstone exactly: one journaled flag under a
// `runKeys.proc` key (invisible to parseJournalKey → reader/time-travel/forkRun see the run's timeline
// unchanged), checked at the run entry points (resume refusal, next to `assertNotCompensated`) AND
// before every FRESH model step (durable-model.ts) — so a run in-flight on ANOTHER worker stops at its
// next model-step boundary. REPLAYED steps deliberately do NOT check the flag: replay is deterministic
// reconstruction of work that already happened — canceling must stop NEW spend, never corrupt or hide
// the existing record (same principle as workflow cancel: journal state is never deleted).
//
// Terminal like compensation: a canceled run refuses to run/resume forever after. Recovery path for a
// mistaken cancel is `forkRun` (time-travel.ts) — fork the completed prefix into a NEW runId, same as
// the compensated-run story. Deliberately NO "uncancel": a cancel may have been ordered for
// safety/compliance reasons and silently reviving the same runId would erase that decision's meaning.
import type { Journal } from './journal.js';
import { runKeys } from './journal.js';

/** The cancel flag key — a proc-space record (invisible to the run's timeline), runId-prefixed so
 *  `withOrg` isolates it and run-retention sweeps clean it up with the rest of the run. */
const cancelKey = (runId: string): string => runKeys.proc(runId, '__gnl_canceled');

/** Thrown when a canceled run is (re)started, resumed, or reaches its next fresh model step. */
export class RunCanceledError extends Error {
  readonly code = 'run_canceled';
  constructor(
    readonly runId: string,
    readonly reason?: unknown,
  ) {
    super(`run '${runId}' was canceled${reason !== undefined ? ` (${typeof reason === 'string' ? reason : JSON.stringify(reason)})` : ''} — a canceled run never resumes; fork the completed prefix into a new runId (forkRun) to continue the work`);
    this.name = 'RunCanceledError';
  }
}

/**
 * Durably cancels an agent run: any worker running it stops at its next fresh model step, and every
 * later run/resume attempt throws `RunCanceledError`. Idempotent (re-canceling keeps the FIRST
 * record's reason/timestamp — the original decision is the audit-relevant one). Never deletes journal
 * state — the completed prefix stays replayable/inspectable (studio timeline, diff, fork all work).
 */
export async function cancelAgentRun(journal: Journal, runId: string, opts: { reason?: unknown } = {}): Promise<void> {
  const record = { at: Date.now(), ...(opts.reason !== undefined ? { reason: opts.reason } : {}) };
  if (journal.putIfAbsent) {
    await journal.putIfAbsent(cancelKey(runId), record); // first cancel wins — idempotent
    return;
  }
  if ((await journal.get(cancelKey(runId))) === undefined) await journal.put(cancelKey(runId), record);
}

/** Whether the run carries the durable cancel flag (undefined-safe on journals without the record). */
export async function agentRunCanceled(journal: Journal, runId: string): Promise<{ at: number; reason?: unknown } | undefined> {
  return journal.get<{ at: number; reason?: unknown }>(cancelKey(runId));
}

/** Throws RunCanceledError if the run was canceled (used by runDurable/streamDurable entry — parity
 *  with `assertNotCompensated`; the per-model-step gate lives in durable-model.ts). */
export async function assertNotCanceled(journal: Journal, runId: string): Promise<void> {
  const flag = await agentRunCanceled(journal, runId);
  if (flag !== undefined) throw new RunCanceledError(runId, flag.reason);
}
