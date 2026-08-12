// Exactly-once prevented the DUPLICATE; this module undoes what DID
// happen when the overall transaction can't complete (charge ✓ → reserve ✓ → ship ✗ → refund+release).
//
// PRINCIPLES (each one a deliberate decision — see the design discussion):
//  - EXPLICIT trigger only. `compensateRun` is an operator/host DECISION ("this run is abandoned").
//    NEVER automatic on failure: a transient failure + resume is GNL's whole point — auto-unwinding
//    would refund a charge that the resume then re-charges.
//  - CONDEMN FIRST, then unwind. The tombstone is claimed BEFORE any compensation runs; from that
//    moment the run REFUSES to resume (see assertNotCompensated in run.ts) — otherwise a resume of a
//    half-unwound run would replay memoized successes over an already-reverted world.
//  - Compensations are side effects TOO: each one goes through the same claim → execute → terminal
//    discipline as the original tool call (`${runId}:comp:<suffix>` mirrors `${runId}:tool:<suffix>`,
//    1:1 per EXECUTED record). Re-running compensateRun after a crash/failure continues exactly where
//    it stopped — a refund can never run twice.
//  - REVERSE order, STOP on failure. Later steps may depend on earlier ones (release the reservation
//    before refunding the charge); on a failed compensation the remaining (earlier) ones are NOT
//    attempted — fix the hook/world and re-run.
//  - UNCERTAINTY is surfaced, not guessed. A stale 'running'/'failed' record might or might not have
//    hit the provider: `recover` (H9) resolves it against the source of truth when declared;
//    otherwise the entry is reported 'uncertain' for a human. Nothing is compensated on a guess.
//  - SCOPE BOUND (deliberate): `idempotencyWindow: 'cross-run'` records live OUTSIDE any run's key
//    space (xrun:*) and are NOT unwound here — a shared-window action belongs to no single run, and
//    reverting it while unwinding ONE run could invalidate OTHER runs that legitimately deduped onto
//    it. Sub-agent (agent:*) nested runs are also not recursed in v1 (documented; v1.1).
import { claim, parseJournalKey, runKeys } from './journal.js';
import { upgradeFormat } from './format.js';
import type { Journal, JournalReader, ToolJournalRecord } from './journal.js';
import type { AnyTool } from './types.js';

/** The run was unwound (compensateRun condemned it) — it can never be resumed, forked, or allowed to
 *  execute further side effects (see assertNotCompensated call sites + the durable-tool mid-flight gate). */
export class CompensatedRunError extends Error {
  public readonly detail: { runId: string };
  constructor(runId: string) {
    super(
      `@gnldev/durable: run '${runId}' has been COMPENSATED (its side effects were unwound) — it cannot ` +
      'continue: replaying/continuing would treat already-reverted side effects as if they still hold.',
    );
    this.name = 'CompensatedRunError';
    this.detail = { runId };
  }
}

export interface CompensationEntry {
  /** The original journal key suffix (call mode: the toolCallId; args mode: the dedupe key). */
  suffix: string;
  toolCallId?: string;
  toolName?: string;
  status:
    | 'compensated' // the hook ran (this pass) and its result was journaled
    | 'already-compensated' // journaled by an earlier pass — the hook did NOT run again
    | 'would-compensate' // dryRun only: a hook-bearing executed record that WOULD be unwound
    | 'skipped-no-hook' // executed, but the tool declares no `compensate` — nothing the runtime can do
    | 'skipped-not-executed' // uncertainty resolved by `recover`: the side effect never happened
    | 'uncertain' // running/failed record, no (working) `recover` — a human must resolve it
    | 'busy' // another compensator holds this entry's claim right now (stop; re-run later)
    | 'failed' // the hook threw — journaled as comp-failed; re-running retries it
    | 'not-attempted'; // an earlier (later-step) compensation failed/busy → stopped before this one
  error?: string;
}

export interface CompensationReport {
  runId: string;
  dryRun: boolean;
  /** True once the tombstone exists — the run is condemned and refuses resume (never set by dryRun). */
  condemned: boolean;
  /** In UNWIND order (reverse execution order). */
  entries: CompensationEntry[];
}

const tombstoneKey = (runId: string): string => runKeys.proc(runId, '__gnl_compensated');
const compKey = (runId: string, suffix: string): string => `${runId}:comp:${suffix}`;

