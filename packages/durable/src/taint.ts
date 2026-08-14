// The runtime's conservative answer to prompt injection. The model is a
// Black box — once attacker-authorable content (an `untrusted: true` tool's output, or anything a
// Processor flags) enters the conversation, there is NO sound way to know which later decision it
// Influenced. So we don't pretend to: the run is marked TAINTED once, monotonically, and every
// SUBSEQUENT side-effect tool call goes through the `limits.taintedSideEffects` action ladder in
// Durable-tool.ts (warn / reflect / block / suspend — the same machinery as the duplicate guard).
//
// The mark is JOURNALED (survives crash/resume — replay sees the same taint the live run saw) and
// FIRST-WINS (claim): the recorded source is the FIRST untrusted content that entered, which is the
// Earliest point after which nothing downstream can be assumed clean.
import { claim } from './journal.js';
import { argsHash } from './hash.js';
import type { Journal } from './journal.js';

/** Why this run is considered tainted — the FIRST untrusted content that entered the conversation. */
export interface RunTaint {
  at: number;
  /** The tool call whose output introduced untrusted content ('processor' sources may synthesize one). */
  toolCallId: string;
  toolName: string;
  /** 'tool' = an `untrusted: true` tool's output landed; 'processor' = a processor flagged content;
   *  'inherited' = carried in from a prior tainted turn on the same thread (`taintScope: 'thread'` —
   *  Audit A4). The toolCallId/toolName still point at the ORIGINAL source, `reason` names the thread. */
  source: 'tool' | 'processor' | 'inherited';
  reason?: string;
}

const taintKey = (runId: string): string => `${runId}:proc:__gnl_taint`;

/**
 * (memory-recall half, opt-in `limits.taintScope: 'thread'`): the THREAD-scoped taint key.
 * Like `runKeys.toolCrossRun` ('xrun:' — see journal.ts), the key contains no `:tool:`/`:model:`
 * Pattern → INVISIBLE to parseJournalKey (reader/time-travel/forkRun), and it has no `${runId}:`
 * Prefix → run-retention/purge does NOT touch it (intentional: it isn't part of any single run's
 * Timeline — it must outlive the run that wrote it). `withOrg` still prefixes it unconditionally →
 * Organization isolation is automatic. Cleanup: purge explicitly via `journal.deletePrefix('thread:')`
 * (or a specific `thread:<id>:taint`) when a thread is deleted.
 */
export const threadTaintKey = (threadId: string): string => `thread:${threadId}:taint`;

/**
 * TAINT PHASE 3 (content-lifetime, opt-in `limits.taintLifetime: 'content-window'`): the thread's
 * Taint PROVENANCE — stable content hashes of every message a DIRECTLY-tainted run (source 'tool' or
 * 'processor', NOT 'inherited') appended to memory. This is what lets a later run ask "is any
 * Tainted-source content still present in what the model sees?" without touching the AI SDK message
 * Shape (no metadata stamping — a separate record keyed by thread, least invasive by design).
 * Same key discipline as `threadTaintKey`: no `:tool:`/`:model:` pattern → invisible to
 * ParseJournalKey; no `${runId}:` prefix → outside run retention; `withOrg` prefixes it → org-isolated;
 * Shares the `thread:<id>:` prefix → a thread purge via `deletePrefix('thread:<id>:')` removes it too.
 */
export const threadTaintProvenanceKey = (threadId: string): string => `thread:${threadId}:taintProv`;

/**
 * PHASE 3: per-run "untrusted content DIRECTLY entered THIS run" mark. Needed because the run taint
 * Key is FIRST-WINS: a run that inherited thread taint at start ('inherited') and THEN did a fresh
 * Untrusted fetch keeps 'inherited' as its run record — but its appended messages DO carry new poison
 * And must be stamped into provenance. Runs that are only 'inherited'-tainted must NOT be stamped
 * (their messages are transitively suspect, but stamping them would make every later turn re-extend
 * The window and the taint could never expire — the documented transitive-echo bound). Written only
 * Under `taintScope: 'thread'` (the sole consumer, content-window expiry, requires it).
 */
const directTaintKey = (runId: string): string => `${runId}:proc:__gnl_taint_direct`;

/** PHASE 3: the provenance record. `overflow` = the hash cap was hit — visibility can no longer be
 *  Proven absent, so the expiry check treats the content as permanently visible (fail toward gating). */
