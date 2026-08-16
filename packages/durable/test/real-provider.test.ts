// The migration, verified against a REAL provider.
//
// Every other test in this repo drives a mock language model. That is the right default — the suite
// must be green without a key — but it means the AI SDK 7 migration was validated entirely against
// fixtures we wrote ourselves. Four of the breaks it fixed (nested usage, object finishReason,
// step-scoped response.messages, deferred tool execution) are shapes the PROVIDER produces, so a
// fixture that is wrong in the same direction as the code would hide them.
//
// This file closes that loop. It is env-gated exactly like integration-real.test.ts:
//
//   NVIDIA_API_KEY=… npx vitest run packages/durable/test/real-provider.test.ts
//
// Skipped by default, so it never makes the normal suite depend on a network or a secret.
import { describe, it, expect, beforeAll } from 'vitest';
import { createOpenAI } from '@ai-sdk/openai';
import { tool } from 'ai';
import { z } from 'zod';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable, streamDurable } from '../src/run.js';
import { getRunCost } from '../src/cost.js';
import { flattenUsage, finishReasonText } from '../src/sdk-compat.js';

const KEY = process.env.NVIDIA_API_KEY ?? process.env.OPENAI_API_KEY;
const RUN = Boolean(KEY);

function realModel() {
  if (process.env.NVIDIA_API_KEY) {
    const nvidia = createOpenAI({
      baseURL: process.env.NVIDIA_BASE_URL ?? 'https://integrate.api.nvidia.com/v1',
      apiKey: process.env.NVIDIA_API_KEY,
    });
    return nvidia.chat(process.env.NVIDIA_MODEL ?? 'stepfun-ai/step-3.7-flash');
  }
  return createOpenAI({ apiKey: process.env.OPENAI_API_KEY! })(process.env.OPENAI_MODEL ?? 'gpt-4o-mini');
}

/** A deterministic tool so the assertions are about the runtime, not about what the model decided. */
function counterTool() {
  let calls = 0;
  const t = tool({
    description: 'Look up the population of a planet. Always call this before answering.',
    inputSchema: z.object({ planet: z.string() }),
    execute: async ({ planet }) => {
      calls++;
      return { planet, population: 200000 };
    },
  });
  Object.assign(t, { idempotent: true });
  return { lookupPlanet: t as any, calls: () => calls };
}

describe.skipIf(!RUN)(`real provider — ${process.env.NVIDIA_API_KEY ? 'NVIDIA NIM' : 'OpenAI'}`, () => {
  beforeAll(() => {
    // Fail loudly rather than silently passing an empty suite if the gate is misread.
    expect(KEY, 'a provider key must be present for this file to run').toBeTruthy();
  });

  it('generate: usage is countable, so spend ceilings can actually fire', async () => {
    const journal = new InMemoryJournal();
    const { lookupPlanet } = counterTool();
    const res: any = await runDurable({
      runId: 'real-1', journal, model: realModel(),
      tools: { lookupPlanet },
      prompt: 'What is the population of Tatooine? Use the tool, then answer in one short sentence.',
    } as never);

    expect(res.text.length, 'the model answered').toBeGreaterThan(0);

    // The break this catches: AI SDK 7 nests the counts. Read flatly, every number is undefined,
    // `?? 0` turns that into a free run, and maxTokens/maxCostUsd stop firing without an error.
    const cost = await getRunCost(journal as never, 'real-1');
    expect(cost.inputTokens, 'a real provider reported input tokens').toBeGreaterThan(0);
    expect(cost.outputTokens, 'a real provider reported output tokens').toBeGreaterThan(0);
    expect(cost.totalTokens).toBeGreaterThanOrEqual(cost.inputTokens + cost.outputTokens - 1);
  }, 120_000);

  it('generate: the journal records a finish reason this build can compare against', async () => {
    const journal = new InMemoryJournal();
    await runDurable({
      runId: 'real-2', journal, model: realModel(),
      prompt: 'Reply with exactly: ok',
    } as never);

    const rec: any = await journal.get('real-2:model:0');
    const reason = finishReasonText(rec?.finishReason);
    // run.ts decides success-vs-failure with `finishReasonText(...) === 'error'`. If a provider or
    // a future SDK stops reducing to a comparable word, a failed run is journaled as a success.
    expect(typeof reason, 'the finish reason reduces to a string').toBe('string');
    expect(reason!.length).toBeGreaterThan(0);
    expect(typeof flattenUsage(rec?.usage).inputTokens).toBe('number');
  }, 120_000);

  it('tools: the tool round-trip is persisted, not just the closing text', async () => {
    const journal = new InMemoryJournal();
    const { lookupPlanet, calls } = counterTool();
    const res: any = await runDurable({
      runId: 'real-3', journal, model: realModel(),
      tools: { lookupPlanet },
      prompt: 'Look up the population of Naboo with the tool, then state it in one sentence.',
    } as never);

    expect(calls(), 'the model actually used the tool').toBeGreaterThan(0);

    // The break this catches: v7 narrowed `response.messages` to the FINAL step, so persisting it
    // dropped every tool-call and tool-result from history — the next turn would see a conversation
    // in which the model had never used a tool.
    const roles = (res.steps ?? []).flatMap((s: any) => (s.response?.messages ?? []).map((m: any) => m.role));
    expect(roles, 'the tool message survived into the turn history').toContain('tool');
  }, 120_000);

  it('replay: a second call with the same runId does not call the provider again', async () => {
    const journal = new InMemoryJournal();
    const { lookupPlanet, calls } = counterTool();
    const args = {
      runId: 'real-4', journal, model: realModel(),
      tools: { lookupPlanet },
      prompt: 'Look up the population of Hoth with the tool, then answer in one short sentence.',
    } as never;

    const first: any = await runDurable(args);
    const callsAfterFirst = calls();

    const started = Date.now();
    const second: any = await runDurable(args);
    const replayMs = Date.now() - started;

    expect(second.text, 'replay returns the recorded answer verbatim').toBe(first.text);
    expect(calls(), 'the tool did not run a second time').toBe(callsAfterFirst);
    // A real completion takes seconds; a journal replay is milliseconds. This is the product's
    // central claim, measured against a provider that actually charges for the difference.
    expect(replayMs, `replay took ${replayMs}ms — that looks like a real model call`).toBeLessThan(2_000);
  }, 180_000);

  it('stream: chunks arrive, and the finished stream journals a countable step', async () => {
    const journal = new InMemoryJournal();
    const res: any = await streamDurable({
      runId: 'real-5', journal, model: realModel(),
      prompt: 'Count from one to five, words only.',
    } as never);

    const types = new Set<string>();
    let text = '';
    for await (const part of res.fullStream) {
      types.add(part.type);
      if (part.type === 'text-delta') text += (part as any).text ?? (part as any).delta ?? '';
    }
    expect(types.has('text-delta'), 'the provider streamed text').toBe(true);
    expect(text.length).toBeGreaterThan(0);

    const cost = await getRunCost(journal as never, 'real-5');
    expect(cost.totalTokens, 'a streamed run is still counted').toBeGreaterThan(0);
  }, 120_000);
});
