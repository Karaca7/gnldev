# stripe-idempotency

`durableTool` (packages/durable/src/durable-tool.ts) injects a stable `idempotencyKey` into every tool's
`execute(input, options)` call — `${runId}:${toolCallId}` by default. This example threads that key to a
**mock** Stripe client and shows the exactly-once guarantee extending **past the framework**, to the real
payment provider itself — the same way it would with the real Stripe SDK's `Idempotency-Key` header.

No real Stripe SDK, no network calls, no API key required.

## Run
```bash
cd ../.. && pnpm -r build   # build the packages first
cd examples/stripe-idempotency
pnpm install
pnpm demo
```

## Scenarios
- **A — unprotected**: no `@gnldev/durable`, the naive retry generates a DIFFERENT idempotency key on every
  attempt → Stripe CANNOT tell it's a retry → **2 charges**.
- **B — with GNL (approved retry, no `recover()`)**: after crash+resume, GNL allows the retry
  (`approvals`), `execute` REALLY does run a second time — but because the injected `idempotencyKey` is
  the SAME on both attempts, Stripe maps the second request to the same charge → **1 charge**.
- **C — with GNL + `recover()`**: the `tool.recover()` hook asks Stripe "was there already a charge
  with this idempotencyKey?" — `execute` **never runs a second time**, not even approval is needed →
  **1 charge**.

## Wiring up the real Stripe
```ts
// Real Stripe SDK — idempotencyKey goes in the `Idempotency-Key` HTTP header, NOT the request body:
import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const chargeCard = {
  execute: async ({ amount }: { amount: number }, options: { idempotencyKey: string }) =>
    stripe.charges.create({ amount, currency: 'usd' }, { idempotencyKey: options.idempotencyKey }),
};
```
`options.idempotencyKey` is injected directly by `durableTool` as shown above — no extra code
needed.
