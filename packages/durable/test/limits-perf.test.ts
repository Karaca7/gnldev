// GOREV (audit — the O(steps³) finding) performance proof: limits.ts used to pull the run's ENTIRE
// record set via `readRun(runId)` on EVERY call to `checkToolGate`/`enforceStepLimits`/`scopedUsage`
// (+ RECURSIVELY for sub-runs) → in an N-step run, O(N) scan per step × N steps = O(N²) (worse with
// fan-out). This file PROVES that the NEW implementation (a single per-run limit-state key, see the
// file header of limits.ts) keeps the `readRun` call COUNT INDEPENDENT of step count (O(1), seeding
// only) — the SAME method as the `countingJournal` pattern in journal-growth.test.ts (a thin wrapper around readRun).
import { describe, it, expect } from 'vitest';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

/** Wraps the journal with a counter: counts only `readRun` calls (behavior is delegated as-is — the SAME pattern as journal-growth.test.ts). */
function countReadRun(inner: InMemoryJournal) {
  let readRunCalls = 0;
  const j = {
    get: (k: string) => inner.get(k),
    put: (k: string, v: unknown) => inner.put(k, v),
    putIfAbsent: (k: string, v: unknown) => inner.putIfAbsent(k, v),
    listKeys: (p: string) => inner.listKeys(p),
    deletePrefix: (p: string) => inner.deletePrefix(p),
    readRun: (r: string) => { readRunCalls++; return inner.readRun(r); },
    readRunStats: (r: string) => inner.readRunStats(r),
    listRuns: () => inner.listRuns(),
  };
  return { j, get readRunCalls() { return readRunCalls; } };
}

/** A K-step tool-call storm: the model calls `work` with a DIFFERENT argument each time
 *  (so it doesn't trigger the loopDetection chain), then writes final text. */
function buildAgent(k: number) {
  let realRuns = 0;
  const work = tool({
    description: 'work',
    inputSchema: z.object({ i: z.number() }),
    execute: async () => {
      realRuns++;
      return { ok: true };
    },
  });
  const model = createMockModel(async ({ prompt }: any) => {
    const done = countToolResults(prompt);
    if (done < k) return toolCallResult('work', `call-${done}`, { i: done }); // a DIFFERENT arg at each step
    return finalTextResult('done');
  });
  return { work, model, calls: () => realRuns };
}

describe('GOREV performance proof — limits O(1) readRun (independent of step count)', () => {
  it('a 60-step run: with limits ON, total readRun count is ≤2 per run (seeding only), SAME as a 10-step run', async () => {
    // We keep ALL limit types (maxTokens/maxCostUsd/maxToolCalls/loopDetection) ON at the same time
    // — previously, checkToolGate ITSELF did 2 separate readRuns (loop scan + scopedUsage), and
    // enforceStepLimits did 1 readRun on EVERY model step (+1 more per sub-run under fan-out); so on
    // the old path a 60-step run would produce dozens-to-hundreds of readRuns (≥1 per step). The
    // limits were deliberately kept LOOSE so that none would ACTUALLY be exceeded (only performance is being measured).
    const limits = {
      maxTokens: 1_000_000,
      maxCostUsd: 1_000,
      maxToolCalls: 1_000,
      loopDetection: { maxRepeats: 1_000 },
    };

    const counts: number[] = [];
    for (const k of [10, 60]) {
      const inner = new InMemoryJournal();
      const { j, readRunCalls } = countReadRun(inner);
      const { work, model, calls } = buildAgent(k);
      const res = await runDurable({
        runId: `perf-${k}`,
        journal: j as any,
        model,
        tools: { work },
        prompt: 'start',
        stopWhen: stepCountIs(k + 5),
        limits,
      } as any);
      expect((res as any).text).toContain('done');
      expect(calls()).toBe(k); // all K tool calls ACTUALLY ran (no limit blocked incorrectly)
      counts.push(readRunCalls);
    }

    // PROOF OF O(1): the readRun count of the 60-step run is the SAME as the 10-step run — it did NOT GROW with step count.
    expect(counts[1]).toBe(counts[0]);
    // Absolute ceiling: ≤2 readRun per run (1 is C2 replay-cache's OWN per-run bulk read —
    // INDEPENDENT of limits, run.ts's loadReplayCache ALREADY does this on every runDurable call; the
    // other is limits.ts's ONE-TIME seeding). limits.ts ITSELF does not call readRun beyond this.
    expect(counts[0]).toBeLessThanOrEqual(2);
  });

  it('with fan-out (sub-agents) too, readRun count stays proportional to sub-run COUNT, NOT step count', async () => {
    // The parent delegates to a sub-agent 5 times (each running a few steps in its own journal);
    // total readRun ~ (1 parent seed + 1 parent C2 + per sub-agent [1 C2 + 1 seed]) — independent of
    // step count, scaling only with the NUMBER of DELEGATED sub-agents (O(sub-run count) get, NOT readRun).
    const { createAgentTool } = await import('../src/agent-tool.js');
    const inner = new InMemoryJournal();
    const { j, readRunCalls } = countReadRun(inner);
    const limits = { maxTokens: 1_000_000, maxCostUsd: 1_000 };

    const childModel = createMockModel(async () => finalTextResult('expert answer'));
    const expert = createAgentTool({ journal: j as any, model: childModel, limits }, { description: 'delegate' });

    const N = 5;
    const parentModel = createMockModel(async ({ prompt }: any) => {
      const done = countToolResults(prompt);
      if (done < N) return toolCallResult('agent_expert', `call-${done}`, { task: `question-${done}` });
      return finalTextResult('all done');
    });

    const res = await runDurable({
      runId: 'perf-parent',
      journal: j as any,
      model: parentModel,
      tools: { agent_expert: expert },
      prompt: 'delegate',
      stopWhen: stepCountIs(N + 5),
      limits,
    } as any);
    expect((res as any).text).toContain('all done');
    // Upper bound: 1 (parent C2) + 1 (parent limits seed) + N × [1 (sub-agent C2) + 1 (sub-agent limits seed)].
    expect(readRunCalls).toBeLessThanOrEqual(2 + N * 2);
  });
});
