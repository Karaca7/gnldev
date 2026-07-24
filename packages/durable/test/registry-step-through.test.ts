// Registry step-through contract: runWorkflow({maxSteps}) is forwarded to runResumable,
// the 'paused' result surfaces as WorkflowRunResult.paused/stepId.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { createGnl } from '../src/registry.js';

function stubWorkflow(received: { opts: unknown[] }) {
  return {
    build: () => [{ id: 'a' }, { id: 'b' }],
    run: async () => 'done',
    async runResumable(_input: unknown, ctx: { runId: string; journal: any }, opts?: { maxSteps?: number }) {
      received.opts.push(opts);
      if (opts?.maxSteps === 1) {
        await ctx.journal.put(`${ctx.runId}:wf:a`, 'a-output'); // first step ran
        return { status: 'paused' as const, stepId: 'b', partial: 'a-output' };
      }
      await ctx.journal.put(`${ctx.runId}:wf:a`, 'a-output');
      await ctx.journal.put(`${ctx.runId}:wf:b`, 'b-output');
      return { status: 'completed' as const, output: 'b-output' };
    },
  };
}

describe('registry: workflow step-through pass-through', () => {
  it('maxSteps is forwarded; paused result returns with stepId + step outputs', async () => {
    const journal = new InMemoryJournal();
    const received = { opts: [] as unknown[] };
    const gnl = createGnl({ journal, workflows: { w: stubWorkflow(received) } });

    const r1 = await gnl.runWorkflow('w', {}, { runId: 'st-api-1', maxSteps: 1 });
    expect(received.opts[0]).toEqual({ maxSteps: 1 });
    expect(r1.paused).toBe(true);
    expect(r1.stepId).toBe('b');
    expect(r1.steps.find((s) => s.id === 'a')?.output).toBe('a-output');
    expect(r1.steps.find((s) => s.id === 'b')?.output).toBeUndefined();

    const r2 = await gnl.runWorkflow('w', {}, { runId: 'st-api-1' }); // continue: without opts → runs to completion
    expect(received.opts[1]).toBeUndefined();
    expect(r2.paused).toBe(false);
    expect(r2.output).toBe('b-output');
  });

  it('workflow without runResumable throws a clear error with maxSteps', async () => {
    const gnl = createGnl({
      journal: new InMemoryJournal(),
      workflows: { legacy: { build: () => [{ id: 'x' }], run: async () => 'ok' } },
    });
    await expect(gnl.runWorkflow('legacy', {}, { maxSteps: 1 })).rejects.toThrow('does not support step-through');
  });
});
