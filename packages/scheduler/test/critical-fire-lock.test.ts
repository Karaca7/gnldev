// The scheduler's fire lock vs. the critical preset's run lock — the collision, and the two rules
// that come out of it.
//
// Live finding (production acceptance run): a `preset: 'critical'` app with an every-5-minutes health
// trigger. The trigger burned all five attempts and landed on `status: 'failed'`. Not one step of the
// workflow ran. Every attempt's error was the same RunBusyError — "workflow run 'sched:saglik-5dk:0' is
// already running — it is locked by another process" — and the lock record left in Postgres afterwards
// read `{"owner":"sched-lui6tf","expires":0}`: released, and owned by the SCHEDULER, never by a
// `critical-wf-*`. Nobody else was running anything.
//
// The other process was this one. `pollScheduler` took a lock on the runId it was about to fire, and
// `runWorkflow` under the critical preset takes a lock on the SAME KEY (`<runId>:lock`, run-lock.ts) —
// so the poller was holding the run out of its own execution. Deterministic, not a race: the "it
// started under heavy load" detail was a coincidence.
//
// Two independent defects, hence two rules and two sets of tests:
//   1. The fire lock must not be the run's lock. It answers a different question ("is another POLLER
//      Firing this occurrence?") and therefore needs a key of its own — `<runId>:fire`, suffixed so it
//      Stays inside the prefix a run purge deletes by.
//   2. A lock-acquisition RunBusyError is not a failed attempt. It means somebody else is running this
//      Exact run — that is a DEFERRAL, and burning retry budget on it turns a busy moment into a dead
//      Trigger. Under rule 1 this case stops being self-inflicted, but it is still reachable for real
//      (a second replica, a manual run of the same runId) and is the difference between "late" and
//      "never fires again".
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, createGnl, acquireRunLock, RunBusyError } from '@gnldev/durable';
import { scheduleWorkflow, pollScheduler, listTriggers, type WorkflowRunner } from '../src/index.js';

const STATE = (id: string) => `sched:state:${id}`;
const FAIL = (id: string) => `sched:fail:${id}`;
interface TriggerState { nextRunAt: number; attempts: number; fireCount: number; status: string }

/**
 * Real wall-clock times, deliberately. The collision only bites when the poller's `now` and the
 * engine's `Date.now()` are the same clock — which they are in production (`pollScheduler`'s default
 * now IS Date.now). With a synthetic `now = 300_000` the scheduler's lock would look expired to the
 * engine (300_000 + ttl is decades in the past) and the takeover would hide the bug completely.
 */
const T0 = Date.now();

