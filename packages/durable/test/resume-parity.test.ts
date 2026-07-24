// AUDIT B (forward-drop parity): resumeRun / studio-embed resume used to forward only a SUBSET of the
// protection set that runDurable enforces — the same bug shape as the fixed RunOptions.lock drop. The
// most dangerous instance: tool-result PROCESSORS (prompt-injection redaction/flagging) did not run for
// any tool executed during a resume, so an operator approves the one suspended call and its output is
// journaled UNSCANNED. This suite pins run==resume parity.
import { describe, it, expect } from 'vitest';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable, resumeRun } from '../src/run.js';
import { RunLimitExceededError } from '../src/limits.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

describe('resume parity (audit B)', () => {
  it('B1: tool-result processors run on the APPROVED call during resume (redaction not dropped)', async () => {
    const journal = new InMemoryJournal();
    const sends: string[] = [];
    const sendMoney = tool({
      description: 'send money (side effect)',
      inputSchema: z.object({ iban: z.string() }),
      execute: async ({ iban }) => { sends.push(iban); return { sent: true, iban }; },
    });
    const guard = (c: any) => (c.toolName === 'sendMoney' ? { action: 'require-approval' as const } : { action: 'allow' as const });
    // A tool-result processor standing in for prompt-injection redaction/flagging.
    const redactor = { processToolResult: async ({ output }: any) => ({ output: { ...(output as object), redacted: true } }) };
    const mkModel = () => createMockModel(async ({ prompt }: any) => {
      if (countToolResults(prompt) === 0) return toolCallResult('sendMoney', 'call-1', { iban: 'ATTACKER' });
      return finalTextResult('Done.');
    });

    const first = await runDurable({
      runId: 'b1', journal, model: mkModel(), tools: { sendMoney }, guard,
      processors: [redactor], prompt: 'go', stopWhen: stepCountIs(6),
    });
    expect(first.interrupts).toHaveLength(1);
    const tcid = first.interrupts[0].toolCallId;
    expect(sends).toHaveLength(0); // suspended, not executed yet

    // Resume + approve. The now-executing approved call MUST pass through the processor chain.
    await resumeRun('b1', {
      journal, model: mkModel(), tools: { sendMoney }, guard,
      approvals: { [tcid]: true }, processors: [redactor],
    } as any);

    const rec = await journal.get<any>('b1:tool:call-1');
    expect(sends).toHaveLength(1); // approved → executed exactly once
    expect(rec?.output?.redacted).toBe(true); // BUG: processors dropped on resume → output unscanned
  });

  it('B2: limits survive resume even when the caller does NOT re-supply them (persisted → recovered)', async () => {
    const journal = new InMemoryJournal();
    // stepOne suspends (require-approval); stepTwo is a plain side-effect tool.
    const stepOne = tool({
      description: 'first side effect (requires approval)',
      inputSchema: z.object({}),
      execute: async () => ({ one: true }),
    });
    const stepTwo = tool({
      description: 'second side effect',
      inputSchema: z.object({}),
      execute: async () => ({ two: true }),
    });
    const guard = (c: any) => (c.toolName === 'stepOne' ? { action: 'require-approval' as const } : { action: 'allow' as const });
    const mkModel = () => createMockModel(async ({ prompt }: any) => {
      const done = countToolResults(prompt);
      if (done === 0) return toolCallResult('stepOne', 'call-1', {});
      if (done === 1) return toolCallResult('stepTwo', 'call-2', {});
      return finalTextResult('Done.');
    });

    // First run: suspends on stepOne (0 tool calls counted). limits persisted to the journal.
    const first = await runDurable({
      runId: 'b2', journal, model: mkModel(), tools: { stepOne, stepTwo }, guard,
      limits: { maxToolCalls: 1 }, prompt: 'go', stopWhen: stepCountIs(6),
    });
    expect(first.interrupts).toHaveLength(1);
    const tcid = first.interrupts[0].toolCallId;

    // Resume + approve, WITHOUT passing limits. stepOne executes (count=1); stepTwo is the 2nd
    // attempt → maxToolCalls:1 must block it. If limits are lost on resume (the bug), stepTwo
    // runs and the run completes with no throw.
    await expect(
      resumeRun('b2', {
        journal, model: mkModel(), tools: { stepOne, stepTwo }, guard,
        approvals: { [tcid]: true }, // NO limits here — must be recovered from the journal
      } as any),
    ).rejects.toBeInstanceOf(RunLimitExceededError);

    // stepTwo was blocked prospectively — nothing written for it.
    expect(await journal.get('b2:tool:call-2')).toBeUndefined();
  });

  it('B2: an explicitly-passed limits on resume OVERRIDES the persisted one', async () => {
    const journal = new InMemoryJournal();
    const stepOne = tool({
      description: 'first side effect (requires approval)',
      inputSchema: z.object({}),
      execute: async () => ({ one: true }),
    });
    const stepTwo = tool({
      description: 'second side effect',
      inputSchema: z.object({}),
      execute: async () => ({ two: true }),
    });
    const guard = (c: any) => (c.toolName === 'stepOne' ? { action: 'require-approval' as const } : { action: 'allow' as const });
    const mkModel = () => createMockModel(async ({ prompt }: any) => {
      const done = countToolResults(prompt);
      if (done === 0) return toolCallResult('stepOne', 'call-1', {});
      if (done === 1) return toolCallResult('stepTwo', 'call-2', {});
      return finalTextResult('Done.');
    });

    // First run persists a TIGHT limit (maxToolCalls:1).
    const first = await runDurable({
      runId: 'b2-override', journal, model: mkModel(), tools: { stepOne, stepTwo }, guard,
      limits: { maxToolCalls: 1 }, prompt: 'go', stopWhen: stepCountIs(6),
    });
    const tcid = first.interrupts[0].toolCallId;

    // Resume with an explicit, RELAXED limit → the override wins, stepTwo runs, the run completes.
    const res = await resumeRun('b2-override', {
      journal, model: mkModel(), tools: { stepOne, stepTwo }, guard,
      approvals: { [tcid]: true }, limits: { maxToolCalls: 5 },
    } as any);
    expect(res.text).toContain('Done.');
    expect(await journal.get('b2-override:tool:call-2')).toBeDefined();
  });
});
