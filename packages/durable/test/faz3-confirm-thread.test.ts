// FAZ-3 (dedup-hardening, katman 3) — what's tested:
// 1) `confirm` on the tool: the FIRST call suspends into the standard approvals flow (no guard
//    factory), approval executes exactly once, denial writes a terminal 'denied' record.
// 2) `idempotencyWindow: 'thread'`: same args dedupe ACROSS RUNS of one thread; a different thread
//    executes its own; a missing threadId falls back to the run window LOUDLY (console.warn).
// 3) thread-scoped duplicate marker (`sideEffectDuplicates: {action:'suspend', scope:'thread'}`):
//    the "created it yesterday, in another run of this chat" repeat suspends with firstToolCallId;
//    optional ttlMs expires the marker.
// 4) toolPolicy 'strict-critical': a side-effect tool without recover() OR idempotencyKey is refused
//    before the run starts; either one satisfies it.
// 5) purgeThread sweeps the thread's `xthr:` dedup state (records + markers die WITH the thread).
import { describe, it, expect, vi } from 'vitest';
import { stepCountIs } from 'ai';
import { InMemoryJournal, runKeys } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { purgeThread } from '../src/retention.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

const chargeModel = (callId = 'call-c', args: unknown = { amount: 50 }) => () =>
  createMockModel(async ({ prompt }: any) =>
    countToolResults(prompt) === 0 ? toolCallResult('charge', callId, args) : finalTextResult('done'),
  );

const baseOpts = (journal: InMemoryJournal, runId: string, extra: Record<string, unknown> = {}) => ({
  runId,
  journal,
  stopWhen: stepCountIs(6),
  prompt: 'x',
  ...extra,
});

describe('FAZ-3 confirm gate', () => {
  it('first call suspends, approval executes exactly once, output lands in the journal', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const tools = {
      charge: {
        sideEffect: true,
        confirm: { reason: (args: any) => `charge ${args.amount} — confirm?` },
        execute: async ({ amount }: any) => { counter.n++; return { charged: amount }; },
      },
    };
    const mk = chargeModel();
    await runDurable(baseOpts(journal, 'cf1', { model: mk(), tools }) as any);
    expect(counter.n).toBe(0); // suspended BEFORE the effect
    const rec = await journal.get<any>(runKeys.tool('cf1', 'call-c'));
    expect(rec.status).toBe('suspended');
    expect(rec.output.__gnl_suspend.reason).toBe('charge 50 — confirm?'); // args-derived reason

    await runDurable(baseOpts(journal, 'cf1', { model: mk(), tools, approvals: { 'call-c': true } }) as any);
    expect(counter.n).toBe(1); // approval executes exactly once
    expect((await journal.get<any>(runKeys.tool('cf1', 'call-c'))).status).toBe('succeeded');

    await runDurable(baseOpts(journal, 'cf1', { model: mk(), tools, approvals: { 'call-c': true } }) as any);
    expect(counter.n).toBe(1); // replay, not a re-execution
  });

  it('denial writes a terminal denied record — the effect never fires', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const tools = { charge: { sideEffect: true, confirm: true, execute: async () => { counter.n++; return { ok: 1 }; } } };
    const mk = chargeModel();
    await runDurable(baseOpts(journal, 'cf2', { model: mk(), tools }) as any); // suspends
    await runDurable(baseOpts(journal, 'cf2', { model: mk(), tools, approvals: { 'call-c': false } }) as any);
    expect(counter.n).toBe(0);
    expect((await journal.get<any>(runKeys.tool('cf2', 'call-c'))).status).toBe('denied');
  });

  it('a pre-supplied approval skips the gate on the very first call', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const tools = { charge: { sideEffect: true, confirm: true, execute: async () => { counter.n++; return { ok: 1 }; } } };
    await runDurable(baseOpts(journal, 'cf3', { model: chargeModel()(), tools, approvals: { 'call-c': true } }) as any);
    expect(counter.n).toBe(1);
  });
});

