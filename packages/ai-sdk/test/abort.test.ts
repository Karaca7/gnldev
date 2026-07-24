// P0.2 (AUDIT-R2): the request AbortSignal must reach generation — a client disconnect stops
// token generation instead of silently billing to completion. Registry-level: RunOptions.abortSignal ->
// runDurable/streamDurable's `...rest` spread -> generateText/streamText's own `abortSignal` option ->
// (via wrapLanguageModel's default passthrough) the mock LanguageModelV2's doStream `options.abortSignal`
// (field name verified against @ai-sdk/provider's LanguageModelV2CallOptions). Route-level: createChatRoute
// wires `c.req.raw.signal` — a server-level smoke exercising the SAME capture through the HTTP route.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, createGnl } from '@gnl/durable';
import { createChatRoute } from '../src/index.js';

/** A model whose stream never finishes (no 'finish' chunk, stream left open) — lets the test abort
 *  mid-generation and observe the captured abortSignal, instead of racing a stream that already closed. */
function controllableMock(captured: { signal?: AbortSignal }): any {
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'm',
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error('no gen');
    },
    doStream: async (options: any) => {
      captured.signal = options?.abortSignal;
      const stream = new ReadableStream({
        start(c) {
          c.enqueue({ type: 'stream-start', warnings: [] });
          c.enqueue({ type: 'text-start', id: '1' });
          c.enqueue({ type: 'text-delta', id: '1', delta: 'chunk1 ' });
          // deliberately no 'finish'/close — simulates a long-running generation.
        },
      });
      return { stream };
    },
  };
}

function userMessage(text: string) {
  return { id: 'u1', role: 'user', parts: [{ type: 'text', text }] };
}

/** Reads from a stream reader until `predicate(value)` is true (or the stream ends) — needed because
 *  streamText's fullStream/UI-chunk stream emits a synthetic 'start'/'start-step' chunk BEFORE the
 *  underlying model's doStream is actually invoked (verified empirically), so reading exactly one chunk
 *  races the model call. */
async function readUntil(reader: ReadableStreamDefaultReader<any>, predicate: (v: any) => boolean, maxReads = 10): Promise<void> {
  for (let i = 0; i < maxReads; i++) {
    const { done, value } = await reader.read();
    if (done || predicate(value)) return;
  }
}

describe('@gnl/ai-sdk abort forwarding', () => {
  it('registry: gnl.stream forwards RunOptions.abortSignal into the model call', async () => {
    const captured: { signal?: AbortSignal } = {};
    const gnl = createGnl({ journal: new InMemoryJournal(), agents: { chat: { model: controllableMock(captured), maxSteps: 4 } } });
    const controller = new AbortController();

    const result: any = await gnl.stream('chat', { runId: 'a1', prompt: 'hi', abortSignal: controller.signal });
    const reader = result.fullStream.getReader();
    await readUntil(reader, (v) => v?.type === 'text-delta');

    expect(captured.signal).toBeInstanceOf(AbortSignal);
    expect(captured.signal?.aborted).toBe(false);
    controller.abort();
    expect(captured.signal?.aborted).toBe(true);
  });

  it('server-level smoke: createChatRoute forwards the HTTP request signal (c.req.raw.signal) into the model call', async () => {
    const captured: { signal?: AbortSignal } = {};
    const app = createChatRoute({ journal: new InMemoryJournal(), agents: { chat: { model: controllableMock(captured), maxSteps: 4 } } });
    const controller = new AbortController();

    const res = await app.request('/agents/chat/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 's1', messages: [userMessage('hi')] }),
      signal: controller.signal,
    });
    // Drain bytes (decoding) until we've seen a 'text-delta' SSE data chunk, so we know doStream has
    // actually run and captured the signal (the response body starts with synthetic 'start'/'start-step'
    // UI chunks emitted BEFORE the model is called — see readUntil's doc comment above).
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (let i = 0; i < 20 && !buf.includes('"type":"text-delta"'); i++) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
    }

    expect(captured.signal).toBeInstanceOf(AbortSignal);
    controller.abort();
    expect(captured.signal?.aborted).toBe(true);
  });
});
