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
  // job is acked reclaims the lock and calls the handler again. Route it through the job's durable
  // run (`ctx.run`, a runDurable on a stable runId), and the send happens once.
  'send-email': async (payload, ctx) => ctx.run({ model, tools, prompt: '...' }),
});
await worker.runOnce();   // or worker.start() (poll loop)
```

## Jobs for an end user

A job can say whose it is. The job's run belongs to that owner, and the handler does not pass it on:
`ctx.run` starts the run as the owner.

```ts
import { enqueue, createWorker } from '@gnldev/queue';
import { InMemoryStorage, user } from '@gnldev/durable';
declare const model: import('@ai-sdk/provider').LanguageModelV4;

const storage = new InMemoryStorage();
await enqueue(storage.work!, 'weekly-summary', { week: 39 }, { caller: user('ayse', 'acme') });
// the same job, in the shorthand: { resourceId: 'ayse', orgId: 'acme' }

createWorker(storage, {
  // ctx.run = runDurable on the job's journal and runId, as the job's owner. Nothing to forget.
  'weekly-summary': async (payload, ctx) => ctx.run({ model, prompt: `Summarise week ${payload.week}` }),
});
```

- **Who the run is.** `ctx.caller` is read once from the owner recorded at `enqueue`: `user(id, org)`,
  `staff(org?)` when you enqueued with `caller: staff()`, else `unknown`. A job with no owner is never
  staff by omission — the same rule as `runDurable`.
- **Forgetting cannot give an ownerless run.** Before the handler runs, the worker records the job's
  owner as the owner of `ctx.runId`. A handler that still calls `runDurable({ runId: ctx.runId, … })`
  without the user, or with another user, is refused (`RunOwnerMismatchError`) — the job fails
  loudly instead of producing a run only staff can see.
- **A workflow instead of an agent:** `gnl.runWorkflow(name, input, { runId: ctx.runId, caller: ctx.caller })`.
- `ctx.journal` and `ctx.storage` are scoped to the job's organization. Build the organization's
  `createGnl` from `ctx.storage`.
- `retryJob` and `ctx.enqueue(type, payload)` keep the owner and the organization.
  Passing `ctx.storage.work` to `enqueue` is refused, since no worker polls that store.
- An explicit `id` is a name **within its owner**: two organizations (or two users) using `weekly-report`
  get two jobs. `enqueue` returns the stored id; use that one with `retryJob` and `listJobs`. A system
  job's id is kept as given.
- `maxDepth` is counted per organization, from a small per-organization index: its cost is
  `min(depth, maxDepth)` records of your own organization, not the whole shared queue.

### Upgrading a job that already exists

A job enqueued before it had an owner keeps its old id. Enqueuing it again with an owner would add a
second job, and both would run. Move it once, with the workers stopped:

```ts
import { moveJob } from '@gnldev/queue';
import { InMemoryStorage } from '@gnldev/durable';
const storage = new InMemoryStorage();

await moveJob(storage.work!, 'weekly-report', { orgId: 'acme' }); // → the owned id
```

The owned job takes over the old one's state (finished stays finished, a dead letter stays dead) and
the old one is marked done with `movedTo`. After that, `enqueue(…, { id: 'weekly-report', orgId: 'acme' })`
finds the moved job.

### Erasing a person

`jobEraser(storage)` removes one person's jobs: the records, the `qdone`/`qfail`/`qatt`/`qown` markers
(`qfail` holds the handler's error text), the worker's lease locks, and the job runs. Hand it to
`eraseSubject` from `@gnldev/durable` together with the other packages' erasers:

```ts
import { jobEraser } from '@gnldev/queue';
import { triggerEraser } from '@gnldev/scheduler';
import { eventEraser } from '@gnldev/events';
import { InMemoryStorage, eraseSubject, toJournal } from '@gnldev/durable';

const storage = new InMemoryStorage();
const journal = toJournal(storage.runs);
await eraseSubject(
  { journal, work: storage.work!, erasers: [jobEraser(storage), triggerEraser(journal), eventEraser(storage.work!)] },
  'ayse', { orgId: 'acme' },
);
```

The work store needs `deleteIdPrefix` and `deletePrefix`. A store without them makes the eraser throw,
rather than report a partial erasure as done.

## API
- `enqueue(work, type, payload, { id?, maxDepth?, caller?, resourceId?, orgId? }) → jobId` — `work` is `storage.work`.
  `caller` is an engine `Caller` (`user(id, org)`, `staff(org?)`); `resourceId`/`orgId` are its shorthand.
- `createWorker(storage, handlers, opts?) → { runOnce, drain, start, stop }` — `opts`: `owner`, `ttlMs` (stale lock reclaim), `pollMs`, `maxAttempts`, `onError`, `backoff`, `maxPollMs`, `heartbeat`
- `JobCtx` gives the handler `{ journal, jobId, runId, caller, run, storage, orgId?, enqueue }`. `ctx.run(args)` is
  `runDurable` on `journal`/`runId` as `caller` — it keeps the side effect at-most-once and the run the owner's.
- `listJobs(work)` shows each job's `resourceId`/`orgId` next to its status.
- `retryJob(work, id)` re-enqueues a dead letter for the same owner.
- `moveJob(work, id, owner)` gives a pre-upgrade system job its owner, without doubling it.
- `jobEraser(storage)` erases one person's jobs (see above).

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
