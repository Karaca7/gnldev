// Open the gnl-demo.db produced by the demo in the browser. FULL demo of the Phase 2–4 views:
// Workflows (registry + run + resume), Scorers, A2A Networks, MCP Servers.
import { serve } from '@hono/node-server';
import { SqliteStorage } from '@gnl/durable/sqlite';
import { createGnl, toJournal } from '@gnl/durable';
import { createStudioApp, createStudioRunner } from '@gnl/studio';
import { workflow, step, waitFor } from '@gnl/workflow';
import { scoreRun, contains, exactMatch } from '@gnl/evals';

const storage = new SqliteStorage('gnl-demo.db');
const journal = storage.runs;

// Networks demo: seed an a2a-shaped edge (the real createA2ATool output looks exactly like this: {text,remoteAgent,runId}).
// Since the demo's local a2a mock doesn't write these fields, we add them here to show the Networks view.
await journal.put('demo-router:tool:call-1', { status: 'succeeded', output: { text: 'research complete', remoteAgent: 'researcher', runId: 'a2a:demo-1' } });
await journal.put('a2a:demo-1:model:0', { content: [{ type: 'text', text: 'remote agent response' }], finishReason: 'stop' });

// Order workflow: sequential + parallel composite (completes).
const orderWf = workflow<{ orderId?: string }>()
  .then(step('validate-order', async (i: any) => ({ ...i, valid: true })))
  .then(step('reserve-stock', async (i: any) => ({ ...i, reserved: true })))
  .parallel([
    step('charge-card', async () => ({ charged: true })),
    step('send-receipt', async () => ({ sent: true })),
  ])
  .then(step('confirm', async (i: any) => ({ ...i, confirmed: true })));

// Approval workflow: SUSPENDS with waitFor → continues via "Resume" from the studio (passes on the second evaluation).
let waitTick = 0;
const approvalWf = workflow<{ ticket?: string }>()
  .then(step('prepare', async (i: any) => ({ ...i, prepared: true })))
  .then(waitFor('await-approval', async () => (++waitTick % 2 === 0 ? { approved: true } : null)))
  .then(step('finalize', async (i: any) => ({ ...i, done: true })));

const config = { storage, workflows: { 'order-fulfillment': orderWf, 'approval-flow': approvalWf } };
const gnl = createGnl(config);

// Scorers: heuristic scorers without an API key (enter expected → Inspector Score tab).
const scorerFns: Record<string, () => any> = { contains: () => contains(), exact: () => exactMatch() };

// MCP: fake client (no real connection needed) — demonstrates listTools introspection.
const githubMcp = {
  listTools: async () => ({
    tools: [
      { name: 'search_repos', description: 'Searches GitHub repos', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } },
      { name: 'create_issue', description: 'Opens an issue', inputSchema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title'] } },
    ],
  }),
};

const app = createStudioApp({
  reader: toJournal(journal),
  resume: async () => ({ text: 'demo resume' }),
  // Governance demo: tenant budgets (usage bar + overage badge in the Tenants view).
  budgets: { default: { tokenLimit: 2000 }, perTenant: { globex: { tokenLimit: 5000 } } },
  gnl: createStudioRunner(gnl, { ...config, journal }),
  scorers: {
    list: () => Object.keys(scorerFns),
    score: (runId, names, opts) => scoreRun(journal, runId, names.map((n) => scorerFns[n]?.()).filter(Boolean), opts),
  },
  a2a: true, // gnl-demo.db has router-1 → a2a:* calls → Networks is populated
  mcp: [{ id: 'github', name: 'GitHub (demo)', client: githubMcp }],
});
serve({ fetch: app.fetch, port: 4321 });
console.log('gnl studio → http://localhost:4321  (first generate gnl-demo.db with `pnpm demo`)');
