// AUDIT: the approval decision was not first-class in the journal — `approvals` was passed as an
// EXTERNAL parameter on every call; in the 'approved but crashes before the tool runs' scenario
// (approved but the process died before execute finished) the decision was never PERSISTED
// anywhere — resume would still require the `approvals` parameter, forcing the caller to keep its
// own decision history.
//
// This file locks in the `resolveApprovals` fix in run.ts:
//  - EVERY decision in the parameter is written to the journal via `claim` (idempotent, first decision wins),
//  - if `journal.listKeys` is supported, existing approvals in the journal are MERGED with the parameter,
//  - on conflict, the FIRST decision in the journal wins + console.warn,
//  - if `listKeys` is missing, behavior is unchanged (limited to the parameter) — no regression.
import { describe, it, expect, vi } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { InMemoryJournal, runKeys, runDurable, parseJournalKey } from '../src/index.js';
import type { Journal } from '../src/index.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

// Model that decides based on conversation state: 0 tool results → call chargeCard; then final text.
// (Even if the tool's execute FAILS/throws, the AI SDK converts it to a tool-error — the model still
// counts as having seen a "tool result"; see the `blockedOrThrow` comment at the top of durable-tool.ts.)
function makeModel() {
  return createMockModel(async ({ prompt }: any) => {
    const done = countToolResults(prompt);
    if (done === 0) return toolCallResult('chargeCard', 'call-1', { amount: 5000 });
    return finalTextResult('Done.');
  });
}

// execute THROWS while crash.active is true (crash simulation: tool dies WITHOUT/before completing).
function makeTools(counter: { charges: number }, crash: { active: boolean }) {
  return {
    chargeCard: tool({
      description: 'charge',
      inputSchema: z.object({ amount: z.number() }),
      execute: async ({ amount }) => {
        if (crash.active) throw new Error('CRASH: process died mid-execute');
        counter.charges++;
        return { charged: amount };
      },
    }),
  };
}

