// P0.4 (AUDIT-R2): typed HITL resume (waitForResume/ctx.resumeData) + durable cross-process
// cancel (cancelWorkflowRun) + the suspended-run registry (getWorkflowRunStatus/listWorkflowRuns).
import { describe, it, expect } from 'vitest';
import {
  workflow, step, asStep, waitForResume,
  cancelWorkflowRun, getWorkflowRunStatus, listWorkflowRuns,
  type JournalLike,
} from '../src/index.js';

/** Same minimal in-memory journal shape used by the other workflow tests (cas.test.ts/step-through.test.ts),
 *  extended with listKeys (P0.4's listWorkflowRuns requires it) and putIfAbsent (CAS, closer to real usage). */
function memJournal() {
  const m = new Map<string, unknown>();
  const j: JournalLike & { map: Map<string, unknown> } = {
    map: m,
    async get<T = unknown>(k: string): Promise<T | undefined> {
      return m.has(k) ? (structuredClone(m.get(k)) as T) : undefined;
    },
    async put(k: string, v: unknown): Promise<void> {
      m.set(k, structuredClone(v));
    },
    async putIfAbsent(k: string, v: unknown): Promise<boolean> {
      if (m.has(k)) return false;
      m.set(k, structuredClone(v));
      return true;
    },
    async listKeys(prefix: string): Promise<string[]> {
      return [...m.keys()].filter((k) => k.startsWith(prefix));
    },
  };
  return j;
}

describe('@gnl/workflow P0.4 — waitForResume', () => {
  it('(a) suspends carrying waitId; runResumable({resume}) completes with the payload AS the step output', async () => {
    const journal = memJournal();
    const wf = workflow<string>()
      .then(step('prepare', async (s: string) => s + '!'))
      .then(waitForResume<{ ok: boolean }>('approval'));
    const ctx = { runId: 'r-a', journal };

    const r1 = await wf.runResumable('hey', ctx);
    expect(r1).toEqual({ status: 'suspended', stepId: 'approval', waitId: 'approval', reason: { kind: 'resume' } });
    // prepare already ran and is journaled — resume must not re-run it.
    expect(await journal.get('r-a:wf:prepare')).toBe('hey!');

    const r2 = await wf.runResumable('hey', ctx, { resume: { approval: { ok: true } } });
    expect(r2).toEqual({ status: 'completed', output: { ok: true } });
  });

  it('(b) a validate() throw does NOT consume the payload — overwriting it and re-resuming succeeds', async () => {
    const journal = memJournal();
    const wf = workflow<string>().then(
      waitForResume<{ ok: boolean }>('approval', {
        validate: (v: any) => {
          if (typeof v?.ok !== 'boolean') throw new Error('bad payload: ok must be boolean');
          return v;
        },
      }),
    );
    const ctx = { runId: 'r-b', journal };
    await wf.runResumable('hey', ctx); // suspends

    await expect(wf.runResumable('hey', ctx, { resume: { approval: { ok: 'nope' } } })).rejects.toThrow('bad payload');
    // not consumed: no journaled step output, and the run is still resumable (not terminal).
    expect(await journal.get('r-b:wf:approval')).toBeUndefined();

    // the operator overwrites the payload with a corrected one — the SAME waitId, delivered again.
    const r2 = await wf.runResumable('hey', ctx, { resume: { approval: { ok: true } } });
    expect(r2).toEqual({ status: 'completed', output: { ok: true } });
  });

  it('(c) crash-sim: a resume payload delivered but never consumed survives for a later runResumable call (same journal, fresh ctx object)', async () => {
    const journal = memJournal();
    const wf = workflow<string>().then(waitForResume<{ ok: boolean }>('approval'));
    const ctx1 = { runId: 'r-c', journal };
    await wf.runResumable('hey', ctx1); // suspends

    // Simulate: an operator/process delivers the resume payload directly into the journal (the documented
    // key shape from StepCtx.resumeData's JSDoc: `<runId>:wf:_resume:<waitId>`) and then "crashes" WITHOUT
    // the delivering runResumable call ever consuming it (here: we never even ran runResumable with
    // `resume` — we write the exact same record runResumable({resume}) would have written).
    await journal.put('r-c:wf:_resume:approval', { ok: true });

    // A brand-new process picks it up: a FRESH ctx object (same journal instance), no `resume` option at all.
    const ctx2 = { runId: 'r-c', journal };
    const r2 = await wf.runResumable('hey', ctx2);
    expect(r2).toEqual({ status: 'completed', output: { ok: true } });
  });
});

