# @gnldev/durable

**Exactly-once + deterministic-replay durability for [Vercel AI SDK](https://sdk.vercel.ai) agents.**

Wraps the AI SDK's agent loop (`generateText`/`streamText`) **without changing it**; after a crash/restart
it guarantees that tools **never run again** (exactly-once) and that the agent **makes the same decisions**
(deterministic replay). The one thing neither other agent frameworks nor plain AI SDK give you structurally:
**correctness.**

```bash
npm i @gnldev/durable ai @ai-sdk/anthropic
```

## Durability in 2 lines

```ts
import { runDurable } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { anthropic } from '@ai-sdk/anthropic';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';

const chargeCard = tool({
  description: "Charge the customer's card",
  inputSchema: z.object({ amount: z.number() }),
  execute: async ({ amount }) => paymentApi.charge(amount),
});

const res = await runDurable({
  runId: 'order-123',                      // ← idempotency key (orderId/sessionId)
  journal: new SqliteStorage('runs.db').runs,   // ← state lives here
  model: anthropic('claude-opus-4-8'),
  tools: { chargeCard },
  stopWhen: stepCountIs(10),
  prompt: 'Process the order',
});
```

If the process crashes mid-turn, **call again with the same `runId`** → it resumes where it left off, the
card is never charged a second time:

```ts
const res = await runDurable({ runId: 'order-123', journal, model, tools, prompt: 'Process the order' });
```

> **What "never charged twice" actually means (audit D3):** the guarantee is **at-most-once**. If a step
> already completed, it's replayed and skipped. But if the crash lands in the narrow window *after* the
> charge executed and *before* its success was journaled, resume can't know whether the charge went
> through — so for a side-effect tool with no `recover()` and no `idempotent`/approval, it does **not**
> silently re-run and does **not** silently continue: it **blocks and asks a human** (`SideEffectRetryBlockedError`,
> surfaced in `result.interrupts`). Safe direction (never a double charge), but resume is not always seamless
> — supply `tool.recover?()` (re-checks the provider) to auto-resolve that window without a human.

If you know `generateText`, you already know this — same arguments, same return type. The only addition:
`runId` + `journal`.

## How it works

- **`durableTool`** — wraps a tool's `execute`. The key is the `toolCallId` the AI SDK assigns; on replay
  the model response is reproduced verbatim, so the same id is generated → a tool that already succeeded
  **never runs again**.
- **`withDurableModel`** — via a `wrapLanguageModel` middleware, records every model response to the
  journal and replays it on resume → the agent reproduces the same tool chain.
- **`Journal`** — an append-only log. `InMemoryJournal` (dev) · `SqliteStorage().runs` (prod, `node:sqlite`,
  zero native dependencies).

> Guarantee: a side effect is **never repeated for the same `toolCallId`** (call-scoped, replay/resume-safe).
> Not "the LLM always produces the exact same text" — if there's a recorded entry, it's replayed; everything
> past the crash point runs live. A call whose outcome is unknown (after a crash/timeout) is first checked
> against the provider via `tool.recover?()`; if it's still unknown, the system **blocks and asks for
> approval instead of silently retrying** (see "Human-in-the-loop").
>
> **Scope caveat (important):** the default dedup is keyed by `toolCallId`. If the model re-plans the *same
> business action* under a **new** `toolCallId` (with identical or slightly different args — a
> documented AI SDK pattern), the call-scoped guard does **not** collapse it: the default `limits.sideEffectDuplicates`
> is `'warn'`, which logs the duplicate but still **executes** it. For a true "this action happens once"
> guarantee across re-plans, opt into `idempotency: 'args'` / `idempotencyKey` (next section) or set
> `limits.sideEffectDuplicates` to `'block'`/`'suspend'`. The 2-line quick-start example is call-scoped only.

## LLM-aware idempotency (`idempotency: 'args'`)

Call-keyed exactly-once (the default above, keyed by `toolCallId`) is blind to one real-world case: the
model re-planning the *same* work under a **brand-new** `toolCallId` (a documented pattern — the same tool
called 5× in one turn). Opt in per tool and GNL keys the journal by the **arguments** instead:

```ts
const tools = {
  charge: {
    idempotency: 'args',                       // default: 'call' (toolCallId-keyed, unchanged)
    // or dedup by a logical key: idempotencyKey: (args) => args.orderId,
    execute: chargeCard,
  },
};
```

> **Same-key only (important — audit D2):** `idempotency: 'args'` collapses calls that hash to the *same*
> key. It cannot dedup a genuinely *different* action key: `refund({orderId:'123'})` and
> `refund({orderId:'123', note:'retry'})` hash differently → **two refunds**. "Exactly-once" here means
> "once per identical key", not "once per business intent". When the model may vary an irrelevant field,
> supply an `idempotencyKey` that projects out only the fields that define the action (e.g.
> `idempotencyKey: (args) => args.orderId`) so the varying `note` no longer splits the key.

Every duplicate — including concurrent duplicates inside the same step, which wait for the winner's
result instead of erroring — collapses into a single execution; the rest receive the journaled output.
The dedup window is run-scoped by default. Opt into `idempotencyWindow: 'cross-run'` to make the same
arguments (or logical key) execute once across **all** runs — retried jobs and re-triggered agents
included. Cross-run records live under the `xrun:` key prefix, outside any run's timeline: run
retention/sweep never touches them (purge explicitly with `journal.deletePrefix('xrun:')`), and
`withOrg` isolation still applies. Proof tests: `test/args-idempotency.test.ts` (reproduces the
duplicate-toolCallId pattern end-to-end) and `test/cross-run-idempotency.test.ts`.

## Governance (policy)

The LLM sees all tools and reasons freely; policy only gates **execution**:

```ts
await runDurable({
  runId, journal, model, tools, prompt,
  guard: ({ toolName, args }) => {
    if (toolName === 'chargeCard' && args.amount > 1000) return { action: 'require-approval' };
    return { action: 'allow' };
  },
});
```

- `deny` → the tool doesn't run, the model gets "not permitted" back (the LLM corrects itself).
- `require-approval` → the run is suspended; `result.interrupts` comes back populated.

## Human-in-the-loop (suspend / resume)

```ts
const r = await runDurable({ runId, journal, model, tools, prompt, guard });
if (r.interrupts.length) {
  // ask the user… then approve and resume:
  await runDurable({ runId, journal, model, tools, prompt, guard, approvals: { [r.interrupts[0].toolCallId]: true } });
}
```

The approval decision is written to the journal as **first-class** (via `claim`, first decision wins):
even in the "approved but the process crashed before the tool ran" scenario, the decision is durable — the
next `runDurable` call applies the decision recorded in the journal even if the `approvals` parameter isn't
passed again.

## Streaming: catching blocked/limit protections

`runDurable` **throws** when a protection fires (loop / `maxToolCalls` / duplicate-side-effect /
tainted-side-effect block). `streamDurable` can't throw mid-stream — the block shows up as an internal
sentinel in `fullStream` (kept there deliberately: `@gnldev/server` / `@gnldev/agui` post-scan `steps` and
emit one terminal error event). As a **direct** consumer you still can't miss it:

```ts
const result = await streamDurable({ runId, journal, model, tools, prompt,
  limits: { maxToolCalls: 5 },
  onBlocked: (breach) => log.warn('protection fired', breach), // { kind, message, detail } — raw, structured
});
try {
  const text = await result.text; // REJECTS with the typed error (RunLimitExceededError, …) if a block fired
} catch (err) { /* mirror of runDurable's throw */ }
```

- `onBlocked` (also on `gnl.stream(name, { onBlocked })`) fires once at stream finish with the raw
  structured breach — you decide what to show your users. It's advisory: a throw from it is swallowed.
- `await result.text` (and the other terminal promises — `content`, `response`, `toolCalls`, …) reject
  with the same typed error `streamFinishError(steps)` would return. `steps`/`finishReason`/`usage` and
  `fullStream` itself deliberately never reject — the post-scan contract (`streamFinishError(steps)`)
  keeps working, which is what `@gnldev/server`/`@gnldev/agui` rely on.

## Composable (any agent framework / your own loop)

```ts
import { withDurableModel, durableTools } from '@gnldev/durable';
const model = withDurableModel(anthropic('claude-opus-4-8'), { journal, runId });
const tools = durableTools(myTools, { journal, runId });
// use these with your own generateText OR with another framework's agent
```

## Tools

- **`gnl chat`** — durable agent terminal REPL (crash & resume, inline tool/cost). `gnl chat --db runs.db`
- **`@gnldev/studio`** (separate package) — web UI: runs/timeline + **time-travel** + approval queue.
  `npx @gnldev/studio`

## Examples

```bash
npx tsx examples/no-double-charge.ts   # no API key needed (mock model) — exactly-once proof
```

## API

| | |
|---|---|
| `runDurable(args) → DurableResult` | Drop-in `generateText` + `journal`/`runId`/`guard`/`approvals`. Adds `.interrupts`. Optional `timeouts: { modelStepMs, toolMs, claimTtlMs }` — on timeout `StepTimeoutError` flows through the existing failed/retry/recover paths (opt-in, behavior unchanged if not provided). |
| `resume` | Alias for `runDurable`. |
| `withDurableModel(model, ctx)` / `durableTools(tools, ctx)` | Composable wrappers. |
| `InMemoryJournal` / `SqliteStorage` (`/sqlite`, journal at `.runs`) | Journal adapters. |
| `Guard`, `Interrupt`, `Journal`, `DurableResult` | Types. |

License: Apache-2.0 — see [LICENSE](../../LICENSE).

## Production deployment notes (exactly-once preconditions)

The exactly-once guarantee rests on one precondition: **storage never loses an acknowledged write**
(detailed analysis: `docs/CORE-HARDENING.md` §8). For multi-worker production:

- **Postgres (recommended `runs` backend):** run it with `synchronous_commit = on` +
  `synchronous_standby_names` (quorum). Under **asynchronous replication**, a primary failover can lose
  acknowledged CAS writes → the same tool can run twice.
- **Redis:** since replication is always asynchronous, it is NOT RECOMMENDED for `runs` (the replay
  journal) in failover setups — use `composite()` to keep `runs` on Postgres and use Redis for
  `work`/`cache` (this is also how the adapter's capability design is meant to be used).
- **SQLite:** meant for a single node; WAL mode gives sufficient filesystem durability.
- **Outbound side effects:** the strongest end-to-end defense is using a provider-side **idempotency
  key** on tool calls (see the pattern in `test/idempotency-key.test.ts`) — regardless of the storage
  layer, the external system rejects the duplicate.