describe('critical preset × scheduler fire lock', () => {
  it('a critical workflow on a cron trigger FIRES — it does not lock itself out and exhaust its attempts', async () => {
    const journal = new InMemoryJournal();
    const ran: unknown[] = [];
    const gnl = createGnl({
      journal,
      preset: 'critical',
      workflows: {
        'saglik-5dk': { async run(input: unknown) { ran.push(input); return { ok: true }; }, build: () => [] } as any,
      },
    });

    await scheduleWorkflow(journal, { id: 'saglik-5dk', name: 'saglik-5dk', every: 300_000, input: { probe: 1 } }, T0);
    const out = await pollScheduler(journal, gnl as unknown as WorkflowRunner, T0 + 300_000);

    expect(ran).toEqual([{ probe: 1 }]); // the live symptom was `[]` — not one step ran
    expect(out).toMatchObject({ fired: 1, failed: 0, skipped: 0 });
    const st = await journal.get<TriggerState>(STATE('saglik-5dk'));
    expect(st?.status).toBe('pending');
    expect(st?.attempts).toBe(0);
    expect(st?.fireCount).toBe(1);
  });

  it('and it keeps firing — five polls, five runs, no attempt is ever consumed', async () => {
    // The live trigger died on the FIFTH attempt (maxAttempts default), so five is the number that
    // reproduces the whole arc rather than just its first step.
    const journal = new InMemoryJournal();
    let runs = 0;
    const gnl = createGnl({
      journal,
      preset: 'critical',
      workflows: { w: { async run() { runs++; return 1; }, build: () => [] } as any },
    });
    await scheduleWorkflow(journal, { id: 'saglik-5dk', name: 'w', every: 300_000 }, T0);
    for (let i = 1; i <= 5; i++) await pollScheduler(journal, gnl as unknown as WorkflowRunner, T0 + i * 300_000);

    expect(runs).toBe(5);
    const st = await journal.get<TriggerState>(STATE('saglik-5dk'));
    expect(st).toMatchObject({ status: 'pending', attempts: 0, fireCount: 5 });
    expect(await journal.get(FAIL('saglik-5dk'))).toBeUndefined(); // nothing was ever recorded as a failure
  });

  it('a GENUINE concurrent runner still gets the 409 — the fire lock did not stop being exclusive', async () => {
    // Rule 1 must not be read as "drop the lock". Two pollers, one slow workflow: exactly one fires,
    // the other records a skip.
    const journal = new InMemoryJournal();
    let starts = 0;
    const runner: WorkflowRunner = {
      async runWorkflow(_n, _i, o) {
        starts++;
        await new Promise((r) => setTimeout(r, 40));
        return { runId: o?.runId ?? 'x' };
      },
    };
    await scheduleWorkflow(journal, { id: 't', name: 'w', every: 300_000 }, T0);
    const [a, b] = await Promise.all([
      pollScheduler(journal, runner, T0 + 300_000, { owner: 'poller-a' }),
      pollScheduler(journal, runner, T0 + 300_000, { owner: 'poller-b' }),
    ]);
    expect(starts).toBe(1);
    expect(a.fired + b.fired).toBe(1);
    expect(a.skipped + b.skipped).toBe(1);
  });

  it('the fire lock is a SEPARATE key but still under the run prefix — two locks, one purge', async () => {
    // Both halves of the design in one assertion. Separate, or the run refuses its own caller (the
    // whole bug). Under `<runId>:`, or a sibling namespace accumulates one orphan record per fire
    // that no `purgeRun`/`sweepRuns` prefix delete ever reaches — a five-minute trigger fires ~105k
    // times a year.
    const journal = new InMemoryJournal();
    const gnl = createGnl({
      journal,
      preset: 'critical',
      workflows: { w: { async run() { return 1; }, build: () => [] } as any },
    });
    await scheduleWorkflow(journal, { id: 't', name: 'w', every: 300_000 }, T0);
    await pollScheduler(journal, gnl as unknown as WorkflowRunner, T0 + 300_000);

    const keys = await journal.listKeys!('sched:t:0:');
    expect(keys).toContain('sched:t:0:fire:lock'); // the poller's
    expect(keys).toContain('sched:t:0:lock'); // the run's — and they are not the same key
  });

  it('a real foreign holder of the run lock also fires the run-busy refusal — and THAT is a deferral, not an attempt', async () => {
    // Rule 2, with the collision removed: somebody outside this scheduler holds `<runId>:lock` (a
    // second replica mid-run, an operator's manual run of the same id). The critical preset refuses,
    // and the trigger must WAIT rather than spend a retry.
    const journal = new InMemoryJournal();
    let runs = 0;
    const gnl = createGnl({
      journal,
      preset: 'critical',
      workflows: { w: { async run() { runs++; return 1; }, build: () => [] } as any },
    });
    await scheduleWorkflow(journal, { id: 't', name: 'w', every: 300_000 }, T0);
    const foreign = await acquireRunLock(journal, 'sched:t:0', 'another-replica', 600_000);
    expect(foreign).not.toBeNull();

    const busy = await pollScheduler(journal, gnl as unknown as WorkflowRunner, T0 + 300_000, { retryMs: 30_000 });
    expect(runs).toBe(0);
    expect(busy).toMatchObject({ fired: 0, failed: 0, rescheduled: 0, skipped: 1 });
    const st = await journal.get<TriggerState>(STATE('t'));
    expect(st?.attempts).toBe(0); // the retry budget is untouched
    expect(st?.status).toBe('pending');
    expect(st?.nextRunAt).toBe(T0 + 300_000 + 30_000); // deferred by retryMs
    expect(await journal.get(FAIL('t'))).toBeUndefined(); // "somebody else is running it" is not a failure

    // The deferral is COUNTED where an operator looks. A trigger stuck deferring reads 'pending'
    // with a near-future nextRunAt — identical to a healthy one — so without this the failure mode is
    // "the health check has not run in a week and the dashboard is green".
    const [info] = await listTriggers(journal);
    expect(info).toMatchObject({ id: 't', status: 'pending', fireCount: 0, deferrals: 1 });
    expect(info!.lastError).toBeUndefined();

    // …and once the other holder is done, the very next poll fires normally.
    await foreign!.release();
    const ok = await pollScheduler(journal, gnl as unknown as WorkflowRunner, T0 + 300_000 + 30_000);
    expect(runs).toBe(1);
    expect(ok.fired).toBe(1);
  });

  it('a run-busy deferral never becomes the recorded lastError — the real failure survives it', async () => {
    // The live trigger's `sched:fail:` said "already running", which told an operator nothing about
    // why the workflow could not run. A deferral must not overwrite (or pre-empt) the genuine error.
    const journal = new InMemoryJournal();
    let mode: 'boom' | 'busy' = 'boom';
    const runner: WorkflowRunner = {
      async runWorkflow() {
        if (mode === 'busy') {
          throw Object.assign(new RunBusyError("workflow run 'sched:t:0' is already running — it is locked by another process"), { atLockAcquisition: true });
        }
        throw new Error('NIM 404: model retired');
      },
    };
    await scheduleWorkflow(journal, { id: 't', name: 'w', every: 300_000, maxAttempts: 2 }, T0);

    let now = T0 + 300_000;
    await pollScheduler(journal, runner, now); // real error → attempts 1
    expect((await journal.get<TriggerState>(STATE('t')))?.attempts).toBe(1);

    mode = 'busy';
    now = (await journal.get<TriggerState>(STATE('t')))!.nextRunAt;
    const deferred = await pollScheduler(journal, runner, now);
    expect(deferred.skipped).toBe(1);
    expect((await journal.get<TriggerState>(STATE('t')))?.attempts).toBe(1); // NOT 2 — the budget is intact
    expect((await journal.get<TriggerState>(STATE('t')))?.status).toBe('pending');

    mode = 'boom';
    now = (await journal.get<TriggerState>(STATE('t')))!.nextRunAt;
    const dead = await pollScheduler(journal, runner, now);
    expect(dead.failed).toBe(1);
    const fail = await journal.get<{ error: string }>(FAIL('t'));
    expect(fail?.error).toContain('NIM 404'); // the diagnosis an operator needs
    expect(fail?.error).not.toContain('already running');
  });
});