describe('@gnl/workflow P0.4 — cancelWorkflowRun', () => {
  it('(d) cancels a suspended run FOREVER — resume returns canceled, again on a second attempt; canceling an already-completed run is a no-op (false)', async () => {
    const journal = memJournal();
    const wf = workflow<string>().then(waitForResume('approval'));
    const ctx = { runId: 'r-d', journal };
    const r1 = await wf.runResumable('hey', ctx);
    expect(r1.status).toBe('suspended');

    const cancelled = await cancelWorkflowRun(journal, 'r-d', { reason: 'operator abort' });
    expect(cancelled).toBe(true);

    const r2 = await wf.runResumable('hey', ctx, { resume: { approval: { ok: true } } });
    expect(r2).toEqual({ status: 'canceled', stepId: 'approval', reason: 'operator abort' });

    // FOREVER: a second resume attempt (even with a fresh ctx object) stays canceled.
    const r3 = await wf.runResumable('hey', { runId: 'r-d', journal }, { resume: { approval: { ok: true } } });
    expect(r3).toEqual({ status: 'canceled', stepId: 'approval', reason: 'operator abort' });

    const status = await getWorkflowRunStatus(journal, 'r-d');
    expect(status?.status).toBe('canceled');

    // Canceling an already-COMPLETED run is a no-op.
    const journal2 = memJournal();
    const wf2 = workflow<number>().then(step('a', async (n: number) => n + 1));
    const ctx2 = { runId: 'r-d2', journal: journal2 };
    const done = await wf2.runResumable(1, ctx2);
    expect(done.status).toBe('completed');
    const cancelledAfterDone = await cancelWorkflowRun(journal2, 'r-d2');
    expect(cancelledAfterDone).toBe(false);
    const status2 = await getWorkflowRunStatus(journal2, 'r-d2');
    expect(status2?.status).toBe('completed'); // stays completed, not clobbered into 'canceled'
  });

  it('(e) an aborted signal cancels BETWEEN steps and durably writes the flag — a later resume without any signal also stays canceled', async () => {
    const journal = memJournal();
    const wf = workflow<number>()
      .then(step('a', async (n: number) => n + 1))
      .then(step('b', async (n: number) => n * 10));
    const ctx = { runId: 'r-e', journal };
    const ctrl = new AbortController();
    ctrl.abort();

    const r1 = await wf.runResumable(1, ctx, { signal: ctrl.signal });
    expect(r1).toEqual({ status: 'canceled', stepId: 'a', reason: 'signal' });
    // step 'a' never actually ran — the cancel check fires BEFORE the step at that position.
    expect(await journal.get('r-e:wf:a')).toBeUndefined();

    // the durable `_canceled` flag now applies even to a resume WITHOUT any signal at all.
    const r2 = await wf.runResumable(1, ctx);
    expect(r2.status).toBe('canceled');
    expect(await journal.get('r-e:wf:a')).toBeUndefined(); // still never ran
  });
});

describe('@gnl/workflow P0.4 — listWorkflowRuns / getWorkflowRunStatus registry', () => {
  it('(f) filters by status with stepId/waitId; a completed run moves out of "suspended" into "completed"; throws without listKeys', async () => {
    const journal = memJournal();
    const wf = workflow<string>().then(waitForResume('approval'));
    const ctx = { runId: 'r-f', journal };
    await wf.runResumable('hey', ctx);

    const suspendedList = await listWorkflowRuns(journal, { status: 'suspended' });
    expect(suspendedList).toHaveLength(1);
    expect(suspendedList[0]).toMatchObject({ runId: 'r-f', status: 'suspended', stepId: 'approval', waitId: 'approval' });

    await wf.runResumable('hey', ctx, { resume: { approval: { ok: true } } });

    const completedList = await listWorkflowRuns(journal, { status: 'completed' });
    expect(completedList.map((r) => r.runId)).toContain('r-f');
    const suspendedAfter = await listWorkflowRuns(journal, { status: 'suspended' });
    expect(suspendedAfter.find((r) => r.runId === 'r-f')).toBeUndefined();

    // no filter → both would show up across multiple runs; sanity check unfiltered call works too.
    const all = await listWorkflowRuns(journal);
    expect(all.some((r) => r.runId === 'r-f' && r.status === 'completed')).toBe(true);

    // without listKeys → a clear, explicit error (not a silent empty list).
    const noListKeysJournal = { get: journal.get.bind(journal), put: journal.put.bind(journal) };
    await expect(listWorkflowRuns(noListKeysJournal as any, {})).rejects.toThrow(/listKeys/);
  });
});

