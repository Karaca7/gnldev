// AI SDK drop-in idempotency — `withIdempotency` WITHOUT runDurable.
//
// This is a PLAIN Vercel AI SDK loop: real `generateText` + a `tools` map. No runDurable, no
// streamDurable — the developer keeps their own loop. The ONLY addition is wrapping the tool map in
// `withIdempotency(tools, { journal })`, which makes a side effect run exactly ONCE per argument set,
// even when the model re-plans the same call under a fresh toolCallId (a documented AI SDK pattern) or
// the whole run is retried (cross-run window, the default).
//
// No API key needed: the model is a mock LanguageModelV2 that scripts the tool calls.
// Run:  pnpm --filter @gnl/showcase exec tsx src/ai-sdk-idempotency.ts
import { generateText, stepCountIs } from 'ai';
import { InMemoryJournal, withIdempotency } from '@gnl/durable';

// ── The side-effectful tool: charge a card. A real one would hit Stripe; here it just counts. ──
let charges = 0;
const chargeCard = {
  description: 'Charge the customer card for an order.',
  execute: async (args: { orderId: string; amount: number }) => {
    charges++;
    console.log(`  [side effect] chargeCard EXECUTED for ${args.orderId} ($${args.amount}) — total charges so far: ${charges}`);
    return { ok: true, orderId: args.orderId, amount: args.amount };
  },
};

// ── A shared journal: dedup persists across BOTH runs below (cross-run window is the default). ──
const journal = new InMemoryJournal();

// ── The drop-in. Plain tools in → idempotent tools out. Same shape, same call sites. ──
const tools = withIdempotency(
  { chargeCard },
  { journal }, // window defaults to 'cross-run' → same orderId charges once across every run
);

// ── A mock model. Turn 1 emits the SAME charge THREE times with DIFFERENT toolCallIds (the
//    documented pattern — a model calling the same tool repeatedly in one turn). Turn 2 finishes. ──
function scriptedModel(): any {
  let turn = 0;
  const usage = { inputTokens: 8, outputTokens: 4, totalTokens: 12 };
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'mock-idempotency-demo',
    supportedUrls: {},
    doStream: async () => { throw new Error('mock: doStream not used'); },
    doGenerate: async () => {
      turn++;
      if (turn === 1) {
        return {
          content: [1, 2, 3].map((i) => ({
            type: 'tool-call' as const,
            toolCallId: `call-${i}`, // THREE different ids…
            toolName: 'chargeCard',
            input: JSON.stringify({ orderId: 'ORD-42', amount: 999 }), // …SAME arguments
          })),
          finishReason: 'tool-calls' as const,
          usage,
          warnings: [] as any[],
        };
      }
      return { content: [{ type: 'text' as const, text: 'Order ORD-42 charged.' }], finishReason: 'stop' as const, usage, warnings: [] as any[] };
    },
  };
}

async function runOnce(label: string) {
  console.log(`\n${label}: plain generateText loop (no runDurable) …`);
  const res = await generateText({
    model: scriptedModel(),
    tools,
    prompt: 'Charge order ORD-42.',
    stopWhen: stepCountIs(4),
  });
  console.log(`  model said: "${res.text}"`);
}

async function main() {
  // Run 1: the model fires the charge 3× in one turn (different toolCallIds, same args).
  await runOnce('RUN 1');
  // Run 2: a full RETRY of the same job — a brand-new generateText loop over the SAME journal.
  await runOnce('RUN 2 (retry of the same job)');

  console.log(`\n──────────────────────────────────────────`);
  console.log(`Total chargeCard side effects: ${charges}`);
  if (charges === 1) {
    console.log(`RESULT: charged once ✔  (3 in-turn duplicates + a full run retry → a single charge)`);
  } else {
    console.log(`RESULT: UNEXPECTED — expected exactly 1 charge, got ${charges}`);
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
