// Run-limits-reflect.test.ts proves the happy
// paths; THIS file proves the mechanism is CAUSAL and sound, not incidental:
//   A. Counterfactual triple — the SAME self-correcting model under (off | block | reflect) configs
//      produces three different outcomes; the ONLY variable is the config → the nudge is the CAUSE of
//      the recovery (without the signal the model cannot self-correct; with a hard block it never gets
//      the chance).
//   B. The nudge payload actually REACHES the model verbatim through the conversation (the
//      communication channel is real, not just journal state).
//   C. Crash right after the nudge → resume: exactly ONE nudge total, exactly-once intact.
//   D. Consecutive semantics — an interleaved different call resets the window (legitimate alternating
//      patterns are never punished; the nudge fires only for a TRUE consecutive chain).
//   E. Per-tool isolation — a different tool with the SAME arguments is not a repeat.
//   F. Escalation survives internal-state loss — the reflected flag is reconstructed from the
//      journaled 'reflected' record (seedFromHistory), so "warn once → then stop" is durable.
//   G. Counter purity — a reflected (never-executed) call does NOT consume maxToolCalls.
//   H. Layering with `idempotency: 'args'` — args-dedup already guarantees single execution, so the
//      detector never fires there (reflection precisely targets the 'call'-mode re-execution gap).
//   I. Per-run window — a NEW runId gets a fresh chain (a genuinely new business request runs).
//   J. Time-travel — the reflected record resolves its pending call (no eternally-pending entry).
//   K. Streaming parity — streamDurable shares the same durable-tool gate (nudge works mid-stream).
import { describe, it, expect } from 'vitest';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable, streamDurable } from '../src/run.js';
import { reconstructState } from '../src/time-travel.js';
import { ToolLoopDetectedError } from '../src/limits.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

const sawNudge = (prompt: any[]) => JSON.stringify(prompt ?? []).includes('__gnl_reflected');

const makeStuck = (counter: { runs: number }) =>
  tool({
    description: 'tool that always does the same work',
    inputSchema: z.object({ orderId: z.string().optional() }),
    execute: async () => {
      counter.runs++;
      return { attempt: counter.runs };
    },
  });

/** The SAME self-correcting model used across the counterfactual triple: repeats identically, but IF
 *  it ever sees a nudge it recovers with final text. Its capability to self-correct is constant — only
 *  the runtime config varies. */
const selfCorrectingModel = () =>
  createMockModel(async ({ prompt }: any) => {
    if (sawNudge(prompt)) return finalTextResult('Recovered.');
    const done = countToolResults(prompt);
    return toolCallResult('stuck', `call-${done + 1}`, {});
  });