describe('FLOW-08 — workflowName mirrored into the wfrun: status record', () => {
  it('(a) opts.workflowName is written into the wfrun: record and returned by getWorkflowRunStatus/listWorkflowRuns', async () => {
    const journal = memJournal();
    const wf = workflow<string>().then(waitForResume('approval'));
    const ctx = { runId: 'r-flow08-a', journal };

    await wf.runResumable('hey', ctx, { workflowName: 'my-workflow' });

    const status = await getWorkflowRunStatus(journal, 'r-flow08-a');
    expect(status?.workflowName).toBe('my-workflow');

    const list = await listWorkflowRuns(journal, { status: 'suspended' });
    expect(list.find((r) => r.runId === 'r-flow08-a')?.workflowName).toBe('my-workflow');

    // reaches 'completed' too.
    await wf.runResumable('hey', ctx, { resume: { approval: { ok: true } }, workflowName: 'my-workflow' });
    const completedStatus = await getWorkflowRunStatus(journal, 'r-flow08-a');
    expect(completedStatus).toEqual({
      runId: 'r-flow08-a',
      status: 'completed',
      workflowName: 'my-workflow',
      updatedAt: completedStatus!.updatedAt,
    });
  });

  it('(b) omitted workflowName → the wfrun: record is byte-for-byte the pre-FLOW-08 shape (no workflowName key at all)', async () => {
    const journal = memJournal();
    const wf = workflow<string>().then(waitForResume('approval'));
    const ctx = { runId: 'r-flow08-b', journal };

    await wf.runResumable('hey', ctx); // no workflowName passed

    const raw = journal.map.get('wfrun:r-flow08-b') as Record<string, unknown>;
    expect(raw).not.toHaveProperty('workflowName');
    expect(raw).toEqual({
      runId: 'r-flow08-b',
      status: 'suspended',
      stepId: 'approval',
      waitId: 'approval',
      reason: { kind: 'resume' },
      updatedAt: raw.updatedAt,
    });

    const status = await getWorkflowRunStatus(journal, 'r-flow08-b');
    expect(status?.workflowName).toBeUndefined();
  });
});

describe('@gnl/workflow P0.4 — nested asStep + waitForResume', () => {
  it('(g) an inner waitForResume suspends OUTWARD; the resume payload (addressed by waitId, per-run namespace) reaches the inner step', async () => {
    const journal = memJournal();
    const inner = workflow<string>().then(waitForResume<{ approved: boolean }>('innerApproval'));
    const outer = workflow<string>()
      .then(step('outerPrep', async (s: string) => s + '-prepped'))
      .then(asStep('inner', inner))
      .then(step('outerFinish', async (v: any) => ({ finished: v })));
    const ctx = { runId: 'r-g', journal };

    const r1 = await outer.runResumable('start', ctx);
    expect(r1).toEqual({ status: 'suspended', stepId: 'inner', waitId: 'innerApproval', reason: { kind: 'resume' } });
    // the outer step BEFORE the nested workflow already ran and is journaled.
    expect(await journal.get('r-g:wf:outerPrep')).toBe('start-prepped');

    const r2 = await outer.runResumable('start', ctx, { resume: { innerApproval: { approved: true } } });
    expect(r2).toEqual({ status: 'completed', output: { finished: { approved: true } } });
    // outerPrep did NOT re-run (still the same journaled value; no way to observe a re-run here directly,
    // but the nested step's namespaced key proves the resume reached the INNER step, not a top-level one).
    expect(await journal.get('r-g:wf:inner:innerApproval')).toEqual({ approved: true });
  });
});
