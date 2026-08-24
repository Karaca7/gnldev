# GNL — Correct Durable Agents

**English** · [Türkçe](./README.tr.md)

**A thin correctness layer on top of the Vercel AI SDK — durable execution without standing up a server.**
It doesn't touch the AI SDK's agentic loop (`generateText`/`streamText` + `tools`) at all; it adds two
wrappers and a journal on top: **a side-effecting tool call is never silently fired twice.** That's the
precise meaning of **"exactly-once effect"** here — call-scoped dedup with a safe default: the guarantee
is carried all the way to the provider itself via `recover()`/`idempotencyKey`, and when the outcome is
genuinely unknown (e.g. after a crash), the system **blocks and asks for approval** instead of silently
retrying. If you know the AI SDK, you already know this.

```ts
import { runDurable, gnlTool } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { openai } from '@ai-sdk/openai';
import { tool } from 'ai';
import { z } from 'zod';

const chargeCard = gnlTool(
  tool({
    description: "Charge the customer's card",
    inputSchema: z.object({ amount: z.number() }),
    execute: async ({ amount }) => payments.charge(amount),
  }),
  {
    sideEffect: true,      // money moves — never replayed from the journal
    idempotency: 'args',   // and never re-run when the model re-plans it under a new toolCallId
  },
);

const res = await runDurable({
  runId: 'order-123',                       // idempotency key (typically an orderId/sessionId)
  journal: new SqliteStorage('runs.db').runs,
  model: openai('gpt-4o'),
  tools: { chargeCard },
  prompt: 'Cancel the order, suggest a similar product',
});
// After a crash: call again with the SAME runId → the card is never charged a 2nd time.
// Completed steps replay from the journal; only what never finished runs again. If the crash landed
// in the window after the charge but before it was journaled, the resume THROWS
// SideEffectRetryBlockedError rather than guess — see "Honest positioning" below.
```

## Why? (the edge — code-verified)
Agent frameworks either have no durability, or durability only at the level of an **opaque snapshot**
(e.g. a policy-gated step-snapshot durable agent — no atomic claim to prevent double-execution
on concurrent resume, no replay/fork from a given step; idempotency on retry is left to the caller →
double-charge risk). GNL's one sharp difference: **call-scoped, CAS-guaranteed exactly-once effect** — the
same tool call (`toolCallId`) never runs twice, and with opt-in `idempotency: 'args'` the same **arguments**
never run twice either, even when the model re-plans the call under a brand-new `toolCallId` (the dominant
real-world duplicate case — see below); a call whose outcome is unknown is first checked against
the provider via `recover()`, and if it's still unknown, the system **blocks and asks a human for
approval** instead of silently retrying — **plus deterministic replay + time-travel.** Every feature is
built on a single `Journal` interface, so it **inherits** these guarantees.

### LLM-aware idempotency (`idempotency: 'args'`)
Most documented double-side-effect incidents in the wild don't come from crash-replay — they come from
the LLM planning the same work again under a **new** `toolCallId` (a documented AI SDK pattern: the same tool called
5× in one turn, *"Tool call ids are different"*). Call-keyed exactly-once — every durable engine's,
including our default — is blind to that case by construction. Opt in per tool and GNL keys the journal
by the **arguments** instead:

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

Every duplicate — including concurrent duplicates inside the same step, which wait for the winner's
result instead of erroring — collapses into a single execution; the rest receive the journaled output.
The dedup window is run-scoped by default; opt into `idempotencyWindow: 'cross-run'` to make the same
arguments (or logical key, e.g. an `orderId`) execute once across **all** runs — retried jobs and
re-triggered agents included. Proof test that reproduces this duplicate-toolCallId pattern end-to-end and shows it
blocked: `packages/durable/test/args-idempotency.test.ts`.

#### AI SDK drop-in: `withIdempotency` — without `runDurable`
Already on a plain `generateText`/`streamText` + `tools` loop and don't want to adopt `runDurable`? Wrap
the tool map instead — same call sites, same loop:

```ts
import { withIdempotency, InMemoryJournal } from '@gnldev/durable';
// or: const journal = new SqliteStorage('runs.db').runs;

const tools = withIdempotency(rawTools, {
  journal: new InMemoryJournal(),
  // window defaults to 'cross-run' → an orderId charges once no matter which call/run it comes from
  // window: 'run', runId: 'order-123',        // scope dedup to one run instead
  // key: (name, args) => (args as any).orderId, // dedup by a logical key
});
```

