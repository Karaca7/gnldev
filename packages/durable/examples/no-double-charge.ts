// Run:  npx tsx examples/no-double-charge.ts   (API key NOT REQUIRED — mock model)
//
// Shows: even if an agent crashes mid-turn, the payment tool does NOT run AGAIN on resume.
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';

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

let charges = 0;
const chargeCard = tool({
  description: 'Charge the customer\'s card',
  inputSchema: z.object({ amount: z.number() }),
  execute: async ({ amount }) => {
    charges++;
    console.log(`  💳 chargeCard ran (total calls: ${charges})`);
    return { charged: amount };
  },
});

const journal = new InMemoryJournal();
const crash = { active: true };

console.log('— Run 1 (will crash mid-turn) —');
try {
  await runDurable({ runId: 'order-1', journal, model: mockModel(crash), tools: { chargeCard }, prompt: 'charge $20', stopWhen: stepCountIs(6) });
} catch (e) {
  console.log('  💥 crashed:', (e as Error).message);
}
console.log(`  → charge count: ${charges}\n`);

crash.active = false;
console.log('— Resume (call again with the same runId) —');
const res = await runDurable({ runId: 'order-1', journal, model: mockModel(crash), tools: { chargeCard }, prompt: 'charge $20', stopWhen: stepCountIs(6) });
console.log(`  → charge count: ${charges}  ${charges === 1 ? '✅ EXACTLY 1 TIME (exactly-once)' : '❌ ERROR'}`);
console.log('  → final:', res.text);

console.log('\nNote: if the same scenario ran with plain `generateText`, the card would be charged TWICE.');
