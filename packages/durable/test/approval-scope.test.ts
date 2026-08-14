// How far does one human approval reach?
//
// The default answer is 'call': the decision is journaled per toolCallId so a crash cannot lose it,
// and further attempts are bounded by maxRetries. That is what makes "approved, then the process
// died before the tool ran" resume correctly, and it is tested in approval-persistence.test.ts.
//
// The cost is that a later resume meets the SAME uncertainty afresh — the effect may have landed
// this time too — and proceeds on an answer the operator gave about an EARLIER attempt. For a
// payment that is one click authorising several charges, most of them unasked.
//
// 'attempt' spends the approval on the attempt it unblocks. Opt-in, because the two readings are
// both defensible and only the operator knows whether a second click is cheaper than a second
// effect. A denial is never spent under either setting.
import { describe, it, expect } from 'vitest';
import { runDurable, InMemoryStorage, SideEffectRetryBlockedError, runKeys } from '../src/index.js';
import { tool } from 'ai';
import { z } from 'zod';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const CALL = 'call-charge';

/** Charges, then throws — the gateway timed out on the way back, so the effect DID land. */
function chargeThenTimeout() {
  let charges = 0;
  const t = tool({
    description: 'charge',
    inputSchema: z.object({ amount: z.number() }),
    execute: async () => { charges++; throw new Error('ETIMEDOUT after the charge posted'); },
  });
  Object.assign(t, { sideEffect: true });
  return { chargeCard: t as any, charges: () => charges };
}

function model() {
  return {
    specificationVersion: 'v2', provider: 'scripted', modelId: 'charger', supportedUrls: {},
    doGenerate: async ({ prompt }: any) => {
      const done = (prompt ?? []).filter((m: any) => m.role === 'tool').length;
      if (done === 0)
        return { content: [{ type: 'tool-call', toolCallId: CALL, toolName: 'chargeCard', input: JSON.stringify({ amount: 2000 }) }], finishReason: 'tool-calls', usage, warnings: [] };
      return { content: [{ type: 'text', text: 'done' }], finishReason: 'stop', usage, warnings: [] };
    },
    doStream: async () => { throw new Error('generate-only'); },
  } as any;
}

function runner(runId: string, limits?: any) {
  const journal = new InMemoryStorage().runs;
  const { chargeCard, charges } = chargeThenTimeout();
  const run = (approvals?: Record<string, boolean>) =>
    runDurable({ runId, journal, model: model(), tools: { chargeCard }, prompt: 'charge', ...(limits ? { limits } : {}), ...(approvals ? { approvals } : {}) })
      .catch((e) => e);
  return { run, charges };
}

describe('limits.approvalScope', () => {
  it("'attempt': the approval is spent by the attempt it unblocks, so the next one asks again", async () => {
    const { run, charges } = runner('scope-attempt', { approvalScope: 'attempt' });

    await run();                                   // charges, then throws
    expect(charges()).toBe(1);
    await run({ [CALL]: true });                   // the human approves once
    expect(charges()).toBe(2);

    const again = await run();                     // no fresh answer → must not proceed
    expect(again).toBeInstanceOf(SideEffectRetryBlockedError);
    expect(charges()).toBe(2);

    await run({ [CALL]: true });                   // asked again, answered again
    expect(charges()).toBe(3);
  });

  it("the default keeps the journaled approval, which is what survives a crash", async () => {
    const { run, charges } = runner('scope-default');

    await run();
    expect(charges()).toBe(1);
    await run({ [CALL]: true });
    expect(charges()).toBe(2);

    // Same decision, still standing: this is the documented behaviour, not an oversight.
    const again = await run();
    expect(again).not.toBeInstanceOf(SideEffectRetryBlockedError);
    expect(charges()).toBe(3);
  });

  it("'attempt' spends the approval BEFORE the effect runs — a SIGKILL mid-execute cannot reuse it", async () => {
    // The spend used to live in the catch, which only a CLEAN throw reaches. A process killed
    // mid-execute never runs a catch: the journaled approval stayed live, and the next resume met
    // "approved" and ran the effect again without asking — one click, two charges, the exact case
    // the option exists to close. The distinguishing observable is WHEN the slot is spent, so the
    // tool reads its own approval key from INSIDE execute: on the approved attempt, the answer must
    // already be gone by the time the effect is running.
    const journal = new InMemoryStorage().runs;
    const reads: unknown[] = [];
    let charges = 0;
    const t = tool({
      description: 'charge',
      inputSchema: z.object({ amount: z.number() }),
      execute: async () => {
        reads.push(await journal.get(runKeys.approval('scope-kill', CALL)));
        charges++;
        // First attempt: the gateway times out on the way back — side-effect uncertainty, a human is asked.
        if (charges === 1) throw new Error('ETIMEDOUT after the charge posted');
        return { ok: true };
      },
    });
    Object.assign(t, { sideEffect: true });

    const run = (approvals?: Record<string, boolean>) =>
      runDurable({ runId: 'scope-kill', journal, model: model(), tools: { chargeCard: t as any }, prompt: 'charge', limits: { approvalScope: 'attempt' }, ...(approvals ? { approvals } : {}) } as any).catch((e) => e);

    await run();                 // attempt 1: charges, throws → blocked, a human is asked
    await run({ [CALL]: true }); // attempt 2: the human approved → executes
    expect(charges).toBe(2);

    const duringApproved = reads[1] as { __gnl_approval_spent?: boolean } | boolean | undefined;
    expect(duringApproved, 'a raw true here would survive a SIGKILL and approve a second, unasked attempt')
      .not.toBe(true);
    expect((duringApproved as any)?.__gnl_approval_spent, 'the slot holds the spent sentinel while the effect runs').toBe(true);
  });

  it("a denial is not spent under 'attempt' either — it keeps denying without re-asking", async () => {
    const { run, charges } = runner('scope-deny', { approvalScope: 'attempt' });

    await run();
    expect(charges()).toBe(1);
    await run({ [CALL]: false });
    expect(charges()).toBe(1);
    await run();                                   // still denied, no new question
    expect(charges()).toBe(1);
  });
});
