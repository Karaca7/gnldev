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
 *   RunCanceledError specifically records NOTHING from here, and that is not an omission: the error
 *   Only exists because `cancelAgentRun` journaled the flag, and that is the call that writes
 *   {status:'canceled'}. Writing again from the throw site would be a second machine for one fact —
 *   Racing the first, on a path (the mid-flight model-step gate) that fires once per worker that
 *   Notices. One writer, at the choke point that knows the ORIGINAL decision's timestamp.
 * RunThreadMismatchError: the caller's own mistake (a runId re-used for a different thread), asserted
 *   Before the attempt does anything — never a verdict on how the run itself went. Critically, this
 *   RunId may already carry a 'completed' outcome from a PRIOR, correctly-scoped attempt; classifying
 *   The mismatch as a failure would let a later, wrong call overwrite that earlier success with
 *   'failed' (measured: run.ts's assertThreadOwnership fires before runStarted/resolveApprovals for
 *   The same reason — see its own doc — but the outer catch here is the second half of that fix).
 *
 * ThreadOwnerMismatchError: the same shape as the sibling above, one axis over — a request that
 *   names a SUBJECT the thread does not belong to. Also asserted before the attempt does anything,
 *   also on a runId that may already carry someone else's 'completed'. It was added to this set the
 *   day the check was written, because the first version of that check ran LATER (inside memory
 *   prep) and was measured turning a victim's completed run into 'failed' — an authorisation
 *   refusal writing into the history of the person it refused.
 *
 * NotAnAgentRunError: the third member of the same family, and the one with the most to lose. The
 *   RunId belongs to a WORKFLOW or a BATCH ITEM — a live run with its own record, written by its own
 *   Machinery. An agent-path call against it is refused before it reads anything; stamping 'failed'
 *   From here would put an agent verdict on a workflow's outcome, which is precisely the
 *   Cross-contamination the refusal exists to prevent.
 *
 * RunOwnerMismatchError: the ThreadOwnerMismatch precedent, one address over — a stranger addressing
 *   a DERIVED run (`run1_<digest>`) that belongs to somebody else. It joins this set on the day the
 *   check is written rather than after the same measurement is taken twice: the derived namespace is
 *   exactly where a stranger CAN spell a live run's id (the digest is computable), so the refused
 *   call arrives against an id that very often already carries the owner's 'completed'. Letting it
 *   through as a failure would mean the leak we just refused still edits the victim's history.
 *
 * Matched by name rather than by instanceof: cancel.ts/compensation.ts/errors.ts import from run.ts's
 * side of the graph, and importing them back here would be a cycle for no gain.
 */
const NOT_A_RUN_FAILURE = new Set(['CompensatedRunError', 'RunCanceledError', 'RunThreadMismatchError', 'ThreadOwnerMismatchError', 'RunOwnerMismatchError', 'NotAnAgentRunError']);

