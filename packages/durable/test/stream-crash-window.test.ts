// The streaming path has a much wider crash window than the generate path, for a structural reason.
//
// wrapGenerate journals the model step the moment doGenerate() returns — BEFORE any tool in it runs.
// wrapStream journals it in flush(), i.e. after the stream is fully consumed — and the AI SDK
// executes tool calls as they arrive, which is BEFORE flush.
//
// So a crash between "the tool ran" and "the stream ended" leaves the tool record present and
// `model:N` absent. Resume re-calls the model, it re-plans, and a real provider mints a fresh
// toolCallId every completion — so the journal's per-toolCallId gate never matches and the side
// effect runs a second time.
//
// The partial checkpoint written every 10 chunks does not help: nothing reads it. It is written,
// overwritten, and never consulted by any code path.
import { describe, it, expect } from 'vitest';
import { streamDurable, InMemoryStorage, runKeys } from '../src/index.js';
import { tool } from 'ai';
import { z } from 'zod';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

function parts(list: any[]) {
  return new ReadableStream({
    start(c) { for (const p of list) c.enqueue(p); c.close(); },
  });
}

/** A model whose tool-call id changes per completion, as every real provider's does.
 *  `hang: true` emits the tool call and then never closes — the shape of a process killed
 *  mid-stream, where flush() never runs and model:N is therefore never written. */
function streamingModel(callId: string, hang = false) {
  return {
    specificationVersion: 'v2', provider: 'scripted', modelId: 'streamer', supportedUrls: {},
    doGenerate: async () => { throw new Error('stream-only'); },
    doStream: async ({ prompt }: any) => {
      const done = (prompt ?? []).filter((m: any) => m.role === 'tool').length;
      if (done === 0) {
        const head = [
          { type: 'stream-start', warnings: [] },
          { type: 'tool-call', toolCallId: callId, toolName: 'chargeCard', input: JSON.stringify({ amount: 2000 }) },
        ];
        if (hang) {
          return {
            stream: new ReadableStream({
              start(c) { for (const p of head) c.enqueue(p); /* never close */ },
            }),
          };
        }
        return { stream: parts([...head, { type: 'finish', finishReason: 'tool-calls', usage }]) };
      }
      return {
        stream: parts([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: 'done' }, { type: 'text-end', id: '1' },
          { type: 'finish', finishReason: 'stop', usage },
        ]),
      };
    },
  } as any;
}

function chargeTool() {
  let charges = 0;
  const t = tool({
    description: 'charge',
    inputSchema: z.object({ amount: z.number() }),
    execute: async () => { charges++; return { chargeId: `ch_${charges}` }; },
  });
  Object.assign(t, { sideEffect: true });
  return { chargeCard: t as any, charges: () => charges };
}

async function drain(res: any) {
  try { for await (const _ of res.fullStream) { /* consume */ } } catch { /* the crash */ }
}

describe('a crash after the tool ran but before the stream ended', () => {
  it('journals the model step early enough that a resume does not re-run the tool', async () => {
    const journal = new InMemoryStorage().runs;
    const { chargeCard, charges } = chargeTool();
    const runId = 'sw-1';

    // Run 1: consume only as far as the tool result, then abandon the stream — the process dies
    // before flush() would have written model:0.
    const first = await streamDurable({
      runId, journal, model: streamingModel('call-A', true), tools: { chargeCard }, prompt: 'charge',
    });
    const reader = (first as any).fullStream.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value?.type === 'tool-result') break; // the tool has run — this is the moment of the kill
    }
    await reader.cancel().catch(() => {});
    expect(charges(), 'the tool ran during the abandoned stream').toBe(1);

    // The step must be recoverable. Without it, the resume below re-plans and charges again.
    const step0 = await journal.get(runKeys.model(runId, 0));
    expect(step0, 'model:0 must be journaled once its tool calls have executed').toBeDefined();

    // Run 2: same runId, and the provider hands back a DIFFERENT toolCallId this time.
    const second = await streamDurable({
      runId, journal, model: streamingModel('call-B'), tools: { chargeCard }, prompt: 'charge',
    });
    await drain(second);

    expect(charges(), 'the resume must replay the recorded step, not re-plan it').toBe(1);
  });
});
