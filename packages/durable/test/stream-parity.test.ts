// run/stream parity: the processor pipeline + memory go through the same helpers in streamDurable
// as in runDurable. The input processor is applied to the journaled input in streaming too and does
// NOT RE-RUN on resume; the tool processor restricts the set the model sees; the output processor is
// applied ONLY to persisted (memory-written) messages.
import { describe, it, expect } from 'vitest';
import { stepCountIs, tool } from 'ai';
import { z } from 'zod';
import { InMemoryJournal, runKeys } from '../src/journal.js';
import { BasicMemory } from '../src/memory.js';
import { streamDurable } from '../src/run.js';
import type { Processor } from '../src/processor.js';
import { createMockStreamAgent } from './mock.js';

const usage = { inputTokens: 5, outputTokens: 5, totalTokens: 10 };

/** Fixed text stream; leaks the options (prompt/tools) received by doStream to the outside. */
function textStreamModel(text: string, seen: { prompts: any[]; tools: any[] }): any {
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'mock-stream',
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error('this mock is stream-only');
    },
    doStream: async (options: any) => {
      seen.prompts.push(options?.prompt);
      seen.tools.push(options?.tools ?? []);
      const stream = new ReadableStream({
        start(c) {
          c.enqueue({ type: 'stream-start', warnings: [] });
          c.enqueue({ type: 'text-start', id: '1' });
          c.enqueue({ type: 'text-delta', id: '1', delta: text });
          c.enqueue({ type: 'text-end', id: '1' });
          c.enqueue({ type: 'finish', finishReason: 'stop', usage });
          c.close();
        },
      });
      return { stream };
    },
  };
}

async function waitFor(cond: () => Promise<boolean>, ms = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('waitFor: condition timed out');
}

