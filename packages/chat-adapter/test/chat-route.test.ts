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

describe('@gnldev/chat-adapter createChatRoute', () => {
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

  // F1 — durability review: useChat POSTs the ENTIRE client history every turn; with memory+threadId
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

// Faz 0.2/0.3 (dedup-hardening) — the effective runId is a response CONTRACT (X-Gnl-Run-Id on every
// response), and engine conflicts are TYPED instead of collapsing to a flat 400.
describe('createChatRoute typed errors + runId echo', () => {
  it('echoes the derived runId as X-Gnl-Run-Id on a success response', async () => {
    const app = createChatRoute({ journal: new InMemoryJournal(), agents: { chat: { model: textMock(), maxSteps: 4 } } });
    const res = await app.request('/agents/chat/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'conv-h', messages: [{ id: 'msg-h', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Gnl-Run-Id')).toBe('conv-h:msg-h'); // `${body.id}:${lastMessage.id}` derivation
  });

  it('reusing a runId under a DIFFERENT thread → typed 409 run_thread_mismatch (was a flat 400)', async () => {
    const journal = new InMemoryJournal();
    const app = createChatRoute({ journal, agents: { chat: { model: textMock(), maxSteps: 4 } } });
    const post = (convId: string) =>
      app.request('/agents/chat/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: convId, runId: 'shared-run', messages: [userMessage('hi')] }),
      });
    const first = await post('conv-A');
    expect(first.status).toBe(200);
    await readChunks(first); // drain: the run completes and freezes its input under threadId conv-A

    const second = await post('conv-B'); // same runId, different thread → the caller's mistake, typed
    expect(second.status).toBe(409);
    const body = await second.json();
    expect(body.code).toBe('run_thread_mismatch');
    expect(body.detail).toMatchObject({ runId: 'shared-run' });
    expect(body.resumable).toBeUndefined(); // never succeeds for this thread — do not advertise retry
    expect(second.headers.get('X-Gnl-Run-Id')).toBe('shared-run'); // echoed on error responses too
  });
});

// Faz 0 kontrol bulgusu (Rüzgar) — conversion throw'u client girdisiyle tetiklenebilir; header
// sözleşmesi tam da malformed-istek yolunda delinmemeli.
describe('createChatRoute malformed messages', () => {
  it('malformed `messages` → typed-route 400 with X-Gnl-Run-Id, not a bare 500', async () => {
    const app = createChatRoute({ journal: new InMemoryJournal(), agents: { chat: { model: textMock(), maxSteps: 4 } } });
    const res = await app.request('/agents/chat/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'bad-msg-run', messages: {} }), // not an array → conversion throws
    });
    expect(res.status).toBe(400); // used to escape the try → Hono's bare 500
    expect(res.headers.get('X-Gnl-Run-Id')).toBe('bad-msg-run'); // the contract holds on THIS path too
  });
});

// FAZ-2 (dedup-hardening) — default per-run lock, Idempotency-Key alias, runId'li interrupt +
// approve() round-trip, replay parity ve convertToModelMessages determinizm testleri.
import { approvalPayload, approve } from '../src/index.js';
import { convertToModelMessages } from 'ai';

/** agentMock ailesi: yanıtı geciktiren yavaş model — eşzamanlılık penceresi açmak için. */
function slowMock(delayMs: number): any {
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'm',
    supportedUrls: {},
    doGenerate: async () => { throw new Error('no gen'); },
    doStream: async () => {
      await new Promise((r) => setTimeout(r, delayMs));
      return {
        stream: mkStream([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: '1' },
          { type: 'text-delta', id: '1', delta: 'slow' },
          { type: 'text-end', id: '1' },
          { type: 'finish', finishReason: 'stop', usage },
        ]),
      };
    },
  };
}

