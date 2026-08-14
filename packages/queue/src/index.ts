// @gnldev/queue — durable background-task queue + worker on top of WorkStore.
// Each job runs as a DURABLE run (the handler typically calls runDurable(runId:'job:'+id)) →
// If the worker crashes mid-job the lock goes stale → reclaim → handler runs again → runDurable
// Resumes from the RunJournal → SIDE EFFECT HAPPENS ONCE. acquireRunLock (M4) prevents two workers
// From running the same job concurrently.
// Job log + markers live in WorkStore (own namespace); the lock + handler's durability live in RunJournal.
import { acquireRunLock, requireCapability, createPollLoop } from '@gnldev/durable';
import type { Storage, WorkStore, RunJournal, LogRecord } from '@gnldev/durable';

export interface JobCtx {
  /** RunJournal for the job's own durable runId ('job:<id>') (passed to the handler as the journal for runDurable). */
  journal: RunJournal;
  jobId: string;
  runId: string;
}

export type JobHandler = (payload: any, ctx: JobCtx) => Promise<any>;

export interface QueueWorkerOptions {
  owner?: string;
  /** Lock TTL: locks older than this (crashed) are reclaimed. */
  ttlMs?: number;
  /** start() poll interval (also the base for backoff growth on an empty queue). */
  pollMs?: number;
  /** How many failed attempts before a job becomes dead-letter (qfail). */
  maxAttempts?: number;
  /**
   * Empty-poll exponential backoff (default ON): if runOnce() CLAIMS NO job (returns false), the next
   * Poll interval grows ×2 (cap: `maxPollMs ?? pollMs*32`) → prevents tens of thousands of empty
   * Queries per second (poll storm, an audit finding) on an empty queue with 1000 consumers. The
   * Interval resets to `pollMs` as soon as a job is claimed. `false` → old behavior (constant `pollMs` interval).
   */
  backoff?: boolean;
  /** Backoff cap (default `pollMs*32`). Only meaningful while `backoff !== false`. */
  maxPollMs?: number;
  /**
   * Y2 (heartbeat, default ON): `renew`s the lock every `ttlMs/3` while the handler runs → prevents a
   * Long-running handler (> ttlMs) from letting the lock expire mid-run and a second worker TAKING OVER
   * AND DOUBLE-RUNNING the job. If disabled, old behavior returns (the lock can expire early on a
   * Handler longer than TTL, reintroducing reclaim risk) — recommended only for test/debug.
   */
  heartbeat?: boolean;
  /**
   * Phase 8 (review leftover): if renew THROWS THIS MANY TIMES IN A ROW (the transient error has become
   * Persistent — e.g. journal/network is consistently unreachable), `lockLost=true` is assumed: a
   * Persistent transient error is treated as the best available signal that the lock may have REALLY
   * Expired via TTL — the worker can't know for certain, so this is the best approximation (until
   * WorkStore CAS/fencing lands — a tracked backlog item). Default 3. The consecutive counter is
   * Reset by any SUCCESSFUL renew (a single hiccup never PRODUCES a lockLost — current behavior, see tests).
   */
  maxRenewFailures?: number;
  onError?: (err: unknown, jobId: string) => void;
}

export interface JobStatus {
  id: string;
  type: string;
  status: 'pending' | 'done' | 'failed';
  attempts: number;
}

/**
 * Phase 8 (audit finding: unbounded accumulation): if `maxDepth` is given — if the queue depth before
 * Insertion (the count of ALL records in the `qjob` namespace: pending+done+failed, since an unpruned
 * Append-only log can't distinguish between them) has reached/exceeded `maxDepth`, throws.
 */
export class QueueDepthExceededError extends Error {
  constructor(
    message: string,
    public readonly detail: { type: string; depth: number; maxDepth: number },
  ) {
    super(message);
    this.name = 'QueueDepthExceededError';
  }
}

/**
 * Counts records in the `ns` namespace UP TO AT MOST `limit` (early exit). WorkStore.list is paginated
 * (default page size e.g. 50) — a full count would read O(depth/pageSize) pages; since we only need to
 * Know "was the limit exceeded", this stops once it reaches `limit` → cost is O(min(actual depth,
 * MaxDepth)) pages, NOT the entire log. Unless `maxDepth` is given (the default behavior), this function
 * Is NEVER called → the existing unbounded-queue behavior is preserved.
 */
async function countUpTo(work: WorkStore, ns: string, limit: number): Promise<number> {
  let count = 0;
  let cursor: string | undefined;
  for (;;) {
    const page = await work.list(ns, { cursor });
    count += page.items.length;
    if (count >= limit || !page.nextCursor) return count;
    cursor = page.nextCursor;
  }
}

