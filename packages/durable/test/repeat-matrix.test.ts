// THE REPEAT MATRIX — "does this actually work?" (the question that prompted it: what happens when
// the WORDS differ but the JOB is the same?). On a confirm-gated critical tool, what is pinned is
// WHICH information the question arrives with:
//   byte-identical arguments (however different the prompt) → ⚠ Identical (exact marker; wording is irrelevant)
//   arguments in a different KEY ORDER                      → ⚠ Identical (stableStringify — order is irrelevant)
//   same identity, DIFFERENT SPELLING (case)                → ⚠ SAME business identity (the semantic view)
//   same identity, DIFFERENT AMOUNT                         → ⚠ amounts DIFFER
//   a different identity                                    → a generic question (NO false alarm)
//   score on its own                                        → NEVER produces ⚠ (the identity fields decide)
// Plus two invariants: the question is asked WITHOUT running (the counter holds), and an approval
// opens the REAL work while a denial does not.
import { describe, it, expect } from 'vitest';
import { stepCountIs } from 'ai';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

/** Deterministic fake embedder (same shape as semantic-dup.test): identical text → identical vector (cosine 1). */
function fakeEmbed() {
  return async (texts: string[]): Promise<number[][]> =>
    texts.map((t) => {
      let h = 0;
      for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
      const vec = new Array(32).fill(0);
      vec[h % 32] = 1;
      vec[(h >> 5) % 32] += 0.5;
      return vec;
    });
}

function buildTool(state: { n: number }, extra: Record<string, unknown> = {}) {
  return {
    order: {
      description: 'create an order',
      sideEffect: true,
      confirm: true,
      recover: async () => ({ done: false as const }),
      semanticIdentity: { keys: ['sku'], amountFields: ['amount'], ...extra },
      execute: async (args: unknown) => { state.n += 1; return { ok: true, order: args }; },
    },
  };
}

const LIMITS = {
  sideEffectDuplicates: {
    action: 'suspend' as const,
    scope: 'thread' as const,
    semantic: { embed: fakeEmbed(), embedModelId: 'test-embed' },
  },
};

const model = (callId: string, args: unknown) =>
  createMockModel(async ({ prompt }: any) =>
    countToolResults(prompt) === 0 ? toolCallResult('order', callId, args) : finalTextResult('done'));

const run = (journal: InMemoryJournal, runId: string, prompt: string, callId: string, args: unknown, tools: any, approvals?: Record<string, boolean>) =>
  runDurable({
    runId, journal, prompt, threadId: 'th-m', stopWhen: stepCountIs(4),
    model: model(callId, args), tools, limits: LIMITS, ...(approvals ? { approvals } : {}),
  } as any);

const reasonOf = (r: any): string => r.interrupts[0]?.reason ?? '';

