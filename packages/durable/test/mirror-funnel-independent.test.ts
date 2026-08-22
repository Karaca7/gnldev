// The shadow record, from the four angles a happy-path test does not reach.
//
// A cross-run tool's authoritative record lives at a run-independent key (`xrun:args-…`). The mirror
// under `${runId}:tool:${toolCallId}` exists for two reasons only — the run needs a timeline, and the
// operator needs something to click — so its correctness properties are:
//
//   1. it AGREES with the authoritative record (a stale copy is worse than no copy: time-travel stops
//      matching on the key once resolvedIds are present, so a disagreeing mirror offers a human an
//      approval for a charge that already went through);
//   2. it is written from EVERY read-and-return point, including the two that used to return early —
//      "this id is already in the list" and the suspend branch's "only when the id differs";
//   3. it is REFRESHED, so a run that consumed a record which has since moved on does not keep
//      advertising the old status;
//   4. it does not exist at all for `withIdempotency`, which has no run and no approvals channel.
//
// Written independently of the author's own cross-run-mirror-faults.test.ts / mirror-limit-accounting.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { withIdempotency } from '../src/idempotent-tools.js';
import { gnlTool } from '../src/types.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

/** A mirror write is a put to `${runId}:tool:…`; the authoritative cross-run key starts `xrun:`. */
const isMirrorKey = (key: string): boolean => key.includes(':tool:') && !key.startsWith('xrun:');

/** Fails the FIRST N mirror writes, then behaves normally. Counts every attempt. */
class FlakyMirrorJournal extends InMemoryJournal {
  attempts = 0;
  constructor(private failFirst = 1) { super(); }
  override async put(key: string, value: unknown): Promise<void> {
    if (isMirrorKey(key)) {
      this.attempts++;
      if (this.failFirst > 0) { this.failFirst--; throw new Error('ECONNRESET: journal write failed'); }
    }
    return super.put(key, value);
  }
}

const model = (toolCallId: string) =>
  createMockModel(async ({ prompt }: never) =>
    countToolResults(prompt as never) === 0
      ? toolCallResult('charge', toolCallId, { orderId: 'o-1' })
      : finalTextResult('done'));

const chargeTool = (onExec: () => void) => gnlTool({
  description: 'charge',
  inputSchema: z.object({ orderId: z.string() }),
  idempotency: 'args',
  idempotencyWindow: 'cross-run',
  execute: async () => { onExec(); return { charged: 100 }; },
} as never);

const needsApproval = async () => ({ action: 'require-approval' as const, reason: 'big amount' });

/** The one authoritative record for this corpus. */
async function authoritative(journal: InMemoryJournal): Promise<{ key: string; value: any }> {
  const key = (await journal.listKeys('')).find((k) => k.startsWith('xrun:'))!;
  expect(key, 'no cross-run record was written — the fixture is wrong').toBeTruthy();
  return { key, value: await journal.get(key) };
}

const mirror = (journal: InMemoryJournal, runId: string, toolCallId: string): Promise<any> =>
  journal.get(`${runId}:tool:${toolCallId}`);

afterEach(() => { vi.restoreAllMocks(); });

describe('the mirror and the authoritative record', () => {
  // The measured failure: the updated resolvedToolCallIds went to the authoritative key while the
  // STALE local copy was mirrored, leaving `["call-A","call-B"]` against a mirror holding
  // `["call-A"]`. Asserting the mirror merely EXISTS would not have seen it.
  it('carry the same resolvedToolCallIds after a second run consumes the record', async () => {
    const journal = new InMemoryJournal();
    const charge = chargeTool(() => {});
    await runDurable({ runId: 'runA', journal, model: model('call-A'), tools: { charge }, prompt: 'go' } as never);
    await runDurable({ runId: 'runB', journal, model: model('call-B'), tools: { charge }, prompt: 'go' } as never);

    const auth = await authoritative(journal);
    const shadowB = await mirror(journal, 'runB', 'call-B');

    expect(auth.value.resolvedToolCallIds, 'the authoritative record did not record both calls')
      .toEqual(['call-A', 'call-B']);
    expect(shadowB, 'the deduping run got no history at all').toBeTruthy();
    expect(shadowB.resolvedToolCallIds, 'the mirror disagrees with the record it is a copy of — a human is offered an approval for a charge that already went through')
      .toEqual(auth.value.resolvedToolCallIds);
  });

  // `mirrorOf` is what keeps the shadow out of compensateRun's worklist and out of the limits seed.
  it('the mirror names the authoritative key it copies', async () => {
    const journal = new InMemoryJournal();
    const charge = chargeTool(() => {});
    await runDurable({ runId: 'runA', journal, model: model('call-A'), tools: { charge }, prompt: 'go' } as never);

    const auth = await authoritative(journal);
    const shadow = await mirror(journal, 'runA', 'call-A');
    expect(shadow?.mirrorOf, 'an unmarked shadow is indistinguishable from a real tool record').toBe(auth.key);
  });
});

