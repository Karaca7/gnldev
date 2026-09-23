// Run:  npx tsx examples/no-double-charge.ts   (API key NOT REQUIRED — mock model)
//
// Shows: even if an agent crashes mid-turn, the payment tool does NOT run AGAIN on resume.
import { tool, stepCountIs, generateText } from 'ai';
import { z } from 'zod';
import { InMemoryJournal, runDurable } from '@gnldev/durable';

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

// Mock model that decides based on conversation state (stands in for a real LLM).
function mockModel(crash: { active: boolean }): any {
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'mock',
    supportedUrls: {},
    doGenerate: async ({ prompt }: any) => {
      const done = (prompt ?? []).filter((m: any) => m.role === 'tool').length;
      if (done === 0) {
        return {
          content: [
            { type: 'tool-call', toolCallId: 'call-charge', toolName: 'chargeCard', input: JSON.stringify({ amount: 20 }) },
          ],
          finishReason: 'tool-calls',
          usage,
          warnings: [],
        };
      }
      if (crash.active && done === 1) throw new Error('CRASH'); // crash AFTER the charge is RECORDED
      return { content: [{ type: 'text', text: 'Charged $20.' }], finishReason: 'stop', usage, warnings: [] };
    },
    doStream: async () => {
      throw new Error('no stream');
    },
  };
}

// The card tool, with its own counter. A FACTORY rather than a single instance, because the
// comparison below needs a second, independent arm — sharing one counter would make the two runs
// read as one.
function makeChargeCard(label: string) {
  const state = { charges: 0 };
  const chargeCard = tool({
    description: 'Charge the customer\'s card',
    inputSchema: z.object({ amount: z.number() }),
    execute: async ({ amount }) => {
      state.charges++;
      console.log(`  💳 chargeCard ran (${label} total: ${state.charges})`);
      return { charged: amount };
    },
  });
  return { chargeCard, state };
}

const { chargeCard, state: gnlState } = makeChargeCard('GNL');

const journal = new InMemoryJournal();
const crash = { active: true };

console.log('— Run 1 (will crash mid-turn) —');
try {
  await runDurable({ runId: 'order-1', journal, model: mockModel(crash), tools: { chargeCard }, prompt: 'charge $20', stopWhen: stepCountIs(6) });
} catch (e) {
  console.log('  💥 crashed:', (e as Error).message);
}
console.log(`  → charge count: ${gnlState.charges}\n`);

crash.active = false;
console.log('— Resume (call again with the same runId) —');
const res = await runDurable({ runId: 'order-1', journal, model: mockModel(crash), tools: { chargeCard }, prompt: 'charge $20', stopWhen: stepCountIs(6) });
console.log(`  → charge count: ${gnlState.charges}  ${gnlState.charges === 1 ? '✅ EXACTLY 1 TIME (exactly-once)' : '❌ ERROR'}`);
console.log('  → final:', res.text);

// ── The comparison, RUN rather than asserted ────────────────────────────────────────────────────
//
// This line used to read: "if the same scenario ran with plain `generateText`, the card would be
// charged TWICE." True, as it happens — but nothing here had measured it, and a proof that asks to
// be taken on faith for its most important sentence is not a proof. The baseline now runs: same mock
// model, same crash, same retry, no journal. The number below is counted, not claimed.
console.log('\n— Same scenario WITHOUT GNL (plain generateText, no journal) —');
const { chargeCard: plainCard, state: plainState } = makeChargeCard('plain');
const plainCrash = { active: true };
const plainArgs = { model: mockModel(plainCrash), tools: { chargeCard: plainCard }, prompt: 'charge $20', stopWhen: stepCountIs(6) };
try {
  await generateText(plainArgs as any);
} catch (e) {
  console.log('  💥 crashed:', (e as Error).message);
}
console.log(`  → charge count: ${plainState.charges}`);
plainCrash.active = false;
console.log('  (retry — nothing remembers the first attempt)');
await generateText({ ...plainArgs, model: mockModel(plainCrash) } as any);
console.log(`  → charge count: ${plainState.charges}\n`);

const ok = gnlState.charges === 1 && plainState.charges > gnlState.charges;
console.log(`RESULT  plain generateText: ${plainState.charges} charge(s)  ·  GNL: ${gnlState.charges} charge(s)  ${ok ? '✅' : '❌ UNEXPECTED'}`);
// The exit code carries the verdict, because a proof that cannot fail is not one. `ok` used to be
// computed, printed and then dropped — this file could have reported ❌ and still exited 0, so no CI
// job could have caught the day it stopped holding. That is the same defect the file exists to
// demonstrate, one level up.
if (!ok) process.exit(1);
