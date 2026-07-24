// Mock Stripe client. Mirrors the REAL Stripe SDK's idempotency contract:
//
//   await stripe.charges.create({ amount, currency }, { idempotencyKey: key });
//
// In the real SDK, `idempotencyKey` travels in the `Idempotency-Key` HTTP header (not the request
// body). Stripe stores the (key → response) pair for ~24h server-side: replaying a request with the
// SAME key returns the ORIGINAL response instead of creating a new charge. That is the exactly-once
// guarantee this mock reproduces — the same behavior a real Stripe integration would get for free once
// GNL's injected `options.idempotencyKey` (see packages/durable/src/durable-tool.ts) is threaded
// through to `stripe.charges.create(params, { idempotencyKey })`.
//
// This is a MOCK — no real Stripe SDK/network calls. No API key is needed to run this example.
export interface StripeCharge {
  id: string;
  amount: number;
  currency: string;
  idempotencyKey: string;
}

export class MockStripe {
  private byKey = new Map<string, StripeCharge>();
  private seq = 0;

  /** Real Stripe: `stripe.charges.create({ amount, currency }, { idempotencyKey })`. */
  async chargesCreate(params: { amount: number; currency: string }, opts: { idempotencyKey: string }): Promise<StripeCharge> {
    const existing = this.byKey.get(opts.idempotencyKey);
    if (existing) return existing; // SAME key → SAME charge returned, NO new charge created
    this.seq++;
    const charge: StripeCharge = { id: `ch_${this.seq}`, amount: params.amount, currency: params.currency, idempotencyKey: opts.idempotencyKey };
    this.byKey.set(opts.idempotencyKey, charge);
    return charge;
  }

  /**
   * Not a literal Stripe API method (real integrations usually keep their own orderId→chargeId
   * mapping for this) — models a `recover()` hook asking the provider "did this already happen?"
   * purely from the idempotency key, which real Stripe supports via the Idempotency-Key lookup.
   */
  async findByIdempotencyKey(key: string): Promise<StripeCharge | undefined> {
    return this.byKey.get(key);
  }

  get chargeCount(): number {
    return this.byKey.size;
  }
}
