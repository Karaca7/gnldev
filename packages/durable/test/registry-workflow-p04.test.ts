// P0.4 (AUDIT-R2): registry.runWorkflow forwards opts.resume/opts.signal into
// WorkflowLike.runResumable AS-IS, and maps a {status:'canceled'} result into
// WorkflowRunResult.canceled the SAME way suspended/paused already are — see registry-step-through.test.ts
// for the sibling maxSteps/paused contract this mirrors.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { createGnl } from '../src/registry.js';

/** Minimal WorkflowLike stub: records every opts object runResumable was called with, and lets the
 *  test script canned per-call responses (suspended → canceled → completed, in order). */
function stubWorkflow(received: { opts: unknown[] }, responses: any[]) {
  let i = 0;
  return {
    build: () => [{ id: 'a' }],
    run: async () => 'unused',
    async runResumable(_input: unknown, _ctx: { runId: string; journal: any }, opts?: unknown) {
      received.opts.push(opts);
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      return r;
    },
  };
}

describe('registry: workflow P0.4 resume/signal forwarding + canceled mapping', () => {
  it('forwards opts.resume into runResumable; omits the field entirely when not given', async () => {
    const journal = new InMemoryJournal();
    const received = { opts: [] as unknown[] };
    const gnl = createGnl({
      journal,
      workflows: { w: stubWorkflow(received, [{ status: 'completed', output: 'done' }]) },
    });

    await gnl.runWorkflow('w', {}, { runId: 'p04-1', resume: { approval: { ok: true } } });
    expect(received.opts[0]).toEqual({ resume: { approval: { ok: true } }, workflowName: 'w' });

    // no resume → nothing to forward EXCEPT workflowName (FLOW-08: the registry always knows the
    // name, so it's always mirrored — the ONLY opts field that isn't conditionally omitted).
    await gnl.runWorkflow('w', {}, { runId: 'p04-1' });
    expect(received.opts[1]).toEqual({ workflowName: 'w' });
  });

  it('forwards opts.signal into runResumable', async () => {
    const journal = new InMemoryJournal();
    const received = { opts: [] as unknown[] };
    const gnl = createGnl({
      journal,
      workflows: { w: stubWorkflow(received, [{ status: 'completed', output: 'done' }]) },
    });
    const ctrl = new AbortController();
    await gnl.runWorkflow('w', {}, { runId: 'p04-2', signal: ctrl.signal });
    expect((received.opts[0] as any).signal).toBe(ctrl.signal);
  });

  it('maps a {status:"canceled"} result into WorkflowRunResult.canceled + stepId/reason, mirroring suspended/paused', async () => {
    const journal = new InMemoryJournal();
    const received = { opts: [] as unknown[] };
    const gnl = createGnl({
      journal,
      workflows: {
        w: stubWorkflow(received, [{ status: 'canceled', stepId: 'a', reason: 'operator abort' }]),
      },
    });
    const r = await gnl.runWorkflow('w', {}, { runId: 'p04-3' });
    expect(r.canceled).toBe(true);
    expect(r.suspended).toBe(false);
    expect(r.paused).toBe(false);
    expect(r.stepId).toBe('a');
    expect(r.reason).toBe('operator abort');
    expect(r.output).toBeUndefined();
  });

  it('a completed result reports canceled: false (not undefined) — same always-present-boolean shape as suspended/paused', async () => {
    const journal = new InMemoryJournal();
    const received = { opts: [] as unknown[] };
    const gnl = createGnl({
      journal,
      workflows: { w: stubWorkflow(received, [{ status: 'completed', output: 'ok' }]) },
    });
    const r = await gnl.runWorkflow('w', {}, { runId: 'p04-4' });
    expect(r).toMatchObject({ suspended: false, paused: false, canceled: false, output: 'ok' });
  });
});

// FLOW-08: the `wfrun:` run-registry record didn't carry the workflow's NAME, only its runId — the
// studio run list had to derive a name from the runId. `runWorkflow` now forwards `opts.workflowName`
// into `runResumable` AUTOMATICALLY (registered-name lookups happen right here — the caller of
// `runWorkflow('w', ...)` never has to pass a name themselves). @gnl/durable stays intentionally
// decoupled from @gnl/workflow (structural WorkflowLike typing — see registry.ts's JSDoc), so this
// stub mirrors the REAL runResumable's `wfrun:` write (see @gnl/workflow's `putStatus`) to prove the
// name actually reaches a status record end-to-end, without importing @gnl/workflow.
describe('registry: FLOW-08 — workflow name auto-populated into the wfrun: registry via runWorkflow', () => {
  function stubWorkflowWithStatusWrite(journal: InMemoryJournal) {
    return {
      build: () => [{ id: 'a' }],
      run: async () => 'unused',
      async runResumable(_input: unknown, ctx: { runId: string; journal: any }, opts?: { workflowName?: string }) {
        // Mirrors @gnl/workflow's putStatus: workflowName written ONLY when present (additive).
        await journal.put(`wfrun:${ctx.runId}`, {
          runId: ctx.runId,
          status: 'completed',
          ...(opts?.workflowName !== undefined ? { workflowName: opts.workflowName } : {}),
          updatedAt: Date.now(),
        });
        return { status: 'completed' as const, output: 'done' };
      },
    };
  }

  it('(c) a real registry-driven run gets its workflowName written into wfrun: WITHOUT the caller passing it', async () => {
    const journal = new InMemoryJournal();
    const gnl = createGnl({
      journal,
      workflows: { 'approval-flow': stubWorkflowWithStatusWrite(journal) },
    });

    // Caller passes only runId — no workflowName anywhere in the call.
    await gnl.runWorkflow('approval-flow', {}, { runId: 'flow08-real-1' });

    const record = await journal.get<{ runId: string; workflowName?: string }>('wfrun:flow08-real-1');
    expect(record?.workflowName).toBe('approval-flow');
  });
});