describe('a mirror lost to a transient failure', () => {
  // The write used to be effectively write-once: the second consume hit `ids.includes(toolCallId)`
  // and returned before reaching the mirror, so one ECONNRESET was permanent. Measured then: the run
  // had NO tool record, listRuns reported it `running` with 0 tool calls, and a later replay did not
  // retry — attempts stayed at 1.
  it('is written by the NEXT consume of the same record, in the same run', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const journal = new FlakyMirrorJournal(1);
    let executed = 0;
    const charge = chargeTool(() => { executed++; });

    await runDurable({ runId: 'runA', journal, model: model('call-A'), tools: { charge }, prompt: 'go' } as never);
    expect(journal.attempts, 'the mirror was never attempted — this test proves nothing').toBe(1);
    expect(await mirror(journal, 'runA', 'call-A'), 'the injected failure did not take effect').toBeUndefined();

    // The same run, replayed. Nothing new to execute; the record is consumed again.
    await runDurable({ runId: 'runA', journal, model: model('call-A'), tools: { charge }, prompt: 'go' } as never);

    expect(executed, 'the replay re-executed the side effect').toBe(1);
    expect(journal.attempts, 'the mirror write was not retried on the next consume').toBeGreaterThan(1);
    expect(await mirror(journal, 'runA', 'call-A'), 'the run has no timeline entry and the operator has nothing to click, permanently')
      .toBeTruthy();
  });

  // The suspend branch had its own early return ("only when the id differs"), so a run whose stored
  // sentinel already carries ITS OWN id never re-mirrored.
  it('is written by a later consume even when the stored sentinel already carries THIS run\'s id', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const journal = new FlakyMirrorJournal(1);
    const charge = chargeTool(() => {});

    // Suspends. The mirror write is the one that fails.
    await runDurable({ runId: 'runA', journal, model: model('call-A'), tools: { charge }, guard: needsApproval, prompt: 'go' } as never);
    expect(await mirror(journal, 'runA', 'call-A'), 'the injected failure did not take effect').toBeUndefined();
    const auth = await authoritative(journal);
    expect(auth.value.status, 'the fixture did not suspend').toBe('suspended');
    expect(auth.value.output?.__gnl_suspend?.toolCallId, 'the sentinel does not carry runA\'s own id — the branch under test is not the one being taken')
      .toBe('call-A');

    // Replay, still unapproved: the suspended record is consumed with sus.toolCallId === toolCallId.
    await runDurable({ runId: 'runA', journal, model: model('call-A'), tools: { charge }, guard: needsApproval, prompt: 'go' } as never);

    const shadow = await mirror(journal, 'runA', 'call-A');
    expect(shadow, 'the suspend branch returned without mirroring, so this run stays invisible to the approvals inbox').toBeTruthy();
    expect(shadow.status).toBe('suspended');
  });
});

describe('a run that consumed a record which has since moved on', () => {
  // The permanent phantom approval, end to end. runA suspends; runB suspends on the same claim; the
  // operator approves in runB and the charge runs; runA replays. If runA's shadow is not refreshed it
  // stays `suspended` forever — listRuns reports a COMPLETED run as suspended, Studio's approvals
  // inbox keeps offering a charge that already went through, and retention cannot sweep the run.
  it('has its shadow refreshed to the record\'s current status', async () => {
    const journal = new InMemoryJournal();
    let executed = 0;
    const charge = chargeTool(() => { executed++; });
    const opts = { journal, tools: { charge }, guard: needsApproval, prompt: 'go' };

    await runDurable({ runId: 'runA', model: model('call-A'), ...opts } as never);
    const b1 = await runDurable({ runId: 'runB', model: model('call-B'), ...opts } as never);
    expect(b1.interrupts?.[0]?.toolCallId, 'run B was not offered its own id').toBe('call-B');

    // The operator approves in run B. The charge runs; the authoritative record becomes succeeded.
    await runDurable({ runId: 'runB', model: model('call-B'), approvals: { 'call-B': true }, ...opts } as never);
    expect(executed, 'the approval did not run the tool').toBe(1);
    expect((await authoritative(journal)).value.status).toBe('succeeded');

    // Run A replays and completes. Its shadow must not still say `suspended`.
    await runDurable({ runId: 'runA', model: model('call-A'), ...opts } as never);

    const shadowA = await mirror(journal, 'runA', 'call-A');
    expect(shadowA.status, 'run A advertises an approval for a charge that already went through')
      .toBe('succeeded');
    const runs = await journal.listRuns();
    expect(runs.find((r) => r.runId === 'runA')?.status, 'a completed run reports itself as suspended, and retention will not sweep it')
      .not.toBe('suspended');
  });
});

