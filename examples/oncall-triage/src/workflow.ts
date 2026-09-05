// The incident pipeline: alert in, resolution out.
//
// WHY THIS IS A WORKFLOW AND NOT MORE AGENT
//
// The agent's job is judgement — which runbook applies, what the numbers mean. The pipeline's job is
// PROCEDURE: classify, triage, escalate, record. Procedure written as prompt is procedure you cannot
// audit and cannot replay, and "page the on-call engineer once" is procedure.
//
// The split also decides what a crash costs. Every step here is journaled under `${runId}#${stepId}`,
// so a process that dies after paging and before recording does NOT page again on restart — it comes
// back holding the page's recorded result and moves on. That is the guarantee the whole example
// exists to show, and it is worth exactly as much as the boundary it is drawn around.
import { workflow, step } from '@gnldev/workflow';

export interface Alert {
  incidentId: string;
  service: string;
  text: string;
  severity: 'sev1' | 'sev2' | 'sev3';
}

export interface Triaged extends Alert {
  diagnosis: string;
  suspended: boolean;
  awaiting?: { toolCallId: string; toolName: string; reason: string };
}

export interface Resolved extends Triaged {
  paged: boolean;
  pageResult?: unknown;
}

/**
 * Builds the pipeline. `deps` is passed in rather than imported so the same workflow can be run
 * against a test double — the steps stay pure functions of their input plus these handles.
 */
export function buildIncidentWorkflow(deps: {
  runTriage: (a: Alert) => Promise<{ text: string; interrupts: any[] }>;
  page: (engineer: string, incident: string) => Promise<unknown>;
  record: (r: Resolved) => Promise<void>;
}) {
  /** Ask the agent what is wrong. May come back SUSPENDED, waiting on a human. */
  const triage = step('triage', async (alert: Alert): Promise<Triaged> => {
    const r = await deps.runTriage(alert);
    const it = r.interrupts?.[0];
    return {
      ...alert,
      diagnosis: r.text ?? '',
      suspended: !!it,
      awaiting: it && { toolCallId: it.toolCallId, toolName: it.toolName, reason: it.reason },
    };
  });

  /**
   * Escalate — sev1 only.
   *
   * The "once and only once" in rb-escalation is enforced TWICE over, and the redundancy is
   * deliberate because the two guards fail in different directions:
   *
   *   the workflow journal  stops a REPLAY of this run from paging again (crash, resume, fork)
   *   cross-run idempotency stops a DIFFERENT run for the same incident from paging again
   *                         (the alert fires a second time, a queue redelivers, an operator retries)
   *
   * Drop the first and a resumed run re-pages. Drop the second and a re-fired alert re-pages. A
   * runbook sentence covers neither.
   */
  const escalate = step('escalate', async (t: Triaged): Promise<Resolved> => {
    if (t.severity !== 'sev1') return { ...t, paged: false };
    const pageResult = await deps.page('sre-oncall', t.incidentId);
    return { ...t, paged: true, pageResult };
  });

  const close = step('close', async (r: Resolved): Promise<Resolved> => {
    await deps.record(r);
    return r;
  });

  return workflow<Alert>().then(triage).then(escalate).then(close);
}