describe('FAZ-2: default lock + approval round-trip', () => {
  it('two CONCURRENT requests with the same runId: one streams, the loser gets 409 run_busy + Retry-After', async () => {
    const app = createChatRoute({ journal: new InMemoryJournal(), agents: { chat: { model: slowMock(40), maxSteps: 4 } } });
    const post = () =>
      app.request('/agents/chat/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'lk1', messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'go' }] }] }),
      });
    const [a, b] = await Promise.all([post(), post()]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    const body = await loser.json();
    expect(body.code).toBe('run_busy');
    expect(body.resumable).toBe(true);
    expect(loser.headers.get('Retry-After')).toBe('5');
    expect(loser.headers.get('X-Gnl-Run-Id')).toBe('lk1:m1');
    const winner = a.status === 200 ? a : b;
    await winner.text(); // drain → lock released
  });

  it('lock:false restores the old concurrent behavior (no 409)', async () => {
    const app = createChatRoute(
      { journal: new InMemoryJournal(), agents: { chat: { model: slowMock(30), maxSteps: 4 } } },
      { lock: false },
    );
    const post = () =>
      app.request('/agents/chat/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'lk2', messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'go' }] }] }),
      });
    const [a, b] = await Promise.all([post(), post()]);
    expect([a.status, b.status]).toEqual([200, 200]);
    await Promise.all([a.text(), b.text()]);
  });

  it('Idempotency-Key header is an alias AFTER body.runId', async () => {
    const app = createChatRoute({ journal: new InMemoryJournal(), agents: { chat: { model: textMock(), maxSteps: 4 } } });
    const post = (body: any, headers: Record<string, string> = {}) =>
      app.request('/agents/chat/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    // Header used when body has no runId and no derivable id pair:
    const viaHeader = await post({ messages: [userMessage('hi')] }, { 'Idempotency-Key': 'idem-42' });
    expect(viaHeader.headers.get('X-Gnl-Run-Id')).toBe('idem-42');
    await viaHeader.text();
    // body.runId STILL wins over the header (an intermediary must not silently change behavior):
    const viaBody = await post({ runId: 'explicit-1', messages: [userMessage('hi')] }, { 'Idempotency-Key': 'idem-43' });
    expect(viaBody.headers.get('X-Gnl-Run-Id')).toBe('explicit-1');
    await viaBody.text();
  });

  it('interrupt chunks carry the runId, and approve() lands the approval on the SUSPENDED run', async () => {
    const charges = { n: 0 };
    const tools = {
      chargeCard: tool({
        description: 'charge',
        inputSchema: z.object({ amount: z.number() }),
        execute: async ({ amount }) => { charges.n++; return { charged: amount }; },
      }),
    };
    const guard = ({ toolName, args }: any) =>
      toolName === 'chargeCard' && args.amount > 1000 ? { action: 'require-approval' as const } : { action: 'allow' as const };
    const app = createChatRoute({ journal: new InMemoryJournal(), agents: { pay: { model: agentMock(), tools, guard, maxSteps: 6 } } });

    const messages = [userMessage('charge')];
    const first = await app.request('/agents/pay/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'o2', messages }),
    });
    const chunks = await readChunks(first);
    const interrupt = chunks.find((c) => c.type === 'data-gnl-interrupt')!.data.interrupts[0];
    expect(interrupt.runId).toBe('o2:u1'); // the approval ADDRESS travels with the interrupt
    expect(charges.n).toBe(0);

    // The approval round-trip: SAME conversation id + messages, the interrupt's runId + toolCallId.
    const second = await approve('/agents/pay/chat', {
      interrupt,
      chatId: 'o2',
      messages,
      fetchImpl: ((url: any, init: any) => app.request(url, init)) as typeof fetch,
    });
    expect(second.status).toBe(200);
    expect(second.headers.get('X-Gnl-Run-Id')).toBe('o2:u1'); // landed on the SUSPENDED run, not a fresh one
    const secondText = await second.text();
    expect(secondText).toContain('charged'); // the tool actually fired this time
    expect(charges.n).toBe(1); // exactly once
  });

  it('approvalPayload refuses an interrupt without runId (no silent fresh-run approvals)', () => {
    expect(() => approvalPayload({ toolCallId: 'call-x' })).toThrow(/runId/);
    expect(approvalPayload({ toolCallId: 'call-x', runId: 'r1' }, false)).toEqual({
      runId: 'r1',
      approvals: { 'call-x': false },
    });
  });
});

describe('FAZ-2: replay parity + conversion determinism (heyet test görevleri)', () => {
  it('a second stream with the SAME runId replays the SAME chunk sequence (modulo the volatile messageId)', async () => {
    const app = createChatRoute({ journal: new InMemoryJournal(), agents: { chat: { model: textMock(), maxSteps: 4 } } });
    const post = () =>
      app.request('/agents/chat/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'rp1', messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }),
      });
    const normalize = (cs: any[]) => cs.map((c) => ('messageId' in c ? { ...c, messageId: '<volatile>' } : c));
    const run1 = normalize(await readChunks(await post()));
    const run2 = normalize(await readChunks(await post()));
    expect(run2).toEqual(run1); // journal replay — not a re-execution with a lookalike answer
  });

  it('convertToModelMessages is deterministic across turns for the same UIMessage history', async () => {
    const history = [
      { id: 'u1', role: 'user' as const, parts: [{ type: 'text' as const, text: 'first' }] },
      { id: 'a1', role: 'assistant' as const, parts: [{ type: 'text' as const, text: 'answer-1' }] },
      { id: 'u2', role: 'user' as const, parts: [{ type: 'text' as const, text: 'second' }] },
    ];
    const once = await convertToModelMessages(structuredClone(history) as any);
    const twice = await convertToModelMessages(structuredClone(history) as any);
    // Byte stability is the precondition for any future content-fingerprint feature (heyet İhtilaf B):
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });
});

