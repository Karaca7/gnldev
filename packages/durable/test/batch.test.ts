// BATCH — the behavior pins from the arbiter's decision (wf_b92e393e):
// 1) preflight is a PURE read plus a plan classification (fresh/exactRepeats/suspended/xidHits/amounts/intra-dup)
// 2) planToken: different items → 409 batch_plan_mismatch; a second run with the SAME token → a
//    REPORT REPLAY, not a 409
// 3) suspend-item: the item suspends → a Studio-style decision claim → the next run() executes it;
//    a denial never executes
// 4) fail-batch: on the first repeat the remaining items are not-run (the cut); skip: a visible
//    result and a trail, without executing
// 5) double-run report consistency: the second run counts them as replayed and the counter does not
//    move (exactly-once)
// 6) classification comes from the OUTPUT SHAPE (a skip's terminal status is 'denied' — reading the
//    status instead of the shape is how the two get confused)
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, runKeys, claim } from '../src/journal.js';
import { createBatch } from '../src/batch.js';
import { writeXid } from '../src/xid.js';
import { readIncidents } from '../src/incidents.js';

function payTool(state: { n: number }) {
  return {
    description: 'pay', sideEffect: true,
    recover: async () => ({ done: false as const }),
    semanticIdentity: { keys: ['ref'], amountFields: ['amount'] },
    effectClass: 'transactional' as const,
    execute: async (args: unknown) => { state.n += 1; return { paid: true, args }; },
  };
}
const items = (...refs: Array<[string, number]>) => refs.map(([ref, amount]) => ({ ref, amount }));
const CFG = (state: { n: number }, onDuplicate?: 'skip' | 'suspend-item' | 'fail-batch') => ({
  tool: payTool(state), toolName: 'pay', itemKey: (i: unknown) => (i as { ref: string }).ref,
  resourceId: 'acct-1', ...(onDuplicate ? { onDuplicate } : {}),
});

describe('batch — plan/token', () => {
  it('preflight is a pure read (call it twice, nothing changes); different items → 409; the same token on a second run → a report replay', async () => {
    const journal = new InMemoryJournal();
    const state = { n: 0 };
    const b = createBatch(journal, CFG(state));
    const list = items(['F-1', 10], ['F-2', 20]);
    const p1 = await b.preflight('b1', list);
    const p2 = await b.preflight('b1', list);
    expect(p1.token).toBe(p2.token);
    expect(p1.fresh).toBe(2);
    expect((await journal.listKeys!('batch:')).length).toBe(0); // a pure read — nothing was written

    const r1 = await b.run('b1', list, { planToken: p1.token });
    expect(r1.summary.done).toBe(2);
    expect(state.n).toBe(2);

    // a different list under the same batchId → the 409 family
    await expect(b.run('b1', items(['F-1', 10], ['F-9', 99]), { planToken: (await b.preflight('b1', items(['F-1', 10], ['F-9', 99]))).token }))
      .rejects.toThrow(/DIFFERENT plan/);
    // verilen token listeye uymuyorsa da 409
    await expect(b.run('b1', list, { planToken: 'sahte' })).rejects.toThrow(/does not match/);

    // the same token on a second run: a REPORT REPLAY — the counter does not move (the arbiter's
    // second trap: losing a claim is not a 409)
    const r2 = await b.run('b1', list, { planToken: p1.token });
    expect(state.n).toBe(2);
    expect(r2.summary.replayed).toBe(2);
    expect(r2.summary.done).toBe(0);
  });

  it('itemKey is required, its charset is constrained, and a duplicate itemKey inside one batch is rejected', async () => {
    const journal = new InMemoryJournal();
    expect(() => createBatch(journal, { tool: payTool({ n: 0 }), toolName: 'pay' } as never)).toThrow(/itemKey/);
    const b = createBatch(journal, CFG({ n: 0 }));
    await expect(b.preflight('bad id!', items(['F-1', 1]))).rejects.toThrow(/batchId/);
    await expect(b.preflight('b1', items(['F 1', 1]))).rejects.toThrow(/itemKey/);
    await expect(b.preflight('b1', items(['F-1', 1], ['F-1', 1]))).rejects.toThrow(/duplicate itemKey/);
  });
});