describe('first-class approval: approvals journal persistence', () => {
  it('PROOF: approved but crashes before the tool runs → resume WITHOUT the approvals parameter, the tool runs thanks to the journal', async () => {
    const journal = new InMemoryJournal();
    const counter = { charges: 0 };
    const crash = { active: true };

    // Run 1: approved (via approvals) but the tool execute THROWS — the tool can't complete.
    const r1 = await runDurable({
      runId: 'proof-1',
      journal,
      model: makeModel(),
      tools: makeTools(counter, crash),
      approvals: { 'call-1': true },
      prompt: 'charge 5000',
    });
    expect(counter.charges).toBe(0); // the tool couldn't complete
    expect(r1.text).toBe('Done.'); // the run continued overall (the AI SDK swallowed the error)
    const toolRecord1 = await journal.get<any>(runKeys.tool('proof-1', 'call-1'));
    expect(toolRecord1.status).toBe('failed'); // trace of the crash

    // The approval decision must have been WRITTEN to the journal — INDEPENDENT of the approvals
    // parameter, at the top of run.ts.
    expect(await journal.get(runKeys.approval('proof-1', 'call-1'))).toBe(true);

    // Run 2: resume WITHOUT the approvals parameter — no more crash, the tool can complete this time.
    crash.active = false;
    const r2 = await runDurable({
      runId: 'proof-1',
      journal,
      model: makeModel(),
      tools: makeTools(counter, crash),
      prompt: 'charge 5000',
    });

    expect(counter.charges).toBe(1); // thanks to the journal approval, the retry was NOT blocked, the tool ran
    expect(r2.text).toBe('Done.');
  });

  it('a denial (false) also persists: false is written to the journal approval key', async () => {
    const journal = new InMemoryJournal();
    const counter = { charges: 0 };
    const bigChargeGuard = ({ toolName, args }: any) =>
      toolName === 'chargeCard' && (args as any).amount > 1000
        ? { action: 'require-approval' as const, reason: 'large amount' }
        : { action: 'allow' as const };

    const r = await runDurable({
      runId: 'deny-1',
      journal,
      model: makeModel(),
      tools: makeTools(counter, { active: false }),
      guard: bigChargeGuard,
      approvals: { 'call-1': false },
      prompt: 'charge 5000',
    });

    expect(counter.charges).toBe(0); // denied, the tool never ran
    expect(r.text).toBe('Done.');
    // The denial decision was PERSISTED to the journal — not just in the tool's 'denied' terminal
    // state, but also in the separate approval key (so it can be enumerated/observed later via listKeys).
    expect(await journal.get(runKeys.approval('deny-1', 'call-1'))).toBe(false);
  });

  it('the FIRST decision wins: even if a later resume brings a DIFFERENT approvals parameter, the journal holds firm + console.warn', async () => {
    const journal = new InMemoryJournal();
    const counter = { charges: 0 };
    const crash = { active: true };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      // Run 1: approval TRUE, the tool crashes (can't complete) — 'true' is written to the journal (first decision).
      await runDurable({
        runId: 'conflict-1',
        journal,
        model: makeModel(),
        tools: makeTools(counter, crash),
        approvals: { 'call-1': true },
        prompt: 'charge 5000',
      });
      expect(counter.charges).toBe(0);
      expect(await journal.get(runKeys.approval('conflict-1', 'call-1'))).toBe(true);

      // Run 2: CONFLICTING parameter (false) — the FIRST decision (true) in the journal must WIN, must NOT be overwritten.
      crash.active = false;
      const r2 = await runDurable({
        runId: 'conflict-1',
        journal,
        model: makeModel(),
        tools: makeTools(counter, crash),
        approvals: { 'call-1': false }, // conflicting, losing decision
        prompt: 'charge 5000',
      });

      expect(counter.charges).toBe(1); // the journal's 'true' won → the tool RAN
      expect(r2.text).toBe('Done.');
      expect(await journal.get(runKeys.approval('conflict-1', 'call-1'))).toBe(true); // still true — not overwritten
      expect(warnSpy).toHaveBeenCalled(); // the conflict was made visible
      expect(String(warnSpy.mock.calls[0]?.[0])).toMatch(/conflict/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('journal WITHOUT listKeys support: enrichment is skipped, behavior is no WORSE than today (fallback)', async () => {
    // Minimal Journal: has get/put/putIfAbsent, NO listKeys (some adapters may support it).
    const inner = new InMemoryJournal();
    const journal: Journal = {
      get: (k) => inner.get(k),
      put: (k, v) => inner.put(k, v),
      putIfAbsent: (k, v) => inner.putIfAbsent(k, v),
    };
    const counter = { charges: 0 };
    const crash = { active: true };

    // Run 1: approved but crashes — the approval IS WRITTEN to the journal (step (a), doesn't require
    // listKeys) but without listKeys a SUBSEQUENT run can't read it back to enrich.
    const r1 = await runDurable({
      runId: 'nolistkeys-1',
      journal,
      model: makeModel(),
      tools: makeTools(counter, crash),
      approvals: { 'call-1': true },
      prompt: 'charge 5000',
    });
    expect(counter.charges).toBe(0);
    expect(r1.text).toBe('Done.');

    // Run 2: WITHOUT the approvals parameter — no listKeys → ctx.approvals can't be enriched (fallback) →
    // the retry is BLOCKED with the OLD behavior (no regression: no retry unless approvals is explicitly given again).
    crash.active = false;
    await expect(
      runDurable({
        runId: 'nolistkeys-1',
        journal,
        model: makeModel(),
        tools: makeTools(counter, crash),
        prompt: 'charge 5000',
      }),
    ).rejects.toThrow(/side effects|not auto-retried/i);
    expect(counter.charges).toBe(0); // still hasn't run — the safe side is preserved
  });

  it("parseJournalKey: the approval key (outside model|tool) is INVISIBLE to reader/time-travel", () => {
    const key = runKeys.approval('some-run', 'call-1');
    expect(key).toBe('some-run:approval:call-1');
    expect(parseJournalKey(key)).toBeNull();
  });
});
