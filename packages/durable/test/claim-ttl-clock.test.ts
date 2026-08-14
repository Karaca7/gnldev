// A claim is "stale" when it is older than the claim TTL, and both halves of that sentence were
// measured against the wrong thing.
//
// THE CLOCK. `startedAt` is written by whichever worker claimed it, and staleness was computed
// against the LOCAL process clock — so whether a live claim looked expired depended on clock skew
// between workers, not on elapsed time. run-lock.ts has always used `journal.now()` for exactly this
// reason; durable-tool had not.
//
// THE DURATION. The 30s default applied to every tool, including one that declares
// `timeoutMs: 120_000` — which is the tool saying, in the API's own vocabulary, that it may
// legitimately run for two minutes. It was declared crashed at 30s while still executing, and a
// second worker took the claim and ran the side effect alongside it.
import { describe, it, expect } from 'vitest';
import { durableTool } from '../src/durable-tool.js';
import { InMemoryStorage, RunBusyError } from '../src/index.js';
import type { DurableCtx } from '../src/journal.js';

const KEY = 'call-1';

/** A journal whose clock is offset from this process's — a worker with a skewed system time. */
function skewedJournal(base: any, skewMs: number) {
  return new Proxy(base, {
    get(t, p, r) {
      if (p === 'now') return async () => Date.now() + skewMs;
      const v = Reflect.get(t, p, r);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

async function liveClaim(journal: any, runId: string, ageMs = 0) {
  await journal.put(`${runId}:tool:${KEY}`, {
    status: 'running',
    startedAt: Date.now() - ageMs,
    toolName: 'slowCharge',
    attempts: 1,
  });
}

function tool(extra: Record<string, unknown> = {}) {
  let executions = 0;
  return {
    tool: { sideEffect: true, execute: async () => { executions++; return { ok: true }; }, ...extra },
    executions: () => executions,
  };
}

describe('claim staleness is measured against the shared clock and the declared work', () => {
  it('a worker whose local clock runs ahead does not steal a live claim', async () => {
    const runId = 'skew-1';
    const base = new InMemoryStorage().runs;
    // Written 60s ago by the LOCAL clock — past the 30s default, so a Date.now() comparison calls it
    // stale. The shared clock says only a second has passed, because this worker's own clock is the
    // thing that is 59s fast.
    await liveClaim(base, runId, 60_000);
    const journal = skewedJournal(base, -59_000);

    const { tool: t, executions } = tool();
    const ctx: DurableCtx = { journal, runId } as DurableCtx;

    await expect(
      durableTool(t as any, ctx, 'slowCharge').execute!({ amount: 1 }, { toolCallId: KEY }),
    ).rejects.toBeInstanceOf(RunBusyError);
    expect(executions()).toBe(0);
  });

  it("a tool that declares a long timeoutMs is not declared crashed inside it", async () => {
    const runId = 'ttl-1';
    const journal = new InMemoryStorage().runs;
    // 60s into a call from a tool that says it may take two minutes: live, not stale.
    await liveClaim(journal, runId, 60_000);

    const { tool: t, executions } = tool({ timeoutMs: 120_000 });
    const ctx: DurableCtx = { journal, runId } as DurableCtx;

    await expect(
      durableTool(t as any, ctx, 'slowCharge').execute!({ amount: 1 }, { toolCallId: KEY }),
    ).rejects.toBeInstanceOf(RunBusyError);
    expect(executions()).toBe(0);
  });

  it('the same claim IS stale once it passes the declared timeout, and is reclaimed', async () => {
    const runId = 'ttl-2';
    const journal = new InMemoryStorage().runs;
    await liveClaim(journal, runId, 200_000); // past 120s — genuinely abandoned

    const { tool: t, executions } = tool({ timeoutMs: 120_000, idempotent: true, sideEffect: false });
    const ctx: DurableCtx = { journal, runId } as DurableCtx;

    await durableTool(t as any, ctx, 'slowCharge').execute!({ amount: 1 }, { toolCallId: KEY });
    expect(executions()).toBe(1);
  });

  it('an explicit claimTtlMs still wins over the timeout-derived floor', async () => {
    const runId = 'ttl-3';
    const journal = new InMemoryStorage().runs;
    await liveClaim(journal, runId, 5_000);

    // The caller says 1s, overriding a 120s timeout: 5s in, this claim is stale by their rule.
    const { tool: t, executions } = tool({ timeoutMs: 120_000, claimTtlMs: 1_000, idempotent: true, sideEffect: false });
    const ctx: DurableCtx = { journal, runId } as DurableCtx;

    await durableTool(t as any, ctx, 'slowCharge').execute!({ amount: 1 }, { toolCallId: KEY });
    expect(executions()).toBe(1);
  });
});
