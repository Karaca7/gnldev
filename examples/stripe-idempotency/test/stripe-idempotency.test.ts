// Provider-side exactly-once, asserted instead of printed.
//
// This example is the README's only evidence for the strongest claim in the project: that the
// guarantee does not stop at the journal but reaches the PROVIDER, through the `idempotencyKey`
// `durable-tool.ts` injects into every tool's `execute` options. Until now nothing ran it —
// `pnpm demo` printed a table for a human, typecheck proved it compiles, and CI did neither. A
// regression in that injection would have left the cited proof silently wrong.
//
// No Stripe account and no network: `MockStripe` implements the same Idempotency-Key contract the
// real SDK does — a repeated key returns the FIRST charge instead of creating a second.
//
// The scenarios are the same functions `demo.ts` calls, so the printed table and these assertions
// cannot disagree.
import { describe, it, expect } from 'vitest';
import { scenarioUnprotected, scenarioApprovedRetry, scenarioRecover } from '../src/scenarios.js';

describe('the exactly-once guarantee reaches the payment provider', () => {
  // The control. Without a reproducing incident the other two prove nothing — they would just be
  // two ways of charging once on a code path that never double-charges.
  it('A) unprotected: a naive retry with a fresh key charges TWICE', async () => {
    const r = await scenarioUnprotected();
    expect(r.executeCalls).toBe(2);
    expect(r.charges, 'the unprotected path no longer reproduces the double charge').toBe(2);
  }, 30_000);

  // The interesting one: GNL's own retry gate is OPEN (the approval was granted), so `execute`
  // genuinely runs a second time. The charge still happens once because the injected key is
  // deterministic and the provider collapses the duplicate. This is the claim — the provider is the
  // backstop even when the framework lets a call through.
  it('B) approved retry: execute runs twice, the provider still records ONE charge', async () => {
    const r = await scenarioApprovedRetry();
    expect(r.executeCalls, 'the approved retry did not actually re-run the tool').toBe(2);
    expect(r.charges, 'the injected idempotencyKey stopped reaching the provider').toBe(1);
    expect(r.firstAttemptError, 'the first attempt was supposed to crash after the charge committed').toBeDefined();
  }, 30_000);

  // The strongest: `recover()` asks the provider whether the key already succeeded, so the tool is
  // never called again and no human approval is needed.
  it('C) recover(): the tool is never re-run, and there is still ONE charge', async () => {
    const r = await scenarioRecover();
    expect(r.executeCalls, 'recover() did not prevent the second execute').toBe(1);
    expect(r.charges).toBe(1);
    expect(r.result, 'recover() returned nothing to replay').toBeDefined();
  }, 30_000);
});
