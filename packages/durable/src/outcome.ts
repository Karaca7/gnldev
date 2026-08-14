// Whether a run ended well, recorded where an operator can find it.
//
// Nothing used to record it. Status was DERIVED from the journal's entries — 'suspended' if any tool
// record was suspended, otherwise 'completed' — and a run that threw writes no entry saying so. A 401
// on the first call, a cost ceiling tripping at step 3, a guard rejection: all of them read back as
// 'completed', and exportRun handed them to OTel with SpanStatusCode.OK and $0 of cost. The one signal
// an operator most needs was the one the system could not express.
//
// So each terminal boundary writes what happened. Deliberately a plain `put`, not a `claim`: a run that
// failed, was fixed, and resumed to success must stop being 'failed'. Last writer wins because the last
// writer is the one that knows.
//
// Best-effort, like every other observability write here (usage counters, metrics, incidents): a
// journal that refuses this write must not take down a run that otherwise succeeded, and must not
// convert a real error into a different one on the failure path.
import { runKeys } from './journal.js';
import type { Journal, RunOutcomeRecord } from './journal.js';
import { RunBusyError } from './errors.js';

/**
 * Errors that mean "this run did not run", not "this run failed".
 *
 * RunBusyError: another worker holds the lock — THAT worker owns the outcome, and stamping 'failed'
 *   From here would overwrite a live run's record with the story of a caller who never got in.
 * CompensatedRunError / RunCanceledError: terminal refusals. The run was deliberately unwound or
 *   Cancelled; those are their own states, and calling them failures loses that distinction.
 *
 * Matched by name rather than by instanceof: cancel.ts/compensation.ts import from run.ts's side of
 * The graph, and importing them back here would be a cycle for no gain.
 */
const NOT_A_RUN_FAILURE = new Set(['CompensatedRunError', 'RunCanceledError']);

export function isRunFailure(err: unknown): boolean {
  if (err instanceof RunBusyError) return false;
  const name = (err as { name?: string } | null)?.name;
  return !(name && NOT_A_RUN_FAILURE.has(name));
}

/** Message only — the stack can carry file paths and argument values into a record an operator reads. */
function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  try { return String(err); } catch { return 'unknown error'; }
}

export async function recordRunOutcome(
  journal: Journal,
  runId: string,
  outcome: RunOutcomeRecord,
): Promise<void> {
  try {
    await journal.put(runKeys.outcome(runId), outcome);
  } catch {
    // Advisory: the run's own result is already decided. Losing this costs an operator the reason,
    // Not the framework its correctness.
  }
}

export const runSucceeded = (journal: Journal, runId: string, at: number): Promise<void> =>
  recordRunOutcome(journal, runId, { status: 'completed', at });

export const runFailed = (journal: Journal, runId: string, err: unknown, at: number): Promise<void> =>
  recordRunOutcome(journal, runId, { status: 'failed', at, error: messageOf(err) });

/** The recorded outcome, or undefined for a run written before outcomes existed. */
export async function readRunOutcome(journal: Journal, runId: string): Promise<RunOutcomeRecord | undefined> {
  try {
    return await journal.get<RunOutcomeRecord>(runKeys.outcome(runId));
  } catch {
    return undefined;
  }
}
