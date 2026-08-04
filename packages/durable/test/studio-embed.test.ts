// Studio embed API: createStudioApp({reader, resume}) → approval-queue Approve, exactly-once preserved in the embed too.
// (Test lives in the durable package because ai/zod are here; studio's server does not import @gnldev/durable at runtime.)
import { describe, it, expect } from 'vitest';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { createStudioApp } from '../../studio/src/server.js';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable, resumeRun } from '../src/run.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';
import type { Guard } from '../src/guard.js';
import { call } from './call.js';

function makeModel() {
  return createMockModel(async ({ prompt }: any) => {
    const done = countToolResults(prompt);
    if (done === 0) return toolCallResult('chargeCard', 'call-c', { amount: 5000 });
    return finalTextResult('Done.');
  });
}
const guard: Guard = ({ toolName, args }) =>
  toolName === 'chargeCard' && (args as any).amount > 1000 ? { action: 'require-approval' } : { action: 'allow' };

describe('studio embed API', () => {
  it('capabilities + runs listesi + POST resume(approve) → charge=1; chat yoksa 501', async () => {
    const journal = new InMemoryJournal();
    const counter = { charges: 0 };
    const tools = () => ({
      chargeCard: tool({
        description: 'charge',
        inputSchema: z.object({ amount: z.number() }),
        execute: async ({ amount }) => {
          counter.charges++;
          return { charged: amount };
        },
      }),
    });

    // produce a suspended run
    await runDurable({
      runId: 'o1', journal, model: makeModel(), tools: tools(), guard,
      prompt: 'charge', stopWhen: stepCountIs(6),
    });
    expect(counter.charges).toBe(0);

    const app = createStudioApp({
      reader: journal,
      resume: async (runId, approvals) => {
        const r = await resumeRun(runId, { journal, model: makeModel(), tools: tools(), guard, approvals });
        return { text: r.text, interrupts: r.interrupts };
      },
    });

    const caps = await (await call(app, '/api/capabilities')).json();
    // M3: writable journal + resume → fork is open. Playground/stream are closed since gnl wasn't provided.
    // (the full capabilities shape returns 14 fields; verify the relevant subset → tolerant of added fields.)
    expect(caps).toMatchObject({ resume: true, chat: false, fork: true, playground: false, stream: false });

    const runs = (await (await call(app, '/api/runs')).json()) as any[];
    expect(runs[0].runId).toBe('o1');
    expect(runs[0].status).toBe('suspended');

    const res = await call(app, '/api/runs/o1/resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approvals: { 'call-c': true } }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(counter.charges).toBe(1); // exactly-once preserved via the embed too

    const chatRes = await call(app, '/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    });
    expect(chatRes.status).toBe(501);
  });
});