describe("FAZ-3 idempotencyWindow: 'thread'", () => {
  const mkTools = (counter: { n: number }) => ({
    createProduct: {
      sideEffect: true,
      idempotencyWindow: 'thread' as const,
      execute: async ({ sku }: any) => { counter.n++; return { created: sku }; },
    },
  });
  const model = (callId: string) => () =>
    createMockModel(async ({ prompt }: any) =>
      countToolResults(prompt) === 0 ? toolCallResult('createProduct', callId, { sku: 'ABC' }) : finalTextResult('done'),
    );

  it('same args dedupe ACROSS RUNS of one thread; another thread executes its own', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const tools = mkTools(counter);
    await runDurable(baseOpts(journal, 'r1', { model: model('call-1')(), tools, threadId: 'th-A' }) as any);
    expect(counter.n).toBe(1);
    // A DIFFERENT run, a DIFFERENT toolCallId, the SAME thread + args → journal replay, no re-fire.
    const second = await runDurable(baseOpts(journal, 'r2', { model: model('call-2')(), tools, threadId: 'th-A' }) as any);
    expect(counter.n).toBe(1);
    expect(JSON.stringify(second.steps)).toContain('"created":"ABC"'); // the replayed output reached run 2
    // Another conversation legitimately creates its own.
    await runDurable(baseOpts(journal, 'r3', { model: model('call-3')(), tools, threadId: 'th-B' }) as any);
    expect(counter.n).toBe(2);
    // The record lives under the thread key family (purgeThread's contract).
    expect((await journal.listKeys('xthr:th-A:')).length).toBeGreaterThan(0);
  });

  it('missing threadId → LOUD warn + run-window fallback (still executes, still exactly-once per run)', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const tools = mkTools(counter);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runDurable(baseOpts(journal, 'r4', { model: model('call-4')(), tools }) as any); // no threadId
      expect(counter.n).toBe(1);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('thread-scoped idempotencyWindow'))).toBe(true);
      expect(await journal.listKeys('xthr:')).toEqual([]); // nothing landed in the thread family
    } finally {
      warn.mockRestore();
    }
  });

  it('purgeThread sweeps the xthr family — the thread takes its dedup state with it', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const tools = mkTools(counter);
    await runDurable(baseOpts(journal, 'r5', { model: model('call-5')(), tools, threadId: 'th-C' }) as any);
    expect((await journal.listKeys('xthr:th-C:')).length).toBeGreaterThan(0);
    await purgeThread(journal, 'th-C');
    expect(await journal.listKeys('xthr:th-C:')).toEqual([]);
    // After the purge the same thread may create again — the window died with the thread.
    await runDurable(baseOpts(journal, 'r6', { model: model('call-6')(), tools, threadId: 'th-C' }) as any);
    expect(counter.n).toBe(2);
  });
});

describe('FAZ-3 thread-scoped duplicate marker', () => {
  const mkTools = (counter: { n: number }) => ({
    sendMail: { sideEffect: true, execute: async ({ to }: any) => { counter.n++; return { sent: to }; } },
  });
  const model = (callId: string) => () =>
    createMockModel(async ({ prompt }: any) =>
      countToolResults(prompt) === 0 ? toolCallResult('sendMail', callId, { to: 'a@b.c' }) : finalTextResult('done'),
    );
  const limits = { sideEffectDuplicates: { action: 'suspend' as const, scope: 'thread' as const } };

  it("the cross-run repeat in ONE thread suspends with firstToolCallId; another thread executes", async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const tools = mkTools(counter);
    await runDurable(baseOpts(journal, 'd1', { model: model('call-a')(), tools, threadId: 'th-X', limits }) as any);
    expect(counter.n).toBe(1);
    // NEW run, NEW toolCallId, same thread + args ('call' mode) — the per-run marker is blind here.
    await runDurable(baseOpts(journal, 'd2', { model: model('call-b')(), tools, threadId: 'th-X', limits }) as any);
    expect(counter.n).toBe(1); // suspended, not re-fired
    const rec = await journal.get<any>(runKeys.tool('d2', 'call-b'));
    expect(rec.status).toBe('suspended');
    expect(rec.output.__gnl_suspend.reason).toContain("thread 'th-X'");
    expect(rec.output.__gnl_suspend.reason).toContain('call-a'); // the FIRST result is addressable in the UI
    // An approval executes the ambiguous repeat exactly once.
    await runDurable(baseOpts(journal, 'd2', { model: model('call-b')(), tools, threadId: 'th-X', limits, approvals: { 'call-b': true } }) as any);
    expect(counter.n).toBe(2);
    // A different conversation is not a duplicate of anything.
    await runDurable(baseOpts(journal, 'd3', { model: model('call-c')(), tools, threadId: 'th-Y', limits }) as any);
    expect(counter.n).toBe(3);
  });

  it('optional ttlMs expires the marker — past it, the repeat is not a duplicate', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const tools = mkTools(counter);
    const ttlLimits = { sideEffectDuplicates: { action: 'block' as const, scope: 'thread' as const, ttlMs: 30 } };
    await runDurable(baseOpts(journal, 'd4', { model: model('call-a')(), tools, threadId: 'th-Z', limits: ttlLimits }) as any);
    expect(counter.n).toBe(1);
    await new Promise((r) => setTimeout(r, 50)); // the window passes
    await runDurable(baseOpts(journal, 'd5', { model: model('call-b')(), tools, threadId: 'th-Z', limits: ttlLimits }) as any);
    expect(counter.n).toBe(2); // expired marker — executes, no block
  });
});

