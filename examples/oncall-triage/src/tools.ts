// The four things this agent can do to a production system.
//
// Three of them read. One of them acts — and `restartService` is where every guarantee in this
// framework stops being an abstraction:
//
//   exactly-once   a restart that runs twice is two outages, and unlike a double charge there is
//                  nothing to refund. The journal makes the second attempt return the first result.
//   approval       a human says yes before it happens, and the run SUSPENDS while waiting rather
//                  than blocking a process for however long that takes.
//   audit          what ran, with which arguments, and who approved it — from the journal, not from
//                  a log line someone remembered to add.
import { tool } from 'ai';
import { z } from 'zod';

/** Where the fake production system keeps its state, so the example can show a restart happening. */
export interface Fleet {
  restarts: { service: string; at: number; reason: string }[];
  pages: { engineer: string; incident: string }[];
}

export const newFleet = (): Fleet => ({ restarts: [], pages: [] });

/**
 * A log line as services actually emit them: with a connection string in it.
 *
 * This is not a contrived detail. Application logs carry DSNs, bearer tokens and customer email
 * addresses, and an on-call agent's whole job is to read logs — so without a redaction processor in
 * front of the model, running this agent means posting your credentials to a model provider. See
 * `agent.ts`, where `piiRedactor` sits on the tool-result hook for exactly this line.
 */
const LOG_LINES = [
  'INFO  boot: connected postgres://svc:hunter2@pg-primary/orders',
  'WARN  pool: 48/50 connections in use',
  'INFO  request: customer jane.doe@example.com placed order',
  'ERROR gc: heap 1.9GB / 2.0GB, pause 840ms',
  'WARN  pool: waiting 1200ms for a connection',
];

export function buildTools(fleet: Fleet, metric: (svc: string, m: string) => number) {
  const getMetric = tool({
    description: 'Reads one metric for one service.',
    inputSchema: z.object({ service: z.string(), metric: z.string() }),
    execute: async ({ service, metric: name }) => ({ service, metric: name, value: metric(service, name) }),
  });

  const readLog = tool({
    description: 'Reads the tail of a service log.',
    inputSchema: z.object({ service: z.string(), lines: z.number().int().positive().max(200) }),
    execute: async ({ service, lines }) => ({ service, lines: LOG_LINES.slice(0, lines) }),
  });

  const restartService = tool({
    description: 'Restarts a service. Disruptive — the guard requires approval.',
    inputSchema: z.object({ service: z.string(), reason: z.string() }),
    execute: async ({ service, reason }) => {
      fleet.restarts.push({ service, at: Date.now(), reason });
      return { service, restarted: true, restartsSoFar: fleet.restarts.length };
    },
  });
  // The durability fields are attached rather than passed inline because the AI SDK's `tool()` helper
  // Types only its own options — inlining them costs the `as any` that would erase `execute`'s
  // Argument types. Attaching keeps both: full inference above, declared durability here.
  //
  // `sideEffect: true` says this call CHANGED something outside the process. It is what makes a
  // Resumed run refuse to blindly re-run it — which for a restart is the difference between one
  // Outage and two. (It is also the default for any tool that does not declare `idempotent: true`;
  // Saying it out loud here is for the reader, not for the runtime.)
  Object.assign(restartService, { sideEffect: true });

  const pageEngineer = tool({
    description: 'Pages the on-call engineer. The runbook allows this once per incident.',
    inputSchema: z.object({ engineer: z.string(), incident: z.string() }),
    execute: async ({ engineer, incident }) => {
      fleet.pages.push({ engineer, incident });
      return { paged: engineer, incident, pagesSoFar: fleet.pages.length };
    },
  });
  // Keyed by ARGUMENTS rather than by call id, and across runs: the same engineer for the same
  // Incident is one page even if a retry, a resume, or a second alert plans the call again. Models do
  // Re-emit an identical call with a fresh toolCallId, and call-keyed dedup does not catch that.
  //
  // This is the runbook's "page once and only once per incident" expressed as a property of the
  // System instead of a sentence people are expected to remember at 3am.
  //
  // The cost is stated in the durable types and is real: a cross-run record is NOT tied to a runId,
  // So run retention never sweeps it. It lives until purged. That is the point — and the bill.
  Object.assign(pageEngineer, { sideEffect: true, idempotency: 'args', idempotencyWindow: 'cross-run' });

  return { getMetric, readLog, restartService, pageEngineer };
}
