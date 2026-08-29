// The three scenarios, as functions that MEASURE and return numbers.
//
// They used to live inline in demo.ts, computing counts into module-scope variables and printing
// them. That made the proof unusable as a test: the only way to run it was to print it. Since this
// example is the README's only evidence that the guarantee reaches the PROVIDER — not just the
// journal — "nothing runs it" was the gap worth closing. demo.ts still prints, and
// test/stripe-idempotency.test.ts asserts, from these same functions.
//
// Every scenario has the same shape: the charge succeeds at the provider, then the process "crashes"
// before the result is durably recorded.
import { InMemoryJournal, durableTool } from '@gnldev/durable';
import type { DurableCtx } from '@gnldev/durable';
import { MockStripe } from './mock-stripe.js';

export interface Outcome {
  /** How many times the tool's own `execute` body ran. */
  executeCalls: number;
  /** How many charges the provider actually recorded. */
  charges: number;
  /** What the second attempt returned, when the scenario has one. */
  result?: unknown;
  /** The error the crashing first attempt threw, for the demo to print. */
  firstAttemptError?: string;
}

/**
 * A) Unprotected — no @gnldev/durable at all.
 *
 * The naive retry mints a FRESH idempotency key, so Stripe sees two unrelated requests. This is the
 * incident, and the test asserts it still reproduces: without it the comparison below proves nothing.
 */
export async function scenarioUnprotected(): Promise<Outcome> {
  const stripe = new MockStripe();
  let executeCalls = 0;
  const chargeNaive = async (amount: number) => {
    executeCalls++;
    return stripe.chargesCreate(
      { amount, currency: 'usd' },
      { idempotencyKey: `naive-${executeCalls}-${Math.random().toString(36).slice(2)}` },
    );
  };
  await chargeNaive(2000); // original attempt (succeeds at Stripe)
  await chargeNaive(2000); // crash+resume → naive retry, NEW key
  return { executeCalls, charges: stripe.chargeCount };
}

/**
 * B) With GNL, approved retry, NO recover() hook.
 *
 * The approval was granted, so GNL genuinely lets `execute` run a second time — the framework's own
 * gate is open. The charge still happens once because the injected key is deterministic
 * (`${runId}:${toolCallId}`) and the PROVIDER collapses the second request onto the first. That is
 * the point of the scenario: the guarantee survives even when the retry gate lets a call through.
 */
export async function scenarioApprovedRetry(): Promise<Outcome> {
  const stripe = new MockStripe();
  let executeCalls = 0;
  const chargeCard = {
    sideEffect: true, // explicit — a payment IS a side effect (also the default per H7)
    execute: async (input: { amount: number }, options: any) => {
      executeCalls++;
      // Real Stripe SDK: stripe.charges.create({ amount, currency: 'usd' }, { idempotencyKey: options.idempotencyKey });
      const charge = await stripe.chargesCreate({ amount: input.amount, currency: 'usd' }, { idempotencyKey: options.idempotencyKey });
      if (executeCalls === 1) throw new Error('CRASH: Stripe committed the charge but the connection dropped BEFORE the response reached the process');
      return charge;
    },
  };
  const ctx: DurableCtx = { journal: new InMemoryJournal(), runId: 'order-77', approvals: { 'call-charge': true } };
  const dt = durableTool(chargeCard as any, ctx, 'chargeCard');

  let firstAttemptError: string | undefined;
  try {
    await dt.execute!({ amount: 2000 }, { toolCallId: 'call-charge' } as any); // attempt 1: crashes AFTER Stripe commits
  } catch (e: any) {
    firstAttemptError = e.message;
  }
  const result = await dt.execute!({ amount: 2000 }, { toolCallId: 'call-charge' } as any); // approved retry — execute RUNS AGAIN
  return { executeCalls, charges: stripe.chargeCount, result, firstAttemptError };
}

/**
 * C) With GNL + a `recover()` hook (the H9 ladder).
 *
 * Asks the provider "did this idempotencyKey already succeed?" before retrying, so `execute` never
 * runs a second time and no human approval is needed. The strongest of the three: one execute, one
 * charge.
 */
export async function scenarioRecover(): Promise<Outcome> {
  const stripe = new MockStripe();
  let executeCalls = 0;
  const chargeCard = {
    sideEffect: true,
    execute: async (input: { amount: number }, options: any) => {
      executeCalls++;
      const charge = await stripe.chargesCreate({ amount: input.amount, currency: 'usd' }, { idempotencyKey: options.idempotencyKey });
      if (executeCalls === 1) throw new Error('CRASH: Stripe committed the charge but the connection dropped BEFORE the response reached the process');
      return charge;
    },
    recover: async (_input: unknown, { idempotencyKey }: { idempotencyKey: string }) => {
      const existing = await stripe.findByIdempotencyKey(idempotencyKey);
      return existing ? { done: true, output: existing } : { done: false };
    },
  };
  const ctx: DurableCtx = { journal: new InMemoryJournal(), runId: 'order-78' }; // NO approvals — recover() resolves it
  const dt = durableTool(chargeCard as any, ctx, 'chargeCard');

  let firstAttemptError: string | undefined;
  try {
    await dt.execute!({ amount: 2000 }, { toolCallId: 'call-charge' } as any);
  } catch (e: any) {
    firstAttemptError = e.message;
  }
  const result = await dt.execute!({ amount: 2000 }, { toolCallId: 'call-charge' } as any); // recover() answers
  return { executeCalls, charges: stripe.chargeCount, result, firstAttemptError };
}
