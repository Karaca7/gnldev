// Replay-disclosure: the honest-narration layer that counters the model's "I just created it" lie. Pinned invariants:
// 1) 'explain': on a window-replay, the model sees a transient [gnl] note in the FOLLOWING step and the envelope fills
// 2) default ('silent'): behavior is byte-identical — NO note; the envelope still fills (out-of-band is unconditional)
// 3) the note is NOT PERSISTENT: the next run's (a new request) model input has no trace of the old note
// 4) the persistence rule holds: the note drops only AFTER the tool is CALLED and the journal has answered — the
//    first (fresh) call has no note in any of its steps (no leakage into the decision point)
import { describe, it, expect } from 'vitest';
import { stepCountIs } from 'ai';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { BasicMemory } from '../src/memory.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

function orderTool(state: { n: number }) {
  return {
    ok: {
      description: 'order',
      sideEffect: true,
      idempotency: 'args' as const,
      idempotencyWindow: 'thread' as const,
      recover: async () => ({ done: false as const }),
      execute: async (args: unknown) => { state.n += 1; return { ok: true, order: args }; },
    },
  };
}

/** Model: calls the tool on the first step, then finishes; captures the PROMPT of every step. */
function capturingModel(callId: string, args: unknown, prompts: string[]) {
  return createMockModel(async ({ prompt }: any) => {
    prompts.push(JSON.stringify(prompt));
    return countToolResults(prompt) === 0 ? toolCallResult('ok', callId, args) : finalTextResult('done');
  });
}

const ARGS = { sku: 'abc', qty: 2 };
const base = (journal: InMemoryJournal, runId: string, extra: Record<string, unknown>) => ({
  runId, journal, stopWhen: stepCountIs(4), prompt: 'place an order', threadId: 'th-1', ...extra,
});

describe('replay-disclosure', () => {
  it("'explain': a transient [gnl] note + envelope in the step following a window-replay; NO note on a fresh call", async () => {
    const journal = new InMemoryJournal();
    const state = { n: 0 };
    const p1: string[] = [];
    const r1 = await runDurable(base(journal, 'rd-1', {
      model: capturingModel('c1', ARGS, p1), tools: orderTool(state), replayDisclosure: 'explain',
    }) as any);
    expect(state.n).toBe(1);
    expect(p1.join()).not.toContain('[gnl]'); // fresh job: no note in any step (the decision point is clean)
    expect((r1 as any).replayedToolCalls).toBeUndefined();

    // Same thread, a NEW runId, the SAME arguments → window replay: the job doesn't run, the note drops, the envelope fills.
    const p2: string[] = [];
    const r2 = await runDurable(base(journal, 'rd-2', {
      model: capturingModel('c2', ARGS, p2), tools: orderTool(state), replayDisclosure: 'explain',
    }) as any);
    expect(state.n).toBe(1); // exactly-once still holds
    expect(p2.length).toBeGreaterThan(1);
    expect(p2[0]).not.toContain('[gnl]'); // absent before the tool is CALLED
    expect(p2[p2.length - 1]).toContain('[gnl]'); // present when narrating the result
    expect((r2 as any).replayedToolCalls).toEqual([
      expect.objectContaining({ toolName: 'ok', status: 'succeeded', origin: 'window' }),
    ]);

    // The note is NOT persistent: a third run (different arguments = a fresh job) sees no trace of the old note in its history.
    const p3: string[] = [];
    await runDurable(base(journal, 'rd-3', {
      model: capturingModel('c3', { sku: 'xyz', qty: 1 }, p3), tools: orderTool(state), replayDisclosure: 'explain',
    }) as any);
    expect(p3.join()).not.toContain('[gnl]');
    expect(state.n).toBe(2);
  });

  it("default 'silent': NO note but the envelope still fills (the out-of-band tag is unconditional)", async () => {
    const journal = new InMemoryJournal();
    const state = { n: 0 };
    await runDurable(base(journal, 'rs-1', { model: capturingModel('c1', ARGS, []), tools: orderTool(state) }) as any);
    const p2: string[] = [];
    const r2 = await runDurable(base(journal, 'rs-2', { model: capturingModel('c2', ARGS, p2), tools: orderTool(state) }) as any);
    expect(state.n).toBe(1);
    expect(p2.join()).not.toContain('[gnl]'); // current behavior is byte-identical
    expect((r2 as any).replayedToolCalls).toHaveLength(1); // the tag is still there
  });
});

