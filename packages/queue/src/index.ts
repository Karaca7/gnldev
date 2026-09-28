// @gnldev/queue — durable background-task queue + worker on top of WorkStore.
// Each job runs as a DURABLE run (the handler typically calls runDurable(runId:'job:'+id)) →
// if the worker crashes mid-job the lock goes stale → reclaim → handler runs again → runDurable
// resumes from the RunJournal → SIDE EFFECT HAPPENS ONCE. acquireRunLock (M4) prevents two workers
// from running the same job concurrently.
// Job log + markers live in WorkStore (own namespace); the lock + handler's durability live in RunJournal.
import { randomUUID } from 'node:crypto';
import {
  acquireRunLock, requireCapability, createPollLoop, orgPrefix, withOrgStorage, orgStorageScopeOf, ownedName, ownedPrefix,
  claimRunOwner, runDurable, user, staff, UNKNOWN, toJournal, ownerOfName, assertRootWorkForErasure,
} from '@gnldev/durable';
import type { Storage, WorkStore, RunJournal, LogRecord, Caller, RunDurableArgs, DurableResult } from '@gnldev/durable';

/** What `ctx.run` takes: `runDurable`'s arguments without the four the job already decides. */
export type JobRunArgs = RunDurableArgs extends infer A ? (A extends unknown ? Omit<A, 'journal' | 'runId' | 'caller' | 'resourceId'> : never) : never;

export interface JobCtx {
  /**
   * RunJournal for the job's own durable runId ('job:<id>'). Scoped to `orgId` when the job has one,
   * so the run lands in that organization.
   */
  journal: RunJournal;
  jobId: string;
  runId: string;
  /**
   * WHO the job runs for, read once from the owner recorded when the job was enqueued: the user
   * (`user(resourceId, orgId)`), staff when it was enqueued with `caller: staff()`, else `unknown`.
   * The worker records it as the owner of `runId` BEFORE the handler runs, so a run started on `runId`
   * as anyone else is refused instead of being born ownerless.
   */
  caller: Caller;
  /**
   * Start (or resume) the job's durable run as its owner: `runDurable` on `journal` + `runId` with
   * `caller` bound. Nothing to pass on by hand.
   */
  run(args: JobRunArgs): Promise<DurableResult>;
  /** The organization this job was enqueued for. */
  orgId?: string;
  /**
   * The worker's storage, scoped to `orgId` when the job has one — build the organization's instance
   * from it. Not for follow-up jobs: its work store is the organization's, which no worker polls.
   */
  storage: Storage;
  /**
   * Enqueue a follow-up job into the worker's own queue, for the same owner in the same organization
   * (both overridable). What `enqueue(ctx.storage.work, …)` looks like it does, and did not.
   */
  enqueue(type: string, payload: unknown, opts?: EnqueueOptions): Promise<string>;
}

/** Whose a job is. Kept beside the payload, never inside it: a payload is the handler's, this is the queue's. */
export interface JobOwner {
  resourceId?: string;
  orgId?: string;
}

export interface EnqueueOptions extends JobOwner {
  id?: string;
  maxDepth?: number;
  /**
   * Whose the job is, as an engine `Caller` (the value a door hands `runDurable`). `user(id, org)` is
   * the same as `{ resourceId, orgId }`; `staff(org?)` is an explicit operator/system job. With neither
   * this nor `resourceId`, the job's run is `unknown`: never staff by omission.
   */
  caller?: Caller;
}

/** A `qjob` log entry. The owner fields are written by `enqueue` only, beside the payload. */
type JobRecord = { type: string; payload: unknown; ownerKind?: 'staff' } & JobOwner;

/** The caller a job's recorded owner stands for — the ONE reading (worker, `ctx.enqueue`, `retryJob`). */
function callerOfJob(rec: JobRecord): Caller {
  if (typeof rec.resourceId === 'string' && rec.resourceId !== '') return user(rec.resourceId, rec.orgId);
  if (rec.ownerKind === 'staff') return staff(rec.orgId);
  return UNKNOWN;
}

