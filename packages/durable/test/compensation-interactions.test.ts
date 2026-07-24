// GOREV (saga × everything — interaction suite): the highest-yield test class in this codebase (the
// resumeRun-limits, two-phase-deny and cold-start bugs all came from INTERSECTIONS). Writing this
// file drove three hardenings, each tested here:
//  - MID-FLIGHT condemnation: runDurable's entry check only covers runs that START after the
//    condemnation — a live worker used to keep producing NEW side effects while the operator unwound
//    the run → durable-tool now refuses side effects in a condemned run (CompensatedRunError).
//  - FORK refusal: a fork of a condemned run silently DROPPED the tombstone (proc keys are invisible
//    to readRun) and would replay memoized successes of reverted effects → forkRun now refuses.
//  - dryRun HONESTY: on a partially-unwound run, dryRun used to report 'would-compensate' for work
//    that had ALREADY happened → the terminal check now precedes the dryRun branch.
// Plus the scope bounds as tests: args-mode dedup ⇒ ONE compensation (the mirror of the call-mode
// double-charge pair), cross-run-window records are deliberately OUT of a single run's unwind, the
// approvals flow composes (approved→executed→compensable; denied→absent), and the streaming `parts`
// shape args-recovery branch is exercised.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable, resumeRun } from '../src/run.js';
import { forkRun } from '../src/time-travel.js';
import { compensateRun, CompensatedRunError } from '../src/compensation.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

afterEach(() => vi.restoreAllMocks());

type CompCall = { tool: string; args: unknown; output: unknown; idempotencyKey: string };

describe('saga × live worker / fork / dryRun (the three hardenings)', () => {
  it('MID-FLIGHT condemnation: a live run refuses NEW side effects the moment the operator condemns it', async () => {
    const journal = new InMemoryJournal();
    let sends = 0;
    // step1's EXECUTE condemns the run (simulating an operator racing a live worker at the worst
    // possible moment) — the in-flight tool may finish, but the NEXT side effect must be refused.
    const step1 = tool({
      description: 'step1', inputSchema: z.object({}),
      execute: async () => {
        await compensateRun('mid-1', { journal, tools: {} });
        return { ok: true };
      },
    });
    const step2 = tool({
      description: 'step2 (side effect that must NEVER run)', inputSchema: z.object({}),
      execute: async () => ({ oops: ++sends }),
    });
    const model = createMockModel(async ({ prompt }: any) => {
      const done = countToolResults(prompt);
      if (done === 0) return toolCallResult('step1', 'call-1', {});
      if (done === 1) return toolCallResult('step2', 'call-2', {});
      return finalTextResult('Done.');
    });
    await expect(
      runDurable({ runId: 'mid-1', journal, model, tools: { step1, step2 }, prompt: 'x', stopWhen: stepCountIs(10) }),
    ).rejects.toBeInstanceOf(CompensatedRunError);
    expect(sends).toBe(0); // the condemned run produced no further effects
    expect(await journal.get('mid-1:tool:call-2')).toBeUndefined(); // refusal writes nothing (sentinel path)
  });

  it('FORK refusal: a condemned run cannot be forked (the copy would drop the tombstone and replay reverted effects)', async () => {
    const journal = new InMemoryJournal();
    const charge = tool({ description: 'c', inputSchema: z.object({}), execute: async () => ({ ok: 1 }) });
    (charge as any).compensate = async () => ({});
    const model = createMockModel(async ({ prompt }: any) =>
      countToolResults(prompt) === 0 ? toolCallResult('charge', 'call-1', {}) : finalTextResult('Done.'));
    await runDurable({ runId: 'fk-1', journal, model, tools: { charge }, prompt: 'x', stopWhen: stepCountIs(6) });

    expect(await forkRun(journal, 'fk-1', 1, 'fk-1-pre')).toBeTruthy(); // forking BEFORE is fine
    await compensateRun('fk-1', { journal, tools: { charge } });
    await expect(forkRun(journal, 'fk-1', 1, 'fk-1-post')).rejects.toBeInstanceOf(CompensatedRunError);
  });

  it('dryRun HONESTY on a partially-unwound run: already-done work reads already-compensated, never would-compensate', async () => {
    const journal = new InMemoryJournal();
    const failReserve = { on: true };
    const mk = (name: string) => {
      const t = tool({ description: name, inputSchema: z.object({ id: z.string() }), execute: async ({ id }) => ({ [`${name}Id`]: id }) });
      (t as any).compensate = async () => {
        if (name === 'reserve' && failReserve.on) throw new Error('down');
        return {};
      };
      return t;
    };
    const tools = { charge: mk('charge'), reserve: mk('reserve'), notify: mk('notify') };
    const model = createMockModel(async ({ prompt }: any) => {
      const done = countToolResults(prompt);
      if (done === 0) return toolCallResult('charge', 'call-1', { id: 'A' });
      if (done === 1) return toolCallResult('reserve', 'call-2', { id: 'A' });
      if (done === 2) return toolCallResult('notify', 'call-3', { id: 'A' });
      return finalTextResult('Done.');
    });
    await runDurable({ runId: 'dr-1', journal, model, tools, prompt: 'x', stopWhen: stepCountIs(10) });
    await compensateRun('dr-1', { journal, tools }); // notify ✓, reserve ✗, charge not-attempted

    const preview = await compensateRun('dr-1', { journal, tools, dryRun: true });
    expect(preview.entries.map((e) => [e.toolName, e.status])).toEqual([
      ['notify', 'already-compensated'], // the truth — this used to lie as 'would-compensate'
      ['reserve', 'would-compensate'], // comp-failed → a re-run WOULD retry it
      ['charge', 'would-compensate'],
    ]);
  });
});

