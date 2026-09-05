// The surface an on-call engineer actually touches.
//
// ONE app, one port, four things mounted on it:
//
//   /alerts, /incidents  the operational API for this example (Hono, hand-written)
//   /chat                @gnldev/chat-adapter — a streaming route the AI SDK's useChat talks to
//   /api                 @gnldev/server — the generic REST API over agents/runs/workflows
//   /studio              @gnldev/studio — time travel, the approval queue, the journal
//
// The approval endpoint is the reason the split matters. A restart waits for a person, and a person
// needs somewhere to say yes. That is not a chat message — it is an authenticated write against a
// specific suspended run, which is why it is a route with a gate on it and not a prompt.
import { Hono } from 'hono';
import { createChatRoute } from '@gnldev/chat-adapter';
import { createRestApi } from '@gnldev/server';
import { createStudioApp } from '@gnldev/studio';
import { roleAuth, makeGate } from '@gnldev/auth';
import { toJournal } from '@gnldev/durable';
import { submitAlert } from './schedule.js';
import { scoreIncident, RUNBOOK_RULES } from './observe.js';
import type { Alert, Resolved } from './workflow.js';

/**
 * What `GET /incidents` answers.
 *
 * `runId` and `awaiting` are the whole point of the shape: without them an operator can see that a
 * run is waiting but has no way to name the decision they are approving, and the approve endpoint —
 * which deliberately takes a specific toolCallId rather than "resume this run" — is unusable from
 * outside Studio. An API that can only be driven by reading the source is an API that gets driven by
 * restarting things instead.
 */
export interface IncidentView extends Alert {
  runId: string;
  status: 'triaging' | 'awaiting-approval' | 'resolved';
  diagnosis?: string;
  paged?: boolean;
  awaiting?: Resolved['awaiting'];
}

export interface ServerDeps {
  storage: any;
  gnl: any;
  /** The same agent definitions `createGnl` was given — see the REST section below for why. */
  agents: Record<string, any>;
  memory: any;
  resume: (runId: string, approvals: Record<string, boolean>) => Promise<any>;
  /** Alerts received, each with whatever triage has concluded about it so far. */
  incidents: () => IncidentView[];
  fleet: { restarts: unknown[]; pages: unknown[] };
}

/**
 * Who may approve a restart, and who may only look.
 *
 * Two classes rather than one flag, because they are genuinely different people during an incident: a
 * responder needs to read the journal and the diagnosis immediately, and exactly one person needs to
 * be able to say yes to taking production down. Collapsing them into a single token means everyone
 * who can watch can also restart.
 *
 * Unset, both are open and `@gnldev/auth` says so once on the first request. That is the right
 * default for `pnpm start` on a laptop and the wrong one everywhere else — which is why
 * `createRestApi` REFUSES to start without a provider under NODE_ENV=production rather than quietly
 * carrying this convenience into a deployment.
 *
 *   ONCALL_ADMIN=s3cr3t  → curl -H 'authorization: Bearer s3cr3t' …
 */
const ADMIN = process.env.ONCALL_ADMIN;
const VIEWER = process.env.ONCALL_VIEWER;
const authProvider = roleAuth({
  admin: ADMIN ? { token: ADMIN } : undefined,
  viewer: VIEWER ? { token: VIEWER } : undefined,
});
// `roleAuth({})` is undefined — no classes configured means no provider, not a provider that refuses
// Everyone. `makeGate` then opens the surface, which is why `allowOpenAccess` below is tied to the
// Same condition instead of being hard-coded true.
const gate = makeGate(authProvider, { allowOpenAccess: !authProvider });