/** The enqueue options that recreate a job's owner (a retry, or a follow-up's defaults). */
function ownerOptionsOf(rec: JobRecord): EnqueueOptions {
  return {
    ...(rec.resourceId !== undefined ? { resourceId: rec.resourceId } : {}),
    ...(rec.orgId !== undefined ? { orgId: rec.orgId } : {}),
    ...(rec.ownerKind === 'staff' ? { caller: staff(rec.orgId) } : {}),
  };
}

/** The owner fields a job record carries, from `enqueue`'s options. One owner per job. */
function jobOwnerOf(opts: EnqueueOptions): JobOwner & { ownerKind?: 'staff' } {
  const c = opts.caller;
  const cOrg = c === undefined || c.kind === 'unknown' ? undefined : c.orgId;
  const cRes = c?.kind === 'user' ? c.id : undefined;
  if (c !== undefined && ((opts.resourceId !== undefined && opts.resourceId !== cRes) || (opts.orgId !== undefined && cOrg !== undefined && opts.orgId !== cOrg))) {
    throw new TypeError('@gnldev/queue: a job was given both `caller` and a different `resourceId`/`orgId` — one owner per job.');
  }
  const resourceId = cRes ?? opts.resourceId;
  const orgId = cOrg ?? opts.orgId;
  return {
    ...(resourceId !== undefined ? { resourceId } : {}),
    ...(orgId !== undefined ? { orgId } : {}),
    ...(c?.kind === 'staff' ? { ownerKind: 'staff' as const } : {}),
  };
}

/**
 * The per-organization depth index: one small log per owner group, holding one record per job under
 * the job's own id. `maxDepth` counts this log, so the cost is O(min(depth, maxDepth)) pages of the
 * caller's OWN organization, never the whole shared queue. Under `org:<id>:` so that
 * `purgeOrganizationWork` takes it with the organization; an owned record's id is the job's owned id,
 * so a person's erasure takes it too.
 */
const depthNs = (orgId: string | undefined) => (orgId === undefined ? 'qdepth' : `org:${orgId}:qdepth`);


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
   * poll interval grows ×2 (cap: `maxPollMs ?? pollMs*32`) → prevents tens of thousands of empty
   * queries per second (poll storm, an audit finding) on an empty queue with 1000 consumers. The
   * interval resets to `pollMs` as soon as a job is claimed. `false` → old behavior (constant `pollMs` interval).
   */
  backoff?: boolean;
  /** Backoff cap (default `pollMs*32`). Only meaningful while `backoff !== false`. */
  maxPollMs?: number;
  /**
   * Y2 (heartbeat, default ON): `renew`s the lock every `ttlMs/3` while the handler runs → prevents a
   * long-running handler (> ttlMs) from letting the lock expire mid-run and a second worker TAKING OVER
   * AND DOUBLE-RUNNING the job. If disabled, old behavior returns (the lock can expire early on a
   * handler longer than TTL, reintroducing reclaim risk) — recommended only for test/debug.
   */
  heartbeat?: boolean;
  /**
   * Phase 8 (review leftover): if renew THROWS THIS MANY TIMES IN A ROW (the transient error has become
   * persistent — e.g. journal/network is consistently unreachable), `lockLost=true` is assumed: a
   * persistent transient error is treated as the best available signal that the lock may have REALLY
   * expired via TTL — the worker can't know for certain, so this is the best approximation (until
   * WorkStore CAS/fencing lands — a tracked backlog item). Default 3. The consecutive counter is
   * reset by any SUCCESSFUL renew (a single hiccup never PRODUCES a lockLost — current behavior, see tests).
   */
  maxRenewFailures?: number;
  onError?: (err: unknown, jobId: string) => void;
}

export interface JobStatus extends JobOwner {
  id: string;
  type: string;
  status: 'pending' | 'done' | 'failed';
  attempts: number;
}

