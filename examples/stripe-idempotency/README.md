# stripe-idempotency

`durableTool` (packages/durable/src/durable-tool.ts) injects a stable `idempotencyKey` into every tool's
`execute(input, options)` call — `${runId}:${toolCallId}` by default. This example threads that key to a
**mock** Stripe client and shows the exactly-once guarantee extending **past the framework**, to the real
payment provider itself — the same way it would with the real Stripe SDK's `Idempotency-Key` header.

No real Stripe SDK, no network calls, no API key required.

## Çalıştır
```bash
cd ../.. && pnpm -r build   # önce paketleri derle
cd examples/stripe-idempotency
pnpm install
pnpm demo
```

## Senaryolar
- **A — korumasız**: `@gnl/durable` yok, naif retry her denemede FARKLI bir idempotency key üretiyor →
  Stripe bunun bir retry olduğunu ANLAYAMIYOR → **2 charge**.
- **B — GNL ile (onaylı retry, `recover()` yok)**: crash+resume sonrası GNL retry'a izin veriyor
  (`approvals`), `execute` GERÇEKTEN ikinci kez çalışıyor — ama enjekte edilen `idempotencyKey` her iki
  denemede de AYNI olduğu için Stripe ikinci isteği aynı charge'a eşliyor → **1 charge**.
- **C — GNL ile + `recover()`**: `tool.recover()` hook'u Stripe'a "bu idempotencyKey ile daha önce charge
  oldu mu?" diye soruyor — `execute` **hiç ikinci kez çalışmıyor**, onay bile gerekmiyor → **1 charge**.

## Gerçek Stripe'a bağlamak
```ts
// Gerçek Stripe SDK — idempotencyKey İSTEK GÖVDESİNDE DEĞİL, `Idempotency-Key` HTTP header'ında gider:
import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const chargeCard = {
  execute: async ({ amount }: { amount: number }, options: { idempotencyKey: string }) =>
    stripe.charges.create({ amount, currency: 'usd' }, { idempotencyKey: options.idempotencyKey }),
};
```
`options.idempotencyKey` yukarıdaki gibi doğrudan `durableTool` tarafından enjekte edilir — ekstra kod
gerekmez.