export interface TaintProvenance {
  hashes: string[];
  overflow?: true;
}

/** Cap on stored hashes — a runaway record must not grow the journal value unboundedly. Overflow flips
 *  The record to "never expire" (conservative) instead of dropping hashes (which could expire early). */
const TAINT_PROVENANCE_MAX_HASHES = 512;

/** Stable content hash of one message (order-independent JSON, sha256/16 — same scheme as argsHash).
 * CONTRACT: matching relies on the Memory implementation returning appended messages structurally
 *  Unchanged after JSON round-trip (both first-party memories do). */
export function taintContentHash(message: unknown): string {
  return argsHash(message);
}

/** `claim` with the A3 retry-then-loud-error discipline (shared by the run and thread taint writes). */
async function claimTaint(journal: Journal, key: string, rec: RunTaint, what: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await claim(journal, key, rec);
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  console.error(
    `@gnldev/durable: FAILED to persist ${what} after 3 attempts — the prompt-injection ` +
      `defense may be DISARMED. Last error: ${String((lastErr as Error)?.message ?? lastErr)}`,
  );
}

/**
 * Marks the run tainted (idempotent, first-wins — a later call never overwrites the original source).
 * Called automatically by durable-tool.ts when an `untrusted: true` tool succeeds; EXPORTED so a
 * Tool-result processor (e.g. a prompt-injection detector) can set taint DYNAMICALLY for content its
 * Heuristics flag even when the tool itself wasn't declared untrusted. Never throws (advisory-write
 * Discipline, same as incidents) — but the ENFORCEMENT read is on the load-bearing path.
 */
export async function markRunTainted(
  journal: Journal,
  runId: string,
  taint: Omit<RunTaint, 'at'>,
  opts?: { threadId?: string },
): Promise<void> {
  const rec = { at: Date.now(), ...taint } satisfies RunTaint;
  // The previous code SWALLOWED a write failure. But the common shape is a SINGLE untrusted
  // Fetch then act — there is no "next" untrusted output to retry the mark, so one transient blip left the
  // Run permanently un-tainted and the injection defense disarmed. Retry a few times, and on final failure
  // Surface it LOUDLY. We deliberately do NOT throw: the mark is written at the untrusted tool's
  // Invocation, so throwing would kill that tool itself — loud-but-continue is the safe middle (an
  // Operator can alert on the log line), still first-wins/idempotent.
  await claimTaint(journal, taintKey(runId), rec, `run taint for '${runId}' (defense disarmed for the rest of this run)`);
  // (opt-in): ALSO claim the thread key so later runs on the same thread inherit the taint at
  // Run start (see run.ts inheritThreadTaint). Callers pass `threadId` ONLY when
  // `limits.taintScope === 'thread'` — without the opt-in this branch never runs (byte-for-byte
  // Current behavior). First-wins: the thread key keeps the EARLIEST source across all its runs.
  if (opts?.threadId !== undefined) {
    await claimTaint(journal, threadTaintKey(opts.threadId), rec, `thread taint for '${opts.threadId}' (cross-turn carry disarmed)`);
    // PHASE 3: also mark "untrusted content DIRECTLY entered this run" — even when the run/thread
    // Claims above LOST first-wins (an inherited-tainted run doing a FRESH fetch), this key still
    // Claims, so the run's appended messages get stamped into content provenance (see run.ts).
    // Skipped for 'inherited' (transitive echoes are deliberately not tracked — see directTaintKey).
    if (taint.source !== 'inherited') {
      await claimTaint(journal, directTaintKey(runId), rec, `direct-taint mark for '${runId}' (content-window provenance may under-record)`);
    }
  }
}

/** The run's taint mark, if any (undefined = clean). */
export async function readRunTaint(journal: Journal, runId: string): Promise<RunTaint | undefined> {
  return journal.get<RunTaint>(taintKey(runId));
}

/** The thread's taint mark (written only under `taintScope: 'thread'`), if any (undefined = clean). */
export async function readThreadTaint(journal: Journal, threadId: string): Promise<RunTaint | undefined> {
  return journal.get<RunTaint>(threadTaintKey(threadId));
}

/** PHASE 3: did untrusted content DIRECTLY enter this run (vs only inherited)? See directTaintKey. */
export async function readDirectRunTaint(journal: Journal, runId: string): Promise<RunTaint | undefined> {
  return journal.get<RunTaint>(directTaintKey(runId));
}

