// H7 — CRASH WINDOW: the "the tool ran but the process died before the result could be written to the journal" scenario.
// There is no such thing, physically, as an atomic dual-write to two systems (journal + outside world); this window CANNOT
// be closed, only managed SAFELY. This file locks down the H7 contract for that window, which was untested until now:
//   - Unmarked (default = side-effecting) tool: on stale 'running' reclaim it is NOT AUTOMATICALLY
//     RE-RUN → SideEffectRetryBlockedError (double-charging is impossible; the cost is a human decision).
//   - approvals[toolCallId]=true: a human says "re-run knowing the risk" → runs exactly 1 more time.
//   - a tool marked idempotent: true: frictionless reclaim (retrying is declared harmless).
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, runKeys, durableTool, SideEffectRetryBlockedError } from '../src/index.js';

const STALE_MS = 60_000; // above CLAIM_TTL_MS (30s) — definitely stale

/** Set up the crash window exactly: the side effect HAS RUN (counter is 1) but the ledger is still 'running'. */
async function crashWindow(journal: InMemoryJournal, runId: string, toolCallId: string) {
  await journal.put(runKeys.tool(runId, toolCallId), {
    status: 'running',
    startedAt: Date.now() - STALE_MS,
  });
}

describe('H7 crash window (stale running) — safe default', () => {
  it('unmarked tool: reclaim is BLOCKED, the body does NOT run again (double charge impossible)', async () => {
    const journal = new InMemoryJournal();
    let charges = 1; // the card was charged once BEFORE the crash (the essence of the window)
    await crashWindow(journal, 'r1', 'call-1');

    const dt = durableTool(
      { execute: async () => { charges++; return { charged: 20 }; } },
      { journal, runId: 'r1' },
      'chargeCard',
    );
    await expect(dt.execute!({ amount: 20 }, { toolCallId: 'call-1' })).rejects.toThrow(
      SideEffectRetryBlockedError,
    );
    await expect(dt.execute!({ amount: 20 }, { toolCallId: 'call-1' })).rejects.toThrow(/MAY have already run/);
    expect(charges).toBe(1); // ✅ the card was NOT charged a second time — the promise itself
  });

  it('human approval: approvals[toolCallId]=true → deliberate re-run, exactly once', async () => {
    const journal = new InMemoryJournal();
    let charges = 1;
    await crashWindow(journal, 'r2', 'call-1');

    const dt = durableTool(
      { execute: async () => { charges++; return { charged: 20 }; } },
      { journal, runId: 'r2', approvals: { 'call-1': true } },
      'chargeCard',
    );
    expect(await dt.execute!({ amount: 20 }, { toolCallId: 'call-1' })).toEqual({ charged: 20 });
    expect(charges).toBe(2); // by human decision, and ONLY once
    // Now recorded as 'succeeded' → the third call replays (no side effect):
    expect(await dt.execute!({ amount: 20 }, { toolCallId: 'call-1' })).toEqual({ charged: 20 });
    expect(charges).toBe(2);
  });

  it('a tool marked idempotent: true: frictionless reclaim (no approval needed)', async () => {
    const journal = new InMemoryJournal();
    let calls = 1;
    await crashWindow(journal, 'r3', 'call-1');

    const dt = durableTool(
      { idempotent: true, execute: async () => { calls++; return 'search-result'; } },
      { journal, runId: 'r3' },
      'search',
    );
    expect(await dt.execute!({ q: 'x' }, { toolCallId: 'call-1' })).toBe('search-result');
    expect(calls).toBe(2); // ran again freely because it was declared harmless
  });

  it('the FRESH running (not a crash, a concurrent executor) distinction is preserved: RunBusyError', async () => {
    const journal = new InMemoryJournal();
    await journal.put(runKeys.tool('r4', 'call-1'), { status: 'running', startedAt: Date.now() - 1000 });
    const dt = durableTool(
      { execute: async () => 'x' },
      { journal, runId: 'r4' },
    );
    await expect(dt.execute!({}, { toolCallId: 'call-1' })).rejects.toThrow(/another executor/);
  });

  it('end-to-end window simulation: the succeeded write is SWALLOWED by the crash → resume stays on the safe side', async () => {
    // Simulated crash: the process dies right as 'succeeded' is about to be written — from that moment on NO write
    // can happen (in a real death, the catch block writing 'failed' is impossible too). The side effect
    // has run, the ledger is still 'running'. The subsequent resume must BLOCK the unmarked tool.
    const inner = new InMemoryJournal();
    let dying = false;
    const journal: any = {
      get: (k: string) => inner.get(k),
      putIfAbsent: (k: string, v: unknown) => inner.putIfAbsent(k, v),
      listKeys: (p: string) => inner.listKeys(p),
      put: async (k: string, v: any) => {
        if (v?.status === 'succeeded' && !dying) dying = true; // moment of death: didn't make it to the succeeded write
        if (dying) throw new Error('CRASH: process died');
        return inner.put(k, v);
      },
    };
    let charges = 0;
    const mk = () => durableTool(
      { execute: async () => { charges++; return { charged: 20 }; } },
      { journal, runId: 'r5' },
      'chargeCard',
    );
    // First run: the body runs (charge=1), the succeeded write is swallowed by the "crash".
    await expect(mk().execute!({ amount: 20 }, { toolCallId: 'call-1' })).rejects.toThrow('CRASH');
    expect(charges).toBe(1);
    expect((await inner.get(runKeys.tool('r5', 'call-1')) as any).status).toBe('running'); // proof of the window

    // Stale it out + resume ("new process"): the H7 gate is active — NO double charge.
    await inner.put(runKeys.tool('r5', 'call-1'), { status: 'running', startedAt: Date.now() - STALE_MS });
    dying = false;
    await expect(mk().execute!({ amount: 20 }, { toolCallId: 'call-1' })).rejects.toThrow(SideEffectRetryBlockedError);
    expect(charges).toBe(1); // ✅ total charges across the window: EXACTLY 1
  });
});

