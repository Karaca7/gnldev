// Child process 2 (run via tsx, SEPARATE execution): opens a NEW SqliteStorage on the SAME
// SQLite file, and passes approvals DIRECTLY as a runDurable parameter (writing approvals to the
// journal is an area where another agent runs concurrently in run.ts — this test is INDEPENDENT
// of that, via the existing public API: approvals: {toolCallId: true}). The tool must run EXACTLY
// once (it never ran during suspend) — proven via the external counter file (sePath).
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { runDurable } from '../../src/run.js';
import { SqliteStorage } from '../../src/sqlite-storage.js';
import type { Guard } from '../../src/guard.js';
import { armFixtureWatchdog } from './watchdog.js';

armFixtureWatchdog(); // never outlive the test that spawned this — see watchdog.ts

const dbPath = process.argv[2]!;
const sePath = process.argv[3]!;
const runId = process.argv[4]!;

function bumpCharges(): void {
  const n = existsSync(sePath) ? Number(readFileSync(sePath, 'utf8')) || 0 : 0;
  writeFileSync(sePath, String(n + 1));
}

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
const model: any = {
  specificationVersion: 'v2',
  provider: 'mock',
  modelId: 'mock',
  supportedUrls: {},
  // step 0 (tool-call) is REPLAYED from the journal (this branch of doGenerate is never CALLED) —
  // only the new model step PRODUCED after approval (final text) is called live.
  doGenerate: async ({ prompt }: any) => {
    const done = (prompt ?? []).filter((m: any) => m.role === 'tool').length;
    if (done === 0) {
      return {
        content: [
          { type: 'tool-call', toolCallId: 'call-charge', toolName: 'chargeCard', input: JSON.stringify({ amount: 5000 }) },
        ],
        finishReason: 'tool-calls',
        usage,
        warnings: [],
      };
    }
    return { content: [{ type: 'text', text: 'Charged.' }], finishReason: 'stop', usage, warnings: [] };
  },
  doStream: async () => {
    throw new Error('no stream');
  },
};

const chargeCard = tool({
  description: 'charge',
  inputSchema: z.object({ amount: z.number() }),
  execute: async ({ amount }: { amount: number }) => {
    bumpCharges();
    return { charged: amount };
  },
});

const guard: Guard = ({ toolName }) =>
  toolName === 'chargeCard' ? { action: 'require-approval', reason: 'large amount' } : { action: 'allow' };

const storage = new SqliteStorage(dbPath);
const res = await runDurable({
  runId,
  journal: storage.runs,
  model,
  tools: { chargeCard },
  guard,
  approvals: { 'call-charge': true }, // resume: approval DIRECTLY via the parameter (independent of journal-approvals)
  prompt: 'charge 5000',
  stopWhen: stepCountIs(6),
});
await storage.close();

if (res.interrupts.length !== 0) {
  console.error('unexpected result — still suspended:', JSON.stringify(res.interrupts));
  process.exit(2);
}
// Single-line, prefixed result for the parent to parse from stdout.
console.log(`RESULT:${JSON.stringify({ text: res.text })}`);
process.exit(0);