/**
 * Phase 8 (audit finding: unbounded accumulation): if `maxDepth` is given — if the queue depth before
 * insertion (the count of ALL records in the `qjob` namespace: pending+done+failed, since an unpruned
 * append-only log can't distinguish between them) has reached/exceeded `maxDepth`, throws.
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
 * know "was the limit exceeded", this stops once it reaches `limit` → cost is O(min(actual depth,
 * maxDepth)) pages, NOT the entire log. Unless `maxDepth` is given (the default behavior), this function
 * is NEVER called → the existing unbounded-queue behavior is preserved.
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

/**
 * Adds a job to the queue (idempotent: repeating with the same id = a single job).
 *
 * `caller` (or the `resourceId`/`orgId` shorthand) says whose the job is. The worker runs the job as
 * that owner (see `JobCtx.caller`); a job with no owner runs as `unknown`. The owner is checked here,
 * at the door — a bad organization id found by the worker would be five failed attempts and a dead
 * letter instead of one error to the caller.
 */
export async function enqueue(
  work: WorkStore,
  type: string,
  payload: unknown,
  options: EnqueueOptions = {},
): Promise<string> {
  const opts: EnqueueOptions = { ...options, ...jobOwnerOf(options), caller: undefined };
  const ownerKind = options.caller?.kind === 'staff' ? ('staff' as const) : undefined;
  // The queue is ONE log that the worker polls at the root. An organization-scoped work store (a
  // handler's `ctx.storage.work`) takes the append and files it under `org:<id>:qjob`, where nothing
  // ever reads it: the job is lost without a word. Refused instead.
  const scopedTo = orgStorageScopeOf(work);
  if (scopedTo !== undefined) {
    throw new Error(
      `@gnldev/queue: enqueue was handed organization '${scopedTo}''s work store — the worker polls the root queue, so the job ` +
        "would never run. In a handler use ctx.enqueue(type, payload); elsewhere pass the root storage's work with { orgId }.",
    );
  }
  if (opts.orgId !== undefined) orgPrefix(opts.orgId);
  if (opts.resourceId !== undefined && (typeof opts.resourceId !== 'string' || opts.resourceId === '')) {
    throw new Error(`@gnldev/queue: invalid resourceId '${String(opts.resourceId)}' — must be a non-empty string, or omitted for a system job`);
  }
  if (opts.maxDepth != null) {
    // Counted per organization: one organization filling the queue refused every other one's work.
    // Read from the organization's own depth index, so an organization with 5 jobs pays for 5 records,
    // not for every other organization's backlog (R22).
    const depth = await countUpTo(work, depthNs(opts.orgId), opts.maxDepth);
    if (depth >= opts.maxDepth) {
      throw new QueueDepthExceededError(
        `@gnldev/queue: queue depth limit exceeded (${depth} >= ${opts.maxDepth}) — job rejected (type='${type}').`,
        { type, depth, maxDepth: opts.maxDepth },
      );
    }
  }
  const rec: JobRecord = {
    type,
    payload,
    ...(opts.resourceId !== undefined ? { resourceId: opts.resourceId } : {}),
    ...(opts.orgId !== undefined ? { orgId: opts.orgId } : {}),
    ...(ownerKind ? { ownerKind } : {}),
  };
  // A caller's id is a name within its owner (`ownedName`): the log is one for every organization. The
  // id returned is the stored one — what `retryJob` and `listJobs` speak.
  // An owned job always has an engine-written owned id: that is where erasure finds it.
  const owned = opts.resourceId !== undefined || opts.orgId !== undefined;
  const name = opts.id ?? (owned ? randomUUID() : undefined);
  const id = await work.append('qjob', rec, name === undefined ? undefined : ownedName(name, { resourceId: opts.resourceId, orgId: opts.orgId }));
  // The depth index, under the SAME id (idempotent with the job). A crash between the two appends
  // under-counts this one job by one; never over-counts.
  await work.append(depthNs(opts.orgId), { type }, id);
  return id;
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
  const jobs = await listAll<JobRecord>(work, 'qjob');
  const out: JobStatus[] = [];
  for (const j of jobs) {
    const done = await work.get(`qdone:${j.id}`);
    const fail = await work.get(`qfail:${j.id}`);
    const attempts = (await work.get<number>(`qatt:${j.id}`)) ?? 0;
    out.push({
      id: j.id,
      type: j.payload.type,
      status: done ? 'done' : fail ? 'failed' : 'pending',
      attempts,
      ...(j.payload.resourceId !== undefined ? { resourceId: j.payload.resourceId } : {}),
      ...(j.payload.orgId !== undefined ? { orgId: j.payload.orgId } : {}),
    });
  }
  return out;
}