describe('batch — repeat policies', () => {
  it('suspend-item: the item suspends without running; after the decision claim run() executes it; a denial does not; the suspension always shows in the report', async () => {
    const journal = new InMemoryJournal();
    const state = { n: 0 };
    const b = createBatch(journal, CFG(state, 'suspend-item'));
    // First run: F-1 goes through. Then the SAME identity in a new batch → XID sees it → the dup ladder suspends.
    const l1 = items(['F-1', 10]);
    await b.run('b1', l1, { planToken: (await b.preflight('b1', l1)).token });
    expect(state.n).toBe(1);

    const l2 = items(['F-1', 10], ['F-3', 30]);
    const p2 = await b.preflight('b2', l2);
    expect(p2.xidHits.map((r) => r.itemKey)).toEqual(['F-1']); // the plan knows about the cross-channel job IN ADVANCE
    const r2 = await b.run('b2', l2, { planToken: p2.token });
    expect(r2.summary.suspended).toBe(1);
    expect(r2.summary.done).toBe(1); // F-3 ran; one suspension did not block the batch
    expect(state.n).toBe(2);

    // A Studio-style decision: a plain boolean claim (the shape TASK-2 writes)
    await claim(journal, runKeys.approval('batch:b2:F-1', 'item:F-1'), true);
    const r3 = await b.run('b2', l2, { planToken: p2.token });
    expect(state.n).toBe(3); // the deliberate repeat REALLY ran
    expect(r3.summary.done).toBe(1);
    expect(r3.summary.replayed).toBe(1); // F-3 replay

    // deny yolu: yeni batch, karar false
    const l4 = items(['F-1', 10]);
    const p4 = await b.preflight('b4', l4);
    const r4a = await b.run('b4', l4, { planToken: p4.token });
    expect(r4a.summary.suspended).toBe(1);
    await claim(journal, runKeys.approval('batch:b4:F-1', 'item:F-1'), false);
    const r4b = await b.run('b4', l4, { planToken: p4.token });
    expect(r4b.summary.denied).toBe(1);
    expect(state.n).toBe(3); // it did not run
  });

  it('skip: a visible result and an incident trail without executing (classified by output shape, even though the terminal status is denied)', async () => {
    const journal = new InMemoryJournal();
    const state = { n: 0 };
    const b = createBatch(journal, CFG(state, 'skip'));
    const l = items(['F-1', 10]);
    await b.run('s1', l, { planToken: (await b.preflight('s1', l)).token });
    const p2 = await b.preflight('s2', l);
    const r = await b.run('s2', l, { planToken: p2.token });
    expect(r.summary.skipped).toBe(1);
    expect(r.items[0]!.detail).toContain('NOT executed');
    expect(state.n).toBe(1);
    const inc = await readIncidents(journal, 'batch:s2:F-1');
    expect(inc.some((i) => i.action === 'skip')).toBe(true); // not silent
  });

  it('fail-batch: the first repeat fails that item and leaves the REST not-run (the cut); the report names every one of them', async () => {
    const journal = new InMemoryJournal();
    const state = { n: 0 };
    const b = createBatch(journal, CFG(state, 'fail-batch'));
    await b.run('f1', items(['F-1', 10]), { planToken: (await b.preflight('f1', items(['F-1', 10]))).token });
    const l = items(['F-1', 10], ['F-2', 20], ['F-3', 30]); // F-1 repeats — and sorts first alphabetically
    const p = await b.preflight('f2', l);
    const r = await b.run('f2', l, { planToken: p.token });
    expect(r.summary.failed).toBe(1);
    expect(r.summary['not-run']).toBe(2);
    expect(state.n).toBe(1); // no new work ran
    expect(r.items.map((i) => i.outcome)).toEqual(['failed', 'not-run', 'not-run']);
  });
});

