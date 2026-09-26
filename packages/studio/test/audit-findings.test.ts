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
import { InMemoryJournal, createGnl, serverIdentityOf, sealRequestContext } from '@gnldev/durable';
import { createStudioRunner } from '../src/runner.js';
import { createStudioApi, type WorkflowDef } from '../src/server.js';
import { compileManagedWorkflow } from '../src/managed-workflow.js';
import { call } from './call.js';

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

// The runner above forwards ctx; this is the other end of the same wire. An agent step inside a
// MANAGED workflow reached the runner through runManaged, which called `run` with two arguments —
// so the fix to the runner could not help it. Asserted as parity with `/agents/:name/run`: whatever
// identity the server hands the runner for a direct agent call, a managed step must hand the same.
describe('#27 (server side) a managed workflow step hands the runner the same ctx as a direct call', () => {
  function appWithSpy(calls: unknown[][]) {
    const defs = new Map<string, WorkflowDef>([['m1', { name: 'm1', steps: [{ id: 's1', agentName: 'writer', prompt: 'Topic: {{input}}' }] }]]);
    return createStudioApi({
      reader: new InMemoryJournal(),
      gnl: {
        listAgents: () => [{ name: 'writer' }],
        run: async (...args: unknown[]) => { calls.push(args); return { text: 'ok' }; },
      } as any,
      compileWorkflow: compileManagedWorkflow,
      workflowStore: { list: () => [...defs.values()], get: (n: string) => defs.get(n), set: () => {}, delete: () => {} } as any,
    });
  }
  const post = (app: any, path: string, body: unknown) =>
    call(app, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  async function directCtx() {
    const calls: unknown[][] = [];
    await post(appWithSpy(calls), '/agents/writer/run', { runId: 'd1', prompt: 'x' });
    expect(calls).toHaveLength(1);
    expect(calls[0].length, 'the direct route is the reference: it must pass a ctx').toBe(3);
    return calls[0][2];
  }

  it('POST /workflows/:name/run', async () => {
    const calls: unknown[][] = [];
    const res = await post(appWithSpy(calls), '/workflows/m1/run', { input: 'cats' });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].length, 'the managed step called run without a ctx').toBe(3);
    expect(calls[0][2]).toEqual(await directCtx());
  });

  it('POST /workflows/:name/run-stream', async () => {
    const calls: unknown[][] = [];
    const res = await post(appWithSpy(calls), '/workflows/m1/run-stream', { input: 'cats' });
    await res.text(); // the managed run executes inside the SSE body
    expect(calls).toHaveLength(1);
    expect(calls[0].length, 'the streamed managed step called run without a ctx').toBe(3);
    expect(calls[0][2]).toEqual(await directCtx());
  });
});