/** Adds a job to the queue (idempotent: repeating with the same id = a single job). */
export async function enqueue(
  work: WorkStore,
  type: string,
  payload: unknown,
  opts: { id?: string; maxDepth?: number } = {},
): Promise<string> {
  if (opts.maxDepth != null) {
    const depth = await countUpTo(work, 'qjob', opts.maxDepth);
    if (depth >= opts.maxDepth) {
      throw new QueueDepthExceededError(
        `@gnldev/queue: queue depth limit exceeded (${depth} >= ${opts.maxDepth}) — job rejected (type='${type}').`,
        { type, depth, maxDepth: opts.maxDepth },
      );
    }
  }
  return work.append('qjob', { type, payload }, opts.id);
}

/**
 * Exhausts WorkStore.list pagination (default limit, e.g. 50) to return ALL records in a namespace.
 * Intended for management/listing (listJobs, drain's cap calculation) — NOT USED in the poll loop
 * (runOnce); that path reads only the necessary pages via a cursor (5.1: reduce O(n)-per-poll).
 */
async function listAll<T>(work: WorkStore, ns: string): Promise<LogRecord<T>[]> {
  const out: LogRecord<T>[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await work.list<T>(ns, { cursor });
    out.push(...page.items);
    if (!page.nextCursor) return out;
    cursor = page.nextCursor;
  }
}

/** Summary of all jobs (pending/done/failed + attempt count). */
export async function listJobs(work: WorkStore): Promise<JobStatus[]> {
  const jobs = await listAll<{ type: string; payload: unknown }>(work, 'qjob');
  const out: JobStatus[] = [];
  for (const j of jobs) {
    const done = await work.get(`qdone:${j.id}`);
    const fail = await work.get(`qfail:${j.id}`);
    const attempts = (await work.get<number>(`qatt:${j.id}`)) ?? 0;
    out.push({ id: j.id, type: j.payload.type, status: done ? 'done' : fail ? 'failed' : 'pending', attempts });
  }
  return out;
}

/**
 * Finds the job record with `id` (if any) in the `qjob` log. Unlike `listAll` it does NOT READ the
 * Entire log — it scans page by page and stops as soon as the id is found (cost O(pages read until found)).
 */
async function findJob(
  work: WorkStore,
  id: string,
): Promise<LogRecord<{ type: string; payload: unknown }> | undefined> {
  let cursor: string | undefined;
  for (;;) {
    const page = await work.list<{ type: string; payload: unknown }>('qjob', { cursor });
    const hit = page.items.find((j) => j.id === id);
    if (hit) return hit;
    if (!page.nextCursor) return undefined;
    cursor = page.nextCursor;
  }
}

/**
 * Re-enqueues a dead-letter (qfail — has reached `maxAttempts`) job as a NEW job with its original
 * Type/payload: calls `enqueue` (append-only log — the old record AND its qfail/qatt markers are
 * NOT MODIFIED/DELETED, the dead-letter history stays permanent for audit; only a new, fresh
 * Runnable copy is added, with a new id auto-generated by `enqueue`).
 *
 * DOUBLE-RUN PROTECTION: only TERMINAL-FAILED (qfail-marked) jobs can be retried. If the job doesn't
 * Exist at all OR hasn't reached qfail yet (status 'pending': still waiting in the queue, a worker is
 * Currently processing it, or an automatic retry — createWorker already retries on its own up to
 * `maxAttempts` — it will continue on its own on the next poll; 'done': already finished) returns
 * `null` (no-op). Adding a second copy for these jobs would create a DOUBLE-RUN of work the worker
 * Is ALREADY going to process/has already processed — exactly the situation this function is meant
 * To prevent.
 */
export async function retryJob(work: WorkStore, id: string, opts: { maxDepth?: number } = {}): Promise<string | null> {
  const rec = await findJob(work, id);
  if (!rec) return null;
  const fail = await work.get(`qfail:${id}`);
  if (!fail) return null; // only dead-letter jobs are retried — pending/done is a no-op
  return enqueue(work, rec.payload.type, rec.payload.payload, opts);
}

export interface Worker {
  /** Claims and runs one pending job. Returns true if a job was processed. */
  runOnce(): Promise<boolean>;
  /** Calls runOnce until no pending jobs remain. Returns the number of jobs processed. */
  drain(): Promise<number>;
  start(): void;
  stop(): void;
}

