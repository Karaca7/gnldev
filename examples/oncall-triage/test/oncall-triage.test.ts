// These are the example's CLAIMS, not a smoke test.
//
// Every README sentence about this example that says "cannot happen" has an assertion here, and each
// one was written by first measuring the failure it prevents. Two in particular exist because the
// example was wrong when it was first written:
//
//   the DSN test        the redactor was installed, the email was masked, and the database password
//                       went to the model verbatim — `piiRedactor` covers PII and a credential is not
//                       PII. The example claimed otherwise until this was run.
//   the two page tests  the workflow journal and cross-run idempotency were assumed to be the same
//                       guard. They are not: one covers replay, the other covers a re-fired alert,
//                       and removing either leaves a real double-page that the other does not catch.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, withIdempotency } from '@gnldev/durable';
import { scoreToolSequence } from '@gnldev/evals';
import { buildTriage } from '../src/agent.js';
import { buildSpecialist } from '../src/specialist.js';
import { buildIncidentWorkflow, type Alert, type Resolved } from '../src/workflow.js';
import { RUNBOOK_RULES } from '../src/observe.js';
import { buildModel } from '../src/model.js';

const MEMORY_ALERT = '[sev1] service=checkout — memory leak suspected, RSS climbing';
const LATENCY_ALERT = '[sev2] service=search — p99 latency regression, 2400ms';

const run = (gnl: any, id: string, prompt: string, service: string) =>
  gnl.run('triage', { runId: id, prompt, threadId: id, resourceId: service });

describe('the restart is a decision a human makes', () => {
  it('suspends instead of restarting, and nothing has happened while it waits', async () => {
    const { gnl, fleet } = await buildTriage(new InMemoryStorage());
    const r = await run(gnl, 'i1', MEMORY_ALERT, 'checkout');

    expect(r.interrupts).toHaveLength(1);
    expect(r.interrupts[0].toolName).toBe('restartService');
    // The point of suspending rather than blocking: the process is free, and production is untouched.
    expect(fleet.restarts).toHaveLength(0);
  });

  it('restarts exactly once after approval — and a second resume does not restart again', async () => {
    const { gnl, resume, fleet } = await buildTriage(new InMemoryStorage());
    const r = await run(gnl, 'i2', MEMORY_ALERT, 'checkout');
    const approval = { [r.interrupts[0].toolCallId]: true };

    await resume('i2', approval);
    expect(fleet.restarts).toHaveLength(1);

    // A double-clicked Approve button, or a retried HTTP request. The journal already holds the
    // outcome of that toolCallId, so the second resume replays it instead of running it.
    await resume('i2', approval);
    expect(fleet.restarts).toHaveLength(1);
  });

  it('follows rb-latency: a latency alert is diagnosed, never restarted', async () => {
    const { gnl, fleet } = await buildTriage(new InMemoryStorage());
    const r = await run(gnl, 'i3', LATENCY_ALERT, 'search');

    expect(r.interrupts).toHaveLength(0);
    expect(fleet.restarts).toHaveLength(0);
    expect(r.text).toContain('search'); // the alert's service, not a default
  });
});

describe('the logs the agent reads carry secrets', () => {
  it('masks the DSN credentials and the customer email before the model sees them', async () => {
    const { gnl, model } = await buildTriage(new InMemoryStorage());
    const seen: string[] = [];
    const orig = model.doGenerate.bind(model);
    model.doGenerate = async (o: any) => { seen.push(JSON.stringify(o.prompt)); return orig(o); };

    await run(gnl, 'i4', MEMORY_ALERT, 'checkout');
    const sent = seen.join('\n');

    expect(sent).not.toContain('hunter2');                 // the password
    expect(sent).not.toContain('jane.doe@example.com');    // the customer
    // The HOST survives, deliberately: at 3am "which database" is the question, and masking the whole
    // URL answers none of it. A test that only asserted the absence of the password would pass just
    // as well if the entire log line had been dropped.
    expect(sent).toContain('db-primary/orders');
    expect(sent).toContain('[REDACTED_DSN_CREDENTIALS]');
  });
});

