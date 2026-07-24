// End-to-end proof of GNL's edge: LLM-aware idempotency (`idempotency: 'args'`).
//
// This reproduces a documented AI SDK pattern — a model emitting the SAME tool call multiple times in one
// turn, each with a DIFFERENT toolCallId — and asserts the side effect fires exactly once.
// The default toolCallId-keyed exactly-once (every durable engine's) would NOT catch this;
// `idempotency: 'args'` does. Run with: pnpm test
import { describe, it, expect } from 'vitest';
import { stepCountIs } from 'ai';
import { runDurable, InMemoryJournal } from '@gnl/durable';
import { chargeOrder, ledger } from '../src/tools.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

// A model that, in ONE turn, calls chargeOrder 3× with identical args but 3 different toolCallIds.
function duplicateCallingModel(): any {
  let turn = 0;
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'dup', supportedUrls: {},
    doGenerate: async () => {
      turn++;
      if (turn === 1) {
        return {
          content: [1, 2, 3].map((i) => ({
            type: 'tool-call', toolCallId: `call-${i}`, toolName: 'chargeOrder',
            input: JSON.stringify({ orderId: 'order-1', amount: 42 }),
          })),
          finishReason: 'tool-calls', usage, warnings: [],
        };
      }
      return { content: [{ type: 'text', text: 'done' }], finishReason: 'stop', usage, warnings: [] };
    },
  };
}

describe('LLM-aware idempotency (idempotency: "args")', () => {
  it('the same order is charged exactly once even across 3 duplicate tool-calls in one turn', async () => {
    ledger.charges.length = 0;
    await runDurable({
      runId: 'e2e-order-1',
      journal: new InMemoryJournal(),
      model: duplicateCallingModel(),
      tools: { chargeOrder },
      prompt: 'charge order-1',
      stopWhen: stepCountIs(4),
    });
    // Without idempotency: 'args' this would be 3. With it: exactly 1.
    expect(ledger.charges).toHaveLength(1);
    expect(ledger.charges[0]).toEqual({ orderId: 'order-1', amount: 42 });
  });

  it('crash-resume replays instead of re-charging (same runId → tool never runs twice)', async () => {
    ledger.charges.length = 0;
    const journal = new InMemoryJournal();
    const opts = {
      runId: 'e2e-order-2', journal, model: duplicateCallingModel(),
      tools: { chargeOrder }, prompt: 'charge order-1', stopWhen: stepCountIs(4),
    };
    await runDurable(opts);
    await runDurable(opts); // simulate a crash + retry with the SAME runId
    expect(ledger.charges).toHaveLength(1);
  });
});