describe("FAZ-3 toolPolicy 'strict-critical'", () => {
  const model = () =>
    createMockModel(async ({ prompt }: any) =>
      countToolResults(prompt) === 0 ? toolCallResult('charge', 'call-c', { amount: 1 }) : finalTextResult('done'),
    );

  it('a side-effect tool with NO crash-window answer is refused before the run starts', async () => {
    const tools = { charge: { sideEffect: true, execute: async () => ({ ok: 1 }) } };
    await expect(
      runDurable(baseOpts(new InMemoryJournal(), 'sc1', { model: model(), tools, toolPolicy: 'strict-critical' }) as any),
    ).rejects.toThrow(/strict-critical.*charge.*recover\(\)|charge.*crash-window/s);
  });

  it('recover() OR a deterministic idempotencyKey satisfies it', async () => {
    const withRecover = { charge: { sideEffect: true, recover: async () => ({ done: false as const }), execute: async () => ({ ok: 1 }) } };
    const withKey = { charge: { sideEffect: true, idempotencyKey: (a: any) => String(a.amount), execute: async () => ({ ok: 1 }) } };
    await expect(runDurable(baseOpts(new InMemoryJournal(), 'sc2', { model: model(), tools: withRecover, toolPolicy: 'strict-critical' }) as any)).resolves.toBeTruthy();
    await expect(runDurable(baseOpts(new InMemoryJournal(), 'sc3', { model: model(), tools: withKey, toolPolicy: 'strict-critical' }) as any)).resolves.toBeTruthy();
  });

  it("undeclared intent still fails (the 'strict' rung is included)", async () => {
    const tools = { mystery: { execute: async () => ({ ok: 1 }) } };
    await expect(
      runDurable(baseOpts(new InMemoryJournal(), 'sc4', { model: model(), tools, toolPolicy: 'strict-critical' }) as any),
    ).rejects.toThrow(/strict-critical.*do not declare/s);
  });
});

