// The
// runtime's answer for the developer who FORGETS `idempotency: 'args'` on a side-effect tool. In
// default 'call' mode the model issuing a FRESH identical call (new toolCallId, same args) would
// silently re-execute (double charge); the journal KNOWS it's a duplicate, so silence is complicity.
// Causality-grade coverage (see critical-review lesson): counterfactual pairs, the loopDetection
// blind spot (non-consecutive duplicates), every action mode, exemptions, approval flow, replay.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable, resumeRun } from '../src/run.js';
import { DuplicateSideEffectError, ToolLoopDetectedError } from '../src/limits.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

afterEach(() => vi.restoreAllMocks());

const sawNudge = (prompt: any[]) => JSON.stringify(prompt ?? []).includes('__gnl_reflected');

/** Unmarked tool → H7 safe-default treats it as side-effecting (the guard's exact audience). */
const makeCharge = (counter: { runs: number }) =>
  tool({
    description: 'charges a card (side effect; deliberately NOT marked idempotent)',
    inputSchema: z.object({ orderId: z.string().optional() }),
    execute: async () => {
      counter.runs++;
      return { charged: counter.runs };
    },
  });

/** Model that issues N identical charge calls, then finishes. */
const repeatThenFinish = (n: number, args: unknown = {}) =>
  createMockModel(async ({ prompt }: any) => {
    const done = countToolResults(prompt);
    if (done < n) return toolCallResult('charge', `call-${done + 1}`, args);
    return finalTextResult('Done.');
  });

const dupWarns = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.filter((c) => String(c[0]).includes('EXECUTE AGAIN'));

