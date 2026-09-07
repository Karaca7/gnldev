// PHASE-7 (backlog closure) — pinned invariants:
// 1) stream lock HEARTBEAT: a live stream that outlasts its ttl cannot have its lock taken over (a
//    previously documented gap is now closed); once the stream finishes, the lock is released again.
// 2) `lookup` (read-before-write): exists:true → the body NEVER runs, the found output is journaled and
//    replayed; exists:false → runs normally; throw → loud warn + fail-open; a non-fresh record never
//    reaches lookup at all (the crash window belongs to recover).
// 3) auditOnReject 'require': the ledger write is a PRECONDITION of the rejection — if the write blows up,
//    an audit error propagates instead of the rejection; 'best-effort' (default) keeps the old behavior.
// 4) preset 'critical' network path: a sub-agent's undeclared side-effect tool trips the strict-critical inheritance.
import { describe, it, expect, vi } from 'vitest';
import { stepCountIs } from 'ai';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable, streamDurable } from '../src/run.js';
import { acquireRunLock } from '../src/run-lock.js';
import { RunInputMismatchError } from '../src/errors.js';
import { createGnl } from '../src/registry.js';
import { createMockModel, createMockStreamAgent, countToolResults, toolCallResult, finalTextResult } from './mock.js';
import { tool } from 'ai';
import { z } from 'zod';

const base = (journal: InMemoryJournal, runId: string, extra: Record<string, unknown>) => ({
  runId, journal, stopWhen: stepCountIs(6), prompt: 'x', ...extra,
});
const textModel = () => createMockModel(async () => finalTextResult('done'));

describe('PHASE-7 stream lock heartbeat', () => {
  it('a LIVE stream that outlasts its ttl cannot be taken over (renew is working); the lock is released when it finishes', async () => {
    const journal = new InMemoryJournal();
    const tools = {
      chargeCard: tool({
        description: 'charge',
        inputSchema: z.object({ amount: z.number() }),
        // The tool runs longer than the ttl (40ms) → without a heartbeat, the lock would have dropped by now.
        execute: async ({ amount }) => { await new Promise((r) => setTimeout(r, 600)); return { charged: amount }; },
      }),
    };
    const r = await streamDurable({
      runId: 'hb1', journal, model: createMockStreamAgent(), tools,
      prompt: 'charge', stopWhen: stepCountIs(6), lock: { owner: 'A', ttlMs: 200 },
    } as any);
    const textP = r.text; // drive the stream
    await new Promise((res) => setTimeout(res, 350)); // ttl (200ms) has passed, the tool is still running
    const thief = await acquireRunLock(journal, 'hb1', 'thief', 60_000);
    expect(thief).toBeNull(); // in the OLD world this would have been a takeover — the heartbeat kept the lock alive
    await textP; // let it finish
    await new Promise((res) => setTimeout(res, 100)); // let the onFinish release settle
    const after = await acquireRunLock(journal, 'hb1', 'later', 60_000);
    expect(after).not.toBeNull(); // released once done — no leak
    await after!.release();
  });
});

describe('PHASE-7 stream lock heartbeat — the cap branch (audit K15/K23)', () => {
  it('once maxHoldMs is exceeded, the beat stops (loud warn), and TTL can take over', async () => {
    const journal = new InMemoryJournal();
    const tools = {
      chargeCard: tool({
        description: 'charge',
        inputSchema: z.object({ amount: z.number() }),
        execute: async ({ amount }) => { await new Promise((r) => setTimeout(r, 700)); return { charged: amount }; },
      }),
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await streamDurable({
        runId: 'hbcap', journal, model: createMockStreamAgent(), tools,
        prompt: 'charge', stopWhen: stepCountIs(6),
        lock: { owner: 'A', ttlMs: 120, maxHoldMs: 150 }, // cap injected (K23)
      } as any);
      const textP = r.text;
      await new Promise((res) => setTimeout(res, 450)); // cap (150) + ttl (120) have well elapsed
      const thief = await acquireRunLock(journal, 'hbcap', 'thief', 60_000);
      expect(thief).not.toBeNull(); // the beat stopped → TTL took over — the abandonment limit is REAL
      expect(warn.mock.calls.some((c) => String(c[0]).includes('renewal cap'))).toBe(true); // not silent
      await thief!.release();
      await textP.catch(() => {});
    } finally { warn.mockRestore(); }
  });
});

