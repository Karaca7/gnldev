// The worker's lease is not the run's lock — the queue's half of a defect first measured in
// @gnldev/scheduler.
//
// There, `pollScheduler` locked the runId it was about to fire and then called `runWorkflow` with it;
// Under `preset: 'critical'` the run takes a lock on the SAME key (`<runId>:lock`, run-lock.ts) and
// refused its own caller. Five polls, five RunBusyErrors, `status: 'failed'`, not one step executed.
//
// This package had the identical shape. `createWorker` locks `job:<id>` and then hands that exact
// string to the handler as `ctx.runId` — and the README's own example is
// `runDurable({ runId: ctx.runId, … })`. The moment that inner call takes a lock of its own (a
// `lock` option, or a critical-preset `runWorkflow`), the handler is refused by the worker that
// called it. Not a race: it cannot work at all, and the job dead-letters at maxAttempts having never
// run once.
//
// The lease answers "which WORKER owns this job"; the run lock answers "is this RUN executing". Two
// questions, two keys, and they nest rather than compete.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, createGnl, acquireRunLock } from '@gnldev/durable';
import { createWorker, enqueue } from '../src/index.js';

describe('worker lease × run lock', () => {
  it("a handler may take a run lock on its OWN ctx.runId — the documented usage the worker used to refuse", async () => {
    const storage = new InMemoryStorage();
    let ran = 0;
    const gnl = createGnl({
      journal: storage.runs,
      preset: 'critical',
      workflows: { w: { async run() { ran++; return 1; }, build: () => [] } as any },
    });
    const worker = createWorker(storage, {
      t: async (_p: unknown, ctx: { runId: string }) => {
        await gnl.runWorkflow('w', {}, { runId: ctx.runId });
      },
    });
    const id = await enqueue(storage.work!, 't', {});
    await worker.runOnce();

    expect(ran).toBe(1); // was 0: RunBusyError, atLockAcquisition, from the worker's own lease
    expect(await storage.work!.get(`qdone:${id}`)).toBeTruthy();
    expect(await storage.work!.get(`qfail:${id}`)).toBeUndefined();
  });

  it('the lease is a separate key, and still under the run prefix so one purge reaches both', async () => {
    const storage = new InMemoryStorage();
    const worker = createWorker(storage, { t: async () => {} });
    await enqueue(storage.work!, 't', {}, { id: 'j' });
    await worker.runOnce();
    // Under `job:j:` rather than a namespace of its own: that prefix is what purgeRun/sweepRuns
    // delete by, and an orphan lock record per job is a leak that grows with throughput.
    expect(await storage.runs.get('job:j:lease:lock')).toBeTruthy();
    expect(await storage.runs.get('job:j:lock')).toBeUndefined(); // the RUN's key, untouched by the worker
  });

  it('two workers still cannot run one job at once — the lease did not stop being exclusive', async () => {
    const storage = new InMemoryStorage();
    let starts = 0;
    const handlers = {
      t: async () => {
        starts++;
        await new Promise((r) => setTimeout(r, 40));
      },
    };
    await enqueue(storage.work!, 't', {}, { id: 'j' });
    const a = createWorker(storage, handlers, { owner: 'w-a', heartbeat: false });
    const b = createWorker(storage, handlers, { owner: 'w-b', heartbeat: false });
    await Promise.all([a.runOnce(), b.runOnce()]);
    expect(starts).toBe(1);
  });

  it('a foreign holder of the LEASE still blocks the job; a foreign holder of the RUN key does not', async () => {
    // The two keys now mean different things, so they must have different effects. A rival worker
    // (lease) means "not mine to run"; a busy run (run key) is the inner call's problem to report,
    // not a reason for the worker to skip the job silently.
    const storage = new InMemoryStorage();
    let ran = 0;
    const worker = createWorker(storage, { t: async () => { ran++; } }, { heartbeat: false });
    await enqueue(storage.work!, 't', {}, { id: 'j' });

    const lease = await acquireRunLock(storage.runs, 'job:j:lease', 'rival-worker', 60_000);
    await worker.runOnce();
    expect(ran).toBe(0); // the rival worker owns this job

    await lease!.release();
    await acquireRunLock(storage.runs, 'job:j', 'somebody-elses-run', 60_000);
    await worker.runOnce();
    expect(ran).toBe(1); // the run key is not the worker's business
  });
});
