import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { durableTool } from '../src/durable-tool.js';
import { RetryLimitExceededError, SideEffectRetryBlockedError } from '../src/errors.js';
import type { Processor } from '../src/processor.js';

describe('durableTool — exactly-once', () => {
  it('when the same toolCallId is called twice, the underlying execute runs once', async () => {
    const journal = new InMemoryJournal();
    let calls = 0;
    const base = {
      execute: async (args: { amount: number }) => {
        calls++;
        return { charged: args.amount };
      },
    };
    const dt = durableTool(base, { journal, runId: 'r1' });

    const o1 = await dt.execute!({ amount: 20 }, { toolCallId: 'call-1' });
    const o2 = await dt.execute!({ amount: 20 }, { toolCallId: 'call-1' });

    expect(calls).toBe(1);
    expect(o1).toEqual({ charged: 20 });
    expect(o2).toEqual({ charged: 20 }); // replayed from the journal
  });

  it('different toolCallId → runs every time', async () => {
    const journal = new InMemoryJournal();
    let calls = 0;
    const dt = durableTool({ execute: async () => ++calls }, { journal, runId: 'r1' });

    await dt.execute!({}, { toolCallId: 'a' });
    await dt.execute!({}, { toolCallId: 'b' });

    expect(calls).toBe(2);
  });

  it('a failed record can be re-executed (marked idempotent; only succeeded is memoized)', async () => {
    const journal = new InMemoryJournal();
    let calls = 0;
    const dt = durableTool(
      {
        idempotent: true, // H7: because of the safe default, retry needs an explicit marker
        execute: async () => {
          calls++;
          if (calls === 1) throw new Error('boom');
          return 'ok';
        },
      },
      { journal, runId: 'r1' },
    );

    await expect(dt.execute!({}, { toolCallId: 'x' })).rejects.toThrow('boom');
    const out = await dt.execute!({}, { toolCallId: 'x' });

    expect(out).toBe('ok');
    expect(calls).toBe(2);
  });
});

describe('durableTool — GOREV 4.3: bounded retry + side-effect distinction', () => {
  it('when maxRetries is unspecified, the default (3) limit results in a permanent failed — no infinite retry', async () => {
    const journal = new InMemoryJournal();
    let calls = 0;
    const dt = durableTool(
      {
        idempotent: true, // H7
        execute: async () => {
          calls++;
          throw new Error('always blows up');
        },
      },
      { journal, runId: 'r1' },
    );

    await expect(dt.execute!({}, { toolCallId: 'x' })).rejects.toThrow('always blows up'); // attempt 1
    await expect(dt.execute!({}, { toolCallId: 'x' })).rejects.toThrow('always blows up'); // attempt 2
    await expect(dt.execute!({}, { toolCallId: 'x' })).rejects.toThrow('always blows up'); // attempt 3
    expect(calls).toBe(3);

    // 4th call: the limit was reached → the underlying execute does NOT run again, permanently failed.
    await expect(dt.execute!({}, { toolCallId: 'x' })).rejects.toThrow(RetryLimitExceededError);
    expect(calls).toBe(3);
  });

  it('customizable via tool.maxRetries=1', async () => {
    const journal = new InMemoryJournal();
    let calls = 0;
    const dt = durableTool(
      {
        idempotent: true, // H7
        maxRetries: 1,
        execute: async () => {
          calls++;
          throw new Error('boom');
        },
      },
      { journal, runId: 'r1' },
    );

    await expect(dt.execute!({}, { toolCallId: 'x' })).rejects.toThrow('boom'); // attempt 1 (limit=1)
    await expect(dt.execute!({}, { toolCallId: 'x' })).rejects.toThrow(RetryLimitExceededError); // blocked immediately
    expect(calls).toBe(1);
  });

  it('sideEffect:true tool → NO automatic retry without approval after a failure', async () => {
    const journal = new InMemoryJournal();
    let calls = 0;
    const ctx: any = { journal, runId: 'r1' };
    const dt = durableTool(
      {
        sideEffect: true,
        execute: async () => {
          calls++;
          if (calls === 1) throw new Error('charge failed');
          return { charged: true };
        },
      },
      ctx,
    );

    await expect(dt.execute!({}, { toolCallId: 'pay-1' })).rejects.toThrow('charge failed');
    expect(calls).toBe(1);

    // No approval → retry is BLOCKED — the underlying execute is not called.
    await expect(dt.execute!({}, { toolCallId: 'pay-1' })).rejects.toThrow(SideEffectRetryBlockedError);
    expect(calls).toBe(1);

    // If the user explicitly grants approval → retry is unblocked.
    ctx.approvals = { 'pay-1': true };
    const out = await dt.execute!({}, { toolCallId: 'pay-1' });
    expect(out).toEqual({ charged: true });
    expect(calls).toBe(2);
  });

  it('idempotent:false behaves equivalently to sideEffect', async () => {
    const journal = new InMemoryJournal();
    let calls = 0;
    const dt = durableTool(
      {
        idempotent: false,
        execute: async () => {
          calls++;
          throw new Error('boom');
        },
      },
      { journal, runId: 'r1' },
    );

    await expect(dt.execute!({}, { toolCallId: 'x' })).rejects.toThrow('boom');
    await expect(dt.execute!({}, { toolCallId: 'x' })).rejects.toThrow(SideEffectRetryBlockedError);
    expect(calls).toBe(1);
  });

  it('H7 SAFE DEFAULT: an unmarked tool gets no automatic retry after a failure (blocked)', async () => {
    const journal = new InMemoryJournal();
    let calls = 0;
    const dt = durableTool(
      {
        execute: async () => {
          calls++;
          if (calls < 2) throw new Error('transient error');
          return 'ok';
        },
      },
      { journal, runId: 'r1' },
    );

    await expect(dt.execute!({}, { toolCallId: 'x' })).rejects.toThrow('transient error');
    // H7: an unmarked tool is assumed to be side-effecting → NO automatic retry, explicit approval is required.
    await expect(dt.execute!({}, { toolCallId: 'x' })).rejects.toThrow(/side effects/);
    expect(calls).toBe(1); // the body did NOT run a second time

    // Explicit human approval = "re-run knowing the risk" → retry is unblocked.
    const approvedCtx = { journal, runId: 'r1', approvals: { x: true } };
    const dtApproved = durableTool(
      { execute: async () => { calls++; return 'ok'; } },
      approvedCtx as any,
    );
    expect(await dtApproved.execute!({}, { toolCallId: 'x' })).toBe('ok');
    expect(calls).toBe(2);
  });
});

