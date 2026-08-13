// `recover()` is what the framework tells you to add when a side-effecting tool crashed mid-flight
// and it cannot know whether the effect landed. Its contract is
// `{ done: true; output } | { done: false }`, and the branch is read as `if (probe.done)`.
//
// So any return that is not one of those two shapes is falsy on `.done` and lands in the
// "the provider says it never happened, re-run it" branch. A tool whose recover() returns
// `{ ok: true, chargeId }` — the shape a real payment SDK actually gives you back — charges the
// card a second time.
//
// Nothing catches this beforehand: `runDurable`'s `tools` is the AI SDK's `ToolSet`, which has no
// `recover` field at all, so the property is unchecked and a misspelling or a wrong shape compiles
// clean. The one place left to be careful is here, at the point of use.
//
// Found by a reviewer who followed SideEffectRetryBlockedError's own advice and got double-charged.
import { describe, it, expect } from 'vitest';
import { durableTool } from '../src/durable-tool.js';
import { InMemoryStorage, SideEffectRetryBlockedError } from '../src/index.js';
import type { DurableCtx } from '../src/journal.js';

const KEY = 'call-1';

/** A tool that has already run once and crashed before its success was journaled. */
function crashedOnce(recover: any) {
  let executions = 0;
  const tool = {
    sideEffect: true,
    recover,
    execute: async () => {
      executions++;
      return { ok: true, chargeId: `ch_${executions}` };
    },
  };
  return { tool, calls: () => executions };
}

async function stale(ctx: DurableCtx, runId: string) {
  // A 'running' record older than the claim TTL: the signature of a process that died mid-tool.
  await ctx.journal.put(`${runId}:tool:${KEY}`, {
    status: 'running',
    startedAt: Date.now() - 60_000,
    toolName: 'chargeCard',
    attempts: 1,
  } as any);
}

describe('recover() must not fail open on a shape it does not understand', () => {
  it('re-runs nothing when recover() answers with the provider payload instead of {done}', async () => {
    const runId = 'shape-1';
    const journal = new InMemoryStorage().runs;
    const ctx: DurableCtx = { journal, runId } as DurableCtx;
    await stale(ctx, runId);

    // The realistic mistake: return what the payment provider returned.
    const { tool, calls } = crashedOnce(async () => ({ ok: true, chargeId: 'ch_1' }));
    const dt = durableTool(tool as any, ctx, 'chargeCard');

    await expect(dt.execute!({ amount: 20 }, { toolCallId: KEY })).rejects.toThrow(
      SideEffectRetryBlockedError,
    );
    expect(calls()).toBe(0); // the card is NOT charged again
  });

  it('still re-runs when recover() properly says it never happened', async () => {
    const runId = 'shape-2';
    const journal = new InMemoryStorage().runs;
    const ctx: DurableCtx = { journal, runId } as DurableCtx;
    await stale(ctx, runId);

    const { tool, calls } = crashedOnce(async () => ({ done: false }));
    const dt = durableTool(tool as any, ctx, 'chargeCard');

    await dt.execute!({ amount: 20 }, { toolCallId: KEY });
    expect(calls()).toBe(1);
  });

  it('still recovers when recover() properly reports the effect landed', async () => {
    const runId = 'shape-3';
    const journal = new InMemoryStorage().runs;
    const ctx: DurableCtx = { journal, runId } as DurableCtx;
    await stale(ctx, runId);

    const { tool, calls } = crashedOnce(async () => ({ done: true, output: { chargeId: 'ch_existing' } }));
    const dt = durableTool(tool as any, ctx, 'chargeCard');

    const out = await dt.execute!({ amount: 20 }, { toolCallId: KEY });
    expect(out).toEqual({ chargeId: 'ch_existing' });
    expect(calls()).toBe(0);
  });

  it('treats a non-object answer the same way — safe side, not re-execution', async () => {
    for (const answer of [undefined, null, true, 'done', 42]) {
      const runId = `shape-${String(answer)}`;
      const journal = new InMemoryStorage().runs;
      const ctx: DurableCtx = { journal, runId } as DurableCtx;
      await stale(ctx, runId);

      const { tool, calls } = crashedOnce(async () => answer);
      const dt = durableTool(tool as any, ctx, 'chargeCard');

      await expect(dt.execute!({ amount: 20 }, { toolCallId: KEY })).rejects.toThrow(
        SideEffectRetryBlockedError,
      );
      expect(calls(), `answer=${String(answer)}`).toBe(0);
    }
  });
});
