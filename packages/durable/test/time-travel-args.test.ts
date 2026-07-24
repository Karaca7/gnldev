// GOREV (time-travel/fork fidelity for `idempotency: 'args'`): args-mode tool records are journaled
// under `runKeys.toolByArgs` (dedupeId = `args-${toolName}-${hash}`, NOT the AI SDK toolCallId — see
// journal.ts runKeys.toolByArgs). Before this fix, reconstructState/forkRun only knew how to match the
// `runKeys.tool` (toolCallId-keyed) form → an args-keyed record never cleared `pending` (a resolved
// tool looked "pending forever") and forkRun never copied it (fork loses exactly-once for that tool).
// Uses the SAME harness/mock-model pattern as time-travel.test.ts / args-idempotency.test.ts.
import { describe, it, expect } from 'vitest';
import { stepCountIs } from 'ai';
import { InMemoryJournal } from '../src/journal.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { runDurable, resumeRun } from '../src/run.js';
import { reconstructState, forkRun } from '../src/time-travel.js';
import { argsHash } from '../src/hash.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

describe('reconstructState — args-mode tool, single completed call', () => {
  it('pending clears once the args-keyed record resolves; tool-result carries the REAL toolCallId + correct output', async () => {
    const journal = new InMemoryJournal();
    const model = createMockModel(async ({ prompt }: any) =>
      countToolResults(prompt) === 0 ? toolCallResult('charge', 'call-only', { amount: 20 }) : finalTextResult('done'),
    );
    const tools = { charge: { idempotency: 'args' as const, execute: async () => ({ charged: 20 }) } };

    await runDurable({ runId: 'rt-args-1', journal, model, tools, stopWhen: stepCountIs(6), prompt: 'x' });
    const entries = await journal.readRun('rt-args-1');

    // Before the model's tool-call step is followed by the tool record: the call is still pending
    // (mirrors the pre-existing reconstructState test's step-by-step shape).
    const atStep1 = reconstructState(entries, 1);
    expect(atStep1.pending).toEqual([{ toolCallId: 'call-only', toolName: 'charge' }]);

    // Full replay: the args-keyed tool record must resolve the SAME pending entry (bug: it never did).
    const full = reconstructState(entries);
    expect(full.pending).toHaveLength(0);
    const toolMsg = full.messages.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg.content[0].toolCallId).toBe('call-only'); // the REAL toolCallId, not the args- dedupe id
    expect(toolMsg.content[0].output).toEqual({ charged: 20 });
  });
});