describe('durableTool — processToolResult (audit: tool-output prompt-injection defense)', () => {
  it('processToolResult produces the transformed output; the TRANSFORMED form is written to the journal; the hook does NOT run again on replay', async () => {
    const journal = new InMemoryJournal();
    let calls = 0;
    const marker: Processor = {
      name: 'marker',
      processToolResult: (res) => {
        calls++;
        return { output: `[marked] ${res.output}` };
      },
    };
    const ctx: any = { journal, runId: 'r1', toolResultProcessors: [marker] };
    const dt = durableTool({ execute: async () => 'raw' }, ctx);

    const o1 = await dt.execute!({}, { toolCallId: 'call-1' });
    expect(o1).toBe('[marked] raw');
    expect(calls).toBe(1);

    const rec: any = await journal.get('r1:tool:call-1');
    expect(rec.status).toBe('succeeded');
    expect(rec.output).toBe('[marked] raw'); // the TRANSFORMED form was written to the journal (not the raw 'raw')

    // Replay: same toolCallId → a succeeded record exists → execute AND processToolResult do NOT run again.
    const o2 = await dt.execute!({}, { toolCallId: 'call-1' });
    expect(o2).toBe('[marked] raw');
    expect(calls).toBe(1); // the counter didn't increase — the hook didn't run a second time
  });

  it('without toolResultProcessors, behavior is identical to before (no hook)', async () => {
    const journal = new InMemoryJournal();
    const dt = durableTool({ execute: async () => 'raw' }, { journal, runId: 'r2' });
    const out = await dt.execute!({}, { toolCallId: 'call-1' });
    expect(out).toBe('raw');
  });

  it('output does NOT change when a processor without processToolResult is in the chain', async () => {
    const journal = new InMemoryJournal();
    const noop: Processor = { name: 'noop' }; // no processToolResult
    const dt = durableTool({ execute: async () => 'raw' }, { journal, runId: 'r3', toolResultProcessors: [noop] } as any);
    const out = await dt.execute!({}, { toolCallId: 'call-1' });
    expect(out).toBe('raw');
  });
});
