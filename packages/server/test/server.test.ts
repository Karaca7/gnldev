// 8.9 — auto-REST: POST /run → suspend → POST /resume → charge exactly-once (over HTTP);
// GET /runs + GET /openapi.json.
import { describe, it, expect } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { InMemoryJournal } from '@gnldev/durable';
import { createRestApi } from '../src/index.js';

function mkModel(): any {
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'm',
    supportedUrls: {},
    doGenerate: async ({ prompt }: any) => {
      const done = (prompt ?? []).filter((m: any) => m.role === 'tool').length;
      const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
      if (done === 0) {
        return { content: [{ type: 'tool-call', toolCallId: 'call-c', toolName: 'chargeCard', input: JSON.stringify({ amount: 5000 }) }], finishReason: 'tool-calls', usage, warnings: [] };
      }
      return { content: [{ type: 'text', text: 'Done.' }], finishReason: 'stop', usage, warnings: [] };
    },
    doStream: async () => {
      throw new Error('no stream');
    },
  };
}

describe('8.9 auto-REST', () => {
  it('run → suspend → resume (charge exactly-once); runs + openapi', async () => {
    const journal = new InMemoryJournal();
    const charges = { n: 0 };
    const tools = {
      chargeCard: tool({
        description: 'charge',
        inputSchema: z.object({ amount: z.number() }),
        execute: async ({ amount }) => {
          charges.n++;
          return { charged: amount };
        },
      }),
    };
    const guard = ({ toolName, args }: any) =>
      toolName === 'chargeCard' && args.amount > 1000 ? { action: 'require-approval' as const } : { action: 'allow' as const };

    const api = createRestApi({ journal, agents: { pay: { model: mkModel(), tools, guard, maxSteps: 6 } } });

    const json = (r: Response) => r.json() as any;

    // run → gets suspended
    const run = await json(
      await api.request('/agents/pay/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: 'o1', prompt: 'charge' }) }),
    );
    expect(run.ok).toBe(true);
    expect(run.interrupts.length).toBe(1);
    expect(charges.n).toBe(0);

    // resume (approve) → charge exactly once
    const res = await json(
      await api.request('/agents/pay/resume', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: 'o1', approvals: { 'call-c': true } }) }),
    );
    expect(res.text).toContain('Done');
    expect(charges.n).toBe(1); // exactly-once holds over HTTP too

    // runs list + openapi
    const runs = await json(await api.request('/runs'));
    expect(runs[0].runId).toBe('o1');
    const spec = await json(await api.request('/openapi.json'));
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.paths['/agents/pay/run']).toBeDefined();
    expect(spec.paths['/agents/pay/resume']).toBeDefined();

    // missing runId → 400
    const bad = await api.request('/agents/pay/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'x' }) });
    expect(bad.status).toBe(400);
  });
});