describe('loop reflection — causality & soundness', () => {
  it('A1 counterfactual (loopDetection OFF): the same model NEVER self-corrects — it runs away until stopWhen', async () => {
    const journal = new InMemoryJournal();
    const counter = { runs: 0 };
    const res = await runDurable({
      runId: 'cf-off', journal, model: selfCorrectingModel(), tools: { stuck: makeStuck(counter) },
      prompt: 'loop', stopWhen: stepCountIs(6),
      // no limits at all
    });
    expect(res.text).not.toBe('Recovered.'); // no signal → no recovery, ever
    expect(counter.runs).toBe(6); // pure runaway: every step re-executed the tool
  });

  it('A2 counterfactual (onRepeat: "block" hard stop): the same model never GETS the chance to self-correct', async () => {
    const journal = new InMemoryJournal();
    const counter = { runs: 0 };
    await expect(
      runDurable({
        runId: 'cf-block', journal, model: selfCorrectingModel(), tools: { stuck: makeStuck(counter) },
        prompt: 'loop', stopWhen: stepCountIs(20),
        limits: { loopDetection: { maxRepeats: 2 } }, // default onRepeat = 'block'
      }),
    ).rejects.toBeInstanceOf(ToolLoopDetectedError);
    expect(counter.runs).toBe(2);
    // No nudge was ever written — the model was stopped, not steered.
    const entries = await journal.readRun('cf-block');
    expect(entries.some((e) => (e.value as any)?.status === 'reflected')).toBe(false);
  });

  it('A3 counterfactual (onRepeat: "reflect"): ONLY the nudge config lets the SAME model recover — the nudge is the cause', async () => {
    const journal = new InMemoryJournal();
    const counter = { runs: 0 };
    const res = await runDurable({
      runId: 'cf-reflect', journal, model: selfCorrectingModel(), tools: { stuck: makeStuck(counter) },
      prompt: 'loop', stopWhen: stepCountIs(20),
      limits: { loopDetection: { maxRepeats: 2, onRepeat: 'reflect' } },
    });
    expect(res.text).toBe('Recovered.');
    expect(counter.runs).toBe(2); // same threshold as A2 — but recovery instead of a dead run
  });

  it('B the nudge payload reaches the model VERBATIM through the conversation', async () => {
    const journal = new InMemoryJournal();
    const counter = { runs: 0 };
    const seenPrompts: any[][] = [];
    const model = createMockModel(async ({ prompt }: any) => {
      seenPrompts.push(prompt);
      if (sawNudge(prompt)) return finalTextResult('Recovered.');
      const done = countToolResults(prompt);
      return toolCallResult('stuck', `call-${done + 1}`, {});
    });
    await runDurable({
      runId: 'chan-1', journal, model, tools: { stuck: makeStuck(counter) },
      prompt: 'loop', stopWhen: stepCountIs(20),
      limits: { loopDetection: { maxRepeats: 2, onRepeat: 'reflect' } },
    });
    // The LAST prompt (the one that produced the final text) carries call-3's tool result = the nudge.
    const last = JSON.stringify(seenPrompts[seenPrompts.length - 1]);
    expect(last).toContain('__gnl_reflected');
    expect(last).toContain('already ran 2 times in a row with identical arguments');
    // Security-sensitive wording (see durable-tool.ts): the nudge steers toward REUSE and explicitly
    // forbids fabricating arguments — it must never hand the model a detector-bypass recipe.
    expect(last).toContain('Do NOT invent or alter identifiers'); // anti-fabrication, verbatim
    expect(last).toContain('stopped for safety'); // the honest escalation warning, verbatim
  });

  it('C crash right after the nudge → resume: exactly ONE nudge total, exactly-once intact, run completes', async () => {
    const journal = new InMemoryJournal();
    const counter = { runs: 0 };
    // Phase 1: the model receives the nudge but the process "crashes" before it can act on it.
    const crashing = createMockModel(async ({ prompt }: any) => {
      if (sawNudge(prompt)) throw new Error('simulated crash');
      const done = countToolResults(prompt);
      return toolCallResult('stuck', `call-${done + 1}`, {});
    });
    await expect(
      runDurable({
        runId: 'crash-1', journal, model: crashing, tools: { stuck: makeStuck(counter) },
        prompt: 'loop', stopWhen: stepCountIs(20),
        limits: { loopDetection: { maxRepeats: 2, onRepeat: 'reflect' } },
      }),
    ).rejects.toThrow('simulated crash');
    expect(counter.runs).toBe(2);

    // Phase 2: resume with a healthy model — journaled steps replay; the nudge is served from the
    // journal (NOT re-derived), the model finally acts on it.
    const healthy = createMockModel(async ({ prompt }: any) => {
      if (sawNudge(prompt)) return finalTextResult('Recovered.');
      const done = countToolResults(prompt);
      return toolCallResult('stuck', `call-${done + 1}`, {});
    });
    const res = await runDurable({
      runId: 'crash-1', journal, model: healthy, tools: { stuck: makeStuck(counter) },
      prompt: 'loop', stopWhen: stepCountIs(20),
      limits: { loopDetection: { maxRepeats: 2, onRepeat: 'reflect' } },
    });
    expect(res.text).toBe('Recovered.');
    expect(counter.runs).toBe(2); // resume re-executed NOTHING
    const reflectedCount = (await journal.readRun('crash-1')).filter((e) => (e.value as any)?.status === 'reflected').length;
    expect(reflectedCount).toBe(1); // one nudge across crash+resume — never doubled
  });

  it('D consecutive semantics: an interleaved DIFFERENT call resets the window — alternating patterns are not punished', async () => {
    const journal = new InMemoryJournal();
    const counter = { runs: 0 };
    // A, A, B(different args), A, A → then the NEXT A hits the threshold of the NEW window and nudges.
    const model = createMockModel(async ({ prompt }: any) => {
      if (sawNudge(prompt)) return finalTextResult('Done.');
      const done = countToolResults(prompt);
      const args = done === 2 ? { orderId: 'B' } : { orderId: 'A' };
      return toolCallResult('stuck', `call-${done + 1}`, args);
    });
    const res = await runDurable({
      runId: 'inter-1', journal, model, tools: { stuck: makeStuck(counter) },
      prompt: 'loop', stopWhen: stepCountIs(20),
      limits: { loopDetection: { maxRepeats: 2, onRepeat: 'reflect' } },
    });
    expect(res.text).toBe('Done.');
    // A,A executed; B executed (chain reset — NOT nudged despite 2 prior calls of the same tool);
    // then A,A executed again (fresh window); the 3rd A of the new window (call-6) was nudged.
    expect(counter.runs).toBe(5);
    expect(await journal.get('inter-1:tool:call-3')).toMatchObject({ status: 'succeeded' }); // B ran
    expect(await journal.get('inter-1:tool:call-6')).toMatchObject({ status: 'reflected' });
  });

  it('E per-tool isolation: a DIFFERENT tool with the SAME arguments is not a repeat', async () => {
    const journal = new InMemoryJournal();
    const c1 = { runs: 0 };
    const c2 = { runs: 0 };
    const model = createMockModel(async ({ prompt }: any) => {
      const done = countToolResults(prompt);
      if (done === 0) return toolCallResult('t1', 'call-1', {});
      if (done === 1) return toolCallResult('t1', 'call-2', {});
      if (done === 2) return toolCallResult('t2', 'call-3', {}); // same args, different tool
      return finalTextResult('Done.');
    });
    const res = await runDurable({
      runId: 'iso-1', journal, model, tools: { t1: makeStuck(c1), t2: makeStuck(c2) },
      prompt: 'go', stopWhen: stepCountIs(10),
      limits: { loopDetection: { maxRepeats: 2, onRepeat: 'reflect' } },
    });
    expect(res.text).toBe('Done.');
    expect(c1.runs).toBe(2);
    expect(c2.runs).toBe(1); // t2 executed — no false-positive nudge across tools
    expect(await journal.get('iso-1:tool:call-3')).toMatchObject({ status: 'succeeded' });
  });

  it('F escalation survives internal-state loss: the reflected flag is reconstructed from the JOURNALED record', async () => {
    const journal = new InMemoryJournal();
    const counter = { runs: 0 };
    const insisting = () => createMockModel(async ({ prompt }: any) => {
      const done = countToolResults(prompt);
      return toolCallResult('stuck', `call-${done + 1}`, {});
    });
    const limits = { loopDetection: { maxRepeats: 2, onRepeat: 'reflect' as const } };

    // Run 1: nudge (call-3) → identical insistence (call-4) → hard block.
    await expect(
      runDurable({ runId: 'seed-1', journal, model: insisting(), tools: { stuck: makeStuck(counter) }, prompt: 'loop', stopWhen: stepCountIs(20), limits }),
    ).rejects.toBeInstanceOf(ToolLoopDetectedError);
    expect(counter.runs).toBe(2);

    // Simulate loss of the INTERNAL limit-state keys (chain + counters) — the journal records survive.
    await journal.deletePrefix('seed-1:proc:');

    // Run 2 (same runId): the chain is re-seeded FROM HISTORY (including the 'reflected' record) →
    // the very next identical attempt hard-blocks immediately; NO second nudge is handed out.
    await expect(
      runDurable({ runId: 'seed-1', journal, model: insisting(), tools: { stuck: makeStuck(counter) }, prompt: 'loop', stopWhen: stepCountIs(20), limits }),
    ).rejects.toBeInstanceOf(ToolLoopDetectedError);
    expect(counter.runs).toBe(2); // replay re-executed nothing
    const reflectedCount = (await journal.readRun('seed-1')).filter((e) => (e.value as any)?.status === 'reflected').length;
    expect(reflectedCount).toBe(1); // still exactly one nudge — "warn once" is durable, not per-process
  });

  it('G counter purity: a reflected (never-executed) call does NOT consume maxToolCalls', async () => {
    const journal = new InMemoryJournal();
    const counter = { runs: 0 };
    const model = createMockModel(async ({ prompt }: any) => {
      const done = countToolResults(prompt);
      if (sawNudge(prompt)) {
        // After the nudge: one genuinely NEW call. If the nudge had (wrongly) counted as a succeeded
        // call, succeededToolCalls would already be at the maxToolCalls=3 limit and THIS would be blocked.
        if (done === 3) return toolCallResult('stuck', 'call-4', { orderId: 'NEW' });
        return finalTextResult('Done.');
      }
      return toolCallResult('stuck', `call-${done + 1}`, { orderId: 'A' });
    });
    const res = await runDurable({
      runId: 'purity-1', journal, model, tools: { stuck: makeStuck(counter) },
      prompt: 'go', stopWhen: stepCountIs(20),
      limits: { maxToolCalls: 3, loopDetection: { maxRepeats: 2, onRepeat: 'reflect' } },
    });
    expect(res.text).toBe('Done.');
    expect(counter.runs).toBe(3); // A×2 + NEW — the nudge consumed nothing
    expect(await journal.get('purity-1:tool:call-4')).toMatchObject({ status: 'succeeded' });
  });

  it('H layering: with `idempotency: "args"` the dedup fast-path already guarantees single execution — the detector never fires', async () => {
    const journal = new InMemoryJournal();
    let realRuns = 0;
    const dedup = tool({
      description: 'args-idempotent tool',
      inputSchema: z.object({}),
      execute: async () => {
        realRuns++;
        return { attempt: realRuns };
      },
    });
    (dedup as any).idempotency = 'args';
    const model = createMockModel(async ({ prompt }: any) => {
      const done = countToolResults(prompt);
      if (done < 5) return toolCallResult('dedup', `call-${done + 1}`, {});
      return finalTextResult('Done.');
    });
    const res = await runDurable({
      runId: 'args-1', journal, model, tools: { dedup },
      prompt: 'go', stopWhen: stepCountIs(20),
      limits: { loopDetection: { maxRepeats: 2, onRepeat: 'reflect' } },
    });
    expect(res.text).toBe('Done.');
    expect(realRuns).toBe(1); // 5 model-side calls, ONE real execution — args-dedup, silently
    const entries = await journal.readRun('args-1');
    expect(entries.some((e) => (e.value as any)?.status === 'reflected')).toBe(false); // no double-layered nudge
  });

  it('I per-run window: a NEW runId gets a fresh chain — a genuinely new business request runs normally', async () => {
    const journal = new InMemoryJournal();
    const counter = { runs: 0 };
    const limits = { loopDetection: { maxRepeats: 2, onRepeat: 'reflect' as const } };
    const model = () => createMockModel(async ({ prompt }: any) => {
      if (sawNudge(prompt)) return finalTextResult('Recovered.');
      const done = countToolResults(prompt);
      return toolCallResult('stuck', `call-${done + 1}`, {});
    });
    await runDurable({ runId: 'win-1', journal, model: model(), tools: { stuck: makeStuck(counter) }, prompt: 'a', stopWhen: stepCountIs(20), limits });
    expect(counter.runs).toBe(2);
    // The SAME tool + SAME args under a NEW runId: fresh window → executes (not nudged at call-1).
    await runDurable({ runId: 'win-2', journal, model: model(), tools: { stuck: makeStuck(counter) }, prompt: 'b', stopWhen: stepCountIs(20), limits });
    expect(counter.runs).toBe(4); // 2 more real executions in the new run
    expect(await journal.get('win-2:tool:call-1')).toMatchObject({ status: 'succeeded' });
  });

  it('J time-travel: the reflected record RESOLVES its pending tool call (nothing stays pending forever)', async () => {
    const journal = new InMemoryJournal();
    const counter = { runs: 0 };
    const model = createMockModel(async ({ prompt }: any) => {
      if (sawNudge(prompt)) return finalTextResult('Recovered.');
      const done = countToolResults(prompt);
      return toolCallResult('stuck', `call-${done + 1}`, {});
    });
    await runDurable({
      runId: 'tt-1', journal, model, tools: { stuck: makeStuck(counter) },
      prompt: 'loop', stopWhen: stepCountIs(20),
      limits: { loopDetection: { maxRepeats: 2, onRepeat: 'reflect' } },
    });
    const state = reconstructState(await journal.readRun('tt-1'));
    expect(state.pending).toEqual([]); // call-3 (reflected) is resolved, not eternally pending
  });

  it('K streaming parity: streamDurable delivers the nudge through the same gate — the stream recovers', async () => {
    const journal = new InMemoryJournal();
    const counter = { runs: 0 };
    const usage = { inputTokens: 5, outputTokens: 5, totalTokens: 10 };
    const parts = (arr: any[]) =>
      new ReadableStream({
        start(c) {
          for (const p of arr) c.enqueue(p);
          c.close();
        },
      });
    const model: any = {
      specificationVersion: 'v2', provider: 'mock', modelId: 'mock-stream', supportedUrls: {},
      doGenerate: async () => { throw new Error('stream-only'); },
      doStream: async ({ prompt }: any) => {
        if (sawNudge(prompt)) {
          return { stream: parts([
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: '1' },
            { type: 'text-delta', id: '1', delta: 'Recovered.' },
            { type: 'text-end', id: '1' },
            { type: 'finish', finishReason: 'stop', usage },
          ]) };
        }
        const done = (prompt ?? []).filter((m: any) => m.role === 'tool').length;
        return { stream: parts([
          { type: 'stream-start', warnings: [] },
          { type: 'tool-call', toolCallId: `call-${done + 1}`, toolName: 'stuck', input: JSON.stringify({}) },
          { type: 'finish', finishReason: 'tool-calls', usage },
        ]) };
      },
    };
    const res = await streamDurable({
      runId: 'stream-1', journal, model, tools: { stuck: makeStuck(counter) },
      prompt: 'loop', stopWhen: stepCountIs(20),
      limits: { loopDetection: { maxRepeats: 2, onRepeat: 'reflect' } },
    });
    expect(await res.text).toBe('Recovered.');
    expect(counter.runs).toBe(2);
    expect(await journal.get('stream-1:tool:call-3')).toMatchObject({ status: 'reflected' });
  });
});