export function createWorker(
  storage: Storage,
  handlers: Record<string, JobHandler>,
  opts: QueueWorkerOptions = {},
): Worker {
  requireCapability(storage, 'work');
  const work = storage.work!;
  const runs: RunJournal = storage.runs;
  const owner = opts.owner ?? `w-${Math.random().toString(36).slice(2, 8)}`;
  const ttlMs = opts.ttlMs ?? 30_000;
  const maxAttempts = opts.maxAttempts ?? 5;
  const pollMs = opts.pollMs ?? 200;
  const backoffOn = opts.backoff ?? true;
  const maxPollMs = opts.maxPollMs ?? pollMs * 32;
  const maxRenewFailures = opts.maxRenewFailures ?? 3;
  // Queue-wide scan cursor (WorkStore KV): persistently tracks the position "all jobs before this
  // Point are terminal (done/fail)" → subsequent polls never re-scan earlier pages (5.1: starvation +
  // O(n)-per-poll fix). If a job is still pending (awaiting retry / locked) the cursor does NOT PASS
  // It → exactly-once/retry semantics are preserved. Old (cursor-less) queues also flow from the
  // Start (cursor=undefined).
  const QCURSOR = 'qcursor';

  async function runOnce(): Promise<boolean> {
    let cursor = await work.get<string>(QCURSOR);
    for (;;) {
      const page = await work.list<{ type: string; payload: unknown }>('qjob', { cursor });
      let allTerminal = true;
      for (const job of page.items) {
        if (await work.get(`qdone:${job.id}`)) continue; // done
        if (await work.get(`qfail:${job.id}`)) continue; // dead-letter
        allTerminal = false;
        const runId = `job:${job.id}`;
        const lock = await acquireRunLock(runs, runId, owner, ttlMs);
        if (!lock) continue; // held by another worker / fresh lock
        // 8.2 (closes a correctness debt): terminal writes (qdone/qfail/qatt) get their OWN fencing
        // Chain inside WorkStore. `qown:<jobId>` answers "who currently holds this" for the ENTIRE
        // DURATION of this run via WorkStore's own in-engine CAS (putIfMatch) — INDEPENDENT of the
        // Lock record in RunJournal, within WorkStore's own consistency boundary. The first write is
        // An UNCONDITIONAL put: the claim itself was already deduplicated via RunJournal CAS
        // (acquireRunLock) → overwriting here is safe (a new claim = a new token = a new "ownership
        // Epoch"). If WorkStore doesn't support putIfMatch this key is never written (stillOwns()
        // Below then falls back to lockLost only — old behavior preserved EXACTLY).
        const fencingKey = `qown:${job.id}`;
        if (work.putIfMatch) await work.put(fencingKey, lock.token);
        // Y2 (heartbeat): if the handler runs longer than ttlMs, the lock TTL expires → a second
        // Worker could take over the SAME job and DOUBLE-RUN it (the actual bug). We keep the lock
        // Alive until the handler finishes by renewing it every ttlMs/3. If renew returns FALSE
        // (fencing token mismatch — the lock was genuinely taken over), `lockLost` is marked: this
        // Worker can no longer WRITE THE JOB RESULT — the worker that took over will write its own
        // Run; a stale worker's qdone/qfail/qatt write could overwrite it and make an
        // INCONSISTENT/wrong result permanent. `lockLost` is a DELAYED approximation, up to one
        // Heartbeat tick (ttlMs/3) — if the handler finishes mid-tick, `lockLost` may not be true yet
        // Even though a real takeover happened. If WorkStore supports it, `stillOwns()` (below) closes
        // This narrow window AT WRITE TIME via the `qown` CAS; if not, we rely on `lockLost` alone
        // (WorkStore.put is NOT CAS-backed — see storage.ts WorkStore).
        // Renew THROWING (a TRANSIENT error like a network/journal hiccup) is a separate case: a
        // SINGLE throw does NOT PROVE a token mismatch — we don't know a real takeover happened —
        // So a single hiccup does NOT TOUCH `lockLost` (flipping it to true by mistake would mean
        // Qdone/qfail/qatt never get written even if the handler finishes successfully, AND
        // Release() would genuinely free the lock since the token still matches → another worker
        // Would RE-RUN the job, exactly the double-run Y2 is meant to prevent). It's just logged; the
        // Lock's TTL already tolerates a few renew ticks (ttlMs/3 interval), and the next tick
        // Retries. BUT (Phase 8 review leftover) if the throw repeats `maxRenewFailures` times IN A
        // ROW, the transient error has become PERSISTENT — this is the best approximation of the
        // Lock having GENUINELY expired via TTL (the worker can't be certain since WorkStore lacks
        // CAS/fencing here — "WorkStore fencing" is a tracked backlog item) → at
        // That point `lockLost=true` is assumed. Any SUCCESSFUL renew (non-throwing) resets the
        // Consecutive counter — a single hiccup never produces lockLost.
        const heartbeatOn = opts.heartbeat ?? true;
        let lockLost = false;
        let consecutiveRenewFailures = 0;
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        if (heartbeatOn) {
          heartbeat = setInterval(() => {
            lock
              .renew(ttlMs)
              .then((ok) => {
                if (!ok) { lockLost = true; return; } // false = a real takeover (token mismatch)
                consecutiveRenewFailures = 0; // successful renew → consecutive failure counter resets
              })
              .catch((err) => {
                consecutiveRenewFailures++;
                console.warn(`[queue] renew transient error (job ${job.id}, ${consecutiveRenewFailures}x in a row), next tick will retry:`, err);
                if (consecutiveRenewFailures >= maxRenewFailures) {
                  lockLost = true;
                  console.warn(`[queue] renew threw ${consecutiveRenewFailures} times in a row (job ${job.id}) — the lock has likely expired via TTL, assuming lockLost=true (best approximation until WorkStore fencing).`);
                }
              });
          }, Math.max(1, Math.floor(ttlMs / 3)));
        }
        // 8.2: the terminal-write GATE. `lockLost` (precautionary — also becomes true on consecutive
        // Renew failures, a real takeover is NOT REQUIRED) is STILL the first condition and is the
        // Behavior the existing tests rely on. ON TOP OF THAT: if WorkStore supports putIfMatch, a
        // Second, stricter check is added via an INSTANT in-engine CAS on `qown` — this catches a
        // Real takeover even if it happened mid-heartbeat-tick (not yet reflected in lockLost). If
        // PutIfMatch isn't available, we fall back to `lockLost` alone (old behavior preserved
        // EXACTLY).
        const stillOwns = async (): Promise<boolean> => {
          if (lockLost) return false;
          if (!work.putIfMatch) return true;
          return work.putIfMatch(fencingKey, lock.token, lock.token);
        };
        try {
          const handler = handlers[job.payload.type];
          if (!handler) {
            if (await stillOwns()) await work.put(`qfail:${job.id}`, { error: `no handler: ${job.payload.type}` });
            return true;
          }
          await handler(job.payload.payload, { journal: runs, jobId: job.id, runId });
          if (await stillOwns()) await work.put(`qdone:${job.id}`, { at: Date.now(), ok: true });
        } catch (err) {
          if (await stillOwns()) {
            const n = ((await work.get<number>(`qatt:${job.id}`)) ?? 0) + 1;
            await work.put(`qatt:${job.id}`, n);
            if (n >= maxAttempts) {
              await work.put(`qfail:${job.id}`, { error: String((err as any)?.message ?? err), attempts: n });
            }
          }
          opts.onError?.(err, job.id);
          // Swallowed: the worker loop continues; the job (unless qfail) retries on the next turn → crash-resume.
        } finally {
          if (heartbeat) clearInterval(heartbeat);
          // While lockLost=true (a real takeover), release() is naturally a no-op because this
          // Worker's token no longer matches the current record (see run-lock.ts mkLock.release) —
          // It never overwrites the lock of the worker that took over. On a transient renew error
          // (lockLost stays false) the token is STILL OURS, so release() here deliberately, genuinely
          // Frees the lock (the job was already written as terminal).
          await lock.release();
        }
        return true; // one job was processed (success or retry)
      }
      if (allTerminal) {
        if (!page.nextCursor) return false; // end of log, all terminal — nothing to process
        // ALL jobs on this page are terminal → advance the cursor permanently (never re-scan it), move to the next page.
        cursor = page.nextCursor;
        await work.put(QCURSOR, cursor);
        continue;
      }
      if (!page.nextCursor) return false; // remaining job(s) exist but are all locked (another worker) — retried on the next poll
      // Page is only partially terminal (has a pending/locked job) → the cursor is NOT advanced permanently (retry preserved), check the next page.
      cursor = page.nextCursor;
    }
  }

  async function drain(): Promise<number> {
    let n = 0;
    // Upper bound of TOTAL job count to prevent infinite retries (each turn either advances or approaches dead-letter).
    // ListAll (5.1): counted correctly even if the job count exceeds the store's default page size (e.g. 50).
    const total = (await listAll(work, 'qjob')).length;
    const cap = total * (maxAttempts + 1) + 1;
    for (let i = 0; i < cap; i++) {
      if (await runOnce()) n++;
      else break;
    }
    return n;
  }

  // Phase 8.1: the tick/backoff/"polling" flag loop now lives in @gnldev/durable's shared
  // CreatePollLoop (it was triplicated across queue/events/scheduler) — behavior is identical: if
  // RunOnce() does NOT CLAIM a job (false) the interval grows ×2 while backoffOn (cap maxPollMs);
  // Resets to pollMs once a job is claimed.
  const loop = createPollLoop(runOnce, { pollMs, backoff: backoffOn, maxPollMs });

  return {
    runOnce,
    drain,
    start: loop.start,
    stop: loop.stop,
  };
}