// ── one layer further down, because the spy above stops one short ─────────────────────────────────
//
// The tests above assert the ADAPTER calls `gnl` with the ctx object. They pass against a `gnl` that
// ignores it entirely, and the real one did: `gnl.run`/`stream`/`runWorkflow` take 2, 2 and 3
// parameters (measured with `fn.length`), so the ctx arrived as `arguments[n]` with nothing to name it.
// createGnl reads identity from `opts.context` via `serverIdentityOf`, and nothing wrote that field.
//
// The history here is the point. An arity assertion was replaced by a spy assertion after an audit
// proved arity useless — and the spy has the same shape of gap one layer down. These tests use a REAL
// createGnl and assert what the ENGINE sees, which is what the describe above has always claimed.
describe('#27b the ctx must reach the ENGINE, not just the call', () => {
  const model = {
    specificationVersion: 'v2', provider: 'm', modelId: 'm', supportedUrls: {},
    doGenerate: async () => ({ content: [{ type: 'text', text: 'ok' }], finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] }),
    doStream: async () => { throw new Error('no stream'); },
  } as any;

  it('a dynamic system() sees the calling organization', async () => {
    // Measured before the fix: `{ keys: [], id: {} }`.
    const seen: unknown[] = [];
    const cfg = { journal: new InMemoryJournal(), agents: { a: { model,
      system: (rc: Record<string, unknown>) => { seen.push(serverIdentityOf(rc)); return 'sys'; } } } } as any;
    const runner = createStudioRunner(cfg.gnlOverride ?? createGnl(cfg), cfg, { toJsonSchema: () => ({}) } as any);
    await runner.run('a', { prompt: 'hi', runId: 'r-org-1' }, { orgId: 'acme-ltd' });
    expect(seen[0], 'the organization the server worked out must reach the engine').toMatchObject({ orgId: 'acme-ltd' });
  }, 60_000);

  it('and the reserved key is SEALED — the caller cannot name its own organization', async () => {
    // The adapter must not merely copy an org in: a context a caller supplied has its reserved keys
    // stripped before the server's is written. Studio forwards no `context` from a request body today,
    // so this pins the property rather than a reachable hole.
    const seen: unknown[] = [];
    const cfg = { journal: new InMemoryJournal(), agents: { a: { model,
      system: (rc: Record<string, unknown>) => { seen.push(serverIdentityOf(rc)); return 'sys'; } } } } as any;
    const runner = createStudioRunner(createGnl(cfg), cfg, { toJsonSchema: () => ({}) } as any);
    // Asserting the RESERVED KEYS a plain `{...ctx, __gnl_orgId}` would leave behind, because that is
    // what distinguishes a seal from last-write-wins. Measured: overwriting the one key keeps
    // `org: 'victim'` AND `__gnl_resourceId: 'victim-user'` alive, and a first version of this test
    // passed against exactly that.
    const rc: Record<string, unknown>[] = [];
    const cfg2 = { journal: new InMemoryJournal(), agents: { a: { model,
      system: (c: Record<string, unknown>) => { rc.push(c); return 'sys'; } } } } as any;
    const runner2 = createStudioRunner(createGnl(cfg2), cfg2, { toJsonSchema: () => ({}) } as any);
    await runner2.run('a', { prompt: 'hi', runId: 'r-org-2',
      context: { __gnl_orgId: 'victim-org', org: 'victim-org', __gnl_resourceId: 'victim-user' } } as any,
      { orgId: 'acme-ltd' });
    expect(serverIdentityOf(rc[0]!), 'the request must not decide the organization').toMatchObject({ orgId: 'acme-ltd' });
    expect(rc[0]!['org'], "the client-readable alias must be the server's too").toBe('acme-ltd');
    expect(rc[0]!['__gnl_resourceId'], 'and a subject the caller named must be stripped, not kept').toBeUndefined();
    void seen;
  }, 60_000);

  it('no ctx organization leaves an existing context alone', async () => {
    // `sealRequestContext` strips the reserved keys unconditionally, so calling it with `undefined`
    // would DELETE an orgId a host had set for itself. The adapter returns the options untouched.
    const seen: unknown[] = [];
    const cfg = { journal: new InMemoryJournal(), agents: { a: { model,
      system: (rc: Record<string, unknown>) => { seen.push(serverIdentityOf(rc)); return 'sys'; } } } } as any;
    const gnl = createGnl(cfg);
    const runner = createStudioRunner(gnl, cfg, { toJsonSchema: () => ({}) } as any);
    await runner.run('a', { prompt: 'hi', runId: 'r-org-3',
      context: sealRequestContext({}, { orgId: 'host-set-org' }) } as any, { actor: 'ayse' });
    expect(seen[0], "a host's own sealed context must survive a ctx that carries no org")
      .toMatchObject({ orgId: 'host-set-org' });
  }, 60_000);

  it('stream carries it too — the mutation that proved this file covered only `run`', async () => {
    // Removing the bridge from `stream` and from `runWorkflow` broke NO test when these were written:
    // three call sites fixed, one covered. That is the same shape as the defect being fixed, so both
    // are pinned here.
    const seen: unknown[] = [];
    const cfg = { journal: new InMemoryJournal(), agents: { a: { model,
      system: (rc: Record<string, unknown>) => { seen.push(serverIdentityOf(rc)); return 'sys'; } } } } as any;
    const gnl = createGnl(cfg);
    const runner = createStudioRunner(gnl, cfg, { toJsonSchema: () => ({}) } as any);
    // The mock model has no doStream, so the call fails AFTER the context has been resolved — which is
    // the only thing under test here.
    await runner.stream?.('a', { prompt: 'hi', runId: 'r-stream-1' }, { orgId: 'acme-ltd' }).catch(() => {});
    expect(seen[0], 'stream must resolve the organization the same way run does').toMatchObject({ orgId: 'acme-ltd' });
  }, 60_000);

  it('runWorkflow carries it too', async () => {
    // Same property as the latent agent case, on the workflow door: `runWorkflow` derives its id from
    // `serverIdentityOf(opts.context)`, so without the bridge two organizations collapse into one run.
    const journal = new InMemoryJournal();
    const ran: string[] = [];
    // WorkflowLike is `{ build(), run(input, ctx) }` — the shape the engine calls, not a step list.
    const cfg = { journal, agents: {}, workflows: {
      w: { build: () => [{ id: 's1' }], run: async () => { ran.push('x'); return { ok: 1 }; } } } } as any;
    const gnl = createGnl(cfg);
    const runner = createStudioRunner(gnl, cfg, { toJsonSchema: () => ({}) } as any);
    const a: any = await runner.runWorkflow?.('w', {}, { workKey: 'batch-7', workScope: 'org' } as any, { orgId: 'acme-ltd' });
    const b: any = await runner.runWorkflow?.('w', {}, { workKey: 'batch-7', workScope: 'org' } as any, { orgId: 'globex-inc' });
    // The step COUNT is 2 either way — a workflow re-runs — so it proves nothing. What the bridge
    // changes is the DERIVED ID: without it both organizations fall back to the deployment sentinel
    // and collapse onto one run. Measured: a first assertion on `ran.length` passed with the bridge
    // mutated out.
    expect(a?.runId, 'a derived id is expected here').toMatch(/^run1_/);
    expect(b?.runId, "two organizations must not derive one another's run id").not.toBe(a?.runId);
    expect((await journal.listRuns()).length, 'and the journal must hold two').toBe(2);
    expect(ran.length).toBe(2);
  }, 60_000);

  it('THE LATENT ONE — two organizations under one workKey no longer share a run', async () => {
    // Not reachable through Studio today (no route forwards a workKey; the agent route requires a raw
    // runId), so this is the guard for the day one does. Measured before the fix: ONE run, the model
    // called ONCE, and the second organization served the first's answer.
    const journal = new InMemoryJournal();
    let n = 0;
    const counting = { ...model, doGenerate: async () => { n++; return { content: [{ type: 'text', text: `answer-${n}` }],
      finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] }; } } as any;
    const cfg = { journal, agents: { pay: { model: counting, workScope: 'org' } } } as any;
    const runner = createStudioRunner(createGnl(cfg), cfg, { toJsonSchema: () => ({}) } as any);
    const first: any = await runner.run('pay', { prompt: 'x', workKey: 'invoice-99' } as any, { orgId: 'acme-ltd' });
    const second: any = await runner.run('pay', { prompt: 'x', workKey: 'invoice-99' } as any, { orgId: 'globex-inc' });
    expect(n, 'two organizations are two units of work').toBe(2);
    expect(second.text, "the second organization must not be served the first's answer").not.toBe(first.text);
    expect((await journal.listRuns()).length, 'and they must be two runs').toBe(2);
  }, 60_000);
});
