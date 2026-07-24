// TASK (intersection verification): the SAME real process-kill pattern as crash-run.ts, with the
// difference that: (1) `lock` (M4.2 fencing) is passed to runDurable — process.exit NEVER releases
//     the lock (finally never runs) → the lock stays 'alive' (owner=child) in the journal; the parent
//     must take it over via post-TTL fencing. (2) tool sideEffect:true + maxRetries — the TASK 4.3
//     fields are also set so they get exercised in a real crash/resume flow (not just claim/lock)
//     (in this scenario the tool succeeds on the FIRST attempt, so the retry-block path is NOT
//     triggered; this only verifies the fields work fine in a real runDurable flow).
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { runDurable } from '../../src/run.js';
import { SqliteStorage } from '../../src/sqlite-storage.js';

const dbPath = process.argv[2]!;
const sePath = process.argv[3]!;
const runId = process.argv[4]!;
const lockTtlMs = Number(process.argv[5]!);

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
    // Hard-crash AFTER the tool is SUCCESSFULLY journaled — the lock is NEVER released (finally never runs).
    process.exit(1);
  },
  doStream: async () => {
    throw new Error('no stream');
  },
};

const chargeCard = tool({
  description: 'charge',
  inputSchema: z.object({ amount: z.number() }),
  sideEffect: true,
  maxRetries: 5,
  execute: async ({ amount }: { amount: number }) => {
    bumpCharges();
    return { charged: amount };
  },
} as any);

const storage = new SqliteStorage(dbPath);
await runDurable({
  runId,
  journal: storage.runs,
  model,
  tools: { chargeCard },
  prompt: 'charge',
  stopWhen: stepCountIs(6),
  lock: { owner: 'child', ttlMs: lockTtlMs },
} as any);
await storage.close();
