// GOREV (saga/compensation — CAUSALITY suite): exactly-once prevented duplicates; compensateRun
// undoes what DID happen. Deep checks: reverse order with the ORIGINAL args+output delivered to the
// hook; the compensations' OWN exactly-once (re-run, crash-retry); condemn-then-refuse (resume after
// unwind is impossible, dryRun condemns nothing); uncertainty resolved by recover, never guessed;
// args recovered from model steps for records that never stored input; and the double-charge unwind
// story (duplicate executions each get their own compensation).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable, streamDurable } from '../src/run.js';
import { compensateRun, CompensatedRunError } from '../src/compensation.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

afterEach(() => vi.restoreAllMocks());

type CompCall = { tool: string; args: unknown; output: unknown; idempotencyKey: string };

/** Three-step order flow — every step compensable, every compensation recorded with its inputs. */
function makeOrderTools(compCalls: CompCall[], opts: { failReserveComp?: { on: boolean } } = {}) {
  const mk = (name: string) => {
    const t = tool({
      description: name,
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => ({ [`${name}Id`]: `${name}-${id}` }),
    });
    (t as any).compensate = async (args: unknown, output: unknown, ctx: { idempotencyKey: string }) => {
      if (name === 'reserve' && opts.failReserveComp?.on) throw new Error('release failed: warehouse API down');
      compCalls.push({ tool: name, args, output, idempotencyKey: ctx.idempotencyKey });
      return { undone: name };
    };
    return t;
  };
  return { charge: mk('charge'), reserve: mk('reserve'), notify: mk('notify') };
}

const orderModel = () =>
  createMockModel(async ({ prompt }: any) => {
    const done = countToolResults(prompt);
    if (done === 0) return toolCallResult('charge', 'call-1', { id: 'A' });
    if (done === 1) return toolCallResult('reserve', 'call-2', { id: 'A' });
    if (done === 2) return toolCallResult('notify', 'call-3', { id: 'A' });
    return finalTextResult('Order placed.');
  });

