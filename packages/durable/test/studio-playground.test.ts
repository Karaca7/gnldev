// Studio Playground: createStudioApp({reader, gnl}) → list /agents, /agents/:name/run + /stream,
// suspend in stream → interrupt event, same runId with approvals → exactly-once.
// (Test lives in the durable package because ai/zod are here; studio uses createGnl/streamDurable.)
import { describe, it, expect } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { createStudioApp } from '../../studio/src/server.js';
import { createStudioRunner } from '../../studio/src/runner.js';
import { InMemoryJournal } from '../src/journal.js';
import { createGnl } from '../src/registry.js';
import type { Guard } from '../src/guard.js';
import { call } from './call.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const mkStream = (arr: any[]) => new ReadableStream({ start(c) { for (const p of arr) c.enqueue(p); c.close(); } });

function agentMock(): any {
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
    doGenerate: async ({ prompt }: any) => {
      const done = (prompt ?? []).filter((mm: any) => mm.role === 'tool').length;
      if (done === 0) return { content: [{ type: 'tool-call', toolCallId: 'call-c', toolName: 'chargeCard', input: JSON.stringify({ amount: 5000 }) }], finishReason: 'tool-calls', usage, warnings: [] };
      return { content: [{ type: 'text', text: 'Done.' }], finishReason: 'stop', usage, warnings: [] };
    },
    doStream: async ({ prompt }: any) => {
      const done = (prompt ?? []).filter((mm: any) => mm.role === 'tool').length;
      if (done === 0) return { stream: mkStream([{ type: 'stream-start', warnings: [] }, { type: 'tool-call', toolCallId: 'call-c', toolName: 'chargeCard', input: JSON.stringify({ amount: 5000 }) }, { type: 'finish', finishReason: 'tool-calls', usage }]) };
      return { stream: mkStream([{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: 'Done.' }, { type: 'text-end', id: '1' }, { type: 'finish', finishReason: 'stop', usage }]) };
    },
  };
}

const guard: Guard = ({ toolName, args }) =>
  toolName === 'chargeCard' && (args as any).amount > 1000 ? { action: 'require-approval' } : { action: 'allow' };

async function readSSE(res: Response): Promise<{ event: string; data: any }[]> {
  const text = await res.text();
  return text.split('\n\n').filter((f) => f.trim()).map((frame) => {
    let event = 'message'; let data = '';
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    return { event, data: data ? JSON.parse(data) : undefined };
  });
}

describe('studio playground', () => {
  it('capabilities.playground + /agents + /agents/:name/run (suspend) + approvals → charge=1', async () => {
    const journal = new InMemoryJournal();
    const charges = { n: 0 };
    const config = {
      journal,
      agents: {
        pay: {
          model: agentMock(),
          tools: {
            chargeCard: tool({
              description: 'charge',
              inputSchema: z.object({ amount: z.number() }),
              execute: async ({ amount }) => { charges.n++; return { charged: amount }; },
            }),
          },
          guard,
          maxSteps: 6,
        },
      },
    };
    const gnl = createGnl(config);
    const app = createStudioApp({ reader: journal, gnl: createStudioRunner(gnl, config) });

    const caps = await (await call(app, '/api/capabilities')).json();
    expect(caps.playground).toBe(true);
    expect(caps.stream).toBe(true);

    const agents = (await (await call(app, '/api/agents')).json()) as any[];
    // agent meta now also includes the tool list (for the studio Tools view) → verify the subset.
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ name: 'pay', model: 'custom', hasTools: true, maxSteps: 6 });

    // run → suspend
    const run = await (await call(app, '/api/agents/pay/run', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: 'p1', prompt: 'charge' }),
    })).json();
    expect(run.interrupts.length).toBe(1);
    expect(charges.n).toBe(0);

    // approve via run (same runId + prompt + approvals) → charge exactly-once
    const res = await (await call(app, '/api/agents/pay/run', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: 'p1', prompt: 'charge', approvals: { 'call-c': true } }),
    })).json();
    expect(res.text).toContain('Done');
    expect(charges.n).toBe(1);
  });

  it('/agents/:name/stream → text-delta + suspend interrupt event', async () => {
    const journal = new InMemoryJournal();
    const charges = { n: 0 };
    const config = {
      journal,
      agents: {
        pay: {
          model: agentMock(),
          tools: { chargeCard: tool({ description: 'charge', inputSchema: z.object({ amount: z.number() }), execute: async ({ amount }) => { charges.n++; return { charged: amount }; } }) },
          guard, maxSteps: 6,
        },
      },
    };
    const app = createStudioApp({ reader: journal, gnl: createStudioRunner(createGnl(config), config) });

    const res = await call(app, '/api/agents/pay/stream', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: 's1', prompt: 'charge' }),
    });
    const events = await readSSE(res);
    expect(events.some((e) => e.event === 'tool-call')).toBe(true);
    expect(events.find((e) => e.event === 'interrupt')?.data.interrupts.length).toBe(1);
    expect(charges.n).toBe(0);
    expect(events[events.length - 1].event).toBe('done');
  });

  it('playground closed when gnl is absent (501) + /agents empty', async () => {
    const journal = new InMemoryJournal();
    const app = createStudioApp({ reader: journal });
    expect((await (await call(app, '/api/agents')).json())).toEqual([]);
    const run = await call(app, '/api/agents/x/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: 'z', prompt: 'h' }) });
    expect(run.status).toBe(501);
  });

  it('auth.write → unauthorized playground run 403', async () => {
    const journal = new InMemoryJournal();
    const config = { journal, agents: { pay: { model: agentMock(), maxSteps: 4 } } };
    const app = createStudioApp({
      reader: journal,
      gnl: createStudioRunner(createGnl(config), config),
      auth: { write: (c) => c.req.header('x-admin') === 'secret' },
    });
    const denied = await call(app, '/api/agents/pay/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: 'a1', prompt: 'hi' }) });
    expect(denied.status).toBe(403);
  });
});
