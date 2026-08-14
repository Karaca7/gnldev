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

/**
 * How a run's error relates to its outcome record. RunBusyError alone cannot answer this — it is
 * Thrown at two very different moments, and the audit measured the blanket exclusion getting the
 * Second one wrong:
 *
 *   'not-a-failure'  — terminal refusals (compensated/canceled) and the LOCK-ACQUISITION refusal:
 *                      this caller never got in, the run belongs to whoever holds the lock, and
 *                      stamping anything from here would overwrite a live run's story.
 *   'contended'      — a MID-FLIGHT RunBusyError: this worker got in, ran, and was fenced out by a
 *                      concurrent executor of the same run. Recording nothing left the run reading
 *                      'completed'; recording 'failed' outright could bury the survivor's earlier
 *                      Success. So the caller records a failure that may only FILL ABSENCE — if the
 *                      Survivor has written (or later writes) a verdict, that verdict stands.
 *   'failure'        — everything else: the run genuinely ended badly.
 *
 * The lock site marks its own throw (atLockAcquisition) — the one place that knows which case it is.
 */
export function classifyRunError(err: unknown): 'failure' | 'contended' | 'not-a-failure' {
  if (err instanceof RunBusyError) {
    return (err as { atLockAcquisition?: boolean }).atLockAcquisition ? 'not-a-failure' : 'contended';
  }
  const name = (err as { name?: string } | null)?.name;
  return name && NOT_A_RUN_FAILURE.has(name) ? 'not-a-failure' : 'failure';
}

export function isRunFailure(err: unknown): boolean {
  return classifyRunError(err) === 'failure';
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
  opts?: { fillOnly?: boolean },
): Promise<void> {
  try {
    const key = runKeys.outcome(runId);
    // The shared clock when the journal has one: two workers' outcomes are ordered against each
    // Other, and local clocks are exactly what cannot do that.
    const at = journal.now ? await journal.now() : outcome.at;
    const next: RunOutcomeRecord = { ...outcome, at };
    // MONOTONIC, not last-writer-wins. The audit measured the failure: worker A dies on a 401 but its
    // 'failed' put is slow; the lock is already free, worker B resumes the SAME run, succeeds, writes
    // 'completed' — then A's stale put lands and a run that succeeded reads 'failed', permanently.
    // A verdict may only be replaced by a NEWER one, and the replacement is CAS'd so a concurrent
    // Newer write is never clobbered by this one. Three attempts, then yield — this is observability,
    // Losing the race to a fresher verdict is the correct outcome.
    for (let i = 0; i < 3; i++) {
      const raw = await journal.get<RunOutcomeRecord>(key);
      const cur = raw as RunOutcomeRecord | undefined;
      if (cur !== undefined) {
        if (opts?.fillOnly) return; // a verdict already stands, and this caller may only fill absence
        if (typeof cur.at === 'number' && cur.at > next.at) return; // a newer verdict already stands
        if (journal.putIfMatch) {
          if (await journal.putIfMatch(key, raw, next)) return;
          continue; // lost the CAS — re-read, the winner may be newer than us
        }
        await journal.put(key, next);
        return;
      }
      if (journal.putIfAbsent) {
        if (await journal.putIfAbsent(key, next)) return;
        continue; // someone filled it first — re-read and compare
      }
      await journal.put(key, next);
      return;
    }
  } catch {
    // Advisory: the run's own result is already decided. Losing this costs an operator the reason,
    // Not the framework its correctness.
  }
}

export const runSucceeded = (journal: Journal, runId: string, at: number): Promise<void> =>
  recordRunOutcome(journal, runId, { status: 'completed', at });

export const runFailed = (journal: Journal, runId: string, err: unknown, at: number): Promise<void> =>
  recordRunOutcome(journal, runId, { status: 'failed', at, error: messageOf(err) });

/** A fenced-out attempt's failure: only ever fills an ABSENT verdict — the surviving executor's wins. */
export const runFailedIfUnrecorded = (journal: Journal, runId: string, err: unknown, at: number): Promise<void> =>
  recordRunOutcome(journal, runId, { status: 'failed', at, error: messageOf(err) }, { fillOnly: true });

/** The recorded outcome, or undefined for a run written before outcomes existed. */
export async function readRunOutcome(journal: Journal, runId: string): Promise<RunOutcomeRecord | undefined> {
  try {
    return await journal.get<RunOutcomeRecord>(runKeys.outcome(runId));
  } catch {
    return undefined;
  }
}
