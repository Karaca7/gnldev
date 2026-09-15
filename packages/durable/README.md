# @gnldev/durable

**Call-scoped exactly-once effect + deterministic-replay durability for [Vercel AI SDK](https://sdk.vercel.ai) agents.**

Wraps the AI SDK's agent loop (`generateText`/`streamText`) **without changing it**. After a crash/restart a
completed tool call is **never executed a second time**, and the agent **makes the same decisions**
(deterministic replay). The one thing neither other agent frameworks nor plain AI SDK give you structurally:
**correctness.**

The precise guarantee is **at-most-once** for a side effect, because the crash window between executing a
tool and journaling its result cannot be closed by any client-side library — see [the callout
below](#what-never-charged-twice-actually-means). gnl's answer to that window is to refuse to guess: it
blocks and asks, rather than silently re-running or silently continuing.

> Install: `pnpm add @gnldev/durable` — the storage adapters ship inside the same package. (Or clone the [repo](https://github.com/Karaca7/gnldev) and `pnpm install && pnpm -r build`.)

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
  runId: 'order-123',                      // ← the id of THIS WORK — never a sessionId (see below)
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

> **One id is one JOB, never one session.** `runDurable` is the raw surface: the string you pass *is*
> the identity, so a `sessionId` or a conversation id there makes every later turn replay the first
> one forever. Through `createGnl` you name the work instead (`workKey`) and the engine derives the
> id — see [Work identity](#work-identity-workkey).

> <a id="what-never-charged-twice-actually-means"></a>
> **What "never charged twice" actually means:** the guarantee is **at-most-once**. If a step
> already completed, it's replayed and skipped. But if the crash lands in the narrow window *after* the
> charge executed and *before* its success was journaled, resume can't know whether the charge went
> through — so for a side-effect tool with no `recover()` and no `idempotent`/approval, it does **not**
> silently re-run and does **not** silently continue: it **blocks and asks a human**. Safe direction
> (never a double charge), but resume is not always seamless.
>
> Concretely, `runDurable` **throws** `SideEffectRetryBlockedError` — it does not come back in
> `result.interrupts`, which carries approval suspensions only. Catch it:
>
> ```ts
> import { SideEffectRetryBlockedError } from '@gnldev/durable';
>
> try {
>   await runDurable({ runId: 'order-123', journal, model, tools, prompt });
> } catch (e) {
>   if (e instanceof SideEffectRetryBlockedError) {
>     // e.detail.key names the tool call that is in doubt. Ask an operator, then re-run with
>     // approvals: { [toolCallId]: true } — or give the tool a recover() so this resolves itself.
>   } else throw e;
> }
> ```
>
> `recover()` is the way to avoid the human: it re-checks the provider and must return
> `{ done: true, output }` or `{ done: false }`. Any other shape is treated as "could not
> determine" and lands back on this same gate rather than re-running the effect.

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

## Work identity (`workKey`)

**A `workKey` is your name for a unit of work — not for a conversation.** While the run it opened
still exists, another call arriving with the same `workKey` in the same `workScope` is routed to that
run instead of starting a second one.

**Coming from `thread_id`?** There the same key means *continue this conversation*. Here the same key
means *this is the same job*: reuse a `workKey` to **retry** work, never to add a turn. A conversation
is `threadId` — a different field, and you can use both at once.

A `workKey` is a **business name** (the invoice being issued, the document being published, the
firmware rollout for device 7742, tonight's reconciliation batch), not a random retry token. Keep
sensitive data out of it — a `workKey` is echoed in error bodies and shown on Studio screens.

```ts
const gnl = createGnl({
  journal,
  agents: {
    // Default. The job belongs to a PERSON: Ayşe's `invoice-4471` and Mehmet's `invoice-4471` are
    // two jobs, because the subject is part of the identity.
    billing: { model, workScope: 'resource' },
    // The job belongs to the INSTALLATION: tonight's reconciliation runs once, whichever of six
    // workers woke up first.
    reconcile: { model, workScope: 'org' },
  },
});

await gnl.run('billing', {
  workKey: 'invoice-2026-04-7742',   // your name for the job
  resourceId: 'u-142',               // the address it is unique WITHIN ('resource' scope)
  prompt: 'Issue the April invoice',
});
```

Pass **either** a `workKey` **or** a `runId`, never both — two identities for one call is a question
with no honest answer. A raw `runId` is still first-class and always will be: `runDurable`,
`resumeRun`, `forkRun` and `streamDurable` take an id, because resume and fork cannot reverse a hash.

### The id you get back

`runId = derive(entityName, workScope, subject, workKey)` — a 128-bit digest behind a `run1_` prefix.
`@gnldev/server` and `@gnldev/chat-adapter` return it in the `X-Gnl-Run-Id` response header;
`@gnldev/agui` carries it in the AG-UI event envelope instead, because that route's answer is a
stream of events and the id belongs on the run's own `RUN_STARTED`, not beside it. In process,
compute it from the same four inputs:

```ts
import { derivedRunId } from '@gnldev/durable';

// NOTE THE `agent:` PREFIX — it is part of the entity name, not decoration.
const id = derivedRunId('agent:billing', 'resource', 'u-142', 'invoice-2026-04-7742');
// 'run1_<32 hex>' — and the same four inputs always produce the same id
```

**The entity name carries a TYPE prefix**: `agent:<name>` for the agent doors, `wf:<name>` for
`runWorkflow`. A workflow and an agent may share a registry name, and without the prefix `pay` the
pipeline and `pay` the agent would derive ONE id from one `workKey` — two unrelated jobs meeting in
a single run. If you compute an id yourself to look one up, use the prefix the engine used.

Three consequences worth knowing before you rely on it:

- **`runId` is a stable *pseudonym* of your `workKey`, not an anonymisation of it.** A low-entropy
  key (`invoice-1`, `order-42`) is recoverable by dictionary, and under GDPR the id keeps whatever
  personal-data status the key had. Treat the digest as a pseudonym, not as a scrub.
- **The agent's name is part of the identity.** Two agents cannot collide on one `workKey` — and
  renaming an agent breaks the resume of its half-finished runs, because the id no longer derives.
- **Collisions die structurally; secrecy does not.** Anyone can compute the digest offline. What
  stops a guessed id from being read is the ownership gate, not the hash.
- **A shape-valid impersonation is indistinguishable.** A caller who knows all four inputs produces
  the same id a legitimate caller would, and the engine cannot tell the two apart — the protection
  is the ownership gates, not the derivation; and a slot that already exists is skipped by rollover,
  never re-born into.

### What happens on the second call

Two axes, whose names are fixed even though v1 gives each exactly one behaviour — there is no field
to set yet, and inventing a single-valued enum would be furniture. The names live here so that
tomorrow's second value is an addition rather than a break.

| Axis | v1 value | The second call gets |
| --- | --- | --- |
| `onConflict` | `'reject'` | The work is **running right now** → `409 run_busy` + `Retry-After`. |
| `onReuse` | `'replay'` | The work already **finished** → the recorded answer, nothing re-runs. |

**What makes `run_busy` possible is a lock, and a lock has a TTL.** "Running right now" is not
inferred from the journal's contents — it is a per-run lock (`lock: { ttlMs }`, default 300 000 ms)
taken before the run starts and renewed by a heartbeat while it lasts. Two consequences follow, and
they are the shape of the guarantee rather than caveats to it: a process that dies without releasing
holds the run only until the TTL expires, after which a retry is admitted and replays from the
journal; and a run that legitimately outlives its TTL keeps the lock alive by heartbeat, so the TTL
bounds crash recovery, not run length.

- **A run that ended in FAILURE has no answer to replay, so the same `workKey` is free to run
  again.** This is a rule, not a footnote: retrying failed work is the normal case, not an escape
  hatch.
- The third collision class keeps its own name: **`strictInput`** — same key, different content →
  `409 run_input_mismatch`. Inside the `run1_` space it is unconditional, with no opt-out: the
  caller did not choose that id, so "use a fresh runId" was never advice they could act on.

### How long a `workKey` stays unique

**As long as the run record lives — not a minute longer.** Recognition is a property of the stored
run, not of the text. The moment a sweep deletes that run, the key is a stranger again.

So the number to set is not "how long do I want history"; it is a comparison: **your retention window
should not be shorter than the longest retry your clients can produce.** If you cannot promise that,
open the tombstones (`tombstones: true` + `tombstonePolicy: 'reject'`) — a late retry is then refused
with `409 run_swept` instead of quietly starting the job over. A tombstone is a refusal, not an
answer, and it stores only a **hash** of the key.

## LLM-aware idempotency (`idempotency: 'args'`)

Call-keyed exactly-once (the default above, keyed by `toolCallId`) is blind to one real-world case: the
model re-planning the *same* work under a **brand-new** `toolCallId` (a documented pattern — the same tool
called 5× in one turn). Opt in per tool and GNL keys the journal by the **arguments** instead:

```ts
import { gnlTool } from '@gnldev/durable';
import { tool } from 'ai';

const tools = {
  charge: gnlTool(
    tool({ description: 'Charge an order', inputSchema: z.object({ orderId: z.string() }), execute: chargeCard }),
    {
      idempotency: 'args',                       // default: 'call' (toolCallId-keyed, unchanged)
      // or dedup by a logical key: idempotencyKey: (input) => input.orderId,
    },
  ),
};
```

> **Same-key only (important):** `idempotency: 'args'` collapses calls that hash to the *same*
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
`withOrg` isolation still applies — including the `options.idempotencyKey` handed to your tool and forwarded to the provider, which carries the org so two organizations using the same `orderId` do NOT collapse into one charge at Stripe. Proof: `test/cross-run-org-key.test.ts`. Proof tests: `test/args-idempotency.test.ts` (reproduces the
duplicate-toolCallId pattern end-to-end) and `test/cross-run-idempotency.test.ts`.

### Conversation-scoped dedup (`idempotencyWindow: 'thread'` + thread-scoped duplicate marker)

"This thread already created that product YESTERDAY, in another run" is invisible to run-scoped
dedup. Two conversation-scoped tools close it, both living under `xthr:<threadId>:` so ONE
`purgeThread` sweep reclaims the thread's whole dedup state (no immortal cross-run keys):

```ts
// Deterministic business key, silent dedup ACROSS RUNS of one conversation (Stripe semantics):
gnlTool(tool({ inputSchema: z.object({ orderId: z.string() }), execute: async () => ({ ok: true }) }),
  { sideEffect: true, idempotencyWindow: 'thread', idempotencyKey: (a: any) => a.orderId });

// LLM-shaped args where silence would be wrong — the ambiguous repeat becomes a HUMAN question
// carrying the first result's address (firstToolCallId). This one is a RUN option, not a tool one:
const limits = { sideEffectDuplicates: { action: 'suspend', scope: 'thread' } };
```

Use the right layer: silent windows are for DETERMINISTIC business keys, where dedup is
unambiguously correct. For LLM-derived raw args an identical-looking second request may be a genuine
second intent — that case belongs to the suspend ladder (or the semantic gate below), where a human
answers. No default TTL, deliberately: a false positive costs one extra question, a false negative
fires the effect twice (`ttlMs` opts in). Records need a `threadId` at call time — absent one, the
window falls back to run scope LOUDLY. `toolPolicy: 'strict-critical'` raises the bar one rung:
every `sideEffect: true` tool must answer the crash window with `recover()` or a deterministic
`idempotencyKey`, or the run refuses to start.

## Governance (policy)

The LLM sees all tools and reasons freely; policy only gates **execution**:

```ts
await runDurable({
  runId, journal, model, tools, prompt,
  guard: ({ toolName, args }) => {
    // `args` is `unknown`: the guard sees every tool's arguments, so narrow before reading one.
    const { amount } = args as { amount?: number };
    if (toolName === 'chargeCard' && (amount ?? 0) > 1000) return { action: 'require-approval' };
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

**`confirm` — the tool's own first-call human gate.** For a tool consequential enough to ask a human
EVERY fresh call, declare it on the tool itself — no guard factory to remember (a two-step ceremony
where forgetting the factory leaves the flag silently unenforced is exactly the failure class this
replaces):

```ts
gnlTool(tool({ inputSchema: z.object({ amount: z.number() }), execute: async () => ({ ok: true }) }), {
  sideEffect: true,
  confirm: { reason: (args: any) => `charge ${args.amount} to card — confirm?` },  // or just `true`
});
```

The fresh call suspends with the standard sentinel into the SAME approvals flow (Studio inbox, the
chat `approve()` helper); deny writes a terminal denied record; a pre-supplied approval skips the
gate and still meets the guard. Scope: per toolCallId — a model issuing a new call asks again. A
crashed (`failed`/`running`) attempt is NOT re-asked "confirm before it runs" — that state belongs to
the recover/reclaim ladder, which knows the effect may already have fired.

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

- **`@gnldev/studio`** (separate package) — web UI: runs/timeline + **time-travel** + approval queue.
  `npx @gnldev/studio --db runs.db` — point it at the journal you passed to `runDurable`.
  With a config file instead (`--config gnl.config.ts`) it also serves the Playground. Bare
  `npx @gnldev/studio` has nothing to read and prints its usage.

## Examples

```bash
npx tsx examples/no-double-charge.ts   # no API key needed (mock model) — at-most-once proof
```

## API

| | |
|---|---|
| `runDurable(args) → DurableResult` | Drop-in `generateText` + `journal`/`runId`/`guard`/`approvals`. Adds `.interrupts`. Optional `timeouts: { modelStepMs, toolMs, claimTtlMs }` — on timeout `StepTimeoutError` flows through the existing failed/retry/recover paths (opt-in, behavior unchanged if not provided). |
| `resumeRun(args)` | Resume a suspended run: reads the prompt and the frozen limits back from the journal, so the resumed turn runs under the same bounds as the original. NOT an alias for `runDurable` — that name never existed. |
| `withDurableModel(model, ctx)` / `durableTools(tools, ctx)` | Composable wrappers. |
| `InMemoryJournal` / `SqliteStorage` (`/sqlite`, journal at `.runs`) | Journal adapters. |
| `Guard`, `Interrupt`, `Journal`, `DurableResult` | Types. |
| `resolveModel(spec)` / `registerModelProvider(prefix, factory)` | Turns `'provider/model'` into a model, lazily importing the provider package. Four prefixes ship built in (`openai`, `anthropic`, `google`, `mistral`); a host teaches it more — see below. |

### Your own provider (OpenAI-compatible endpoints)

An endpoint that speaks the OpenAI API — NVIDIA NIM, Together, vLLM, Ollama, a gateway, a local
server — is not one of the four built-in prefixes, so `resolveModel('nvidia/…')` does not know it
until the host says so:

```ts
import { createOpenAI } from '@ai-sdk/openai';
import { registerModelProvider } from '@gnldev/durable';

// `.chat(id)`, NOT `createOpenAI({...})(id)`. The bare call returns the RESPONSES model, and these
// servers speak /chat/completions — the wrong one fails as a 404 from your own endpoint.
const unregister = registerModelProvider('nvidia', (modelId) =>
  createOpenAI({ baseURL: 'https://integrate.api.nvidia.com/v1', apiKey: process.env.NVIDIA_API_KEY })
    .chat(modelId));
```

After that, `'nvidia/meta/llama-3.1-70b-instruct'` resolves everywhere a model string is accepted —
agent config, the Studio playground, a fallback chain. The returned function unregisters it, so a
test can add one without leaking it into the next.

Two things the router enforces, so a host does not have to:

- **Prefixes are lowercase words.** `' openai'`, `'OPENAI'` and `'openai '` are refused rather than
  normalised: two spellings of one name resolving through different factories in the same process is
  a difference nothing on screen would show.
- **Model ids are checked before they reach your factory.** That string arrives from an HTTP body in
  Studio, and a factory typically puts it in a request URL under your credentials — so `'../../etc'`,
  a whole URL, or anything with a newline is refused at the boundary rather than passed on.

License: Apache-2.0 — see [LICENSE](../../LICENSE).

## Critical profile (`preset: 'critical'`)

The banking/defense/medical bundle as ONE opt-in switch — explicit opts still win field by field:

```ts
const gnl = createGnl({ journal, agents, preset: 'critical' });
// = toolPolicy 'strict-critical' + sideEffectDuplicates {action:'suspend', scope:'thread'} + exclusiveModelStep
//   + an automatic per-run lock (ttl 300s) + strictInput + actor binding + conflictLedger
//   + tombstonePolicy 'reject'
```

What each protection answers, in one line each:

- **`strictInput`** — one runId carries ONE request: the raw caller input is fingerprinted at freeze
  time; the same runId arriving with different content gets `409 run_input_mismatch` (Stripe's
  "same key, different payload" semantics — the *rule* is Stripe's, the *status* is ours: Stripe
  answers 400, we answer 409, because a conflict is what this is). Legitimate flows stay open: driving the run with its own
  frozen content is a replay, and an approval addressing any journaled toolCallId admits the
  re-POST — even retried after the record turned terminal.
- **`actor`** — the runId binds to its first caller (first-wins); a different actor re-driving it
  gets `409 run_actor_mismatch`. No actor on either side = no check: an auth-less deployment has no
  protection here, stated rather than silent.
- **`conflictLedger`** — every refusal (busy / thread / input / actor / swept) appends an
  `idem:conflict:*` record: codes, **key hashes** and the actor id, never content. Say it precisely,
  because the difference has legal weight: a hashed `workKey` is a **stable pseudonym**, not an
  anonymisation — a low-entropy key is recoverable by dictionary, and the record keeps whatever
  personal-data status the key itself had. The family lives OUTSIDE
  the run's sweep prefix — the audit's subject cannot erase its own refusal history. Read it with
  `readIdemLedger(journal)`, which THROWS without `listKeys` rather than lying with an empty answer.
- **`auditOnReject: 'require'`** — the conflict-ledger append becomes a PRECONDITION of the
  refusal: if the audit store cannot record the "no", the caller gets the audit error, never an
  unrecorded 409. Default `'best-effort'` (the refusal always lands; a failed append warns).
- **`tombstonePolicy: 'reject'`** — a retention-swept runId's late retry is refused
  (`409 run_swept`) instead of silently re-running side effects whose dedup window died with the
  journal. Pair with `sweepRuns({ tombstones: true })`; the REAL contract stays: retention window ≥
  client retry horizon. `sweepRuns({ suspendedTtlMs })` gives abandoned suspended runs an expiry so
  they stop accumulating forever.

Journal guidance: prefer Postgres. On Redis, configure
`waitReplicas: { replicas: 1, timeoutMs: 1000, onTimeout: 'throw' }` and know the honest bound — the
throw fires AFTER the write, so an unacknowledged claim becomes visible, not undone; treat thrown
claims as a reconciliation suspect list. And the single-home bound, restated where it matters: every
guarantee above spans any number of workers on ONE journal store; two regions with independent
journals are two independent dedup windows — route a runId to its home journal. Scope stated
honestly: the preset wraps `run()`/`stream()`; `runWorkflow()`/`runNetwork()` entry paths are not
covered yet — apply protections there explicitly.

**The decision hierarchy, which every layer here serves:** deterministic (work identity, unique
constraints, fingerprints) > human gate (`confirm`, suspend ladders) > probabilistic (semantic
candidates, working memory). **`workKey` sits at the top of the deterministic layer** — it is the
run-level answer to "is this the same job?", settled by exact equality before any tool runs, and the
semantic gate below never overrides it. And the recipe that no framework can automate away: give critical tools
a **read-before-write** sibling (`createProduct` ↔ `findProduct`) so the agent checks the system of
record before acting — and for the same-key half, the framework leg exists: a tool-level
`lookup(input, { idempotencyKey })` hook is consulted before the FIRST attempt of a side-effect tool
(`{exists: true, output}` journals the found result without firing; a throw is fail-open with a loud
warn). `lookup` answers BEFORE the first attempt; `recover` answers the crash window AFTER a failure
— distinct on purpose — the source of truth is never the conversation, and the LAST line of defense
is always a unique constraint or upsert in the external system itself.

## Semantic duplicate-candidate gate (`sideEffectDuplicates.semantic`)

**The honest claim, verbatim:** this layer finds past side-effect work that LOOKS similar in meaning
("create product ABC" said two different ways — where hash-based dedup is blind) and, ONLY when the
deterministic field comparison also matches (tool name, identity fields, amount fields), puts the
first result next to an approval question. It never silently skips, blocks or tells the model
"already done" on your behalf; the final word is always deterministic field equality + a human. It is
best-effort and fail-open: if your embedder is unreachable or no candidate clears the bar, behavior
is today's behavior — no regression, and no guarantee either. Decision hierarchy: deterministic >
human gate > probabilistic — this layer is the third class serving the first two as a candidate
finder. Which also fixes where it sits relative to run identity: a run's `workKey` is settled by
exact equality before any tool executes, and nothing on this layer can turn two work names into one
job or one work name into two.
It does not replace layers 1-4 (hash/claim/confirm/critical); it runs beneath them, and it
refuses to start where no approvals channel exists. The quality of your `semanticIdentity.keys`
declaration IS the quality of the protection.

```ts
// Double opt-in: the run-level block AND the tool-level declaration — either absent, layer inert.
const limits = {
  sideEffectDuplicates: {
    action: 'suspend', scope: 'thread',            // required — config-time throw otherwise
    semantic: {
      embed: myEmbed,                              // (texts: string[]) => Promise<number[][]>
      embedModelId: 'text-embedding-3-small',      // required stamp — mixed-model cosine is meaningless
      minSimilarity: 0.6,                          // candidate threshold (recall side; misses are safe)
    },
  },
};

const createProduct = gnlTool(tool({
  inputSchema: z.object({ sku: z.string(), price: z.number(), cancel: z.boolean().optional() }),
  execute: async () => ({ ok: true }),
}), {
  sideEffect: true,
  semanticIdentity: {
    keys: ['sku'],                                 // the business identity — REQUIRED, non-empty
    amountFields: ['price'],                       // identity-equal + amount-differ → its own question
    discriminatorFields: ['cancel'],               // negation gate: differ → deterministically not a duplicate
    describe: (args: any) => `create product ${args.sku}`, // the PII boundary: ONLY this reaches the embedder
  },
});
```

**Local, in-process embeddings (recommended for the critical profile — nothing leaves the machine).**
The `embed` contract is provider-agnostic; a ~240MB multilingual model behind it removes the API
bill, the rate limit AND the PII question in one move:

```ts
// npm i @huggingface/transformers   (~150-400MB RAM at runtime, ~5-20ms per short sentence on CPU)
import { pipeline } from '@huggingface/transformers';
const extractor = await pipeline('feature-extraction', 'Xenova/multilingual-e5-small', { dtype: 'q8' });
const embed = async (texts: string[]) => {
  // e5 family quirk: inputs want a "query: " prefix — bake it into the adapter, never into callers.
  const out = await extractor(texts.map((t) => `query: ${t}`), { pooling: 'mean', normalize: true });
  return out.tolist();
};
// embedModelId: 'local:multilingual-e5-small@q8'  ← stamp the QUANTIZATION too — a re-quantized
// model produces different vectors, and the stamp is what keeps old records out of the comparison.
// The same closure serves @gnldev/memory's semantic recall — one model, both jobs.
```

Cost model (documented so the bill is never a surprise): ~1 embed call per guarded side-effect call
on the happy path (the recall-side vector is cached by args hash and reused for the write). Records
live in YOUR journal under `xthr:<threadId>:` (~3KB each, no vector DB, no index) and die with the
thread in the same `purgeThread` sweep as everything else. Not written on failed/suspended work;
`ttlMs` on the parent block ages records out of consideration. Named TOCTOU bound: two CONCURRENT
paraphrase twins (different hashes, same identity, in flight together) cannot see each other's
records — both run; this layer's promise is duplicates SEPARATED IN TIME, concurrency belongs to the
exact-hash/lock layers below. What this feature is NOT (binding for
docs and marketing alike): not a "meaning engine", not AI-powered duplicate prevention, not intent
detection, not "semantically exactly-once" — negation and magnitude are solved by the STRUCTURED
fields, never by the vector.

### The rule ladder and the judge (`semantic.rules`, `semantic.judge`)

The gate above asks nothing when the identity fields differ — "TV-42" and "tv-42" normalize into one
job, but "Samsung 42 inch TV" and "SMSNG TV42" do not, and v1 only counts those (`droppedIdentity`).
Two optional rungs work that residue, both opt-in, neither able to decide anything by itself.

**Why not just lower the threshold:** we measured it. On 300 labelled pairs run through a real
embedder, "same job, written differently" averaged 0.906 and "different job that looks alike"
averaged 0.852 — the bands overlap, so every threshold trades recall against false alarms one for
one. Concretely: `Philips Airfryer XL` vs `XXL` (two different products) scored 0.959, HIGHER than a
genuine paraphrase pair at 0.740. A score-only arm would ask about neighbouring SKUs and sibling
companies while missing the abbreviations it exists for, and an operator trained to approve
question-storms approves the real duplicate too. That arm is not deferred; it is refused.

**The ladder (`rules`) is deterministic, free, and journalled.** Its constitution is encoded in the
types, because the direction a rule may conclude is the whole safety argument:

| class | may conclude | examples |
|---|---|---|
| normalizer | `match` → a question | digit VALUE (`0142` = `142`, `42` ≠ `43`), digit concatenation, character folding (`Danışmanlık A.Ş.` = `danismanlik as`, `Air Fryer` = `Airfryer`) |
| separator | `separate` → candidate drops | size ladder (`XL` ≠ `XXL`), one-character short-code difference (`abc` ≠ `abd`) |

**Every rule here is an algorithm, not a list — `rules: true` is the whole configuration.** That is a
deliberate correction, not an oversight. An earlier design had a third class fed by caller-supplied
dictionaries (synonyms, locale tokens, initials); it was removed once measured, for two reasons that
are worth stating because they generalise. First, the safety constitution capped that class at
"defer to the next rung" — which is also what happens when no rule matches, so it could not change a
single outcome while still asking for upkeep. Second, on both calibration sets **every** ladder
decision came from the list-free rules; the dictionary surface contributed nothing. A knob that
changes no behaviour and decays silently is worse than no knob.

Dropping is the safe direction throughout: a `separate` means no question, which is today's
behaviour. And what needs world knowledge — is Ahmet the same person as Mehmet, is a depot a
warehouse — goes to the judge, which brings that knowledge with it and needs no maintenance from you.

Open-ended prefix matching and phonetic skeletons are **not in the framework at all** — not disabled,
absent. Measured directly: a prefix rule that looked sound on one dataset matched `Berg` to `Bergman`
and `Pro` to `ProHeat` on a fresh one, two different people and two different products.

(`gazetteers` survives as an escape hatch for a genuinely small, stable closed set — twelve
warehouses, not "Turkish surnames" — and only pays off when a judge is configured, since it saves
judge calls rather than changing any answer. Default empty; leave it that way unless you have
measured a reason.)

**Where these rungs actually earn their keep — measured, and not where we first assumed.** We ran 144
turns of natural conversation through the real engine with a real tool model writing every argument.
The ladder matched nothing and the judge, called twelve times, asked nothing. The reason is worth
knowing before you enable either: a competent tool model CANONICALISES for you. "one more of that
television" comes back as `sku: "TV-42"` — byte-identical to the earlier call — so the exact-hash
layer catches it and the semantic rungs never get their turn.

So: on identity fields the model can canonicalise (SKUs, invoice references, order ids) you may not
need these rungs at all. They earn their keep where the model passes text through as written —
support-ticket subjects, customer and company names, free-text descriptions — which is exactly where
"same job, different wording" survives all the way to the tool call. Read your own `scan.grayCalls`
before deciding; if it stays near zero, that is your answer.

**And before you write the declaration, check the SCHEMA.** Every false alarm in that run had one
cause: two orders to different warehouses looked identical because `createOrder` had no warehouse
field. The distinguishing fact never reached the tool call, and no declaration can separate what the
engine cannot see. `semanticIdentity.keys` is the second question; the first is whether the tool's
input schema carries what makes two jobs different.

**The judge (`judge`) is the last rung, and it does not decide either.** It answers one question —
"do these two records name the same real-world thing?" — and a `same` answer buys exactly one thing:
a human is asked. `different`, `unsure`, a timeout, an exhausted budget and an unparseable reply all
mean today's behavior, and every one of them is journalled. The judge is never told the work ran
before (that is the permanent model-notification ban, projected onto this surface), and it receives
only the two canonical sentences plus the tool name — never the raw args, amounts or discriminators.

**Read that literally, because the default matters:** the canonical sentence is BY DEFAULT built from
your declared identity values (`"<toolName>: <identity values>"`), so with no `describe()` override
your SKUs, invoice references and customer names DO reach the judge provider — a second provider
beside the embedder. `describe()` is the redaction point for both. If your compliance position is
"nothing identifying leaves the process", the recipe is the same one as for embeddings: a local model
behind both closures, or a `describe()` that emits hashed or bucketed identifiers.

`describe()` is also where RECALL quality is won or lost for free-text identity fields. Measured
systematic blind spot: mixed-language term pairs ("Karanlık mod" vs "Dark mode", "dışa aktarma" vs
"export") score below the candidate threshold, and a record the recall gate never surfaces is never
seen by the rules or the judge — the miss is silent and final. If an identity field can carry the
same term in more than one language, normalize it to ONE canonical language inside `describe()`
(and inside `keys` normalization if the field is also an identity key). This is a per-tool, per-field
decision — the framework deliberately ships no translation dictionary.

```ts
// The `semantic` block from above, with the two quality layers filled in.
const semantic = {
  embed: myEmbed, embedModelId: 'local:multilingual-e5-small@q8',
  rules: true,                                  // defaults; or an object to supply your own lists
  judge: {
    // TRANSPORT ONLY: the framework renders the prompt, you own the model and the bill.
    complete: async ({ system, user }) => (await myModel(system, user)).text,
    judgeModelId: 'your-judge-model',
    qualification: cert,                        // from @gnldev/semantic-qualify — REQUIRED
    maxCallsPerRun: 10,                         // journal-backed slots; survive resume
    timeoutMs: 8000,
  },
};
```

**The certificate is not ceremony.** On identical fixtures with the identical prompt, one model
answered 43% of the paraphrase pairs correctly and another 100%. A third, from a family unrelated to
the one that wrote the fixtures, scored 93% — so the spread is about the model, not about whose
phrasing it recognises. A judge you have not measured is a
layer that looks installed and is not — so a missing, weak (recall < 0.70 or false alarms > 0.05),
model-mismatched or prompt-version-mismatched certificate is a **config-time throw**, the sibling of
v1's empty-`keys` throw. Swapping the model or upgrading past a prompt-version bump invalidates it
and the exam must be re-sat:

```sh
npx gnl-semantic-qualify --judge ./my-judge.mjs --model your-judge-model   # → gnl-judge-cert.json
```

The bench evaluates blind (opaque ids, shuffled order, labels never sent) and scores against the same
exported constants the runtime enforces. Point it at `--fixtures ./yours.json` to measure something
your model cannot have seen; the published set stops being held out the moment it is published, and
the certificate stamps EXAM performance, not field accuracy.

**Cost, stated before you enable it.** The judge runs only on the gray residue, at most once per
call, bounded by `maxCallsPerRun` slots that are claimed in the journal (so a crash loop cannot re-buy
the budget, and a timeout burns a slot on purpose). Verdicts are cached symmetrically and stamped
with model, prompt and ruleset versions, so a replay never pays twice and a swapped model is never
served the previous one's answers.

**Count first, judge second.** Studio's `/semantic-guard` reports `scan.grayCalls`: the number of
guarded CALLS that produced a gray residue. The unit is deliberate — one call can surface several
candidates, but the judge speaks at most once per call, so calls (not candidates) are what a judge
would cost. Run with `rules` on and `judge` off for a while, read it, then decide. Two traps worth naming: `droppedIdentity` is not a second quote
(it counts the same candidates from the other side, so adding them double-counts), and its MEANING
shifts when you enable `rules` — separator drops move into `droppedByRule`, so the same traffic
reports a smaller `droppedIdentity` after the upgrade and pre/post baselines are not comparable. In
our measurements the ladder settled about a third of the paraphrases for free and dropped a third to
a half of the look-alikes before any judge call.

**Measured on conversation traffic:** 0.10 judge calls per guarded call (12 calls across 126
tool-calling turns), and none of them produced a question — the gray band was genuinely made of
different work. The `maxCallsPerRun` default of 10 is therefore roomy rather than tight; it is a
backstop against a pathological thread, not a budget you should expect to spend.

The chain, end to end:

```
exact-hash → cosine candidate (≥0.60) → identity fields
    equal            → question (v1, unchanged)
    ladder match     → question (deterministic, origin: 'rule')
    ladder separate  → today's behavior + counted (droppedByRule)
    gray + judge     → 'same' → question · anything else → today's behavior + incident
    gray, no judge   → today's behavior + counted (grayUnjudged)
```

Studio's semantic card breaks the questions down by which rung asked (identity / rules / judge)
beside `precision@suspend`. A judge share climbing over time is the first sign your identity
declarations or dictionaries stopped matching the traffic.

When a question turns out to be unnecessary — a human read it and ran the work anyway — the card
also names the declaration it rested on (`byDeclaration`):

```
createOrder · sku — 4 of 4 questions ran anyway
```

`precision@suspend` tells you how many questions were wrong; this tells you which declaration
produced them, which is the part you can change. Questions all resting on the same one or two fields
usually mean the tool call never carried what separates the jobs — two orders for different
warehouses are identical to the gate if `createOrder` has no warehouse field. That is a schema fix
before it is a `semanticIdentity` fix: **the gate can only see what the tool call carries.** Read the
count as a ranking of suspects, not a verdict — a repeat someone deliberately approved lands in the
same column.

**What this is NOT** (binding for docs and marketing alike, extending the v1 list): the judge does
not decide or approve; the ladder does not "catch duplicates" (no guarantee language); this is not
AI-verified dedup; no synthetic measurement here is a field-accuracy promise; and "a qualified judge"
never equals "reliable protection" — the live `precision@suspend` number is the only evidence that
the questions were worth asking.

## Replay disclosure (honest narration)

When a tool result is answered from the journal instead of executing (the repeat of already-done
work), the model receives a plain successful result — and would naturally announce a fresh success
("your order has been created!") for work that did NOT run. Measured live; a user cannot tell the
replay from the real thing. Two mechanisms close that, without touching the permanent panel rule
(the model must NEVER know work was done BEFORE deciding to call — that would enable silent,
unauditable dedup):

- **Envelope (always on):** every consumed pre-existing record lands on the result as
  `result.replayedToolCalls: [{ toolCallId, toolName, status, origin }]` — out-of-band, never shown
  to the model. `origin` separates `'window'` (genuinely earlier work) from `'self'` (this very
  request resuming — an approval continuation must not be narrated as "an earlier request"; the
  identity test is `resolvedToolCallIds`, not key prefix). `@gnldev/server` forwards the field on
  run responses; UIs can badge it.
- **`replayDisclosure: 'explain'` (opt-in, per run or `createGnl` config):** a TRANSIENT system
  note is injected into the step FOLLOWING the consume — the model then narrates honestly ("the
  operation was not performed again; this is the record of the earlier one"). The note is
  prepareStep-only: it never reaches the journal, thread memory, or any later turn (pinned by a
  memory-attached test), and only `origin:'window'` + `status:'succeeded'` entries earn it. The
  model stays blind at decision time, informed only while narrating. Honest bounds: a replay
  consumed on the FINAL step gets no note (no following live step — the envelope covers it), and
  the stream surface fires the note but does not yet stamp the envelope on the stream result.

### Repeat questions carry their context

Under the critical preset the duplicate policy is thread-scoped suspend: a deliberate identical
repeat becomes a human question EVERY time — approval creates the second job for real, denial
doesn't (product rule: never silently swallow an intentional repeat, never silently run one). And
because the `confirm` gate fires before the duplicate ladder, the confirm question itself is
decorated rather than left generic:

- exact repeat → `⚠ Identical work was ALREADY COMPLETED earlier in this conversation (first
  result: <toolCallId>) — approve only if you intend a deliberate repeat.`
- same normalized identity, different spelling (`'LAMBA-1'` vs `'lamba-1'`) → the confirm arm runs
  the same semantic candidate finder locally: `⚠ Work with the SAME business identity appears
  ALREADY COMPLETED …` (the score only finds; identity fields decide; the outcome is text on a
  HUMAN question — never a silent decision; fail-open if the embedder is down)
- same identity, different amounts → `⚠ … the amounts DIFFER — check carefully before approving.`

The full behavior matrix (different words / key order / spelling / amounts / genuinely different
work / approve / deny / score-alone-never-decides / embedder-down) is pinned in
`test/repeat-matrix.test.ts`.

## Scale characteristics (measured)

Measured on real Postgres, real key schemas, 2048-dim vectors (`scripts/bench-scale.ts` in the
companion prod-test app). What grows with what:

| Layer | Cost shape | Measured |
|---|---|---|
| Exact dedup (hash/marker/lock) | O(1) point reads per tool call | **0.25 ms/read** at 2 000 markers |
| Semantic recall | linear in THIS THREAD's side-effect records (listKeys + N gets + N cosines, in-process) | 100 recs → **36 ms** · 500 → 160 ms · 2 000 → ~650 ms |
| Record writes (semantic/marker) | O(1) per successful side effect | ~3–4 ms/record |
| HERMES suggestion scans | linear in the TENANT's suggestion/lesson count (approval-time, off the hot path) | 2 000 records → ~0.5 s full scan |

The load-bearing property: semantic cost is **thread-local** — it grows with the number of
side-effect jobs in ONE conversation, not with users, tenants, or total volume. A deployment with
a million users whose conversations each carry tens of side-effect jobs pays tens of milliseconds
per gated call; horizontal scale is the ordinary kind (more workers on one journal — the
single-home routing contract above). Practical bounds, stated honestly:

- A single conversation with **thousands** of side-effect jobs pushes semantic recall toward a
  second per gated call. That is the designed v1 boundary (in-process brute force, thread scope);
  cross-thread recall and an external vector index (Qdrant-class) are the deliberate v2, gated on
  telemetry data — not a rewrite, the recall interface already isolates the scan.
- HERMES merge/promotion scans are full-prefix scans per tenant; comfortable to ~10⁴
  suggestions/lessons per tenant, indexable in v2 the same way.
- Embedding latency is the caller's own closure (one call per gated side effect, content-keyed
  cache in front): a remote API adds its round trip; the documented local-model recipe keeps it
  on-machine.

## Production deployment notes (exactly-once preconditions)

The exactly-once guarantee rests on one precondition: **storage never loses an acknowledged write**
(detailed analysis: the core-hardening review). For multi-worker production:

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

## License

Apache-2.0 — see [LICENSE](./LICENSE).
