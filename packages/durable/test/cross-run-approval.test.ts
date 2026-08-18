// An approval on a `cross-run` tool must be actionable by the run that is waiting for it.
//
// The cross-run window drops the runId from the journal key on purpose — that is what makes the same
// arguments dedup across runs. The cost, unnoticed until measured, is that the run has NOTHING under
// its own prefix, so everything that describes a run from the journal goes blind at once:
//
//   readRun('runA')       → ['model']          the tool step is missing entirely
//   listRuns()            → status 'running'   'suspended' is derived from a run's tool records
//   Studio GET /approvals → []                 nothing to approve, for a run that is waiting
//
// And when a SECOND run reaches the same claim, it re-returns the stored sentinel — which embeds the
// FIRST run's toolCallId. So run B reported an id it never emitted, while its approval was looked up
// under its own. Measured: approve('call-A') left it suspended and executed nothing; deny('call-A')
// wrote no terminal record at all; approve('call-B') worked, but nothing ever showed anyone 'call-B'.
//
// That is precisely the failure durable-tool.ts's own comment says it closed ("the Studio Deny button
// did nothing") — reopened by a key that drops the runId.
//
// The fix writes a SHADOW record under `${runId}:tool:`, marked `mirrorOf`. The authoritative record
// stays run-independent, because that is what dedup needs; the shadow is only history and something to
// click. The marker is load-bearing in the other direction too: a cross-run action is SHARED, so a
// single run's unwind must not touch it (compensation-interactions.test.ts pins that, and caught this
// the first time the shadow was written without the marker).
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { compensateRun } from '../src/compensation.js';
import { gnlTool } from '../src/types.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

const guard = async () => ({ action: 'require-approval' as const, reason: 'big amount' });

/** A model that always emits `toolCallId`, so each run can be given a DIFFERENT one. */
const model = (toolCallId: string, toolName = 'charge', args: object = { orderId: 'X' }) =>
  createMockModel(async ({ prompt }: never) =>
    countToolResults(prompt as never) === 0
      ? toolCallResult(toolName, toolCallId, args)
      : finalTextResult('done'));

const chargeTool = (onExec: () => void) => gnlTool({
  description: 'charge',
  inputSchema: z.object({ orderId: z.string() }),
  idempotency: 'args',
  idempotencyWindow: 'cross-run',
  execute: async () => { onExec(); return { charged: 100 }; },
} as never);

describe('a cross-run tool suspended for approval', () => {
  it('leaves the run visible as suspended, with its step in the run\'s own history', async () => {
    const journal = new InMemoryJournal();
    const charge = chargeTool(() => {});
    await runDurable({ runId: 'runA', journal, model: model('call-A'), tools: { charge }, guard, prompt: 'go' } as never);

    const kinds = (await journal.readRun('runA')).map((e) => e.kind);
    expect(kinds, 'the run has no record that the tool step happened').toContain('tool');
    const runs = await journal.listRuns();
    expect(runs.find((r) => r.runId === 'runA')?.status, 'a run waiting for approval reported itself as running').toBe('suspended');
  });

  it('reports the toolCallId of the run that is ASKING, not of the run that first suspended', async () => {
    const journal = new InMemoryJournal();
    const charge = chargeTool(() => {});
    await runDurable({ runId: 'runA', journal, model: model('call-A'), tools: { charge }, guard, prompt: 'go' } as never);
    const b = await runDurable({ runId: 'runB', journal, model: model('call-B'), tools: { charge }, guard, prompt: 'go' } as never);

    expect(b.interrupts?.[0]?.toolCallId, 'run B reported an id it never emitted').toBe('call-B');
  });

  it('approving the id that was REPORTED runs the tool — exactly once, across both runs', async () => {
    const journal = new InMemoryJournal();
    let executed = 0;
    const charge = chargeTool(() => { executed++; });
    await runDurable({ runId: 'runA', journal, model: model('call-A'), tools: { charge }, guard, prompt: 'go' } as never);
    const b = await runDurable({ runId: 'runB', journal, model: model('call-B'), tools: { charge }, guard, prompt: 'go' } as never);

    const reported = b.interrupts![0]!.toolCallId;
    const done = await runDurable({
      runId: 'runB', journal, model: model('call-B'), tools: { charge }, guard, prompt: 'go',
      approvals: { [reported]: true },
    } as never);

    expect(done.interrupts ?? [], 'approving the id the operator was shown did nothing').toHaveLength(0);
    expect(executed, 'the shared action ran a second time').toBe(1);
  });

  it('DENYING the id that was reported writes a terminal record — not a silent no-op', async () => {
    // The half that was quietest. A denial that leaves the record 'suspended' looks identical to an
    // operator who has not decided yet: the run stays parked, the inbox keeps offering the same
    // button, and pressing it keeps doing nothing.
    const journal = new InMemoryJournal();
    let executed = 0;
    const charge = chargeTool(() => { executed++; });
    await runDurable({ runId: 'runA', journal, model: model('call-A'), tools: { charge }, guard, prompt: 'go' } as never);
    const b = await runDurable({ runId: 'runB', journal, model: model('call-B'), tools: { charge }, guard, prompt: 'go' } as never);

    await runDurable({
      runId: 'runB', journal, model: model('call-B'), tools: { charge }, guard, prompt: 'go',
      approvals: { [b.interrupts![0]!.toolCallId]: false },
    } as never);

    const authoritative = (await journal.listKeys('')).find((k) => k.startsWith('xrun:'))!;
    const record = await journal.get(authoritative) as { status?: string };
    expect(record?.status, 'the denial was a silent no-op — the record stayed suspended').toBe('denied');
    expect(executed).toBe(0);
  });

  it('the shadow is NOT the authoritative record: dedup across runs still holds', async () => {
    // The guarantee the run-independent key exists for. If the shadow were ever read as the record,
    // each run would find its own copy and charge again — the shape of the bug this whole window
    // prevents. Asserted without a guard so nothing suspends: two runs, same arguments, one charge.
    const journal = new InMemoryJournal();
    let executed = 0;
    const charge = chargeTool(() => { executed++; });
    await runDurable({ runId: 'r1', journal, model: model('c1'), tools: { charge }, prompt: 'go' } as never);
    await runDurable({ runId: 'r2', journal, model: model('c2'), tools: { charge }, prompt: 'go' } as never);

    expect(executed, 'the shadow was treated as the record and the charge ran twice').toBe(1);
  });

  it('a single run\'s unwind still does not touch the SHARED action', async () => {
    // compensation-interactions.test.ts states this invariant already; repeated here against the
    // shadow specifically, because the shadow is the thing that could break it and did, once.
    const journal = new InMemoryJournal();
    let compensated = 0;
    const welcome = gnlTool({
      description: 'welcome email — once EVER',
      inputSchema: z.object({ user: z.string() }),
      idempotencyWindow: 'cross-run',
      execute: async () => ({ sent: true }),
      compensate: async () => { compensated++; return {}; },
    } as never);
    await runDurable({
      runId: 'xr-1', journal, model: model('call-1', 'welcome', { user: 'u1' }), tools: { welcome }, prompt: 'go',
    } as never);

    const report = await compensateRun('xr-1', { journal, tools: { welcome } } as never);
    expect(report.entries, 'the run\'s unwind reached a record other runs depend on').toHaveLength(0);
    expect(compensated).toBe(0);
  });
});
