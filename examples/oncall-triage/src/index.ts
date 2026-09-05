// On-call Incident Triage — the whole framework, wired for one job. NO API KEY NEEDED.
//
//   app     → http://localhost:3200          alerts in, incidents out
//   studio  → http://localhost:3200/studio   the journal, the approval queue, time travel
//
// What this program is for: an alert fires at 3am. Something reads the runbook, gathers the numbers,
// says what is wrong, and — if the runbook calls for it — asks a human for permission to restart a
// service. Then it watches for thirty minutes, because the runbook says to.
//
// Every guarantee here is load-bearing for a reason you can state in one sentence:
//
//   exactly-once   a restart that happens twice is two outages, and there is nothing to refund
//   approval       a person decides, and the run waits without holding a process open
//   redaction      the logs the agent reads carry a database password
//   durability     the thirty-minute watch has to survive the deploy that lands at 3:10am
import { serve } from '@hono/node-server';
import { rmSync } from 'node:fs';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { withIdempotency } from '@gnldev/durable';
import { buildTriage } from './agent.js';
import { buildSpecialist } from './specialist.js';
import { buildIncidentWorkflow, type Alert, type Resolved } from './workflow.js';
import { buildOps, announceRestart, WATCH_WORKFLOW, WATCH_MS } from './schedule.js';
import { buildServer } from './server.js';
import { buildModel } from './model.js';

// Start fresh — delete this line to keep the journal across restarts.
//
// All THREE files, not just the database. SQLite in WAL mode keeps `-wal` and `-shm` beside it, and
// deleting the database alone leaves sidecars describing a file that no longer exists.
//
// Measured, because the obvious guess is wrong: after a CLEAN exit, deleting only the database and
// reopening works. The failure needs a previous process still holding the old database — a restart
// faster than the old one shuts down, a supervisor that has not reaped it, or two copies started by
// accident. Then the fresh database meets the old process's sidecars and the open fails with
// `disk I/O error` before any of this program runs. Deleting all three opens cleanly in the same
// situation. It cost half an hour here; it is one line.
for (const f of ['oncall.db', 'oncall.db-wal', 'oncall.db-shm']) rmSync(f, { force: true });
const storage = new SqliteStorage('oncall.db'); // runs + memory + cache + work, one file

const model = await buildModel();
const { app: specialistApp, askSpecialist } = await buildSpecialist(storage, model);
const { gnl, agents, memory, resume, fleet, journal, tools } = await buildTriage(storage, { askSpecialist });

/**
 * The page, wrapped so the same incident cannot page twice.
 *
 * The tool already declares `idempotency: 'args'` + `idempotencyWindow: 'cross-run'`, but those
 * fields are read by the durable tool layer — which the agent loop applies and a plain function call
 * does NOT. The workflow calls this outside any agent turn, so the wrapper is what puts it back on
 * that layer. Calling `pageEngineer.execute` directly here would look identical and dedup nothing.
 */
const safeTools = withIdempotency({ pageEngineer: tools.pageEngineer } as any, {
  journal,
  window: 'cross-run',
  key: (_name, args: any) => args.incident, // one page per INCIDENT, whoever is on the rota
});

const resolved: Resolved[] = [];
const alerts: Alert[] = [];

const incidentWorkflow = buildIncidentWorkflow({
  runTriage: (a) =>
    gnl.run('triage', {
      runId: `triage:${a.incidentId}`,
      // The service goes in the PROMPT, not only in the routing fields. It was in `resourceId` alone
      // At first, which scopes memory correctly and tells the model nothing: a latency alert reading
      // "p99 regression, 2400ms" names no service, so the agent diagnosed a different one than the
      // Alert was about — confidently, and with a perfect runbook-adherence score, because it followed
      // The procedure faithfully against the wrong subject.
      prompt: `[${a.severity}] service=${a.service} — ${a.text}`,
      threadId: a.incidentId,
      resourceId: a.service,
    }),
  page: (engineer, incident) =>
    (safeTools.pageEngineer as any).execute({ engineer, incident }, { toolCallId: `page:${incident}` }),
  record: async (r) => { resolved.push(r); },
});

