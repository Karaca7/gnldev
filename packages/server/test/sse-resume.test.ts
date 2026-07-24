// TASK W3 — Resumable SSE: resuming where it left off via the id: field + Last-Event-ID.
// Core insight: calling the stream again with the same runId is deterministic journal replay
// (the model/tool do NOT actually run again) → the event sequence + ids are IDENTICAL start to finish.
import { describe, it, expect } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { InMemoryJournal } from '@gnl/durable';
import { createRestApi } from '../src/index.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const mkStream = (arr: any[]) =>
  new ReadableStream({
    start(c) {
      for (const p of arr) c.enqueue(p);
      c.close();
    },
  });

/** 1 tool call (echo) + final text — same agentMock pattern as sse.test.ts. */
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

interface SSEFrame {
  event: string;
  data: any;
  id?: string;
}

async function readSSE(res: Response): Promise<SSEFrame[]> {
  const text = await res.text();
  return text
    .split('\n\n')
    .filter((f) => f.trim())
    .map((frame) => {
      let event = 'message';
      let data = '';
      let id: string | undefined;
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
        else if (line.startsWith('id:')) id = line.slice(3).trim();
      }
      return { event, data: data ? JSON.parse(data) : undefined, id };
    });
}

function makeApi(execs: { n: number }) {
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
  return createRestApi({ journal: new InMemoryJournal(), agents: { echoAgent: { model: agentMock(), tools, maxSteps: 6 } } });
}

describe('@gnl/server SSE — resumable (W3)', () => {
  it('when lastEventId is not given, behavior is the same as before; id starts at 0 and increments', async () => {
    const execs = { n: 0 };
    const api = makeApi(execs);
    const res = await api.request('/agents/echoAgent/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'rs1', prompt: 'go' }),
    });
    const events = await readSSE(res);
    expect(events.length).toBeGreaterThan(1);
    expect(events.map((e) => e.id)).toEqual(events.map((_, i) => String(i)));
    expect(events[events.length - 1].event).toBe('done');
    expect(events.some((e) => e.event === 'tool-call')).toBe(true);
    expect(execs.n).toBe(1);
  });

  it('a second call with the same runId → the SAME event sequence + SAME ids, the tool does NOT actually run again (exactly-once)', async () => {
    const execs = { n: 0 };
    const api = makeApi(execs);

    const res1 = await api.request('/agents/echoAgent/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'rs2', prompt: 'go' }),
    });
    const events1 = await readSSE(res1);
    expect(execs.n).toBe(1);

    const res2 = await api.request('/agents/echoAgent/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'rs2', prompt: 'go' }),
    });
    const events2 = await readSSE(res2);

    expect(events2).toEqual(events1);
    expect(execs.n).toBe(1); // still 1 after the second call — replay, the tool did not run again
  });

  it('Last-Event-ID header → only returns events with id>N, production is still a replay (the tool does not run again)', async () => {
    const execs = { n: 0 };
    const api = makeApi(execs);

    const res1 = await api.request('/agents/echoAgent/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'rs3', prompt: 'go' }),
    });
    const events1 = await readSSE(res1);
    expect(events1.length).toBeGreaterThan(2);
    const cutoff = Number(events1[0].id);

    const res2 = await api.request('/agents/echoAgent/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Last-Event-ID': String(cutoff) },
      body: JSON.stringify({ runId: 'rs3', prompt: 'go' }),
    });
    const events2 = await readSSE(res2);
    expect(events2).toEqual(events1.slice(1));
    expect(execs.n).toBe(1); // the resume call is also a replay — the tool did not run again
  });

  it('body.lastEventId is also accepted (an alternative to the Last-Event-ID header)', async () => {
    const execs = { n: 0 };
    const api = makeApi(execs);

    const res1 = await api.request('/agents/echoAgent/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'rs4', prompt: 'go' }),
    });
    const events1 = await readSSE(res1);
    const lastSeen = Number(events1[events1.length - 2].id); // saw everything except the last event

    const res2 = await api.request('/agents/echoAgent/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'rs4', prompt: 'go', lastEventId: lastSeen }),
    });
    const events2 = await readSSE(res2);
    expect(events2).toEqual(events1.slice(-1));
    expect(events2[0].event).toBe('done');
  });
});
