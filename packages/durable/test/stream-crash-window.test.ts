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
// AI SDK 7 NARROWED THIS. Measured against ai@7.0.66: a stream that never delivers its `finish`
// part does not execute tools at all — so the "killed mid-stream, tool already charged" shape this
// file was written for can no longer occur that way. What remains reachable is the abandoned
// reader: the step finishes (tools run), and the consumer goes away before draining. The test now
// drives THAT, because a scenario the runtime cannot reach proves nothing. Both facts are asserted
// below, so a future SDK that reverts either one fails here.
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

    // Run 1: the step completes (so the tool runs), then the consumer abandons the stream — a
    // client that disconnected, a worker killed after the charge landed.
    const first = await streamDurable({
      runId, journal, model: streamingModel('call-A'), tools: { chargeCard }, prompt: 'charge',
    });
    const reader = (first as any).fullStream.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value?.type === 'tool-result') break; // the tool has run — this is the moment of the kill
    }
    await reader.cancel().catch(() => {});
    expect(charges(), 'the tool ran during the abandoned stream').toBe(1);
    // Poll for the abandoned pipeline's write instead of sleeping a fixed 50ms: the wait is for the
    // journal entry to appear, not for a span of time. (Not a reproduced flake — see the measurement
    // note in running-status.test.ts; this removes the assumption, it does not close a known failure.)
    const settleBy = Date.now() + 5_000;
    let step0 = await journal.get(runKeys.model(runId, 0));
    while (step0 === undefined && Date.now() < settleBy) {
      await new Promise((r) => setTimeout(r, 10));
      step0 = await journal.get(runKeys.model(runId, 0));
    }
    expect(step0, 'model:0 must be journaled once its tool calls have executed').toBeDefined();

    // Run 2: same runId, and the provider hands back a DIFFERENT toolCallId this time.
    const second = await streamDurable({
      runId, journal, model: streamingModel('call-B'), tools: { chargeCard }, prompt: 'charge',
    });
    await drain(second);

    expect(charges(), 'the resume must replay the recorded step, not re-plan it').toBe(1);
  });

  it('a stream that never finishes does not execute its tools at all', async () => {
    // The narrowing, pinned. Under AI SDK 5 the tool ran the moment its call arrived, which is what
    // made the window above dangerous. If a future version goes back to that, this fails and the
    // wider hazard is back on the table — worth knowing on the day it happens, not later.
    const journal = new InMemoryStorage().runs;
    const { chargeCard, charges } = chargeTool();
    const res: any = await streamDurable({
      runId: 'sw-hang', journal, model: streamingModel('call-H', true), tools: { chargeCard }, prompt: 'charge',
    });
    const reader = res.fullStream.getReader();
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const r: any = await Promise.race([
        reader.read(),
        new Promise((done) => setTimeout(() => done({ done: true }), 400)),
      ]);
      if (r.done) break;
      if (r.value?.type === 'tool-result') break;
    }
    await reader.cancel().catch(() => {});
    expect(charges(), 'no finish part → no tool execution → nothing to double-charge').toBe(0);
  }, 15000);
});