describe('PHASE-7 lookup (read-before-write)', () => {
  const model = (callId: string, args: unknown) => createMockModel(async ({ prompt }: any) =>
    countToolResults(prompt) === 0 ? toolCallResult('charge', callId, args) : finalTextResult('done'));

  it('exists:true → the body never runs, the found output is journaled and replayed; idempotencyKey is passed through', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    let seenKey: string | undefined;
    const tools = {
      charge: {
        sideEffect: true,
        lookup: async (_i: unknown, { idempotencyKey }: any) => { seenKey = idempotencyKey; return { exists: true as const, output: { charged: 50, via: 'lookup' } }; },
        execute: async () => { counter.n++; return { charged: 50, via: 'execute' }; },
      },
    };
    const r1 = await runDurable(base(journal, 'lk1', { model: model('c1', { amount: 50 }), tools }) as any);
    expect(counter.n).toBe(0); // the external system said "already there" — the effect never fired
    expect(JSON.stringify(r1.steps)).toContain('"via":"lookup"');
    expect(seenKey).toContain('lk1'); // the downstream key contract was honored
    // journaled → replay, lookup isn't even re-invoked (fast-path):
    seenKey = undefined;
    await runDurable(base(journal, 'lk1', { model: model('c1', { amount: 50 }), tools }) as any);
    expect(seenKey).toBeUndefined();
    expect(counter.n).toBe(0);
  });

  it('exists:false → runs normally; throw → loud warn + fail-open (current behavior)', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const mk = (lookup: any) => ({ charge: { sideEffect: true, lookup, execute: async () => { counter.n++; return { ok: 1 }; } } });
    await runDurable(base(journal, 'lk2', { model: model('c1', { amount: 1 }), tools: mk(async () => ({ exists: false })) }) as any);
    expect(counter.n).toBe(1);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runDurable(base(journal, 'lk3', { model: model('c1', { amount: 2 }), tools: mk(async () => { throw new Error('registry down'); }) }) as any);
      expect(counter.n).toBe(2); // the job wasn't blocked
      expect(warn.mock.calls.some((c) => String(c[0]).includes('lookup() failed'))).toBe(true);
    } finally { warn.mockRestore(); }
  });

  it('a non-fresh (failed) record never reaches lookup — the crash window belongs to the recover ladder', async () => {
    const journal = new InMemoryJournal();
    let lookups = 0;
    let explode = true;
    const tools = {
      charge: {
        sideEffect: true,
        lookup: async () => { lookups++; return { exists: false as const }; },
        execute: async () => { if (explode) throw new Error('boom'); return { ok: 1 }; },
      },
    };
    await runDurable(base(journal, 'lk4', { model: model('c1', { amount: 3 }), tools }) as any).catch(() => {});
    expect(lookups).toBe(1); // asked on the fresh call
    explode = false;
    await runDurable(base(journal, 'lk4', { model: model('c1', { amount: 3 }), tools }) as any).catch(() => {});
    expect(lookups).toBe(1); // a failed record → the recover ladder; lookup was NOT asked again
  });
});

describe('PHASE-7 lookup × suspended→approval (audit K6)', () => {
  it('lookup IS ASKED on a call returning from a suspended approval — a twin created while waiting gets caught', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const external = { created: false }; // the external system
    const tools = {
      charge: {
        sideEffect: true,
        confirm: true, // force a suspend
        lookup: async () => external.created ? { exists: true as const, output: { via: 'lookup' } } : { exists: false as const },
        execute: async () => { counter.n++; return { via: 'execute' }; },
      },
    };
    const model = createMockModel(async ({ prompt }: any) =>
      countToolResults(prompt) === 0 ? toolCallResult('charge', 'c1', { amount: 5 }) : finalTextResult('done'));
    await runDurable(base(journal, 'ls1', { model, tools }) as any); // confirm → suspended
    expect(counter.n).toBe(0);
    external.created = true; // a twin was created out-of-band while waiting
    const r = await runDurable(base(journal, 'ls1', { model, tools, approvals: { 'c1': true } }) as any);
    expect(counter.n).toBe(0); // despite approval, the body did NOT fire — read-before-write also works on the suspend path
    expect(JSON.stringify(r.steps)).toContain('"via":"lookup"');
  });
});