// FAZ-2 denetçi bulguları (K8×2 + K14) — kilit yaşam döngüsünün abort ve kurulum-throw çıkışları
// pinlendi; default lock'un yeteneksiz (CAS'sız) journal'la route seviyesinde çalıştığı kanıtlandı.
describe('FAZ-2 denetçi düzeltmeleri: lock release yolları', () => {
  it('abort releases the lock — the immediate same-runId retry gets 200, not 5 minutes of 409', async () => {
    let calls = 0;
    const abortableMock: any = {
      specificationVersion: 'v2',
      provider: 'mock',
      modelId: 'm',
      supportedUrls: {},
      doGenerate: async () => { throw new Error('no gen'); },
      doStream: async () => {
        calls++;
        if (calls === 1) {
          // First call: a stream that never finishes — the client will abort it mid-flight.
          return {
            stream: new ReadableStream({
              start(c) {
                c.enqueue({ type: 'stream-start', warnings: [] });
                c.enqueue({ type: 'text-start', id: '1' });
                c.enqueue({ type: 'text-delta', id: '1', delta: 'hanging ' });
              },
            }),
          };
        }
        return {
          stream: mkStream([
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: '1' },
            { type: 'text-delta', id: '1', delta: 'retried ok' },
            { type: 'text-end', id: '1' },
            { type: 'finish', finishReason: 'stop', usage },
          ]),
        };
      },
    };
    const app = createChatRoute({ journal: new InMemoryJournal(), agents: { chat: { model: abortableMock, maxSteps: 4 } } });
    const body = JSON.stringify({ id: 'ab1', messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'go' }] }] });

    const controller = new AbortController();
    const first = await app.request('/agents/chat/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: controller.signal,
    });
    expect(first.status).toBe(200);
    const reader = (first.body as ReadableStream).getReader();
    await reader.read(); // the stream is live
    controller.abort(); // user hit stop / closed the tab
    await new Promise((r) => setTimeout(r, 100)); // let onAbort's release land

    const retry = await app.request('/agents/chat/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    // Without the onAbort release, this is 409 run_busy for the remaining ~5 minutes of TTL.
    expect(retry.status).toBe(200);
    await retry.text();
  });

  it('a setup-throw after acquire (thread mismatch) releases the lock — the CORRECT retry is not blocked', async () => {
    const journal = new InMemoryJournal();
    const app = createChatRoute({ journal, agents: { chat: { model: textMock(), maxSteps: 4 } } });
    const post = (convId: string) =>
      app.request('/agents/chat/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: convId, runId: 'shared-lk', messages: [userMessage('hi')] }),
      });
    await (await post('conv-A')).text(); // freezes the input under thread conv-A, completes, releases

    const wrong = await post('conv-B'); // acquire succeeds, then assertThreadOwnership throws
    expect(wrong.status).toBe(409);
    expect((await wrong.json()).code).toBe('run_thread_mismatch');

    const right = await post('conv-A'); // the legitimate replay of the run's own thread
    // Without the release-on-setup-throw guard, conv-B's leaked lock turns this into 409 run_busy.
    expect(right.status).toBe(200);
    await right.text();
  });

  it('default lock works on a capability-less (get/put only) journal — fallback path at route level', async () => {
    const m = new Map<string, unknown>();
    const plainJournal: any = {
      async get(k: string) { return m.has(k) ? structuredClone(m.get(k)) : undefined; },
      async put(k: string, v: unknown) { m.set(k, structuredClone(v)); },
    };
    const app = createChatRoute({ journal: plainJournal, agents: { chat: { model: textMock(), maxSteps: 4 } } });
    const post = () =>
      app.request('/agents/chat/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'pl1', messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }),
      });
    const first = await post();
    expect(first.status).toBe(200); // default-on lock must not crash adapters without putIfAbsent/putIfMatch
    await first.text();
    const replay = await post();
    expect(replay.status).toBe(200);
    await replay.text();
  });
});
