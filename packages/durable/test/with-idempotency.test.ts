// Proof tests for `withIdempotency` — the thin public wrapper that adds
// LLM-aware idempotency to a PLAIN AI SDK loop (no runDurable). Mirrors the harness of
// args-idempotency.test.ts / cross-run-idempotency.test.ts: durableTool-wrapped tools driven directly
// against an InMemoryJournal, so no full generateText loop is needed to prove the dedup contract.
import { describe, it, expect, vi } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { withIdempotency, releaseFailedClaim } from '../src/idempotent-tools.js';
import { z } from 'zod';

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

// A refusal must name a remedy the caller can actually reach.
//
// The side-effect retry block is correct — a failed side effect is not re-run on its own — but the
// message told the caller what to do next, and for two callers that instruction was a dead end.
//
// `withIdempotency` runs OUTSIDE runDurable and has no approvals channel at all, and the toolCallId it
// names is a fresh one on every attempt, so `approvals[id] = true` could never have been pre-supplied.
// The code knew this for the cross-run window and said so there — but the reason has nothing to do with
// the window, and a `window: 'run'` caller (a documented option) was still being sent to approvals.
//
// The other half was a detection bug: `crossRun` was decided by sniffing the KEY for 'xrun:' rather
// than reading the `window` already in scope. A run whose runId is literally `xrun` produces the
// run-window key `xrun:tool:args-…`, which startsWith('xrun:') — so it was told to call
// releaseFailedClaim, which looks for `xrun:args-<tool>-<hash>`, finds nothing, and returns false
// without saying why.
describe('the remedy named when a failed side effect is refused', () => {
  const failing = (fail: boolean) => ({
    description: 'charge',
    inputSchema: z.object({ o: z.string() }),
    idempotency: 'args' as const,
    execute: async () => { if (fail) throw new Error('provider down'); return { ok: true }; },
  });

  /** Runs the tool once so it fails, then again so the refusal fires; returns the second message. */
  async function refusalFrom(make: (fail: boolean) => { charge: any }) {
    try { await make(true).charge.execute({ o: 'X' }, { toolCallId: 'c1' }); } catch { /* first attempt fails */ }
    try {
      await make(false).charge.execute({ o: 'X' }, { toolCallId: 'c2' });
      return '(no refusal)';
    } catch (e) { return String((e as Error).message); }
  }

  it('does not offer approvals to a caller that has no approvals channel', async () => {
    const journal = new InMemoryJournal();
    const msg = await refusalFrom((fail) =>
      withIdempotency({ charge: failing(fail) } as never, { journal, runId: 'R1', window: 'run' }) as never);

    expect(msg, 'the caller was sent to a channel it does not have').not.toMatch(/approvals\['c2'\]=true/);
    expect(msg).toMatch(/no approvals channel/);
    expect(msg, 'the reachable remedies must still be named').toMatch(/recover\(\)/);
  });

  it('still offers approvals to a run that HAS them, even when its runId looks like a key prefix', async () => {
    // `xrun` is a legal runId. Keyed off the window rather than the key text, this is an ordinary
    // run-scoped claim and approvals are exactly the right answer.
    const { durableTool } = await import('../src/durable-tool.js');
    const journal = new InMemoryJournal();
    const make = (fail: boolean) => ({
      charge: durableTool(failing(fail) as never, { journal, runId: 'xrun' } as never, 'charge'),
    });
    const msg = await refusalFrom(make as never);

    expect(msg, 'a run-scoped claim was described as a permanent cross-run one').not.toMatch(/cross-run claim/);
    expect(msg).toMatch(/approvals\['c2'\]=true/);
  });

  it('still names releaseFailedClaim for a genuine cross-run claim', async () => {
    // The branch that was right all along, kept honest: this remedy IS reachable here, because the
    // claim key really is run-independent.
    const { durableTool } = await import('../src/durable-tool.js');
    const journal = new InMemoryJournal();
    const crossRun = (fail: boolean) => ({ ...failing(fail), idempotencyWindow: 'cross-run' as const });
    const make = (fail: boolean) => ({
      charge: durableTool(crossRun(fail) as never, { journal, runId: 'R1' } as never, 'charge'),
    });
    const msg = await refusalFrom(make as never);

    expect(msg).toMatch(/cross-run claim/);
    expect(msg).toMatch(/releaseFailedClaim/);
  });
});

// `false` on its own cannot be acted on.
//
// releaseFailedClaim returns false both when nothing was ever claimed and when the caller looked in
// the wrong place — and three ordinary mistakes land in the second case: releasing against the ROOT
// journal when the tools ran org-scoped, releasing a `window: 'run'` claim (whose key carries the
// runId), and omitting the `key` function the tools were built with. In all three the operator reads
// "no claim" and stops looking while the run stays blocked.
describe('releaseFailedClaim when it finds nothing', () => {
  it('says which key it looked for, so the caller can see they are in the wrong place', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const journal = new InMemoryJournal();
      expect(await releaseFailedClaim(journal, { toolName: 'charge', args: { o: 'X' } })).toBe(false);
      const said = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(said, 'the answer was a bare false').toContain('xrun:args-charge-');
      expect(said).toMatch(/no cross-run claims at all/);
    } finally { warn.mockRestore(); }
  });

  it('distinguishes "this tool has none" from "none with THESE arguments"', async () => {
    // Two different problems, and only one of them is about the arguments.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const journal = new InMemoryJournal();
      await journal.put('xrun:args-charge-deadbeefdeadbeef', { status: 'failed' });

      expect(await releaseFailedClaim(journal, { toolName: 'charge', args: { o: 'other' } })).toBe(false);
      const said = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(said, 'a sibling claim went unmentioned').toMatch(/DOES have 1 other claim/);
      expect(said).toContain('xrun:args-charge-deadbeefdeadbeef');
    } finally { warn.mockRestore(); }
  });

  it('says nothing extra when it actually releases one', async () => {
    // The diagnostic is for the failure path only; a working release must stay quiet.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const journal = new InMemoryJournal();
      const { argsHash } = await import('../src/hash.js');
      const key = `xrun:args-charge-${argsHash({ o: 'X' })}`;
      await journal.put(key, { status: 'failed', toolName: 'charge' });

      expect(await releaseFailedClaim(journal, { toolName: 'charge', args: { o: 'X' } })).toBe(true);
      expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain('found no claim');
    } finally { warn.mockRestore(); }
  });
});
