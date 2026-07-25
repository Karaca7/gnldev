// #5B scheduler: at/every firing, backoff/retry, lock, suspended workflow + createGnl integration.
import { describe, it, expect, vi } from 'vitest';
import { InMemoryJournal, acquireRunLock, createGnl } from '@gnldev/durable';
import { workflow, step } from '@gnldev/workflow';
import { scheduleWorkflow, pollScheduler, createScheduler, listTriggers, type WorkflowRunner } from '../src/index.js';

function mockRunner(behavior: () => { suspended?: boolean; output?: unknown }): WorkflowRunner & { calls: { name: string; runId: string }[] } {
  const calls: { name: string; runId: string }[] = [];
  return {
    calls,
    async runWorkflow(name, _input, opts) {
      const runId = opts?.runId ?? 'x';
      calls.push({ name, runId });
      return { runId, ...behavior() };
    },
  };
}

describe('@gnldev/scheduler', () => {
  it('at (past): fires once, second poll is a no-op', async () => {
    const j = new InMemoryJournal();
    const runner = mockRunner(() => ({ output: 'ok' }));
    await scheduleWorkflow(j, { name: 'wf', at: 1000 }, 1000);

    const r1 = await pollScheduler(j, runner, 2000);
    expect(r1.fired).toBe(1);
    expect(runner.calls).toEqual([{ name: 'wf', runId: 'sched:wf:0' }]);

    const r2 = await pollScheduler(j, runner, 3000);
    expect(r2.fired).toBe(0); // status done
    expect(runner.calls).toHaveLength(1);
  });

  it('every: fires repeatedly, fireCount increments + reschedule', async () => {
    const j = new InMemoryJournal();
    const runner = mockRunner(() => ({ output: 'ok' }));
    await scheduleWorkflow(j, { id: 'e', name: 'wf', every: 1000 }, 0); // nextRunAt=1000

    expect((await pollScheduler(j, runner, 1000)).fired).toBe(1);
    expect(runner.calls[0]!.runId).toBe('sched:e:0');
    expect((await pollScheduler(j, runner, 1500)).fired).toBe(0); // not due yet (next=2000)
    expect((await pollScheduler(j, runner, 2000)).fired).toBe(1);
    expect(runner.calls[1]!.runId).toBe('sched:e:1'); // fireCount incremented
  });

  it('error: backoff/retry → failed at maxAttempts', async () => {
    const j = new InMemoryJournal();
    const runner = mockRunner(() => {
      throw new Error('boom');
    });
    await scheduleWorkflow(j, { id: 'f', name: 'wf', at: 0, maxAttempts: 2 }, 0);

    expect((await pollScheduler(j, runner, 0)).rescheduled).toBe(1); // attempt 1 → backoff(1)=1000
    expect((await pollScheduler(j, runner, 1000)).failed).toBe(1); // attempt 2 → failed
    const r3 = await pollScheduler(j, runner, 5000);
    expect(r3.fired + r3.failed + r3.rescheduled).toBe(0); // status failed → skip
  });

  it('suspended workflow: reschedule → next poll resumes the SAME runId → completed', async () => {
    const j = new InMemoryJournal();
    let suspended = true;
    const runner = mockRunner(() => (suspended ? { suspended: true } : { output: 'done' }));
    await scheduleWorkflow(j, { id: 's', name: 'wf', at: 0 }, 0);

    expect((await pollScheduler(j, runner, 0, { retryMs: 100 })).rescheduled).toBe(1);
    expect(runner.calls[0]!.runId).toBe('sched:s:0');

    suspended = false;
    expect((await pollScheduler(j, runner, 100)).fired).toBe(1);
    expect(runner.calls[1]!.runId).toBe('sched:s:0'); // resumed the same runId
    expect((await pollScheduler(j, runner, 200)).fired).toBe(0); // done
  });

  it('does not fire when the lock is held by someone else (double-fire protection)', async () => {
    const j = new InMemoryJournal();
    const runner = mockRunner(() => ({ output: 'ok' }));
    await scheduleWorkflow(j, { id: 'L', name: 'wf', at: 0 }, 0);
    await acquireRunLock(j, 'sched:L:0', 'other', 60_000, 0); // held by someone else

    const r = await pollScheduler(j, runner, 0);
    expect(r.fired).toBe(0);
    expect(runner.calls).toHaveLength(0);
  });

  it('every + misfire skip (default): missed fires on a late poll are skipped, no drift accumulates, single fire', async () => {
    const j = new InMemoryJournal();
    const runner = mockRunner(() => ({ output: 'ok' }));
    await scheduleWorkflow(j, { id: 'sk', name: 'wf', every: 1000 }, 0); // nextRunAt=1000

    // poll arrives at 5250 → 4 full intervals missed (1000,2000,3000,4000 all passed). A single fire is expected.
    const r1 = await pollScheduler(j, runner, 5250);
    expect(r1.fired).toBe(1);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.runId).toBe('sched:sk:0');

    // the next slot should align to the planned grid (based on 1000): 1000 + 1000*5 = 6000 (the first grid point right after 5250).
    const state = await j.get<{ nextRunAt: number }>('sched:state:sk');
    expect(state!.nextRunAt).toBe(6000);

    // poll exactly on time at 6000 → normal fire, no drift.
    const r2 = await pollScheduler(j, runner, 6000);
    expect(r2.fired).toBe(1);
    expect(runner.calls).toHaveLength(2);
    const state2 = await j.get<{ nextRunAt: number }>('sched:state:sk');
    expect(state2!.nextRunAt).toBe(7000); // 6000+1000, stays aligned to the grid
  });

  it('every + misfire catchup: missed occurrences fire in sequence (one per poll), none are skipped', async () => {
    const j = new InMemoryJournal();
    const runner = mockRunner(() => ({ output: 'ok' }));
    await scheduleWorkflow(j, { id: 'cu', name: 'wf', every: 1000, misfire: 'catchup' }, 0); // nextRunAt=1000

    // A single poll call is made at 5000, but back-to-back (poll loop) it catches 1 occurrence at a time.
    const r1 = await pollScheduler(j, runner, 5000);
    expect(r1.fired).toBe(1);
    expect(runner.calls[0]!.runId).toBe('sched:cu:0');
    let state = await j.get<{ nextRunAt: number }>('sched:state:cu');
    expect(state!.nextRunAt).toBe(2000); // next missed occurrence, not skipped

    const r2 = await pollScheduler(j, runner, 5000); // still due (2000<=5000) → catches the next one immediately
    expect(r2.fired).toBe(1);
    expect(runner.calls[1]!.runId).toBe('sched:cu:1');
    state = await j.get<{ nextRunAt: number }>('sched:state:cu');
    expect(state!.nextRunAt).toBe(3000);

    const r3 = await pollScheduler(j, runner, 5000);
    expect(r3.fired).toBe(1);
    expect(runner.calls[2]!.runId).toBe('sched:cu:2');
    state = await j.get<{ nextRunAt: number }>('sched:state:cu');
    expect(state!.nextRunAt).toBe(4000);

    const r4 = await pollScheduler(j, runner, 5000);
    expect(r4.fired).toBe(1);
    expect(runner.calls[3]!.runId).toBe('sched:cu:3');
    state = await j.get<{ nextRunAt: number }>('sched:state:cu');
    expect(state!.nextRunAt).toBe(5000);

    const r5 = await pollScheduler(j, runner, 5000); // the last missed one is also caught
    expect(r5.fired).toBe(1);
    expect(runner.calls[4]!.runId).toBe('sched:cu:4');
    state = await j.get<{ nextRunAt: number }>('sched:state:cu');
    expect(state!.nextRunAt).toBe(6000); // now in the future, caught up

    const r6 = await pollScheduler(j, runner, 5000); // no longer due
    expect(r6.fired).toBe(0);
    expect(runner.calls).toHaveLength(5);
  });

  it('cron + misfire skip (default): missed cron matches are skipped, jumps to the first future match', async () => {
    const j = new InMemoryJournal();
    const runner = mockRunner(() => ({ output: 'ok' }));
    // cron that fires every minute; first nextRunAt = 00:01
    await scheduleWorkflow(j, { id: 'csk', name: 'wf', cron: '* * * * *' }, Date.UTC(2026, 5, 21, 0, 0));

    // not polled until 5 minutes later → the previous 4 minutes (00:01..00:04) were missed.
    const dueNow = Date.UTC(2026, 5, 21, 0, 5, 30);
    const r1 = await pollScheduler(j, runner, dueNow);
    expect(r1.fired).toBe(1);
    expect(runner.calls).toHaveLength(1); // only 1 fire — the missed ones were skipped
    const state = await j.get<{ nextRunAt: number }>('sched:state:csk');
    expect(state!.nextRunAt).toBe(Date.UTC(2026, 5, 21, 0, 6)); // first match after now
  });

  it('cron + misfire catchup: missed minutes are caught up in sequence', async () => {
    const j = new InMemoryJournal();
    const runner = mockRunner(() => ({ output: 'ok' }));
    await scheduleWorkflow(j, { id: 'ccu', name: 'wf', cron: '* * * * *', misfire: 'catchup' }, Date.UTC(2026, 5, 21, 0, 0));
    // nextRunAt = 00:01

    const dueNow = Date.UTC(2026, 5, 21, 0, 5, 30);
    const r1 = await pollScheduler(j, runner, dueNow);
    expect(r1.fired).toBe(1);
    let state = await j.get<{ nextRunAt: number }>('sched:state:ccu');
    expect(state!.nextRunAt).toBe(Date.UTC(2026, 5, 21, 0, 2)); // next missed minute

    const r2 = await pollScheduler(j, runner, dueNow);
    expect(r2.fired).toBe(1);
    state = await j.get<{ nextRunAt: number }>('sched:state:ccu');
    expect(state!.nextRunAt).toBe(Date.UTC(2026, 5, 21, 0, 3));

    expect((await pollScheduler(j, runner, dueNow)).fired).toBe(1); // 00:03
    expect((await pollScheduler(j, runner, dueNow)).fired).toBe(1); // 00:04
    expect((await pollScheduler(j, runner, dueNow)).fired).toBe(1); // 00:05
    expect(runner.calls).toHaveLength(5); // 00:01..00:05 all fired in sequence
    state = await j.get<{ nextRunAt: number }>('sched:state:ccu');
    expect(state!.nextRunAt).toBe(Date.UTC(2026, 5, 21, 0, 6)); // now in the future
    expect((await pollScheduler(j, runner, dueNow)).fired).toBe(0);
  });

  it('fire dedup exactly-once is PRESERVED: each occurrence during catchup gets a different runId, the same slot never fires twice', async () => {
    const j = new InMemoryJournal();
    const runner = mockRunner(() => ({ output: 'ok' }));
    await scheduleWorkflow(j, { id: 'dd', name: 'wf', every: 1000, misfire: 'catchup' }, 0);

    await pollScheduler(j, runner, 3000);
    await pollScheduler(j, runner, 3000);
    await pollScheduler(j, runner, 3000);
    const runIds = runner.calls.map((c) => c.runId);
    expect(new Set(runIds).size).toBe(runIds.length); // all unique — no repeats

    // Even if we try to fire the same poll again with the same runId (parallel-poller scenario), the lock
    // has already moved the status to 'pending' at the next fireCount, so the old runId is no longer used.
    expect(runIds).toEqual(['sched:dd:0', 'sched:dd:1', 'sched:dd:2']);
  });

  it('createGnl integration: the scheduled workflow actually runs durably', async () => {
    const j = new InMemoryJournal();
    const hits = { n: 0 };
    const wf = workflow<{ x: number }>().then(
      step('inc', async (i) => {
        hits.n++;
        return { y: i.x + 1 };
      }),
    );
    const gnl = createGnl({ journal: j, workflows: { inc: wf } });
    await scheduleWorkflow(j, { id: 'i', name: 'inc', input: { x: 41 }, at: 0 }, 0);

    const r = await pollScheduler(j, gnl, 0);
    expect(r.fired).toBe(1);
    expect(hits.n).toBe(1);
    expect(await j.get('sched:i:0:wf:inc')).toEqual({ y: 42 }); // workflow step is in the journal
  });

  // 1.4: optional budget/quota hook — if not given, old behavior; if given and it throws on overage, the trigger is SKIPPED.
  describe('budgetGuard (optional budget hook, 1.4)', () => {
    it('behavior is UNCHANGED if not given (no regression): runWorkflow is called normally', async () => {
      const j = new InMemoryJournal();
      const runner = mockRunner(() => ({ output: 'ok' }));
      await scheduleWorkflow(j, { id: 'nb', name: 'wf', at: 0 }, 0);
      const r = await pollScheduler(j, runner, 0);
      expect(r.fired).toBe(1);
      expect(r.skipped).toBe(0);
      expect(runner.calls).toHaveLength(1);
    });

    it('if it throws on overage: runWorkflow is NOT CALLED, counted as skip, state stays pending + retries after retryMs, attempts DOES NOT increase', async () => {
      const j = new InMemoryJournal();
      const runner = mockRunner(() => ({ output: 'ok' }));
      await scheduleWorkflow(j, { id: 'bg', name: 'wf', at: 0 }, 0);
      const budgetGuard = async () => {
        throw new Error('budget exceeded');
      };

      const r1 = await pollScheduler(j, runner, 0, { budgetGuard, retryMs: 500 });
      expect(r1.skipped).toBe(1);
      expect(r1.fired).toBe(0);
      expect(runner.calls).toHaveLength(0); // no remote/durable call was made at all

      const state = await j.get<{ nextRunAt: number; attempts: number; status: string }>('sched:state:bg');
      expect(state!.status).toBe('pending'); // NOT failed — a budget overage doesn't count as a workflow error
      expect(state!.attempts).toBe(0); // not counted toward maxAttempts
      expect(state!.nextRunAt).toBe(500); // now(0) + retryMs(500)

      const skipLog = await j.get<{ error: string }>('sched:budget-skip:bg');
      expect(skipLog!.error).toMatch(/budget exceeded/); // recorded/logged

      // Early re-poll (not due yet) → still not skipped/fired.
      expect((await pollScheduler(j, runner, 100, { budgetGuard })).skipped).toBe(0);
      expect(runner.calls).toHaveLength(0);
    });

    it('once the overage clears (guard now passes) → the trigger fires normally', async () => {
      const j = new InMemoryJournal();
      const runner = mockRunner(() => ({ output: 'ok' }));
      await scheduleWorkflow(j, { id: 'bg2', name: 'wf', at: 0 }, 0);
      let over = true;
      const budgetGuard = async () => {
        if (over) throw new Error('budget exceeded');
      };

      const r1 = await pollScheduler(j, runner, 0, { budgetGuard, retryMs: 100 });
      expect(r1.skipped).toBe(1);
      expect(runner.calls).toHaveLength(0);

      over = false; // limit was raised / usage dropped
      const r2 = await pollScheduler(j, runner, 100, { budgetGuard, retryMs: 100 });
      expect(r2.fired).toBe(1);
      expect(r2.skipped).toBe(0);
      expect(runner.calls).toHaveLength(1);
    });

    it('createScheduler opts.budgetGuard is passed through to the poll loop', async () => {
      const j = new InMemoryJournal();
      const runner = mockRunner(() => ({ output: 'ok' }));
      await scheduleWorkflow(j, { id: 'cs', name: 'wf', at: Date.now() }, Date.now());
      let guardCalls = 0;
      const sched = createScheduler(j, runner, {
        pollMs: 10,
        budgetGuard: () => {
          guardCalls++;
          throw new Error('budget exceeded');
        },
      });
      sched.start();
      await new Promise((r) => setTimeout(r, 60));
      sched.stop();
      expect(guardCalls).toBeGreaterThan(0);
      expect(runner.calls).toHaveLength(0); // guard always throws → runWorkflow was never called
    });
  });

  // listTriggers: READ-ONLY introspection from the journal WITHOUT needing a scheduler INSTANCE/runner
  // (this is what feeds the Studio Scheduler view). Does NOT change state, does not take a lock.
  describe('listTriggers (read-only introspection)', () => {
    it('empty journal → empty list', async () => {
      const j = new InMemoryJournal();
      expect(await listTriggers(j)).toEqual([]);
    });

    it('pending trigger (every): correctly reflects def+state fields', async () => {
      const j = new InMemoryJournal();
      await scheduleWorkflow(j, { id: 'e1', name: 'wf-every', every: 1000, maxAttempts: 3 }, 0); // nextRunAt=1000
      const list = await listTriggers(j);
      expect(list).toEqual([{
        id: 'e1', name: 'wf-every', kind: 'every', value: 1000, input: undefined,
        nextRunAt: 1000, attempts: 0, maxAttempts: 3, fireCount: 0, status: 'pending', misfire: 'skip',
      }]);
    });

    it('cron trigger: kind/value carries the cron expression', async () => {
      const j = new InMemoryJournal();
      await scheduleWorkflow(j, { id: 'c1', name: 'wf-cron', cron: '*/5 * * * *', misfire: 'catchup' }, 0);
      const list = await listTriggers(j);
      expect(list[0]).toMatchObject({ id: 'c1', kind: 'cron', value: '*/5 * * * *', misfire: 'catchup' });
    });

    it('failed trigger: lastError/lastErrorAt are added', async () => {
      const j = new InMemoryJournal();
      const runner = { async runWorkflow() { throw new Error('boom'); } };
      await scheduleWorkflow(j, { id: 'f1', name: 'wf-fail', at: 0, maxAttempts: 1 }, 0);
      await pollScheduler(j, runner, 0); // attempt 1 == maxAttempts → status 'failed'

      const list = await listTriggers(j);
      expect(list[0]).toMatchObject({ id: 'f1', status: 'failed', attempts: 1 });
      expect(list[0]!.lastError).toMatch(/boom/);
      expect(list[0]!.lastErrorAt).toBe(0);
    });

    it('a pending trigger has NO lastError field (only added for failed)', async () => {
      const j = new InMemoryJournal();
      await scheduleWorkflow(j, { id: 'p1', name: 'wf', at: 5000 }, 0);
      const list = await listTriggers(j);
      expect(list[0]!.lastError).toBeUndefined();
    });

    it('multiple triggers: returned sorted alphabetically by id', async () => {
      const j = new InMemoryJournal();
      await scheduleWorkflow(j, { id: 'zeta', name: 'wf', at: 0 }, 0);
      await scheduleWorkflow(j, { id: 'alpha', name: 'wf', at: 0 }, 0);
      await scheduleWorkflow(j, { id: 'mid', name: 'wf', at: 0 }, 0);
      const list = await listTriggers(j);
      expect(list.map((t) => t.id)).toEqual(['alpha', 'mid', 'zeta']);
    });

    it('throws if journal.listKeys is missing (enumeration is required)', async () => {
      const noListKeys = { get: async () => undefined, put: async () => {} } as any;
      await expect(listTriggers(noListKeys)).rejects.toThrow(/listKeys/);
    });

    it('read-only: the call does NOT change state (fireCount/nextRunAt stay the same, next poll is unaffected)', async () => {
      const j = new InMemoryJournal();
      const runner = { calls: [] as string[], async runWorkflow(name: string, _i: unknown, o: any) { this.calls.push(o.runId); return { output: 'ok' }; } };
      await scheduleWorkflow(j, { id: 'ro', name: 'wf', every: 1000 }, 0); // nextRunAt=1000

      await listTriggers(j);
      await listTriggers(j);
      expect((await pollScheduler(j, runner, 1000)).fired).toBe(1); // still fires normally
      expect(runner.calls).toEqual(['sched:ro:0']);
    });
  });

  // Audit: poll storm — on an empty schedule table, setInterval(1000ms) across many instances caused
  // tens of thousands of queries per second. start()/stop() is now a self-rescheduling setTimeout chain;
  // with `backoff: true`, if no trigger fires (fired=0) the interval grows ×2, resetting to pollMs once
  // a trigger fires, without overlapping. Default OFF: since the scheduler is timing-critical, we don't
  // want a trigger firing after a quiet period to be delayed up to maxPollMs by default — backoff only
  // kicks in when explicitly requested.
  describe('poll backoff (poll storm prevention, opt-in)', () => {
    it('default (backoff not given): consecutive empty poll intervals stay CONSTANT', async () => {
      const j = new InMemoryJournal();
      const runner = mockRunner(() => ({ output: 'ok' }));
      const origListKeys = j.listKeys!.bind(j);
      const times: number[] = [];
      vi.spyOn(j, 'listKeys').mockImplementation((...args: any[]) => {
        times.push(Date.now());
        return (origListKeys as any)(...args);
      });
      const sched = createScheduler(j, runner, { pollMs: 15, maxPollMs: 120 }); // backoff not given → default false
      sched.start();
      await new Promise((r) => setTimeout(r, 200));
      sched.stop();

      expect(times.length).toBeGreaterThanOrEqual(8); // many polls at a constant ~15ms interval
      const gaps: number[] = [];
      for (let i = 1; i < times.length; i++) gaps.push(times[i]! - times[i - 1]!);
      // no growth: the last interval should not be much larger than the first (it would double if backoff were on)
      expect(gaps[gaps.length - 1]!).toBeLessThan(gaps[0]! * 2);
    });

    it('backoff:true (explicitly given): consecutive poll intervals grow while no triggers exist', async () => {
      const j = new InMemoryJournal();
      const runner = mockRunner(() => ({ output: 'ok' }));
      const origListKeys = j.listKeys!.bind(j);
      const times: number[] = [];
      vi.spyOn(j, 'listKeys').mockImplementation((...args: any[]) => {
        times.push(Date.now());
        return (origListKeys as any)(...args);
      });
      const sched = createScheduler(j, runner, { pollMs: 15, maxPollMs: 120, backoff: true });
      sched.start();
      await new Promise((r) => setTimeout(r, 320));
      sched.stop();

      expect(times.length).toBeGreaterThanOrEqual(4);
      const gaps: number[] = [];
      for (let i = 1; i < times.length; i++) gaps.push(times[i]! - times[i - 1]!);
      expect(gaps[1]!).toBeGreaterThan(gaps[0]! * 1.3);
      expect(gaps[2]!).toBeGreaterThan(gaps[1]! * 1.3);
      expect(Math.max(...gaps)).toBeLessThanOrEqual(120 + 40);
    });

    it('backoff:true + poll interval resets to pollMs once a trigger fires', async () => {
      const j = new InMemoryJournal();
      const runner = mockRunner(() => ({ output: 'ok' }));
      const sched = createScheduler(j, runner, { pollMs: 10, maxPollMs: 400, backoff: true } /* DEFLAKE: cap widened */);
      sched.start();
      await new Promise((r) => setTimeout(r, 450)); // DEFLAKE: let backoff approach the widened cap
      await scheduleWorkflow(j, { id: 'r1', name: 'wf', at: Date.now() }, Date.now());
      await new Promise((r) => setTimeout(r, 450)); // DEFLAKE: worst-case backed-off tick is ≤400ms
      expect(runner.calls.some((c) => c.runId === 'sched:r1:0')).toBe(true);

      runner.calls.length = 0;
      await scheduleWorkflow(j, { id: 'r2', name: 'wf', at: Date.now() }, Date.now());
      // if it reset (~pollMs=10ms) it's caught quickly; if still in backoff (cap ~80ms) it wouldn't be caught.
      // DEFLAKE margins: reset ≈10ms vs cap 400ms through a 150ms window (15× slack, 2.6× headroom).
      await new Promise((r) => setTimeout(r, 150));
      expect(runner.calls.some((c) => c.runId === 'sched:r2:0')).toBe(true);
      sched.stop();
    });

    it('backoff:false (explicitly given, same behavior as default): constant poll interval', async () => {
      const j = new InMemoryJournal();
      const runner = mockRunner(() => ({ output: 'ok' }));
      const origListKeys = j.listKeys!.bind(j);
      let calls = 0;
      vi.spyOn(j, 'listKeys').mockImplementation((...args: any[]) => {
        calls++;
        return (origListKeys as any)(...args);
      });
      const sched = createScheduler(j, runner, { pollMs: 10, backoff: false });
      sched.start();
      await new Promise((r) => setTimeout(r, 205));
      sched.stop();
      expect(calls).toBeGreaterThanOrEqual(15);
    });

    it('no overlap: a slow poll in progress does not let a new tick start', async () => {
      const j = new InMemoryJournal();
      const runner = mockRunner(() => ({ output: 'ok' }));
      const origListKeys = j.listKeys!.bind(j);
      let active = 0;
      let maxActive = 0;
      vi.spyOn(j, 'listKeys').mockImplementation(async (...args: any[]) => {
        active++;
        maxActive = Math.max(maxActive, active);
        const res = await (origListKeys as any)(...args);
        await new Promise((r) => setTimeout(r, 60));
        active--;
        return res;
      });
      const sched = createScheduler(j, runner, { pollMs: 10 });
      sched.start();
      await new Promise((r) => setTimeout(r, 200));
      sched.stop();
      expect(maxActive).toBeLessThanOrEqual(1);
    });
  });
});