describe('page the on-call engineer once, and only once', () => {
  /** The pipeline, wired the way index.ts wires it. */
  async function pipeline() {
    const storage = new InMemoryStorage();
    const { gnl, fleet, tools, journal } = await buildTriage(storage);
    const safe = withIdempotency({ pageEngineer: tools.pageEngineer } as any, {
      journal, window: 'cross-run', key: (_n, a: any) => a.incident,
    });
    const closed: Resolved[] = [];
    const wf = buildIncidentWorkflow({
      runTriage: (a) => run(gnl, `triage:${a.incidentId}`, `[${a.severity}] service=${a.service} — ${a.text}`, a.service),
      page: (engineer, incident) =>
        (safe.pageEngineer as any).execute({ engineer, incident }, { toolCallId: `page:${incident}` }),
      record: async (r) => { closed.push(r); },
    });
    return { wf, fleet, journal, closed };
  }

  const ALERT: Alert = {
    incidentId: 'INC-42', service: 'checkout', severity: 'sev1',
    text: 'memory leak suspected, RSS climbing',
  };

  it('a replayed run does not page again (the WORKFLOW journal)', async () => {
    const { wf, fleet, journal } = await pipeline();
    await wf.run(ALERT, { runId: 'wf-a', journal });
    expect(fleet.pages).toHaveLength(1);

    // Same runId = the crash-and-restart case. `escalate` is journaled, so it returns its recorded
    // result rather than paging a second time.
    await wf.run(ALERT, { runId: 'wf-a', journal });
    expect(fleet.pages).toHaveLength(1);
  });

  it('a re-fired alert does not page again (CROSS-RUN idempotency)', async () => {
    const { wf, fleet, journal } = await pipeline();
    await wf.run(ALERT, { runId: 'wf-a', journal });

    // A DIFFERENT run for the SAME incident — the monitoring system fired twice, or an operator
    // retried. The workflow journal cannot help here: this run has its own key space, and `escalate`
    // genuinely has not run in it. Only the argument-keyed, runId-free record stops the second page.
    await wf.run(ALERT, { runId: 'wf-b', journal });
    expect(fleet.pages).toHaveLength(1);
  });

  it('a DIFFERENT incident still pages — the guard dedups, it does not mute', async () => {
    const { wf, fleet, journal } = await pipeline();
    await wf.run(ALERT, { runId: 'wf-a', journal });
    await wf.run({ ...ALERT, incidentId: 'INC-43' }, { runId: 'wf-c', journal });
    expect(fleet.pages).toHaveLength(2);
  });

  it('sev3 is not paged at all', async () => {
    const { wf, fleet, journal } = await pipeline();
    await wf.run({ ...ALERT, severity: 'sev3' }, { runId: 'wf-d', journal });
    expect(fleet.pages).toHaveLength(0);
  });
});

describe('the runbook, as something that can fail', () => {
  // Without this test the two scoring rules are unfalsifiable: every run the mock produces scores
  // 1.0, so a scorer wired to the wrong tool names would look exactly as healthy.
  it('scores a restart during a latency incident BELOW a clean run', async () => {
    const clean = scoreToolSequence(['searchRunbook', 'getMetric', 'readLog'], RUNBOOK_RULES.latency as any);
    const violating = scoreToolSequence(
      ['searchRunbook', 'getMetric', 'readLog', 'restartService'],
      RUNBOOK_RULES.latency as any,
    );

    expect(clean.score).toBe(1);
    expect(violating.score).toBeLessThan(1);
    expect(violating.reason).toMatch(/forbidden/i);
  });

  it('penalises a run that never opened the runbook', async () => {
    const skipped = scoreToolSequence(['getMetric', 'readLog'], RUNBOOK_RULES.memory as any);
    expect(skipped.score).toBeLessThan(1);
  });
});

describe('the second opinion comes from another agent, over the network', () => {
  it('answers from its MCP tools rather than from its system prompt', async () => {
    const storage = new InMemoryStorage();
    const model = await buildModel();
    const { askSpecialist, dbTools } = await buildSpecialist(storage, model);

    // The tools are the MCP server's, discovered at connect time — not written in this repo.
    expect(Object.keys(dbTools)).toEqual(['db_slowQueries', 'db_connectionPool']);

    const r: any = await (askSpecialist as any).execute({ task: 'why is search slow?' }, { toolCallId: 'a2a-1' });
    // 1840ms is a number that exists only inside the MCP tool's response. Its presence in the answer
    // is the evidence that the call actually went out and came back.
    expect(r.text).toContain('1840ms');
    expect(r.remoteAgent).toBe('dbSpecialist');
  });
});
