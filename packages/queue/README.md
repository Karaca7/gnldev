# @gnldev/queue

**Durable background-task queue + worker** on top of the journal. Each job runs as a durable run → if the process crashes mid-job, it resumes **exactly-once**. `acquireRunLock` prevents two workers from running the same job concurrently.

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
// it needs the work store to lock jobs and the run journal to make the side effect exactly-once.
const worker = createWorker(storage, {
  // A bare `await sendEmail(...)` here is AT-LEAST-once: a crash after the send but before the
  // job is acked reclaims the lock and calls the handler again. Route through runDurable with a
  // stable runId, and the send happens once.
  'send-email': async (payload, ctx) =>
    runDurable({ runId: ctx.runId, journal: storage.runs, model, tools, prompt: '...' }),
});
await worker.runOnce();   // or worker.start() (poll loop)
```

## API
- `enqueue(work, type, payload, { id? }) → jobId` — `work` is `storage.work`
- `createWorker(storage, handlers, opts?) → { runOnce, start, stop }` — `opts`: `owner`, `ttlMs` (stale lock reclaim), `pollMs`, `maxAttempts`, `onError`, `backoff`, `maxPollMs`, `heartbeat`
- `JobCtx` gives the handler `{ journal, jobId, runId }` — the handler typically calls `runDurable({ runId, ... })` to make the side effect exactly-once.

## How it works
Jobs are written to an append-only log; the worker locks a job and runs it. Crash → lock goes stale → reclaim → handler runs again → `runDurable` resumes from the journal → **side effect happens exactly once**.

## Heartbeat + empty-poll backoff (both on by default)
`heartbeat`: if a job's handler runs longer than `ttlMs`, the lock TTL can expire before the handler finishes, letting a second worker take over the same job and run it twice — `createWorker` prevents this by `renew`ing the lock every `ttlMs/3` while the handler runs. If a real takeover is detected (fencing token mismatch), this worker does NOT WRITE `qdone`/`qfail`/`qatt`, so it doesn't clobber the result of the worker that took over. Can be disabled with `heartbeat: false` (recommended only for test/debug).
`backoff`: if `runOnce()` claims no job, the next poll interval starts at `pollMs` and grows ×2 (cap `maxPollMs ?? pollMs*32`); it resets to `pollMs` once a job is claimed — prevents a poll storm on an empty queue. `backoff: false` reverts to the old constant-interval behavior.
