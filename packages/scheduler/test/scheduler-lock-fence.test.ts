// Long-running triggers: lock heartbeat (renew) + CAS-fenced state writes.
// The bug this file pins down: `pollScheduler` used to take a FIXED 60s lock, never renew it, and
// write the trigger state with a plain `put` at the end. A workflow running longer than the TTL
// therefore let a SECOND poller take the lock over and fire the SAME trigger again, and the late
// FIRST poller then wrote its STALE state back on top (fireCount/nextRunAt rolled back, `attempts`
// resurrected) → a third fire.
// All timing is driven by FAKE TIMERS — no test may actually wait 60 real seconds.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import type { Journal } from '@gnldev/durable';
import { scheduleWorkflow, pollScheduler, createScheduler, type WorkflowRunner } from '../src/index.js';

const STATE = (id: string) => `sched:state:${id}`;
interface TriggerState { nextRunAt: number; attempts: number; fireCount: number; status: string }

/** Runner whose run BLOCKS until the returned gate is opened (simulates a long workflow). */
function gatedRunner(opts: { fail?: boolean; suspended?: boolean } = {}) {
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  const calls: string[] = [];
  const runner: WorkflowRunner = {
    async runWorkflow(_name, _input, o) {
      const runId = o?.runId ?? 'x';
      calls.push(runId);
      await gate;
      if (opts.fail) throw new Error('boom');
      return { runId, suspended: opts.suspended };
    },
  };
  return { runner, calls, open: () => open() };
}

function fastRunner(opts: { suspended?: boolean } = {}) {
  const calls: string[] = [];
  const runner: WorkflowRunner = {
    async runWorkflow(_name, _input, o) {
      const runId = o?.runId ?? 'x';
      calls.push(runId);
      return { runId, suspended: opts.suspended };
    },
  };
  return { runner, calls };
}

/**
 * An OLDER/custom journal that does NOT implement `putIfMatch` (the documented fallback path in
 * `pollScheduler`'s `commit`). `putIfAbsent` is deliberately KEPT — otherwise `claim()` would also
 * drop to its own fallback and the test would no longer be isolated to the CAS branch.
 */