/**
 * Finds the job record with `id` (if any) in the `qjob` log. Unlike `listAll` it does NOT READ the
 * entire log — it scans page by page and stops as soon as the id is found (cost O(pages read until found)).
 */
async function findJob(
  work: WorkStore,
  id: string,
): Promise<LogRecord<JobRecord> | undefined> {
  let cursor: string | undefined;
  for (;;) {
    const page = await work.list<JobRecord>('qjob', { cursor });
    const hit = page.items.find((j) => j.id === id);
    if (hit) return hit;
    if (!page.nextCursor) return undefined;
    cursor = page.nextCursor;
  }
}

/**
 * Re-enqueues a dead-letter (qfail — has reached `maxAttempts`) job as a NEW job with its original
 * type/payload: calls `enqueue` (append-only log — the old record AND its qfail/qatt markers are
 * NOT MODIFIED/DELETED, the dead-letter history stays permanent for audit; only a new, fresh
 * runnable copy is added, with a new id auto-generated by `enqueue`).
 *
 * DOUBLE-RUN PROTECTION: only TERMINAL-FAILED (qfail-marked) jobs can be retried. If the job doesn't
 * exist at all OR hasn't reached qfail yet (status 'pending': still waiting in the queue, a worker is
 * currently processing it, or an automatic retry — createWorker already retries on its own up to
 * `maxAttempts` — it will continue on its own on the next poll; 'done': already finished) returns
 * `null` (no-op). Adding a second copy for these jobs would create a DOUBLE-RUN of work the worker
 * is ALREADY going to process/has already processed — exactly the situation this function is meant
 * to prevent.
 */
