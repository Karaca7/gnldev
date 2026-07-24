// K1 — THE BLOCKED SENTINEL: the AI SDK's executeTools swallows the error thrown from tool.execute
// and converts it to 'tool-error' → the run does NOT stop. If block errors (SideEffectRetryBlocked/RetryLimit/RunBusy)
// were THROWN inside the loop, the model would see the error text and could produce a NEW
// toolCallId with the SAME arguments — since a fresh key means a fresh record, the H7 protection would be BREACHED (double charge).
// Solution: inside runDurable a sentinel (__gnl_blocked) is returned → composeStopWhen stops the loop →
// runDurableInner converts it to the real typed error and throws. This file locks down that contract:
//   - a stubborn model (retrying with a new toolCallId after seeing the error) CANNOT get around the protection,
//   - runDurable throws the OLD typed error to the caller (the external contract doesn't change),
//   - behavior for direct durableTool users (MCP server, manual wrapping) does NOT change: throw.
import { describe, it, expect } from 'vitest';
import {
  InMemoryJournal,
  runKeys,
  runDurable,
  durableTool,
  SideEffectRetryBlockedError,
  RetryLimitExceededError,
  RunBusyError,
} from '../src/index.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

const STALE_MS = 60_000; // above CLAIM_TTL_MS (30s) — definitely stale

/** Crash window: the side effect HAS RUN (counter is 1) but the ledger is still 'running'. */
async function crashWindow(journal: InMemoryJournal, runId: string, toolCallId: string) {
  await journal.put(runKeys.tool(runId, toolCallId), {
    status: 'running',
    startedAt: Date.now() - STALE_MS,
  });
}

/** Stubborn model: call-1 on the first turn; if it sees a tool result (including an error) it tries call-2 with the SAME arguments. */
function stubbornModel(gen: { calls: number }) {
  return createMockModel(async ({ prompt }: any) => {
    gen.calls++;
    const done = countToolResults(prompt);
    if (done === 0) return toolCallResult('chargeCard', 'call-1', { amount: 20 });
    return toolCallResult('chargeCard', 'call-2', { amount: 20 }); // bypass attempt
  });
}

describe('K1 — blocked sentinel: the model cannot bypass the protection', () => {
  it('stale running + stubborn model: the loop STOPS, call-2 is never produced, a typed error is thrown', async () => {
    const journal = new InMemoryJournal();
    let charges = 1; // the card was charged BEFORE the crash (the essence of the window)
    await crashWindow(journal, 'k1', 'call-1');
    const gen = { calls: 0 };

    await expect(
      runDurable({
        model: stubbornModel(gen),
        journal,
        runId: 'k1',
        prompt: 'issue a refund',
        tools: {
          chargeCard: { execute: async () => { charges++; return { charged: 20 }; } } as any,
        },
      }),
    ).rejects.toThrow(SideEffectRetryBlockedError);

    expect(charges).toBe(1); // ✅ NO double charge — the promise itself
    expect(gen.calls).toBe(1); // the model never made it to the SECOND turn (composeStopWhen stopped it)
    // the bypass key never came into existence: there's neither a record nor a claim for call-2
    expect(await journal.get(runKeys.tool('k1', 'call-2'))).toBeUndefined();
  });

  it('failed record (side-effecting, unapproved): runDurable throws SideEffectRetryBlockedError', async () => {
    const journal = new InMemoryJournal();
    let charges = 0;
    await journal.put(runKeys.tool('k2', 'call-1'), { status: 'failed', error: 'timeout', attempts: 1 });
    const gen = { calls: 0 };

    await expect(
      runDurable({
        model: stubbornModel(gen),
        journal,
        runId: 'k2',
        prompt: 'issue a refund',
        tools: {
          chargeCard: { execute: async () => { charges++; return { charged: 20 }; } } as any,
        },
      }),
    ).rejects.toThrow(SideEffectRetryBlockedError);
    expect(charges).toBe(0);
    expect(gen.calls).toBe(1);
  });

  it('idempotent tool with maxRetries exhausted: throws with type RetryLimitExceededError', async () => {
    const journal = new InMemoryJournal();
    await journal.put(runKeys.tool('k3', 'call-1'), { status: 'failed', error: 'boom', attempts: 3 });
    const gen = { calls: 0 };

    await expect(
      runDurable({
        model: stubbornModel(gen),
        journal,
        runId: 'k3',
        prompt: 'try',
        tools: {
          chargeCard: { idempotent: true, execute: async () => ({ ok: true }) } as any,
        },
      }),
    ).rejects.toThrow(RetryLimitExceededError);
    expect(gen.calls).toBe(1);
  });

  it('FRESH running (another executor in-flight): throws with type RunBusyError, execute does not run', async () => {
    const journal = new InMemoryJournal();
    let charges = 0;
    await journal.put(runKeys.tool('k4', 'call-1'), { status: 'running', startedAt: Date.now() });
    const gen = { calls: 0 };

    await expect(
      runDurable({
        model: stubbornModel(gen),
        journal,
        runId: 'k4',
        prompt: 'issue a refund',
        tools: {
          chargeCard: { execute: async () => { charges++; return { charged: 20 }; } } as any,
        },
      }),
    ).rejects.toThrow(RunBusyError);
    expect(charges).toBe(0);
    expect(gen.calls).toBe(1);
  });

  it('resume with approvals flows AS BEFORE: deliberate re-run + final answer', async () => {
    const journal = new InMemoryJournal();
    let charges = 1;
    await crashWindow(journal, 'k5', 'call-1');
    const gen = { calls: 0 };
    const model = createMockModel(async ({ prompt }: any) => {
      gen.calls++;
      if (countToolResults(prompt) === 0) return toolCallResult('chargeCard', 'call-1', { amount: 20 });
      return finalTextResult('refund complete');
    });

    const result = await runDurable({
      model,
      journal,
      runId: 'k5',
      prompt: 'issue a refund',
      approvals: { 'call-1': true },
      tools: {
        chargeCard: { execute: async () => { charges++; return { charged: 20 }; } } as any,
      },
    });
    expect(result.text).toBe('refund complete');
    expect(charges).toBe(2); // by human decision, and ONLY once more
    expect(result.interrupts).toEqual([]);
  });

  it('direct durableTool (outside the loop) contract UNCHANGED: throw', async () => {
    const journal = new InMemoryJournal();
    let charges = 1;
    await crashWindow(journal, 'k6', 'call-1');
    const dt = durableTool(
      { execute: async () => { charges++; return { charged: 20 }; } },
      { journal, runId: 'k6' }, // NO blockedAsSentinel → old behavior
      'chargeCard',
    );
    await expect(dt.execute!({ amount: 20 }, { toolCallId: 'call-1' })).rejects.toThrow(
      SideEffectRetryBlockedError,
    );
    expect(charges).toBe(1);
  });
});
