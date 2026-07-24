// End-to-end proof of GNL's durability: a run resumed with the SAME runId REPLAYS from the
// journal instead of re-invoking the model (exactly-once model step). Run with: pnpm test
import { describe, it, expect } from 'vitest';
import { runDurable, InMemoryJournal } from '@gnl/durable';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

// An echo model that counts how many times it is actually invoked.
function countingModel(counter: { calls: number }): any {
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'echo', supportedUrls: {},
    doGenerate: async () => {
      counter.calls++;
      return { content: [{ type: 'text', text: 'hello' }], finishReason: 'stop', usage, warnings: [] };
    },
  };
}

describe('durability: resume replays instead of re-running', () => {
  it('a second run with the same runId does not invoke the model again', async () => {
    const counter = { calls: 0 };
    const journal = new InMemoryJournal();
    const opts = { runId: 'e2e-1', journal, model: countingModel(counter), prompt: 'hi' };

    const first = await runDurable(opts);
    const second = await runDurable(opts); // simulate a crash + retry with the SAME runId

    expect(first.text).toBe(second.text);   // identical output
    expect(counter.calls).toBe(1);          // the model ran once; the 2nd run replayed the journal
  });
});
