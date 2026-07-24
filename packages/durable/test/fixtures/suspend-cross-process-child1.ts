// Child process 1 (run via tsx): calls runDurable with a require-approval tool.
// The guard holds it for approval → the run is suspended WITHOUT the tool running (interrupts is
// returned). The process does NOT crash via process.exit — it exits NORMALLY via suspend-run.ts's
// normal completion path (not a crash — suspend PERSISTENCE is being tested — see
// suspend-cross-process.test.ts's title).
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { runDurable } from '../../src/run.js';
import { SqliteStorage } from '../../src/sqlite-storage.js';
import type { Guard } from '../../src/guard.js';

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
    bumpCharges(); // must NEVER be called if suspended (proof: sePath stays 0)
    return { charged: amount };
  },
});

// Charges of 5000+ require human approval.
const guard: Guard = ({ toolName }) =>
  toolName === 'chargeCard' ? { action: 'require-approval', reason: 'large amount' } : { action: 'allow' };

const storage = new SqliteStorage(dbPath);
const res = await runDurable({
  runId,
  journal: storage.runs,
  model,
  tools: { chargeCard },
  guard,
  prompt: 'charge 5000',
  stopWhen: stepCountIs(6),
});
await storage.close();

if (res.interrupts.length !== 1 || res.interrupts[0]?.toolCallId !== 'call-charge') {
  console.error('unexpected result — interrupts:', JSON.stringify(res.interrupts));
  process.exit(2);
}
// NORMAL exit — the process did not crash, the run was deliberately left suspended.
process.exit(0);
