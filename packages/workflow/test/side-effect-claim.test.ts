// FAZ-1 (dedup-hardening) — write-ahead claim for side-effect steps: the crash window between
// "effect fired" and "output journaled" is no longer invisible. What's tested:
// 1) the claim is written BEFORE the body runs; output journaled; replay cached; no double effect.
// 2) a step WITHOUT sideEffect never writes a claim key (byte-parity with today's path).
// 3) ctx.idempotencyKey is engine-injected and equals the step's journal key (both paths).
// 4) a THROWN attempt stamps the claim `failed` → the resume skips the TTL wait and, without
//    `recover`, refuses with StepRetryBlockedError('unresolved') instead of re-firing the effect.
// 5) recover {done:true} journals the recovered output and the body does NOT re-run.
// 6) recover {done:false} adopts the claim and the body runs for real.
// 7) a LIVE claim (fresh, no output) → StepRetryBlockedError('in-flight') — concurrent worker guard.
// 8) a STALE claim (process death: no failed stamp, age > ttl) without recover → 'unresolved'.
// 9) a malformed recover return is rejected loudly (shape discipline).
// 10) a clean suspend stamps `released` → the resume re-runs the step (suspend contract intact).
import { describe, it, expect } from 'vitest';
import {
  workflow,
  step,
  retry,
  suspendWorkflow,
  StepRetryBlockedError,
  type JournalLike,
  type StepCtx,
} from '../src/index.js';

/** CAS journal: putIfAbsent + putIfMatch (serialized equality — same contract as InMemoryJournal). */
function casJournal() {
  const m = new Map<string, unknown>();
  const j: JournalLike & { map: Map<string, unknown> } = {
    map: m,
    async get<T>(k: string) {
      return m.has(k) ? (structuredClone(m.get(k)) as T) : undefined;
    },
    async put(k: string, v: unknown) {
      m.set(k, structuredClone(v));
    },
    async putIfAbsent(k: string, v: unknown) {
      if (m.has(k)) return false;
      m.set(k, structuredClone(v));
      return true;
    },
    async putIfMatch(k: string, expected: unknown, v: unknown) {
      if (!m.has(k)) return false;
      if (JSON.stringify(m.get(k)) !== JSON.stringify(expected)) return false;
      m.set(k, structuredClone(v));
      return true;
    },
  };
  return j;
}

const ctxOf = (journal: JournalLike, runId: string): StepCtx => ({ runId, journal });