/** PHASE 3: the thread's content-provenance record (undefined = no directly-tainted run ever appended). */
export async function readTaintProvenance(journal: Journal, threadId: string): Promise<TaintProvenance | undefined> {
  return journal.get<TaintProvenance>(threadTaintProvenanceKey(threadId));
}

/**
 * PHASE 3: merge the appended messages' content hashes into the thread's provenance record (union —
 * A thread can accumulate poison from several directly-tainted runs). CAS when the journal supports it
 * (two concurrent tainted runs on one thread must not lose each other's hashes; a lost hash could
 * Expire the taint EARLY — the unsafe direction), otherwise best-effort get→put (the same documented
 * Narrow window as the other fallbacks, the core-hardening review). Never throws (advisory-write discipline);
 * On final failure it is LOUD: a MISSING record is the safe side (the expiry check treats it as
 * "cannot prove absence" and keeps the taint), but a PARTIAL record — this run's hashes lost while an
 * Older run's survive — can expire the taint early, so we retry and surface the failure for operators.
 */
export async function recordTaintProvenance(journal: Journal, threadId: string, messages: unknown[]): Promise<void> {
  if (messages.length === 0) return;
  const key = threadTaintProvenanceKey(threadId);
  const incoming = messages.map(taintContentHash);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const cur = await journal.get<TaintProvenance>(key);
      const merged = [...new Set([...(cur?.hashes ?? []), ...incoming])];
      const next: TaintProvenance =
        cur?.overflow || merged.length > TAINT_PROVENANCE_MAX_HASHES
          ? { hashes: merged.slice(0, TAINT_PROVENANCE_MAX_HASHES), overflow: true }
          : { hashes: merged };
      if (cur !== undefined && journal.putIfMatch) {
        if (await journal.putIfMatch(key, cur, next)) return;
        continue; // raced with a concurrent tainted run → re-read and re-merge
      }
      if (cur === undefined && journal.putIfAbsent) {
        if (await journal.putIfAbsent(key, next)) return;
        continue;
      }
      await journal.put(key, next);
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  console.error(
    `@gnldev/durable: FAILED to record taint content provenance for thread '${threadId}' after 3 attempts — ` +
      `if an OLDER provenance record exists, the content-window taint may EXPIRE EARLY while this run's ` +
      `poisoned content is still visible. Last error: ${String((lastErr as Error)?.message ?? lastErr ?? 'CAS contention')}`,
  );
}

/**
 * PHASE 3 — the expiry decision: is the thread's tainting content ABSENT from everything the model
 * Still sees this run? `visibleMessages` must be the messages ACTUALLY going to the model (the loaded
 * Context: recent window + recalled + incoming — run.ts passes `rest.messages` AFTER memory/processor
 * Preparation), NOT a re-derived "last N" — semantic recall can pull an old poisoned message back in.
 * Returns true ONLY when expiry is provably safe; every unknown falls back to false (keep gating):
 * no/empty/overflowed provenance record → cannot prove absence → keep;
 * any system-role message in the window → memory-SYNTHESIZED content (OM observations) may carry
 *    Summarized poison the hash cannot attribute → keep (over-gates callers who put system-role
 *    Messages in `messages`; documented — use the `system` option);
 * any visible message hash-matches the provenance → the poison is literally on screen → keep;
 * non-empty working memory (via the lazy `getWorkingMemory` callback) → WM is not a window, a
 *    Summary of the poison could hide there and we cannot tell → keep (conservative over-gating —
 *    The documented Phase 3 WM bound; no callback = the run has no WM in context, nothing to check).
 */
export async function isThreadTaintExpired(
  journal: Journal,
  threadId: string,
  visibleMessages: readonly any[],
  getWorkingMemory?: () => Promise<string | undefined>,
): Promise<boolean> {
  const prov = await readTaintProvenance(journal, threadId);
  if (!prov || prov.hashes.length === 0 || prov.overflow) return false;
  if (visibleMessages.some((m) => m?.role === 'system')) return false;
  const hashes = new Set(prov.hashes);
  if (visibleMessages.some((m) => hashes.has(taintContentHash(m)))) return false;
  if (getWorkingMemory && (await getWorkingMemory())) return false;
  return true;
}
