# @gnldev/workflow

**Durable deterministic workflows** — each step journaled exactly-once; crash → resume picks up where it left off. Control flow: `then` / `parallel` / `branch` / `foreach` / `loop`. Suspendable: `runResumable` + `sleep` / `waitFor` (evented + scheduled).

```bash
npm i @gnldev/workflow   # journal: @gnldev/durable
```

```ts
import { workflow, step } from '@gnldev/workflow';
import { SqliteJournal } from '@gnldev/durable/sqlite';

const fetchUser = step('fetchUser', async (id: number) => ({ id, name: 'Ada' }));
const greet = step('greet', async (u: { name: string }) => `Hello ${u.name}`);

const wf = workflow<number>().then(fetchUser).then(greet);

const out = await wf.run(1, { runId: 'w1', journal: new SqliteJournal('runs.db') });
// Crash → run again with the same runId → completed steps come back from the journal, continuing where it left off.
```

## API
- `workflow<I>()` → builder: `.then(step)` · `.parallel([a, b])` · `.branch(pred, ifStep, elseStep)` · `.foreach(...)` · `.loop(...)`
- `step(id, async (input, ctx) => out)` — every step journaled (exactly-once)
- `wf.run(input, { runId, journal })` — one-shot
- `wf.runResumable(input, ctx)` — for suspending steps (`sleep` / `waitFor`); suspends with `WorkflowSuspended`, resumes on event/time.

## How it works
Each step's output is journaled under `${runId}#${stepId}` → the step doesn't rerun on replay. `parallel` sub-steps are journaled individually; `branch`/`loop` preserve deterministic replay.
