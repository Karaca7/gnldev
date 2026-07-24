// SSE output of the createAguiRoute + pipeAguiStream factory (sse.test.ts readSSE pattern — here AG-UI
// frames don't carry an `event:` field, the type is inside the JSON; see route.ts header note).
import { describe, it, expect } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { InMemoryJournal } from '@gnl/durable';
import { createAguiRoute } from '../src/route.js';
import { EventType } from '../src/types.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const mkStream = (arr: any[]) =>
  new ReadableStream({
    start(c) {
      for (const p of arr) c.enqueue(p);
      c.close();
    },
  });

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

/** 0 tool results → echo tool-call; then final text (sse.test.ts agentMock pattern). */
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
            { type: 'tool-call', toolCallId: 'call-e', toolName: 'echo', input: JSON.stringify({ v: 1 }) },
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

/** AG-UI frames carry only `data:` (event name is inside the JSON) — different from readSSE in sse.test.ts. */
async function readAguiSSE(res: Response): Promise<any[]> {
  const text = await res.text();
  return text
    .split('\n\n')
    .filter((f) => f.trim())
    .map((frame) => {
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      return JSON.parse(data);
    });
}

describe('@gnl/agui createAguiRoute + pipeAguiStream', () => {
  it('POST /agents/:name/run → RUN_STARTED ... TEXT_MESSAGE_* ... RUN_FINISHED', async () => {
    const app = createAguiRoute({ journal: new InMemoryJournal(), agents: { chat: { model: textMock(), maxSteps: 4 } } });
    const res = await app.request('/agents/chat/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'r1', prompt: 'hi' }),
    });
    const events = await readAguiSSE(res);
    expect(events[0]).toMatchObject({ type: EventType.RUN_STARTED, threadId: 'r1', runId: 'r1' });
    // P0.1: step boundaries now travel as CUSTOM gnl.step-* events — the first NON-custom event after
    // RUN_STARTED is still the text start (the old assertion assumed nothing between the two).
    const nonCustom = events.filter((e) => e.type !== EventType.CUSTOM);
    expect(nonCustom[1].type).toBe(EventType.TEXT_MESSAGE_START);
    const deltas = events.filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT).map((e) => e.delta).join('');
    expect(deltas).toBe('Hello world');
    const last = events[events.length - 1];
    expect(last).toMatchObject({ type: EventType.RUN_FINISHED, threadId: 'r1', runId: 'r1' });
  });

  it('threadId is passed from the body (if not given, runId is used)', async () => {
    const app = createAguiRoute({ journal: new InMemoryJournal(), agents: { chat: { model: textMock(), maxSteps: 4 } } });
    const res = await app.request('/agents/chat/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'r2', threadId: 'thread-xyz', prompt: 'hi' }),
    });
    const events = await readAguiSSE(res);
    expect(events[0]).toMatchObject({ type: EventType.RUN_STARTED, threadId: 'thread-xyz', runId: 'r2' });
    expect(events[events.length - 1]).toMatchObject({ type: EventType.RUN_FINISHED, threadId: 'thread-xyz' });
  });

  it('tool-call + tool-result → TOOL_CALL_START/ARGS/END + TOOL_CALL_RESULT events', async () => {
    const execs = { n: 0 };
    const tools = {
      echo: tool({
        description: 'echo',
        inputSchema: z.object({ v: z.number() }),
        execute: async ({ v }: { v: number }) => {
          execs.n++;
          return { v };
        },
      }),
    };
    const app = createAguiRoute({ journal: new InMemoryJournal(), agents: { echoAgent: { model: agentMock(), tools, maxSteps: 6 } } });
    const res = await app.request('/agents/echoAgent/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'r3', prompt: 'go' }),
    });
    const events = await readAguiSSE(res);
    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.TOOL_CALL_START);
    expect(types).toContain(EventType.TOOL_CALL_ARGS);
    expect(types).toContain(EventType.TOOL_CALL_END);
    expect(types).toContain(EventType.TOOL_CALL_RESULT);
    expect(execs.n).toBe(1);
    expect(events[events.length - 1].type).toBe(EventType.RUN_FINISHED);
  });

  it('guard suspend → interrupt CUSTOM event (gnl.interrupt), tool does not run', async () => {
    const charges = { n: 0 };
    const tools = {
      chargeCard: tool({
        description: 'charge',
        inputSchema: z.object({ amount: z.number() }),
        execute: async ({ amount }: { amount: number }) => {
          charges.n++;
          return { charged: amount };
        },
      }),
    };
    const guard = ({ toolName, args }: any) =>
      toolName === 'chargeCard' && args.amount > 1000 ? { action: 'require-approval' as const } : { action: 'allow' as const };
    function payMock(): any {
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
            { type: 'tool-call', toolCallId: 'call-c', toolName: 'chargeCard', input: JSON.stringify({ amount: 5000 }) },
            { type: 'finish', finishReason: 'tool-calls', usage },
          ]),
        }),
      };
    }
    const app = createAguiRoute({ journal: new InMemoryJournal(), agents: { pay: { model: payMock(), tools, guard, maxSteps: 6 } } });
    const res = await app.request('/agents/pay/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'o1', prompt: 'charge' }),
    });
    const events = await readAguiSSE(res);
    // P0.1: several gnl.* CUSTOM events may flow now (step boundaries etc.) — find the interrupt BY NAME.
    const custom = events.find((e) => e.type === EventType.CUSTOM && e.name === 'gnl.interrupt');
    expect(custom).toMatchObject({ name: 'gnl.interrupt' });
    expect(custom.value.interrupts.length).toBe(1);
    expect(charges.n).toBe(0);
    expect(events[events.length - 1].type).toBe(EventType.RUN_FINISHED);
  });

  it('400 when runId is missing', async () => {
    const app = createAguiRoute({ journal: new InMemoryJournal(), agents: { chat: { model: textMock() } } });
    const bad = await app.request('/agents/chat/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'x' }),
    });
    expect(bad.status).toBe(400);
  });
});
