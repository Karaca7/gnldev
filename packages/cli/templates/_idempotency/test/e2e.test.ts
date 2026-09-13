// End-to-end proof of GNL's edge: LLM-aware idempotency (`idempotency: 'args'`).
//
// This reproduces a documented AI SDK pattern — a model emitting the SAME tool call multiple times in one
// turn, each with a DIFFERENT toolCallId — and asserts the side effect fires exactly once.
// The default toolCallId-keyed exactly-once (every durable engine's) would NOT catch this;
// `idempotency: 'args'` does. Run with: pnpm test
import { describe, it, expect } from 'vitest';
import { stepCountIs } from 'ai';
import { runDurable, InMemoryJournal } from '@gnldev/durable';
import { chargeOrder, ledger } from '../src/tools.js';

// v7 nests the token counts; a flat shape reads as undefined through the SDK's accessors.
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

// And the same is true of the finish reason: v7 reads `finishReason.unified`. With a bare string it
// is undefined, and from ai@7.0.70 the loop stops before executing a tool — so these two tests, the
// ones that exist to prove the charge happens exactly once, failed by never charging at all.
const finish = (reason: 'stop' | 'tool-calls') => ({ unified: reason, raw: reason });

// A model that, in ONE turn, calls chargeOrder 3× with identical args but 3 different toolCallIds.
function duplicateCallingModel(): any {
  let turn = 0;
  return {
    specificationVersion: 'v4', provider: 'mock', modelId: 'dup', supportedUrls: {},
    doGenerate: async () => {
      turn++;
      if (turn === 1) {
        return {
          content: [1, 2, 3].map((i) => ({
            type: 'tool-call', toolCallId: `call-${i}`, toolName: 'chargeOrder',
            input: JSON.stringify({ orderId: 'order-1', amount: 42 }),
          })),
          finishReason: finish('tool-calls'), usage, warnings: [],
        };
      }
      return { content: [{ type: 'text', text: 'done' }], finishReason: finish('stop'), usage, warnings: [] };
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