describe('replay-disclosure — audit findings', () => {
  it("the note is not written to thread MEMORY: with memory attached, the next turn's loaded history has no [gnl] (K15)", async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const state = { n: 0 };
    // With memory attached, the history carries messages that INCLUDE tool-results — the mock must
    // look at its own step count, not the tool-result counter (otherwise it says 'final' on step one and never calls the tool — this happened before).
    const stepModel = (callId: string, prompts: string[]) => createMockModel(async ({ prompt }: any) => {
      prompts.push(JSON.stringify(prompt));
      return prompts.length === 1 ? toolCallResult('ok', callId, ARGS) : finalTextResult('done');
    });
    await runDurable(base(journal, 'rm-1', {
      model: stepModel('c1', []), tools: orderTool(state), memory, replayDisclosure: 'explain',
    }) as any);
    // the window-replay turn: the note drops into the model INPUT but must NOT be written to memory
    const p2: string[] = [];
    await runDurable(base(journal, 'rm-2', {
      model: stepModel('c2', p2), tools: orderTool(state), memory, replayDisclosure: 'explain',
    }) as any);
    expect(p2[p2.length - 1]).toContain('[gnl]');
    // THIRD turn: the history loaded from memory enters the model input — it must NOT contain the note.
    const p3: string[] = [];
    await runDurable(base(journal, 'rm-3', {
      model: capturingModel('c3', { sku: 'q', qty: 9 }, p3), tools: orderTool(state), memory, replayDisclosure: 'explain',
    }) as any);
    expect(p3[0]).toContain('place an order'); // the history is genuinely loaded (the negative test isn't trivial)
    expect(p3.join()).not.toContain('[gnl]');
    const stored = await memory.getMessages('th-1');
    expect(JSON.stringify(stored)).not.toContain('[gnl]');
  });

  it("SELF origin: consuming its own record during an approval-resume does NOT produce a note, the envelope tags it 'self' (K4)", async () => {
    const journal = new InMemoryJournal();
    const state = { n: 0 };
    const tools = {
      ...orderTool(state),
      onayli: {
        description: 'onay ister', sideEffect: true, confirm: true, recover: async () => ({ done: false as const }),
        execute: async () => { state.n += 1; return { ok: 2 }; },
      },
    };
    // model: step1 A(ok) → step2 B(onayli) → step3 final
    const script = (prompts: string[]) => createMockModel(async ({ prompt }: any) => {
      prompts.push(JSON.stringify(prompt));
      const n = countToolResults(prompt);
      if (n === 0) return toolCallResult('ok', 'a1', ARGS);
      if (n === 1) return toolCallResult('onayli', 'b1', {});
      return finalTextResult('bitti');
    });
    const p1: string[] = [];
    const r1 = await runDurable(base(journal, 'self-1', { model: script(p1), tools, replayDisclosure: 'explain' }) as any);
    expect(r1.interrupts).toHaveLength(1); // B is suspended
    // approve and resume: A's record is consumed (SELF) — the live final step must have NO note
    const p2: string[] = [];
    const r2 = await runDurable(base(journal, 'self-1', {
      model: script(p2), tools, replayDisclosure: 'explain', approvals: { b1: true },
    }) as any);
    expect(r2.interrupts).toHaveLength(0);
    expect(state.n).toBe(2); // A once + B once
    expect(p2.join()).not.toContain('[gnl]'); // the continuation of one's own request isn't narrated as "an earlier request"
    const env = (r2 as any).replayedToolCalls ?? [];
    expect(env.some((e: any) => e.origin === 'self')).toBe(true); // observability isn't lost
    expect(env.every((e: any) => e.origin === 'self')).toBe(true);
  });

  it('composition with processors: with processInputStep PRESENT + explain → both run (K14)', async () => {
    const journal = new InMemoryJournal();
    const state = { n: 0 };
    const seen = { steps: 0 };
    const proc = { name: 'sayan', processInputStep: () => { seen.steps += 1; return undefined; } };
    await runDurable(base(journal, 'pc-1', {
      model: capturingModel('c1', ARGS, []), tools: orderTool(state), replayDisclosure: 'explain', processors: [proc],
    }) as any);
    const p2: string[] = [];
    await runDurable(base(journal, 'pc-2', {
      model: capturingModel('c2', ARGS, p2), tools: orderTool(state), replayDisclosure: 'explain', processors: [proc],
    }) as any);
    expect(seen.steps).toBeGreaterThan(0); // the processor pipeline is intact
    expect(p2[p2.length - 1]).toContain('[gnl]'); // the note still dropped through the composed prepareStep
    expect(state.n).toBe(1);
  });
});

