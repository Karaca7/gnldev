// App API (hono): open ticket → message (durable run) → high-amount refund waits for approval → /approve resumes it.
// Background: send-email worker + refund event consumer. Ops: refund/email/notification + run trace.
import { Hono } from 'hono';
import { createWorker } from '@gnldev/queue';
import { createConsumer } from '@gnldev/events';
import { exportRun } from '@gnldev/otel';
import { getRunCost, RunBusyError, SideEffectRetryBlockedError, RetryLimitExceededError } from '@gnldev/durable';
import type { Storage } from '@gnldev/durable';
import { APP_HTML } from './ui.js';
import { ORDERS, type OrderRow } from './knowledge.js';
import type { AppState } from './agent.js';

interface Ticket {
  id: string; customerId: string; subject: string; status: 'open' | 'awaiting-approval' | 'closed';
  messages: { role: 'user' | 'assistant' | 'system'; text: string }[];
  pending?: { runId: string; toolCallId: string; reason: string };
  msgCount: number;
}

export function buildServer(opts: {
  storage: Storage;
  gnl: { run: (name: string, o: any) => Promise<any> };
  resume: (runId: string, approvals: Record<string, boolean>) => Promise<any>;
  memory: { createThread: (i: any) => Promise<any> };
  state: AppState;
}) {
  const { storage, gnl, resume, memory, state } = opts;
  const journal = storage.runs; // OTEL/cost via the low-level RunJournal
  const app = new Hono();

  // K1: gnl.run/resume (messages, approve) are called without try/catch — a double-clicked approval or
  // a concurrent message can throw SideEffectRetryBlockedError/RunBusyError/RetryLimitExceededError
  // from @gnldev/durable (see durable-tool.ts blockedOrThrow → run.ts errorFromBlocked, the request that
  // LOSES the atomic tool-claim race for the same runId). If uncaught, Hono's default returns 500 — the
  // client would think "the server crashed", when it's actually a deterministic and RESUMABLE state
  // (retrying/replay resolves it). The `instanceof || err?.name === '...'` pair is the SAME pattern as
  // limitErrorResponse in @gnldev/server (packages/server/src/index.ts) — instanceof alone would also work
  // in this repo (@gnldev/durable is symlinked as a single dist copy, see node_modules/@gnldev/durable), but
  // the name-check also makes it resilient to class-identity differences coming from a different
  // module-resolution/build path (e.g. a separate tsc output) — consistent with the existing architecture, no extra cost.
  app.onError((err, c) => {
    if (err instanceof SideEffectRetryBlockedError || (err as any)?.name === 'SideEffectRetryBlockedError') {
      return c.json({ error: err.message, code: 'side_effect_retry_blocked', resumable: true }, 409);
    }
    if (err instanceof RunBusyError || (err as any)?.name === 'RunBusyError') {
      return c.json({ error: err.message, code: 'run_busy', resumable: true }, 409);
    }
    if (err instanceof RetryLimitExceededError || (err as any)?.name === 'RetryLimitExceededError') {
      return c.json({ error: err.message, code: 'retry_limit_exceeded' }, 422);
    }
    console.error(err);
    return c.json({ error: 'internal error' }, 500);
  });

  const tickets = new Map<string, Ticket>();
  const emails: any[] = [];
  const notifications: any[] = [];

  // Background: email job worker + refund event consumer (exactly-once delivery).
  const worker = createWorker(storage, { 'send-email': async (p: any) => void emails.push(p) });
  const consumer = createConsumer(storage.work!, 'refunds', (p: any) => void notifications.push(p), { name: 'app' });
  const pump = setInterval(() => { void worker.runOnce(); void consumer.poll(); }, 250);

  app.get('/', (c) => c.html(APP_HTML));

  app.get('/api/tickets', (c) => c.json([...tickets.values()].map((t) => ({ id: t.id, subject: t.subject, status: t.status, customerId: t.customerId }))));

  app.get('/api/tickets/:id', (c) => {
    const t = tickets.get(c.req.param('id'));
    return t ? c.json(t) : c.json({ error: 'not found' }, 404);
  });

  app.post('/api/tickets', async (c) => {
    const { customerId, subject } = (await c.req.json().catch(() => ({}))) as any;
    if (!customerId || !subject) return c.json({ error: 'customerId + subject required' }, 400);
    const id = `t-${tickets.size + 1}`;
    await memory.createThread({ id, resourceId: customerId, title: subject });
    tickets.set(id, { id, customerId, subject, status: 'open', messages: [], msgCount: 0 });
    return c.json({ ticketId: id });
  });

  app.post('/api/tickets/:id/messages', async (c) => {
    const t = tickets.get(c.req.param('id'));
    if (!t) return c.json({ error: 'ticket not found' }, 404);
    const { text } = (await c.req.json().catch(() => ({}))) as any;
    if (!text) return c.json({ error: 'text required' }, 400);
    t.messages.push({ role: 'user', text });
    const runId = `${t.id}:m${t.msgCount++}`;
    const r = await gnl.run('support', { runId, prompt: text, threadId: t.id, resourceId: t.customerId });
    if (r.interrupts.length) {
      const it = r.interrupts[0];
      t.pending = { runId, toolCallId: it.toolCallId, reason: it.reason ?? 'approval required' };
      t.status = 'awaiting-approval';
      t.messages.push({ role: 'system', text: `⏸ Awaiting approval: ${t.pending.reason}` });
    } else {
      t.status = 'open';
      t.messages.push({ role: 'assistant', text: r.text });
    }
    return c.json({ reply: r.text, pending: t.pending ?? null });
  });

  // Double-clicked approval: two concurrent requests read the SAME t.pending (runId+toolCallId) and
  // race on resume(). @gnldev/durable's atomic tool-claim leaves a single winner (see durable-tool.ts) —
  // if the LOSING request arrives after the WINNER has already written 'succeeded' (e.g. a very fast
  // tool), it gets the idempotent REPLAY result from the journal and returns a normal 200 (no separate
  // code needed, exactly-once already gives this); only if the loser catches up WHILE the winner is
  // STILL RUNNING does it get RunBusyError → the onError above returns 409 + resumable, and the client
  // retries. An extra "already approved" check was DELIBERATELY NOT added here: the journal is already
  // the correct source-of-truth, re-querying duplicates the state and widens the race window
  // (TOCTOU) — this is the simplest correct behavior.
  app.post('/api/tickets/:id/approve', async (c) => {
    const t = tickets.get(c.req.param('id'));
    if (!t?.pending) return c.json({ error: 'no pending approval' }, 400);
    const { approve } = (await c.req.json().catch(() => ({}))) as any;
    const r = await resume(t.pending.runId, { [t.pending.toolCallId]: approve !== false });
    t.messages.push({ role: 'assistant', text: r.text || (approve !== false ? 'Processed.' : 'Rejected.') });
    t.pending = undefined;
    t.status = 'open';
    return c.json({ reply: r.text });
  });

  // Ops: background status + a run's trace summary (OTEL).
  app.get('/api/ops', (c) => c.json({ refunds: state.refunds, emailsSent: emails.length, notifications: notifications.length, tickets: tickets.size }));
  app.get('/api/tickets/:id/trace', async (c) => {
    const t = tickets.get(c.req.param('id'));
    if (!t || t.msgCount === 0) return c.json({ error: 'no run' }, 404);
    const runId = `${t.id}:m0`;
    const { traceId, spans } = await exportRun(journal, runId, { serviceName: 'support-desk' });
    const cost = await getRunCost(journal, runId);
    return c.json({ traceId, spans, costUsd: cost.costUsd, tokens: cost.totalTokens });
  });

  app.get('/api/orders/:id', (c) => {
    const o: OrderRow | undefined = ORDERS[c.req.param('id')];
    return o ? c.json(o) : c.json({ error: 'not found' }, 404);
  });

  return { app, stop: () => clearInterval(pump) };
}