export async function retryJob(work: WorkStore, id: string, opts: { maxDepth?: number } = {}): Promise<string | null> {
  const rec = await findJob(work, id);
  if (!rec) return null;
  const fail = await work.get(`qfail:${id}`);
  if (!fail) return null; // only dead-letter jobs are retried — pending/done is a no-op
  // The copy is the same user's, in the same organization: a retry must not turn their job into the system's.
  return enqueue(work, rec.payload.type, rec.payload.payload, { ...opts, ...ownerOptionsOf(rec.payload) });
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
  // point are terminal (done/fail)" → subsequent polls never re-scan earlier pages (5.1: starvation +
  // O(n)-per-poll fix). If a job is still pending (awaiting retry / locked) the cursor does NOT PASS
  // it → exactly-once/retry semantics are preserved. Old (cursor-less) queues also flow from the
  // start (cursor=undefined).
  const QCURSOR = 'qcursor';

  async function runOnce(): Promise<boolean> {
    let cursor = await work.get<string>(QCURSOR);
    for (;;) {
      const page = await work.list<JobRecord>('qjob', { cursor });
      let allTerminal = true;
      for (const job of page.items) {
        if (await work.get(`qdone:${job.id}`)) continue; // done
        if (await work.get(`qfail:${job.id}`)) continue; // dead-letter
        allTerminal = false;
        const runId = `job:${job.id}`;
        // THE LEASE'S KEY — deliberately NOT the runId.
        //
        // This lock answers "which WORKER owns this job". The runId's own lock answers "is this RUN
        // executing anywhere". Two questions, and they used to be written to one place:
        // `acquireRunLock(runs, runId, …)` produces `<runId>:lock`, and `runId` is then handed to the
        // handler as `ctx.runId` — the value this package's own README tells handlers to pass to
        // `runDurable({ runId: ctx.runId, … })`. So the moment that inner call took a lock of its own
        // (a `lock` option, or a critical-preset `runWorkflow`), the worker refused the handler it had
        // just invoked. RunBusyError on every attempt, the job dead-lettering at maxAttempts having
        // never run once. Not a race — it could not work at all.
        //
        // Found in @gnldev/scheduler first, where the same construction killed a production health
        // trigger; this package had it in the same shape and is fixed the same way. The two locks now
        // nest instead of competing.
        //
        // SUFFIXED rather than moved to a namespace of its own, for the reason the scheduler's
        // FIRE_LOCK gives at length: `<runId>:lease:lock` stays under the run's key prefix, which is
        // what purgeRun/sweepRuns delete by. A sibling namespace would leak one small record per job,
        // forever. `parseJournalKey` ignores it either way (it claims only `:model:`/`:tool:`).
        //
        // The WorkStore fencing chain below is unaffected: `qown:<jobId>` stores `lock.token`, and a
        // token is a token whichever key it was minted on.
        const lock = await acquireRunLock(runs, `${runId}:lease`, owner, ttlMs);
        if (!lock) continue; // held by another worker / fresh lease
        // 8.2 (closes a correctness debt): terminal writes (qdone/qfail/qatt) get their OWN fencing
        // chain inside WorkStore. `qown:<jobId>` answers "who currently holds this" for the ENTIRE
        // DURATION of this run via WorkStore's own in-engine CAS (putIfMatch) — INDEPENDENT of the
        // lock record in RunJournal, within WorkStore's own consistency boundary. The first write is
        // an UNCONDITIONAL put: the claim itself was already deduplicated via RunJournal CAS
        // (acquireRunLock) → overwriting here is safe (a new claim = a new token = a new "ownership
        // epoch"). If WorkStore doesn't support putIfMatch this key is never written (stillOwns()
        // below then falls back to lockLost only — old behavior preserved EXACTLY).
        const fencingKey = `qown:${job.id}`;
        if (work.putIfMatch) await work.put(fencingKey, lock.token);
        // Y2 (heartbeat): if the handler runs longer than ttlMs, the lock TTL expires → a second
        // worker could take over the SAME job and DOUBLE-RUN it (the actual bug). We keep the lock
        // alive until the handler finishes by renewing it every ttlMs/3. If renew returns FALSE
        // (fencing token mismatch — the lock was genuinely taken over), `lockLost` is marked: this
        // worker can no longer WRITE THE JOB RESULT — the worker that took over will write its own
        // run; a stale worker's qdone/qfail/qatt write could overwrite it and make an
        // INCONSISTENT/wrong result permanent. `lockLost` is a DELAYED approximation, up to one
        // heartbeat tick (ttlMs/3) — if the handler finishes mid-tick, `lockLost` may not be true yet
        // even though a real takeover happened. If WorkStore supports it, `stillOwns()` (below) closes
        // this narrow window AT WRITE TIME via the `qown` CAS; if not, we rely on `lockLost` alone
        // (WorkStore.put is NOT CAS-backed — see storage.ts WorkStore).
        // renew THROWING (a TRANSIENT error like a network/journal hiccup) is a separate case: a
        // SINGLE throw does NOT PROVE a token mismatch — we don't know a real takeover happened —
        // so a single hiccup does NOT TOUCH `lockLost` (flipping it to true by mistake would mean
        // qdone/qfail/qatt never get written even if the handler finishes successfully, AND
        // release() would genuinely free the lock since the token still matches → another worker
        // would RE-RUN the job, exactly the double-run Y2 is meant to prevent). It's just logged; the
        // lock's TTL already tolerates a few renew ticks (ttlMs/3 interval), and the next tick
        // retries. BUT (Phase 8 review leftover) if the throw repeats `maxRenewFailures` times IN A
        // ROW, the transient error has become PERSISTENT — this is the best approximation of the
        // lock having GENUINELY expired via TTL (the worker can't be certain since WorkStore lacks
        // CAS/fencing here — "WorkStore fencing" is a tracked backlog item) → at
        // that point `lockLost=true` is assumed. Any SUCCESSFUL renew (non-throwing) resets the
        // consecutive counter — a single hiccup never produces lockLost.
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
        // renew failures, a real takeover is NOT REQUIRED) is STILL the first condition and is the
        // behavior the existing tests rely on. ON TOP OF THAT: if WorkStore supports putIfMatch, a
        // second, stricter check is added via an INSTANT in-engine CAS on `qown` — this catches a
        // real takeover even if it happened mid-heartbeat-tick (not yet reflected in lockLost). If
        // putIfMatch isn't available, we fall back to `lockLost` alone (old behavior preserved
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
          const rec = job.payload;
          const orgId = rec.orgId;
          const scoped = orgId !== undefined ? withOrgStorage(storage, orgId) : storage;
          const caller = callerOfJob(rec);
          // ADR-0002 5a: the job's run belongs to the job's recorded owner WITHOUT the handler passing
          // it. Recorded here, before the handler runs (first write wins, so a retry or a resumed run
          // keeps the owner it was born with). A handler that starts `runId` as anyone else — the old
          // `runDurable({ runId: ctx.runId, … })` with the user forgotten — is now refused by the
          // engine's own admission instead of producing a run nobody but staff can see.
          await claimRunOwner(toJournal(scoped.runs), runId, caller);
          const followUp = (o: EnqueueOptions = {}): EnqueueOptions => {
            if (o.caller !== undefined) return o;
            const base = ownerOptionsOf(rec);
            if (o.resourceId !== undefined) delete base.caller;
            else if (base.caller && o.orgId !== undefined) base.caller = staff(o.orgId);
            return { ...base, ...o };
          };
          await handler(rec.payload, {
            journal: scoped.runs, jobId: job.id, runId, storage: scoped, caller,
            ...(orgId !== undefined ? { orgId } : {}),
            run: (args) => runDurable({ ...args, journal: toJournal(scoped.runs), runId, caller }),
            enqueue: (type, payload, o) => enqueue(work, type, payload, followUp(o)),
          });
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
          // swallowed: the worker loop continues; the job (unless qfail) retries on the next turn → crash-resume.
        } finally {
          if (heartbeat) clearInterval(heartbeat);
          // While lockLost=true (a real takeover), release() is naturally a no-op because this
          // worker's token no longer matches the current record (see run-lock.ts mkLock.release) —
          // it never overwrites the lock of the worker that took over. On a transient renew error
          // (lockLost stays false) the token is STILL OURS, so release() here deliberately, genuinely
          // frees the lock (the job was already written as terminal).
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
    // upper bound of TOTAL job count to prevent infinite retries (each turn either advances or approaches dead-letter).
    // listAll (5.1): counted correctly even if the job count exceeds the store's default page size (e.g. 50).
    const total = (await listAll(work, 'qjob')).length;
    const cap = total * (maxAttempts + 1) + 1;
    for (let i = 0; i < cap; i++) {
      if (await runOnce()) n++;
      else break;
    }
    return n;
  }

  // Phase 8.1: the tick/backoff/"polling" flag loop now lives in @gnldev/durable's shared
  // createPollLoop (it was triplicated across queue/events/scheduler) — behavior is identical: if
  // runOnce() does NOT CLAIM a job (false) the interval grows ×2 while backoffOn (cap maxPollMs);
  // resets to pollMs once a job is claimed.
  const loop = createPollLoop(runOnce, { pollMs, backoff: backoffOn, maxPollMs });

  return {
    runOnce,
    drain,
    start: loop.start,
    stop: loop.stop,
  };
}

// ─── Upgrades and erasure ──────────────────────────────────────────────────────────────────────

/**
 * Give an existing SYSTEM job (an id written before jobs had owners) to an owner, without doubling it.
 *
 * `enqueue` stores an owned job under `ownedName(id, owner)`, so after an upgrade the same caller
 * re-enqueuing `weekly-report` with `{ orgId }` adds a SECOND job next to the old one, and both run.
 * This moves it instead: the owned job gets the old one's markers (a finished job stays finished, a
 * dead letter stays dead), then the old one is marked done with `movedTo`. Run it once per id during
 * the upgrade, with the workers stopped; afterwards the post-upgrade `enqueue` is idempotent with it.
 * A job that had started keeps no progress: its run was `job:<old id>`, the moved job's is new.
 *
 * Returns the owned id, or `null` when there is no such job. Refuses an id that already has an owner.
 */
export async function moveJob(work: WorkStore, fromId: string, to: Omit<EnqueueOptions, 'id' | 'maxDepth'>): Promise<string | null> {
  const from = ownerOfName(fromId);
  if (from.resourceId !== undefined || from.orgId !== undefined) {
    throw new TypeError(`@gnldev/queue: moveJob('${fromId}') — that job already has an owner; only a system job is moved.`);
  }
  const owner = jobOwnerOf(to);
  if (owner.resourceId === undefined && owner.orgId === undefined) {
    throw new TypeError('@gnldev/queue: moveJob needs an owner to move the job to (`caller`, `resourceId` or `orgId`).');
  }
  const old = await findJob(work, fromId);
  if (!old) return null;
  const toId = ownedName(fromId, { resourceId: owner.resourceId, orgId: owner.orgId });
  // Markers FIRST: a worker that saw the owned job before its markers would run a finished job again.
  for (const m of ['qdone', 'qfail', 'qatt'] as const) {
    const v = await work.get(`${m}:${fromId}`);
    if (v !== undefined && (await work.get(`${m}:${toId}`)) === undefined) await work.put(`${m}:${toId}`, v);
  }
  await enqueue(work, old.payload.type, old.payload.payload, { ...to, id: fromId });
  if ((await work.get(`qdone:${fromId}`)) === undefined && (await work.get(`qfail:${fromId}`)) === undefined) {
    await work.put(`qdone:${fromId}`, { at: Date.now(), movedTo: toId });
  }
  return toId;
}

/** What `eraseSubject` (in `@gnldev/durable`) calls to erase one person's share of a package. */
export interface SubjectEraser {
  name: string;
  erase(owner: { resourceId: string; orgId?: string }): Promise<number>;
}

/**
 * Erase one person's jobs: the job records and their depth-index records, the `qdone`/`qfail`/`qatt`/
 * `qown` markers (a `qfail` holds the handler's error text), the worker's lease locks in the root
 * journal, and the job runs themselves (`job:<owned id>` in the organization's journal).
 *
 * Found by the id prefix the engine wrote (`ownedPrefix`), never by payload. Refuses, rather than
 * reporting a partial erasure as done, when a store cannot delete: the work store needs
 * `deleteIdPrefix` and `deletePrefix`, the run journal `deletePrefix`.
 *
 * Pass it to `eraseSubject({ …, erasers: [jobEraser(storage)] }, id)`, or call `.erase(owner)`.
 */
export function jobEraser(storage: Storage): SubjectEraser {
  return {
    name: 'jobs',
    async erase(owner) {
      requireCapability(storage, 'work');
      const work = storage.work!;
      assertRootWorkForErasure(work, '@gnldev/queue: jobEraser');
      if (typeof work.deleteIdPrefix !== 'function' || typeof work.deletePrefix !== 'function') {
        throw new Error("@gnldev/queue: this work store cannot delete by id prefix (`deleteIdPrefix`) and key prefix (`deletePrefix`), so this person's jobs cannot be erased through it");
      }
      const root = toJournal(storage.runs);
      const scoped = owner.orgId !== undefined ? toJournal(withOrgStorage(storage, owner.orgId).runs) : root;
      if (typeof root.deletePrefix !== 'function' || typeof scoped.deletePrefix !== 'function') {
        throw new Error("@gnldev/queue: the run journal cannot deletePrefix, so this person's job runs and locks cannot be erased");
      }
      const prefix = ownedPrefix(owner);
      let n = await work.deleteIdPrefix(prefix);
      for (const m of ['qdone', 'qfail', 'qatt', 'qown']) n += await work.deletePrefix(`${m}:${prefix}`);
      // The lease lock lives in the ROOT journal (`job:<id>:lease:lock`); the run in the job's organization.
      n += await root.deletePrefix(`job:${prefix}`);
      if (owner.orgId !== undefined) n += await scoped.deletePrefix(`job:${prefix}`);
      return n;
    },
  };
}