function noCasJournal(): Journal {
  const inner = new InMemoryJournal();
  return {
    get: (key: string) => inner.get(key),
    put: (key: string, v: unknown) => inner.put(key, v),
    putIfAbsent: (key: string, v: unknown) => inner.putIfAbsent(key, v),
    listKeys: (prefix: string) => inner.listKeys(prefix),
    // no putIfMatch, no now()
  } as Journal;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('scheduler: long-running trigger, lock + fencing', () => {
  it('heartbeat: a workflow longer than the lock TTL is fired only ONCE', async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const j = new InMemoryJournal();
    const a = gatedRunner();
    const b = fastRunner();
    await scheduleWorkflow(j, { id: 'long', name: 'wf', at: Date.now() }, Date.now());

    const p1 = pollScheduler(j, a.runner, Date.now(), { owner: 'A' }); // holds the lock, workflow hasn't finished
    await vi.advanceTimersByTimeAsync(90_000); // 90s > 60s TTL — without a heartbeat the lock would be dead

    const r2 = await pollScheduler(j, b.runner, Date.now(), { owner: 'B' });
    expect(r2.fired).toBe(0); // B could NOT take the lock over → no second fire
    expect(b.calls).toEqual([]);

    a.open();
    await vi.advanceTimersByTimeAsync(0);
    const r1 = await p1;
    expect(r1.fired).toBe(1);
    expect(a.calls).toEqual(['sched:long:0']); // a single fire in total
  });

  it('fencing: a stale poller cannot write the state back (fireCount/nextRunAt are preserved)', async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const t0 = Date.now();
    const j = new InMemoryJournal();
    const a = gatedRunner();
    const b = fastRunner();
    // every=60s → the state after a fire is observable (fireCount+1, nextRunAt on the planned grid).
    await scheduleWorkflow(j, { id: 'e', name: 'wf', every: 60_000 }, t0 - 60_000); // nextRunAt = t0

    // A takes the lock, then the clock JUMPS past the TTL without the pending heartbeat interval ever
    // firing (setSystemTime moves the wall clock, advanceTimersByTime would run the timer) → the lock
    // genuinely expires, a real takeover — no test-only knob in the production API.
    const p1 = pollScheduler(j, a.runner, t0, { owner: 'A' });
    await vi.advanceTimersByTimeAsync(0); // A takes the lock and enters the (gated) workflow
    expect(a.calls).toEqual(['sched:e:0']); // precondition: A really is in flight holding the lock
    vi.setSystemTime(t0 + 70_000);

    const r2 = await pollScheduler(j, b.runner, Date.now(), { owner: 'B' });
    expect(r2.fired).toBe(1); // B took over the expired lock and fired
    const afterB = (await j.get<TriggerState>(STATE('e')))!;
    expect(afterB.fireCount).toBe(1);

    a.open(); // the late A now wants to write its own (stale) result
    await vi.advanceTimersByTimeAsync(0);
    const r1 = await p1;

    const afterA = (await j.get<TriggerState>(STATE('e')))!;
    expect(afterA).toEqual(afterB); // the stale write was REJECTED — the state is untouched
    expect(afterA.fireCount).toBe(1); // not rolled back to 0
    expect(afterA.nextRunAt).toBe(afterB.nextRunAt); // B's grid stands
    expect(r1.fired).toBe(0); // the stale poller doesn't count a fire either
  });

  it('fencing: `attempts` is not resurrected by a stale write', async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const t0 = Date.now();
    const j = new InMemoryJournal();
    const a = gatedRunner({ fail: true }); // long AND then failing
    const b = fastRunner();
    await scheduleWorkflow(j, { id: 'r', name: 'wf', every: 60_000 }, t0 - 60_000);

    const p1 = pollScheduler(j, a.runner, t0, { owner: 'A' });
    await vi.advanceTimersByTimeAsync(0);
    expect(a.calls).toEqual(['sched:r:0']); // precondition: A really is in flight holding the lock
    vi.setSystemTime(t0 + 70_000); // genuine TTL expiry: the clock jumps, the heartbeat interval never fires

    await pollScheduler(j, b.runner, Date.now(), { owner: 'B' }); // takeover + successful fire → attempts=0
    a.open();
    await vi.advanceTimersByTimeAsync(0);
    const r1 = await p1; // A's workflow threw → it wants to write attempts=1 + backoff

    const st = (await j.get<TriggerState>(STATE('r')))!;
    expect(st.attempts).toBe(0); // the failure of the poller that lost the lock does NOT stick
    expect(st.fireCount).toBe(1);
    expect(r1.rescheduled).toBe(0);
    expect(r1.failed).toBe(0);
  });

  // The heartbeat must be stopped when the fire ends. `release()` KEEPS the fencing token (it only
  // pushes `expires` into the past), so a tick that outlives the fire renews a lock that was already
  // released — resurrecting it for a full TTL and locking out every later poll of the SAME runId.
  it('a released lock is NOT resurrected by a surviving heartbeat (the same runId is resumable)', async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const t0 = Date.now();
    const j = new InMemoryJournal();
    // A SUSPENDING workflow leaves fireCount untouched → the next poll retries the SAME runId
    // (`sched:s:0`) and therefore needs the SAME lock key to be free again.
    const r = fastRunner({ suspended: true });
    await scheduleWorkflow(j, { id: 's', name: 'wf', every: 60_000 }, t0 - 60_000); // nextRunAt = t0

    const r1 = await pollScheduler(j, r.runner, t0, { owner: 'A', retryMs: 30_000 });
    expect(r1.rescheduled).toBe(1);
    expect(r.calls).toEqual(['sched:s:0']);

    // ttl/3 = 20s falls inside this window: a heartbeat that survived the fire would tick and push the
    // released lock's `expires` from 0 to now+60s.
    await vi.advanceTimersByTimeAsync(35_000);

    const r2 = await pollScheduler(j, r.runner, Date.now(), { owner: 'B', retryMs: 30_000 });
    expect(r2.rescheduled).toBe(1); // the lock was free → the suspended run is picked up again
    expect(r.calls).toEqual(['sched:s:0', 'sched:s:0']);
  });

  // The remaining CAS gates. A stale poller must not increment its own counters and — the thing the
  // code explicitly claims to prevent — must not leave a diagnostic record on SOMEBODY ELSE's fire.
  it('CAS (budget-skip): a stale poller leaves no budget-skip record on another poller`s fire', async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const t0 = Date.now();
    const j = new InMemoryJournal();
    const a = fastRunner(); // must never be reached: the guard blocks A before runWorkflow
    const b = fastRunner();
    let openGuard!: () => void;
    const guardGate = new Promise<void>((res) => { openGuard = res; });
    let guardEntered = false;
    await scheduleWorkflow(j, { id: 'bs', name: 'wf', every: 60_000 }, t0 - 60_000);

    const p1 = pollScheduler(j, a.runner, t0, {
      owner: 'A',
      budgetGuard: async () => { guardEntered = true; await guardGate; throw new Error('over budget'); },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(guardEntered).toBe(true); // precondition: A holds the lock and is inside the guard
    vi.setSystemTime(t0 + 70_000);

    const r2 = await pollScheduler(j, b.runner, Date.now(), { owner: 'B' }); // takeover + real fire
    expect(r2.fired).toBe(1);
    const afterB = (await j.get<TriggerState>(STATE('bs')))!;

    openGuard(); // the late A now overruns its budget and wants to record a skip
    await vi.advanceTimersByTimeAsync(0);
    const r1 = await p1;

    expect(r1.skipped).toBe(0); // the stale poller does not count a skip
    expect(await j.get('sched:budget-skip:bs')).toBeUndefined(); // …nor annotate B's fire
    expect(await j.get<TriggerState>(STATE('bs'))).toEqual(afterB); // …nor push nextRunAt around
    expect(a.calls).toEqual([]);
  });

  it('CAS (failed): a stale poller cannot mark the trigger failed or leave a fail record', async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const t0 = Date.now();
    const j = new InMemoryJournal();
    const a = gatedRunner({ fail: true });
    const b = fastRunner();
    // maxAttempts=1 → A's single failure lands on the TERMINAL 'failed' branch, not the retry branch.
    await scheduleWorkflow(j, { id: 'f', name: 'wf', every: 60_000, maxAttempts: 1 }, t0 - 60_000);

    const p1 = pollScheduler(j, a.runner, t0, { owner: 'A' });
    await vi.advanceTimersByTimeAsync(0);
    expect(a.calls).toEqual(['sched:f:0']);
    vi.setSystemTime(t0 + 70_000);

    const r2 = await pollScheduler(j, b.runner, Date.now(), { owner: 'B' });
    expect(r2.fired).toBe(1);
    const afterB = (await j.get<TriggerState>(STATE('f')))!;

    a.open();
    await vi.advanceTimersByTimeAsync(0);
    const r1 = await p1;

    expect(r1.failed).toBe(0);
    expect(await j.get('sched:fail:f')).toBeUndefined(); // no FAIL note on B's successful fire
    const st = (await j.get<TriggerState>(STATE('f')))!;
    expect(st.status).toBe('pending'); // a live trigger is not killed by a poller that lost the lock
    expect(st).toEqual(afterB);
  });

  it('CAS (done, kind=`at`): a one-shot trigger is counted as fired by exactly ONE poller', async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const t0 = Date.now();
    const j = new InMemoryJournal();
    const a = gatedRunner();
    const b = fastRunner();
    await scheduleWorkflow(j, { id: 'once', name: 'wf', at: t0 }, t0);

    const p1 = pollScheduler(j, a.runner, t0, { owner: 'A' });
    await vi.advanceTimersByTimeAsync(0);
    expect(a.calls).toEqual(['sched:once:0']);
    vi.setSystemTime(t0 + 70_000);

    const r2 = await pollScheduler(j, b.runner, Date.now(), { owner: 'B' });
    expect(r2.fired).toBe(1);

    a.open();
    await vi.advanceTimersByTimeAsync(0);
    const r1 = await p1;

    expect(r1.fired).toBe(0);
    expect(r1.fired + r2.fired).toBe(1); // ONE trigger → ONE reported fire, across both pollers
    expect((await j.get<TriggerState>(STATE('once')))!.status).toBe('done');
  });

  it('CAS (suspended): a stale poller cannot drag a suspended trigger`s retry time backwards', async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const t0 = Date.now();
    const j = new InMemoryJournal();
    const a = gatedRunner({ suspended: true });
    const b = fastRunner({ suspended: true });
    await scheduleWorkflow(j, { id: 'sp', name: 'wf', every: 60_000 }, t0 - 60_000);

    const p1 = pollScheduler(j, a.runner, t0, { owner: 'A', retryMs: 30_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(a.calls).toEqual(['sched:sp:0']);
    vi.setSystemTime(t0 + 70_000);

    const r2 = await pollScheduler(j, b.runner, Date.now(), { owner: 'B', retryMs: 30_000 });
    expect(r2.rescheduled).toBe(1);
    const afterB = (await j.get<TriggerState>(STATE('sp')))!;
    expect(afterB.nextRunAt).toBe(t0 + 70_000 + 30_000); // B's retry slot

    a.open(); // the late A wants its own (much earlier) retry slot: t0 + 30s
    await vi.advanceTimersByTimeAsync(0);
    const r1 = await p1;

    expect(r1.rescheduled).toBe(0);
    const st = (await j.get<TriggerState>(STATE('sp')))!;
    expect(st.nextRunAt).toBe(afterB.nextRunAt); // NOT pulled back to t0 + 30s (which is already past)
    expect(st).toEqual(afterB);
  });
});

