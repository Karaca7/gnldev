// GOREV (cross-run dedup, opt-in `idempotencyWindow: 'cross-run'`): proof test for the widened dedup
// window — "orderId=X gets charged exactly ONCE no matter which run/retry it comes from". Uses the
// SAME harness pattern as args-idempotency.test.ts (durableTool wired directly against an
// InMemoryJournal, no need for the full runDurable loop for most scenarios).
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { durableTool } from '../src/durable-tool.js';
import { withOrg } from '../src/organization.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('cross-run idempotency — two DIFFERENT runIds, same args, idempotencyWindow: "cross-run"', () => {
  it('the tool executes exactly ONCE; the second run reads the SAME output from the journal', async () => {
    const journal = new InMemoryJournal();
    let calls = 0;
    const makeTool = (runId: string) =>
      durableTool(
        {
          idempotency: 'args' as const,
          idempotencyWindow: 'cross-run' as const,
          execute: async () => { calls++; return { charged: 100, seq: calls }; },
        },
        { journal, runId },
        'charge',
      );

    const o1 = await makeTool('run-A').execute!({ orderId: 'X' }, { toolCallId: 'call-1' });
    const o2 = await makeTool('run-B').execute!({ orderId: 'X' }, { toolCallId: 'call-2' });

    expect(calls).toBe(1); // a DIFFERENT run, SAME arguments → NOT re-executed
    expect(o2).toEqual(o1); // run-B got run-A's recorded output
  });
});

describe('cross-run idempotency — proof of the WINDOW DIFFERENCE: default ("run") window still executes per-run', () => {
  it('same scenario WITHOUT idempotencyWindow (default "run") → the tool executes TWICE (one per run)', async () => {
    const journal = new InMemoryJournal();
    let calls = 0;
    const makeTool = (runId: string) =>
      durableTool(
        { idempotency: 'args' as const, execute: async () => { calls++; return { charged: 100, seq: calls }; } },
        { journal, runId },
        'charge',
      );

    const o1 = await makeTool('run-A').execute!({ orderId: 'X' }, { toolCallId: 'call-1' });
    const o2 = await makeTool('run-B').execute!({ orderId: 'X' }, { toolCallId: 'call-2' });

    expect(calls).toBe(2); // 'run' window (default/current behavior) — NO cross-run dedup
    expect(o2).not.toEqual(o1); // different execution → different seq
  });
});

describe('cross-run idempotency — custom idempotencyKey (e.g. orderId) + cross-run window', () => {
  it('different arguments but the SAME orderId, DIFFERENT runIds → single execution', async () => {
    const journal = new InMemoryJournal();
    let calls = 0;
    const makeTool = (runId: string) =>
      durableTool(
        {
          idempotencyKey: (args: any) => args.orderId, // IMPLIES 'args' mode
          idempotencyWindow: 'cross-run' as const,
          execute: async (args: any) => { calls++; return { ok: true, orderId: args.orderId }; },
        },
        { journal, runId },
        'charge',
      );

    const o1 = await makeTool('run-1').execute!({ orderId: 'o1', note: 'first' }, { toolCallId: 'a' });
    const o2 = await makeTool('run-2').execute!({ orderId: 'o1', note: 'DIFFERENT-field' }, { toolCallId: 'b' });

    expect(calls).toBe(1);
    expect(o2).toEqual(o1); // same logical key, different run → still returned from the cross-run record
  });
});

describe('cross-run idempotency — withOrg isolation', () => {
  it('org A has a cross-run record; org B with the SAME args still EXECUTES (organizations do not see each other)', async () => {
    const base = new InMemoryJournal();
    const orgA = withOrg(base, 'org-a');
    const orgB = withOrg(base, 'org-b');
    let calls = 0;
    const makeTool = (journal: any, runId: string) =>
      durableTool(
        {
          idempotency: 'args' as const,
          idempotencyWindow: 'cross-run' as const,
          execute: async () => { calls++; return { charged: 50, seq: calls }; },
        },
        { journal, runId },
        'charge',
      );

    const oA1 = await makeTool(orgA, 'run-A1').execute!({ orderId: 'X' }, { toolCallId: 'c1' });
    const oA2 = await makeTool(orgA, 'run-A2').execute!({ orderId: 'X' }, { toolCallId: 'c2' });
    expect(calls).toBe(1);
    expect(oA2).toEqual(oA1); // same org → dedup applies across runs

    const oB1 = await makeTool(orgB, 'run-B1').execute!({ orderId: 'X' }, { toolCallId: 'c3' });
    expect(calls).toBe(2); // different org → its OWN cross-run window, executes independently
    expect(oB1).not.toEqual(oA1);
  });
});

describe('cross-run idempotency — PARALLEL race across TWO DIFFERENT runs', () => {
  it('two concurrent executes from different runIds, same args → one runs, the other polls to the SAME output', async () => {
    const journal = new InMemoryJournal();
    let calls = 0;
    const makeTool = (runId: string) =>
      durableTool(
        {
          idempotency: 'args' as const,
          idempotencyWindow: 'cross-run' as const,
          execute: async () => { calls++; await sleep(30); return { ok: true, seq: calls }; },
        },
        { journal, runId },
        'pay',
      );

    const [r1, r2] = await Promise.all([
      makeTool('run-P1').execute!({ a: 1 }, { toolCallId: 'call-A' }),
      makeTool('run-P2').execute!({ a: 1 }, { toolCallId: 'call-B' }),
    ]);

    expect(calls).toBe(1); // no RunBusyError, no double side-effect — the loser polled instead
    expect(r1).toEqual(r2); // both got the output of the SAME execution
  });
});

describe('cross-run idempotency — cleanup via deletePrefix("xrun:")', () => {
  it('after purging the cross-run namespace, the SAME arguments execute again', async () => {
    const journal = new InMemoryJournal();
    let calls = 0;
    const makeTool = (runId: string) =>
      durableTool(
        {
          idempotency: 'args' as const,
          idempotencyWindow: 'cross-run' as const,
          execute: async () => { calls++; return { charged: 10, seq: calls }; },
        },
        { journal, runId },
        'charge',
      );

    const o1 = await makeTool('run-C1').execute!({ orderId: 'Y' }, { toolCallId: 'c1' });
    expect(calls).toBe(1);

    const deleted = await journal.deletePrefix('xrun:');
    expect(deleted).toBeGreaterThan(0); // documents the purge path from types.ts's TSDoc

    const o2 = await makeTool('run-C2').execute!({ orderId: 'Y' }, { toolCallId: 'c2' });
    expect(calls).toBe(2); // record was purged → re-executed
    expect(o2).not.toEqual(o1);
  });
});