describe('stream-parity: processor pipeline within streamDurable', () => {
  it('input processor: input is transformed and journaled; does NOT re-run on resume', async () => {
    const journal = new InMemoryJournal();
    const runs = { input: 0 };
    const redactor: Processor = {
      name: 'redactor',
      processInput: (pin) => {
        runs.input++;
        return { ...pin, prompt: String(pin.prompt).replace('SECRET', '[REDACTED]') };
      },
    };

    const seen1 = { prompts: [] as any[], tools: [] as any[] };
    const r1 = await streamDurable({
      runId: 'sp1', journal, model: textStreamModel('ok', seen1),
      prompt: 'SECRET charge', processors: [redactor], stopWhen: stepCountIs(3),
    });
    await r1.text;
    expect(runs.input).toBe(1);
    // Transformed input was journaled → resume is self-contained + redacted
    const input = await journal.get<{ prompt?: string }>(runKeys.input('sp1'));
    expect(input?.prompt).toBe('[REDACTED] charge');
    // The model saw the transformed prompt
    expect(JSON.stringify(seen1.prompts[0])).toContain('[REDACTED]');
    expect(JSON.stringify(seen1.prompts[0])).not.toContain('SECRET');

    // Resume (same runId): input is journaled → processor does NOT re-run
    const seen2 = { prompts: [] as any[], tools: [] as any[] };
    const r2 = await streamDurable({
      runId: 'sp1', journal, model: textStreamModel('ok', seen2),
      prompt: 'SECRET charge', processors: [redactor], stopWhen: stepCountIs(3),
    });
    await r2.text;
    expect(runs.input).toBe(1);
  });

  it('tool processor: the tool set the model sees is restricted in streaming too', async () => {
    const journal = new InMemoryJournal();
    const onlySafe: Processor = {
      name: 'toolFilter',
      processTools: (tools) => Object.fromEntries(Object.entries(tools).filter(([n]) => n !== 'dangerous')),
    };
    const seen = { prompts: [] as any[], tools: [] as any[] };
    const r = await streamDurable({
      runId: 'sp2', journal, model: textStreamModel('ok', seen),
      prompt: 'hi', processors: [onlySafe], stopWhen: stepCountIs(3),
      tools: {
        safe: tool({ description: 'safe', inputSchema: z.object({}), execute: async () => 'ok' }),
        dangerous: tool({ description: 'nope', inputSchema: z.object({}), execute: async () => 'boom' }),
      },
    });
    await r.text;
    const toolNames = (seen.tools[0] ?? []).map((t: any) => t?.name);
    expect(toolNames).toContain('safe');
    expect(toolNames).not.toContain('dangerous');
  });

  it('output processor: applied only to persisted messages (memory append)', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const outRedactor: Processor = {
      name: 'outRedactor',
      processOutput: (pout) => ({
        ...pout,
        messages: pout.messages.map((m: any) => ({
          ...m,
          content: JSON.parse(JSON.stringify(m.content).replaceAll('TOKEN', '[CONFIDENTIAL]')),
        })),
      }),
    };
    const seen = { prompts: [] as any[], tools: [] as any[] };
    const r = await streamDurable({
      runId: 'sp3', journal, model: textStreamModel('response contains TOKEN', seen),
      memory, threadId: 't1', prompt: 'hello', processors: [outRedactor], stopWhen: stepCountIs(3),
    });
    // The streamed delta is NOT transformed (documented boundary) — raw text streams through
    expect(await r.text).toContain('TOKEN');
    // Persisted messages ARE transformed (onFinish is async → wait for the ACTUAL content; the marker
    // is now written BEFORE the claim: it's a "claimed" signal, not "finished").
    await waitFor(async () => (await memory.getMessages('t1')).length > 0);
    const saved = await memory.getMessages('t1');
    const flat = JSON.stringify(saved);
    expect(flat).toContain('[CONFIDENTIAL]');
    expect(flat).not.toContain('TOKEN');
  });

  it('suspend parity: while suspended onFinish does NOT process memory/marker/usage; approved resume writes the final answer', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const guard = async ({ toolName }: any) =>
      toolName === 'chargeCard' ? ({ action: 'require-approval' as const }) : ({ action: 'allow' as const });
    const chargeTools = {
      chargeCard: tool({
        description: 'payment',
        inputSchema: z.object({ amount: z.number() }),
        execute: async ({ amount }) => ({ charged: amount }),
      }),
    };

    // Run 1 — no approval: guard suspends. The old behavior wrote the half-finished conversation to
    // memory and locked the marker (the resume's final answer would NEVER land in memory) — this proves
    // the parity fix.
    const r1 = await streamDurable({
      runId: 'sp4', journal, memory, threadId: 't4', guard,
      model: createMockStreamAgent(), tools: chargeTools, prompt: 'pay', stopWhen: stepCountIs(4),
    });
    await r1.text; // drain the stream (triggers onFinish)
    await new Promise((r) => setTimeout(r, 30)); // onFinish is async — let it run
    expect(await journal.get(runKeys.memAppended('sp4'))).toBeUndefined(); // marker NOT locked
    expect(await memory.getMessages('t4')).toEqual([]); // half-finished conversation NOT written
    expect(await journal.get('sp4:usage-counted')).toBeUndefined(); // usage NOT counted while suspended

    // Run 2 — approved resume: step-0 stream replays from the journal, the tool ACTUALLY runs, the final is live.
    const r2 = await streamDurable({
      runId: 'sp4', journal, memory, threadId: 't4', guard,
      model: createMockStreamAgent(), tools: chargeTools, prompt: 'pay',
      approvals: { 'call-charge': true }, stopWhen: stepCountIs(4),
    });
    await r2.text;
    await waitFor(async () => (await memory.getMessages('t4')).length > 0);
    const flat4 = JSON.stringify(await memory.getMessages('t4'));
    expect(flat4).toContain('Charged'); // FINAL answer is in memory — impossible under the old behavior
    expect(await journal.get(runKeys.memAppended('sp4'))).toBeDefined();
  });
});