// FAZ-3 denetçi bulguları — confirm×crash-window zinciri, storage-saat yolu ve eşzamanlı ikiz pinlendi.
describe('FAZ-3 denetçi düzeltmeleri', () => {
  it('a crashed CONFIRMED attempt is NOT re-suspended over — the reclaim ladder owns it (bloker)', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    let explode = true;
    const tools = {
      charge: {
        sideEffect: true,
        confirm: true,
        execute: async () => { counter.n++; if (explode) throw new Error('provider timeout — effect uncertain'); return { ok: 1 }; },
      },
    };
    const mk = chargeModel();
    // approvalScope 'attempt': the approval is SPENT before the effect — the denetçi's exact
    // scenario (a standing journaled approval would legitimately allow the ladder's retry instead).
    const limits = { approvalScope: 'attempt' as const };
    await runDurable(baseOpts(journal, 'cf4', { model: mk(), tools, limits }) as any); // confirm suspends
    await runDurable(baseOpts(journal, 'cf4', { model: mk(), tools, limits, approvals: { 'call-c': true } }) as any).catch(() => {});
    expect(counter.n).toBe(1);
    const afterCrash = await journal.get<any>(runKeys.tool('cf4', 'call-c'));
    expect(afterCrash.status).toBe('failed'); // the crash window is RECORDED

    explode = false;
    // Resume WITHOUT a live approval (spent): the old confirm arm overwrote 'failed' with a fresh
    // 'suspended' ("confirm before it RUNS" — hiding that it may HAVE run) and bypassed the ladder.
    await runDurable(baseOpts(journal, 'cf4', { model: mk(), tools, limits }) as any).catch(() => {});
    const rec = await journal.get<any>(runKeys.tool('cf4', 'call-c'));
    expect(rec.status).toBe('failed'); // NOT re-suspended over — the ladder (recover/approval) owns this state
    expect(counter.n).toBe(1); // and nothing re-fired
  });

  it('windowExpired decides by the STORAGE clock — both stamp and decision (K2 both ends)', async () => {
    const base = new InMemoryJournal();
    const clock = { t: 1_000_000 }; // storage clock, far from Date.now()
    const journal: any = new Proxy(base, {
      get: (t, p) => (p === 'now' ? async () => clock.t : (t as any)[p] instanceof Function ? (t as any)[p].bind(t) : (t as any)[p]),
    });
    const counter = { n: 0 };
    const tools = { sendMail: { sideEffect: true, execute: async () => { counter.n++; return { ok: 1 }; } } };
    const model = (callId: string) => () =>
      createMockModel(async ({ prompt }: any) =>
        countToolResults(prompt) === 0 ? toolCallResult('sendMail', callId, { to: 'x' }) : finalTextResult('done'));
    const limits = { sideEffectDuplicates: { action: 'block' as const, scope: 'thread' as const, ttlMs: 100 } };

    await runDurable(baseOpts(journal, 'w1', { model: model('call-a')(), tools, threadId: 'th-K2', limits }) as any);
    expect(counter.n).toBe(1); // marker stamped at storage-clock 1_000_000
    clock.t += 50; // inside the window by the STORAGE clock (wall clock has moved arbitrarily)
    // Run() THROWS on a block (stream() masks it as a sentinel instead) — the rejection IS the assert.
    await expect(
      runDurable(baseOpts(journal, 'w2', { model: model('call-b')(), tools, threadId: 'th-K2', limits }) as any),
    ).rejects.toThrow(/duplicate blocked/);
    expect(counter.n).toBe(1); // still a duplicate
    clock.t += 200; // past the window by the STORAGE clock
    await runDurable(baseOpts(journal, 'w3', { model: model('call-c')(), tools, threadId: 'th-K2', limits }) as any);
    expect(counter.n).toBe(2); // expired → executes (Date.now() played no part in either decision)
  });

  it('CONCURRENT twins on one thread: the effect fires once, ttlMs never expires an IN-FLIGHT marker', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const tools = {
      sendMail: {
        sideEffect: true,
        execute: async () => { counter.n++; await new Promise((r) => setTimeout(r, 30)); return { ok: 1 }; },
      },
    };
    const model = (callId: string) => () =>
      createMockModel(async ({ prompt }: any) =>
        countToolResults(prompt) === 0 ? toolCallResult('sendMail', callId, { to: 'x' }) : finalTextResult('done'));
    // ttlMs 1: if windowExpired ever applied to an in-flight marker, the twin would take it over mid-run.
    const limits = { sideEffectDuplicates: { action: 'suspend' as const, scope: 'thread' as const, ttlMs: 1 } };
    const [a, b] = await Promise.allSettled([
      runDurable(baseOpts(journal, 'tw1', { model: model('call-a')(), tools, threadId: 'th-TW', limits }) as any),
      runDurable(baseOpts(journal, 'tw2', { model: model('call-b')(), tools, threadId: 'th-TW', limits }) as any),
    ]);
    expect(counter.n).toBe(1); // exactly one execution across the two concurrent runs
    expect([a.status, b.status].filter((s) => s === 'fulfilled').length).toBeGreaterThanOrEqual(1);
  });
});