describe('FAZ-1 side-effect write-ahead claim', () => {
  it('claim is written BEFORE the body runs; output journaled; replay cached (no double effect)', async () => {
    const journal = casJournal();
    let fired = 0;
    let claimSeenInsideBody: unknown;
    const wf = workflow<number>().then(
      step(
        'charge',
        async (amount, ctx) => {
          claimSeenInsideBody = await ctx.journal.get(`${ctx.runId}:wf:charge:_claim`);
          fired++;
          return { charged: amount };
        },
        { sideEffect: true },
      ),
    );
    const out = await wf.run(10, ctxOf(journal, 'r1'));
    expect(out).toEqual({ charged: 10 });
    expect(claimSeenInsideBody).toMatchObject({ startedAt: expect.any(Number) }); // write-AHEAD: visible during the body
    expect(await journal.get('r1:wf:charge')).toEqual({ charged: 10 });

    const replay = await wf.run(10, ctxOf(journal, 'r1'));
    expect(replay).toEqual({ charged: 10 });
    expect(fired).toBe(1); // exactly-once
  });

  it('a step WITHOUT sideEffect never writes a claim key (byte-parity with the old path)', async () => {
    const journal = casJournal();
    const wf = workflow<number>().then(step('pure', async (n) => n + 1));
    await wf.run(1, ctxOf(journal, 'r2'));
    expect(journal.map.has('r2:wf:pure:_claim')).toBe(false);
    expect(await journal.get('r2:wf:pure')).toBe(2);
  });

  it('ctx.idempotencyKey is engine-injected and equals the step journal key (both paths)', async () => {
    const journal = casJournal();
    const seen: Record<string, string | undefined> = {};
    const wf = workflow<number>()
      .then(step('pure', async (n, ctx) => ((seen.pure = ctx.idempotencyKey), n)))
      .then(step('fx', async (n, ctx) => ((seen.fx = ctx.idempotencyKey), n), { sideEffect: true }));
    await wf.run(1, ctxOf(journal, 'r3'));
    expect(seen.pure).toBe('r3:wf:pure');
    expect(seen.fx).toBe('r3:wf:fx');
  });

  it("a thrown attempt stamps `failed` → resume without recover refuses ('unresolved'), effect NOT re-fired", async () => {
    const journal = casJournal();
    let fired = 0;
    let explode = true;
    const wf = workflow<number>().then(
      step(
        'charge',
        async (amount) => {
          fired++;
          if (explode) throw new Error('provider timeout AFTER the charge may have landed');
          return { charged: amount };
        },
        { sideEffect: true, claimTtlMs: 60_000 }, // ttl deliberately LONG: the failed stamp must bypass it
      ),
    );
    await expect(wf.run(10, ctxOf(journal, 'r4'))).rejects.toThrow('provider timeout');
    expect(await journal.get('r4:wf:charge:_claim')).toMatchObject({ failed: true });

    explode = false; // even though a retry would now succeed, the engine must not guess
    await expect(wf.run(10, ctxOf(journal, 'r4'))).rejects.toSatisfy(
      (e: unknown) => e instanceof StepRetryBlockedError && e.detail.state === 'unresolved',
    );
    expect(fired).toBe(1);
  });

  it('recover {done:true} journals the recovered output, the body does NOT re-run, idempotencyKey is passed', async () => {
    const journal = casJournal();
    let fired = 0;
    let recoverKey: string | undefined;
    const wf = workflow<number>().then(
      step(
        'charge',
        async (amount) => {
          fired++;
          throw new Error('crash after the effect');
        },
        {
          sideEffect: true,
          recover: async (_amount, { idempotencyKey }) => {
            recoverKey = idempotencyKey;
            return { done: true, output: { charged: 10, via: 'recover' } };
          },
        },
      ),
    );
    await expect(wf.run(10, ctxOf(journal, 'r5'))).rejects.toThrow('crash after the effect');
    const out = await wf.run(10, ctxOf(journal, 'r5'));
    expect(out).toEqual({ charged: 10, via: 'recover' });
    expect(recoverKey).toBe('r5:wf:charge');
    expect(fired).toBe(1); // the body never re-ran
    expect(await journal.get('r5:wf:charge')).toEqual({ charged: 10, via: 'recover' }); // journaled → replays forever
  });

  it('recover {done:false} adopts the claim and the body runs for real', async () => {
    const journal = casJournal();
    let fired = 0;
    let explode = true;
    const wf = workflow<number>().then(
      step(
        'charge',
        async (amount) => {
          fired++;
          if (explode) throw new Error('crash BEFORE the effect landed');
          return { charged: amount };
        },
        { sideEffect: true, recover: async () => ({ done: false }) },
      ),
    );
    await expect(wf.run(10, ctxOf(journal, 'r6'))).rejects.toThrow('crash BEFORE');
    explode = false;
    const out = await wf.run(10, ctxOf(journal, 'r6'));
    expect(out).toEqual({ charged: 10 });
    expect(fired).toBe(2); // re-run is CORRECT here: recover certified the effect never landed
  });

  it("a live claim with no output → StepRetryBlockedError('in-flight') — the concurrent-worker guard", async () => {
    const journal = casJournal();
    // Another worker wrote its claim moments ago and is still executing (no output record yet).
    await journal.put('r7:wf:charge:_claim', { startedAt: Date.now() });
    const wf = workflow<number>().then(
      step('charge', async (n) => ({ charged: n }), { sideEffect: true, claimTtlMs: 60_000 }),
    );
    await expect(wf.run(10, ctxOf(journal, 'r7'))).rejects.toSatisfy(
      (e: unknown) => e instanceof StepRetryBlockedError && e.detail.state === 'in-flight',
    );
  });

  it("a stale claim (process death — no stamp, age > ttl) without recover → 'unresolved'", async () => {
    const journal = casJournal();
    await journal.put('r8:wf:charge:_claim', { startedAt: Date.now() - 10_000 }); // the worker died mid-flight
    let fired = 0;
    const wf = workflow<number>().then(
      step('charge', async (n) => (fired++, { charged: n }), { sideEffect: true, claimTtlMs: 100 }),
    );
    await expect(wf.run(10, ctxOf(journal, 'r8'))).rejects.toSatisfy(
      (e: unknown) => e instanceof StepRetryBlockedError && e.detail.state === 'unresolved',
    );
    expect(fired).toBe(0); // the engine never guessed
  });

  it('a malformed recover return is rejected loudly (shape discipline)', async () => {
    const journal = casJournal();
    await journal.put('r9:wf:charge:_claim', { startedAt: Date.now() - 10_000 });
    const wf = workflow<number>().then(
      step('charge', async (n) => ({ charged: n }), {
        sideEffect: true,
        claimTtlMs: 100,
        recover: async () => ({ ok: true } as any), // neither {done:true,output} nor {done:false}
      }),
    );
    await expect(wf.run(10, ctxOf(journal, 'r9'))).rejects.toThrow(/recover\('charge'\) must return/);
  });

  it('a clean suspend stamps `released` → the resume re-runs the step (suspend contract intact)', async () => {
    const journal = casJournal();
    let fired = 0;
    const wf = workflow<number>().then(
      step(
        'notify',
        async (n, ctx) => {
          const approval = ctx.resumeData ? await ctx.resumeData('ok') : undefined;
          if (approval === undefined) suspendWorkflow('ok'); // suspends BEFORE the effect — the documented pattern
          fired++;
          return { notified: n, approval };
        },
        { sideEffect: true, claimTtlMs: 60_000 }, // ttl LONG: released stamp must bypass the in-flight guard
      ),
    );
    const first = await wf.runResumable(1, ctxOf(journal, 'r10'));
    expect(first.status).toBe('suspended');
    expect(await journal.get('r10:wf:notify:_claim')).toMatchObject({ released: true });

    const second = await wf.runResumable(1, ctxOf(journal, 'r10'), { resume: { ok: { by: 'op' } } });
    expect(second).toMatchObject({ status: 'completed', output: { notified: 1, approval: { by: 'op' } } });
    expect(fired).toBe(1);
  });
});