export function buildServer(deps: ServerDeps) {
  const { storage, gnl, memory, resume, incidents, fleet } = deps;
  const app = new Hono();

  app.get('/', (c) =>
    c.json({
      service: 'oncall-triage',
      endpoints: [
        'POST /alerts', 'GET /incidents', 'GET /incidents/:runId/score',
        'POST /incidents/:runId/approve', 'POST /chat', '/api', '/studio',
      ],
      fleet: { restarts: fleet.restarts.length, pages: fleet.pages.length },
    }),
  );

  /** An alert from the monitoring system. Returns immediately — the work is a durable job. */
  app.post('/alerts', async (c) => {
    const body = await c.req.json<Partial<Alert>>();
    if (!body.incidentId || !body.service || !body.text) {
      return c.json({ error: 'incidentId, service and text are required' }, 400);
    }
    const jobId = await submitAlert(storage.work, {
      incidentId: body.incidentId,
      service: body.service,
      text: body.text,
      severity: body.severity ?? 'sev2',
    });
    // 202, not 200: nothing has been triaged yet. Answering 200 with an empty diagnosis is how a
    // Monitoring system learns to stop trusting the acknowledgement.
    return c.json({ accepted: true, jobId }, 202);
  });

  app.get('/incidents', (c) => c.json({ incidents: incidents() }));

  /**
   * Did the run follow the runbook?
   *
   * A read, and deliberately available while the incident is still open. Scoring is usually filed
   * under "offline evaluation", but the question it answers here — did this agent do the sequence the
   * document says — is one you most want answered in the minute before you approve its restart.
   */
  app.get('/incidents/:runId/score', async (c) => {
    const runId = c.req.param('runId');
    const alert = incidents().find((i) => i.runId === runId);
    const rules = alert && /p99|latenc|slow/i.test(alert.text) ? RUNBOOK_RULES.latency : RUNBOOK_RULES.memory;
    return c.json(await scoreIncident(storage, runId, rules));
  });

  /**
   * A human answers the approval. The run continues from where it suspended.
   *
   * Note what is NOT here: any way to say "run the restart". The only thing this endpoint can do is
   * release a decision the agent already reached and the journal already recorded, addressed by the
   * toolCallId of that exact suspended call.
   */
  app.post('/incidents/:runId/approve', async (c) => {
    if (!(await gate.allow(c.req.raw, 'write'))) return gate.deny(c.req.raw, 'write');
    const runId = c.req.param('runId');
    const { toolCallId, approved } = await c.req.json<{ toolCallId: string; approved?: boolean }>();
    if (!toolCallId) return c.json({ error: 'toolCallId is required' }, 400);
    const r = await resume(runId, { [toolCallId]: approved !== false });
    return c.json({ runId, text: r.text, interrupts: r.interrupts });
  });

  // The streaming route. `resolveThreadId` keys memory on the INCIDENT, so an engineer who reloads
  // The page continues the same conversation instead of starting a fresh one mid-incident.
  app.route(
    '/chat',
    createChatRoute(
      { gnl },
      {
        resolveThreadId: (_c, body) => body?.incidentId ?? body?.id,
        resolveRunId: (_c, body) => body?.runId,
      },
    ),
  );

  // The generic REST API, gated by the same token as the approval endpoint. It is built from the
  // Agent config rather than from the `gnl` handle: createRestApi builds its own registry, and
  // Handing it a live instance would give two owners to one journal.
  const restApi = createRestApi(
    { storage, agents: deps.agents },
    { title: 'On-call Triage API', auth: authProvider, allowOpenAccess: !authProvider },
  );
  app.route('/api', new Hono().all('/*', (c) => restApi(c.req.raw)));

  app.mount(
    '/studio',
    createStudioApp({
      reader: toJournal(storage.runs),
      apiBase: '/studio',
      resume: async (runId, approvals) => {
        const r = await resume(runId, approvals);
        return { text: r.text, interrupts: r.interrupts };
      },
      memory: {
        listThreads: (opts) => memory.listThreads(opts),
        listAllThreads: () => memory.listAllThreads(),
        getMessages: (tid) => memory.getMessages(tid),
        getWorkingMemory: (tid) => memory.getWorkingMemory(tid),
        truncateMessages: (tid, afterIndex) => memory.truncateMessagesAfter(tid, afterIndex),
      },
      auth: authProvider,
    }),
  );

  return { app, adminToken: ADMIN };
}
