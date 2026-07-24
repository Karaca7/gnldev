// VAKA 2 — checkpoint-resend: a documented pattern where a tool call that runs 180s+ gets silently
// RESENT from a checkpoint after a reconnect/replay — the original invocation may already be in flight
// or already finished, but the orchestrator has no memory of that and re-issues the call: "2-3x
// redundant work and cost". Without a durable journal, a crash/reconnect boundary is invisible to the
// process that resumes — it just calls the tool again.
//
// GNL: `runDurable` with the SAME runId across the crash/resume boundary. The tool's result is written
// to the journal the moment it succeeds; on resume (same runId, journal) the exactly-once check at the
// top of durableTool returns the journaled output instead of re-running the tool.
//
// Adapted (as a runnable demo) from packages/durable/examples/no-double-charge.ts.
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { InMemoryJournal, runDurable } from '@gnl/durable';
import { printCase } from './report.js';

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

// Mock model: turn 1 → calls refundOrder. If `crash.active`, the NEXT model step (right after the tool
// result would be read back) throws — simulating the connection dropping mid-turn, exactly the window
// in which a checkpoint resend happens. Turn 2 (post-resume) → final text.
function mockModel(crash: { active: boolean }): any {
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'mock', supportedUrls: {},
    doGenerate: async ({ prompt }: any) => {
      const toolResultsSoFar = (prompt ?? []).filter((m: any) => m.role === 'tool').length;
      if (toolResultsSoFar === 0) {
        return {
          content: [{ type: 'tool-call', toolCallId: 'call-refund', toolName: 'refundOrder', input: JSON.stringify({ orderId: 'ord-42' }) }],
          finishReason: 'tool-calls' as const, usage, warnings: [] as any[],
        };
      }
      if (crash.active) throw new Error('CONNECTION DROPPED (simulates the 180s+ checkpoint-resend window)');
      return { content: [{ type: 'text', text: 'Refunded.' }], finishReason: 'stop' as const, usage, warnings: [] as any[] };
    },
    doStream: async () => { throw new Error('no stream'); },
  };
}

export async function runCheckpointResend() {
  // ── korumasız: no journal — the process resuming after "reconnect" has no memory of the first
  // attempt, so the orchestrator just calls the tool function again (this IS the checkpoint-resend bug). ──
  let unprotectedCalls = 0;
  const unprotectedRefund = async () => { unprotectedCalls++; return { refunded: true }; };
  await unprotectedRefund(); // original in-flight call
  await unprotectedRefund(); // checkpoint resend after reconnect

  // ── GNL ile: runDurable + journal, SAME runId spanning the crash/resume boundary ──
  let protectedCalls = 0;
  const refundOrder = tool({
    description: 'Refund an order',
    inputSchema: z.object({ orderId: z.string() }),
    execute: async ({ orderId }) => { protectedCalls++; return { refunded: true, orderId }; },
  });
  const journal = new InMemoryJournal();
  const crash = { active: true };
  const runArgs = { runId: 'refund-run-1', journal, tools: { refundOrder }, prompt: 'refund ord-42', stopWhen: stepCountIs(6) };
  try {
    await runDurable({ ...runArgs, model: mockModel(crash) });
  } catch {
    // simulated crash/disconnect right after the tool's result was journaled
  }
  crash.active = false;
  await runDurable({ ...runArgs, model: mockModel(crash) }); // "checkpoint resend": SAME runId, SAME journal

  return printCase({
    id: 'checkpoint-resend',
    title: '180s+ tool call, checkpoint\'ten crash sonrası sessizce yeniden gönderiliyor',
    unprotectedCalls,
    protectedCalls,
  });
}
