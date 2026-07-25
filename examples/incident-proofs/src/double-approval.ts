// CASE 3 — double-approval: a documented pattern where, after the user approves a permission prompt,
// the underlying tool runs TWICE — "unintended side effects... non-idempotent operations". Root cause
// is orchestration, not crash/replay: the approval EVENT itself gets processed more than once
// (double-click, retried webhook/IPC message, etc.) and nothing remembers that the approved call
// already ran.
//
// GNL: the tool call is suspended behind `guard: () => ({ action: 'require-approval' })`; approving it
// resumes the run via `resumeRun`. If the approval event is delivered/processed a second time,
// `resumeRun` is simply called again — the exactly-once check at the top of durableTool finds a
// 'succeeded' record for that toolCallId in the journal and returns it WITHOUT re-executing the tool.
//
// Adapted (as a runnable demo) from packages/durable/test/resume-run.test.ts.
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { InMemoryJournal, runDurable, resumeRun } from '@gnldev/durable';
import type { Guard } from '@gnldev/durable';
import { printCase } from './report.js';

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

// Mock model: turn 1 → calls runShellCommand (a risky op requiring approval), SAME toolCallId every
// time (deterministic re-planning, exactly as the AI SDK replays a conversation). Once a tool result is
// present in the (reconstructed) prompt → final text.
function makeModel(): any {
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'mock', supportedUrls: {},
    doGenerate: async ({ prompt }: any) => {
      const toolResultsSoFar = (prompt ?? []).filter((m: any) => m.role === 'tool').length;
      if (toolResultsSoFar === 0) {
        return {
          content: [{ type: 'tool-call', toolCallId: 'call-cleanup', toolName: 'runShellCommand', input: JSON.stringify({ cmd: 'rm -rf /tmp/cache' }) }],
          finishReason: 'tool-calls' as const, usage, warnings: [] as any[],
        };
      }
      return { content: [{ type: 'text', text: 'Cleaned up.' }], finishReason: 'stop' as const, usage, warnings: [] as any[] };
    },
    doStream: async () => { throw new Error('no stream'); },
  };
}

const guard: Guard = ({ toolName }) =>
  toolName === 'runShellCommand' ? { action: 'require-approval', reason: 'destructive command' } : { action: 'allow' };

export async function runDoubleApproval() {
  // ── unprotected: the approval event is processed twice — nothing remembers the first execution, so the
  // tool just runs again (this IS the double-approval bug). ──
  let unprotectedCalls = 0;
  const unprotectedCleanup = async () => { unprotectedCalls++; return { ok: true }; };
  await unprotectedCleanup(); // ran after the 1st delivery of the approval event
  await unprotectedCleanup(); // ran again after the 2nd (duplicate) delivery

  // ── with GNL: guard suspends the call; resumeRun (called TWICE — simulating the duplicate approval
  // event) only executes the tool on the first call, the 2nd returns the journaled result. ──
  let protectedCalls = 0;
  const runShellCommand = tool({
    description: 'Run a shell command',
    inputSchema: z.object({ cmd: z.string() }),
    execute: async ({ cmd }) => { protectedCalls++; return { ok: true, cmd }; },
  });
  const journal = new InMemoryJournal();
  const resumeArgs = { journal, model: makeModel(), tools: { runShellCommand }, guard, approvals: { 'call-cleanup': true }, stopWhen: stepCountIs(6) };

  const r1 = await runDurable({ runId: 'shell-run-1', journal, model: makeModel(), tools: { runShellCommand }, guard, prompt: 'clean tmp cache', stopWhen: stepCountIs(6) });
  console.log(`  (suspended: ${r1.interrupts.length} approval pending — approving 'run')`);
  await resumeRun('shell-run-1', resumeArgs); // 1st delivery of the approval event → tool actually runs
  await resumeRun('shell-run-1', resumeArgs); // 2nd (duplicate) delivery → journal already has 'succeeded'

  return printCase({
    id: 'double-approval',
    title: 'tool runs twice after approval (the approval event is processed twice)',
    unprotectedCalls,
    protectedCalls,
  });
}
