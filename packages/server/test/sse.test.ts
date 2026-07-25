// SSE: GET /agents + POST /agents/:name/stream — text streaming, tool-call + suspend → interrupt event, done.
import { describe, it, expect } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { InMemoryJournal } from '@gnldev/durable';
import { createRestApi } from '../src/index.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const mkStream = (arr: any[]) =>
  new ReadableStream({
    start(c) {
      for (const p of arr) c.enqueue(p);
      c.close();
    },
  });

/** Mock that only streams text. */
function textMock(): any {
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'm',
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error('no gen');
    },
    doStream: async () => ({
      stream: mkStream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: '1' },
        { type: 'text-delta', id: '1', delta: 'Hello ' },
        { type: 'text-delta', id: '1', delta: 'world' },
        { type: 'text-end', id: '1' },
        { type: 'finish', finishReason: 'stop', usage },
      ]),
    }),
  };
}

/** 0 tool results → chargeCard tool-call; then final text. */
function agentMock(): any {
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'm',
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error('no gen');
    },
    doStream: async ({ prompt }: any) => {
      const done = (prompt ?? []).filter((mm: any) => mm.role === 'tool').length;
      if (done === 0) {
        return {
          stream: mkStream([
            { type: 'stream-start', warnings: [] },
            { type: 'tool-call', toolCallId: 'call-c', toolName: 'chargeCard', input: JSON.stringify({ amount: 5000 }) },
            { type: 'finish', finishReason: 'tool-calls', usage },
          ]),
        };
      }
      return {
        stream: mkStream([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: '1' },
          { type: 'text-delta', id: '1', delta: 'Done.' },
          { type: 'text-end', id: '1' },
          { type: 'finish', finishReason: 'stop', usage },
        ]),
      };
    },
  };
}

/** P0.1: a reasoning model — thinking trace + source + file BEFORE the answer text. */
function reasoningMock(): any {
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'm',
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error('no gen');
    },
    doStream: async () => ({
      stream: mkStream([
        { type: 'stream-start', warnings: [] },
        { type: 'reasoning-start', id: 'rs1' },
        { type: 'reasoning-delta', id: 'rs1', delta: 'Let me think… ' },
        { type: 'reasoning-delta', id: 'rs1', delta: 'ok.' },
        { type: 'reasoning-end', id: 'rs1' },
        { type: 'source', sourceType: 'url', id: 's1', url: 'https://example.com', title: 'Example' },
        { type: 'file', mediaType: 'image/png', data: new Uint8Array([1, 2, 3]) },
        { type: 'text-start', id: '1' },
        { type: 'text-delta', id: '1', delta: 'Answer' },
        { type: 'text-end', id: '1' },
        { type: 'finish', finishReason: 'stop', usage },
      ]),
    }),
  };
}

async function readSSE(res: Response): Promise<{ event: string; data: any }[]> {
  const text = await res.text();
  return text
    .split('\n\n')
    .filter((f) => f.trim())
    .map((frame) => {
      let event = 'message';
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      return { event, data: data ? JSON.parse(data) : undefined };
    });
}

