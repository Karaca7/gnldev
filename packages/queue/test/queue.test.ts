// Phase 12 — @gnl/queue: durable job. crash mid-job → worker reclaim → side-effect exactly-once;
// two workers, one job; drain.
import { describe, it, expect, vi } from 'vitest';
import { InMemoryStorage, runDurable } from '@gnl/durable';
import { enqueue, createWorker, listJobs, retryJob, QueueDepthExceededError, type JobHandler } from '../src/index.js';

function mockModel(crash: { active: boolean }): any {
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'm',
    supportedUrls: {},
    doGenerate: async ({ prompt }: any) => {
      const done = (prompt ?? []).filter((m: any) => m.role === 'tool').length;
      const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
      if (done === 0) return { content: [{ type: 'tool-call', toolCallId: 'call-charge', toolName: 'charge', input: '{}' }], finishReason: 'tool-calls', usage, warnings: [] };
      if (crash.active && done === 1) throw new Error('CRASH');
      return { content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage, warnings: [] };
    },
    doStream: async () => {
      throw new Error('no stream');
    },
  };
}

describe('@gnl/queue', () => {
  it('crash mid-job → reclaim → side-effect exactly-once (job = durable run)', async () => {
    const storage = new InMemoryStorage();
    const charges = { n: 0 };
    const crash = { active: true };
    const handler: JobHandler = async (payload, { journal: j, runId }) => {
      await runDurable({
        runId, journal: j, model: mockModel(crash),
        tools: { charge: { execute: async () => ({ charged: (charges.n++, payload.amount) }) } },
        prompt: 'do it',
      });
    };
    const worker = createWorker(storage, { refund: handler }, { ttlMs: 50 });
    await enqueue(storage.work, 'refund', { amount: 20 }, { id: 'job-1' });

    // Attempt 1: the charge happens, then the model crashes → runDurable throws → the worker swallows it (pending for retry).
    expect(await worker.runOnce()).toBe(true);
    expect(charges.n).toBe(1);
    expect((await listJobs(storage.work))[0]!.status).toBe('pending');

    // Attempt 2 (crash off): runDurable resumes from RunJournal → the charge is NOT REPEATED.
    crash.active = false;
    expect(await worker.runOnce()).toBe(true);
    expect(charges.n).toBe(1); // exactly-once: only one charge despite the crash + reclaim
    expect((await listJobs(storage.work))[0]!.status).toBe('done');
  });

  it('two workers, one job → the job runs only once (lock)', async () => {
    const storage = new InMemoryStorage();
    const runs = { n: 0 };
    const handler: JobHandler = async () => {
      runs.n++;
      await new Promise((r) => setTimeout(r, 10));
    };
    const w1 = createWorker(storage, { t: handler }, { owner: 'w1', ttlMs: 5000 });
    const w2 = createWorker(storage, { t: handler }, { owner: 'w2', ttlMs: 5000 });
    await enqueue(storage.work, 't', {}, { id: 'j' });

    await Promise.all([w1.runOnce(), w2.runOnce()]);
    expect(runs.n).toBe(1); // only one worker took the job
    expect((await listJobs(storage.work))[0]!.status).toBe('done');
  });

  it('drain: processes all pending jobs', async () => {
    const storage = new InMemoryStorage();
    const seen: string[] = [];
    const worker = createWorker(storage, { t: async (p: any) => void seen.push(p.tag) });
    await enqueue(storage.work, 't', { tag: 'a' }, { id: 'a' });
    await enqueue(storage.work, 't', { tag: 'b' }, { id: 'b' });
    const n = await worker.drain();
    expect(n).toBe(2);
    expect(seen.sort()).toEqual(['a', 'b']);
  });

  // Phase 5.1 — cursor-based drain: no starvation with 50+ jobs (WorkStore.list's default page was
  // 50; previously anything past the first page was never seen) + cursor advances + exactly-once preserved.
  it('50+ jobs: drain processes all of them (no starvation) + cursor advances + exactly-once', async () => {
    const storage = new InMemoryStorage();
    const N = 60; // a number of jobs that exceeds the default page size (50)
    const seen: Record<string, number> = {};
    const worker = createWorker(storage, {
      t: async (p: any) => { seen[p.tag] = (seen[p.tag] ?? 0) + 1; },
    });
    for (let i = 0; i < N; i++) {
      await enqueue(storage.work, 't', { tag: `job-${i}` }, { id: `job-${i}` });
    }

    const n = await worker.drain();
    expect(n).toBe(N); // all processed — job-50..job-59 (past page 1) were not skipped

    for (let i = 0; i < N; i++) {
      expect(seen[`job-${i}`]).toBe(1); // each job EXACTLY ONCE (exactly-once)
    }
    const statuses = await listJobs(storage.work);
    expect(statuses.length).toBe(N);
    expect(statuses.every((s) => s.status === 'done')).toBe(true);

    // The cursor must have advanced permanently past the first (fully terminal) page.
    const cursor = await storage.work.get('qcursor');
    expect(cursor).toBeDefined();
  });

  it('the cursor does not skip a job awaiting retry; moves to the next job once it goes terminal', async () => {
    const storage = new InMemoryStorage();
    let failOnce = true;
    const order: string[] = [];
    const worker = createWorker(storage, {
      t: async (p: any) => {
        if (p.tag === 'flaky' && failOnce) { failOnce = false; throw new Error('boom'); }
        order.push(p.tag);
      },
    }, { maxAttempts: 5 });
    await enqueue(storage.work, 't', { tag: 'flaky' }, { id: 'j1' });
    await enqueue(storage.work, 't', { tag: 'second' }, { id: 'j2' });

    expect(await worker.runOnce()).toBe(true); // j1 is attempted, fails → still pending (awaiting retry)
    expect((await listJobs(storage.work)).find((j) => j.id === 'j1')!.status).toBe('pending');
    expect(order).toEqual([]); // did not move on to j2 — order preserved

    expect(await worker.runOnce()).toBe(true); // j1 is attempted again, succeeds this time
    expect(order).toEqual(['flaky']);

    expect(await worker.runOnce()).toBe(true); // j1 is now terminal → next up, j2 is processed
    expect(order).toEqual(['flaky', 'second']);
  });

  // Y2 — heartbeat: on a long handler, the lock TTL expiring and letting a second worker take over
  // (the "job double-runs" bug) is prevented by the heartbeat renewing every ttlMs/3.
  // DETERMINISM: fake timers, same reasoning as the transient-renew test below — on the wall clock
  // each heartbeat tick has only ~ttlMs*2/3 (~34ms) of slack, and a longer event-loop stall under
  // full-suite load lets the lease REALLY expire (a legitimate takeover, not a lock defect).
  it('Y2: short ttl + long handler → heartbeat keeps the lock alive, the second worker cannot take over, the job runs ONCE', async () => {
    vi.useFakeTimers();
    try {
      const storage = new InMemoryStorage();
      const runs = { n: 0 };
      const handler: JobHandler = async () => {
        runs.n++;
        await new Promise((r) => setTimeout(r, 150)); // much longer than ttlMs (50)
      };
      // heartbeat option not given → default ON.
      const w1 = createWorker(storage, { t: handler }, { owner: 'w1', ttlMs: 50 });
      const w2 = createWorker(storage, { t: handler }, { owner: 'w2', ttlMs: 50 });
      await enqueue(storage.work, 't', {}, { id: 'j' });

      // w1 takes the job and runs the handler (150ms), while w2 keeps retrying like a poll.
      const w1p = w1.runOnce();
      await vi.advanceTimersByTimeAsync(0); // let w1 claim the lock and enter the handler
      const pokes: Promise<boolean>[] = [];
      for (let i = 0; i < 4; i++) { // pokes at t=30/60/90/120 — all while the handler is running
        await vi.advanceTimersByTimeAsync(30);
        const rec = await (storage.runs as any).get('job:j:lock'); // explicit lease check
        expect(rec.owner).toBe('w1');
        expect(rec.expires).toBeGreaterThan(Date.now()); // the heartbeat keeps extending it
        pokes.push(w2.runOnce());
      }
      await vi.advanceTimersByTimeAsync(200);
      await Promise.all([w1p, ...pokes]);

      expect(runs.n).toBe(1); // heartbeat kept extending the TTL → w2 never took over
      expect((await listJobs(storage.work))[0]!.status).toBe('done');
    } finally {
      vi.useRealTimers();
    }
  });

  // Review finding: if renew() THROWS (a transient network/journal hiccup — NOT a token mismatch),
  // `lockLost` used to be flipped to true by mistake → qdone never gets written even if the handler
  // finishes successfully, AND release() genuinely frees the lock (the token still matches) → a
  // second worker could RE-RUN the job. Fix: only renew returning FALSE (a real token mismatch)
  // makes lockLost true; a throw is just logged, and the next tick retries.
  // DETERMINISM (flake fix): this test runs on FAKE TIMERS. The earlier real-time version measured
  // the race on the WALL CLOCK: after the first renew THROWS, the lock (ttlMs=50, acquired at t=0)
  // is only extended by the NEXT heartbeat tick at ttlMs/3*2 = ~32ms — a margin of ~18ms. Under
  // full-suite load (288 files, parallel workers) the event loop stalls longer than that, so the
  // tick lands after t=50, the lock GENUINELY expires and the second worker CORRECTLY takes over
  // (queue job runs are at-least-once; exactly-once applies to the EFFECTS via the RunJournal) →
  // `runs.n` became 2 intermittently. That was a test-timing artifact, not a lock/fencing defect.
  // With fake timers every heartbeat tick, handler sleep and poke happens at an exact VIRTUAL
  // time, so the lease is provably still alive at each poke regardless of machine load.
  it('Y2: renew throws on the first call (transient error), succeeds afterwards → job runs ONCE, qdone is written, the second worker cannot take over', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const storage = new InMemoryStorage();
      const runs = { n: 0 };
      const handler: JobHandler = async () => {
        runs.n++;
        await new Promise((r) => setTimeout(r, 150)); // much longer than ttlMs (50) → several renew ticks happen
      };
      let putIfMatchCalls = 0;
      const origPutIfMatch = (storage.runs as any).putIfMatch.bind(storage.runs);
      vi.spyOn(storage.runs as any, 'putIfMatch').mockImplementation(async (...args: any[]) => {
        putIfMatchCalls++;
        if (putIfMatchCalls === 1) throw new Error('transient network error'); // only the FIRST renew throws
        return origPutIfMatch(...args);
      });
      const w1 = createWorker(storage, { t: handler }, { owner: 'w1', ttlMs: 50 });
      const w2 = createWorker(storage, { t: handler }, { owner: 'w2', ttlMs: 50 });
      await enqueue(storage.work, 't', {}, { id: 'j' });

      const w1p = w1.runOnce();
      await vi.advanceTimersByTimeAsync(0); // let w1 claim the lock and enter the handler
      const lockKey = 'job:j:lock';
      const pokes: Promise<boolean>[] = [];
      // 4 pokes at t=30/60/90/120 — all WHILE the 150ms handler is still running.
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(30); // virtual time: the heartbeat ticks (every 16ms) run in order
        // EXPLICIT LEASE CHECK: the lock must still be LIVE and OURS at every poke — this is what
        // the test is really about (the single transient renew error must not orphan the lease).
        const rec = await (storage.runs as any).get(lockKey);
        expect(rec.owner).toBe('w1');
        expect(rec.expires).toBeGreaterThan(Date.now());
        pokes.push(w2.runOnce()); // w2 sees a live lock → acquireRunLock returns null → no takeover
      }
      await vi.advanceTimersByTimeAsync(200); // let the 150ms handler finish + the terminal write land
      await Promise.all([w1p, ...pokes]);
      expect(await w2.runOnce()).toBe(false); // job is terminal (qdone) → nothing left for w2 to claim

      expect(putIfMatchCalls).toBeGreaterThan(1); // the first renew threw, later ones went through
      expect(runs.n).toBe(1); // despite the transient renew error, the job ran only ONCE (w2 did not take over)
      expect((await listJobs(storage.work))[0]!.status).toBe('done'); // qdone was written (lockLost was not flipped to true by mistake)
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  // The FLAKE'S OTHER HALF, pinned deterministically: if renew ticks are actually MISSED long
  // enough for the lease to expire on the clock (transient renew errors + a stalled event loop —
  // exactly what happened under full-suite load), a takeover is LEGITIMATE and the job body runs
  // again (queue runs are at-least-once; exactly-once applies to the EFFECTS of a durable handler).
  // What must NEVER break in that window is RESULT INTEGRITY: the takeover is a single atomic CAS
  // (no split-brain), and the stale worker can neither write the result nor release the new owner's
  // lock. `maxRenewFailures: 10` isolates the TTL-expiry path (lockLost is not assumed from the
  // consecutive-throw heuristic here).
  it('lease REALLY expires (missed renews) → takeover is atomic, the job re-runs, but the stale worker writes NOTHING', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const storage = new InMemoryStorage();
      const runs: string[] = [];
      const handler: JobHandler = async () => {
        runs.push('start');
        await new Promise((r) => setTimeout(r, 150));
      };
      let renewBroken = true; // while true, every renew CAS throws → the lock is never extended
      const origPutIfMatch = (storage.runs as any).putIfMatch.bind(storage.runs);
      vi.spyOn(storage.runs as any, 'putIfMatch').mockImplementation(async (...args: any[]) => {
        if (renewBroken) throw new Error('transient network error');
        return origPutIfMatch(...args);
      });
      const qdoneWrites: unknown[] = [];
      const origPut = storage.work.put.bind(storage.work);
      vi.spyOn(storage.work, 'put').mockImplementation(async (k: string, v: unknown) => {
        if (k === 'qdone:j') qdoneWrites.push(v);
        return origPut(k, v);
      });
      const w1 = createWorker(storage, { t: handler }, { owner: 'w1', ttlMs: 50, maxRenewFailures: 10 });
      const w2 = createWorker(storage, { t: handler }, { owner: 'w2', ttlMs: 50, maxRenewFailures: 10 });
      await enqueue(storage.work, 't', {}, { id: 'j' });

      const w1p = w1.runOnce();
      await vi.advanceTimersByTimeAsync(0); // w1 holds the lock until t=50; its renews (t=16/32/48) all throw
      await vi.advanceTimersByTimeAsync(55); // virtual clock passes the lease end — the lock is now genuinely stale
      const stale = await (storage.runs as any).get('job:j:lock');
      expect(stale.owner).toBe('w1');
      expect(stale.expires).toBeLessThan(Date.now()); // proof: EXPIRED, not "stolen"
      renewBroken = false;
      const w2p = w2.runOnce(); // takes over the expired lock via CAS (acquireRunLock putIfMatch)
      await vi.advanceTimersByTimeAsync(250); // both handlers finish (w1 at t=150, w2 at t=205)
      await Promise.all([w1p, w2p]);

      expect(runs.length).toBe(2); // at-least-once: the takeover legitimately re-ran the body
      const owner = await (storage.runs as any).get('job:j:lock');
      expect(owner.owner).toBe('w2'); // w1's release() was a no-op (token fencing) — it never freed w2's lock
      expect(qdoneWrites.length).toBe(1); // ONE result: the stale w1 was blocked (lockLost + qown CAS)
      expect(await storage.work.get('qatt:j')).toBeUndefined(); // and it corrupted no attempt counter either
      expect((await listJobs(storage.work))[0]!.status).toBe('done');
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  // Phase 8 (review leftover): if renew throws `maxRenewFailures` (default 3) times IN A ROW,
  // lockLost=true is now assumed (the transient error has become persistent — the lock has likely
  // expired via TTL, the worker can't be certain: best approximation until WorkStore fencing). The
  // single-hiccup test above (throws once, then succeeds) keeps passing UNCHANGED — this is a separate test.
  it('renew THROWING 3 times in a row makes lockLost=true assumed → qdone is not written (job stays pending)', async () => {
    const storage = new InMemoryStorage();
    const runs = { n: 0 };
    const handler: JobHandler = async () => {
      runs.n++;
      await new Promise((r) => setTimeout(r, 200)); // much longer than ttlMs (30) → many renew ticks
    };
    let putIfMatchCalls = 0;
    vi.spyOn(storage.runs as any, 'putIfMatch').mockImplementation(async () => {
      putIfMatchCalls++;
      throw new Error('persistent network error'); // EVERY renew throws
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const worker = createWorker(storage, { t: handler }, { owner: 'w1', ttlMs: 30 });
    await enqueue(storage.work, 't', {}, { id: 'j' });

    await worker.runOnce();

    expect(putIfMatchCalls).toBeGreaterThanOrEqual(3); // at least 3 consecutive throws happened
    expect(runs.n).toBe(1); // the handler still ran once
    expect((await listJobs(storage.work))[0]!.status).toBe('pending'); // lockLost → qdone was NOT WRITTEN
    warn.mockRestore();
  });

  it('renew fails twice in a row + a success in between resets the counter → lockLost is not triggered', async () => {
    const storage = new InMemoryStorage();
    const runs = { n: 0 };
    const handler: JobHandler = async () => {
      runs.n++;
      await new Promise((r) => setTimeout(r, 200));
    };
    let calls = 0;
    const origPutIfMatch = (storage.runs as any).putIfMatch.bind(storage.runs);
    vi.spyOn(storage.runs as any, 'putIfMatch').mockImplementation(async (...args: any[]) => {
      calls++;
      // Pattern: throw, throw, SUCCESS (counter resets), throw, throw, ... — never 3 IN A ROW.
      if (calls % 3 === 0) return origPutIfMatch(...args);
      throw new Error('intermittent transient error');
    });
    const worker = createWorker(storage, { t: handler }, { owner: 'w1', ttlMs: 30 });
    await enqueue(storage.work, 't', {}, { id: 'j' });

    await worker.runOnce();

    expect(calls).toBeGreaterThanOrEqual(3);
    expect(runs.n).toBe(1);
    expect((await listJobs(storage.work))[0]!.status).toBe('done'); // never reached 3 in a row → no lockLost, qdone was written
  });

  describe('backpressure: enqueue maxDepth (opt-in)', () => {
    it('if maxDepth is not given (default) the queue grows unbounded — current behavior', async () => {
      const storage = new InMemoryStorage();
      for (let i = 0; i < 5; i++) await enqueue(storage.work, 't', { i }, { id: `j${i}` });
      expect((await listJobs(storage.work)).length).toBe(5);
    });

    it('enqueue passes freely while depth is below maxDepth', async () => {
      const storage = new InMemoryStorage();
      await enqueue(storage.work, 't', {}, { id: 'a' });
      await enqueue(storage.work, 't', {}, { id: 'b' });
      // depth 2, maxDepth 3 → free.
      await expect(enqueue(storage.work, 't', {}, { id: 'c', maxDepth: 3 })).resolves.toBe('c');
      expect((await listJobs(storage.work)).length).toBe(3);
    });

    it('enqueue throws QueueDepthExceededError with an English message once depth reaches maxDepth', async () => {
      const storage = new InMemoryStorage();
      await enqueue(storage.work, 't', {}, { id: 'a' });
      await enqueue(storage.work, 't', {}, { id: 'b' });
      // depth already 2, maxDepth 2 → exceeded (>=).
      await expect(enqueue(storage.work, 't', {}, { id: 'c', maxDepth: 2 })).rejects.toThrow(QueueDepthExceededError);
      await expect(enqueue(storage.work, 't', {}, { id: 'c', maxDepth: 2 })).rejects.toThrow(/queue depth limit exceeded/);
      expect((await listJobs(storage.work)).length).toBe(2); // 'c' was not added
    });
  });

  it('Y2: heartbeat:false → old behavior (documented risk): on a long handler the TTL expires, the second worker can take over', async () => {
    const storage = new InMemoryStorage();
    const runs = { n: 0 };
    const handler: JobHandler = async () => {
      runs.n++;
      await new Promise((r) => setTimeout(r, 150));
    };
    const w1 = createWorker(storage, { t: handler }, { owner: 'w1', ttlMs: 20, heartbeat: false });
    const w2 = createWorker(storage, { t: handler }, { owner: 'w2', ttlMs: 20, heartbeat: false });
    await enqueue(storage.work, 't', {}, { id: 'j' });

    const w1p = w1.runOnce();
    const pokes: Promise<boolean>[] = [];
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 20));
      pokes.push(w2.runOnce());
    }
    await Promise.all([w1p, ...pokes]);

    // heartbeat off → renew is never called, the TTL (20ms) expires mid-way through the 150ms handler →
    // w2 can take over the stale lock and run the handler ONE MORE TIME (the actual bug, documented).
    expect(runs.n).toBeGreaterThanOrEqual(2);
  });

  // 8.2 — WorkStore fencing: the qown CAS blocks a stale worker's TERMINAL WRITE (qdone/qfail/qatt).
  // NOTE: this does NOT prevent the double-RUN itself (that's heartbeat/Y2's job) — if a real takeover
  // happens during the heartbeat-tick window (before lockLost is set), it blocks the stale worker from
  // overwriting the winner's RESULT and making it inconsistent, via the in-engine CAS. Here we isolate
  // that this is INDEPENDENT of lockLost.
  it('8.2: the qown CAS blocks a stale worker\'s terminal write WITHOUT lockLost (in-engine fencing)', async () => {
    const storage = new InMemoryStorage();
    const ran = { n: 0 };
    // qown gets overwritten with a different token IN THE MIDDLE of the handler = a simulation of a
    // second worker taking over with a new acquireRunLock token. heartbeat:false → lockLost is NEVER
    // set → the ONLY mechanism blocking the terminal write is the qown CAS (the window 8.2 closes).
    const handler: JobHandler = async () => {
      ran.n++;
      await storage.work.put('qown:job-x', 'taking-over-worker-token');
    };
    const worker = createWorker(storage, { t: handler }, { ttlMs: 5000, heartbeat: false });
    await enqueue(storage.work, 't', {}, { id: 'job-x' });

    expect(await worker.runOnce()).toBe(true);
    expect(ran.n).toBe(1); // the handler ran
    // qown was taken over → stillOwns() putIfMatch(qown, myToken, myToken) is FALSE → qdone was NOT WRITTEN.
    expect(await storage.work.get('qdone:job-x')).toBeUndefined();
    expect((await listJobs(storage.work))[0]!.status).toBe('pending'); // the worker that took over will write its own result
  });

  // Audit: poll storm — with an empty queue, setInterval(200ms) across 1000 workers led to tens of
  // thousands of queries per second. start()/stop() now use a self-rescheduling setTimeout chain; on an
  // empty poll the interval grows ×2 (backoff default ON), resets to pollMs once a job is claimed, and never overlaps.
  describe('poll backoff (poll storm prevention)', () => {
    it('on an empty queue, consecutive poll intervals grow', async () => {
      const storage = new InMemoryStorage();
      const origList = storage.work.list.bind(storage.work);
      const times: number[] = [];
      vi.spyOn(storage.work, 'list').mockImplementation((...args: any[]) => {
        times.push(Date.now());
        return (origList as any)(...args);
      });
      const worker = createWorker(storage, {}, { pollMs: 15, maxPollMs: 120 });
      worker.start();
      await new Promise((r) => setTimeout(r, 320));
      worker.stop();

      expect(times.length).toBeGreaterThanOrEqual(4); // a few ticks must have happened
      const gaps: number[] = [];
      for (let i = 1; i < times.length; i++) gaps.push(times[i]! - times[i - 1]!);
      expect(gaps[1]!).toBeGreaterThan(gaps[0]! * 1.3); // ×2 growth (loose comparison to allow for jitter)
      expect(gaps[2]!).toBeGreaterThan(gaps[1]! * 1.3);
      expect(Math.max(...gaps)).toBeLessThanOrEqual(120 + 40); // the cap (maxPollMs) is not exceeded
    });

    it('the poll interval resets to pollMs once a job is claimed', async () => {
      const storage = new InMemoryStorage();
      const seen: string[] = [];
      const worker = createWorker(
        storage,
        { t: async (p: any) => void seen.push(p.tag) },
        { pollMs: 10, maxPollMs: 400 }, // DEFLAKE: cap widened (see the reset test's window comment)
      );
      worker.start();
      await new Promise((r) => setTimeout(r, 450)); // DEFLAKE: let backoff approach the widened cap
      await enqueue(storage.work, 't', { tag: 'a' }, { id: 'a' });
      await new Promise((r) => setTimeout(r, 450)); // DEFLAKE: worst-case backed-off tick is ≤400ms
      expect(seen).toContain('a');

      seen.length = 0;
      await enqueue(storage.work, 't', { tag: 'b' }, { id: 'b' });
      // if it reset (~pollMs=10ms) it's caught quickly; if it had stayed in backoff (cap ~80ms) it
      // wouldn't be caught in this short window.
      // DEFLAKE margins: reset ≈10ms gets a 150ms window (15× slack under full-suite load); a
      // non-reset interval sits near the 400ms cap — 2.6× above the window. Stronger discrimination.
      await new Promise((r) => setTimeout(r, 150));
      expect(seen).toContain('b');
      worker.stop();
    });

    // DETERMINISM: fake timers. The real-time version counted ticks in a 205ms WALL-CLOCK window
    // (pollMs=10, expecting ≥15) — under a stalled event loop the loop simply gets fewer turns
    // (observed: 13) even though the interval logic is correct. On the virtual clock the 10ms
    // interval yields exactly 20 ticks, load-independent.
    it('backoff:false → constant poll interval (old behavior)', async () => {
      vi.useFakeTimers();
      try {
        const storage = new InMemoryStorage();
        const origList = storage.work.list.bind(storage.work);
        let calls = 0;
        vi.spyOn(storage.work, 'list').mockImplementation((...args: any[]) => {
          calls++;
          return (origList as any)(...args);
        });
        const worker = createWorker(storage, {}, { pollMs: 10, backoff: false });
        worker.start();
        await vi.advanceTimersByTimeAsync(205); // ~20-tick window
        worker.stop();
        expect(calls).toBeGreaterThanOrEqual(15); // ticks at a regular constant interval, no backoff
      } finally {
        vi.useRealTimers();
      }
    });

    it('no overlap: a new tick does not start while a slow poll is still running', async () => {
      const storage = new InMemoryStorage();
      const origList = storage.work.list.bind(storage.work);
      let active = 0;
      let maxActive = 0;
      vi.spyOn(storage.work, 'list').mockImplementation(async (...args: any[]) => {
        active++;
        maxActive = Math.max(maxActive, active);
        const res = await (origList as any)(...args);
        await new Promise((r) => setTimeout(r, 60)); // artificially slow down each tick
        active--;
        return res;
      });
      const worker = createWorker(storage, {}, { pollMs: 10 });
      worker.start();
      await new Promise((r) => setTimeout(r, 200));
      worker.stop();
      expect(maxActive).toBeLessThanOrEqual(1); // two ticks never entered the store concurrently
    });
  });

  // Queue retry/dead-letter: re-enqueue a failed (qfail) job with its original type/payload.
  describe('retryJob', () => {
    it('re-enqueues a dead-letter (qfail) job as a new job; the old record/qfail is UNCHANGED', async () => {
      const storage = new InMemoryStorage();
      const worker = createWorker(storage, { t: async () => { throw new Error('always fails'); } }, { maxAttempts: 2 });
      await enqueue(storage.work, 't', { amount: 7 }, { id: 'j1' });
      await worker.runOnce(); // attempt 1 → pending
      await worker.runOnce(); // attempt 2 → reached maxAttempts → qfail (dead-letter)
      expect((await listJobs(storage.work)).find((j) => j.id === 'j1')!.status).toBe('failed');

      const newId = await retryJob(storage.work, 'j1');
      expect(newId).toBeTruthy();
      expect(newId).not.toBe('j1'); // append-only: the same id was not reused, a new record was opened

      const jobs = await listJobs(storage.work);
      expect(jobs.find((j) => j.id === 'j1')!.status).toBe('failed'); // the old dead-letter record REMAINS
      const fresh = jobs.find((j) => j.id === newId);
      expect(fresh).toMatchObject({ type: 't', status: 'pending', attempts: 0 }); // the new copy is fresh/pending

      // the new job can be processed normally (the worker recognizes it, the original payload is preserved)
      const runs: unknown[] = [];
      const worker2 = createWorker(storage, { t: async (p: any) => void runs.push(p) });
      expect(await worker2.runOnce()).toBe(true);
      expect(runs).toEqual([{ amount: 7 }]);
    });

    it('a pending/locked job is not retried (double-run protection) → no-op (null)', async () => {
      const storage = new InMemoryStorage();
      await enqueue(storage.work, 't', {}, { id: 'j1' }); // never ran → status pending
      expect(await retryJob(storage.work, 'j1')).toBeNull();
      expect((await listJobs(storage.work)).length).toBe(1); // a second copy was NOT OPENED
    });

    it('a done job is not retried → no-op (null)', async () => {
      const storage = new InMemoryStorage();
      const worker = createWorker(storage, { t: async () => {} });
      await enqueue(storage.work, 't', {}, { id: 'j1' });
      await worker.runOnce(); // done
      expect((await listJobs(storage.work))[0]!.status).toBe('done');
      expect(await retryJob(storage.work, 'j1')).toBeNull();
      expect((await listJobs(storage.work)).length).toBe(1);
    });

    it('a nonexistent job id → no-op (null)', async () => {
      const storage = new InMemoryStorage();
      expect(await retryJob(storage.work, 'nonexistent-id')).toBeNull();
    });
  });
});
