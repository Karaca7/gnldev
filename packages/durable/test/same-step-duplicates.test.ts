// Two identical tool calls in ONE model step.
//
// The AI SDK runs a step's tool calls with Promise.all, so they are genuinely concurrent. The
// duplicate guard reads its marker at the start of a call and writes it in writeToolTerminal — after
// execute has already returned. Both calls therefore read `undefined`, both proceed, and both charge
// the card. The per-toolCallId claim does not save it either: the two calls have different
// toolCallIds by construction, so they claim different keys.
//
// The sequential case (the model re-plans in a LATER step) is already handled and is covered by
// readme-quickstart-duplicate.test.ts. This file is the same-step case, which nothing covered.
//
// `sideEffectDuplicates: 'block'` is the important row. An operator who sets it has been told
// duplicates are impossible; a guard that silently does not hold is worse than one that was never
// offered.
import { describe, it, expect, vi } from 'vitest';
import { runDurable, InMemoryStorage } from '../src/index.js';
import { tool } from 'ai';
import { z } from 'zod';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

/** One step, two identical calls, different toolCallIds — what a model does when it double-books. */
function twoIdenticalCallsInOneStep() {
  return {
    specificationVersion: 'v2',
    provider: 'scripted',
    modelId: 'double-booker',
    supportedUrls: {},
    doGenerate: async ({ prompt }: any) => {
      const done = (prompt ?? []).filter((m: any) => m.role === 'tool').length;
      if (done === 0) {
        const call = (id: string) => ({
          type: 'tool-call' as const,
          toolCallId: id,
          toolName: 'chargeCard',
          input: JSON.stringify({ amount: 2000 }),
        });
        return { content: [call('call-A'), call('call-B')], finishReason: 'tool-calls', usage, warnings: [] };
      }
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
    execute: async () => {
      charges++;
      // Give the sibling call a chance to interleave; without this the two can serialise by luck and
      // the test would pass for the wrong reason.
      await new Promise((r) => setTimeout(r, 20));
      return { chargeId: `ch_${charges}` };
    },
  });
  Object.assign(t, { sideEffect: true }, extra);
  return { chargeCard: t as any, charges: () => charges };
}

async function run(runId: string, tools: any, limits?: any) {
  return runDurable({
    runId,
    journal: new InMemoryStorage().runs,
    model: twoIdenticalCallsInOneStep(),
    tools,
    ...(limits ? { limits } : {}),
    prompt: 'charge it',
  }).catch((e) => e);
}

describe('two identical side-effect calls in the same model step', () => {
  it("'block' blocks — the operator asked for a hard stop and gets one", async () => {
    const { chargeCard, charges } = chargeTool();
    await run('same-block', { chargeCard }, { sideEffectDuplicates: 'block' });
    expect(charges()).toBe(1);
  });

  it("'suspend' does not execute the second one either", async () => {
    const { chargeCard, charges } = chargeTool();
    await run('same-suspend', { chargeCard }, { sideEffectDuplicates: 'suspend' });
    expect(charges()).toBe(1);
  });

  it("idempotency: 'args' collapses them onto one journal record", async () => {
    const { chargeCard, charges } = chargeTool({ idempotency: 'args' });
    await run('same-args', { chargeCard });
    expect(charges()).toBe(1);
  });

  it("'warn' is documented as permissive, so it stays permissive — but it warns", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { chargeCard, charges } = chargeTool();
    await run('same-warn', { chargeCard });
    expect(charges()).toBe(2);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
