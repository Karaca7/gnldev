// Proof test + supporting
// scenarios for the dominant double-side-effect case in the field (a documented AI SDK pattern — the model
// calls a tool multiple times in a single turn with the SAME arguments, EACH TIME with a
// DIFFERENT toolCallId). Uses the SAME harness/mock-model pattern as the existing tests
// (durable-tool.test.ts / concurrency.test.ts / reader.test.ts).
import { describe, it, expect, vi } from 'vitest';
import { stepCountIs } from 'ai';
import { InMemoryJournal, claim } from '../src/journal.js';
import { durableTool } from '../src/durable-tool.js';
import { runDurable } from '../src/run.js';
import { createMockModel, toolCallResult, finalTextResult } from './mock.js';

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('duplicate-toolCallId proof test — model calls the same tool 5x in a SINGLE turn with the same arguments, EACH WITH A DIFFERENT toolCallId', () => {
  // Real generateText loop: doGenerate returns 5 tool-calls in ONE turn (5 DIFFERENT toolCallIds,
  // SAME arguments) — the AI SDK's executeTools runs these in PARALLEL via Promise.all (verified,
  // see the limits.ts header). idempotency: 'args' must guarantee a SINGLE execution for this turn.
  function multiCallModel() {
    let turn = 0;
    return createMockModel(async () => {
      turn++;
      if (turn === 1) {
        return {
          content: Array.from({ length: 5 }, (_, i) => ({
            type: 'tool-call' as const,
            toolCallId: `call-${i + 1}`,
            toolName: 'charge',
            input: JSON.stringify({ amount: 20 }),
          })),
          finishReason: 'tool-calls' as const,
          usage,
          warnings: [] as any[],
        };
      }
      return finalTextResult('done');
    });
  }

  it('with idempotency: "args" → underlying execute runs EXACTLY 1 time, all 5 tool-results have the SAME output', async () => {
    const journal = new InMemoryJournal();
    let calls = 0;
    const tools = { charge: { idempotency: 'args' as const, execute: async () => { calls++; return { charged: 20, seq: calls }; } } };

    const result = await runDurable({ runId: 'r7261-args', journal, model: multiCallModel(), tools, stopWhen: stepCountIs(6), prompt: 'x' });

    expect(calls).toBe(1); // duplicate-toolCallId pattern: double (5x) side-effect PREVENTED
    // AI SDK 7 narrowed `response.messages` to the FINAL step's messages; tool results now live per
    // step. Searching every step is both correct here and correct under v5, where the tool message
    // also appears in its own step.
    const stepMessages = ((result as any).steps ?? []).flatMap((st: any) => st.response?.messages ?? []);
    const toolMsg = stepMessages.find((m: any) => m.role === 'tool');
    expect(toolMsg, 'no tool message was produced in any step').toBeDefined();
    const outputs = toolMsg.content.map((p: any) => p.output.value);
    expect(outputs).toHaveLength(5);
    for (const o of outputs) expect(o).toEqual({ charged: 20, seq: 1 }); // all outputs come from the SAME execution
  });

  it('with the default (idempotency unspecified → "call") → underlying execute runs 5 times (documents the CURRENT behavior)', async () => {
    const journal = new InMemoryJournal();
    let calls = 0;
    const tools = { charge: { execute: async () => { calls++; return { charged: 20, seq: calls }; } } };

    await runDurable({ runId: 'r7261-call', journal, model: multiCallModel(), tools, stopWhen: stepCountIs(6), prompt: 'x' });

    expect(calls).toBe(5); // behavior BEFORE/AFTER the is IDENTICAL — no regression
  });
});

describe('args idempotency — sequential-turn duplicate (model produces SAME args + a NEW toolCallId in turn 2)', () => {
  it('in args mode the second call returns from the journal (cache) — underlying execute runs 1 time', async () => {
    const journal = new InMemoryJournal();
    let calls = 0;
    let call = 0;
    const model = createMockModel(async () => {
      call++;
      if (call === 1) return toolCallResult('charge', 'call-1', { amount: 20 });
      if (call === 2) return toolCallResult('charge', 'call-2', { amount: 20 }); // SAME args, NEW id
      return finalTextResult('done');
    });
    const tools = { charge: { idempotency: 'args' as const, execute: async () => { calls++; return { charged: 20 }; } } };

    const result = await runDurable({ runId: 'r-seq', journal, model, tools, stopWhen: stepCountIs(6), prompt: 'x' });

    expect(calls).toBe(1);
    expect(result.text).toBe('done');
  });
});

