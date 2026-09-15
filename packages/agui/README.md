# @gnldev/agui

**AG-UI protocol adapter**: converts `@gnldev/server`'s SSE contract ([see `@gnldev/server` README](../server/README.md)) into [AG-UI](https://github.com/ag-ui-protocol/ag-ui) (CopilotKit's open agent↔UI event protocol) event sequences. **Zero `@ag-ui/*` dependency** — event types are hand-defined (AG-UI is an open SSE/JSON protocol, no SDK required).

> Install: `pnpm add @gnldev/agui` — or use it from a [repo clone](https://github.com/Karaca7/gnl-framework): `pnpm install && pnpm -r build`.

```bash
npm i @gnldev/agui   # dep: @gnldev/server, hono  ·  peer: @gnldev/durable
```

```ts
import { createAguiRoute } from '@gnldev/agui';
import { serve } from '@hono/node-server';
import { SqliteStorage } from '@gnldev/durable/sqlite';

const app = createAguiRoute({
  journal: new SqliteStorage('runs.db').runs,
  agents: { support: { model: 'anthropic/claude-opus-4-8', tools, guard, maxSteps: 8 } },
});
serve({ fetch: app.fetch, port: 3001 }); // POST /agents/:name/run → AG-UI SSE
```

`createAguiRoute` returns a fetch handler, so it binds to any Node server through the bridge in
@gnldev/server — a package this one already depends on, so there is nothing extra to install:

```ts
import { toNodeHandler } from '@gnldev/server/node';

express().use('/agui', toNodeHandler(route));   // mount BEFORE express.json()
```

### Connecting to the CopilotKit side
AG-UI's `HttpAgent` (`@ag-ui/client`) can POST directly to this endpoint:

```ts
import { HttpAgent } from '@ag-ui/client';

const agent = new HttpAgent({ url: 'http://localhost:3001/agents/support/run' });
agent.runAgent({ runId: 'r1', threadId: 't1', prompt: 'hi' });
```

**Honesty note**: this is a hand-extracted implementation of a subset of the AG-UI core events — it is NOT VERIFIED against the official
`@ag-ui/*` conformance test suite. Fields we're not sure about from the [upstream AG-UI
spec](https://github.com/ag-ui-protocol/ag-ui) are marked with comments in `types.ts`/`convert.ts`
(no made-up fields were added) — there is no vendored copy of the spec in this repo to check against.

## API
- `createAguiRoute(config, opts?)` — a single-endpoint Hono router from `@gnldev/durable`'s `CreateGnlConfig`:
  `POST /agents/:name/run {runId, prompt|messages, threadId?, approvals?}` → AG-UI SSE. Deliberately
  small: NO auth/tenancy/budget gates. If these are needed, use `@gnldev/server`'s `createRestApi` to
  produce a `gnl.stream(...)` result and pass it to `pipeAguiStream`.
- `pipeAguiStream(c, runId, result, opts?)` — the AG-UI-output counterpart of `pipeAgentStream` (takes a Hono `Context`
  + AI SDK `StreamTextResult`, starts with `RUN_STARTED`, ends with `RUN_FINISHED`/`RUN_ERROR`).
  If `opts.threadId` is not given, `runId` is used.
- `toAguiEvents(gnlEvent, ctx, state?)` — a PURE (I/O-free) converter: converts a single GNL SSE event
  (`{event, data}` — the schema from `@gnldev/server`'s W3 id contract) into an AG-UI event sequence. `state`
  is threaded in from outside (`initialAguiConvertState`) — a SINGLE state object must be threaded
  through from start to end for an ENTIRE run (this is required for text message framing START/END).

## Who is this request for? (`identity`)

This route declares auth out of scope, and that boundary is right. What it leaves you responsible for
is naming the end user each run acts for — the subject memory scopes on and every ownership gate
compares against.

```ts
import { createAguiRoute } from '@gnldev/agui';

const route = createAguiRoute(config, {
  // The SAME signature @gnldev/chat-adapter's route takes — write the function once, mount either adapter.
  identity: (req) => {
    const session = db.sessions.get(req.headers.get('cookie'));   // YOUR session store
    return session ? { resourceId: session.userId, threadId: session.conversationId } : undefined;
  },
});
```

It receives the web `Request` (not the Hono context, so an Express or Fastify bridge can use it), is
called once per request, and may return `undefined`. **Read it from something the server trusts** — a
session cookie, a verified JWT — and never from the request body: the engine treats its reserved
context keys as "the server established this", and a body-supplied subject is the caller naming
whoever they like. The route always seals the context, so that forgery is closed either way; what
`identity` decides is whether the run has an owner **at all**.

Precedence, field by field: `resolveResourceId` / `resolveThreadId` win (the existing contract), then
`identity`, then the body. With none of them, runs are born ownerless — ownership gates stay
fail-open — and in `NODE_ENV=production` the route says so once with a `console.warn`. It never
throws.

`@gnldev/chat-adapter`'s README carries the long version of the same section, including the attack it was
measured against.

## Which run is this? (`workKey`, and the two regimes)

Every request names one of two things, and exactly one:

- **`workKey`** — your name for a unit of work. The engine derives the run's id from it, so the same
  name always lands on the same run: durable replay, side effects once. It is a *business* name (the
  invoice being issued, tonight's reconciliation), so keep sensitive data out of it — it is reflected
  in error details and shown on Studio screens.
- **`runId`** — a raw id you already hold (a resume, a fork, an id you stored).

Sending both is a 400. Sending neither is a 400. `Idempotency-Key` is accepted when the body named
nothing itself.

**The derived id is not in a header.** `@gnldev/server` and `@gnldev/chat-adapter` return
`X-Gnl-Run-Id`; this route's answer is a stream of AG-UI events, so the id travels in the event
envelope where it belongs to the run rather than to the HTTP response.

### Two regimes, decided by whether the route can name a subject

Deriving an id from a name needs an **address** — otherwise the engine cannot tell whose job it is.
This route ships with no auth, so it has deployments that can name nobody, and the rules differ by
how the name arrived:

| What arrived | With a subject | With no subject |
| --- | --- | --- |
| `body.workKey` | Derived `run1_` id | **400** — fail-closed (the field is new; nobody loses anything) |
| `Idempotency-Key` | Derived `run1_` id | Stays a raw runId, as it has since FAZ-1 |
| `body.runId` | Raw id | Raw id |

The header is the forgiving one on purpose: it is usually stamped by a gateway, and turning a working
deployment's 200 into a 400 is not a fix. An `'org'` workScope is addressed by the organization, so
org-scoped work runs **without** a subject — that is the nightly-reconciliation case, not a hole. Pass
`orgId` from `identity` for it, and for parity with `@gnldev/server`: without it, org-scoped work
derives a *different* id here than it does through REST, which duplicates silently rather than
failing.

### Refusals

Errors thrown before the stream exists are typed, with the same codes `@gnldev/server` uses — a client
matches on `code`, never on the sentence.

**A conflict — 409, no `resumable`.** Something about the REQUEST has to change; no retry clears it.
All eight are `CALLER_CONFLICT_CODES` in `@gnldev/durable`, and this route returns every one of them:

| Code | Means |
| --- | --- |
| `run_thread_mismatch` | This id already belongs to a different conversation. |
| `run_input_mismatch` | Same derived id, different content — inside `run1_` this is unconditional. |
| `run_owner_mismatch` | The run belongs to a different subject. |
| `run_actor_mismatch` | Started by one actor, re-used by another — the first is frozen into the input, first-wins. |
| `thread_owner_mismatch` | The `resourceId` and the `threadId` belong to different people; nothing was appended. |
| `not_an_agent_run` | That id belongs to a workflow, a network or a batch item — `detail.kind` says which. |
| `run_swept` | Retention deleted the record; a `${runId}:swept` tombstone says it existed. |
| `batch_plan_mismatch` | A `batchId` carries one plan, and these items are not it. |

**Blocked — the request is right, the moment is not.** The three 409s carry `resumable: true`:

| Code | Status | `resumable` | Means |
| --- | --- | --- | --- |
| `run_busy` | 409 | yes | The same run is executing right now. The **only** code that also sends `Retry-After: 5`. |
| `side_effect_retry_blocked` | 409 | yes | A side effect's outcome is unknown; the engine refuses to guess. |
| `step_retry_blocked` | 409 | yes | A workflow step's side-effect claim was refused for the same reason. |
| `retry_limit_exceeded` | 422 | **no** | Retries are spent. 422 and no flag, because waiting is exactly what will not help. |

`resumable` answers one question — can waiting help? — which is why the conflicts never carry it and
why `retry_limit_exceeded` does not either, despite arriving through the same code path. Full pages
for each are in [`docs/errors`](../../docs/errors).

## Mapping table (GNL SSE → AG-UI)
| GNL event | AG-UI event(s) | Note |
|---|---|---|
| `text-delta` (first) | `TEXT_MESSAGE_START` + `TEXT_MESSAGE_CONTENT` | GNL has no separate "text started" event — synthesized on the first delta |
| `text-delta` (subsequent) | `TEXT_MESSAGE_CONTENT` | |
| `tool-call` | `TOOL_CALL_START` + `TOOL_CALL_ARGS` + `TOOL_CALL_END` | Arguments in a SINGLE delta (not streaming in GNL, arrives COMPLETE) |
| `tool-result` | `TOOL_CALL_RESULT` | `messageId = ${toolCallId}:result` |
| `error` | `RUN_ERROR` | `code` is carried; `detail`, if present, goes into `rawEvent` |
| `interrupt` (HITL/suspend) | `CUSTOM {name:'gnl.interrupt', value:{interrupts}}` | **UNCERTAIN mapping** — we're not sure whether AG-UI core has a dedicated event type for HITL; moved to the spec's `CUSTOM` escape hatch |
| `done` | `RUN_FINISHED` | `result: {finishReason, usage}` — we're not sure whether this field exists in the official spec (best-effort) |

If `tool-call`/`tool-result`/`interrupt`/`error`/`done` arrives while a text message is open,
`TEXT_MESSAGE_END` is written first (same state machine).

## How it works
`pipeAguiStream` keeps a small, independent copy of the fullStream-reading loop from `pipeAgentStream` in
`@gnldev/server/sse.ts` — it converts to the GNL `{event,data}` shape and
passes it to `toAguiEvents`. AG-UI SSE frames carry only a `data:` field (the type is inside the JSON) — the
`event:` field is not used.

## Known limits
- This adapter has **NO resumable stream (Last-Event-ID)** — `@gnldev/server`'s resumable-id contract is
  not carried here, so a dropped connection restarts the turn rather than resuming it.
- `createAguiRoute` does not include auth/tenancy/budget (see the API note above).

## License

Apache-2.0 — see [LICENSE](./LICENSE).