// Faz 1 heyet bulguları (bloker + Derya'nın kanıt boşlukları) — kombinatör taşıması, retry×sideEffect
// disiplini, gerçek eşzamanlılık, CAS'sız journal, journal.now() ve recover çıktı-yarışı pinlendi.
describe('FAZ-1 heyet düzeltmeleri', () => {
  it('parallel and branch legs KEEP durability — the claim is written inside combinators', async () => {
    const journal = casJournal();
    let fired = 0;
    const charge = step(
      'charge',
      async (_n: unknown, ctx: StepCtx) => {
        fired++;
        expect(await ctx.journal.get(`${ctx.idempotencyKey}:_claim`)).toBeDefined(); // write-AHEAD, inside the leg
        return { charged: true };
      },
      { sideEffect: true },
    );
    const wf = workflow<number>()
      .parallel([charge], 'par')
      .branch(() => true, charge, step('skip', async () => 'skipped'), 'br');
    await wf.run(5, ctxOf(journal, 'r11'));
    expect(journal.map.has('r11:wf:par/charge:_claim')).toBe(true);
    expect(journal.map.has('r11:wf:br/charge:_claim')).toBe(true);
    expect(fired).toBe(2);
  });

  it('retry+sideEffect WITHOUT recover: the first throw propagates — no blind in-process re-fire', async () => {
    const journal = casJournal();
    let fired = 0;
    const wf = workflow<number>().then(
      retry(
        step('charge', async () => { fired++; throw new Error('timeout — effect uncertain'); }, { sideEffect: true }),
        { attempts: 3 },
      ),
    );
    await expect(wf.run(1, ctxOf(journal, 'r12'))).rejects.toThrow('timeout');
    expect(fired).toBe(1); // attempts 2-3 never fired: no honest way to re-run a non-idempotent body blind
  });

  it('retry+sideEffect WITH recover: attempts consult recover — done:false re-fires, done:true returns the found output', async () => {
    const journal = casJournal();
    let fired = 0;
    const answers: any[] = [{ done: false }, { done: true, output: { charged: 'found-downstream' } }];
    const wf = workflow<number>().then(
      retry(
        step('charge', async () => { fired++; throw new Error('timeout'); }, {
          sideEffect: true,
          recover: async () => answers.shift(),
        }),
        { attempts: 5 },
      ),
    );
    const out = await wf.run(1, ctxOf(journal, 'r13'));
    expect(out).toEqual({ charged: 'found-downstream' });
    expect(fired).toBe(2); // attempt1 + ONE re-fire (after recover certified not-landed); done:true stopped the loop
    expect(await journal.get('r13:wf:charge')).toEqual({ charged: 'found-downstream' }); // journaled → replays
  });

  it('two CONCURRENT executions: the effect fires ONCE, the loser gets in-flight', async () => {
    const journal = casJournal();
    let fired = 0;
    const wf = workflow<number>().then(
      step(
        'charge',
        async (n) => { fired++; await new Promise((r) => setTimeout(r, 10)); return { charged: n }; },
        { sideEffect: true, claimTtlMs: 60_000 },
      ),
    );
    const results = await Promise.allSettled([wf.run(7, ctxOf(journal, 'r14')), wf.run(7, ctxOf(journal, 'r14'))]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(StepRetryBlockedError);
    expect((loser.reason as StepRetryBlockedError).detail.state).toBe('in-flight');
    expect(fired).toBe(1);
  });

  it('plain get/put journal (no CAS at all): claim→failed→recover(done:false)→re-run cycle still works', async () => {
    const m = new Map<string, unknown>();
    const journal: JournalLike = {
      async get<T>(k: string) { return m.has(k) ? (structuredClone(m.get(k)) as T) : undefined; },
      async put(k: string, v: unknown) { m.set(k, structuredClone(v)); },
    };
    let fired = 0;
    let explode = true;
    const wf = workflow<number>().then(
      step(
        'charge',
        async (n) => { fired++; if (explode) throw new Error('boom'); return { charged: n }; },
        { sideEffect: true, recover: async () => ({ done: false }) },
      ),
    );
    await expect(wf.run(3, ctxOf(journal, 'r15'))).rejects.toThrow('boom');
    expect(await journal.get('r15:wf:charge:_claim')).toMatchObject({ failed: true }); // fallback stamp path
    explode = false;
    expect(await wf.run(3, ctxOf(journal, 'r15'))).toEqual({ charged: 3 }); // fallback adopt path
    expect(fired).toBe(2);
  });

  it('staleness decides by journal.now(), not the wall clock', async () => {
    const journal = casJournal() as ReturnType<typeof casJournal> & { now(): Promise<number> };
    journal.now = async () => 1_050; // the storage clock — far "behind" Date.now()
    await journal.put('r16:wf:charge:_claim', { startedAt: 1_000 });
    const wf = workflow<number>().then(
      step('charge', async (n) => ({ charged: n }), { sideEffect: true, claimTtlMs: 100 }),
    );
    // Age by the STORAGE clock is 50ms < ttl 100 → in-flight. If the engine leaked Date.now() into
    // the decision, the age would be astronomic → stale → 'unresolved' (no recover here) instead.
    await expect(wf.run(1, ctxOf(journal, 'r16'))).rejects.toSatisfy(
      (e: unknown) => e instanceof StepRetryBlockedError && e.detail.state === 'in-flight',
    );
  });

  it('recover {done:true} losing the output race returns the WINNER record', async () => {
    const journal = casJournal();
    await journal.put('r17:wf:charge:_claim', { startedAt: Date.now() - 10_000 }); // stale → recover path
    const wf = workflow<number>().then(
      step('charge', async (n) => ({ charged: n }), {
        sideEffect: true,
        claimTtlMs: 100,
        recover: async () => {
          await journal.put('r17:wf:charge', { charged: 'winner' }); // a sibling resume landed first
          return { done: true, output: { charged: 'loser' } };
        },
      }),
    );
    expect(await wf.run(1, ctxOf(journal, 'r17'))).toEqual({ charged: 'winner' }); // single source of truth
  });
});
