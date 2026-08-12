// JOURNAL GROWTH / REPLAY COST — a characterization of the internal audit §3.2.
//
// QUESTION: "in very long-running runs, does the journal grow without bound; is replay read from
// scratch every time, or is there a snapshot/compaction?"
//
// This file makes the CURRENT behavior measurable (it does not change behavior):
//   1. Growth: within a run, the journal is O(steps) — each model step + tool call is 1 entry each (NO compaction).
//   2. Replay cost: EXACTLY 1 bulk `readRun` per resume (C2 replayCache) + a small number of point
//      `get` calls INDEPENDENT of step count — i.e. replay is O(N) but in a SINGLE query; no get storm proportional to N.
//   3. During replay, the LLM/tool NEVER run (the cost is read-only).
// Analysis of the compaction/snapshot gap: the core-hardening review.
import { describe, it, expect } from 'vitest';
import { stepCountIs } from 'ai';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

/** Wraps the journal with a counter: counts point get / bulk readRun / put calls (behavior is delegated as-is). */
function countingJournal(inner: InMemoryJournal) {
  const stats = { get: 0, readRun: 0, put: 0 };
  const j = {
    get: (k: string) => (stats.get++, inner.get(k)),
    put: (k: string, v: unknown) => (stats.put++, inner.put(k, v)),
    putIfAbsent: (k: string, v: unknown) => inner.putIfAbsent(k, v),
    listKeys: (p: string) => inner.listKeys(p),
    deletePrefix: (p: string) => inner.deletePrefix(p),
    readRun: (r: string) => (stats.readRun++, inner.readRun(r)),
    listRuns: () => inner.listRuns(),
  };
  return { j, stats, reset: () => { stats.get = 0; stats.readRun = 0; stats.put = 0; } };
}

/** Builds an agent run with K tool calls: the model calls the tool K times, then produces final text. */
function agentOf(k: number, counters: { model: number; tool: number }) {
  const tools = {
    work: {
      execute: async () => {
        counters.tool++;
        return { ok: true };
      },
    },
  };
  const model = createMockModel(async ({ prompt }: any) => {
    counters.model++;
    const done = countToolResults(prompt);
    return done < k ? toolCallResult('work', `call-${done}`, { i: done }) : finalTextResult('done');
  });
  return { tools, model };
}

async function runOnce(j: any, runId: string, k: number, counters: { model: number; tool: number }) {
  const { tools, model } = agentOf(k, counters);
  return runDurable({ runId, journal: j, model, tools, prompt: 'x', stopWhen: stepCountIs(k + 2) } as any);
}

describe('§3.2 journal growth + replay cost (characterization)', () => {
  it('within-run growth is O(steps): a K-tool run → K+1 model + K tool entries (no compaction)', async () => {
    for (const k of [3, 10]) {
      const inner = new InMemoryJournal();
      const c = { model: 0, tool: 0 };
      await runOnce(inner, 'r', k, c);
      const entries = await inner.readRun('r');
      const models = entries.filter((e) => e.kind === 'model').length;
      const toolsN = entries.filter((e) => e.kind === 'tool').length;
      expect(models).toBe(k + 1); // K tool-rounds + 1 final
      expect(toolsN).toBe(k);
      // Linear growth constant: entry = 2K+1. IF snapshot/compaction existed, this number would drop.
      expect(entries.length).toBe(2 * k + 1);
    }
  });

  it('resume: EXACTLY 1 bulk readRun; point get count INDEPENDENT of step count; LLM/tool do not run', async () => {
    // Compare the point-get cost of replay on a small (K=3) and a large (K=15) run:
    // the C2 replayCache loads all entries in a SINGLE readRun → the get count should NOT GROW with N.
    const getCounts: number[] = [];
    for (const k of [3, 15]) {
      const inner = new InMemoryJournal();
      const { j, stats, reset } = countingJournal(inner);
      const c = { model: 0, tool: 0 };
      await runOnce(j, 'r', k, c); // first run: fills the journal
      expect(c.model).toBe(k + 1);
      expect(c.tool).toBe(k);

      reset();
      c.model = 0; c.tool = 0;
      const res = await runOnce(j, 'r', k, c); // resume/replay: same runId
      expect((res as any).text).toBe('done');
      expect(c.model).toBe(0); // the LLM was NEVER called → replay is free (no token cost)
      expect(c.tool).toBe(0); // the tool side effect did NOT run again (exactly-once)
      expect(stats.readRun).toBe(1); // C2: a single bulk snapshot read
      getCounts.push(stats.get);
    }
    // Point gets (fixed keys like input/lock/cfg) should not scale with step count:
    // the get count at K=15 should be the SAME as at K=3 (O(1)); if it were per-entry it would be ~5x.
    expect(getCounts[1]).toBe(getCounts[0]);
  });

  it('replay is read FROM SCRATCH on every resume: total readRun cost is multiplied by resume count', async () => {
    // Proof that snapshot/checkpoint does NOT EXIST: M resumes → M full readRuns (each O(N) rows).
    const inner = new InMemoryJournal();
    const { j, stats } = countingJournal(inner);
    const c = { model: 0, tool: 0 };
    await runOnce(j, 'r', 5, c);
    const before = stats.readRun;
    for (let m = 0; m < 3; m++) await runOnce(j, 'r', 5, c);
    expect(stats.readRun - before).toBe(3); // each resume is 1 full read → O(N·M) total row reads
  });
});
