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

  it('does not leave the OTHER run holding a phantom approval for a charge that already ran', async () => {
    // The shadow was written once and never refreshed, which turned the fix into a worse version of the
    // bug it closed. Run A suspends and gets a `suspended` shadow; run B suspends on the same claim, the
    // operator approves in B, the charge runs, the authoritative record moves to `succeeded` — and run A
    // keeps its shadow at `suspended` forever. Measured before the replay path mirrored too: run A
    // COMPLETED (final model step written, text 'done') while listRuns reported it suspended
    // permanently, so Studio's inbox offered a human an approval for a charge that had already gone
    // through, Deny did nothing, and Approve printed a bogus "the journal recorded false" conflict.
    // Retention went blind at the same time: listStaleRuns excludes suspended, so run A was never
    // reclaimed.
    const journal = new InMemoryJournal();
    let executed = 0;
    const charge = chargeTool(() => { executed++; });
    await runDurable({ runId: 'runA', journal, model: model('call-A'), tools: { charge }, guard, prompt: 'go' } as never);
    const b = await runDurable({ runId: 'runB', journal, model: model('call-B'), tools: { charge }, guard, prompt: 'go' } as never);
    await runDurable({
      runId: 'runB', journal, model: model('call-B'), tools: { charge }, guard, prompt: 'go',
      approvals: { [b.interrupts![0]!.toolCallId]: true },
    } as never);

    // The operator now acts on the id run A's inbox entry is showing.
    const a = await runDurable({
      runId: 'runA', journal, model: model('call-A'), tools: { charge }, guard, prompt: 'go',
      approvals: { 'call-A': true },
    } as never);

    expect((a as { text?: string }).text, 'approving from run A\'s inbox entry did nothing').toBe('done');
    expect(executed, 'the shared action ran a second time').toBe(1);
    const runA = (await journal.listRuns()).find((r) => r.runId === 'runA');
    expect(runA?.status, 'a finished run still reports suspended — the inbox keeps it forever and retention never sweeps it').toBe('completed');
    const step = (await journal.readRun('runA')).find((e) => e.kind === 'tool');
    expect((step?.value as { status?: string })?.status, 'the run\'s own history still says suspended').toBe('succeeded');
  });

  it('does not leave the run\'s copy disagreeing with the record about who has been served', async () => {
    // The updated resolvedToolCallIds list was written to the authoritative key while the STALE local
    // copy was mirrored, so the two disagreed — authoritative `["call-A","call-B"]` against a mirror
    // still holding `["call-A"]`. time-travel.ts stops matching on the key once resolvedIds are
    // present, so a COMPLETED run reported a pending tool call, and Studio's GET /approvals offered a
    // human an approval for a charge that had already gone through. Deny then read as a silent no-op:
    // the record stays 'succeeded' and only the inbox row disappears.
    const journal = new InMemoryJournal();
    const charge = chargeTool(() => {});
    await runDurable({ runId: 'runA', journal, model: model('call-A'), tools: { charge }, guard, prompt: 'go' } as never);
    const b = await runDurable({ runId: 'runB', journal, model: model('call-B'), tools: { charge }, guard, prompt: 'go' } as never);
    await runDurable({
      runId: 'runB', journal, model: model('call-B'), tools: { charge }, guard, prompt: 'go',
      approvals: { [b.interrupts![0]!.toolCallId]: true },
    } as never);
    await runDurable({ runId: 'runA', journal, model: model('call-A'), tools: { charge }, guard, prompt: 'go' } as never);

    const authoritativeKey = (await journal.listKeys('')).find((k) => k.startsWith('xrun:'))!;
    const authoritative = await journal.get(authoritativeKey) as { resolvedToolCallIds?: string[] };
    const mirror = (await journal.readRun('runA')).find((e) => e.kind === 'tool')!.value as { resolvedToolCallIds?: string[] };

    expect(authoritative.resolvedToolCallIds, 'run A never recorded that its own id was served').toContain('call-A');
    expect(mirror.resolvedToolCallIds, 'the run\'s copy disagrees with the record about who has been served')
      .toEqual(authoritative.resolvedToolCallIds);
  });

  it('gives the DEDUPING run a history too, not only the one that wrote the terminal', async () => {
    // The shadow was written only from the terminal-write path, so of two runs doing the same work one
    // had a tool step and the other had none — and getRunCost reported different tool counts for them.
    const journal = new InMemoryJournal();
    const charge = chargeTool(() => {});
    await runDurable({ runId: 'first', journal, model: model('c1'), tools: { charge }, prompt: 'go' } as never);
    await runDurable({ runId: 'second', journal, model: model('c2'), tools: { charge }, prompt: 'go' } as never);

    const kinds = (await journal.readRun('second')).map((e) => e.kind);
    expect(kinds, 'the run that deduped has no record that the step happened').toContain('tool');
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
