// The README's quickstart, exactly as written, against the case the README itself calls the
// dominant real-world duplicate: the model re-plans the same call under a NEW toolCallId.
//
// `sideEffect: true` alone does not stop that. The default duplicate policy is `'warn'`
// (durable-tool.ts: `ctx.limits?.sideEffectDuplicates ?? 'warn'`), which records an incident, warns,
// and then executes. Stopping it needs either `idempotency: 'args'` on the tool or
// `limits.sideEffectDuplicates: 'block'` on the run.
//
// This test exists so the README cannot drift back: if the quickstart's configuration stops being
// sufficient for its own headline scenario, this fails.
import { describe, it, expect, vi } from 'vitest';
import { runDurable, InMemoryStorage } from '../src/index.js';
import { tool } from 'ai';
import { z } from 'zod';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

/**
 * Asks for the SAME charge twice, under two different toolCallIds — what a model does when it
 * re-plans after a tool result it did not like. Both calls carry identical arguments.
 */
function replansTheSameCharge() {
  return {
    specificationVersion: 'v2',
    provider: 'scripted',
    modelId: 'replanner',
    supportedUrls: {},
    doGenerate: async ({ prompt }: any) => {
      const done = (prompt ?? []).filter((m: any) => m.role === 'tool').length;
      if (done === 0)
        return { content: [{ type: 'tool-call', toolCallId: 'call-A', toolName: 'chargeCard', input: JSON.stringify({ amount: 2000 }) }], finishReason: 'tool-calls', usage, warnings: [] };
      if (done === 1)
        return { content: [{ type: 'tool-call', toolCallId: 'call-B', toolName: 'chargeCard', input: JSON.stringify({ amount: 2000 }) }], finishReason: 'tool-calls', usage, warnings: [] };
      return { content: [{ type: 'text', text: 'done' }], finishReason: 'stop', usage, warnings: [] };
    },
    doStream: async () => { throw new Error('generate-only'); },
  } as any;
}

function chargeTool(extra: Record<string, unknown> = {}) {
  let charges = 0;
  const t = tool({
    description: "Charge the customer's card",
    inputSchema: z.object({ amount: z.number() }),
    execute: async () => { charges++; return { chargeId: `ch_${charges}` }; },
  });
  Object.assign(t, { sideEffect: true }, extra);
  return { chargeCard: t as any, charges: () => charges };
}

describe("the README quickstart's own headline scenario", () => {
  it('sideEffect alone does NOT stop a re-planned duplicate — it warns and charges again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { chargeCard, charges } = chargeTool();
    await runDurable({
      runId: 'dup-warn',
      journal: new InMemoryStorage().runs,
      model: replansTheSameCharge(),
      tools: { chargeCard },
      prompt: 'charge it',
    });
    expect(charges()).toBe(2);                       // the documented default, made visible
    expect(warn).toHaveBeenCalled();                 // not silent, but not prevented either
    warn.mockRestore();
  });

  it("idempotency: 'args' is what makes the quickstart's promise true", async () => {
    const { chargeCard, charges } = chargeTool({ idempotency: 'args' });
    await runDurable({
      runId: 'dup-args',
      journal: new InMemoryStorage().runs,
      model: replansTheSameCharge(),
      tools: { chargeCard },
      prompt: 'charge it',
    });
    expect(charges()).toBe(1);
  });

  it("limits.sideEffectDuplicates: 'block' does it run-wide, and says so loudly", async () => {
    const { chargeCard, charges } = chargeTool();
    // 'block' stops the duplicate by failing the run, which is a different trade from 'args':
    // nothing is charged twice, but the run does not finish on its own either.
    await expect(
      runDurable({
        runId: 'dup-block',
        journal: new InMemoryStorage().runs,
        model: replansTheSameCharge(),
        tools: { chargeCard },
        limits: { sideEffectDuplicates: 'block' },
        prompt: 'charge it',
      }),
    ).rejects.toThrow(/duplicate blocked, this call was NOT EXECUTED/);
    expect(charges()).toBe(1);
  });
});
