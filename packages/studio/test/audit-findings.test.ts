// AUDIT FINDINGS — round 12 (audit-log.md).
//
// #27 — `StudioAgentRunner` declares four parameters and the server passes all four
// (server.ts:3823, 3867, 3892, 4938), but `createStudioRunner` took THREE, so `ctx` was discarded by
// arity. `StudioCallbackCtx` is { orgId?, actor? }, and the `actor` comment describes it as a
// security mechanism ("the stamp was there, but Studio never identified itself, so the check NEVER
// fired"). runner.ts calls itself the single source of truth for @gnldev/cli and studio `--config`.
//
// These tests SPY on the underlying `gnl` and assert the object ARRIVES. An earlier version of this
// file asserted `fn.length >= 4` instead — and an audit proved that useless: taking `ctx` and then
// dropping it on the floor in the body, which is verbatim the defect above, kept every arity test
// green. Parameter counts are satisfied by an unused parameter and by nothing else.
import { describe, it, expect } from 'vitest';
import { createStudioRunner } from '../src/runner.js';

const cfg = { agents: { a: { model: 'm', tools: { t: { description: 'd', execute: async () => 1 } } } } } as any;
const CTX = { orgId: 'acme', actor: 'ayse' };

function spyGnl() {
  const seen: Record<string, unknown[]> = {};
  return {
    seen,
    gnl: {
      run: async (...args: unknown[]) => { seen.run = args; return { text: 'ok' }; },
      stream: async (...args: unknown[]) => { seen.stream = args; return {}; },
      runWorkflow: async (...args: unknown[]) => { seen.runWorkflow = args; return {}; },
      listWorkflows: () => [{ name: 'w' }],
    } as any,
  };
}

describe('#27 the ctx the server computes must reach the engine', () => {
  it('run forwards ctx as the third argument', async () => {
    const { gnl, seen } = spyGnl();
    const r: any = createStudioRunner(gnl, cfg, { toJsonSchema: (s: any) => s });
    await r.run('a', { runId: 'r1', prompt: 'x' }, CTX);
    expect(seen.run?.[2], 'the org/actor the server worked out was dropped on the floor').toEqual(CTX);
  });

  it('stream forwards ctx as the third argument', async () => {
    const { gnl, seen } = spyGnl();
    const r: any = createStudioRunner(gnl, cfg, { toJsonSchema: (s: any) => s });
    await r.stream('a', { runId: 'r1', prompt: 'x' }, CTX);
    expect(seen.stream?.[2]).toEqual(CTX);
  });

  it('runWorkflow forwards ctx as the fourth argument', async () => {
    const { gnl, seen } = spyGnl();
    const r: any = createStudioRunner(gnl, { ...cfg, workflows: { w: {} } }, { toJsonSchema: (s: any) => s });
    await r.runWorkflow('w', { in: 1 }, { runId: 'r1' }, CTX);
    expect(seen.runWorkflow?.[3]).toEqual(CTX);
  });

  it('the run options still arrive intact alongside ctx', async () => {
    const { gnl, seen } = spyGnl();
    const r: any = createStudioRunner(gnl, cfg, { toJsonSchema: (s: any) => s });
    await r.run('a', { runId: 'r1', prompt: 'x', actor: 'from-opts' }, CTX);
    expect(seen.run?.[0]).toBe('a');
    expect(seen.run?.[1], 'the ownership lock reads actor from HERE, not from ctx').toMatchObject({ runId: 'r1', actor: 'from-opts' });
  });

  it('runTool ACCEPTS ctx even though durableTool has nowhere to forward it', () => {
    // Honest about what this one is: the parameter is taken and unused (`_ctx` in the source). The
    // point is the contract the reference implementation teaches, so arity is the only thing there
    // is to check here — and it is stated as such rather than dressed up as a behaviour test.
    const r: any = createStudioRunner(spyGnl().gnl, cfg, { toJsonSchema: (s: any) => s, toolExec: true });
    expect(r.runTool.length).toBeGreaterThanOrEqual(4);
  });
});