describe('the repeat matrix — the question always comes; WHAT IT CARRIES varies by case', () => {
  it('the full matrix: exact / key-order / spelling / amount / different-work / approval / denial', async () => {
    const journal = new InMemoryJournal();
    const state = { n: 0 };
    const tools = buildTool(state);

    // 0) The FIRST job: a generic question → approval → it runs (the baseline)
    const r0 = await run(journal, 'm-0', 'order LAMBA-1', 'c0', { sku: 'LAMBA-1', qty: 1, amount: 40 }, tools);
    expect(reasonOf(r0)).toContain('explicit confirmation');
    expect(reasonOf(r0)).not.toContain('⚠');
    expect(state.n).toBe(0); // the question arrived WITHOUT running anything
    await run(journal, 'm-0', 'order LAMBA-1', 'c0', { sku: 'LAMBA-1', qty: 1, amount: 40 }, tools, { c0: true });
    expect(state.n).toBe(1);

    // 1) DIFFERENT WORDS, byte-identical arguments → the exact ⚠ (the prompt carries no weight at all)
    const r1 = await run(journal, 'm-1', 'i think i want one more of that lamp', 'c1', { sku: 'LAMBA-1', qty: 1, amount: 40 }, tools);
    expect(reasonOf(r1)).toContain('Identical work was ALREADY COMPLETED');
    expect(reasonOf(r1)).toContain('c0'); // ilk sonucun adresi
    expect(state.n).toBe(1);

    // 2) A different KEY ORDER → the same fingerprint (stableStringify) → still the exact ⚠
    const r2 = await run(journal, 'm-2', 'again', 'c2', { amount: 40, qty: 1, sku: 'LAMBA-1' }, tools);
    expect(reasonOf(r2)).toContain('Identical work was ALREADY COMPLETED');
    expect(state.n).toBe(1);

    // 3) A SPELLING difference: 'lamba-1' (lower case) → a different hash the exact layer misses;
    //    the SEMANTIC identity catches it
    const r3 = await run(journal, 'm-3', 'one of lamba-1', 'c3', { sku: 'lamba-1', qty: 1, amount: 40 }, tools);
    expect(reasonOf(r3)).not.toContain('Identical work'); // not the exact layer
    expect(reasonOf(r3)).toContain('SAME business identity');
    expect(reasonOf(r3)).toContain('c0'); // the first job's address comes through the semantic path too
    expect(state.n).toBe(1);

    // 3b) "I mean it" → approval → a REAL second job (a spelling difference does not block an approval)
    await run(journal, 'm-3', 'one of lamba-1', 'c3', { sku: 'lamba-1', qty: 1, amount: 40 }, tools, { c3: true });
    expect(state.n).toBe(2);

    // 4) SAME IDENTITY, DIFFERENT AMOUNT → the 'amounts DIFFER' notice (a call for attention, not a dedup claim)
    const r4 = await run(journal, 'm-4', 'lamba ama 90 liraya', 'c4', { sku: 'LAMBA-1', qty: 1, amount: 90 }, tools);
    expect(reasonOf(r4)).toContain('amounts DIFFER');
    expect(state.n).toBe(2);

    // 5) DIFFERENT WORK (another sku) → a generic question, NO ⚠ (we do not manufacture false alarms)
    const r5 = await run(journal, 'm-5', 'and a table too', 'c5', { sku: 'MASA-7', qty: 1, amount: 200 }, tools);
    expect(reasonOf(r5)).toContain('explicit confirmation');
    expect(reasonOf(r5)).not.toContain('⚠');

    // 6) The denial path: 'no' to a repeat question → nothing runs
    const r6 = await run(journal, 'm-6', 'lamba yine', 'c6', { sku: 'LAMBA-1', qty: 1, amount: 40 }, tools);
    expect(reasonOf(r6)).toContain('⚠');
    await run(journal, 'm-6', 'lamba yine', 'c6', { sku: 'LAMBA-1', qty: 1, amount: 40 }, tools, { c6: false });
    expect(state.n).toBe(2); // a denial means zero new executions

    // 7) It asks EVERY TIME: even after an approval, the next repeat asks again
    const r7 = await run(journal, 'm-7', 'lamp once more', 'c7', { sku: 'LAMBA-1', qty: 1, amount: 40 }, tools);
    expect(r7.interrupts).toHaveLength(1);
    expect(reasonOf(r7)).toContain('⚠');
  });

  it('score ALONE never produces ⚠: with an identical canonical sentence but a different identity field, the question stays GENERIC', async () => {
    const journal = new InMemoryJournal();
    const state = { n: 0 };
    // A constant describe() gives every call the SAME vector (cosine 1.0) — but the identity field (sku) decides.
    const tools = buildTool(state, { describe: () => 'order operation' });
    await run(journal, 's-0', 'x', 'c0', { sku: 'A-1', qty: 1, amount: 10 }, tools);
    await run(journal, 's-0', 'x', 'c0', { sku: 'A-1', qty: 1, amount: 10 }, tools, { c0: true });
    expect(state.n).toBe(1);
    const r = await run(journal, 's-1', 'y', 'c1', { sku: 'B-2', qty: 1, amount: 10 }, tools);
    expect(reasonOf(r)).toContain('explicit confirmation');
    expect(reasonOf(r)).not.toContain('⚠'); // even a 100%-similar vector cannot decorate the question without an identity match
  });

  it("the semantic view is FAIL-OPEN: with a broken embedder the question arrives generic and the flow never breaks", async () => {
    const journal = new InMemoryJournal();
    const state = { n: 0 };
    const tools = buildTool(state);
    const broken = {
      sideEffectDuplicates: {
        action: 'suspend' as const, scope: 'thread' as const,
        semantic: { embed: async () => { throw new Error('embed down'); }, embedModelId: 'down' },
      },
    };
    const runB = (id: string, cid: string, args: unknown, ap?: Record<string, boolean>) =>
      runDurable({ runId: id, journal, prompt: 'x', threadId: 'th-b', stopWhen: stepCountIs(4), model: model(cid, args), tools, limits: broken, ...(ap ? { approvals: ap } : {}) } as any);
    await runB('b-0', 'c0', { sku: 'K-1', qty: 1, amount: 5 });
    await runB('b-0', 'c0', { sku: 'K-1', qty: 1, amount: 5 }, { c0: true });
    const r = await runB('b-1', 'c1', { sku: 'k-1', qty: 1, amount: 5 }); // a spelling difference, with the embedder dead
    expect(r.interrupts).toHaveLength(1); // the question still comes (confirm) — just undecorated
    expect(reasonOf(r)).toContain('explicit confirmation');
    expect(state.n).toBe(1);
  });
});
