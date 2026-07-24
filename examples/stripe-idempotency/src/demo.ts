// Run: pnpm demo   (no API key needed — mock Stripe, no network calls)
//
// A3: shows that GNL's exactly-once guarantee extends BEYOND the framework, all the way to a real
// payment provider — via the `idempotencyKey` durable-tool.ts injects into every tool's `execute`
// options (see packages/durable/src/durable-tool.ts, `execOpts = { ...options, idempotencyKey }`).
//
// Three scenarios, same crash+resume shape (charge succeeds at the provider, then the process
// "crashes" before the result is durably recorded):
//   A) korumasız  — no @gnl/durable at all, naive retry with a FRESH key each attempt → Stripe sees
//                   two unrelated requests → 2 charges.
//   B) GNL ile    — durableTool + approved retry, NO recover() hook. GNL allows the retry (approval
//                   was granted) so `execute` genuinely runs twice — but because the injected
//                   idempotencyKey is DETERMINISTIC (`${runId}:${toolCallId}`), Stripe itself collapses
//                   the second request onto the first charge. The provider is the backstop even when
//                   the framework's own retry gate lets a call through.
//   C) GNL ile    — durableTool + a `recover()` hook (H9 ladder): asks Stripe "did this idempotencyKey
//      (bonus)      already succeed?" BEFORE retrying — `execute` doesn't even run a second time, no
//                   human approval needed.
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

// ── Senaryo A: korumasız (GNL yok) — naif retry, HER denemede FARKLI idempotencyKey ──
let chargesA: number, executeCallsA: number;
{
  section('Senaryo A: korumasız (GNL yok)');
  const stripe = new MockStripe();
  let executeCalls = 0;
  const chargeNaive = async (amount: number) => {
    executeCalls++;
    // no stable key travels to the provider on retry → Stripe can't tell this is the SAME request
    return stripe.chargesCreate({ amount, currency: 'usd' }, { idempotencyKey: `naive-${executeCalls}-${Math.random().toString(36).slice(2)}` });
  };
  await chargeNaive(2000); // original attempt (succeeds at Stripe)
  await chargeNaive(2000); // crash+resume → naive retry, NEW key
  console.log(`  execute ${executeCalls} kez çalıştı → Stripe'ta ${stripe.chargeCount} charge oluştu`);
  executeCallsA = executeCalls;
  chargesA = stripe.chargeCount;
}

// ── Senaryo B: GNL ile — crash Stripe'ı commit ettikten SONRA, journal'a yazmadan ÖNCE; onaylı retry, recover YOK ──
let chargesB: number, executeCallsB: number;
{
  section('Senaryo B: GNL ile (idempotencyKey enjekte edilir, onaylı retry, recover YOK)');
  const stripe = new MockStripe();
  let executeCalls = 0;
  const chargeCard = {
    sideEffect: true, // explicit — a payment IS a side effect (also the default per H7)
    execute: async (input: { amount: number }, options: any) => {
      executeCalls++;
      // Real Stripe SDK: stripe.charges.create({ amount, currency: 'usd' }, { idempotencyKey: options.idempotencyKey });
      const charge = await stripe.chargesCreate({ amount: input.amount, currency: 'usd' }, { idempotencyKey: options.idempotencyKey });
      if (executeCalls === 1) throw new Error("CRASH: Stripe charge'ı commit etti ama cevap sürece ULAŞMADAN bağlantı koptu");
      return charge;
    },
  };
  const journal = new InMemoryJournal();
  const ctx: DurableCtx = { journal, runId: 'order-77', approvals: { 'call-charge': true } };
  const dt = durableTool(chargeCard as any, ctx, 'chargeCard');

  try {
    await dt.execute!({ amount: 2000 }, { toolCallId: 'call-charge' }); // attempt 1: crashes AFTER Stripe commits
  } catch (e: any) {
    console.log(`  1. deneme: ${e.message}`);
  }
  const result = await dt.execute!({ amount: 2000 }, { toolCallId: 'call-charge' }); // approved retry — execute RUNS AGAIN
  console.log(`  execute ${executeCalls} kez çalıştı (GNL onaylı retry'a izin verdi) → Stripe'ta ${stripe.chargeCount} charge var`);
  console.log(`  2. denemenin sonucu: ${JSON.stringify(result)}`);
  executeCallsB = executeCalls;
  chargesB = stripe.chargeCount;
}

// ── Senaryo C (bonus): GNL ile + recover() — execute HİÇ tekrar çalışmaz, onay GEREKMEZ ──
let chargesC: number, executeCallsC: number;
{
  section('Senaryo C (bonus): GNL ile + recover() hook — otomatik, onay GEREKMEZ');
  const stripe = new MockStripe();
  let executeCalls = 0;
  const chargeCard = {
    sideEffect: true,
    execute: async (input: { amount: number }, options: any) => {
      executeCalls++;
      const charge = await stripe.chargesCreate({ amount: input.amount, currency: 'usd' }, { idempotencyKey: options.idempotencyKey });
      if (executeCalls === 1) throw new Error("CRASH: Stripe charge'ı commit etti ama cevap sürece ULAŞMADAN bağlantı koptu");
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
    console.log(`  1. deneme: ${e.message}`);
  }
  const result = await dt.execute!({ amount: 2000 }, { toolCallId: 'call-charge' }); // recover() answers, NO approval needed
  console.log(`  execute yalnızca ${executeCalls} kez çalıştı (recover() Stripe'a sordu, tool ikinci kez ÇAĞRILMADI) → Stripe'ta ${stripe.chargeCount} charge var`);
  console.log(`  recover edilen sonuç: ${JSON.stringify(result)}`);
  executeCallsC = executeCalls;
  chargesC = stripe.chargeCount;
}

console.log('\n=== ÖZET ===');
console.log('| senaryo                                  | execute çağrısı | Stripe charge sayısı |');
console.log('|-------------------------------------------|-----------------|-----------------------|');
console.log(`| A) korumasız                               | ${executeCallsA}               | ${chargesA}                     |`);
console.log(`| B) GNL (idempotencyKey, onaylı retry)      | ${executeCallsB}               | ${chargesB}                     |`);
console.log(`| C) GNL (idempotencyKey + recover)          | ${executeCallsC}               | ${chargesC}                     |`);

const ok = chargesA === 2 && chargesB === 1 && chargesC === 1 && executeCallsC === 1;
console.log(ok
  ? '\n✅ Kart GNL ile YALNIZCA 1 KEZ çekildi (senaryo B ve C) — korumasız senaryoda 2 kez çekildi (senaryo A).'
  : '\n❌ BEKLENMEYEN SONUÇ');
if (!ok) process.exitCode = 1;
