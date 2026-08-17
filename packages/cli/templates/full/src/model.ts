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
          finishReason: 'tool-calls',
          usage,
          warnings: [],
        };
      }
      return { content: [{ type: 'text', text: 'Order charged once. Try running the same runId again — it will not charge twice.' }], finishReason: 'stop', usage, warnings: [] };
    },
    doStream: async () => ({
      stream: new ReadableStream({
        start(c) {
          c.enqueue({ type: 'stream-start', warnings: [] });
          c.enqueue({ type: 'text-start', id: '1' });
          for (const ch of 'Order charged once.') c.enqueue({ type: 'text-delta', id: '1', delta: ch });
          c.enqueue({ type: 'text-end', id: '1' });
          c.enqueue({ type: 'finish', finishReason: 'stop', usage });
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