/** The scheduler runs workflows BY NAME, so the watch has to be reachable by one. */
const runner = {
  runWorkflow: async (name: string, input: any) => {
    if (name !== WATCH_WORKFLOW) throw new Error(`unknown workflow: ${name}`);
    // The follow-up the runbook asks for: if the leak came back inside the window, this is a code bug.
    // Escalate — do NOT restart a second time.
    const rss = fleet.restarts.some((r: any) => r.service === input.service) ? 1932 : 640;
    if (rss > 1800) {
      await (safeTools.pageEngineer as any).execute(
        { engineer: 'sre-oncall', incident: input.incidentId },
        { toolCallId: `watch:${input.incidentId}` },
      );
    }
    return { runId: `watch:${input.incidentId}` };
  },
};

const ops = buildOps(storage, runner, async (alert) => {
  alerts.push(alert);
  const out = (await incidentWorkflow.run(alert, { runId: `wf:${alert.incidentId}`, journal })) as Resolved;
  // The restart is announced only after it actually happened — the workflow may be sitting on an
  // Approval, in which case there is nothing to watch yet and the event would schedule a watch over
  // A restart that never occurred.
  if (!out?.suspended && fleet.restarts.some((r: any) => r.service === alert.service)) {
    await announceRestart(storage.work, alert.incidentId, alert.service);
  }
});

ops.worker.start();
ops.watcher.start();
// `.catch` is not decoration. A rejected promise from a bare interval callback is an unhandled
// Rejection, and Node's default is to terminate the process — so one transient scheduler error at
// 3am takes down the alert intake, the approval endpoint and Studio along with the poll that failed.
// The tick is the least important thing running here; it must be the least able to kill the rest.
setInterval(() => {
  ops.tick().catch((e) => console.error('[scheduler] poll failed, continuing:', e?.message ?? e));
}, 5_000).unref();

/**
 * Resume, and then tell the incident list what happened.
 *
 * Without this the run finishes and `/incidents` keeps answering "awaiting-approval" forever — the
 * durable state moved on and the view did not. Reconciling a projection after the write is the boring
 * half of event-driven design and the half that gets left out of examples.
 */
const resumeAndRefresh = async (runId: string, approvals: Record<string, boolean>) => {
  const r = await resume(runId, approvals);
  const incidentId = runId.replace(/^triage:/, '');
  const rec = resolved.find((x) => x.incidentId === incidentId);
  if (rec && !r.interrupts?.length) {
    rec.suspended = false;
    rec.awaiting = undefined;
    rec.diagnosis = r.text ?? rec.diagnosis;
    const alert = alerts.find((a) => a.incidentId === incidentId);
    if (alert && fleet.restarts.some((x: any) => x.service === alert.service)) {
      await announceRestart(storage.work, incidentId, alert.service);
    }
  }
  return r;
};

const { app, adminToken } = buildServer({
  storage, gnl, agents, memory, fleet, resume: resumeAndRefresh,
  // The alert as received, joined with whatever triage concluded — including the toolCallId of the
  // Decision that is waiting, which is what the approve endpoint needs and nothing else publishes.
  incidents: () =>
    alerts.map((a) => {
      const r = resolved.find((x) => x.incidentId === a.incidentId);
      return {
        ...a,
        runId: `triage:${a.incidentId}`,
        status: !r ? 'triaging' : r.suspended ? 'awaiting-approval' : 'resolved',
        diagnosis: r?.diagnosis || undefined,
        paged: r?.paged,
        awaiting: r?.awaiting,
      } as const;
    }),
});
app.mount('/specialist', specialistApp as any);

const PORT = Number(process.env.PORT ?? 3200);
// Loopback unless an address is named. A bare serve() binds every interface, and with no admin token
// set that would put an approval endpoint for production restarts on the network.
serve({ fetch: app.fetch, port: PORT, hostname: process.env.HOST ?? '127.0.0.1' });

console.log(`\n🚨 On-call Triage → http://localhost:${PORT}`);
console.log(`🔍 Studio         → http://localhost:${PORT}/studio   (admin-write ${adminToken ? 'token protected' : 'open'})`);
console.log(`⏱  Post-restart watch: ${Math.round(WATCH_MS / 1000)}s (WATCH_MS overrides)\n`);
console.log('Try it:');
console.log(`  curl -XPOST localhost:${PORT}/alerts -H 'content-type: application/json' \\`);
console.log(`    -d '{"incidentId":"INC-1","service":"checkout","severity":"sev1","text":"memory leak suspected"}'`);
console.log(`  → open Studio, find the suspended run, approve the restart.\n`);
