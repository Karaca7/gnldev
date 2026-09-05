# @gnldev/workflow

**Durable deterministic workflows** — each step journaled exactly-once; crash → resume picks up where it left off. Control flow: `then` / `parallel` / `branch` / `foreach` / `loop`. Suspendable: `runResumable` + `sleep` / `waitFor` (evented + scheduled).

> **Not on npm yet** — no `@gnldev/*` package has been published. Until the first release, use it from a [repo clone](https://github.com/Karaca7/gnl-framework): `pnpm install && pnpm -r build`.

```bash
npm i @gnldev/workflow   # journal: @gnldev/durable
```

```ts
import { workflow, step } from '@gnldev/workflow';
import { SqliteStorage } from '@gnldev/durable/sqlite';

const fetchUser = step('fetchUser', async (id: number) => ({ id, name: 'Ada' }));
const greet = step('greet', async (u: { name: string }) => `Hello ${u.name}`);

const wf = workflow<number>().then(fetchUser).then(greet);

const out = await wf.run(1, { runId: 'w1', journal: new SqliteStorage('runs.db').runs });
// Crash → run again with the same runId → completed steps come back from the journal, continuing where it left off.
```

## API
- `workflow<I>()` → builder: `.then(step)` · `.parallel([a, b])` · `.branch(pred, ifStep, elseStep)` · `.foreach(...)` · `.loop(...)`
- `step(id, async (input, ctx) => out)` — every step journaled (exactly-once)
- `wf.run(input, { runId, journal })` — one-shot
- `wf.runResumable(input, ctx)` — for suspending steps (`sleep` / `waitFor`); suspends with `WorkflowSuspended`, resumes on event/time.

## How it works
Each step's output is journaled under `${runId}:wf:${stepId}` → the step doesn't rerun on replay. `parallel` sub-steps are journaled individually; `branch`/`loop` preserve deterministic replay.

## Side-effect steps (the crash window, closed)

Plain steps journal their output AFTER running — a crash between an external effect (an HTTP POST, a
charge) and the journal write leaves no record, and the resume re-fires the effect. Declare the
effect and the engine writes a **write-ahead claim** before executing:

```ts
step('charge', async (input, ctx) => {
  // ctx.idempotencyKey === `${runId}:wf:charge` — carry it to the provider (Stripe Idempotency-Key)
  // and the journal's exactly-once extends downstream.
  return chargeCard(input, { idempotencyKey: ctx.idempotencyKey });
}, {
  sideEffect: true,
  recover: async (input, { idempotencyKey }) => {         // the crash-window answer: ask the provider
    const found = await lookupCharge(idempotencyKey);
    return found ? { done: true, output: found } : { done: false };
  },
  claimTtlMs: 60_000,   // presume in-flight this long; calibrate ABOVE the step's worst case
});
```

Resume state machine: output present → replay; claim absent → run; claim live → `StepRetryBlockedError`
(`state: 'in-flight'`, clears by itself); claim stale or the attempt threw → `recover` is asked first —
`{done:true}` journals the found output without re-running, `{done:false}` re-runs safely; no `recover` →
`'unresolved'`: the engine refuses to guess. Manual exits for `'unresolved'`: effect LANDED →
`journal.put(detail.key, output)`; effect NEVER fired → `journal.put(detail.key + ':_claim',
{ startedAt: Date.now(), released: true })`. A clean suspend re-runs on resume (the documented
contract); `retry()` carries the declaration and consults `recover` BETWEEN in-process attempts —
without `recover`, a side-effect step's first throw propagates instead of blind-re-firing.
Combinators (`parallel`/`branch`) carry the declaration through; `foreach`/`loop` bodies are bare
functions with NO durability surface — put the effect in a `step(..., { sideEffect: true })` inside a
nested workflow (`asStep`) if an iteration needs the claim protocol.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