describe("PHASE-7 auditOnReject: 'require'", () => {
  it('if the ledger write blows up, an audit error propagates INSTEAD OF the rejection; best-effort keeps the old behavior', async () => {
    const mkJournal = (failLedger: boolean) => {
      const inner = new InMemoryJournal();
      const j: any = new Proxy(inner, {
        get: (t, p) => {
          if (p === 'put' && failLedger) {
            return async (k: string, v: unknown) => {
              if (k.startsWith('idem:conflict:')) throw new Error('audit store down');
              return inner.put(k, v);
            };
          }
          const val = (t as any)[p];
          return val instanceof Function ? val.bind(t) : val;
        },
      });
      return j;
    };
    // require: the audit write is a precondition of the refusal — if it can't be written, an audit error replaces the 409
    const j1 = mkJournal(true);
    await runDurable(base(j1, 'ar1', { model: textModel(), prompt: 'A', strictInput: true, conflictLedger: true, auditOnReject: 'require' }) as any);
    await expect(
      runDurable(base(j1, 'ar1', { model: textModel(), prompt: 'B', strictInput: true, conflictLedger: true, auditOnReject: 'require' }) as any),
    ).rejects.toThrow('audit store down');
    // best-effort (default): the rejection propagates as-is, the ledger error just gets a warn
    const j2 = mkJournal(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runDurable(base(j2, 'ar2', { model: textModel(), prompt: 'A', strictInput: true, conflictLedger: true }) as any);
      await expect(
        runDurable(base(j2, 'ar2', { model: textModel(), prompt: 'B', strictInput: true, conflictLedger: true }) as any),
      ).rejects.toBeInstanceOf(RunInputMismatchError);
    } finally { warn.mockRestore(); }
  });
});

describe("FAZ-7 require × the RunBusy site (a minor audit finding)", () => {
  it('a lock refusal cannot go unrecorded either: if the ledger fails, the audit error surfaces instead of RunBusy', async () => {
    const inner = new InMemoryJournal();
    const journal: any = new Proxy(inner, {
      get: (t, p) => {
        if (p === 'put') return async (k: string, v: unknown) => {
          if (k.startsWith('idem:conflict:')) throw new Error('audit store down');
          return inner.put(k, v);
        };
        const val = (t as any)[p];
        return val instanceof Function ? val.bind(t) : val;
      },
    });
    const held = await acquireRunLock(journal, 'rb1', 'other', 60_000);
    expect(held).not.toBeNull();
    await expect(
      runDurable(base(journal, 'rb1', {
        model: textModel(), conflictLedger: true, auditOnReject: 'require',
        lock: { owner: 'me', ttlMs: 60_000 },
      }) as any),
    ).rejects.toThrow('audit store down'); // not RunBusyError — record first, refuse second
  });
});

describe("FAZ-7 preset 'critical' network yolu", () => {
  it('a sub-agent\'s undeclared side-effect tool is caught by the inherited strict-critical policy', async () => {
    const route = JSON.stringify({ action: 'route', agent: 'payer', task: 'pay it' });
    const gnl = createGnl({
      journal: new InMemoryJournal(),
      preset: 'critical',
      agents: {
        payer: {
          model: createMockModel(async () => finalTextResult('paid')),
          tools: { mystery: { sideEffect: true, execute: async () => ({ ok: 1 }) } }, // recover/idempotencyKey YOK
        } as any,
      },
      networks: { n: { router: createMockModel(async () => finalTextResult(route)), agents: ['payer'] } as any },
    });
    await expect(gnl.runNetwork('n', { runId: 'nw1', task: 'pay' })).rejects.toThrow(/strict-critical/);
  });

  it("an inherited sideEffectDuplicates 'suspend' works in the sub-agent; an explicit opts.limits WINS", async () => {
    const routeMsg = JSON.stringify({ action: 'route', agent: 'payer', task: 'pay twice' });
    const finalMsg = JSON.stringify({ action: 'final', answer: 'done' });
    const mkGnl = () => {
      const counter = { n: 0 };
      let routerCall = 0;
      const gnl = createGnl({
        journal: new InMemoryJournal(),
        preset: 'critical',
        agents: {
          payer: {
            // The sub-agent calls twice with the SAME arguments → the run-scope dup marker fires.
            model: createMockModel(async ({ prompt }: any) => {
              const done = countToolResults(prompt);
              if (done < 2) return toolCallResult('send', `c${done + 1}`, { to: 'x' });
              return finalTextResult('paid');
            }),
            tools: { send: { sideEffect: true, recover: async () => ({ done: false as const }), execute: async () => { counter.n++; return { ok: 1 }; } } },
            maxSteps: 6,
          } as any,
        },
        networks: { n: { router: createMockModel(async () => finalTextResult(routerCall++ === 0 ? routeMsg : finalMsg)), agents: ['payer'] } as any },
      });
      return { gnl, counter };
    };
    const a = mkGnl();
    await a.gnl.runNetwork('n', { runId: 'nw2', task: 'pay' });
    expect(a.counter.n).toBe(1); // inherited 'suspend': the identical second call never fired (it suspended)
    const b = mkGnl();
    await b.gnl.runNetwork('n', { runId: 'nw3', task: 'pay', limits: { sideEffectDuplicates: 'off' } });
    expect(b.counter.n).toBe(2); // the explicit opts.limits won — inheritance was overridden
  });
});
