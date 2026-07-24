// Child process (run via tsx): starts run1, and AFTER the charge is RECORDED, hard-crashes
// with process.exit(1). The parent resumes with the same SQLite file and verifies the charge stayed at 1.
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { runDurable } from '../../src/run.js';
import { SqliteStorage } from '../../src/sqlite-storage.js';

const dbPath = process.argv[2]!;
const sePath = process.argv[3]!;

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
          {
            type: 'tool-call',
            toolCallId: 'call-charge',
            toolName: 'chargeCard',
            input: JSON.stringify({ amount: 20 }),
          },
        ],
        finishReason: 'tool-calls',
        usage,
        warnings: [],
      };
    }
    process.exit(1); // hard-crash AFTER the charge is RECORDED (process kill)
  },
  doStream: async () => {
    throw new Error('no stream');
  },
};

const chargeCard = tool({
  description: 'charge',
  inputSchema: z.object({ amount: z.number() }),
  execute: async ({ amount }) => {
    bumpCharges();
    return { charged: amount };
  },
});

const storage = new SqliteStorage(dbPath);
await runDurable({
  runId: 'order-kill',
  journal: storage.runs,
  model,
  tools: { chargeCard },
  prompt: 'charge',
  stopWhen: stepCountIs(6),
});
await storage.close();