describe('reconstructState — documented same-turn duplicate (5 distinct toolCallIds, one args-keyed record)', () => {
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

  it('pending is empty; all 5 tool-results carry their OWN real toolCallId with the SAME output', async () => {
    const journal = new InMemoryJournal();
    let calls = 0;
    const tools = { charge: { idempotency: 'args' as const, execute: async () => { calls++; return { charged: 20, seq: calls }; } } };

    await runDurable({ runId: 'rt-args-5', journal, model: multiCallModel(), tools, stopWhen: stepCountIs(6), prompt: 'x' });
    expect(calls).toBe(1); // single underlying execution (duplicate-toolCallId dedup)

    const entries = await journal.readRun('rt-args-5');
    const state = reconstructState(entries);

    expect(state.pending).toHaveLength(0); // ALL 5 pending entries resolved by the ONE args-keyed record
    const toolMsgs = state.messages.filter((m) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(5);
    const ids = toolMsgs.map((m) => m.content[0].toolCallId).sort();
    expect(ids).toEqual(['call-1', 'call-2', 'call-3', 'call-4', 'call-5']);
    for (const m of toolMsgs) expect(m.content[0].output).toEqual({ charged: 20, seq: 1 }); // same output, all 5
  });
});

// GOREV (Task 1 — reconstructState "pending tool in a completed run" fix): a tool with a CUSTOM
// `idempotencyKey` function (e.g. `chargeOrder` from the `full` CLI template — dedup by orderId, not
// the full args) derives its journal dedupe key from a function that lives in the TOOL DEFINITION, not
// the journal — reconstructState (pure, journal-only) can never recompute it. Before the fix, this made
// a genuinely SUCCEEDED tool-call show up as "pending" FOREVER, even in the final state of a completed
// run (reproduces the observed `gnl run <id>` output: `pending: chargeOrder[call-1]` on a completed
// run). Fixed via `resolvedToolCallIds` (journal.ts/durable-tool.ts) — the record now carries the REAL
// toolCallId(s) it resolved, so reconstructState matches EXACTLY instead of recomputing.
describe('reconstructState — args-mode tool with a CUSTOM idempotencyKey (chargeOrder-style)', () => {
  function chargeOrderTool() {
    return {
      idempotency: 'args' as const,
      idempotencyKey: (args: any) => String(args.orderId), // dedup by orderId, NOT the full args
      execute: async ({ orderId, amount }: any) => ({ charged: amount, orderId, receipt: `rcpt_${orderId}` }),
    };
  }

  it('a single resolved call: pending is EMPTY on the completed run\'s final state (was: stuck pending forever)', async () => {
    const journal = new InMemoryJournal();
    const model = createMockModel(async ({ prompt }: any) =>
      countToolResults(prompt) === 0 ? toolCallResult('chargeOrder', 'call-1', { orderId: 'o1', amount: 20 }) : finalTextResult('done'),
    );
    const tools = { chargeOrder: chargeOrderTool() };

    await runDurable({ runId: 'order-1', journal, model, tools, stopWhen: stepCountIs(6), prompt: 'charge' });
    const entries = await journal.readRun('order-1');

    const summary = { toolRecords: entries.filter((e) => e.kind === 'tool').map((e) => e.value) };
    expect((summary.toolRecords[0] as any).status).toBe('succeeded'); // genuinely resolved in the journal

    const final = reconstructState(entries); // uptoStep defaults to entries.length — the "gnl run" view
    expect(final.pending).toHaveLength(0); // must NOT show a phantom pending on a completed run
    const toolMsg = final.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content[0]).toMatchObject({ toolCallId: 'call-1', output: { charged: 20, orderId: 'o1', receipt: 'rcpt_o1' } });
  });

  it('two calls with the SAME orderId across different turns (different toolCallIds) both resolve; the tool runs once', async () => {
    const journal = new InMemoryJournal();
    let turn = 0;
    let charges = 0;
    const model = createMockModel(async () => {
      turn++;
      if (turn === 1) return toolCallResult('chargeOrder', 'call-1', { orderId: 'o1', amount: 20 });
      if (turn === 2) return toolCallResult('chargeOrder', 'call-2', { orderId: 'o1', amount: 20 }); // same orderId, new toolCallId
      return finalTextResult('done');
    });
    const tools = { chargeOrder: { ...chargeOrderTool(), execute: async (a: any) => { charges++; return { charged: a.amount, orderId: a.orderId, receipt: `rcpt_${a.orderId}` }; } } };

    await runDurable({ runId: 'order-2', journal, model, tools, stopWhen: stepCountIs(6), prompt: 'charge twice' });
    expect(charges).toBe(1); // exactly-once: the second call is served from the journal, not re-executed

    const entries = await journal.readRun('order-2');
    const final = reconstructState(entries);
    expect(final.pending).toHaveLength(0); // BOTH call-1 and call-2 must clear
    const toolMsgs = final.messages.filter((m) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(2);
    expect(toolMsgs.map((m) => m.content[0].toolCallId).sort()).toEqual(['call-1', 'call-2']);
  });
});

describe.each([
  ['InMemory', () => new InMemoryJournal()],
  ['Sqlite', () => new SqliteStorage(':memory:').runs],
])('forkRun — args-mode tool record, %s', (_name, make) => {
  it('the args-keyed record (not a toolCallId-keyed one) is copied to the fork; fork resume does NOT re-execute the tool', async () => {
    const journal = make() as any;
    const charges = { n: 0 };
    const tools = () => ({ charge: { idempotency: 'args' as const, execute: async () => ({ charged: (charges.n++, 20) }) } });
    const srcModel = () =>
      createMockModel(async ({ prompt }: any) =>
        countToolResults(prompt) === 0 ? toolCallResult('charge', 'call-c', { amount: 20 }) : finalTextResult('SRC-final'),
      );

    await runDurable({ runId: 'ra', journal, model: srcModel(), tools: tools(), stopWhen: stepCountIs(6), prompt: 'x' });
    expect(charges.n).toBe(1);

    const fork = await forkRun(journal, 'ra', 1, 'fork-args-1');
    expect(fork).toMatchObject({ newRunId: 'fork-args-1', copiedModel: 1, copiedTool: 1 });

    // The tool executed under `execute(input, …)`'s PARSED input `{ amount: 20 }` (the model record
    // carries the RAW JSON-string form) — argsHash must be computed over the parsed object to match
    // the key durable-tool.ts actually wrote.
    const hash = argsHash({ amount: 20 });
    expect(await journal.get(`fork-args-1:tool:args-charge-${hash}`)).toBeDefined(); // args-keyed record WAS copied
    expect(await journal.get('fork-args-1:tool:call-c')).toBeUndefined(); // no toolCallId-keyed copy exists (never written in args mode)
    expect(await journal.get('fork-args-1:model:0')).toBeDefined();
    expect(await journal.get('fork-args-1:model:1')).toBeUndefined();

    const forkModel = () =>
      createMockModel(async ({ prompt }: any) =>
        countToolResults(prompt) === 0 ? toolCallResult('charge', 'call-c', { amount: 20 }) : finalTextResult('FORK-final'),
      );
    const r2 = await resumeRun('fork-args-1', { journal, model: forkModel(), tools: tools(), stopWhen: stepCountIs(6) });
    expect(r2.text).toBe('FORK-final'); // step 1 ran LIVE (different tail from SRC)
    expect(charges.n).toBe(1); // step 0 (charge) replayed from the copied args-keyed record → NOT re-executed
  });
});

describe('reconstructState — call mode (default), no regression', () => {
  it('behaves identically to the pre-fix contract: pending keyed by the real toolCallId', async () => {
    const j = new InMemoryJournal();
    await j.put('rc:model:0', { content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'pay', input: '{}' }], finishReason: 'tool-calls' });
    await j.put('rc:tool:c1', { status: 'succeeded', output: { paid: true } });
    await j.put('rc:model:1', { content: [{ type: 'text', text: 'done' }], finishReason: 'stop' });
    const entries = await j.readRun('rc');

    const s1 = reconstructState(entries, 1);
    expect(s1.pending).toEqual([{ toolCallId: 'c1', toolName: 'pay' }]);

    const s2 = reconstructState(entries, 2);
    expect(s2.pending).toHaveLength(0);
    expect(s2.messages[1]).toEqual({ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', output: { paid: true } }] });
  });
});