/**
 * How a run's error relates to its outcome record. RunBusyError alone cannot answer this — it is
 * thrown at two very different moments, and the audit measured the blanket exclusion getting the
 * second one wrong:
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
  opts?: { fillOnly?: boolean; notAfterTerminal?: boolean },
): Promise<void> {
  try {
    const key = runKeys.outcome(runId);
    // The shared clock when the journal has one: two workers' outcomes are ordered against each
    // other, and local clocks are exactly what cannot do that.
    const at = journal.now ? await journal.now() : outcome.at;
    const next: RunOutcomeRecord = { ...outcome, at };
    // MONOTONIC, not last-writer-wins. The audit measured the failure: worker A dies on a 401 but its
    // 'failed' put is slow; the lock is already free, worker B resumes the SAME run, succeeds, writes
    // 'completed' — then A's stale put lands and a run that succeeded reads 'failed', permanently.
    // A verdict may only be replaced by a NEWER one, and the replacement is CAS'd so a concurrent
    // newer write is never clobbered by this one. Three attempts, then yield — this is observability,
    // losing the race to a fresher verdict is the correct outcome.
    for (let i = 0; i < 3; i++) {
      const raw = await journal.get<RunOutcomeRecord>(key);
      const cur = raw as RunOutcomeRecord | undefined;
      if (cur !== undefined) {
        if (opts?.fillOnly) return; // a verdict already stands, and this caller may only fill absence
        // This record says HOW A RUN ENDED, and a run that already ended did not end by being
        // canceled. Used only by the cancel path: an operator cancelling a run that finished a second
        // before the click must not relabel a run whose output is sitting right there in the
        // timeline, and cancelling one that already failed must not erase the 401. 'running' is not
        // an ending, so it IS replaced — which is the whole point, since a mid-flight run, a crashed
        // one, and a suspended one all carry exactly that record. A re-cancel lands here too and
        // returns, which is the idempotence cancel.ts already promises.
        if (opts?.notAfterTerminal && cur.status !== 'running') return;
        if (typeof cur.at === 'number' && cur.at > next.at) return; // a newer verdict already stands
        // A write-ahead 'running' may never bury a CANCEL. Every other verdict still can when it is
        // strictly newer — a run that finished DESPITE a late cancel really did finish, and calling
        // that canceled would be the lie in the other direction (the cancel takes effect at the next
        // model-step boundary; against a run on its last step it simply arrives too late). But a
        // start marker is not an ending, and this race is reachable without any of that nuance: a
        // worker that passed assertNotCanceled microseconds before the flag landed writes runStarted
        // right after it, then throws RunCanceledError at its next step and — correctly — records
        // nothing, leaving a canceled run reading 'running' forever.
        if (cur.status === 'canceled' && next.status === 'running') return;
        // A same-millisecond tie between a TERMINAL verdict and a 'running' start goes to the
        // terminal: the start is only newer information when it is STRICTLY newer. Without this, a
        // resume's start stamped in the same ms as the previous attempt's verdict flickered the run
        // back to 'running' even though nothing had run yet — harmless but noisy; and the reverse
        // race (terminal then same-ms running from a parallel starter) hid a real ending.
        if (typeof cur.at === 'number' && cur.at === next.at && next.status === 'running' && cur.status !== 'running') return;
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
    // not the framework its correctness.
  }
}

export const runSucceeded = (journal: Journal, runId: string, at: number): Promise<void> =>
  recordRunOutcome(journal, runId, { status: 'completed', at });

export const runFailed = (journal: Journal, runId: string, err: unknown, at: number): Promise<void> =>
  recordRunOutcome(journal, runId, { status: 'failed', at, error: messageOf(err) });

/** A fenced-out attempt's failure: only ever fills an ABSENT verdict — the surviving executor's wins. */
export const runFailedIfUnrecorded = (journal: Journal, runId: string, err: unknown, at: number): Promise<void> =>
  recordRunOutcome(journal, runId, { status: 'failed', at, error: messageOf(err) }, { fillOnly: true });

/**
 * The write-ahead start marker. Recorded at every attempt's entry (a resume is a new attempt), so a
 * run killed between here and its terminal write reads 'running' — never 'completed', which is what
 * the absence of any record used to mean. Monotonic like every outcome write: it cannot bury a
 * strictly newer terminal, and a stale attempt's late start cannot resurrect a finished run.
 */
export const runStarted = (journal: Journal, runId: string, at: number): Promise<void> =>
  recordRunOutcome(journal, runId, { status: 'running', at });

/**
 * The operator's ending. Written by `cancelAgentRun` — the durable cancel's single choke point — with
 * the `at` of the WINNING flag record, so a re-cancel keeps stamping the original decision's moment
 * rather than sliding it forward. `notAfterTerminal` because a cancel can only decide how a run ended
 * if it had not already ended (see recordRunOutcome), and no straggling start marker may bury it.
 */
export const runCanceled = (journal: Journal, runId: string, at: number): Promise<void> =>
  recordRunOutcome(journal, runId, { status: 'canceled', at }, { notAfterTerminal: true });

/** The recorded outcome, or undefined for a run written before outcomes existed. */
export async function readRunOutcome(journal: Journal, runId: string): Promise<RunOutcomeRecord | undefined> {
  try {
    return await journal.get<RunOutcomeRecord>(runKeys.outcome(runId));
  } catch {
    return undefined;
  }
}
