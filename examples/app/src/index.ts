// Durable AI Support Desk — a real app that uses our framework end to end. NO API KEY NEEDED.
//   app  → http://localhost:3000  (web UI + API)
//   ops  → http://localhost:4321  (studio: time-travel/fork/approval)
import { serve } from '@hono/node-server';
import { rmSync } from 'node:fs';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { toJournal } from '@gnldev/durable';
import { createStudioApp } from '@gnldev/studio';
import { buildSupport } from './agent.js';
import { buildServer } from './server.js';

rmSync('support.db', { force: true }); // start fresh; remove this line to keep the journal PERSISTENT across restarts
const storage = new SqliteStorage('support.db'); // all store ports (run + memory + cache + work)
const state = { refunds: { count: 0, total: 0 } };

const { gnl, memory, resume } = await buildSupport(storage, state);
const { app } = buildServer({ storage, gnl, resume, memory, state });

// Embed Studio into the SAME app under /studio (no separate port). API/admin separation + write-auth:
// if STUDIO_ADMIN is set, fork/resume require an `x-studio-admin` header (viewer read stays open).
const ADMIN = process.env.STUDIO_ADMIN;
app.mount('/studio', createStudioApp({
  reader: toJournal(storage.runs),
  apiBase: '/studio',
  resume: async (runId, approvals) => { const r = await resume(runId, approvals); return { text: r.text, interrupts: r.interrupts }; },
  // Memory/Threads view: without a resourceId, ALL threads (listAllThreads); with one, only that resource's.
  memory: {
    listThreads: (rid) => (rid ? memory.listThreads({ resourceId: rid }) : memory.listAllThreads()),
    getMessages: (tid) => memory.getMessages(tid),
    getWorkingMemory: (tid) => memory.getWorkingMemory(tid),
    truncateMessages: (tid, afterIndex) => memory.truncateMessagesAfter(tid, afterIndex),
  },
  auth: { write: (c) => !ADMIN || c.req.header('x-studio-admin') === ADMIN },
}));

const APP_PORT = Number(process.env.PORT ?? 3100);
serve({ fetch: app.fetch, port: APP_PORT });
console.log(`\n🎫 Support Desk → http://localhost:${APP_PORT}`);
console.log(`🔍 Ops Studio   → http://localhost:${APP_PORT}/studio   (admin-write ${ADMIN ? 'token protected' : 'open'})\n`);
console.log('Try it: open a ticket for "cust-1" → type "I want a refund for ORD-1042" → an approval prompt appears → Approve.\n');