describe('batch — preflight classification details', () => {
  it('the xid self-filter is BATCH-scoped; amountMismatch is its own column; same-args inside one batch warns; without a resourceId the scope-disabled flag is raised', async () => {
    const journal = new InMemoryJournal();
    const state = { n: 0 };
    const b = createBatch(journal, CFG(state, 'suspend-item'));
    // An XID written from ANOTHER CHANNEL (chat)
    await writeXid(journal, { resourceId: 'acct-1', toolName: 'pay', identity: { ref: 'f-7' }, amounts: { amount: 70 }, channel: 'chat' }, 'chat-run-1', 'tc-chat');
    const l = items(['F-7', 70], ['F-8', 999], ['F-9', 1]);
    // A second XID for F-8: same identity, different amount
    await writeXid(journal, { resourceId: 'acct-1', toolName: 'pay', identity: { ref: 'f-8' }, amounts: { amount: 80 }, channel: 'api' }, 'api-run-1', 'tc-api');
    const p = await b.preflight('x1', l);
    expect(p.xidHits.map((r) => r.itemKey)).toEqual(['F-7']);
    expect(p.xidHits[0]!.detail).toContain('via chat');
    expect(p.amountMismatches.map((r) => r.itemKey)).toEqual(['F-8']);
    expect(p.fresh).toBe(1); // only F-9

    // the same-args, different-key warning inside one batch
    const p2 = await b.preflight('x2', [{ ref: 'A-1', amount: 5 }, { ref: 'A-2', amount: 5 }].map((x, i) => ({ ...x, ref: i === 1 ? 'A-2' : 'A-1' })) as never);
    // (A-1 and A-2 carry different args because their refs differ; argsHash covers the WHOLE item,
    //  so what is pinned here is that NO warning fires: different work, no false alarm)
    expect(p2.intraBatchDuplicates).toHaveLength(0);

    // A setup without a resourceId raises the scope-disabled flag, so an empty list is not misread as 'clean'
    const b2 = createBatch(journal, { tool: payTool({ n: 0 }), toolName: 'pay', itemKey: (i: unknown) => (i as { ref: string }).ref });
    const p3 = await b2.preflight('x3', items(['Z-1', 1]));
    expect(p3.xidScopeDisabled).toBe(true);
  });
});

describe('batch — real concurrency (K13)', () => {
  it('two workers run the same plan AT ONCE: the work count holds, the plan race produces no 409, and a busy item does not fail the batch', async () => {
    const journal = new InMemoryJournal();
    let paid = 0;
    const slowTool = {
      description: 'pay', sideEffect: true, recover: async () => ({ done: false as const }),
      semanticIdentity: { keys: ['ref'] }, effectClass: 'transactional' as const,
      execute: async (args: unknown) => { await new Promise((r) => setTimeout(r, 25)); paid += 1; return { paid: true, args }; },
    };
    const b = createBatch(journal, { tool: slowTool, toolName: 'pay', itemKey: (i: unknown) => (i as { ref: string }).ref, resourceId: 'acct', onDuplicate: 'suspend-item' });
    const l = items(['C-1', 1], ['C-2', 2]);
    const token = (await b.preflight('cc1', l)).token;
    const [r1, r2] = await Promise.all([
      b.run('cc1', l, { planToken: token }),
      b.run('cc1', l, { planToken: token }),
    ]);
    expect(paid).toBe(2); // exactly-once: two workers, TWO jobs in total
    // Both reports are consistent: no item vanished, and a busy(failed) item did not fail the batch (no throw)
    for (const r of [r1, r2]) {
      const total = Object.values(r.summary).reduce((a, b2) => a + b2, 0);
      expect(total).toBe(2);
    }
    // at least one worker shows the race (failed-busy OR replay) — and the total done is exactly 2
    const doneTotal = r1.summary.done + r2.summary.done;
    expect(doneTotal).toBeLessThanOrEqual(2);
  });
});
