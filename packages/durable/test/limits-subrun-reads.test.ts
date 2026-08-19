// Summing sub-run cost must not cost one round trip per tool call, per step, forever.
//
// `chain.subRunIds` collects EVERY tool call the run has made, and `enforceStepLimits` re-runs
// `sumSubRuns` over the whole list on EVERY model step, probing two key shapes per id (the
// parent-scoped one and the legacy bare one). Almost none of those ids are sub-agents, so almost every
// probe is a miss — and the same misses are re-probed on every subsequent step. Measured with one tool
// call per step, counting only counter reads:
//
//   10 steps →   200      30 steps →  1800      60 steps →  7200      (= 2k²)
//
// Cheap against a local store. Against Postgres it is 7200 network round trips inside one run's spend
// check, and it grows with the square of how long the agent works.
//
// The fix caches MISSES per store. A miss is permanent because a toolCallId only enters `subRunIds`
// from `recordToolOutcome`, which durable-tool.ts calls when it writes the tool's OUTCOME — the tool's
// execute has already returned by then, so a sub-agent it ran has already written its counters.
//
// HITS are never cached, and that is the half worth guarding: a sub-agent's counters are exactly the
// live value the ceiling depends on. Nothing in the suite covered it — an over-eager cache that also
// swallowed hits was measured against nested-run-legacy-shape.test.ts, run-limits.test.ts and
// limits-perf.test.ts, and all 11 stayed green, because each of those calls enforceStepLimits ONCE and
// a cache cannot show up until the second read. That is what this file exists for.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, runKeys, RunLimitExceededError } from '../src/index.js';
import { enforceStepLimits } from '../src/limits.js';

const NESTED = 'sub-1';

/** Parent chain naming one sub-run, plus that sub-run's counters at `tokens`. */
async function seed(journal: any, parentRunId: string, tokens: number) {
  await journal.put(runKeys.proc(parentRunId, '__gnl_limits_state'), {
    lastToolName: undefined, lastArgsHash: undefined, consecutiveRepeats: 0, subRunIds: [NESTED],
  });
  await journal.put(runKeys.proc(`agent:${NESTED}`, '__gnl_limits_counters'), {
    modelStepsSeen: 1, totalTokens: tokens, costUsd: 0, succeededToolCalls: 0,
  });
}