**Honest limit:** this layer gives you *"the same argument never runs twice"* — the happy-path dedup and
cross-run single-execution work fully. It does **not** give full durability: without loop integration the
blocked/retry/approval ladder (crash recovery, approval gating) **throws** in standalone mode rather than
suspending. For those, use `runDurable`. Runnable example (no API key):
`examples/showcase/src/ai-sdk-idempotency.ts`; tests: `packages/durable/test/with-idempotency.test.ts`.

| Only us | Parity (+ durable twist) |
|---|---|
| exactly-once tool/model/MCP/RAG · **LLM-aware args-based idempotency** (`idempotency: 'args'` / `idempotencyKey` — dedups the model re-planning the same call under a new `toolCallId`) · deterministic replay (opt-in `replay: 'strict'` → **tool-argument** drift throws `DivergenceError`; a diverging **model step** only `console.warn`s even under strict, and isn't checked at all under the lenient default — replay is an **opt-in assurance**, not an imposed constraint) · time-travel + fork · **deterministic model fallback** (the winner is written to the journal, resume sticks with it) · **org-scoped journal** (`withOrg` — organization isolation + inherits exactly-once) · **edge-native**: **32.2 KiB gzip** core, **99.8 KiB** gzip including the AI SDK = 3.2% of the CF Workers free-tier limit (measured with `pnpm --filter @gnldev/showcase bundle` — esbuild, minified, esm/browser) · durable queue (lock renewal via heartbeat) · event bus (exactly-once marking + at-least-once delivery) · cross-network A2A (opt-in HMAC-SHA256 signing) · idempotent OTEL · cross-run cache · outbound-call **timeouts** (`timeouts: {modelStepMs,toolMs,claimTtlMs}` → `StepTimeoutError`) · **fail-closed auth** (setup errors out in production if no provider is configured) · **approval decisions are first-class in the journal** (in the approved-but-crashed-before-the-tool-ran scenario, resume applies the decision from the journal even if the `approvals` parameter isn't passed) | agent loop · **requestContext DI** (dynamic model/system/tools) · memory (recall/schema-WM/thread/OM) · workflows (evented) · MCP (client+server) · evals (+datasets) · auto-REST/OpenAPI (409/422 resumable contract) · processors · RAG (+rerank) · cost ledger |

## Requirements

**Node.js 22.13 or newer.** The default storage uses `node:sqlite`, which is only importable from 22.13 (it existed behind a flag from 22.5) — on an
older runtime the first run fails with `ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module: node:sqlite`. If you are on Node 20
LTS, either upgrade or point `journal` at `@gnldev/durable/postgres` or `/redis` instead.
pnpm 10 is what the repository is developed and tested against.

## Quickstart (DX)
Until the packages land on npm, run the starter from a clone (honest note: `npm create gnl`
becomes the one-liner only after the npm release):
```bash
git clone https://github.com/Karaca7/gnl-framework.git gnl && cd gnl
pnpm install && pnpm -r build
cd examples && node ../packages/create-gnl/dist/index.js my-agent   # starter (mock model — no API key needed)
cd my-agent && pnpm install       # inside examples/ → @gnldev/* resolve via workspace links
pnpm dev                          # REST API + Studio Playground (single port). Open http://localhost:3000/studio
                                  # (the REST API is mounted at `/`, which has no index route — bare `/` answers 404)
```
After the npm release: `npm create gnl my-agent` anywhere.
Type-safe calls from the frontend:
```ts
import { GnlClient } from '@gnldev/client';                 // or: '@gnldev/client/react' → useChat
const gnl = new GnlClient({ baseUrl: 'http://localhost:3000' });
const { text } = await gnl.run('assistant', { prompt: 'hello' });
for await (const ev of gnl.stream('assistant', { prompt: 'streaming' })) { /* text-delta… */ }
```

## Packages
`packages/` holds **24** manifests, and every one of them publishes to npm under Apache-2.0 — there
is no private package in this repository and no build step that withholds one. The paid auth tier
(`@gnldev/auth-ee`) is distributed separately under its own licence; it implements the same
`AuthProvider` interface `@gnldev/auth` defines here, so nothing in this tree depends on having it.
The table below covers the ones you interact with directly.