describe('a failing mirror on the DEDUPING run', () => {
  // The best-effort guard has to hold on the consume path too, not only on the path that writes the
  // terminal. If it does not, a convenience write turns the deduping run into a failure.
  it('does not stop the run, re-execute the side effect, or damage the authoritative record', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const journal = new FlakyMirrorJournal(Number.MAX_SAFE_INTEGER); // every mirror write fails
    let executed = 0;
    const charge = chargeTool(() => { executed++; });

    await runDurable({ runId: 'runA', journal, model: model('call-A'), tools: { charge }, prompt: 'go' } as never);
    const b = await runDurable({ runId: 'runB', journal, model: model('call-B'), tools: { charge }, prompt: 'go' } as never);

    expect(executed, 'the deduping run re-charged').toBe(1);
    expect(b.text, 'the run did not finish').toBe('done');
    const auth = await authoritative(journal);
    expect(auth.value.status, 'a failed CONVENIENCE write damaged the record that decides whether the side effect happened').toBe('succeeded');
    expect(auth.value.resolvedToolCallIds, 'the authoritative write was lost along with the mirror').toEqual(['call-A', 'call-B']);
    expect(warn.mock.calls.flat().join(' '), 'the loss was swallowed silently').toContain('could not mirror');
  });
});

describe('withIdempotency', () => {
  const idemTool = (onExec: () => void) => ({
    description: 'charge',
    inputSchema: z.object({ orderId: z.string() }),
    execute: async () => { onExec(); return { charged: 100 }; },
  });

  // No approvals channel means no run: the ctx is a journal and a placeholder runId shared by every
  // call in the process. Measured before the guard: one business key called 1000 times took the
  // journal from 2 rows to 1001, and listRuns reported a single run 'ambient' with 1000 tool calls.
  it('writes no shadow, so its journal does not grow with the number of deduped calls', async () => {
    const journal = new InMemoryJournal();
    let executed = 0;
    const tools = withIdempotency({ charge: idemTool(() => { executed++; }) } as never, { journal } as never) as any;

    await tools.charge.execute({ orderId: 'o-1' }, { toolCallId: 'c-1' });
    const afterFirst = (await journal.listKeys('')).length;
    for (let i = 2; i <= 25; i++) await tools.charge.execute({ orderId: 'o-1' }, { toolCallId: `c-${i}` });

    expect(executed, 'the dedup itself is broken — this test would prove nothing').toBe(1);
    expect((await journal.listKeys('')).length, 'the hot path of this API writes a row per call, and nothing ever sweeps them')
      .toBe(afterFirst);
    expect((await journal.listKeys('')).filter((k) => isMirrorKey(k)), 'a shadow was written for a caller that has no run')
      .toEqual([]);
  });

  it('invents no run — listRuns stays empty', async () => {
    const journal = new InMemoryJournal();
    const tools = withIdempotency({ charge: idemTool(() => {}) } as never, { journal } as never) as any;
    for (let i = 1; i <= 5; i++) await tools.charge.execute({ orderId: 'o-1' }, { toolCallId: `c-${i}` });

    expect(await journal.listRuns(), 'a placeholder runId surfaced as a real run with tool calls').toEqual([]);
  });

  // An explicit runId is still not a run: it scopes dedup in the 'run' window and nothing else.
  it('writes no shadow even when the caller supplies a runId', async () => {
    const journal = new InMemoryJournal();
    const tools = withIdempotency({ charge: idemTool(() => {}) } as never, { journal, runId: 'r9' } as never) as any;
    await tools.charge.execute({ orderId: 'o-1' }, { toolCallId: 'c-1' });
    await tools.charge.execute({ orderId: 'o-1' }, { toolCallId: 'c-2' });

    expect((await journal.listKeys('')).filter((k) => k.startsWith('r9:tool:'))).toEqual([]);
  });
});
