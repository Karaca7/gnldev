// A side-effecting durable tool that showcases GNL's edge: LLM-aware idempotency.
//
// `idempotency: 'args'` keys the journal by the tool's ARGUMENTS instead of the AI SDK's
// per-call `toolCallId`. So even when the model re-plans the same call under a brand-new
// `toolCallId` — the dominant real-world double-charge case (a documented AI SDK pattern) — the tool
// runs exactly once and every duplicate gets the journaled result. `idempotencyKey` narrows
// the dedup to a logical key (here: `orderId`), so two calls with the same orderId but
// otherwise different args still collapse to one execution.

// A stand-in "ledger" so the demo/e2e can observe how many times the side effect really ran.
// In a real app this would be a DB write / a Stripe charge / an email send.
export const ledger: { charges: { orderId: string; amount: number }[] } = { charges: [] };

export const chargeOrder = {
  description: 'Charge a customer order (has a real side effect — must run exactly once).',
  idempotency: 'args' as const,
  idempotencyKey: (args: any) => String(args.orderId),
  // Uncomment to dedup across runs too (retried jobs / re-triggered agents):
  // idempotencyWindow: 'cross-run' as const,
  execute: async ({ orderId, amount }: { orderId: string; amount: number }) => {
    ledger.charges.push({ orderId, amount });
    return { charged: amount, orderId, receipt: `rcpt_${orderId}` };
  },
};