| Package | What |
|---|---|
| **`@gnldev/durable`** | Core: `runDurable`/`resumeRun`/`streamDurable` · `durableTool`/`withDurableModel` · journal (memory/**sqlite/postgres/redis**) · `createGnl` + model router · `createAgentTool` + **dynamic network (`runNetwork`, CAS-frozen routing)** · `getRunCost` · `reconstructState`/`forkRun` · run-lock (**atomic takeover: `putIfMatch`**) · `rolloverRun` (period rollover) · retention (`sweepRuns/sweepLog/sweepThreads`, recursive `purgeRun`, disk reclaim via the storage's `compact()`) · **`timeouts` (`modelStepMs`/`toolMs`/`claimTtlMs`) → `StepTimeoutError`** |
| **`@gnldev/memory`** | `AgentMemory`: recall (messageRange/threshold/filter/resource-scope) · schema working memory + `updateWorkingMemory` tool · thread CRUD/clone · observational memory (Observer/Reflector, pluggable tokenizer) · MessageList |
| **`@gnldev/rag`** | vector store (dev: in-memory · **prod: pgvector**) · **`chunkText`/`chunkDocuments`** (recursive/markdown/character) · **`GraphRag`** (similarity-graph retrieval) · `createRagTool` · `llmReranker` · `SemanticMemory` |
| **`@gnldev/workflow`** | then/parallel/branch · foreach/loop · **`retry` (declarative retry policy, counter kept in the journal)** · `wf.runResumable()` (a `Workflow` **method**, not a top-level export) + `sleep`/`waitFor` (evented/scheduled) |
| **`@gnldev/processors`** | piiRedactor · moderationProcessor · toolFilter · **`toolSearch` (semantic tool selection, journaled)** · tokenLimit · promptInjectionDetector · outputLimit |
| **`@gnldev/evals`** | **16 built-in scorers** — 8 LLM-judge (faithfulness/hallucination/…), 4 model-free text, 3 rule-based (exactMatch/contains/regexScore) + embeddingSimilarity, which takes an embedding function you supply · llmJudge · `scoreRun` · `evalDataset` (resumable) · **`createDatasetsManager`** (version history + experiment `compare`) |
| **`@gnldev/mcp`** | MCP client (`mcpTools`) **+ server** (`createMcpServer`, server-side exactly-once) |
| **`@gnldev/server`** | `createRestApi` + OpenAPI · **fail-closed auth** (setup errors out in production if no provider is configured; opt in explicitly with `allowOpenAccess: true`) · **409/422 resumable contract** (blocked/limit errors return `resumable`/`retry` from a single `BLOCKED_ERROR_CODES` source of truth) |
| **`@gnldev/otel`** | `exportRunToOtlp` + **`otlpPresets`** (Langfuse/Braintrust/Honeycomb/Datadog/Collector + generic API-key OTLP) · **live mode** (`@gnldev/otel/live`) |
| **`@gnldev/queue`** | durable job queue + worker · **lock renewal via heartbeat** (prevents takeover during long-running handlers) + opt-in empty-poll backoff |
| **`@gnldev/events`** | event bus (fan-out) — exactly-once marking + at-least-once delivery; handlers must be idempotent · opt-in empty-poll backoff |
| **`@gnldev/a2a`** | remote agent (cross-network exactly-once) · **opt-in HMAC-SHA256-signed requests** (`createA2ATool({ secret })` ↔ `createRestApi({ a2aSecret })`, replay resistance via a timestamp window) |
| **`@gnldev/cache`** | cross-run cache |
| **`@gnldev/studio`** | inspector **+ Playground**: pick agent → prompt → streaming response → approval · time-travel/fork + cost/trace/metrics/diff · admin/API separation + role-based auth |
| **`@gnldev/client`** | type-safe REST/SSE client (framework-agnostic core) + React hooks (`@gnldev/client/react`: `useGnlAgent`/`useChat`) |
| **`@gnldev/cli`** | project: `gnl init` (**interactive feature checkbox** — pick idempotency-tool/rag/mcp/memory/workflow/auth/e2e → a wired `gnl.config.ts` is generated; non-interactive via `--features a,b,c` / `--template minimal\|full` / `--yes`, prompt never opens without a TTY) / `add <idempotency-tool\|rag\|mcp\|memory\|workflow\|auth>` / `dev` / `studio` · inspect: `runs`/`run`/`inspect` (**time-travel in the terminal**) · operate: `fork`/`resume`/`sweep`/`rm`/`pricing` (all wired straight to `@gnldev/durable`'s own exports, nothing reimplemented) · **one runtime dep** (`tsx`, to load `gnl.config.ts`; hand-rolled ANSI/table + a from-scratch raw-mode checkbox, no chalk/ora/commander/inquirer) · `create-gnl` (`npm create gnl`) |

## Examples (`examples/`)
- **`showcase`** — a single self-verifying file exercising the packages: `pnpm --filter @gnldev/showcase demo` → 22 sections, 22/22 ✓ (mock model, no API key needed) · `bench` (overhead measurement)
- **`app`** — **Durable AI Support Desk** (web UI + API): `pnpm --filter @gnldev/app start` → :3100 (UI) + :3100/studio (ops). Ticket → message → approval → exactly-once refund + queue/events/otel.
- **`react-client`** — a `@gnldev/client/react` demo (`useChat` + streaming + approval), API-key-free echo backend. `pnpm --filter @gnldev/react-client-example server` + `… dev`.

## Supply-chain hygiene
A dependency you install runs code on your machine and in your build. GNL's posture, verifiable in
this repo today:
- **Zero install scripts** — no `postinstall`/`preinstall` in any package.
- **Minimal dependency surface** — the core (`@gnldev/durable`) has exactly **one** runtime dependency
  (`superjson`); storage drivers (`pg`, `ioredis`) are optional peers you explicitly opt into.
- **Signed, provenance-attested releases** (`npm publish --provenance`) are the publishing plan — no
  release happens outside CI.

## Development
```bash
pnpm install
pnpm -r build && pnpm -r typecheck && pnpm test   # 3589 passing, 48 skipped, 432 files (npx vitest run)

# real-backend integration test (optional):
docker-compose up -d
GNL_INTEGRATION=1 npx vitest run packages/durable/test/integration-real.test.ts
docker-compose down
```
TypeScript strict · 0 `@ts-ignore` (type escapes are kept minimal; some `any` remains at boundary/
serialization points) · dependency: `superjson` (+ optional hono/opentelemetry).
Peers: `ai`, `zod`. **No telemetry, no phone-home.**

## Deployment
gnl is fully Hono-based, so a Node deploy is a few lines:
```ts
import { createRestApi } from '@gnldev/server';
import { serve } from '@hono/node-server';
serve({ fetch: createRestApi(config).fetch, port: Number(process.env.PORT ?? 3000) });
```
`createRestApi` returns a plain fetch handler, so it also mounts straight into an existing server —
`toNodeHandler` from `@gnldev/server/node` bridges it to Express, Fastify, Koa, Nest or bare
`node:http`, and on Deno, Bun or Workers the handler is already the shape those runtimes expect.
**Journal warning:** `node:sqlite` doesn't work on serverless/edge runtimes → use a network-backed journal
(`@gnldev/durable/postgres` or `/redis`, D1 on Cloudflare). `SqliteStorage` is only for long-lived Node
processes.

## Honest positioning
Not "a full-featured agent-framework alternative" — a **durability/correctness layer for the AI SDK**: a solid core
(`@gnldev/durable`) plus satellite packages of varying maturity that inherit its guarantees. It covers most of
what a typical full-featured agent framework's core provides (memory/workflow/rag/mcp/processors/eval…), but builds it on top of
**call-scoped exactly-once effect + deterministic replay**. "Exactly-once" here isn't an absolute physical
guarantee — it means **call-scoped dedup with a safe default**: the same `toolCallId` never runs again, a
call whose outcome is unknown is tracked all the way to the provider via `recover()`/`idempotencyKey`, and
if it's still unknown the system **blocks and asks for approval instead of silently retrying** (the sentinel that
keeps a re-planned call from slipping past is in `packages/durable/test/blocked-sentinel.test.ts`;
the recover ladder is in `packages/durable/test/crash-window.test.ts`) — which is exactly what an
opaque step-snapshot durable agent doesn't give you. Full-featured agent frameworks are broader/more mature (voice/deployer/editor/auth — deliberately out of scope for us), but
none of their features ship with these guarantees. Our edge is **correctness**; it's decisive for
payment/financial and transactional or long-running/distributed workloads.

---

## Why not `WorkflowAgent`?

Fair question, and the most important one to answer: durability for AI SDK agents is no longer a gap
in the SDK. Vercel ships [`WorkflowAgent`](https://vercel.com/kb/guide/what-is-workflowagent) in
`@ai-sdk/workflow` and [`DurableAgent`](https://workflow-sdk.dev) in the Workflow DevKit — the same
agent loop, with each tool call marked `'use step'` so it becomes a durable step: it retries on
failure, survives a process boundary, and can suspend on `needsApproval` and resume days later. If
you are on Vercel, you get managed persistence, observability and multi-region with none of the
storage to operate. That is a real product and it overlaps most of what this project does.

**The difference is one axis: who is responsible for not doing the side effect twice.**

`WorkflowAgent` retries a failed tool call automatically — three attempts by default. It does not
dedupe the effect, and does not claim to: Vercel's own guidance is that the developer passes the
step's `stepId` to the external API as an
[idempotency key](https://workflow-sdk.dev/cookbook/common-patterns/idempotency), so that *Stripe*
collapses the duplicate. That is a sound pattern, and it leaves three things to you:

- **The API has to support idempotency keys.** Stripe does. An internal ledger service usually does not.
- **It is wired by hand at every call site.** Miss one and nothing breaks loudly; it just charges
  twice one day.
- **`stepId` is positional.** If the model re-plans the *same business action* as a new tool call — a
  documented AI SDK pattern — the step is different, so the key is different, so the effect happens
  again. This is the case [`idempotency: 'args'`](./packages/durable/README.md) exists for.

gnl puts the dedup in the journal instead: keyed by `toolCallId` by default, by argument hash or a
logical key when you opt in, across runs when you ask for it — and when the outcome genuinely cannot
be known (crash between the effect and its record) it **blocks and asks a human** rather than
guessing in either direction. Correctness is the default, not a per-call-site obligation. The other
practical difference: this is a library over storage you already run (`node:sqlite`, Postgres, Redis,
your own adapter), not a platform to deploy onto.

**Agents inside a workflow graph.** `@gnldev/workflow` has the graph — `then` / `branch` / `parallel`
/ `foreach` / `dowhile`, plus `sleep`, `waitFor` and suspend/resume — and a `Step` is a two-field
interface, so an agent becomes a node without any new API:

```ts
import { workflow, step, type StepCtx } from '@gnldev/workflow';
import { runDurable } from '@gnldev/durable';

const triage = step('triage', async (input: { ticket: string }, ctx: StepCtx) => {
  const res = await runDurable({
    runId: `${ctx.keyPrefix ?? ''}${ctx.runId}:triage`,   // ← derive it from the step, see below
    journal: ctx.journal as never, model, tools, prompt: 'classify this ticket',
  } as never);
  return { ...input, label: (res as { text: string }).text };
});

const refundFlow = step('refund', async (i: { label: string }) => i);
const closeTicket = step('close', async (i: { label: string }) => i);

workflow<{ ticket: string }>()
  .then(triage)
  .branch((i) => i.label === 'refund', refundFlow, closeTicket);
```

The `runId` is the load-bearing line. Derived from the step's identity, a resume replays the same
agent run; made up per call, it starts a fresh one — and a crash *inside* the step, after a tool ran
but before the graph recorded anything, charges the card twice. That is measured, not asserted:
`packages/durable/test/agent-as-workflow-step.test.ts` covers the nesting, and breaking that one line
turns its charge count from 1 into 2. One asymmetry to know about: `.foreach` takes a function rather
than a `Step`, so an agent inside a fan-out is invoked inline instead of reusing the same helper.

---

## Documentation

- **[docs/GUIDE.md](./docs/GUIDE.md)** — the complete walkthrough: what it is, how a run works, the
  journal's key schema, the storage ports, and the design trade-offs behind them. Start here if you
  want to understand the engine rather than just call it.
- **[docs/GUIDE.tr.md](./docs/GUIDE.tr.md)** — the same guide, in Turkish.
- **[examples/incident-proofs](./examples/incident-proofs)** — reproductions of real double-side-effect
  incidents, and what this framework does differently in each.
- **[examples/stripe-idempotency](./examples/stripe-idempotency)** — provider-side exactly-once against
  a mock Stripe: the same key carried from the journal to the provider.
- **[examples/showcase](./examples/showcase)** — one self-verifying file that exercises the packages
  end to end with no API key: `pnpm --filter @gnldev/showcase demo`.
- **[CHANGELOG.md](./CHANGELOG.md)** — what changed, with the migration notes for anything that breaks.
- **[VERSIONING.md](./VERSIONING.md)** — the packages move in lockstep; what a minor bump means while
  the project is 0.x, and what counts as breaking.

## Contributing

Pull requests are welcome. Read **[CONTRIBUTING.md](./CONTRIBUTING.md)** first — it covers the build,
the checks a change has to pass, and the one-line **[CLA](./CLA.md)** acceptance that lets the
project's license evolve later without tracking down every past contributor.

## Security

Please do not open a public issue for a vulnerability. **[SECURITY.md](./SECURITY.md)** explains how
to report one privately through GitHub, and what is in scope — durability, cross-organization
isolation, and the approval gates are the guarantees worth attacking first.

## License

[Apache-2.0](./LICENSE) — © 2026 Karaca Yılmaz.
