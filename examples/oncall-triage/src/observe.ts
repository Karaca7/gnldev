// Did it follow the runbook, and what did it cost?
//
// These two questions are separate from "did it work", and both are answered from the JOURNAL after
// the fact — not from log lines the agent was asked to emit. A run that has already finished can be
// scored, re-scored under a stricter rule, and traced, because the record of what happened is a data
// structure rather than a transcript.
//
//   @gnldev/evals  scores the run against the runbook it was supposed to follow
//   @gnldev/otel   exports the same run as OTEL spans
import { trajectoryScorerFor, scoreRun } from '@gnldev/evals';
import { exportRun } from '@gnldev/otel';
import { piiTextRedactor } from '@gnldev/processors';
import { toJournal } from '@gnldev/durable';

/**
 * The runbook, expressed as something checkable.
 *
 * This is the part worth copying. rb-memory and rb-latency are prose an engineer reads; these are the
 * same rules in a form that can fail a build. The rules are deliberately about the SHAPE of the run
 * rather than the wording of the answer — a diagnosis can be phrased a hundred ways, but "restarted a
 * service during a latency incident" is either in the trajectory or it is not.
 */
export const RUNBOOK_RULES = {
  /** Memory saturation: read the runbook, gather the metric, then act. */
  memory: {
    requiredTools: ['searchRunbook', 'getMetric'],
    maxToolCalls: 8,
  },
  /**
   * Latency: rb-latency says "Do NOT restart". A model that restarts anyway is not making a
   * defensible judgement call — it is contradicting the document it was told to follow, and that is
   * exactly the failure a rule can catch and a system prompt cannot promise to prevent.
   */
  latency: {
    requiredTools: ['searchRunbook'],
    forbiddenTools: ['restartService'],
    maxToolCalls: 8,
  },
} as const;

/** Scores a finished run against one of the rule sets above. */
export async function scoreIncident(storage: any, runId: string, rules: { requiredTools?: readonly string[]; forbiddenTools?: readonly string[]; maxToolCalls?: number }) {
  const reader = toJournal(storage.runs);
  return scoreRun(reader, runId, [
    trajectoryScorerFor(reader, {
      requiredTools: rules.requiredTools as string[] | undefined,
      forbiddenTools: rules.forbiddenTools as string[] | undefined,
      maxToolCalls: rules.maxToolCalls,
      name: 'runbook-adherence',
    }),
  ]);
}

/**
 * Exports the run's spans.
 *
 * `redact` is passed for the reason the option's own documentation gives: the run outcome is written
 * by a path no processor sees, so a provider that quotes the offending input back in a refusal puts
 * that text into the span raw — and from there into the collector, which is usually somebody else's.
 * The agent in this example reads production logs; that is not a trace to export unfiltered.
 */
export async function traceIncident(storage: any, runId: string, endpoint?: string) {
  return exportRun(toJournal(storage.runs), runId, {
    endpoint: endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    serviceName: 'oncall-triage',
    redact: piiTextRedactor(),
  });
}
