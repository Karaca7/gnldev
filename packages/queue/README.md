# @gnldev/queue

**Durable background-task queue + worker** on top of the journal. Each job runs as a durable run → if the process crashes mid-job it resumes from the journal, and a side effect already recorded as done is not run again ([at-most-once](../durable/README.md#what-never-charged-twice-actually-means)). `acquireRunLock` keeps two workers off the same job at once (bounded by the lock TTL after a worker crash — see the storage notes).

> Install: `pnpm add @gnldev/queue` — or use it from a [repo clone](https://github.com/Karaca7/gnldev): `pnpm install && pnpm -r build`.

```bash
npm i @gnldev/queue   # peer: @gnldev/durable
```

```ts
import { enqueue, createWorker } from '@gnldev/queue';
import { SqliteStorage } from '@gnldev/durable/sqlite';

const storage = new SqliteStorage('runs.db');

// Producer: idempotent enqueue (same id → single job). Takes the WORK store, not the run journal.
await enqueue(storage.work, 'send-email', { to: 'a@x.com' }, { id: 'email:order-1' });

// Consumer: retried on handler crashes (dead-letter after maxAttempts). Takes the whole storage —
// it needs the work store to lock jobs and the run journal to keep the side effect at-most-once.
const worker = createWorker(storage, {
  // A bare `await sendEmail(...)` here is AT-LEAST-once: a crash after the send but before the
  // job is acked reclaims the lock and calls the handler again. Route through runDurable with a
  // stable runId, and the send happens once.
  'send-email': async (payload, ctx) =>
    runDurable({ runId: ctx.runId, journal: ctx.journal, model, tools, prompt: '...' }),
});
await worker.runOnce();   // or worker.start() (poll loop)
```

## Jobs for an end user

A job can say whose it is. The worker passes this on, and the run the job starts belongs to that user
in that organization. The user can see it and approve it; other users cannot.

```ts
import { enqueue, createWorker } from '@gnldev/queue';

await enqueue(storage.work, 'weekly-summary', { week: 39 }, { resourceId: 'ayse', orgId: 'acme' });

createWorker(storage, {
  'weekly-summary': async (payload, ctx) =>
    // ctx.journal is already acme's. Pass ctx.resourceId on and the run is Ayşe's.
    runDurable({ runId: ctx.runId, journal: ctx.journal, resourceId: ctx.resourceId, model, prompt: '...' }),
});
```

- Leave both out and the job is the system's (maintenance, cleanups). Only staff can see its run.
- `ctx.storage` is the worker's storage scoped to `orgId`. Build the organization's `createGnl` from it.
- If a handler forgets `resourceId`, the run has no owner. Only staff can see it; it never leaks to
  another user.
- `retryJob` keeps the owner and the organization.
- An explicit `id` is a name **within its owner**: two organizations (or two users) using `weekly-report`
  get two jobs. `enqueue` returns the stored id (`acme:ayse:weekly-report`); use that one with `retryJob`
  and `listJobs`. A system job's id is kept as given.
- A follow-up job from a handler: `ctx.enqueue(type, payload)`. It inherits the user and the organization.
  Passing `ctx.storage.work` to `enqueue` is refused, since no worker polls that store.
- `maxDepth` is counted per organization.

## API
- `enqueue(work, type, payload, { id?, maxDepth?, resourceId?, orgId? }) → jobId` — `work` is `storage.work`
- `createWorker(storage, handlers, opts?) → { runOnce, start, stop }` — `opts`: `owner`, `ttlMs` (stale lock reclaim), `pollMs`, `maxAttempts`, `onError`, `backoff`, `maxPollMs`, `heartbeat`
- `JobCtx` gives the handler `{ journal, jobId, runId, storage, resourceId?, orgId?, enqueue }` — the handler typically calls `runDurable({ runId, ... })` to keep the side effect at-most-once.
- `listJobs(work)` shows each job's `resourceId`/`orgId` next to its status.

## How it works
Jobs are written to an append-only log; the worker locks a job and runs it. Crash → lock goes stale → reclaim → handler runs again → `runDurable` resumes from the journal → **a side effect already recorded as done is not repeated**; one caught in the crash window blocks and asks rather than re-firing ([at-most-once](../durable/README.md#what-never-charged-twice-actually-means)).

The worker's lock is a **lease on the job** (`<runId>:lease`), not a lock on the run. That is why the
example above works: your handler is free to take its own run lock on `ctx.runId` — a `lock` option, or
a `runWorkflow` under `preset: 'critical'` — and the two nest instead of colliding. They were once the
same key, and a handler that locked its own `ctx.runId` was refused by the worker that had just called
it, on every attempt, until the job dead-lettered without ever running.

## Heartbeat + empty-poll backoff (both on by default)
`heartbeat`: if a job's handler runs longer than `ttlMs`, the lock TTL can expire before the handler finishes, letting a second worker take over the same job and run it twice — `createWorker` prevents this by `renew`ing the lock every `ttlMs/3` while the handler runs. If a real takeover is detected (fencing token mismatch), this worker does NOT WRITE `qdone`/`qfail`/`qatt`, so it doesn't clobber the result of the worker that took over. Can be disabled with `heartbeat: false` (recommended only for test/debug).
`backoff`: if `runOnce()` claims no job, the next poll interval starts at `pollMs` and grows ×2 (cap `maxPollMs ?? pollMs*32`); it resets to `pollMs` once a job is claimed — prevents a poll storm on an empty queue. `backoff: false` reverts to the old constant-interval behavior.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
