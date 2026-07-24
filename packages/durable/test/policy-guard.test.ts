// Data-driven guard: rules live in the journal, policyGuard reads LIVE — a rule change
// requires no deploy and takes effect on the next tool call.
import { describe, it, expect } from 'vitest';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { InMemoryJournal, policyGuard, evaluatePolicy, POLICY_KEY } from '../src/index.js';
import { runDurable } from '../src/run.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

describe('evaluatePolicy (pure)', () => {
  it('exact match wins before wildcard; falls back when no match', () => {
    const doc = { version: 1, rules: [
      { tool: 'chargeCard', action: 'require-approval' as const, reason: 'money movement' },
      { tool: '*', action: 'deny' as const, reason: 'default closed' },
    ] };
    expect(evaluatePolicy(doc, 'chargeCard')).toEqual({ action: 'require-approval', reason: 'money movement' });
    expect(evaluatePolicy(doc, 'baskaTool')).toEqual({ action: 'deny', reason: 'default closed' });
    expect(evaluatePolicy(undefined, 'x')).toEqual({ action: 'allow' }); // no document → fallback
    expect(evaluatePolicy({ version: 1, rules: [] }, 'x', 'deny')).toEqual({ action: 'deny', reason: undefined });
  });
});

describe('policyGuard (journal-live)', () => {
  it('free when no rule; once a rule is added the NEXT run falls into approval (no deploy)', async () => {
    const journal = new InMemoryJournal();
    const charges = { n: 0 };
    const agent = () => createMockModel(async (options: any) =>
      countToolResults(options.prompt) === 0
        ? toolCallResult('chargeCard', `c-${charges.n}-${Math.random().toString(36).slice(2, 6)}`, { amount: 5 })
        : finalTextResult('done'),
    );
    const tools = {
      chargeCard: tool({ description: 't', inputSchema: z.object({ amount: z.number() }), execute: async () => { charges.n++; return { ok: true }; } }),
    };
    const guard = policyGuard(journal);

    // Empty document → allow (behavior unchanged)
    const r1 = await runDurable({ runId: 'pg-1', journal, model: agent(), tools, guard, prompt: 'pay', stopWhen: stepCountIs(4) } as any);
    expect(r1.interrupts).toHaveLength(0);
    expect(charges.n).toBe(1);

    // Write a rule the way Studio would → new run falls into approval, tool DOES NOT RUN
    await journal.put(POLICY_KEY, { version: 1, rules: [{ tool: 'chargeCard', action: 'require-approval', reason: 'limit' }] });
    const r2 = await runDurable({ runId: 'pg-2', journal, model: agent(), tools, guard, prompt: 'pay', stopWhen: stepCountIs(4) } as any);
    expect(r2.interrupts).toHaveLength(1);
    expect(r2.interrupts[0]).toMatchObject({ toolName: 'chargeCard', reason: 'limit' });
    expect(charges.n).toBe(1); // did not run without approval

    // deny rule: tool is rejected, model sees the result
    await journal.put(POLICY_KEY, { version: 2, rules: [{ tool: 'chargeCard', action: 'deny', reason: 'forbidden' }] });
    const r3 = await runDurable({ runId: 'pg-3', journal, model: agent(), tools, guard, prompt: 'pay', stopWhen: stepCountIs(4) } as any);
    expect(r3.interrupts).toHaveLength(0);
    expect(charges.n).toBe(1); // deny → never ran
  });
});
