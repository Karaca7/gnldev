// AUDIT C3 — `maxToolCalls` must bound side-effect ATTEMPTS, not only SUCCESSES.
//
// The hole: a side-effecting tool that executes its effect and THEN throws (e.g. chargeCard posts the
// charge, then errors on the response) records 'failed'. The old counter incremented ONLY for
// 'succeeded' records, so a flaky side-effect tool could run an UNBOUNDED number of REAL executions
// (real charges) while `succeededToolCalls` stayed at 0 → `maxToolCalls` never fired.
//
// The fix (protection-hardening, backward-compatible in spirit — it can only make the limit STRICTER):
// a SIDE-EFFECT tool whose execute was actually INVOKED counts toward maxToolCalls whether it ends
// 'succeeded' OR 'failed'. A read-only tool (idempotent:true / sideEffect:false) that fails does NOT
// count (it did no side effect).
import { describe, it, expect } from 'vitest';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { RunLimitExceededError } from '../src/limits.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

describe('AUDIT C3 — maxToolCalls bounds side-effect ATTEMPTS (not only successes)', () => {
  it('a side-effect tool that EXECUTES then THROWS is bounded by maxToolCalls (each failed attempt counts)', async () => {
    const journal = new InMemoryJournal();
    let realCharges = 0;
    // A flaky side-effect tool: it POSTS the charge (the real side effect) and THEN errors on the
    // response → the AI SDK swallows the throw into a 'tool-error' part and the model calls it again.
    // No idempotent/sideEffect flag → treated as a side effect by default (H7 safe default).
    const chargeCard = tool({
      description: 'charge the customer card',
      inputSchema: z.object({ amount: z.number() }),
      execute: async () => {
        realCharges++; // the side effect ALREADY happened
        throw new Error('gateway timeout AFTER the charge posted');
      },
    });
    // The model keeps calling chargeCard (a fresh toolCallId + fresh args each time → each is a genuine
    // new charge attempt, no duplicate/loop guard involved), until it "gives up" after many attempts.
    const model = createMockModel(async ({ prompt }: any) => {
      const done = countToolResults(prompt);
      if (done < 8) return toolCallResult('chargeCard', `call-${done + 1}`, { amount: done + 1 });
      return finalTextResult('Giving up.');
    });

    // maxToolCalls:3 → after 3 real charge ATTEMPTS the gate must block the 4th BEFORE it executes.
    await expect(
      runDurable({
        runId: 'c3-run', journal, model, tools: { chargeCard },
        prompt: 'charge the card', stopWhen: stepCountIs(20),
        limits: { maxToolCalls: 3 },
      }),
    ).rejects.toBeInstanceOf(RunLimitExceededError);

    // The heart of C3: EXACTLY 3 real charges happened — NOT 8. Before the fix the counter stayed 0 and
    // all 8 attempts (8 real charges) executed while the "limit" never fired.
    expect(realCharges).toBe(3);
    // The 4th call was blocked PROSPECTIVELY — nothing written for it.
    expect(await journal.get('c3-run:tool:call-4')).toBeUndefined();
  });

  it('a READ-ONLY (idempotent) tool that fails does NOT count toward maxToolCalls (no side effect done)', async () => {
    const journal = new InMemoryJournal();
    let attempts = 0;
    // idempotent:true → read-only. Failing it did no side effect, so a failure must NOT consume the budget.
    const flakyRead = tool({
      description: 'read a value (idempotent, no side effect)',
      inputSchema: z.object({ q: z.number() }),
      idempotent: true,
      execute: async () => {
        attempts++;
        if (attempts <= 4) throw new Error('transient read error');
        return { ok: true };
      },
    });
    // Fails 4 times, then succeeds once, then the model finishes.
    const model = createMockModel(async ({ prompt }: any) => {
      const done = countToolResults(prompt);
      if (done < 5) return toolCallResult('flakyRead', `call-${done + 1}`, { q: done + 1 });
      return finalTextResult('Read done.');
    });

    // maxToolCalls:1 — with ONLY 1 success allowed. The 4 read FAILURES must not count; only the single
    // success counts. So the run completes (the success is the 1st and only counted call).
    const res = await runDurable({
      runId: 'c3-read', journal, model, tools: { flakyRead },
      prompt: 'read', stopWhen: stepCountIs(20),
      limits: { maxToolCalls: 1 },
    });
    expect(res.text).toContain('Read done.');
    expect(attempts).toBe(5); // 4 failed + 1 succeeded, none of the failures were blocked
  });
});