describe('saga × idempotency modes (scope bounds as tests)', () => {
  it("args-mode dedup ⇒ ONE execution ⇒ ONE compensation — the mirror of the call-mode double-charge pair", async () => {
    const journal = new InMemoryJournal();
    const compCalls: CompCall[] = [];
    let executions = 0;
    const charge = tool({ description: 'charge', inputSchema: z.object({ id: z.string() }), execute: async () => ({ chargeId: `c-${++executions}` }) });
    (charge as any).idempotency = 'args';
    (charge as any).compensate = async (args: unknown, output: unknown, ctx: { idempotencyKey: string }) =>
      void compCalls.push({ tool: 'charge', args, output, idempotencyKey: ctx.idempotencyKey });
    const model = createMockModel(async ({ prompt }: any) => {
      const done = countToolResults(prompt);
      if (done < 3) return toolCallResult('charge', `call-${done + 1}`, { id: 'A' }); // 3 model-side calls…
      return finalTextResult('Done.');
    });
    await runDurable({ runId: 'am-1', journal, model, tools: { charge }, prompt: 'x', stopWhen: stepCountIs(10) });
    expect(executions).toBe(1); // …ONE real execution (args dedup)

    const report = await compensateRun('am-1', { journal, tools: { charge } });
    const comped = report.entries.filter((e) => e.status === 'compensated');
    expect(comped).toHaveLength(1); // one execution → one refund. Call mode's 2-executions → 2 refunds is the pair.
    expect(compCalls).toHaveLength(1);
    expect(compCalls[0]).toMatchObject({ args: { id: 'A' } }); // args-mode records store input too
  });

  it("cross-run-window records are OUT of a single run's unwind (deliberate: other runs may depend on the shared action)", async () => {
    const journal = new InMemoryJournal();
    let executions = 0;
    const welcome = tool({ description: 'welcome email — once EVER', inputSchema: z.object({ user: z.string() }), execute: async () => ({ sent: ++executions }) });
    (welcome as any).idempotencyWindow = 'cross-run';
    (welcome as any).compensate = async () => { throw new Error('MUST NEVER BE CALLED from a single-run unwind'); };
    const model = createMockModel(async ({ prompt }: any) =>
      countToolResults(prompt) === 0 ? toolCallResult('welcome', 'call-1', { user: 'u1' }) : finalTextResult('Done.'));
    await runDurable({ runId: 'xr-1', journal, model, tools: { welcome }, prompt: 'x', stopWhen: stepCountIs(6) });
    expect(executions).toBe(1);

    const report = await compensateRun('xr-1', { journal, tools: { welcome } });
    expect(report.entries).toHaveLength(0); // the xrun record lives outside the run's key space — untouched
    expect(report.condemned).toBe(true); // the RUN is still condemned; the SHARED action stands
  });

  it("uncertain args-mode record: recover is probed with the CORRECTLY reconstructed downstream key (tool name with dashes)", async () => {
    const journal = new InMemoryJournal();
    // Hand-craft an args-mode crash shape: key = args-<tool>-<hash>, no toolName/input on the record.
    const hash = 'abcdef0123456789';
    await journal.put(`ua-1:tool:args-my-charge-tool-${hash}`, { status: 'failed', error: 'timeout', attempts: 1 });
    const seenKeys: string[] = [];
    const t = tool({ description: 'c', inputSchema: z.object({}), execute: async () => ({}) });
    (t as any).recover = async (_args: unknown, opts: { idempotencyKey: string }) => {
      seenKeys.push(opts.idempotencyKey);
      return { done: false };
    };
    (t as any).compensate = async () => ({});

    const report = await compensateRun('ua-1', { journal, tools: { 'my-charge-tool': t } });
    expect(report.entries[0]).toMatchObject({ toolName: 'my-charge-tool', status: 'skipped-not-executed' });
    // The greedy parse survived the dashes: the probe used the EXACT key the original execution carried.
    expect(seenKeys).toEqual([`ua-1:my-charge-tool:${hash}`]);
  });
});

