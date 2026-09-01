# @gnldev/scheduler

Cron, interval and one-shot triggers for durable workflows. Several workers can poll the same
schedule: a run-lock picks one winner per fire and every write to the trigger's state is CAS-fenced,
so a slot is never double-advanced or rolled back — see [the lock section](#lock-ttl-and-what-once-covers)
for what that does and does not promise about the workflow body.

## Install

> **Not on npm yet** — no `@gnldev/*` package has been published. Until the first release, use it from a [repo clone](https://github.com/Karaca7/gnl-framework): `pnpm install && pnpm -r build`.

```bash
npm i @gnldev/scheduler
```

## Schedule something

```ts
import { scheduleWorkflow, createScheduler, pollScheduler } from '@gnldev/scheduler';

await scheduleWorkflow(journal, {
  id: 'nightly-invoices',
  cron: '0 3 * * *',
  name: 'invoices',          // the workflow name handed to runner.runWorkflow
});

// in your worker loop. The runner is an object with runWorkflow — createGnl() is one.
setInterval(() => pollScheduler(journal, gnl), 30_000);
```

## Lock TTL and what "once" covers

Two workers polling at the same moment do not both fire the trigger: `acquireRunLock` picks one
winner, and every write to the trigger's state is a CAS against the record that winner read when the
fire began. `fireCount`, `nextRunAt` and `attempts` can therefore only be advanced by the poller that
actually owns the fire — a poller that lost the lock cannot roll them back or resurrect a stale
attempt count. The property comes from the journal rather than from careful timing.

`lockTtlMs` (default **60 s**, on both `pollScheduler` and `createScheduler`) is how long that lock is
held. It is renewed every `lockTtlMs / 3` for as long as the workflow is in flight, so a run that
takes longer than the TTL keeps its lock. That renewal is not cosmetic: the TTL used to be fixed and
never renewed, so *any* workflow running longer than 60 s let its lock expire and a second poller
re-fired the same trigger. Raise `lockTtlMs` if your triggers are long and your journal is slow;
lowering it makes a genuinely dead worker's fire reclaimable sooner.

**Known limit — the fencing covers the state write, not the execution.** A `renew` that fails is
logged and nothing else; `pollScheduler` does not abort the workflow it already started. So if the
lock does expire anyway — a stalled or paused process, a clock jump, a journal outage that outlasts
the TTL — a second poller can take the fire over and call `runner.runWorkflow` with the **same**
`runId` while the first is still inside it. The CAS then discards the loser's state write, so the
schedule stays correct; it does not undo what the loser's workflow did. This is measured, not
theoretical: in `test/scheduler-lock-fence.test.ts` both pollers run `sched:<id>:<fireCount>`.

What keeps that from becoming a duplicated side effect is the run, not the scheduler. Because both
attempts share one `runId`, each workflow step reads its output from the journal first and only the
first writer's result is kept (`claim`), so the two attempts converge on one recorded result — and a
step built on `runDurable`/`durableTool` is exactly-once for real. A plain step's body, however, still
executes in both pollers. Read the guarantee as *"the schedule advances once and the journal records
one result"*, not as *"two workers can never run the same job at the same time"*, and write steps that
touch the outside world to be idempotent — the same rule `@gnldev/queue` and `@gnldev/events` state.

## Time is data

A trigger's next fire time is **resolved and then frozen** into the journal, not recomputed on each
poll. A worker that wakes up late fires the run it owed rather than silently skipping it, and a
replay sees the same schedule the original run saw.

## Exports

| Export | What it is |
|---|---|
| `scheduleWorkflow` | Registers a cron / interval / `at` trigger |
| `pollScheduler` | Fires whatever is due; call it from a loop or a cron container |
| `listTriggers` | Everything currently registered |
| `createScheduler` | The stateful wrapper, if you would rather hold an object than call functions |
| `nextCronTime`, `parseField` | The cron arithmetic, exported for testing and for building your own UI |
| `createWorkflowWaker` | Wakes a suspended workflow when its sleep or wait elapses |

## License

Apache-2.0 — see [LICENSE](./LICENSE).
