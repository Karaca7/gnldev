// P2-cancel (AUDIT-R2 Dalga-2): durable cross-worker AGENT-run cancel — the agent twin of
// @gnl/workflow's cancelWorkflowRun. Mirrors compensation.test.ts's terminal-refusal test style.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { tool } from 'ai';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { cancelAgentRun, agentRunCanceled, RunCanceledError } from '../src/cancel.js';
import { reconstructState } from '../src/time-travel.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

/** State-driven agent mock: 0 tool results → call `toolName`; afterwards → final text. */
const toolThenText = (toolName: string) =>
  createMockModel(async ({ prompt }: any) =>
    countToolResults(prompt) === 0 ? toolCallResult(toolName, 'call-1', {}) : finalTextResult('done'));
const textOnly = (text: string) => createMockModel(async () => finalTextResult(text));

describe('cancel.ts — durable agent-run cancel', () => {
  it('a canceled run refuses to (re)start/resume forever (terminal, like compensation)', async () => {
    const journal = new InMemoryJournal();
    await cancelAgentRun(journal, 'r-c1', { reason: 'operator' });
    await expect(
      runDurable({ runId: 'r-c1', journal, model: textOnly('hi') as any, prompt: 'x' }),
    ).rejects.toThrow(RunCanceledError);
    // idempotent re-cancel keeps the FIRST record (original decision is the audit-relevant one)
    const first = await agentRunCanceled(journal, 'r-c1');
    await cancelAgentRun(journal, 'r-c1', { reason: 'second-actor' });
    expect(await agentRunCanceled(journal, 'r-c1')).toEqual(first);
  });

  it('CROSS-WORKER: the flag written mid-run (by another actor, between model steps) stops the run at its next FRESH model step', async () => {
    const journal = new InMemoryJournal();
    // A tool whose execute simulates "another worker/operator cancels while this worker is mid-run":
    // the cancel flag lands AFTER model step 0 completed, BEFORE the follow-up model step starts.
    const tools = {
      doWork: tool({
        description: 'work',
        inputSchema: z.object({}),
        execute: async () => {
          await cancelAgentRun(journal, 'r-c2', { reason: 'mid-run cancel' });
          return { ok: true };
        },
      }),
    };
    await expect(
      runDurable({ runId: 'r-c2', journal, model: toolThenText('doWork') as any, tools, prompt: 'go' }),
    ).rejects.toThrow(RunCanceledError);
    // The completed prefix is INTACT and replayable — cancel stops NEW spend, never deletes the record.
    const entries = await journal.readRun('r-c2');
    expect(entries.length).toBeGreaterThan(0); // model step 0 + tool record survived
    const st = reconstructState(entries, entries.length);
    expect(st.messages.length).toBeGreaterThan(0); // time-travel over the prefix still works
    // And the refusal is durable: a later resume attempt fails at the ENTRY gate.
    await expect(
      runDurable({ runId: 'r-c2', journal, model: toolThenText('doWork') as any, tools, prompt: 'go' }),
    ).rejects.toThrow(RunCanceledError);
  });

  it('an UNRELATED run on the same journal is unaffected', async () => {
    const journal = new InMemoryJournal();
    await cancelAgentRun(journal, 'r-other');
    const r = await runDurable({ runId: 'r-free', journal, model: textOnly('done') as any, prompt: 'x' });
    expect((r as any).text).toBe('done');
  });
});