describe('saga × approvals flow', () => {
  it('approved-then-executed calls are compensable; denied calls are absent; a condemned suspended run refuses approvals-resume', async () => {
    const journal = new InMemoryJournal();
    const compCalls: CompCall[] = [];
    const mkTool = (name: string) => {
      const t = tool({ description: name, inputSchema: z.object({}), execute: async () => ({ [`${name}Done`]: true }) });
      (t as any).compensate = async (args: unknown, output: unknown, ctx: { idempotencyKey: string }) =>
        void compCalls.push({ tool: name, args, output, idempotencyKey: ctx.idempotencyKey });
      return t;
    };
    const tools = { charge: mkTool('charge'), audit: mkTool('audit') };
    const guard = () => ({ action: 'require-approval' as const, reason: 'human gate' });
    const model = () => createMockModel(async ({ prompt }: any) => {
      const done = countToolResults(prompt);
      if (done === 0) return toolCallResult('charge', 'call-1', {});
      if (done === 1) return toolCallResult('audit', 'call-2', {});
      return finalTextResult('Done.');
    });

    // charge approved up-front → executes; audit denied up-front → 'denied' record, never executed.
    await runDurable({
      runId: 'ap-1', journal, model: model(), tools, guard,
      approvals: { 'call-1': true, 'call-2': false },
      prompt: 'x', stopWhen: stepCountIs(10),
    });

    const report = await compensateRun('ap-1', { journal, tools });
    expect(report.entries).toHaveLength(1); // ONLY the approved+executed charge — the denied audit never happened
    expect(report.entries[0]).toMatchObject({ toolName: 'charge', status: 'compensated' });
    expect(compCalls.map((c) => c.tool)).toEqual(['charge']);

    // And a SUSPENDED-elsewhere run that gets condemned refuses even an approvals-resume.
    const j2 = new InMemoryJournal();
    await runDurable({ runId: 'ap-2', journal: j2, model: model(), tools, guard, prompt: 'x', stopWhen: stepCountIs(10) }); // suspends at call-1
    await compensateRun('ap-2', { journal: j2, tools });
    await expect(
      resumeRun('ap-2', { journal: j2, model: model(), tools, guard, approvals: { 'call-1': true } }),
    ).rejects.toBeInstanceOf(CompensatedRunError);
  });
});

describe('saga × streaming journal shape', () => {
  it("args recovery reads the STREAM `parts` shape too (a streamed run's legacy record without stored input)", async () => {
    const journal = new InMemoryJournal();
    // Streaming model steps journal as { parts: [...] } (see stream-fidelity) — craft that shape.
    await journal.put('sp-1:model:0', {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'tool-call', toolCallId: 'call-1', toolName: 'charge', input: JSON.stringify({ id: 'STREAMED' }) },
        { type: 'finish', finishReason: 'tool-calls' },
      ],
    });
    await journal.put('sp-1:tool:call-1', { status: 'succeeded', output: { chargeId: 'c1' }, toolName: 'charge', resolvedToolCallIds: ['call-1'] });
    const compCalls: CompCall[] = [];
    const charge = tool({ description: 'c', inputSchema: z.object({ id: z.string() }), execute: async () => ({}) });
    (charge as any).compensate = async (args: unknown, output: unknown, ctx: { idempotencyKey: string }) =>
      void compCalls.push({ tool: 'charge', args, output, idempotencyKey: ctx.idempotencyKey });

    const report = await compensateRun('sp-1', { journal, tools: { charge } });
    expect(report.entries[0].status).toBe('compensated');
    expect(compCalls[0]).toMatchObject({ args: { id: 'STREAMED' }, output: { chargeId: 'c1' } });
  });
});
