// CASE 1 — duplicate-toolcall-ids: a documented failure pattern where the model calls the SAME tool,
// with the SAME arguments, 5 TIMES in a single turn, each time under a DIFFERENT toolCallId. A
// call-scoped exactly-once guard (keyed by toolCallId — every durable engine's default, including
// GNL's) is blind to this by construction: 5 different keys, 5 executions, 5 charges. GNL's opt-in
// `idempotency: 'args'` keys the journal by the tool's ARGUMENTS instead — a re-plan under a new
// toolCallId collapses onto the same journal record.
//
// This is adapted (as a runnable demo, not a test) from the proof test at
// packages/durable/test/args-idempotency.test.ts.
import { stepCountIs } from 'ai';
import { InMemoryJournal, runDurable } from '@gnl/durable';
import { printCase } from './report.js';

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

// Mock model: turn 1 → 5 tool-calls for 'charge', SAME args ({ amount: 20 }), 5 DIFFERENT toolCallIds
// (exactly the pattern this case documents). Turn 2 → final text.
function multiCallModel(): any {
  let turn = 0;
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'mock', supportedUrls: {},
    doGenerate: async () => {
      turn++;
      if (turn === 1) {
        return {
          content: Array.from({ length: 5 }, (_, i) => ({
            type: 'tool-call' as const,
            toolCallId: `call-${i + 1}`, // 5 DIFFERENT toolCallIds
            toolName: 'charge',
            input: JSON.stringify({ amount: 20 }), // SAME arguments
          })),
          finishReason: 'tool-calls' as const,
          usage,
          warnings: [] as any[],
        };
      }
      return { content: [{ type: 'text', text: 'done' }], finishReason: 'stop' as const, usage, warnings: [] as any[] };
    },
    doStream: async () => { throw new Error('no stream'); },
  };
}

export async function runDuplicateToolCallIds() {
  // ── unprotected: default idempotency mode ('call', keyed by toolCallId) — documents CURRENT/baseline behavior ──
  let unprotectedCalls = 0;
  const unprotectedTools = { charge: { execute: async () => { unprotectedCalls++; return { charged: 20, seq: unprotectedCalls }; } } };
  await runDurable({
    runId: 'dup-unprotected', journal: new InMemoryJournal(), model: multiCallModel(),
    tools: unprotectedTools as any, stopWhen: stepCountIs(6), prompt: 'charge $20',
  });

  // ── with GNL: idempotency: 'args' — journal keyed by (toolName, argsHash) instead of toolCallId ──
  let protectedCalls = 0;
  const protectedTools = {
    charge: { idempotency: 'args' as const, execute: async () => { protectedCalls++; return { charged: 20, seq: protectedCalls }; } },
  };
  await runDurable({
    runId: 'dup-gnl', journal: new InMemoryJournal(), model: multiCallModel(),
    tools: protectedTools as any, stopWhen: stepCountIs(6), prompt: 'charge $20',
  });

  return printCase({
    id: 'duplicate-toolcall-ids',
    title: 'model calls the same tool + same arguments 5 DIFFERENT toolCallIds in one turn',
    unprotectedCalls,
    protectedCalls,
  });
}
