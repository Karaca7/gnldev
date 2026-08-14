// Taking over a stale claim has to be single-owner, and it was not.
//
// The FRESH claim uses `claim()` (putIfAbsent) and is genuinely atomic. Taking over a stale one —
// after a crash, or a failed attempt, or an approved retry — wrote unconditionally, so two workers
// reaching it in the same moment both "took" it and both ran the side effect. The comment above that
// write said "single-owner reclaim"; it wasn't.
//
// The trigger is not exotic. It is exactly what SideEffectRetryBlockedError tells you to do —
// approve, or declare idempotent, or supply recover() — plus two workers on one runId, which is an
// at-least-once queue or two "resume" clicks.
//
// Two things this fix depends on, both of which broke a first attempt:
//   - putIfMatch compares the SERIALISED expected value, so it must be given the raw journal.get()
//     result; an upgradeFormat'ed copy never matches and the CAS always loses.
//   - The loser must not `continue` on a stale read, or the loop re-enters the same branch forever.
//     That livelock hung the cross-process suite for half an hour before it was spotted.
import { describe, it, expect } from 'vitest';
import { durableTool } from '../src/durable-tool.js';
import { InMemoryStorage, RunBusyError } from '../src/index.js';
import type { DurableCtx } from '../src/journal.js';

const KEY = 'call-1';

/** A claim old enough to be stale: the signature of a worker that died mid-tool. */
async function staleClaim(journal: any, runId: string) {
  await journal.put(`${runId}:tool:${KEY}`, {
    status: 'running',
    startedAt: Date.now() - 120_000,
    toolName: 'chargeCard',
    attempts: 1,
  });
}

function countingTool() {
  let executions = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  const tool = {
    sideEffect: true,
    execute: async () => {
      executions++;
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 30)); // hold it open so a twin would overlap
      concurrent--;
      return { chargeId: `ch_${executions}` };
    },
  };
  return { tool, executions: () => executions, maxConcurrent: () => maxConcurrent };
}

describe('two workers reaching the same stale claim', () => {
  it('with an approval — the remedy the error message recommends — only one executes', async () => {
    const runId = 'stale-approved';
    const journal = new InMemoryStorage().runs;
    await staleClaim(journal, runId);

    const { tool, executions, maxConcurrent } = countingTool();
    // Two independent contexts on one journal: two processes resuming the same run.
    const worker = () => {
      const ctx: DurableCtx = { journal, runId, approvals: { [KEY]: true } } as DurableCtx;
      return durableTool(tool as any, ctx, 'chargeCard').execute!({ amount: 20 }, { toolCallId: KEY });
    };

    const results = await Promise.allSettled([worker(), worker()]);

    expect(executions()).toBe(1);
    expect(maxConcurrent()).toBe(1);
    // One of them got through; the other was told someone else owns it.
    const rejected = results.filter((r) => r.status === 'rejected');
    for (const r of rejected) expect((r as PromiseRejectedResult).reason).toBeInstanceOf(RunBusyError);
  });

  it('with idempotent: true — the other documented remedy — still only one execution', async () => {
    const runId = 'stale-idempotent';
    const journal = new InMemoryStorage().runs;
    await staleClaim(journal, runId);

    const { tool, executions } = countingTool();
    Object.assign(tool, { idempotent: true, sideEffect: false });
    const worker = () => {
      const ctx: DurableCtx = { journal, runId } as DurableCtx;
      return durableTool(tool as any, ctx, 'chargeCard').execute!({ amount: 20 }, { toolCallId: KEY });
    };

    await Promise.allSettled([worker(), worker()]);
    expect(executions()).toBe(1);
  });

  it('a single worker still takes over cleanly — the CAS does not block the normal case', async () => {
    const runId = 'stale-single';
    const journal = new InMemoryStorage().runs;
    await staleClaim(journal, runId);

    const { tool, executions } = countingTool();
    const ctx: DurableCtx = { journal, runId, approvals: { [KEY]: true } } as DurableCtx;
    const out: any = await durableTool(tool as any, ctx, 'chargeCard').execute!({ amount: 20 }, { toolCallId: KEY });

    expect(executions()).toBe(1);
    expect(out.chargeId).toBe('ch_1');
  });
});