// `lockTtlMs` is a PUBLIC, README-documented option (pollScheduler + createScheduler) that had ZERO
// coverage: every other test in this file runs on the 60s default, so hard-coding 60_000 and ignoring
// the option entirely kept the whole suite green. Two separate claims are pinned below, because they
// fail to different mutations: (1) the ACQUISITION really uses the given TTL — a shorter TTL means an
// earlier real takeover; (2) the HEARTBEAT interval is derived from the given TTL (ttl/3), not from
// the default — a custom TTL that is being renewed survives past its own expiry.
describe('scheduler: custom lockTtlMs', () => {
  it('a short lockTtlMs really expires that early — the second poller takes over and fires', async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const t0 = Date.now();
    const j = new InMemoryJournal();
    const a = gatedRunner();
    const b = fastRunner();
    await scheduleWorkflow(j, { id: 'tt', name: 'wf', every: 60_000 }, t0 - 60_000); // nextRunAt = t0

    // A holds the lock with a 9s TTL. The clock then JUMPS to t0+10s: past A's OWN ttl but far short
    // of the 60s default — so a takeover here is only possible if `lockTtlMs` was actually honoured.
    // (setSystemTime moves the wall clock WITHOUT running the pending heartbeat → a genuine expiry.)
    const p1 = pollScheduler(j, a.runner, t0, { owner: 'A', lockTtlMs: 9_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(a.calls).toEqual(['sched:tt:0']); // precondition: A is in flight holding the lock
    vi.setSystemTime(t0 + 10_000);

    const r2 = await pollScheduler(j, b.runner, Date.now(), { owner: 'B' });
    expect(r2.fired).toBe(1); // B took the 9s lock over and FIRED
    expect(b.calls).toEqual(['sched:tt:0']); // …the same fire A is still running

    a.open(); // A finishes late; the CAS discards its result (as with any takeover)
    await vi.advanceTimersByTimeAsync(0);
    expect((await p1).fired).toBe(0);
  });

  it('the heartbeat follows the CUSTOM ttl/3 — a 9s lock renewed at 3s is still alive at 11s', async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const t0 = Date.now();
    const j = new InMemoryJournal();
    const a = gatedRunner();
    const b = fastRunner();
    await scheduleWorkflow(j, { id: 'hb', name: 'wf', every: 60_000 }, t0 - 60_000);

    const p1 = pollScheduler(j, a.runner, t0, { owner: 'A', lockTtlMs: 9_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(a.calls).toEqual(['sched:hb:0']);

    // Timers RUN for 4s: with a ttl/3 = 3s heartbeat exactly one renew lands, pushing `expires` to
    // 3s + 9s = t0+12s. The clock then jumps to t0+11s — past the ORIGINAL 9s expiry, before the
    // renewed one. A heartbeat driven by the DEFAULT ttl (60s/3 = 20s) would not have ticked yet.
    await vi.advanceTimersByTimeAsync(4_000);
    vi.setSystemTime(t0 + 11_000);

    const r2 = await pollScheduler(j, b.runner, Date.now(), { owner: 'B' });
    expect(r2.fired).toBe(0); // the renewed lock still stands → NO second fire
    expect(b.calls).toEqual([]);

    a.open();
    await vi.advanceTimersByTimeAsync(0);
    const r1 = await p1;
    expect(r1.fired).toBe(1);
    expect(a.calls).toEqual(['sched:hb:0']); // a single fire in total
  });

  // …and the OPTION HAS TO ARRIVE. `createScheduler` is the documented entry point (README:39 says
  // lockTtlMs applies "on both pollScheduler and createScheduler") and it reaches pollScheduler only
  // through one hand-written forwarding list (src/index.ts: `{ owner, retryMs, budgetGuard,
  // lockTtlMs }`). MEASURED: deleting `lockTtlMs` from that object left the scheduler package plus
  // four other packages — 105 tests — entirely GREEN, because every test above builds its options by
  // calling pollScheduler directly and so never crosses the wrapper. Asserted by the same behaviour
  // as the test above, driven through createScheduler: a 9s lock is takeable at 10s, a 60s one isn't.
  it('createScheduler forwards lockTtlMs to the poll it performs', async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const t0 = Date.now();
    const j = new InMemoryJournal();
    const a = gatedRunner();
    const b = fastRunner();
    await scheduleWorkflow(j, { id: 'cs', name: 'wf', every: 60_000 }, t0 - 60_000); // nextRunAt = t0

    const sched = createScheduler(j, a.runner, { owner: 'A', lockTtlMs: 9_000 });
    const p1 = sched.poll(t0); // NOT start() — one deliberate poll, no background loop to stop
    await vi.advanceTimersByTimeAsync(0);
    expect(a.calls).toEqual(['sched:cs:0']); // precondition: the scheduler is in flight, holding the lock
    vi.setSystemTime(t0 + 10_000); // past 9s, far short of the 60s default

    const r2 = await pollScheduler(j, b.runner, Date.now(), { owner: 'B' });
    expect(r2.fired).toBe(1); // 0 = the option never left createScheduler and a 60s lock was taken
    expect(b.calls).toEqual(['sched:cs:0']);

    a.open();
    await vi.advanceTimersByTimeAsync(0);
    expect((await p1).fired).toBe(0); // the CAS discards the superseded poller's result, as ever
  });
});

// The `if (!journal.putIfMatch)` fallback in `commit` had NO coverage either: every test above runs
// on InMemoryJournal, which HAS the CAS. Deleting the branch (i.e. assuming `putIfMatch` always
// exists) left the suite green while it would throw TypeError on the first old/custom adapter.
// The fallback is a documented QUALITY DROP — an unconditional put, no fencing — not a crash; pin
// exactly that much: it still fires and still writes correctly, and the lost fencing is visible.
describe('scheduler: journal without putIfMatch (documented fallback)', () => {
  it('still fires, advances fireCount and reschedules on the planned grid', async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const t0 = Date.now();
    const j = noCasJournal();
    const r = fastRunner();
    await scheduleWorkflow(j, { id: 'nc', name: 'wf', every: 60_000 }, t0 - 60_000); // nextRunAt = t0

    const r1 = await pollScheduler(j, r.runner, t0, { owner: 'A' });
    expect(r1.fired).toBe(1);
    expect(await j.get<TriggerState>(STATE('nc'))).toEqual({
      nextRunAt: t0 + 60_000,
      attempts: 0,
      fireCount: 1,
      status: 'pending',
    });

    const r2 = await pollScheduler(j, r.runner, t0 + 60_000, { owner: 'A' });
    expect(r2.fired).toBe(1); // the trigger keeps repeating — the write path is not a one-off fluke
    expect(r.calls).toEqual(['sched:nc:0', 'sched:nc:1']); // per-fire runIds still advance
    expect((await j.get<TriggerState>(STATE('nc')))!.fireCount).toBe(2);
  });

  it('WITHOUT the CAS a stale poller`s write does land — the documented loss of fencing', async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const t0 = Date.now();
    const j = noCasJournal();
    const a = gatedRunner();
    const b = fastRunner();
    await scheduleWorkflow(j, { id: 'ncf', name: 'wf', every: 60_000 }, t0 - 60_000);

    const p1 = pollScheduler(j, a.runner, t0, { owner: 'A' });
    await vi.advanceTimersByTimeAsync(0);
    expect(a.calls).toEqual(['sched:ncf:0']);
    vi.setSystemTime(t0 + 70_000); // genuine TTL expiry (the heartbeat interval never ticks)

    const r2 = await pollScheduler(j, b.runner, Date.now(), { owner: 'B' });
    expect(r2.fired).toBe(1); // takeover still works (run-lock has its own fallback)
    expect((await j.get<TriggerState>(STATE('ncf')))!.nextRunAt).toBe(t0 + 120_000); // B's grid slot

    a.open();
    await vi.advanceTimersByTimeAsync(0);
    const r1 = await p1;

    // This is the price of an adapter without putIfMatch, and it is stated in the source comment:
    // The late poller's unconditional put OVERWRITES B's result — the same slot is counted as fired
    // twice and nextRunAt is dragged back to a time that has already passed (an immediate re-fire).
    // An adapter WITH the CAS keeps fired at 1 and nextRunAt at t0+120s (see the fencing tests above).
    expect(r1.fired).toBe(1);
    expect(r1.fired + r2.fired).toBe(2);
    expect((await j.get<TriggerState>(STATE('ncf')))!.nextRunAt).toBe(t0 + 60_000);
  });
});