describe('args idempotency — PARALLEL duplicate within the SAME turn (losing the claim means poll, NOT RunBusyError)', () => {
  it('two concurrent executes (same args, different toolCallId) → one runs, the other gets the SAME output via poll', async () => {
    const journal = new InMemoryJournal();
    let calls = 0;
    const dt = durableTool(
      {
        idempotency: 'args' as const,
        execute: async () => { calls++; await sleep(30); return { ok: true, seq: calls }; },
      },
      { journal, runId: 'r-race' },
      'pay',
    );

    const [r1, r2] = await Promise.all([
      dt.execute!({ a: 1 }, { toolCallId: 'call-A' }),
      dt.execute!({ a: 1 }, { toolCallId: 'call-B' }),
    ]);

    expect(calls).toBe(1); // RunBusyError did NOT throw (Promise.all wasn't rejected) AND the body ran only once
    expect(r1).toEqual(r2); // both got the output of the SAME execution
  });
});

describe('args idempotency — custom idempotencyKey (e.g. orderId)', () => {
  it('different arguments but the SAME orderId → single execution; different orderId → two executions', async () => {
    const journal = new InMemoryJournal();
    let calls = 0;
    const dt = durableTool(
      {
        idempotencyKey: (args: any) => args.orderId, // IMPLIES 'args' mode
        execute: async (args: any) => { calls++; return { ok: true, orderId: args.orderId }; },
      },
      { journal, runId: 'r-key' },
      'charge',
    );

    const o1 = await dt.execute!({ orderId: 'o1', note: 'first' }, { toolCallId: 'x' });
    const o2 = await dt.execute!({ orderId: 'o1', note: 'DIFFERENT-field' }, { toolCallId: 'y' }); // same orderId
    expect(calls).toBe(1);
    expect(o2).toEqual(o1); // returned from cache — even though arguments differ, SAME logical key

    const o3 = await dt.execute!({ orderId: 'o2', note: 'second' }, { toolCallId: 'z' }); // DIFFERENT orderId
    expect(calls).toBe(2);
    expect(o3).toEqual({ ok: true, orderId: 'o2' });
  });
});

describe('args idempotency — crash/resume', () => {
  it('after a succeeded record (new durableTool instance, SAME journal/runId, NEW toolCallId) the tool does NOT RUN AGAIN', async () => {
    const journal = new InMemoryJournal();
    let calls = 0;
    const makeTool = () =>
      durableTool(
        { idempotency: 'args' as const, execute: async () => { calls++; return { charged: 5 }; } },
        { journal, runId: 'r-resume' },
        'charge',
      );

    const dt1 = makeTool();
    const o1 = await dt1.execute!({ amount: 5 }, { toolCallId: 'call-1' });
    expect(calls).toBe(1);

    // "resume": the process restarted (new durableTool wrapper), the model produced a NEW
    // toolCallId with the SAME arguments — the args-keyed journal record already exists → the tool does NOT run again.
    const dt2 = makeTool();
    const o2 = await dt2.execute!({ amount: 5 }, { toolCallId: 'call-2' });
    expect(calls).toBe(1);
    expect(o2).toEqual(o1);
  });
});

describe('args idempotency — different arguments get SEPARATE keys (no false-positive dedup)', () => {
  it('two calls with different arguments both run', async () => {
    const journal = new InMemoryJournal();
    let calls = 0;
    const dt = durableTool(
      { idempotency: 'args' as const, execute: async (args: any) => { calls++; return { amount: args.amount }; } },
      { journal, runId: 'r-distinct' },
      'charge',
    );

    const o1 = await dt.execute!({ amount: 5 }, { toolCallId: 'c1' });
    const o2 = await dt.execute!({ amount: 9 }, { toolCallId: 'c2' });

    expect(calls).toBe(2);
    expect(o1).toEqual({ amount: 5 });
    expect(o2).toEqual({ amount: 9 });
  });
});

describe('journal.ts claim() — silent fallback made loud', () => {
  it('journal without putIfAbsent → console.warn ONCE PER journal in the get→put fallback path', async () => {
    const store = new Map<string, unknown>();
    const journal: any = {
      get: async (k: string) => store.get(k),
      put: async (k: string, v: unknown) => { store.set(k, v); },
      // putIfAbsent DELIBERATELY UNDEFINED — triggers the fallback path.
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await claim(journal, 'k1', { v: 1 })).toBe(true);
      expect(await claim(journal, 'k1', { v: 2 })).toBe(false); // key already taken → false, NO second warning
      expect(await claim(journal, 'k2', { v: 3 })).toBe(true); // different key, SAME journal object
      expect(warnSpy).toHaveBeenCalledTimes(1); // ONCE per journal object
      expect(warnSpy.mock.calls[0]?.[0]).toMatch(/putIfAbsent/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('InMemoryJournal (HAS putIfAbsent) never warns', async () => {
    const journal = new InMemoryJournal();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await claim(journal, 'k1', { v: 1 });
      await claim(journal, 'k2', { v: 2 });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
