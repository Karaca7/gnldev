// Run: pnpm demo   (no API key needed — mock Stripe, no network calls)
//
// A3: shows that GNL's exactly-once guarantee extends BEYOND the framework, all the way to a real
// payment provider — via the `idempotencyKey` durable-tool.ts injects into every tool's `execute`
// options (see packages/durable/src/durable-tool.ts, `execOpts = { ...options, idempotencyKey }`).
//
// Three scenarios, same crash+resume shape (charge succeeds at the provider, then the process
// "crashes" before the result is durably recorded):
//   A) unprotected — no @gnl/durable at all, naive retry with a FRESH key each attempt → Stripe sees
//                    two unrelated requests → 2 charges.
//   B) with GNL    — durableTool + approved retry, NO recover() hook. GNL allows the retry (approval
//                    was granted) so `execute` genuinely runs twice — but because the injected
//                    idempotencyKey is DETERMINISTIC (`${runId}:${toolCallId}`), Stripe itself collapses
//                    the second request onto the first charge. The provider is the backstop even when
//                    the framework's own retry gate lets a call through.
//   C) with GNL    — durableTool + a `recover()` hook (H9 ladder): asks Stripe "did this idempotencyKey
//      (bonus)       already succeed?" BEFORE retrying — `execute` doesn't even run a second time, no
//                    human approval needed.
import { InMemoryJournal, durableTool } from '@gnl/durable';
import type { DurableCtx } from '@gnl/durable';
import { MockStripe } from './mock-stripe.js';

function section(title: string): void {
  console.log(`\n— ${title} —`);
}

console.log('A3: provider-side exactly-once (mock Stripe) — crash+resume\n');
console.log('GNL injects a stable idempotencyKey into every tool execute() (durable-tool.ts). This demo');
console.log('threads it to a mock Stripe client that mirrors the real SDK\'s Idempotency-Key contract:');
console.log("  await stripe.charges.create({ amount, currency }, { idempotencyKey });  // real Stripe SDK\n");

// ── Scenario A: unprotected (no GNL) — naive retry, a DIFFERENT idempotencyKey on EVERY attempt ──
let chargesA: number, executeCallsA: number;
{
  section('Scenario A: unprotected (no GNL)');
  const stripe = new MockStripe();
  let executeCalls = 0;
  const chargeNaive = async (amount: number) => {
    executeCalls++;
    // no stable key travels to the provider on retry → Stripe can't tell this is the SAME request
    return stripe.chargesCreate({ amount, currency: 'usd' }, { idempotencyKey: `naive-${executeCalls}-${Math.random().toString(36).slice(2)}` });
  };
  await chargeNaive(2000); // original attempt (succeeds at Stripe)
  await chargeNaive(2000); // crash+resume → naive retry, NEW key
  console.log(`  execute ran ${executeCalls} times → Stripe recorded ${stripe.chargeCount} charge(s)`);
  executeCallsA = executeCalls;
  chargesA = stripe.chargeCount;
}

// ── Scenario B: with GNL — crash AFTER Stripe commits the charge, BEFORE the journal write; approved retry, NO recover ──
let chargesB: number, executeCallsB: number;
{
  section('Scenario B: with GNL (idempotencyKey injected, approved retry, no recover)');
  const stripe = new MockStripe();
  let executeCalls = 0;
  const chargeCard = {
    sideEffect: true, // explicit — a payment IS a side effect (also the default per H7)
    execute: async (input: { amount: number }, options: any) => {
      executeCalls++;
      // Real Stripe SDK: stripe.charges.create({ amount, currency: 'usd' }, { idempotencyKey: options.idempotencyKey });
      const charge = await stripe.chargesCreate({ amount: input.amount, currency: 'usd' }, { idempotencyKey: options.idempotencyKey });
      if (executeCalls === 1) throw new Error("CRASH: Stripe committed the charge but the connection dropped BEFORE the response reached the process");
      return charge;
    },
  };
  const journal = new InMemoryJournal();
  const ctx: DurableCtx = { journal, runId: 'order-77', approvals: { 'call-charge': true } };
  const dt = durableTool(chargeCard as any, ctx, 'chargeCard');

  try {
    await dt.execute!({ amount: 2000 }, { toolCallId: 'call-charge' }); // attempt 1: crashes AFTER Stripe commits
  } catch (e: any) {
    console.log(`  attempt 1: ${e.message}`);
  }
  const result = await dt.execute!({ amount: 2000 }, { toolCallId: 'call-charge' }); // approved retry — execute RUNS AGAIN
  console.log(`  execute ran ${executeCalls} times (GNL allowed the approved retry) → Stripe has ${stripe.chargeCount} charge(s)`);
  console.log(`  attempt 2 result: ${JSON.stringify(result)}`);
  executeCallsB = executeCalls;
  chargesB = stripe.chargeCount;
}

// ── Scenario C (bonus): with GNL + recover() — execute NEVER runs again, NO approval needed ──
let chargesC: number, executeCallsC: number;
{
  section('Scenario C (bonus): with GNL + recover() hook — automatic, no approval needed');
  const stripe = new MockStripe();
  let executeCalls = 0;
  const chargeCard = {
    sideEffect: true,
    execute: async (input: { amount: number }, options: any) => {
      executeCalls++;
      const charge = await stripe.chargesCreate({ amount: input.amount, currency: 'usd' }, { idempotencyKey: options.idempotencyKey });
      if (executeCalls === 1) throw new Error("CRASH: Stripe committed the charge but the connection dropped BEFORE the response reached the process");
      return charge;
    },
    // H9: ask the PROVIDER for the truth instead of blocking on human approval.
    recover: async (_input: unknown, { idempotencyKey }: { idempotencyKey: string }) => {
      const existing = await stripe.findByIdempotencyKey(idempotencyKey);
      return existing ? { done: true, output: existing } : { done: false };
    },
  };
  const journal = new InMemoryJournal();
  const ctx: DurableCtx = { journal, runId: 'order-78' }; // NO approvals — recover() resolves it automatically
  const dt = durableTool(chargeCard as any, ctx, 'chargeCard');

  try {
    await dt.execute!({ amount: 2000 }, { toolCallId: 'call-charge' });
  } catch (e: any) {
    console.log(`  attempt 1: ${e.message}`);
  }
  const result = await dt.execute!({ amount: 2000 }, { toolCallId: 'call-charge' }); // recover() answers, NO approval needed
  console.log(`  execute ran only ${executeCalls} time(s) (recover() asked Stripe, the tool was NOT called a 2nd time) → Stripe has ${stripe.chargeCount} charge(s)`);
  console.log(`  recovered result: ${JSON.stringify(result)}`);
  executeCallsC = executeCalls;
  chargesC = stripe.chargeCount;
}

console.log('\n=== SUMMARY ===');
console.log('| scenario                                   | execute calls   | Stripe charge count   |');
console.log('|-------------------------------------------|-----------------|-----------------------|');
console.log(`| A) unprotected                             | ${executeCallsA}               | ${chargesA}                     |`);
console.log(`| B) GNL (idempotencyKey, approved retry)    | ${executeCallsB}               | ${chargesB}                     |`);
console.log(`| C) GNL (idempotencyKey + recover)          | ${executeCallsC}               | ${chargesC}                     |`);

const ok = chargesA === 2 && chargesB === 1 && chargesC === 1 && executeCallsC === 1;
console.log(ok
  ? '\n✅ The card was charged ONLY ONCE with GNL (scenarios B and C) — the unprotected scenario charged it twice (scenario A).'
  : '\n❌ UNEXPECTED RESULT');
if (!ok) process.exitCode = 1;
