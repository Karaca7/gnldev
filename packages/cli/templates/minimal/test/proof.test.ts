// The proof this project ships with: GNL's edge, reproduced end-to-end with no API key.
//
// A model emitting the SAME tool call several times in one turn — each under a DIFFERENT
// toolCallId — is a documented AI SDK pattern and the dominant real-world double-side-effect case.
// toolCallId-keyed exactly-once (every durable engine's default, ours included) cannot see it;
// `idempotency: 'args'` on the tool (src/tools/charge-order.ts) is what absorbs it.
// Run with: pnpm test
import { describe, it, expect } from 'vitest';
import { stepCountIs } from 'ai';
import { runDurable, InMemoryJournal } from '@gnldev/durable';
import { toolCallingModel } from '@gnldev/durable/mock';
import { chargeOrder, ledger } from '../src/tools/charge-order.js';

// 3 duplicate calls for the same order, one turn, three distinct toolCallIds.
const duplicates = () => toolCallingModel({ calls: 3 });

describe("the same work is never silently done twice", () => {
  it('one order, 3 duplicate tool-calls in one turn → charged exactly once', async () => {
    ledger.charges.length = 0;
    await runDurable({
      runId: 'proof-order-1',
      journal: new InMemoryJournal(),
      model: duplicates(),
      tools: { chargeOrder },
      prompt: 'charge order-1',
      stopWhen: stepCountIs(4),
    });
    // Without idempotency: 'args' this would be 3. With it: exactly 1.
    expect(ledger.charges).toHaveLength(1);
    expect(ledger.charges[0]).toEqual({ orderId: 'order-1', amount: 42 });
  });

  it('crash-resume replays instead of re-charging (same runId → the tool never runs twice)', async () => {
    ledger.charges.length = 0;
    const journal = new InMemoryJournal();
    const opts = {
      runId: 'proof-order-2', journal, model: duplicates(),
      tools: { chargeOrder }, prompt: 'charge order-1', stopWhen: stepCountIs(4),
    };
    await runDurable(opts);
    await runDurable(opts); // simulate a crash + retry with the SAME runId
    expect(ledger.charges).toHaveLength(1);
  });
});
