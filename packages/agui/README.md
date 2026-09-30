# @gnldev/agui

**AG-UI protocol adapter**: converts the GNL agent stream (the `{event, data}` schema of `@gnldev/durable`'s `agentStreamEvents`) into [AG-UI](https://github.com/ag-ui-protocol/ag-ui) (CopilotKit's open agent↔UI event protocol) event sequences. **Zero `@ag-ui/*` dependency** — event types are hand-defined (AG-UI is an open SSE/JSON protocol, no SDK required).

**Two ways to run it:**

- **Standalone.** `createAguiRoute(config, { identify })` is a complete AG-UI endpoint. It needs
  only `@gnldev/durable` and `@gnldev/auth`. It does **not** need `@gnldev/server`, and installing
  this package does not install it. The isolation is the same as through the server: the route maps
  your `identify` to an engine caller, and the engine checks run and thread owners.
- **As a server surface.** `aguiSurface()` puts the same format on `@gnldev/server`'s REST API
  (`createRestApi(config, { auth, surfaces: [aguiSurface()] })`). Then the API's auth decides who
  the caller is. See [On the REST API](#on-the-rest-api-recommended).

> Install: `pnpm add @gnldev/agui` — or use it from a [repo clone](https://github.com/gnlhq/gnldev): `pnpm install && pnpm -r build`.

```bash
npm i @gnldev/agui   # dep: @gnldev/auth, hono  ·  peer: @gnldev/durable  (no @gnldev/server)
```

```ts
import { createAguiRoute } from '@gnldev/agui';
import { serve } from '@hono/node-server';
import { SqliteStorage } from '@gnldev/durable/sqlite';

const app = createAguiRoute({
  journal: new SqliteStorage('runs.db').runs,
  agents: { support: { model: 'anthropic/claude-opus-4-8', tools, guard, maxSteps: 8 } },
}, {
  // Who is calling. In production the route refuses to start without this: pass your auth
  // (see "identify" below), or say explicitly that there is no per-user identity.
  // With end users, prefer `aguiSurface()` on createRestApi: the API's auth decides it for you.
  identify: () => undefined,
});
serve({ fetch: app.fetch, port: 3001 }); // POST /agents/:name/run → AG-UI SSE
```

`createAguiRoute` returns a fetch handler, so any host that speaks web `Request`/`Response` can
call it (`@hono/node-server` above, Workers, Bun, Deno). For Express, the Node bridge lives in
@gnldev/server. This package does not depend on it, so install it only if you want the bridge
(`npm i @gnldev/server`):

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

## On the REST API (recommended)

`aguiSurface()` mounts the AG-UI format on `@gnldev/server`'s REST API, at `/agents/:name/agui`, so
the API's auth decides identity, organization and ownership:
`createRestApi(config, { auth, surfaces: [aguiSurface()] })`. `aguiSurface({ path })` changes the
path. The standalone `createAguiRoute` below is for a host that authenticates the request itself; in
production it refuses to start without `identify` (`identify: () => undefined` opts out, explicitly).

## API
- `createAguiRoute(config, opts?)` — a single-endpoint Hono router from `@gnldev/durable`'s `CreateGnlConfig`:
  `POST /agents/:name/run {runId, prompt|messages, threadId?, approvals?}` → AG-UI SSE. Deliberately
  small: the caller comes from `identify` (each run and thread is its caller's, inside its organization),
  roles are checked only when the route is handed `authorize` (see "Roles" below), and there is no
  budget gate. For budgets, mount the route on `@gnldev/server`'s `createRestApi` with `surfaces`.
- `pipeAguiStream(c, runId, result, opts?)` — the AG-UI-output counterpart of `pipeAgentStream` (takes a Hono `Context`
  + AI SDK `StreamTextResult`, starts with `RUN_STARTED`, ends with `RUN_FINISHED`/`RUN_ERROR`).
  If `opts.threadId` is not given, `runId` is used.
- `toAguiEvents(gnlEvent, ctx, state?)` — a PURE (I/O-free) converter: converts a single GNL SSE event
  (`{event, data}` — the schema from `@gnldev/server`'s W3 id contract) into an AG-UI event sequence. `state`
  is threaded in from outside (`initialAguiConvertState`) — a SINGLE state object must be threaded
  through from start to end for an ENTIRE run (this is required for text message framing START/END).

## Who is calling? (`identify`)

This route declares auth out of scope, and that boundary is right. What it leaves you responsible for
is one function: `identify(req)`, which returns a `Principal` from `@gnldev/auth`. It is the same
function `@gnldev/chat-adapter`, `@gnldev/mcp` and `@gnldev/server` take — write "who is this caller" once,
mount any door. An `AuthProvider` is one as it is:

```ts
import { createAguiRoute } from '@gnldev/agui';
import { roleAuth } from '@gnldev/auth';

const auth = roleAuth({ endUsers: { secret: process.env.GNL_END_USER_SECRET!, orgId: 'acme' } })!;

const route = createAguiRoute(config, {
  identify: (req) => auth.authenticate(req), // an end user's signed token → that user, in acme
});
```

It receives the web `Request` (not the Hono context, so an Express or Fastify bridge can use it), is
called once per request, and may return nothing. The route maps the principal to the engine's caller
with `engineCallerOf`, the one mapping every door uses:

| `principal.kind` | The run acts for | Reaches |
|---|---|---|
| `subject` | that user (`principal.id`) | its own runs and threads |
| `operator` | staff | every run and thread in its organization |
| `application` | the end user it names in the body's `resourceId` | that user's runs and threads |
| *(nothing)* | `unknown` | nothing that belongs to a user or to staff |

**An application** (a backend holding an application credential) speaks for one of its users on each
request and names it in the body: `{ runId, prompt, resourceId: 'u-ayse' }`. `resourceId` is read
**for an application only** — the same field and rule as `@gnldev/server`'s REST routes. A user who
sends it is still itself; staff is still staff. An application that names nobody gets a `400` and
nothing runs.

**The organization** is `principal.orgId`, never the body's. A run of an org-bound caller is stored in
that organization's partition, where the REST API and Studio read it. Runs stored before 0.7 are in
the shared root; `@gnldev/chat-adapter`'s README says how to move them.

**The thread is checked, not trusted.** `resolveThreadId`, then `body.threadId`, then the runId picks
it. The engine checks the thread's owner against the caller: a user naming staff's thread or another
user's gets `409 thread_owner_mismatch`, and the model never sees that history.

**Read the principal from something the server trusts** — a session cookie, a verified JWT — never
from the request body. The route always seals the request context, so a body-supplied
`__gnl_resourceId` names nobody. `identify: () => undefined` says, explicitly, that there is no
per-user identity: every caller is `unknown`, closed to every user's and staff's data.

**A presented credential the provider rejected is refused with 401**, not served as anonymous — a
revoked or deleted user's token used to answer 200 as an `unknown` caller, with an audit row saying
`allowed: true`. The route refuses when `identify` answers nothing and the provider noted the rejection
(`@gnldev/auth-ee` does for any credential its chain did not accept; your own `identify` calls
`markCredentialRejected(req)`); the row carries `detail: 'credential_rejected'`. No credential, or
`identify: () => undefined`, is still anonymous.

**Breaking in 0.7.** `identity: (req) => ({ resourceId, orgId, threadId })` was replaced by
`identify: (req) => Principal`: the old shape could not say "this caller is staff", and the standalone
route let an end user read a staff member's ownerless thread (measured). Passing `identity` now throws
at construction; `threadId` comes from `resolveThreadId` or the body. The package now depends on
`@gnldev/auth`.

**Roles (`authorize`).** `identify` says WHO is calling, not WHAT they may do. Without `authorize`,
every identified caller may run an agent here. Pass
`authorize: (principal, req, ctx) => auth.authorize(principal, req, ctx)` next to `identify` and the
route asks for `agents:run` before each run, as `@gnldev/server` does. `@gnldev/chat-adapter`'s README
has the example.

**Recording who asked (`onDecision`).** Without it, this route leaves no audit record. Pass
`onDecision: (d) => auth.onDecision?.(d)` next to `identify`: it is called once per request with who
asked and what they got, and a foreign thread or run (`409 …_owner_mismatch`) is recorded as an
ownership refusal. If the hook throws, the route answers 500.

`@gnldev/chat-adapter`'s README carries the long version of the same section.

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
org-scoped work runs **without** a subject — that is the nightly-reconciliation case, not a hole:
an `operator` principal with an `orgId` (staff of that organization). The org comes from the
principal, as on `@gnldev/server`: without it, org-scoped work derives a *different* id here than it
does through REST, which duplicates silently rather than failing.

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
- `createAguiRoute` has no budget gate, and checks roles only when handed `authorize` (see the API note above).

## License

Apache-2.0 — see [LICENSE](./LICENSE).
