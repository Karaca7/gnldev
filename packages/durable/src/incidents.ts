// GOREV (incident journaling): the guard decisions in durable-tool.ts (duplicate guard, loop
// detection, maxToolCalls) used to be visible ONLY as a console line, a nudge in the conversation, or
// a thrown error — nothing an operator can query after the fact ("the runtime must at minimum SAY so"
// is weak if the saying evaporates). Every such decision now ALSO lands as a small, queryable
// incident record in the journal.
//
// DESIGN (mirrors processor.ts's procreport pattern — per-key records + listKeys read):
//  - Key = IDENTITY: `${runId}:incident:${toolCallId}:${source}:${action}` — a replay/resume that
//    re-takes the SAME decision (e.g. a still-blocked call re-evaluated on every resume attempt)
//    overwrites the SAME key idempotently → no duplicate spam, no CAS machinery needed.
//  - INVISIBLE to reader/time-travel/reconstructState (parseJournalKey only exposes
//    model/tool/input) and purged with the run (`${runId}:` prefix delete) — same as procreport.
//  - ADVISORY telemetry, never load-bearing: a failed incident write must NEVER break the run
//    (recordIncident swallows errors); exactly-once semantics live in the tool records, not here.
import type { Journal } from './journal.js';

/** A guard decision worth an operator's attention — what fired, on which call, and why (verbatim). */
export interface RunIncident {
  at: number;
  /** Which mechanism decided (see limits.ts / durable-tool.ts / taint.ts). */
  source: 'duplicate-guard' | 'loop-detection' | 'max-tool-calls' | 'taint-guard';
  /** What it did: 'warn' executed anyway (named the incident), the rest did not execute the call. */
  action: 'warn' | 'reflect' | 'block' | 'suspend';
  toolName: string;
  toolCallId: string;
  /** The SAME honest message the console/model/error carried — single source of truth, verbatim. */
  message: string;
  detail?: Record<string, unknown>;
}

const incidentKey = (runId: string, i: Pick<RunIncident, 'toolCallId' | 'source' | 'action'>): string =>
  `${runId}:incident:${i.toolCallId}:${i.source}:${i.action}`;

/** Journals one incident (idempotent by key — see the design note). Never throws. */
export async function recordIncident(journal: Journal, runId: string, incident: RunIncident): Promise<void> {
  try {
    await journal.put(incidentKey(runId, incident), { v: incident });
  } catch {
    // advisory only — a telemetry write must never take the run down with it.
    // ACCEPTED BOUND (audit E5): on this swallow the incident becomes UNQUERYABLE (readIncidents won't
    // list it), yet the ENFORCEMENT already happened — a 'warn' still executed its effect, a
    // 'reflect'/'block'/'suspend' still took its decision. This is a telemetry gap, NOT a safety gap:
    // the decision itself is durable elsewhere (the tool's own journal record — the 'reflected'/
    // 'suspended' terminal status, or, for a block, the absence of any succeeded record), so exactly-once
    // and the audit trail of what the tool DID are intact; only the operator-facing incident annotation
    // is lost. Kept best-effort deliberately (a full CAS/retry here would be load-bearing telemetry —
    // the opposite of the design intent). A host that needs guaranteed incident capture should tee these
    // to its own sink, not rely on the journal write succeeding.
  }
}

/** All incidents of a run, oldest first. Empty if the adapter has no `listKeys` (same optional-capability
 *  fallback as readProcessorReports/audit). */
export async function readIncidents(journal: Journal, runId: string): Promise<RunIncident[]> {
  if (typeof journal.listKeys !== 'function') return [];
  const keys = await journal.listKeys(`${runId}:incident:`);
  const out: RunIncident[] = [];
  for (const key of keys) {
    const hit = await journal.get<{ v: RunIncident }>(key);
    if (hit && typeof hit === 'object' && 'v' in hit) out.push(hit.v);
  }
  out.sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.toolCallId.localeCompare(b.toolCallId));
  return out;
}
