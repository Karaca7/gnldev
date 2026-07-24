// streamDurable end-to-end: a real `streamText` loop + durable wrappers.
// Produces text; a second run with the same runId replays WITHOUT ever calling the underlying doStream (tool exactly-once).
import { describe, it, expect } from 'vitest';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { InMemoryJournal } from '../src/journal.js';
import { streamDurable } from '../src/run.js';
import { createMockStreamAgent } from './mock.js';

function makeTools(counter: { charges: number }) {
  return {
    chargeCard: tool({
      description: 'charge',
      inputSchema: z.object({ amount: z.number() }),
      execute: async ({ amount }) => {
        counter.charges++;
        return { charged: amount };
      },
    }),
  };
}

describe('streamDurable e2e', () => {
  it('produces text + replay: run 2 does not call the underlying model, charge exactly-once', async () => {
    const journal = new InMemoryJournal();
    const counter = { charges: 0 };

    const calls1 = { calls: 0 };
    const r1 = await streamDurable({
      runId: 's1', journal, model: createMockStreamAgent(calls1), tools: makeTools(counter),
      prompt: 'charge', stopWhen: stepCountIs(6),
    });
    const text1 = await r1.text;
    expect(text1).toContain('Charged');
    expect(counter.charges).toBe(1);
    expect(calls1.calls).toBeGreaterThan(0);

    // Run 2 — same runId/journal → full replay
    const calls2 = { calls: 0 };
    const r2 = await streamDurable({
      runId: 's1', journal, model: createMockStreamAgent(calls2), tools: makeTools(counter),
      prompt: 'charge', stopWhen: stepCountIs(6),
    });
    const text2 = await r2.text;
    expect(text2).toContain('Charged');
    expect(counter.charges).toBe(1); // exactly-once: no re-charge on replay
    expect(calls2.calls).toBe(0); // underlying model was NEVER called (deterministic replay)
  });
});
