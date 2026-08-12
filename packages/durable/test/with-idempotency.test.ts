// Proof tests for `withIdempotency` — the thin public wrapper that adds
// LLM-aware idempotency to a PLAIN AI SDK loop (no runDurable). Mirrors the harness of
// args-idempotency.test.ts / cross-run-idempotency.test.ts: durableTool-wrapped tools driven directly
// against an InMemoryJournal, so no full generateText loop is needed to prove the dedup contract.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { withIdempotency } from '../src/idempotent-tools.js';

describe('withIdempotency — default window ("cross-run")', () => {
  it('two SEPARATE calls (different toolCallIds, same args) → underlying execute runs EXACTLY once', async () => {
    const journal = new InMemoryJournal();
    let calls = 0;
    const tools = withIdempotency(
      { charge: { execute: async () => { calls++; return { charged: 100, seq: calls }; } } },
      { journal }, // window defaults to 'cross-run'; runId irrelevant (key is runId-free)
    );

    const o1 = await tools.charge.execute!({ orderId: 'X' }, { toolCallId: 'call-1' });
    const o2 = await tools.charge.execute!({ orderId: 'X' }, { toolCallId: 'call-2' });

    expect(calls).toBe(1); // deduped by arguments across independent calls
    expect(o2).toEqual(o1); // second call returned the journaled output of the first
  });

  it('cross-run default ignores runId: same args from tools built with DIFFERENT runIds still dedup', async () => {
    const journal = new InMemoryJournal();
    let calls = 0;
    const mk = (runId: string) =>
      withIdempotency(
        { charge: { execute: async () => { calls++; return { seq: calls }; } } },
        { journal, runId }, // runId passed but must NOT matter in the cross-run window
      );

    const o1 = await mk('run-A').charge.execute!({ orderId: 'X' }, { toolCallId: 'a' });
    const o2 = await mk('run-B').charge.execute!({ orderId: 'X' }, { toolCallId: 'b' });

    expect(calls).toBe(1); // proves the cross-run key is genuinely runId-independent
    expect(o2).toEqual(o1);
  });
});

describe('withIdempotency — window: "run" + runId', () => {
  it('same runId repeated → runs once; a DIFFERENT runId → runs again (run-scoped dedup)', async () => {
    const journal = new InMemoryJournal();
    let calls = 0;
    const mk = (runId: string) =>
      withIdempotency(
        { charge: { execute: async () => { calls++; return { seq: calls }; } } },
        { journal, window: 'run', runId },
      );

    // Same runId, two calls with same args → deduped.
    const o1 = await mk('run-1').charge.execute!({ orderId: 'X' }, { toolCallId: 'a' });
    const o2 = await mk('run-1').charge.execute!({ orderId: 'X' }, { toolCallId: 'b' });
    expect(calls).toBe(1);
    expect(o2).toEqual(o1);

    // Different runId, same args → the 'run' window does NOT dedup across runs → executes again.
    await mk('run-2').charge.execute!({ orderId: 'X' }, { toolCallId: 'c' });
    expect(calls).toBe(2);
  });
});

describe('withIdempotency — custom logical key', () => {
  it('key: (name, args) => args.orderId → DIFFERENT args sharing an orderId collapse to one execution', async () => {
    const journal = new InMemoryJournal();
    let calls = 0;
    const tools = withIdempotency(
      { charge: { execute: async (args: any) => { calls++; return { ok: true, orderId: args.orderId }; } } },
      { journal, key: (_name, args: any) => args.orderId },
    );

    const o1 = await tools.charge.execute!({ orderId: 'o1', note: 'first' }, { toolCallId: 'x' });
    const o2 = await tools.charge.execute!({ orderId: 'o1', note: 'DIFFERENT-field' }, { toolCallId: 'y' });
    expect(calls).toBe(1); // same logical key despite different incidental fields
    expect(o2).toEqual(o1);

    const o3 = await tools.charge.execute!({ orderId: 'o2' }, { toolCallId: 'z' }); // different key → runs
    expect(calls).toBe(2);
    expect(o3).toEqual({ ok: true, orderId: 'o2' });
  });
});

describe('withIdempotency — control: an UNWRAPPED plain tool has no dedup', () => {
  it('the same tool WITHOUT withIdempotency executes twice for the same args (baseline)', async () => {
    let calls = 0;
    const plain = { charge: { execute: async () => { calls++; return { seq: calls }; } } };

    await plain.charge.execute!({ orderId: 'X' }, { toolCallId: 'a' });
    await plain.charge.execute!({ orderId: 'X' }, { toolCallId: 'b' });

    expect(calls).toBe(2); // no idempotency layer → both side effects happen
  });
});
