// Measure the durable layer's overhead: plain generateText vs runDurable (InMemory/Sqlite) vs replay.
// The numeric answer to the question "how much does the correctness guarantee cost?"
import { generateText, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import { runDurable, InMemoryJournal } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { agentModel } from './mock.js';

const toolset = () => ({
  charge: tool({ description: 'Charge an order', inputSchema: z.object({ amt: z.number() }), execute: async () => ({ ok: true }) }),
});
const model = () => agentModel('charge', 'c', { amt: 1 }, 'done'); // 2 model steps + 1 tool

async function timeIt(label: string, n: number, fn: (i: number) => Promise<any>): Promise<number> {
  for (let i = 0; i < 20; i++) await fn(i); // warmup
  const t0 = performance.now();
  for (let i = 0; i < n; i++) await fn(i);
  const per = (performance.now() - t0) / n;
  console.log(`  ${label.padEnd(32)} ${per.toFixed(3)} ms/op   ${(1000 / per).toFixed(0).padStart(6)} ops/s`);
  return per;
}

console.log('\n=== gnl durable overhead (mock model, 2 steps + 1 tool) ===\n');

const N = 2000;
const base = await timeIt('plain generateText', N, () => generateText({ model: model(), tools: toolset(), prompt: 'x', stopWhen: stepCountIs(6) }));
const mem = await timeIt('runDurable (InMemory, fresh)', N, (i) => runDurable({ runId: `b${i}`, journal: new InMemoryJournal(), model: model(), tools: toolset(), prompt: 'x', stopWhen: stepCountIs(6) }));

const shared = new InMemoryJournal();
await runDurable({ runId: 'r', journal: shared, model: model(), tools: toolset(), prompt: 'x', stopWhen: stepCountIs(6) });
const replay = await timeIt('runDurable resume/replay', N, () => runDurable({ runId: 'r', journal: shared, model: model(), tools: toolset(), prompt: 'x', stopWhen: stepCountIs(6) }));

const sqb = new SqliteStorage(':memory:');
const sq = sqb.runs;
const sqlite = await timeIt('runDurable (Sqlite :memory:)', 500, (i) => runDurable({ runId: `s${i}`, journal: sq, model: model(), tools: toolset(), prompt: 'x', stopWhen: stepCountIs(6) }));
await sqb.close();

const pct = (x: number) => `${(((x / base) - 1) * 100).toFixed(0)}%`;
console.log(`\n  Overhead (InMemory):  +${(mem - base).toFixed(3)} ms/op  (${pct(mem)})`);
console.log(`  Overhead (Sqlite):    +${(sqlite - base).toFixed(3)} ms/op  (${pct(sqlite)})`);
console.log(`  Replay (no model call): ${replay.toFixed(3)} ms/op  → cheap resume after a crash`);
console.log('\n  Note: with a real LLM call (hundreds of ms) this overhead is practically INVISIBLE.\n');