describe('side-effect duplicate guard (sideEffectDuplicates)', () => {
  it("DEFAULT (no limits at all) = 'warn': the duplicate still EXECUTES (zero behavior change) but the incident is NAMED with both exits", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const journal = new InMemoryJournal();
    const counter = { runs: 0 };
    const res = await runDurable({
      runId: 'dw-1', journal, model: repeatThenFinish(2), tools: { charge: makeCharge(counter) },
      prompt: 'go', stopWhen: stepCountIs(10),
      // NO limits passed — this is the safe-by-DEFAULT claim itself
    });
    expect(res.text).toBe('Done.');
    expect(counter.runs).toBe(2); // behavior unchanged — 'warn' prevents nothing, silence is what it kills
    const warns = dupWarns(warn);
    expect(warns).toHaveLength(1); // exactly the duplicate (call-2), not the first call
    const msg = String(warns[0][0]);
    expect(msg).toContain("'charge'");
    expect(msg).toContain('idempotent: true'); // exit 1: repeats are harmless → mark safe
    expect(msg).toContain("idempotency: 'args'"); // exit 2: must never duplicate → args-dedup
  });

  it("counterfactual 'off': the SAME scenario is silent (the warn above is caused by the guard, not ambient)", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const journal = new InMemoryJournal();
    const counter = { runs: 0 };
    await runDurable({
      runId: 'dw-2', journal, model: repeatThenFinish(2), tools: { charge: makeCharge(counter) },
      prompt: 'go', stopWhen: stepCountIs(10),
      limits: { sideEffectDuplicates: 'off' },
    });
    expect(counter.runs).toBe(2);
    expect(dupWarns(warn)).toHaveLength(0);
  });

  it('exemption: `idempotent: true` (declared safe to repeat) → no warn — the pressure valve against warn fatigue', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const journal = new InMemoryJournal();
    let runs = 0;
    const search = tool({
      description: 'read-only search — repeats are harmless',
      inputSchema: z.object({}),
      execute: async () => ({ hit: ++runs }),
    });
    (search as any).idempotent = true;
    const model = createMockModel(async ({ prompt }: any) => {
      const done = countToolResults(prompt);
      if (done < 3) return toolCallResult('search', `call-${done + 1}`, {});
      return finalTextResult('Done.');
    });
    await runDurable({ runId: 'dw-3', journal, model, tools: { search }, prompt: 'go', stopWhen: stepCountIs(10) });
    expect(runs).toBe(3);
    expect(dupWarns(warn)).toHaveLength(0);
  });

  it("exemption: `idempotency: 'args'` tools are args-deduped upstream — the guard never fires (clean layering)", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const journal = new InMemoryJournal();
    let runs = 0;
    const dedup = tool({
      description: 'args-idempotent side effect',
      inputSchema: z.object({}),
      execute: async () => ({ n: ++runs }),
    });
    (dedup as any).idempotency = 'args';
    const model = createMockModel(async ({ prompt }: any) => {
      const done = countToolResults(prompt);
      if (done < 3) return toolCallResult('dedup', `call-${done + 1}`, {});
      return finalTextResult('Done.');
    });
    await runDurable({ runId: 'dw-4', journal, model, tools: { dedup }, prompt: 'go', stopWhen: stepCountIs(10) });
    expect(runs).toBe(1); // the CORRECT protection for this tool: silent dedup, not warnings
    expect(dupWarns(warn)).toHaveLength(0);
  });

  it("the loopDetection BLIND SPOT: an A,B,A non-consecutive duplicate evades the loop chain but NOT this guard ('block')", async () => {
    const abaModel = () => createMockModel(async ({ prompt }: any) => {
      const done = countToolResults(prompt);
      if (done === 0) return toolCallResult('charge', 'call-1', { orderId: 'A' });
      if (done === 1) return toolCallResult('charge', 'call-2', { orderId: 'B' });
      if (done === 2) return toolCallResult('charge', 'call-3', { orderId: 'A' }); // duplicate of call-1
      return finalTextResult('Done.');
    });

    // Counterfactual: loopDetection alone (even at maxRepeats=1) is BLIND to it — B resets the chain.
    const j1 = new InMemoryJournal();
    const c1 = { runs: 0 };
    const res1 = await runDurable({
      runId: 'aba-loop', journal: j1, model: abaModel(), tools: { charge: makeCharge(c1) },
      prompt: 'go', stopWhen: stepCountIs(10),
      limits: { loopDetection: { maxRepeats: 1 }, sideEffectDuplicates: 'off' },
    });
    expect(res1.text).toBe('Done.');
    expect(c1.runs).toBe(3); // the duplicate re-executed — the documented oscillation hole

    // The guard closes exactly that hole: same model, same args — the A-duplicate is blocked.
    const j2 = new InMemoryJournal();
    const c2 = { runs: 0 };
    try {
      await runDurable({
        runId: 'aba-dup', journal: j2, model: abaModel(), tools: { charge: makeCharge(c2) },
        prompt: 'go', stopWhen: stepCountIs(10),
        limits: { sideEffectDuplicates: 'block' },
      });
      throw new Error('expected error did not throw');
    } catch (e) {
      expect(e).toBeInstanceOf(DuplicateSideEffectError);
      expect((e as DuplicateSideEffectError).detail).toMatchObject({ toolName: 'charge', firstToolCallId: 'call-1', toolCallId: 'call-3' });
    }
    expect(c2.runs).toBe(2); // A + B; the A-duplicate never executed
    expect(await j2.get('aba-dup:tool:call-3')).toBeUndefined(); // block writes nothing (re-evaluable)
  });

  it("'reflect': nudge (not executed) → model self-corrects → completes; the journaled record carries the anti-fabrication wording", async () => {
    const journal = new InMemoryJournal();
    const counter = { runs: 0 };
    const model = createMockModel(async ({ prompt }: any) => {
      if (sawNudge(prompt)) return finalTextResult('Recovered.');
      const done = countToolResults(prompt);
      return toolCallResult('charge', `call-${done + 1}`, {});
    });
    const res = await runDurable({
      runId: 'dr-1', journal, model, tools: { charge: makeCharge(counter) },
      prompt: 'go', stopWhen: stepCountIs(10),
      limits: { sideEffectDuplicates: 'reflect' },
    });
    expect(res.text).toBe('Recovered.');
    expect(counter.runs).toBe(1); // ONLY the original — the duplicate was reflected, not executed
    const rec = await journal.get<any>('dr-1:tool:call-2');
    expect(rec).toMatchObject({ status: 'reflected' });
    expect(rec.output.guidance).toContain('Do NOT invent or alter identifiers');
  });

  it("'reflect' ignored (identical insistence after the nudge) → DuplicateSideEffectError — warn once, then stop", async () => {
    const journal = new InMemoryJournal();
    const counter = { runs: 0 };
    try {
      await runDurable({
        runId: 'dr-2', journal, model: repeatThenFinish(99), tools: { charge: makeCharge(counter) },
        prompt: 'go', stopWhen: stepCountIs(10),
        limits: { sideEffectDuplicates: 'reflect' },
      });
      throw new Error('expected error did not throw');
    } catch (e) {
      expect(e).toBeInstanceOf(DuplicateSideEffectError);
      expect((e as DuplicateSideEffectError).message).toContain('reconsider nudge');
    }
    expect(counter.runs).toBe(1); // one real execution; nudge + block never executed
    expect(await journal.get('dr-2:tool:call-2')).toMatchObject({ status: 'reflected' });
    expect(await journal.get('dr-2:tool:call-3')).toBeUndefined();
  });

  it("'suspend': the duplicate lands in the approvals flow — a HUMAN approves → it executes exactly once more", async () => {
    const journal = new InMemoryJournal();
    const counter = { runs: 0 };
    const model = () => repeatThenFinish(2);
    const limits = { sideEffectDuplicates: 'suspend' as const };

    const first = await runDurable({
      runId: 'ds-1', journal, model: model(), tools: { charge: makeCharge(counter) },
      prompt: 'go', stopWhen: stepCountIs(10), limits,
    });
    // The duplicate (call-2) suspended the run with the standard interrupt shape + an honest reason.
    expect(counter.runs).toBe(1);
    expect(first.interrupts).toHaveLength(1);
    expect(first.interrupts[0]).toMatchObject({ toolCallId: 'call-2', toolName: 'charge' });
    expect(String(first.interrupts[0].reason)).toContain('Duplicate side effect');

    // Human approval for exactly that toolCallId → the duplicate executes ONCE, the run completes.
    const resumed = await resumeRun('ds-1', {
      journal, model: model(), tools: { charge: makeCharge(counter) }, limits,
      approvals: { 'call-2': true },
    });
    expect(resumed.text).toBe('Done.');
    expect(counter.runs).toBe(2); // original + the explicitly-approved repeat — nothing else
  });

  it('a genuinely DIFFERENT action (different args) is untouched — no warn, no block', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const journal = new InMemoryJournal();
    const counter = { runs: 0 };
    const model = createMockModel(async ({ prompt }: any) => {
      const done = countToolResults(prompt);
      if (done === 0) return toolCallResult('charge', 'call-1', { orderId: 'A' });
      if (done === 1) return toolCallResult('charge', 'call-2', { orderId: 'B' });
      return finalTextResult('Done.');
    });
    await runDurable({
      runId: 'dd-1', journal, model, tools: { charge: makeCharge(counter) },
      prompt: 'go', stopWhen: stepCountIs(10),
      limits: { sideEffectDuplicates: 'block' }, // even the strictest mode
    });
    expect(counter.runs).toBe(2);
    expect(dupWarns(warn)).toHaveLength(0);
  });

  it('per-run window: the SAME action in a NEW run is a fresh business request — runs without a peep', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const journal = new InMemoryJournal();
    const counter = { runs: 0 };
    await runDurable({ runId: 'pr-1', journal, model: repeatThenFinish(1), tools: { charge: makeCharge(counter) }, prompt: 'a', stopWhen: stepCountIs(10) });
    await runDurable({ runId: 'pr-2', journal, model: repeatThenFinish(1), tools: { charge: makeCharge(counter) }, prompt: 'b', stopWhen: stepCountIs(10) });
    expect(counter.runs).toBe(2);
    expect(dupWarns(warn)).toHaveLength(0);
  });

  it('replay safety: re-running a completed warn-mode run re-executes nothing and does NOT re-warn', async () => {
    const journal = new InMemoryJournal();
    const counter = { runs: 0 };
    await runDurable({ runId: 'rp-1', journal, model: repeatThenFinish(2), tools: { charge: makeCharge(counter) }, prompt: 'go', stopWhen: stepCountIs(10) });
    expect(counter.runs).toBe(2);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const again = await runDurable({ runId: 'rp-1', journal, model: repeatThenFinish(2), tools: { charge: makeCharge(counter) }, prompt: 'go', stopWhen: stepCountIs(10) });
    expect(again.text).toBe('Done.');
    expect(counter.runs).toBe(2); // exactly-once across replay
    expect(dupWarns(warn)).toHaveLength(0); // the fast-path short-circuits before the guard
  });
});
