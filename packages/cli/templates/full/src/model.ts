// Demo agent (mock model — no API key). On the first turn it calls the `chargeOrder` tool,
// then it summarizes the receipt. Swap `model` for a real provider
// (e.g. 'anthropic/claude-opus-4-8') and delete the mock to go live.
import type { AgentConfig } from '@gnldev/durable';
import { chargeOrder } from './tools.js';

function toolResultsSeen(prompt: any[]): number {
  let n = 0;
  for (const m of prompt ?? []) {
    if (m.role === 'tool') n++;
    if (Array.isArray(m.content)) for (const p of m.content) if (p?.type === 'tool-result') n++;
  }
  return n;
}

// SPEC v4, matching the `ai@^7` this project depends on. Declaring 'v2' put the SDK into
// compatibility mode and printed a warning on the FIRST run of every scaffolded project — before the
// user had written a line. The usage shape moved with it: v7 nests the counts, and a flat
// `{inputTokens: 1}` reads as undefined through the SDK's accessors, so any cost or token ceiling
// would have counted this model as free.
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

// The finish reason moved with the usage shape, and only the usage half was fixed.
//
// A v4 provider reports `{unified, raw}`; AI SDK 7 reads `finishReason.unified`. A bare string leaves
// it undefined — and until ai@7.0.69 the loop tolerated that and ran the tool anyway. From 7.0.70 it
// does not. Measured against the plain SDK, with no gnl code involved:
//
//   ai=7.0.69  bare string -> fired=1 text="done"  |  {unified,raw} -> fired=1 text="done"
//   ai=7.0.73  bare string -> fired=0 text=""      |  {unified,raw} -> fired=1 text="done"
//
// The peer range is `^7.0.0`, so a project scaffolded today installs 7.0.7x and ships an agent that
// never calls a tool: `POST /agents/assistant/run` answers `{"text":""}` and `gnl run` shows a
// COMPLETED run with its tool call still pending. The template that exists to demonstrate
// exactly-once side effects demonstrated none, and its own `pnpm test` failed 2/2 out of the box.
//
// Fixed here rather than by pinning `ai` below 7.0.70: the bare string was always the wrong shape —
// this repo's own fixture (packages/durable/test/mock.ts) has converted it for months. Pinning would
// freeze every new user on an old SDK to preserve our bug.
const finish = (reason: 'stop' | 'tool-calls') => ({ unified: reason, raw: reason });

// Turn 1: call chargeOrder(orderId: 'order-1', amount: 42). Turn 2 (once a tool result exists):
// reply with text. This gives you a real tool call to inspect in Studio (`gnl studio`).
function toolCallingMock(): any {
  return {
    specificationVersion: 'v4',
    provider: 'mock',
    modelId: 'demo',
    supportedUrls: {},
    doGenerate: async ({ prompt }: any) => {
      if (toolResultsSeen(prompt) === 0) {
        return {
          content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'chargeOrder', input: JSON.stringify({ orderId: 'order-1', amount: 42 }) }],
          finishReason: finish('tool-calls'),
          usage,
          warnings: [],
        };
      }
      return { content: [{ type: 'text', text: 'Order charged once. Try running the same runId again — it will not charge twice.' }], finishReason: finish('stop'), usage, warnings: [] };
    },
    doStream: async () => ({
      stream: new ReadableStream({
        start(c) {
          c.enqueue({ type: 'stream-start', warnings: [] });
          c.enqueue({ type: 'text-start', id: '1' });
          for (const ch of 'Order charged once.') c.enqueue({ type: 'text-delta', id: '1', delta: ch });
          c.enqueue({ type: 'text-end', id: '1' });
          c.enqueue({ type: 'finish', finishReason: finish('stop'), usage });
          c.close();
        },
      }),
    }),
  };
}

export const assistant: AgentConfig = {
  model: toolCallingMock(),
  system: 'You charge orders exactly once. (Demo: mock model — no API key required.)',
  tools: { chargeOrder },
  maxSteps: 4,
};
