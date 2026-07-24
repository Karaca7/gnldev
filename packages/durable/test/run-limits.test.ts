// GOREV W1: per-run cost ceiling + runaway protection. `limits` is OPT-IN — if not given, the old behavior
// is preserved EXACTLY. The count is computed deterministically from the step records in the journal (see limits.ts) →
// on overflow the journal stays CONSISTENT (no half-step) and the limit can be raised and the SAME runId resumed.
import { describe, it, expect } from 'vitest';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { createAgentTool } from '../src/agent-tool.js';
import { getRunCost } from '../src/cost.js';
import { RunLimitExceededError, ToolLoopDetectedError } from '../src/limits.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

describe('GOREV W1 — run limits (cost ceiling + loop detection + fan-out inheritance)', () => {
  it('RunLimitExceededError on maxTokens overflow; journal stays consistent; limit can be raised and the SAME runId resumed', async () => {
    const journal = new InMemoryJournal();
    const calls: string[] = [];
    const noop = tool({
      description: 'noop',
      inputSchema: z.object({}),
      execute: async () => {
        calls.push('run');
        return { ok: true };
      },
    });
    // 3 model steps: tool-call(15 tokens), tool-call(15 tokens), final text(15 tokens) → cumulative 15/30/45.
    const model = () =>
      createMockModel(async ({ prompt }: any) => {
        const done = countToolResults(prompt);
        if (done === 0) return toolCallResult('noop', 'call-1', {});
        if (done === 1) return toolCallResult('noop', 'call-2', {});
        return finalTextResult('Done.');
      });

    // maxTokens=20: after step 0, 15 ≤ 20 (passes); after step 1, 30 > 20 → throws.
    await expect(
      runDurable({
        runId: 'r1', journal, model: model(), tools: { noop },
        prompt: 'start', stopWhen: stepCountIs(10),
        limits: { maxTokens: 20 },
      }),
    ).rejects.toBeInstanceOf(RunLimitExceededError);

    // Journal consistent: step 0's tool ACTUALLY ran (succeeded), step 1's tool never ran BECAUSE OF
    // the overflow (the model step was journaled but generateText was never invoked).
    expect(calls).toEqual(['run']);
    expect(await journal.get('r1:tool:call-1')).toMatchObject({ status: 'succeeded' });
    expect(await journal.get('r1:tool:call-2')).toBeUndefined();
    expect(await journal.get('r1:model:1')).toBeDefined(); // step is not HALF-written, it's FULLY written

    try {
      await runDurable({
        runId: 'r1', journal, model: model(), tools: { noop },
        prompt: 'start', stopWhen: stepCountIs(10),
        limits: { maxTokens: 20 },
      });
      throw new Error('expected error did not throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RunLimitExceededError);
      expect((e as RunLimitExceededError).detail).toEqual({ kind: 'maxTokens', value: 30, limit: 20 });
    }

    // Limit is RAISED and the same runId is resumed → COMPLETES from where it left off; step 0's tool
    // does NOT RUN AGAIN (exactly-once preserved), step 1's tool ACTUALLY runs this time.
    const resumed = await runDurable({
      runId: 'r1', journal, model: model(), tools: { noop },
      prompt: 'start', stopWhen: stepCountIs(10),
      limits: { maxTokens: 1000 },
    });
    expect(resumed.text).toContain('Done');
    expect(calls).toEqual(['run', 'run']); // only 1 more time (total 2 — no double run)
    const finalCost = await getRunCost(journal, 'r1');
    expect(finalCost.totalTokens).toBe(45);
  });

  it('throws RunLimitExceededError on maxCostUsd overflow (real cost computed via DEFAULT_PRICING)', async () => {
    const journal = new InMemoryJournal();
    // claude-opus-4: input $5/1M, output $25/1M — mock usage {input:10,output:5} → per-step cost
    // (10/1e6)*5 + (5/1e6)*25 = 0.00005 + 0.000125 = $0.000175. Cumulative over 3 steps ~$0.000525.
    const model = createMockModel(async ({ prompt }: any) => {
      const done = countToolResults(prompt);
      if (done < 2) return { ...toolCallResult('noop', `call-${done + 1}`, {}), response: { modelId: 'claude-opus-4' } };
      return { ...finalTextResult('Done.'), response: { modelId: 'claude-opus-4' } };
    });
    const noop = tool({ description: 'noop', inputSchema: z.object({}), execute: async () => ({ ok: true }) });

    await expect(
      runDurable({
        runId: 'r2', journal, model, tools: { noop },
        prompt: 'start', stopWhen: stepCountIs(10),
        limits: { maxCostUsd: 0.0003 }, // exceeds after 2 steps (0.00035), does not exceed after 1 step (0.000175)
      }),
    ).rejects.toBeInstanceOf(RunLimitExceededError);
  });

  it('throws RunLimitExceededError once maxToolCalls is reached, without the NEXT call ever being EXECUTED', async () => {
    const journal = new InMemoryJournal();
    let realRuns = 0;
    const noop = tool({
      description: 'noop',
      inputSchema: z.object({}),
      execute: async () => {
        realRuns++;
        return { n: realRuns };
      },
    });
    const model = createMockModel(async ({ prompt }: any) => {
      const done = countToolResults(prompt);
      if (done < 4) return toolCallResult('noop', `call-${done + 1}`, {});
      return finalTextResult('Done.');
    });

    await expect(
      runDurable({
        runId: 'r3', journal, model, tools: { noop },
        prompt: 'start', stopWhen: stepCountIs(10),
        limits: { maxToolCalls: 2 },
      }),
    ).rejects.toBeInstanceOf(RunLimitExceededError);
    // Only 2 calls (the limit) ACTUALLY ran; the 3rd call was blocked WITHOUT BEING EXECUTED (prospective gate).
    expect(realRuns).toBe(2);
    expect(await journal.get('r3:tool:call-3')).toBeUndefined();
  });

  it('loop detection: once the same tool + same argsHash runs maxRepeats times in a row, the NEXT call is blocked WITHOUT being executed', async () => {
    const journal = new InMemoryJournal();
    let realRuns = 0;
    const stuck = tool({
      description: 'tool that always does the same work',
      inputSchema: z.object({}),
      execute: async () => {
        realRuns++;
        return { attempt: realRuns };
      },
    });
    // The model ALWAYS calls the same tool with the SAME arguments (never progresses — a genuine "runaway" loop).
    const model = createMockModel(async ({ prompt }: any) => {
      const done = countToolResults(prompt);
      return toolCallResult('stuck', `call-${done + 1}`, {});
    });

    await expect(
      runDurable({
        runId: 'r4', journal, model, tools: { stuck },
        prompt: 'loop', stopWhen: stepCountIs(20),
        limits: { loopDetection: { maxRepeats: 3 } },
      }),
    ).rejects.toBeInstanceOf(ToolLoopDetectedError);

    // Ran EXACTLY 3 times for real; the 4th attempt was blocked without ever touching the journal.
    expect(realRuns).toBe(3);
    expect(await journal.get('r4:tool:call-4')).toBeUndefined();

    try {
      await runDurable({
        runId: 'r4x', journal, model: createMockModel(async ({ prompt }: any) => {
          const done = countToolResults(prompt);
          return toolCallResult('stuck', `call-x-${done + 1}`, {});
        }), tools: { stuck },
        prompt: 'loop', stopWhen: stepCountIs(20),
        limits: { loopDetection: { maxRepeats: 3 } },
      });
      throw new Error('expected error did not throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ToolLoopDetectedError);
      expect((e as ToolLoopDetectedError).detail).toMatchObject({ toolName: 'stuck', repeats: 3, maxRepeats: 3 });
    }
  });

  it('when loopDetection is not given (OFF): runs as many times as desired with the same tool + args (old behavior)', async () => {
    const journal = new InMemoryJournal();
    let realRuns = 0;
    const stuck = tool({
      description: 'tool that always does the same work', inputSchema: z.object({}),
      execute: async () => { realRuns++; return { attempt: realRuns }; },
    });
    const model = createMockModel(async ({ prompt }: any) => {
      const done = countToolResults(prompt);
      if (done < 5) return toolCallResult('stuck', `call-${done + 1}`, {});
      return finalTextResult('Done.');
    });

    const res = await runDurable({
      runId: 'r5', journal, model, tools: { stuck },
      prompt: 'loop', stopWhen: stepCountIs(20),
      // limits was NOT given AT ALL → loop detection off, no maxTokens/maxToolCalls either.
    });
    expect(res.text).toContain('Done');
    expect(realRuns).toBe(5); // none were blocked
  });

  it('FAN-OUT INHERITANCE: sub-agent spend COUNTS toward the parent\'s ceiling — no bypass even if it alone wouldn\'t exceed it', async () => {
    const journal = new InMemoryJournal();
    // Sub-agent: 15 tokens in a single step (final text) — WELL BELOW the limit (40) on its own.
    const childModel = createMockModel(async () => finalTextResult('expert answer'));
    const limits = { maxTokens: 40 };
    const expert = createAgentTool({ journal, model: childModel, limits }, { description: 'hand off to the expert' });

    // Parent: step 0 calls the sub-agent (15 tokens), step 1 writes final text (15 tokens) →
    // the parent's OWN total is 30 (under the limit) but parent+sub-agent TOTAL is 45 (> 40).
    const parentModel = createMockModel(async ({ prompt }: any) => {
      const done = countToolResults(prompt);
      if (done === 0) return toolCallResult('agent_expert', 'call-1', { task: 'question' });
      return finalTextResult('Result ready.');
    });

    await expect(
      runDurable({
        runId: 'parent1', journal, model: parentModel, tools: { agent_expert: expert },
        prompt: 'delegate', stopWhen: stepCountIs(10),
        limits,
      }),
    ).rejects.toBeInstanceOf(RunLimitExceededError);

    // Proof there's NO bypass: the parent's OWN (naive, without sub-agent) cost is 30 — on its own, under the limit (40)
    // it would stay under; only the scoped check that COVERS fan-out (limits.ts) caught this.
    const parentOnly = await getRunCost(journal, 'parent1');
    expect(parentOnly.totalTokens).toBe(30);
  });

  it('when limits is not given at all (opt-in OFF): existing behavior is preserved exactly (no regression)', async () => {
    const journal = new InMemoryJournal();
    const model = createMockModel(async ({ prompt }: any) => {
      const done = countToolResults(prompt);
      if (done === 0) return toolCallResult('noop', 'call-1', {});
      return finalTextResult('Done.');
    });
    const noop = tool({ description: 'noop', inputSchema: z.object({}), execute: async () => ({ ok: true }) });
    const res = await runDurable({
      runId: 'r6', journal, model, tools: { noop },
      prompt: 'start', stopWhen: stepCountIs(10),
    });
    expect(res.text).toContain('Done');
  });
});