describe('@gnldev/server SSE', () => {
  it('GET /agents → lists registered agent metadata', async () => {
    const api = createRestApi({ journal: new InMemoryJournal(), agents: { chat: { model: textMock(), maxSteps: 4 } } });
    const agents = (await (await api.request('/agents')).json()) as any[];
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ name: 'chat', model: 'custom', hasTools: false, maxSteps: 4 });
  });

  it('POST /agents/:name/stream → text-delta events + done', async () => {
    const api = createRestApi({ journal: new InMemoryJournal(), agents: { chat: { model: textMock(), maxSteps: 4 } } });
    const res = await api.request('/agents/chat/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'r1', prompt: 'hi' }),
    });
    const events = await readSSE(res);
    const deltas = events.filter((e) => e.event === 'text-delta').map((e) => e.data.text).join('');
    expect(deltas).toBe('Hello world');
    expect(events[events.length - 1].event).toBe('done');
    expect(events[events.length - 1].data.runId).toBe('r1');
  });

  // P0.1 (AUDIT-R2): reasoning/source/file used to be SILENTLY DROPPED (a switch with only
  // 4 cases and no default) — a reasoning model's whole thinking trace vanished with no error.
  it('P0.1: reasoning-delta + source + file events are emitted (no silent drop)', async () => {
    const api = createRestApi({ journal: new InMemoryJournal(), agents: { think: { model: reasoningMock(), maxSteps: 4 } } });
    const res = await api.request('/agents/think/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'rt1', prompt: 'hi' }),
    });
    const events = await readSSE(res);
    const reasoning = events.filter((e) => e.event === 'reasoning-delta').map((e) => e.data.text).join('');
    expect(reasoning).toBe('Let me think… ok.');
    expect(events.some((e) => e.event === 'reasoning-start')).toBe(true);
    expect(events.some((e) => e.event === 'reasoning-end')).toBe(true);
    const source = events.find((e) => e.event === 'source');
    expect(source?.data).toMatchObject({ sourceType: 'url', url: 'https://example.com', title: 'Example' });
    const file = events.find((e) => e.event === 'file');
    expect(file?.data.mediaType).toBe('image/png');
    // answer text still flows, and done still terminates the stream
    expect(events.filter((e) => e.event === 'text-delta').map((e) => e.data.text).join('')).toBe('Answer');
    expect(events[events.length - 1].event).toBe('done');
  });

  it('stream + guard suspend → interrupt event, tool does not run', async () => {
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
    const api = createRestApi({ journal: new InMemoryJournal(), agents: { pay: { model: agentMock(), tools, guard, maxSteps: 6 } } });

    const res = await api.request('/agents/pay/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'o1', prompt: 'charge' }),
    });
    const events = await readSSE(res);
    expect(events.some((e) => e.event === 'tool-call')).toBe(true);
    const interrupt = events.find((e) => e.event === 'interrupt');
    expect(interrupt?.data.interrupts.length).toBe(1);
    expect(charges.n).toBe(0); // no side effect while waiting for approval
    expect(events[events.length - 1].event).toBe('done');
  });

  it('Decision #2: loop limit in a stream → sentinel does NOT leak, terminal error event (with code), NO done', async () => {
    let realRuns = 0;
    const tools = {
      stuck: tool({
        description: 'tool that always does the same thing',
        inputSchema: z.object({}),
        execute: async () => {
          realRuns++;
          return { attempt: realRuns };
        },
      }),
    };
    // The model calls the same tool with the SAME arguments on EVERY step (a genuine runaway loop).
    const loopMock: any = {
      specificationVersion: 'v2',
      provider: 'mock',
      modelId: 'm',
      supportedUrls: {},
      doGenerate: async () => {
        throw new Error('no gen');
      },
      doStream: async ({ prompt }: any) => {
        const done = (prompt ?? []).filter((mm: any) => mm.role === 'tool').length;
        return {
          stream: mkStream([
            { type: 'stream-start', warnings: [] },
            { type: 'tool-call', toolCallId: `call-${done + 1}`, toolName: 'stuck', input: JSON.stringify({}) },
            { type: 'finish', finishReason: 'tool-calls', usage },
          ]),
        };
      },
    };
    const api = createRestApi({ journal: new InMemoryJournal(), agents: { loop: { model: loopMock, tools, maxSteps: 10 } } });

    const res = await api.request('/agents/loop/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'l1', prompt: 'loop', limits: { loopDetection: { maxRepeats: 2 } } }),
    });
    const events = await readSSE(res);
    // 1) The internal sentinel (__gnl_limit_exceeded) does NOT leak into ANY tool-result event.
    for (const e of events.filter((x) => x.event === 'tool-result')) {
      expect(e.data.output?.__gnl_limit_exceeded).toBeUndefined();
    }
    // 2) The terminal `error` event is machine-readable: code + detail (the existing error contract, no new event type).
    const last = events[events.length - 1];
    expect(last.event).toBe('error');
    expect(last.data.code).toBe('tool_loop_detected');
    expect(last.data.detail).toMatchObject({ toolName: 'stuck', maxRepeats: 2 });
    // 3) error = terminal → done is NOT sent (consistent with the error contract on the catch path).
    expect(events.some((e) => e.event === 'done')).toBe(false);
    // 4) The tool ACTUALLY ran exactly maxRepeats times; the next call never executed.
    expect(realRuns).toBe(2);
  });

  it('missing runId → 400', async () => {
    const api = createRestApi({ journal: new InMemoryJournal(), agents: { chat: { model: textMock() } } });
    const bad = await api.request('/agents/chat/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'x' }),
    });
    expect(bad.status).toBe(400);
  });
});