describe('H9 — the recover hook: ask the provider for the truth, exactly-once AUTOMATIC', () => {
  it('stale running + recover says "it happened" → NO retry, the result is recovered, the run continues without approval', async () => {
    const journal = new InMemoryJournal();
    let charges = 1; // was charged before the crash
    await crashWindow(journal, 'h9a', 'call-1');

    const dt = durableTool(
      {
        execute: async () => { charges++; return { charged: 20 }; },
        // Stripe pattern: query by idempotencyKey — the transaction was found.
        recover: async (_i: any, { idempotencyKey }: any) => {
          expect(idempotencyKey).toBe('h9a:call-1');
          return { done: true as const, output: { charged: 20, recovered: true } };
        },
      },
      { journal, runId: 'h9a' },
      'chargeCard',
    );
    const out = await dt.execute!({ amount: 20 }, { toolCallId: 'call-1' });
    expect(out).toEqual({ charged: 20, recovered: true });
    expect(charges).toBe(1); // ✅ no retry, no approval — exactly-once automatic
    // The record turned into succeeded → the next call is a pure replay:
    expect(await dt.execute!({ amount: 20 }, { toolCallId: 'call-1' })).toEqual({ charged: 20, recovered: true });
    expect(charges).toBe(1);
  });

  it('stale running + recover says "it never happened" → safely AUTOMATICALLY re-run (exactly 1)', async () => {
    const journal = new InMemoryJournal();
    let charges = 0; // in reality: it died before ever reaching execute
    await crashWindow(journal, 'h9b', 'call-1');

    const dt = durableTool(
      {
        execute: async () => { charges++; return { charged: 20 }; },
        recover: async () => ({ done: false as const }),
      },
      { journal, runId: 'h9b' },
      'chargeCard',
    );
    expect(await dt.execute!({ amount: 20 }, { toolCallId: 'call-1' })).toEqual({ charged: 20 });
    expect(charges).toBe(1); // the provider said 'it didn\'t happen' → auto re-run, still exactly 1
  });

  it('if recover THROWS (provider unreachable) → safe last resort: approval gate, NO retry', async () => {
    const journal = new InMemoryJournal();
    let charges = 1;
    await crashWindow(journal, 'h9c', 'call-1');

    const dt = durableTool(
      {
        execute: async () => { charges++; return { charged: 20 }; },
        recover: async () => { throw new Error('provider 503'); },
      },
      { journal, runId: 'h9c' },
      'chargeCard',
    );
    await expect(dt.execute!({ amount: 20 }, { toolCallId: 'call-1' })).rejects.toThrow(SideEffectRetryBlockedError);
    expect(charges).toBe(1); // the ambiguity could not be resolved → stop (no silent double charge)
  });

  it('ambiguous FAILED (a timeout may have actually gone through server-side) + recover says "it happened" → recovery instead of retry', async () => {
    const journal = new InMemoryJournal();
    let calls = 1; // the first attempt wrote 'failed' due to timeout, but it WENT THROUGH server-side
    await journal.put(runKeys.tool('h9d', 'call-1'), { status: 'failed', error: 'ETIMEDOUT', attempts: 1 });

    const dt = durableTool(
      {
        execute: async () => { calls++; return { charged: 20 }; },
        recover: async () => ({ done: true as const, output: { charged: 20, via: 'lookup' } }),
      },
      { journal, runId: 'h9d' },
      'chargeCard',
    );
    expect(await dt.execute!({ amount: 20 }, { toolCallId: 'call-1' })).toEqual({ charged: 20, via: 'lookup' });
    expect(calls).toBe(1); // the truth behind the timeout was found — NO double charge
  });
});

describe("H10 — footnotes turned into code: strict tool policy", () => {
  it("toolPolicy 'strict': an undeclared tool is caught by name at the START of the run; declared ones pass", async () => {
    const { durableTools } = await import('../src/durable-tool.js');
    const ctx = { journal: new InMemoryJournal(), runId: 'p1', toolPolicy: 'strict' as const };

    // Undeclared chargeCard → at wiring time, not mid-run:
    expect(() =>
      durableTools({ chargeCard: { execute: async () => 1 }, ara: { idempotent: true, execute: async () => 2 } }, ctx),
    ).toThrow(/\[chargeCard\]/);

    // Any one of the three legitimate declarations is sufficient:
    expect(() =>
      durableTools(
        {
          odeme: { recover: async () => ({ done: false as const }), execute: async () => 1 },
          posta: { sideEffect: true, execute: async () => 2 },
          ara: { idempotent: true, execute: async () => 3 },
        },
        ctx,
      ),
    ).not.toThrow();

    // Without a policy given, old behavior identically (undeclared is free):
    expect(() =>
      durableTools({ chargeCard: { execute: async () => 1 } }, { journal: new InMemoryJournal(), runId: 'p2' }),
    ).not.toThrow();
  });
});