describe('repeat context on the confirm question', () => {
  it('with a completed thread-marker present, the confirm question carries a ⚠ repeat warning; a fresh question does not; approval OPENS the new job', async () => {
    const journal = new InMemoryJournal();
    const state = { n: 0 };
    const tools = {
      ok: {
        description: 'order', sideEffect: true, confirm: true,
        recover: async () => ({ done: false as const }),
        execute: async (args: unknown) => { state.n += 1; return { ok: true, order: args }; },
      },
    };
    const limits = { sideEffectDuplicates: { action: 'suspend' as const, scope: 'thread' as const } };
    const reasonOf = (r: any) => r.interrupts[0]?.reason ?? '';

    // r1: fresh job → generic confirm question (NO ⚠)
    const r1 = await runDurable(base(journal, 'cf-1', { model: capturingModel('c1', ARGS, []), tools, limits }) as any);
    expect(reasonOf(r1)).toContain('explicit confirmation');
    expect(reasonOf(r1)).not.toContain('ALREADY COMPLETED');
    await runDurable(base(journal, 'cf-1', { model: capturingModel('c1', ARGS, []), tools, limits, approvals: { c1: true } }) as any);
    expect(state.n).toBe(1); // the marker was born

    // r2: the SAME job, a new request → the question comes AGAIN and carries repeat context
    const r2 = await runDurable(base(journal, 'cf-2', { model: capturingModel('c2', ARGS, []), tools, limits }) as any);
    expect(r2.interrupts).toHaveLength(1); // asks on every repeat
    expect(reasonOf(r2)).toContain('ALREADY COMPLETED');
    expect(reasonOf(r2)).toContain('c1'); // points to the first result

    // "I really want this" → approve → a REAL second job
    await runDurable(base(journal, 'cf-2', { model: capturingModel('c2', ARGS, []), tools, limits, approvals: { c2: true } }) as any);
    expect(state.n).toBe(2);

    // r3: a third time → asks AGAIN, still with context
    const r3 = await runDurable(base(journal, 'cf-3', { model: capturingModel('c3', ARGS, []), tools, limits }) as any);
    expect(r3.interrupts).toHaveLength(1);
    expect(reasonOf(r3)).toContain('ALREADY COMPLETED');
  });
});

describe('replay-disclosure — STREAM envelope (closing out K28)', () => {
  it('the stream result carries a lazy envelope: empty before consumption, filled after', async () => {
    const { streamDurable } = await import('../src/run.js');
    // Our own stream mock: a DIFFERENT toolCallId per run (real models generate unique ones —
    // a shared mock with a fixed id gave false positives on the identity-based self test).
    const mkStreamAgent = (callId: string) => ({
      specificationVersion: 'v4', provider: 'mock', modelId: 'm', supportedUrls: {},
      doGenerate: async () => { throw new Error('stream-only'); },
      doStream: async ({ prompt }: any) => {
        const done = (prompt ?? []).filter((m: any) => m.role === 'tool').length;
        const usage = { inputTokens: { total: 1, noCache: 1 }, outputTokens: { total: 1, text: 1 } };
        const arr = done === 0
          ? [{ type: 'stream-start', warnings: [] }, { type: 'tool-call', toolCallId: callId, toolName: 'chargeCard', input: JSON.stringify({ amount: 20 }) }, { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage }]
          : [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: 'ok' }, { type: 'text-end', id: '1' }, { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }];
        return { stream: new ReadableStream({ start(c) { for (const p of arr) c.enqueue(p); c.close(); } }) };
      },
    });
    const journal = new InMemoryJournal();
    const state = { n: 0 };
    const tools = {
      chargeCard: {
        description: 'charge', sideEffect: true, idempotency: 'args' as const, idempotencyWindow: 'thread' as const,
        recover: async () => ({ done: false as const }),
        execute: async () => { state.n += 1; return { charged: 20 }; },
      },
    };
    const consume = async (r: any) => { for await (const _ of r.fullStream) { /* consume */ } };
    const r1 = await streamDurable({ runId: 'sd-1', journal, threadId: 'th-s', model: mkStreamAgent('call-A'), tools, stopWhen: stepCountIs(4), prompt: 'charge' } as any);
    await consume(r1);
    expect(state.n).toBe(1);
    expect((r1 as any).replayedToolCalls).toBeUndefined(); // fresh job — empty envelope

    const r2 = await streamDurable({ runId: 'sd-2', journal, threadId: 'th-s', model: mkStreamAgent('call-B'), tools, stopWhen: stepCountIs(4), prompt: 'charge' } as any);
    expect((r2 as any).replayedToolCalls).toBeUndefined(); // BEFORE CONSUMPTION: lazy — still empty
    await consume(r2);
    expect(state.n).toBe(1); // replayed, did not run
    const env = (r2 as any).replayedToolCalls;
    expect(env).toHaveLength(1); // AFTER CONSUMPTION: filled
    expect(env[0]).toMatchObject({ toolName: 'chargeCard', origin: 'window' });
  });
});
