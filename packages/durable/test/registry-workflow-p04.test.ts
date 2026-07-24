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
    expect(received.opts[0]).toEqual({ resume: { approval: { ok: true } } });

    await gnl.runWorkflow('w', {}, { runId: 'p04-1' }); // no resume → opts is undefined (nothing to forward)
    expect(received.opts[1]).toBeUndefined();
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