/** True once the run has been condemned by compensateRun (tombstone present). Load-bearing read:
 *  runDurable/streamDurable/forkRun refuse on it, and durable-tool refuses NEW side effects mid-flight
 *  (a still-running worker must not keep producing effects while an operator unwinds the run). */
export async function runCompensated(journal: Journal, runId: string): Promise<boolean> {
  return (await journal.get(tombstoneKey(runId))) !== undefined;
}

/** Throws CompensatedRunError if the run was condemned (used by runDurable/streamDurable/forkRun). */
export async function assertNotCompensated(journal: Journal, runId: string): Promise<void> {
  if (await runCompensated(journal, runId)) throw new CompensatedRunError(runId);
}

/** Args AND toolName for records that never stored them, recovered from the model steps' tool-call
 *  parts (both generate `content` and stream `parts` shapes). Succeeded records of compensate-bearing
 *  tools carry `input` themselves; UNCERTAIN records ('running'/'failed') carry NEITHER input NOR
 *  toolName — this map is the only way to know which tool an uncertain call even belongs to. */
function callsFromModelSteps(entries: { kind: string; value: unknown }[]): Map<string, { input: unknown; toolName?: string }> {
  const map = new Map<string, { input: unknown; toolName?: string }>();
  for (const e of entries) {
    if (e.kind !== 'model') continue;
    const v = e.value as { content?: unknown[]; parts?: unknown[] } | undefined;
    for (const part of [...(v?.content ?? []), ...(v?.parts ?? [])] as any[]) {
      if (part?.type !== 'tool-call' || !part.toolCallId) continue;
      let input = part.input;
      if (typeof input === 'string') {
        try { input = JSON.parse(input); } catch { /* keep the raw string — better than nothing */ }
      }
      map.set(part.toolCallId, { input, toolName: part.toolName });
    }
  }
  return map;
}

/** The ORIGINAL execution's downstream idempotencyKey (mirrors durable-tool.ts) — recover must probe
 *  the provider with the SAME key the execution carried. */
function originalIdempotencyKey(runId: string, suffix: string): string {
  const m = suffix.match(/^args-(.+)-([0-9a-f]{16})$/);
  return m ? `${runId}:${m[1]}:${m[2]}` : `${runId}:${suffix}`;
}

// A fresh 'running' comp claim younger than this belongs to a live compensator — don't fight it.
const COMP_CLAIM_TTL_MS = 30_000;

type CompRecord =
  | { status: 'compensated'; output: unknown; at: number }
  | { status: 'comp-failed'; error: string; attempts: number }
  | { status: 'running'; startedAt: number };

/**
 * Unwinds an abandoned run: every EXECUTED side effect (succeeded record) whose tool declares
 * `compensate` is undone in REVERSE order, exactly-once. See the module header for the principles.
 * Re-runnable: continues past 'already-compensated', retries 'comp-failed'. `dryRun` previews the
 * work without condemning or executing anything.
 */
