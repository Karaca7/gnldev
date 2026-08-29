// Run: pnpm demo   (no API key needed — mock Stripe, no network calls)
//
// Shows that GNL's exactly-once guarantee extends BEYOND the framework, all the way to a real
// payment provider — via the `idempotencyKey` durable-tool.ts injects into every tool's `execute`
// options (see packages/durable/src/durable-tool.ts, `execOpts = { ...options, idempotencyKey }`).
//
// Three scenarios, same crash+resume shape (charge succeeds at the provider, then the process
// "crashes" before the result is durably recorded):
//   A) unprotected — no @gnldev/durable at all, naive retry with a FRESH key each attempt → Stripe sees
//                    two unrelated requests → 2 charges.
//   B) with GNL    — durableTool + approved retry, NO recover() hook. GNL allows the retry (approval
//                    was granted) so `execute` genuinely runs twice — but because the injected
//                    idempotencyKey is DETERMINISTIC (`${runId}:${toolCallId}`), Stripe itself collapses
//                    the second request onto the first charge. The provider is the backstop even when
//                    the framework's own retry gate lets a call through.
//   C) with GNL    — durableTool + a `recover()` hook (H9 ladder): asks Stripe "did this idempotencyKey
//      (bonus)       already succeed?" BEFORE retrying — `execute` doesn't even run a second time, no
//                    human approval needed.
import { scenarioUnprotected, scenarioApprovedRetry, scenarioRecover } from './scenarios.js';

function section(title: string): void {
  console.log(`\n— ${title} —`);
}

console.log('Provider-side exactly-once (mock Stripe) — crash+resume\n');
console.log('GNL injects a stable idempotencyKey into every tool execute() (durable-tool.ts). This demo');
console.log('threads it to a mock Stripe client that mirrors the real SDK\'s Idempotency-Key contract:');
console.log("  await stripe.charges.create({ amount, currency }, { idempotencyKey });  // real Stripe SDK\n");

// The scenarios live in scenarios.ts and are asserted by test/stripe-idempotency.test.ts. This file
// only prints them, so what CI checks and what a reader sees here cannot drift apart.
section('Scenario A: unprotected (no GNL)');
const a = await scenarioUnprotected();
console.log(`  execute ran ${a.executeCalls} times → Stripe recorded ${a.charges} charge(s)`);

section('Scenario B: with GNL (idempotencyKey injected, approved retry, no recover)');
const b = await scenarioApprovedRetry();
if (b.firstAttemptError) console.log(`  attempt 1: ${b.firstAttemptError}`);
console.log(`  execute ran ${b.executeCalls} times (GNL allowed the approved retry) → Stripe has ${b.charges} charge(s)`);
console.log(`  attempt 2 result: ${JSON.stringify(b.result)}`);

section('Scenario C (bonus): with GNL + recover() hook — automatic, no approval needed');
const c = await scenarioRecover();
if (c.firstAttemptError) console.log(`  attempt 1: ${c.firstAttemptError}`);
console.log(`  execute ran only ${c.executeCalls} time(s) (recover() asked Stripe, the tool was NOT called a 2nd time) → Stripe has ${c.charges} charge(s)`);
console.log(`  recovered result: ${JSON.stringify(c.result)}`);

console.log('\n=== SUMMARY ===');
console.log('| scenario                                   | execute calls   | Stripe charge count   |');
console.log('|-------------------------------------------|-----------------|-----------------------|');
console.log(`| A) unprotected                             | ${a.executeCalls}               | ${a.charges}                     |`);
console.log(`| B) GNL (idempotencyKey, approved retry)    | ${b.executeCalls}               | ${b.charges}                     |`);
console.log(`| C) GNL (idempotencyKey + recover)          | ${c.executeCalls}               | ${c.charges}                     |`);

const ok = a.charges === 2 && b.charges === 1 && c.charges === 1 && c.executeCalls === 1;
console.log(ok
  ? '\n✅ The card was charged ONLY ONCE with GNL (scenarios B and C) — the unprotected scenario charged it twice (scenario A).'
  : '\n❌ UNEXPECTED RESULT');
if (!ok) process.exitCode = 1;