describe('compensateRun — saga unwind', () => {
  it('REVERSE order with the ORIGINAL args+output delivered; per-entry idempotency keys; tombstone condemns the run', async () => {
    const journal = new InMemoryJournal();
    const compCalls: CompCall[] = [];
    const tools = makeOrderTools(compCalls);
    await runDurable({ runId: 'saga-1', journal, model: orderModel(), tools, prompt: 'order', stopWhen: stepCountIs(10) });

    const report = await compensateRun('saga-1', { journal, tools });
    expect(report.condemned).toBe(true);
    expect(report.entries.map((e) => [e.toolName, e.status])).toEqual([
      ['notify', 'compensated'], ['reserve', 'compensated'], ['charge', 'compensated'], // strictly reverse
    ]);
    // The hook got exactly what the ORIGINAL execution saw — args AND output (refunds need chargeId).
    expect(compCalls.map((c) => c.tool)).toEqual(['notify', 'reserve', 'charge']);
    expect(compCalls[2]).toMatchObject({ args: { id: 'A' }, output: { chargeId: 'charge-A' } });
    expect(compCalls[2].idempotencyKey).toBe('saga-1:comp:call-1'); // stable downstream dedup key
  });

  it("the compensations' OWN exactly-once: a re-run reports 'already-compensated' and calls NO hook again", async () => {
    const journal = new InMemoryJournal();
    const compCalls: CompCall[] = [];
    const tools = makeOrderTools(compCalls);
    await runDurable({ runId: 'saga-2', journal, model: orderModel(), tools, prompt: 'order', stopWhen: stepCountIs(10) });

    await compensateRun('saga-2', { journal, tools });
    expect(compCalls).toHaveLength(3);
    const again = await compensateRun('saga-2', { journal, tools });
    expect(again.entries.every((e) => e.status === 'already-compensated')).toBe(true);
    expect(compCalls).toHaveLength(3); // a refund can never run twice
  });

  it('STOP on failure (later-step comps may be depended on) → the re-run retries the failure and finishes the rest', async () => {
    const journal = new InMemoryJournal();
    const compCalls: CompCall[] = [];
    const failReserveComp = { on: true };
    const tools = makeOrderTools(compCalls, { failReserveComp });
    await runDurable({ runId: 'saga-3', journal, model: orderModel(), tools, prompt: 'order', stopWhen: stepCountIs(10) });

    const r1 = await compensateRun('saga-3', { journal, tools });
    expect(r1.entries.map((e) => [e.toolName, e.status])).toEqual([
      ['notify', 'compensated'],
      ['reserve', 'failed'], // the hook threw…
      ['charge', 'not-attempted'], // …and the EARLIER step was deliberately not touched
    ]);
    expect(r1.entries[1].error).toContain('warehouse API down');

    failReserveComp.on = false; // the world/hook is fixed
    const r2 = await compensateRun('saga-3', { journal, tools });
    expect(r2.entries.map((e) => [e.toolName, e.status])).toEqual([
      ['notify', 'already-compensated'],
      ['reserve', 'compensated'], // retried
      ['charge', 'compensated'], // and the unwind completed
    ]);
    expect(compCalls.map((c) => c.tool)).toEqual(['notify', 'reserve', 'charge']); // each exactly once overall
  });

  it('condemn-then-refuse: a compensated run can NEVER run/resume again (runDurable AND streamDurable)', async () => {
    const journal = new InMemoryJournal();
    const tools = makeOrderTools([]);
    await runDurable({ runId: 'saga-4', journal, model: orderModel(), tools, prompt: 'order', stopWhen: stepCountIs(10) });
    await compensateRun('saga-4', { journal, tools });

    await expect(
      runDurable({ runId: 'saga-4', journal, model: orderModel(), tools, prompt: 'order', stopWhen: stepCountIs(10) }),
    ).rejects.toBeInstanceOf(CompensatedRunError);
    await expect(
      streamDurable({ runId: 'saga-4', journal, model: orderModel(), tools, prompt: 'order', stopWhen: stepCountIs(10) }),
    ).rejects.toBeInstanceOf(CompensatedRunError);
  });

  it('dryRun: previews the unwind, executes NOTHING, condemns NOTHING — the run stays resumable', async () => {
    const journal = new InMemoryJournal();
    const compCalls: CompCall[] = [];
    const tools = makeOrderTools(compCalls);
    await runDurable({ runId: 'saga-5', journal, model: orderModel(), tools, prompt: 'order', stopWhen: stepCountIs(10) });

    const preview = await compensateRun('saga-5', { journal, tools, dryRun: true });
    expect(preview.condemned).toBe(false);
    expect(preview.entries.every((e) => e.status === 'would-compensate')).toBe(true);
    expect(compCalls).toHaveLength(0); // nothing ran
    // Still resumable — dryRun left no tombstone (replays to the same completed result).
    const res = await runDurable({ runId: 'saga-5', journal, model: orderModel(), tools, prompt: 'order', stopWhen: stepCountIs(10) });
    expect(res.text).toContain('Order placed');
  });

  it('honest reporting: a hook-less executed tool is skipped-no-hook; never-executed records (suspended) do not even appear', async () => {
    const journal = new InMemoryJournal();
    let charges = 0;
    const charge = tool({
      description: 'charge (NO compensate hook)',
      inputSchema: z.object({ id: z.string() }),
      execute: async () => ({ ok: ++charges }),
    });
    const guard = ({ toolName }: any) => (toolName === 'audit'
      ? { action: 'require-approval' as const, reason: 'needs human' } : { action: 'allow' as const });
    const audit = tool({ description: 'audit', inputSchema: z.object({}), execute: async () => ({ ok: true }) });
    const model = createMockModel(async ({ prompt }: any) => {
      const done = countToolResults(prompt);
      if (done === 0) return toolCallResult('charge', 'call-1', { id: 'A' });
      if (done === 1) return toolCallResult('audit', 'call-2', {}); // will suspend
      return finalTextResult('Done.');
    });
    await runDurable({ runId: 'saga-6', journal, model, tools: { charge, audit }, guard, prompt: 'x', stopWhen: stepCountIs(10) });

    const report = await compensateRun('saga-6', { journal, tools: { charge, audit } });
    expect(report.entries).toHaveLength(1); // ONLY the executed charge — the suspended audit never happened
    expect(report.entries[0]).toMatchObject({ toolName: 'charge', status: 'skipped-no-hook' });
  });

  it('uncertainty is surfaced, not guessed: no recover → uncertain; recover(done:false) → skipped; recover(done:true) → compensated with the PROVIDER output', async () => {
    const seed = async (journal: InMemoryJournal, runId: string) => {
      // Craft the crash shape by hand: a model step ISSUED the call (args live in the step) but the
      // tool record is stuck at 'failed' — did the provider execute it? The journal cannot know.
      await journal.put(`${runId}:model:0`, {
        content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'charge', input: JSON.stringify({ id: 'A' }) }],
      });
      await journal.put(`${runId}:tool:call-1`, { status: 'failed', error: 'timeout', attempts: 1 });
    };
    const compCalls: CompCall[] = [];
    const mkCharge = (recover?: (args: any) => Promise<any>) => {
      const t = tool({ description: 'charge', inputSchema: z.object({ id: z.string() }), execute: async () => ({ ok: 1 }) });
      (t as any).compensate = async (args: unknown, output: unknown, ctx: { idempotencyKey: string }) =>
        void compCalls.push({ tool: 'charge', args, output, idempotencyKey: ctx.idempotencyKey });
      if (recover) (t as any).recover = recover;
      return t;
    };

    // (a) no recover → 'uncertain', hook NOT called (nothing is compensated on a guess).
    const j1 = new InMemoryJournal();
    await seed(j1, 'u-1');
    const r1 = await compensateRun('u-1', { journal: j1, tools: { charge: mkCharge() } });
    expect(r1.entries[0].status).toBe('uncertain');

    // (b) recover says it NEVER happened → skipped-not-executed.
    const j2 = new InMemoryJournal();
    await seed(j2, 'u-2');
    const r2 = await compensateRun('u-2', { journal: j2, tools: { charge: mkCharge(async () => ({ done: false })) } });
    expect(r2.entries[0].status).toBe('skipped-not-executed');

    // (c) recover finds it DID happen → compensated using the PROVIDER's output; recover received the
    // args recovered from the MODEL STEP (the failed record never stored them).
    const j3 = new InMemoryJournal();
    await seed(j3, 'u-3');
    const seenRecoverArgs: unknown[] = [];
    const r3 = await compensateRun('u-3', {
      journal: j3,
      tools: { charge: mkCharge(async (args) => { seenRecoverArgs.push(args); return { done: true, output: { chargeId: 'FOUND-AT-PROVIDER' } }; }) },
    });
    expect(r3.entries[0].status).toBe('compensated');
    expect(seenRecoverArgs).toEqual([{ id: 'A' }]);
    expect(compCalls).toHaveLength(1);
    expect(compCalls[0].output).toEqual({ chargeId: 'FOUND-AT-PROVIDER' }); // the provider truth, not a guess
  });

  it('old-style succeeded record WITHOUT stored input: the hook still receives args (recovered from the model step)', async () => {
    const journal = new InMemoryJournal();
    await journal.put('old-1:model:0', {
      content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'charge', input: JSON.stringify({ id: 'LEGACY' }) }],
    });
    await journal.put('old-1:tool:call-1', { status: 'succeeded', output: { chargeId: 'c9' }, toolName: 'charge', resolvedToolCallIds: ['call-1'] });
    const compCalls: CompCall[] = [];
    const charge = tool({ description: 'charge', inputSchema: z.object({ id: z.string() }), execute: async () => ({}) });
    (charge as any).compensate = async (args: unknown, output: unknown, ctx: { idempotencyKey: string }) =>
      void compCalls.push({ tool: 'charge', args, output, idempotencyKey: ctx.idempotencyKey });

    const report = await compensateRun('old-1', { journal, tools: { charge } });
    expect(report.entries[0].status).toBe('compensated');
    expect(compCalls[0]).toMatchObject({ args: { id: 'LEGACY' }, output: { chargeId: 'c9' } });
  });

  it('the double-charge unwind story: duplicate executions (call mode, warn default) each get their OWN compensation', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const journal = new InMemoryJournal();
    const compCalls: CompCall[] = [];
    const charge = tool({ description: 'charge', inputSchema: z.object({ id: z.string() }), execute: async ({ id }) => ({ chargeId: `c-${id}` }) });
    (charge as any).compensate = async (args: unknown, output: unknown, ctx: { idempotencyKey: string }) =>
      void compCalls.push({ tool: 'charge', args, output, idempotencyKey: ctx.idempotencyKey });
    const model = createMockModel(async ({ prompt }: any) => {
      const done = countToolResults(prompt);
      if (done < 2) return toolCallResult('charge', `call-${done + 1}`, { id: 'A' }); // the accidental double charge
      return finalTextResult('Done.');
    });
    await runDurable({ runId: 'dup-1', journal, model, tools: { charge }, prompt: 'x', stopWhen: stepCountIs(10) });

    const report = await compensateRun('dup-1', { journal, tools: { charge } });
    expect(report.entries.filter((e) => e.status === 'compensated')).toHaveLength(2); // BOTH executions refunded
    expect(compCalls).toHaveLength(2);
    expect(new Set(compCalls.map((c) => c.idempotencyKey)).size).toBe(2); // distinct downstream keys per refund
  });
});
