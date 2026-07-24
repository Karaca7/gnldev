// P2-waker (AUDIT-R2): createWorkflowWaker closes the "suspend and hope someone polls"
// gap — sleep(id, untilMs)/waitFor suspend a @gnl/workflow run and NOTHING re-drives it on its own.
// This waker scans the P0.4 suspended-run registry (listWorkflowRuns) and calls a host-supplied
// `resume` for runs that are actually due, the same poll-loop pattern @gnl/scheduler already uses
// for cron/interval/at triggers.
import { describe, it, expect, vi } from 'vitest';
import { InMemoryJournal } from '@gnl/durable';
import { workflow, step, sleep, waitFor, type JournalLike, type WorkflowRunStatus } from '@gnl/workflow';
import { createWorkflowWaker } from '../src/index.js';

describe('@gnl/scheduler — createWorkflowWaker', () => {
  it('time-based sleep: NOT resumed before untilMs, resumed once it passes', async () => {
    const journal = new InMemoryJournal();
    const untilMs = Date.now() + 150;
    const wf = workflow<Record<string, never>>()
      .then(sleep('wake', untilMs))
      .then(step('after', async () => ({ done: true })));

    const first = await wf.runResumable({}, { runId: 'r1', journal });
    expect(first).toMatchObject({ status: 'suspended', stepId: 'wake', reason: { kind: 'time', untilMs } });

    const resumeCalls: string[] = [];
    const waker = createWorkflowWaker({
      journal,
      resume: async (runId) => {
        resumeCalls.push(runId);
        return wf.runResumable({}, { runId, journal });
      },
    });

    // Not due yet — resume must NOT be called.
    const before = await waker.tick();
    expect(before).toEqual({ resumed: 0, skipped: 1, errored: 0 });
    expect(resumeCalls).toEqual([]);

    await new Promise((r) => setTimeout(r, 200)); // real clock — past untilMs now

    const after = await waker.tick();
    expect(after).toEqual({ resumed: 1, skipped: 0, errored: 0 });
    expect(resumeCalls).toEqual(['r1']);

    // The run completed — a later tick sees nothing suspended left to wake.
    const later = await waker.tick();
    expect(later).toEqual({ resumed: 0, skipped: 0, errored: 0 });
  });

  it('evented (waitFor): skipped by default, resumed only with wakeEvented: true', async () => {
    const journal = new InMemoryJournal();
    let ready = false;
    const wf = workflow<Record<string, never>>()
      // A tiny real delay when not-ready guarantees consecutive suspend generations of the SAME run
      // land on DIFFERENT milliseconds — otherwise, on a fast in-memory journal, a resume() that
      // re-suspends can rewrite `updatedAt` to the SAME ms it started from, colliding with the wake
      // ticket THAT SAME tick just claimed (an artifact of synchronous back-to-back ticks in a test;
      // real deployments always have `intervalMs` of real time between ticks, so this never happens
      // in production — see the WAKE_TICKET bound noted in workflow-waker.ts).
      .then(waitFor('ev', async () => {
        if (ready) return { ok: true };
        await new Promise((r) => setTimeout(r, 2));
        return null;
      }))
      .then(step('after', async (v) => v));

    await wf.runResumable({}, { runId: 'r2', journal });
    const status = await journal.get<WorkflowRunStatus>('wfrun:r2');
    expect(status).toMatchObject({ status: 'suspended', waitId: 'ev', reason: { kind: 'event' } });

    let resumeCalls = 0;
    const defaultWaker = createWorkflowWaker({
      journal,
      resume: async (runId) => {
        resumeCalls++;
        return wf.runResumable({}, { runId, journal });
      },
    });
    const r1 = await defaultWaker.tick();
    expect(r1).toEqual({ resumed: 0, skipped: 1, errored: 0 });
    expect(resumeCalls).toBe(0); // no readiness signal → left alone by default

    const eventedWaker = createWorkflowWaker({
      journal,
      wakeEvented: true,
      resume: async (runId) => {
        resumeCalls++;
        return wf.runResumable({}, { runId, journal });
      },
    });
    const r2 = await eventedWaker.tick();
    expect(r2).toEqual({ resumed: 1, skipped: 0, errored: 0 });
    expect(resumeCalls).toBe(1); // opt-in: resumed even without a readiness signal (still not ready → re-suspends)

    ready = true; // now the event is actually satisfied
    const r3 = await eventedWaker.tick();
    expect(r3).toEqual({ resumed: 1, skipped: 0, errored: 0 });
    expect(resumeCalls).toBe(2);
    expect((await journal.get<WorkflowRunStatus>('wfrun:r2'))!.status).toBe('completed');
  });

  it('double-instance tick with a shared (CAS-capable) journal: resume is called exactly once (wake ticket)', async () => {
    const journal = new InMemoryJournal();
    await journal.put('wfrun:r3', {
      runId: 'r3',
      status: 'suspended',
      stepId: 'wake',
      reason: { kind: 'time', untilMs: 0 },
      updatedAt: 42,
    } satisfies WorkflowRunStatus);

    let resumeCalls = 0;
    const makeWaker = () =>
      createWorkflowWaker({
        journal,
        resume: async () => {
          resumeCalls++;
        },
      });
    const wakerA = makeWaker();
    const wakerB = makeWaker();

    const [ra, rb] = await Promise.all([wakerA.tick(), wakerB.tick()]);
    expect(ra.resumed + rb.resumed).toBe(1); // exactly one instance won the ticket
    expect(resumeCalls).toBe(1);
  });

  it('correctness does NOT depend on the ticket: even if it fails to dedupe, both resume() calls converge on the SAME journaled outcome', async () => {
    // Real journal — the WORKFLOW's own step-level CAS (putIfAbsent) is fully intact here; only the
    // WAKER's ticket bookkeeping is deliberately defeated below (worst case: no protection at all).
    const inner = new InMemoryJournal();
    let computeCount = 0;
    const untilMs = Date.now() + 60;
    const wf = workflow<Record<string, never>>()
      .then(sleep('wake', untilMs))
      .then(step('after', async () => { computeCount++; return { seq: computeCount }; }));
    const ctx = { runId: 'race1', journal: inner };
    expect(await wf.runResumable({}, ctx)).toMatchObject({ status: 'suspended' });

    await new Promise((r) => setTimeout(r, 80)); // now due

    // A journal whose ticket keys ALWAYS look absent (worst-case: no CAS protection whatsoever —
    // stronger than merely "no putIfAbsent", since even the get+put fallback's narrow race window
    // wouldn't normally guarantee a double-claim on every run; this forces it deterministically).
    const noTicketProtection: JournalLike = {
      get: async (k: string) => (k.startsWith('wfwake:') ? undefined : inner.get(k)),
      put: (k, v) => inner.put(k, v),
      listKeys: (p: string) => inner.listKeys!(p),
    };
    const results: unknown[] = [];
    const resume = async (runId: string) => {
      const r = await wf.runResumable({}, { runId, journal: inner });
      results.push(r);
      return r;
    };
    const wakerA = createWorkflowWaker({ journal: noTicketProtection, resume });
    const wakerB = createWorkflowWaker({ journal: noTicketProtection, resume });

    const [ra, rb] = await Promise.all([wakerA.tick(), wakerB.tick()]);
    expect(ra.resumed).toBe(1); // BOTH "won" the (defeated) ticket — worst case demonstrated
    expect(rb.resumed).toBe(1);
    // "runResumable is idempotent anyway" means the RUN'S OUTCOME is single-sourced (CAS on the
    // step's journal record) — NOT that a step's own internal side effects are magically deduped
    // (a bare counter inside a step is not itself durable; steps with side effects must be
    // idempotent themselves, same as everywhere else in @gnl/workflow — see cas.test.ts). Both
    // callers nonetheless converge on the IDENTICAL final result: the losing compute's output is
    // discarded, the winner's journaled record is what both resume() calls return.
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({ status: 'completed' });
  });

  it('resume() throwing does not kill tick(): the error is swallowed per-run, other runs in the same tick still resume, onError observes it', async () => {
    const journal = new InMemoryJournal();
    await journal.put('wfrun:bad', {
      runId: 'bad', status: 'suspended', reason: { kind: 'time', untilMs: 0 }, updatedAt: 1,
    } satisfies WorkflowRunStatus);
    await journal.put('wfrun:good', {
      runId: 'good', status: 'suspended', reason: { kind: 'time', untilMs: 0 }, updatedAt: 1,
    } satisfies WorkflowRunStatus);

    const errors: Array<{ runId: string; error: unknown }> = [];
    const resumed: string[] = [];
    const waker = createWorkflowWaker({
      journal,
      onError: (runId, error) => errors.push({ runId, error }),
      resume: async (runId) => {
        if (runId === 'bad') throw new Error('boom');
        resumed.push(runId);
      },
    });

    const result = await waker.tick(); // must not throw
    expect(result).toEqual({ resumed: 2, skipped: 0, errored: 1 });
    expect(resumed).toEqual(['good']);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.runId).toBe('bad');
    expect(String((errors[0]!.error as Error).message)).toBe('boom');
  });

  it('default onError (no hook given): console.warn ONCE per runId per failure streak, then again after a NEW streak starts', async () => {
    const journal = new InMemoryJournal();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let seq = 0;
      let shouldFail = true;
      // Each tick gets a FRESH updatedAt (simulating a real workflow's own suspend-status rewrite on
      // every resume attempt) → a fresh wake ticket every time, so the SAME waker instance's
      // per-run failStreak bookkeeping is what's under test here, not the ticket.
      const putFresh = async () =>
        journal.put('wfrun:w', {
          runId: 'w', status: 'suspended', reason: { kind: 'time', untilMs: 0 }, updatedAt: ++seq,
        } satisfies WorkflowRunStatus);

      const waker = createWorkflowWaker({
        journal,
        resume: async () => {
          if (shouldFail) throw new Error('boom');
        },
      });

      await putFresh();
      await waker.tick(); // fail #1 — new streak → warns
      expect(warn).toHaveBeenCalledTimes(1);

      await putFresh();
      await waker.tick(); // fail #2 — same streak (no success in between) → no re-warn
      expect(warn).toHaveBeenCalledTimes(1);

      shouldFail = false;
      await putFresh();
      await waker.tick(); // succeeds → streak reset
      expect(warn).toHaveBeenCalledTimes(1);

      shouldFail = true;
      await putFresh();
      await waker.tick(); // fails again → NEW streak → warns again
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('start()/stop(): stop() halts ticking, no dangling timer (no further scans after stop)', async () => {
    const journal = new InMemoryJournal();
    const origListKeys = journal.listKeys!.bind(journal);
    let scans = 0;
    vi.spyOn(journal, 'listKeys').mockImplementation((...args: Parameters<typeof origListKeys>) => {
      scans++;
      return origListKeys(...args);
    });

    const waker = createWorkflowWaker({ journal, resume: async () => {}, intervalMs: 15 });
    waker.start();
    await new Promise((r) => setTimeout(r, 100));
    waker.stop();
    const scansAtStop = scans;
    expect(scansAtStop).toBeGreaterThan(0);

    await new Promise((r) => setTimeout(r, 100));
    expect(scans).toBe(scansAtStop); // nothing fired after stop()

    // Idempotent stop()/restart safety: calling stop() again or start()ing fresh doesn't blow up.
    waker.stop();
    waker.start();
    await new Promise((r) => setTimeout(r, 40));
    waker.stop();
    expect(scans).toBeGreaterThan(scansAtStop);
  });

  it('integration: a REAL @gnl/workflow with sleep() — suspend → waker resumes → completes', async () => {
    const journal = new InMemoryJournal();
    const untilMs = Date.now() + 60;
    const wf = workflow<{ x: number }>()
      .then(sleep('wake', untilMs))
      .then(step('finish', async (_v, ctx) => ({ x: 1, runId: ctx.runId })));

    const first = await wf.runResumable({ x: 1 }, { runId: 'int1', journal });
    expect(first.status).toBe('suspended');

    const waker = createWorkflowWaker({
      journal,
      intervalMs: 20,
      resume: (runId) => wf.runResumable({ x: 1 }, { runId, journal }),
    });
    waker.start();
    try {
      await new Promise((r) => setTimeout(r, 150));
      const status = await journal.get<WorkflowRunStatus>('wfrun:int1');
      expect(status?.status).toBe('completed');
    } finally {
      waker.stop();
    }
  });
});
