// createChatRoute: useChat v5 wire format in, sentinel-masked UI message stream out. Mock-model pattern
// (mkStream + LanguageModelV2 mocks with reasoning/tool parts) is REUSED from packages/server/test/sse.test.ts
// so the two suites stay behaviorally comparable (same fullStream shapes, different output encodings).
import { describe, it, expect } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { InMemoryJournal, BasicMemory } from '@gnldev/durable';
import { createChatRoute } from '../src/index.js';

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

/** P0.1-parity mock: a reasoning model — thinking trace BEFORE the answer text. */
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
        { type: 'text-start', id: '1' },
        { type: 'text-delta', id: '1', delta: 'Answer' },
        { type: 'text-end', id: '1' },
        { type: 'finish', finishReason: 'stop', usage },
      ]),
    }),
  };
}

/** 0 tool results → chargeCard tool-call; then final text (same shape as sse.test.ts's agentMock). */
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

function userMessage(text: string) {
  return { id: 'u1', role: 'user', parts: [{ type: 'text', text }] };
}

/** Parses createUIMessageStreamResponse's SSE body (`data: {json}\n\n`, terminated by `data: [DONE]`) into chunks. */
async function readChunks(res: Response): Promise<any[]> {
  const text = await res.text();
  return text
    .split('\n\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^data:\s*/, ''))
    .filter((d) => d !== '[DONE]')
    .map((d) => JSON.parse(d));
}

describe('@gnldev/ai-sdk createChatRoute', () => {
  // REGRESSION (review finding): useChat's `body.id` is STABLE across the whole conversation — using it
  // alone as the runId made every later turn REPLAY turn 1 from the journal (the model never ran again).
  // The route now derives `${body.id}:${lastMessage.id}` — same chat id + NEW message id → fresh run.
  it('second turn on the SAME chat id gets a FRESH answer (per-turn runId derivation, not turn-1 replay)', async () => {
    let calls = 0;
    const countingMock: any = {
      specificationVersion: 'v2',
      provider: 'mock',
      modelId: 'm',
      supportedUrls: {},
      doGenerate: async () => { throw new Error('no gen'); },
      doStream: async () => {
        calls++;
        return {
          stream: mkStream([
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: '1' },
            { type: 'text-delta', id: '1', delta: `answer-${calls}` },
            { type: 'text-end', id: '1' },
            { type: 'finish', finishReason: 'stop', usage },
          ]),
        };
      },
    };
    const app = createChatRoute({ journal: new InMemoryJournal(), agents: { chat: { model: countingMock, maxSteps: 4 } } });
    const post = (msgId: string, text: string) =>
      app.request('/agents/chat/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'conv-1', messages: [{ id: msgId, role: 'user', parts: [{ type: 'text', text }] }] }),
      });
    const t1 = await readChunks(await post('m1', 'first'));
    const t2 = await readChunks(await post('m2', 'second')); // same chat id, NEW message id
    const retry = await readChunks(await post('m2', 'second')); // SAME message id → deduped replay, model NOT re-run
    const textOf = (cs: any[]) => cs.filter((c) => c.type === 'text-delta').map((c) => c.delta).join('');
    expect(textOf(t1)).toBe('answer-1');
    expect(textOf(t2)).toBe('answer-2'); // fresh run — the old body.id fallback would have replayed 'answer-1'
    expect(textOf(retry)).toBe('answer-2'); // idempotent retry: same runId → journal replay
    expect(calls).toBe(2); // the retry did NOT hit the model
  });

  // F1 (RISK-AUDIT-DURABILITY): useChat POSTs the ENTIRE client history every turn; with memory+threadId
  // that whole history used to become `incoming` → compounded duplication in memory AND in the prompt.
  // The core now strips client-echoed turns by role (durable run.ts dropEchoedHistory) — this is the
  // previously-missing two-turn coverage for the chat-route + memory combination.
  it('two turns with MEMORY: the full-history POST does not compound messages', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const seenPrompts: any[] = [];
    let calls = 0;
    const countingMock: any = {
      specificationVersion: 'v2',
      provider: 'mock',
      modelId: 'm',
      supportedUrls: {},
      doGenerate: async () => { throw new Error('no gen'); },
      doStream: async ({ prompt }: any) => {
        calls++;
        seenPrompts.push(prompt);
        return {
          stream: mkStream([
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: '1' },
            { type: 'text-delta', id: '1', delta: `answer-${calls}` },
            { type: 'text-end', id: '1' },
            { type: 'finish', finishReason: 'stop', usage },
          ]),
        };
      },
    };
    const app = createChatRoute({ journal, memory, agents: { chat: { model: countingMock, maxSteps: 4 } } });
    const post = (msgs: any[]) =>
      app.request('/agents/chat/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'conv-mem', threadId: 'th-mem', messages: msgs }),
      });

    // Turn 1: just the first user message.
    await readChunks(await post([{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'first' }] }]));
    // Turn 2: useChat's real behavior — the WHOLE history including the assistant echo.
    await readChunks(await post([
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'first' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'answer-1' }] },
      { id: 'm2', role: 'user', parts: [{ type: 'text', text: 'second' }] },
    ]));

    // Memory stays linear: first, answer-1, second, answer-2 — the echoed turns were NOT re-persisted.
    const saved = await memory.getMessages('th-mem');
    expect(saved.filter((m: any) => m?.role === 'user').length).toBe(2);
    expect(saved.length).toBe(4);
    // Turn 2's prompt carries 'first' exactly once (from server memory), not doubled by the echo.
    const t2users = (seenPrompts[1] ?? []).filter((m: any) => m?.role === 'user');
    expect(t2users.length).toBe(2);
  });

  it('POST /agents/:name/chat → UI message stream reconstructs the answer text', async () => {
    const app = createChatRoute({ journal: new InMemoryJournal(), agents: { chat: { model: textMock(), maxSteps: 4 } } });
    const res = await app.request('/agents/chat/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'c1', messages: [userMessage('hi')] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const chunks = await readChunks(res);
    const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.delta).join('');
    expect(text).toBe('Hello world');
  });

  it('reasoning chunks are present when the mock model streams reasoning', async () => {
    const app = createChatRoute({ journal: new InMemoryJournal(), agents: { think: { model: reasoningMock(), maxSteps: 4 } } });
    const res = await app.request('/agents/think/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'c2', messages: [userMessage('hi')] }),
    });
    const chunks = await readChunks(res);
    expect(chunks.some((c) => c.type === 'reasoning-start')).toBe(true);
    const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.delta).join('');
    expect(reasoning).toBe('Let me think… ok.');
    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => c.delta).join('')).toBe('Answer');
  });

  it('sentinel masking: __gnl_suspend never leaks; data-gnl-interrupt chunk + masked tool-output-available', async () => {
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
    const app = createChatRoute({ journal: new InMemoryJournal(), agents: { pay: { model: agentMock(), tools, guard, maxSteps: 6 } } });

    const res = await app.request('/agents/pay/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'o1', messages: [userMessage('charge')] }),
    });
    const bodyText = await res.text();
    // 1) No internal sentinel substring anywhere in the wire body.
    expect(bodyText).not.toContain('__gnl_suspend');
    expect(bodyText).not.toContain('__gnl_limit_exceeded');
    expect(bodyText).not.toContain('__gnl_blocked');

    const chunks = bodyText
      .split('\n\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((line) => line.replace(/^data:\s*/, ''))
      .filter((d) => d !== '[DONE]')
      .map((d) => JSON.parse(d));

    // 2) A data-gnl-interrupt chunk carries exactly one interrupt.
    const interruptChunk = chunks.find((c) => c.type === 'data-gnl-interrupt');
    expect(interruptChunk).toBeTruthy();
    expect(interruptChunk.data.interrupts).toHaveLength(1);
    expect(interruptChunk.data.interrupts[0]).toMatchObject({ toolCallId: 'call-c', toolName: 'chargeCard' });

    // 3) The tool-output-available chunk shows the masked pending-approval shape, not the raw sentinel.
    const toolOut = chunks.find((c) => c.type === 'tool-output-available');
    expect(toolOut).toBeTruthy();
    expect(toolOut.output).toMatchObject({ pending: 'approval', toolName: 'chargeCard' });

    // 4) No side effect ran while awaiting approval.
    expect(charges.n).toBe(0);
  });
});
