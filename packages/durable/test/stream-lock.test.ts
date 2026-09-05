// AUDIT B3(a) — streamDurable run-lock. streamDurable used to IGNORE `lock` entirely (a `lock` passed
// in was swallowed into `...rest` and handed to streamText as an unknown option) → two workers could
// stream the same runId concurrently with no serialization. This suite pins the opt-in lock: a
// concurrent stream of a locked runId gets RunBusyError, and the lock is released when the stream ends.
//
// FAZ-7 UPDATE: the streamed lock now self-renews on a ttl/2 heartbeat (parity with runDurable),
// hard-capped at STREAM_LOCK_MAX_HOLD_MS so the old objection — "an abandoned stream would hold the
// lock forever" — stays answered: abandonment costs a bounded hold, then TTL reclaims.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { streamDurable } from '../src/run.js';
import { acquireRunLock } from '../src/run-lock.js';
import { RunBusyError } from '../src/errors.js';
import { createMockStreamAgent } from './mock.js';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';

function makeTools() {
  return {
    chargeCard: tool({
      description: 'charge',
      inputSchema: z.object({ amount: z.number() }),
      execute: async ({ amount }) => ({ charged: amount }),
    }),
  };
}

describe('streamDurable run-lock (audit B3a)', () => {
  it('a concurrent stream of a locked runId is rejected with RunBusyError', async () => {
    const journal = new InMemoryJournal();
    // Another worker already holds the lock (far-future TTL → definitely live).
    const held = await acquireRunLock(journal, 'b3a', 'worker-A', 60_000);
    expect(held).not.toBeNull();

    // A second worker tries to stream the SAME runId with a lock → must be refused.
    await expect(
      streamDurable({
        runId: 'b3a', journal, model: createMockStreamAgent(), tools: makeTools(),
        prompt: 'charge', stopWhen: stepCountIs(6), lock: { owner: 'worker-B', ttlMs: 60_000 },
      } as any),
    ).rejects.toBeInstanceOf(RunBusyError);
  });

  it('the lock is released when the stream finishes (a later acquire succeeds)', async () => {
    const journal = new InMemoryJournal();
    const r = await streamDurable({
      runId: 'b3a-release', journal, model: createMockStreamAgent(), tools: makeTools(),
      prompt: 'charge', stopWhen: stepCountIs(6), lock: { owner: 'worker-A', ttlMs: 60_000 },
    } as any);
    // Drive the stream to completion → onFinish fires → the lock is released.
    const text = await r.text;
    expect(text).toContain('Charged');

    // onFinish is async (a few microtasks after `r.text` resolves — same as the memory-append tests);
    // poll until the lock is free. Another owner acquiring it (non-null) proves it was released.
    let after = null as Awaited<ReturnType<typeof acquireRunLock>>;
    const t0 = Date.now();
    while (after === null && Date.now() - t0 < 1000) {
      after = await acquireRunLock(journal, 'b3a-release', 'worker-B', 60_000);
      if (after === null) await new Promise((r) => setTimeout(r, 10));
    }
    expect(after).not.toBeNull();
  });
});
