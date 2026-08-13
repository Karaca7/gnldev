# @gnldev/scheduler

Cron, interval and one-shot triggers for durable workflows — with the guarantee that a scheduled
run fires **once**, even when several workers are polling the same schedule.

## Install

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

Two workers polling at the same moment do not both fire the job: the winner is decided by the same
run-lock the rest of the framework uses, so the "exactly once" property comes from the journal
rather than from careful timing.

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
