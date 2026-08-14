// Scoping the sub-agent runId to its parent changed the SHAPE of a key that two subsystems re-derive
// rather than observe: limits.ts sums a sub-run's cost into the parent's ceiling, and retention.ts
// cascades a purge into it. Both now look for `agent:<parentRunId>:<toolCallId>`.
//
// A journal written before that change holds the bare `agent:<toolCallId>`. If the derivation sites
// only knew the new shape, an existing deployment would silently stop counting sub-agent spend toward
// its budget (the limit-BREACH direction) and stop purging sub-agent PII (a GDPR obligation, missed
// quietly). So both sites check both shapes; this pins that, because a comment cannot fail.
import { describe, it, expect } from 'vitest';
import { runDurable, InMemoryStorage, runKeys, purgeRun, RunLimitExceededError } from '../src/index.js';

const usage = { inputTokens: 5, outputTokens: 5, totalTokens: 10 };

function plainModel() {
  return {
    specificationVersion: 'v2', provider: 'scripted', modelId: 'plain', supportedUrls: {},
    doGenerate: async () => ({ content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage, warnings: [] }),
    doStream: async () => { throw new Error('generate-only'); },
  } as any;
}

/** Writes the parent chain + a sub-run counter in the pre-scoping shape. */
async function seedLegacySubRun(journal: any, parentRunId: string, toolCallId: string, tokens: number) {
  await journal.put(runKeys.proc(parentRunId, '__gnl_limits_state'), {
    lastToolName: undefined, lastArgsHash: undefined, consecutiveRepeats: 0, subRunIds: [toolCallId],
  });
  await journal.put(runKeys.proc(`agent:${toolCallId}`, '__gnl_limits_counters'), {
    modelStepsSeen: 1, totalTokens: tokens, costUsd: 0, succeededToolCalls: 0,
  });
}

describe('a journal written before sub-agent runIds were parent-scoped', () => {
  it("still counts the legacy sub-run's tokens toward the parent's ceiling", async () => {
    const journal = new InMemoryStorage().runs;
    // 500 tokens already spent by a sub-agent under the OLD key; the parent's own step adds 10.
    await seedLegacySubRun(journal, 'legacy-cost', 'old-call', 500);

    await expect(
      runDurable({
        runId: 'legacy-cost', journal, model: plainModel(), prompt: 'go',
        limits: { maxTokens: 100 },
      } as any),
    ).rejects.toBeInstanceOf(RunLimitExceededError);
  });

  it('still cascades a purge into the legacy nested journal', async () => {
    const journal = new InMemoryStorage().runs;
    const parent = 'legacy-purge';
    // The parent's tool entry names the toolCallId; the child journal sits under the OLD shape.
    await journal.put(runKeys.tool(parent, 'old-call'), { status: 'succeeded', output: { text: 'x' } });
    await journal.put(runKeys.model(`agent:old-call`, 0), { content: ['sub-agent PII'] });

    expect((await journal.readRun('agent:old-call')).length).toBeGreaterThan(0);
    await purgeRun(journal, parent);
    expect(await journal.readRun('agent:old-call'), 'legacy child must not be left behind').toEqual([]);
  });
});