/** Counts the counter point-reads a call makes, without altering behaviour. */
function counting(journal: any) {
  const counts = { counters: 0 };
  const proxy = new Proxy(journal, {
    get(target: any, prop) {
      if (prop === 'get') {
        return async (key: string) => {
          if (String(key).includes('__gnl_limits_counters')) counts.counters++;
          return target.get(key);
        };
      }
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { counts, proxy };
}

describe('sub-run cost summing', () => {
  it('sees a sub-agent that GROWS between two steps', async () => {
    // The invariant the miss-cache must not break. A sub-agent suspended for approval, or simply still
    // being read on a later step, has counters that keep moving; caching a hit would freeze the
    // parent's view of them at whatever they were the first time — a ceiling that stops rising while
    // the spend does.
    const journal = new InMemoryStorage().runs;
    await seed(journal, 'grow-1', 10);

    // Under the ceiling on the first check.
    await expect(
      enforceStepLimits(journal as never, 'grow-1', { maxTokens: 1000 } as never, {}),
    ).resolves.toBeUndefined();

    // The sub-agent keeps working.
    await journal.put(runKeys.proc(`agent:${NESTED}`, '__gnl_limits_counters'), {
      modelStepsSeen: 2, totalTokens: 5000, costUsd: 0, succeededToolCalls: 0,
    });

    await expect(
      enforceStepLimits(journal as never, 'grow-1', { maxTokens: 1000 } as never, {}),
      'the sub-agent grew past the ceiling and the parent did not notice',
    ).rejects.toBeInstanceOf(RunLimitExceededError);
  });

  it('a sub-run that never existed is probed once, not once per step', async () => {
    // The cost being removed. `absent-1` names ten tool calls that are not sub-agents; before the
    // cache each check re-probed all ten (two key shapes each) and the work grew with the step count.
    const journal = new InMemoryStorage().runs;
    await journal.put(runKeys.proc('absent-1', '__gnl_limits_state'), {
      lastToolName: undefined, lastArgsHash: undefined, consecutiveRepeats: 0,
      subRunIds: Array.from({ length: 10 }, (_, i) => `call-${i}`),
    });
    const { counts, proxy } = counting(journal);

    await enforceStepLimits(proxy as never, 'absent-1', { maxTokens: 1_000_000 } as never, {});
    const firstPass = counts.counters;
    expect(firstPass, 'the first check should still probe every candidate').toBeGreaterThanOrEqual(10);

    counts.counters = 0;
    for (let step = 0; step < 5; step++) {
      await enforceStepLimits(proxy as never, 'absent-1', { maxTokens: 1_000_000 } as never, {});
    }
    // Five further checks must not repeat the ten misses; only the run's OWN counter key is read.
    expect(counts.counters, `five later checks re-probed absent sub-runs (${counts.counters} reads)`)
      .toBeLessThan(firstPass);
  });

  it('still counts a sub-run present from the very first check', async () => {
    // Guards the other direction of the cache: `absent` must not be consulted before the read that
    // would populate it, or a real sub-agent is skipped on step one and never looked at again.
    const journal = new InMemoryStorage().runs;
    await seed(journal, 'hit-1', 5000);

    await expect(
      enforceStepLimits(journal as never, 'hit-1', { maxTokens: 1000 } as never, {}),
      'a sub-run with counters already on disk was not counted at all',
    ).rejects.toBeInstanceOf(RunLimitExceededError);
  });
});

// The same invariant through the real API, not hand-seeded keys.
//
// run-limits.test.ts already pins that a sub-agent's spend counts toward the parent's ceiling, but it
// fires on the step immediately after the hand-off — the FIRST read of the nested counter, where a
// cache cannot show up yet. That is why an over-eager cache passed it. Here the parent keeps working
// for several more steps first, so the nested counter has to be read again after the miss-cache has
// been populated by the parent's own noop calls.
describe('fan-out spend after the parent keeps working', () => {
  it('the sub-agent\'s cost is still counted many steps later', async () => {
    const { runDurable, createAgentTool, gnlTool } = await import('../src/index.js');
    const { stepCountIs } = await import('ai');
    const { z } = await import('zod');
    const journal = new InMemoryStorage().runs;

    const bigUsage = { inputTokens: 300_000, outputTokens: 300_000, totalTokens: 600_000 };
    const childModel: any = {
      specificationVersion: 'v2', provider: 'mock', modelId: 'gpt-4o', supportedUrls: {},
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'sub' }], finishReason: 'stop',
        usage: bigUsage, warnings: [], response: { modelId: 'gpt-4o' },
      }),
      doStream: async () => { throw new Error('generate-only'); },
    };
    // A ceiling the sub-agent alone does not hit, so it completes and leaves its counters behind.
    const expert = createAgentTool({ journal, model: childModel, limits: { maxCostUsd: 1000 } } as never);
    const noop = gnlTool({ description: 'noop', inputSchema: z.object({}), execute: async () => ({ ok: true }) } as never);

    let step = 0;
    const parentModel: any = {
      specificationVersion: 'v2', provider: 'mock', modelId: 'gpt-4o', supportedUrls: {},
      doGenerate: async () => {
        step++;
        const small = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
        if (step === 1) {
          return { content: [{ type: 'tool-call', toolCallId: 'call-sub', toolName: 'agent_expert', input: JSON.stringify({ task: 'go' }) }], finishReason: 'tool-calls', usage: small, warnings: [], response: { modelId: 'gpt-4o' } };
        }
        if (step <= 6) {
          return { content: [{ type: 'tool-call', toolCallId: `noop-${step}`, toolName: 'noop', input: '{}' }], finishReason: 'tool-calls', usage: small, warnings: [], response: { modelId: 'gpt-4o' } };
        }
        return { content: [{ type: 'text', text: 'done' }], finishReason: 'stop', usage: small, warnings: [], response: { modelId: 'gpt-4o' } };
      },
      doStream: async () => { throw new Error('generate-only'); },
    };

    // A ceiling high enough that the run completes — the point is what is VISIBLE afterwards.
    await runDurable({
      runId: 'fan-1', journal, model: parentModel, tools: { agent_expert: expert, noop },
      prompt: 'delegate', stopWhen: stepCountIs(12), limits: { maxCostUsd: 1000 },
    } as never);
    expect(step, 'the parent should have kept working after the hand-off').toBeGreaterThan(5);

    // 600k tokens at gpt-4o rates is $3.75; the parent's own steps add cents.
    await expect(
      enforceStepLimits(journal as never, 'fan-1', { maxCostUsd: 1 } as never, {}),
      'after several later steps the sub-agent\'s spend was no longer visible to the ceiling',
    ).rejects.toBeInstanceOf(RunLimitExceededError);
  });
});