export async function compensateRun(
  runId: string,
  opts: { journal: Journal & Partial<JournalReader>; tools?: Record<string, AnyTool>; dryRun?: boolean },
): Promise<CompensationReport> {
  const { journal, tools = {}, dryRun = false } = opts;
  if (typeof journal.readRun !== 'function') {
    throw new Error('@gnldev/durable compensateRun: the journal does not support readRun — cannot enumerate the run');
  }
  const entries = await journal.readRun(runId);
  const callsMap = callsFromModelSteps(entries);

  // Worklist: EXECUTED-or-uncertain tool records, in REVERSE journal (≈ execution) order.
  const prefix = `${runId}:tool:`;
  const work: { suffix: string; record: ToolJournalRecord }[] = [];
  for (const e of entries) {
    if (e.kind !== 'tool' || !e.key.startsWith(prefix)) continue;
    const record = upgradeFormat(e.value as any, e.key) as ToolJournalRecord | undefined;
    if (!record) continue;
    // denied/reflected/suspended never EXECUTED anything → nothing to unwind, not even reported.
    if (record.status === 'succeeded' || record.status === 'failed' || record.status === 'running') {
      work.push({ suffix: e.key.slice(prefix.length), record });
    }
  }
  work.reverse();

  // CONDEMN FIRST (never in dryRun): from this moment the run refuses resume. claim() = idempotent
  // (a re-run keeps the original tombstone); the result is deliberately ignored.
  if (!dryRun) await claim(journal, tombstoneKey(runId), { at: Date.now() });

  const report: CompensationReport = { runId, dryRun, condemned: !dryRun, entries: [] };
  let stopped = false;
  for (const { suffix, record } of work) {
    const toolCallId =
      record.status === 'succeeded' && record.resolvedToolCallIds?.length ? record.resolvedToolCallIds[0]
      : parseJournalKey(`${prefix}${suffix}`) ? suffix : suffix;
    const toolName = (record as { toolName?: string }).toolName
      ?? callsMap.get(toolCallId)?.toolName // uncertain records store no toolName — the model step knows
      ?? (suffix.match(/^args-(.+)-[0-9a-f]{16}$/)?.[1]);
    const base: Omit<CompensationEntry, 'status'> = { suffix, toolCallId, toolName };
    if (stopped) {
      report.entries.push({ ...base, status: 'not-attempted' });
      continue;
    }
    const tool = toolName ? tools[toolName] : undefined;

    // 1) Resolve what actually HAPPENED for uncertain records — against the provider, never a guess.
    let output: unknown;
    if (record.status === 'succeeded') {
      output = record.output;
    } else {
      if (typeof tool?.recover !== 'function') {
        report.entries.push({ ...base, status: 'uncertain' });
        continue;
      }
      try {
        const args = (record as any).input ?? callsMap.get(toolCallId)?.input;
        const probe = await tool.recover(args, { idempotencyKey: originalIdempotencyKey(runId, suffix), toolCallId });
        if (!probe.done) {
          report.entries.push({ ...base, status: 'skipped-not-executed' });
          continue;
        }
        output = probe.output;
      } catch (e) {
        report.entries.push({ ...base, status: 'uncertain', error: String((e as Error)?.message ?? e) });
        continue;
      }
    }

    if (typeof tool?.compensate !== 'function') {
      report.entries.push({ ...base, status: 'skipped-no-hook' });
      continue;
    }

    // 2) Exactly-once compensation: terminal check → claim → execute → terminal write.
    // The terminal check comes BEFORE the dryRun branch on purpose (honesty fix): a dryRun on a
    // PARTIALLY-unwound run must report the already-done entries as 'already-compensated', not
    // pretend it 'would-compensate' work that has already happened.
    const ck = compKey(runId, suffix);
    const existing = await journal.get<CompRecord>(ck);
    if (existing?.status === 'compensated') {
      report.entries.push({ ...base, status: 'already-compensated' });
      continue;
    }
    if (dryRun) {
      report.entries.push({ ...base, status: 'would-compensate' });
      continue;
    }
    if (existing?.status === 'running' && Date.now() - existing.startedAt <= COMP_CLAIM_TTL_MS) {
      // A live compensator owns this entry — proceeding to EARLIER steps would break the reverse
      // ordering invariant, so stop here; a later re-run picks up whatever remains.
      report.entries.push({ ...base, status: 'busy' });
      stopped = true;
      continue;
    }
    if (existing === undefined) {
      const won = await claim(journal, ck, { status: 'running', startedAt: Date.now() } satisfies CompRecord);
      if (!won) {
        // Lost a concurrent race after our read — same semantics as the fresh-running case above.
        report.entries.push({ ...base, status: 'busy' });
        stopped = true;
        continue;
      }
    } else {
      // comp-failed retry / stale-running reclaim: single-operator overwrite (documented bound — the
      // unwind action itself is an operator action; the claim above guards the common race).
      await journal.put(ck, { status: 'running', startedAt: Date.now() } satisfies CompRecord);
    }
    try {
      const args = (record as any).input ?? callsMap.get(toolCallId)?.input;
      const result = await tool.compensate(args, output, {
        idempotencyKey: compKey(runId, suffix), // stable downstream key — the refund is exactly-once at the provider too
        toolCallId, runId,
      });
      await journal.put(ck, { status: 'compensated', output: result, at: Date.now() } satisfies CompRecord);
      report.entries.push({ ...base, status: 'compensated' });
    } catch (e) {
      const attempts = existing?.status === 'comp-failed' ? existing.attempts + 1 : 1;
      await journal.put(ck, { status: 'comp-failed', error: String((e as Error)?.message ?? e), attempts } satisfies CompRecord);
      report.entries.push({ ...base, status: 'failed', error: String((e as Error)?.message ?? e) });
      stopped = true; // earlier steps may depend on this one — do not unwind past a failure
    }
  }
  return report;
}
