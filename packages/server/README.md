# @gnldev/server

Exposes the `createGnl` registry as **auto-REST + OpenAPI + SSE**. Every endpoint bottoms out in `runDurable` → the journal, replay and the [at-most-once side-effect guarantee](../durable/README.md#what-never-charged-twice-actually-means) are inherited for free. (The durable counterpart to the common auto-REST pattern.)

> Install: `pnpm add @gnldev/server` — or use it from a [repo clone](https://github.com/Karaca7/gnl-framework): `pnpm install && pnpm -r build`.

```bash
npm i @gnldev/server   # peer: @gnldev/durable  ·  dep: hono
```

```ts
import { createRestApi } from '@gnldev/server';
import { serve } from '@hono/node-server';
import { SqliteStorage } from '@gnldev/durable/sqlite';

const api = createRestApi({
  journal: new SqliteStorage('runs.db').runs,
  agents: { support: { model: 'anthropic/claude-opus-4-8', tools, guard, maxSteps: 8 } },
});
serve({ fetch: api.fetch, port: 3000 });        // on its own port
// app.mount('/api', api)                      // inside a Hono app
```

## Binding it to a Node server

`createRestApi` returns a fetch handler — callable, and carrying `.fetch`. On Node, bind it with the
bridge on this package's own subpath:

```ts
import { createServer } from 'node:http';
import { toNodeHandler } from '@gnldev/server/node';

express().use('/api', toNodeHandler(api));                            // Express
await fastify.register(middie); fastify.use('/api', toNodeHandler(api));   // Fastify + @fastify/middie
koa.use(c2k((req, res, _next) => toNodeHandler(api)(req, res)));      // Koa + koa-connect
createServer(toNodeHandler(api)).listen(3000);                        // node:http
nestApp.use('/api', toNodeHandler(api));                              // Nest (Express or Fastify)
```

Two rules, both measured on live servers rather than reasoned about:

**Bind at the middleware layer, not as a route.** On Fastify the difference is the whole story:
middleware runs before body parsing, a route runs after it. `fastify.all('/api/*', …)` looks correct,
passes every GET, and answers 400 to a perfectly good POST — because Fastify's built-in JSON parser
has already drained the stream.

**On Koa, declare the third parameter.** `koa-connect` switches on `fn.length`: a middleware with
fewer than three parameters is assumed not to terminate the response, so it calls `next()` straight
after and Koa writes its own 404 over what was already sent — measured, `ERR_HTTP_HEADERS_SENT` and
404 on every route. Naming `next` without calling it selects the branch that waits, which is what a
handler that owns the response needs.

**Mount before whatever parses request bodies.** A parser that runs first reads the stream to the end
and hands the result to the framework, not to us. Get it wrong and the bridge says so
(`body_consumed_upstream`) instead of blaming your request. Your own routes keep the parser: it still
runs for everything mounted after.

## Endpoints (per agent)
| Method | Path | Description |
|---|---|---|
| GET | `/agents` | List of registered agent metadata (client/playground selector) |
| POST | `/agents/:name/run` | Durable run `{runId, prompt\|messages, threadId?, approvals?}` → `{ok, runId, text, interrupts}` |
| POST | `/agents/:name/stream` | **SSE** streaming run (schema below) |
| POST | `/agents/:name/resume` | `{runId, approvals?}` — the input is read from the journal |
| GET | `/runs` · `/runs/:id` | Run summaries / journal timeline |
| GET | `/openapi.json` | Generated schema |
| GET | `/health` | Liveness — process is alive. No storage access. **Unauthenticated** |
| GET | `/ready` | Readiness — can serve traffic; 503 if the journal is unreachable. **Unauthenticated** |

### Health checks

`/health` and `/ready` answer two different questions, and pointing the wrong probe at the wrong one
causes the wrong action:

- **`/health`** — is the process alive? It touches nothing. A failing *dependency* must not make an
  orchestrator kill and restart a healthy process: restarting it does not reconnect your database, it
  only discards whatever the process still had in flight. Use this for liveness probes.
- **`/ready`** — can it serve? It reads from the journal, with a 2s budget because an unreachable
  database usually *hangs* rather than refusing. On failure the instance leaves the load balancer while
  staying alive to recover. Use this for readiness/traffic probes.

Both are deliberately unauthenticated — probes run before any credential exists, and usually never get
one. For the same reason they report reachability and nothing else: no agent names, no counts, no
configuration, and never the underlying error, which for a database failure routinely carries the host,
database and user. That detail goes to your logs.

```yaml
# Kubernetes
livenessProbe:  { httpGet: { path: /health, port: 3000 } }
readinessProbe: { httpGet: { path: /ready,  port: 3000 } }
```

### SSE schema (`/stream`)
`event` + JSON `data`: `text-delta {text}` · `tool-call {toolCallId,toolName,input}` · `tool-result {...}` · `error {error}` · `interrupt {interrupts[]}` (when the stream ends) · `done {runId,finishReason,usage}`. The same schema is also used in the `@gnldev/studio` playground → [`@gnldev/client`](../client) connects to both ends.

### Reconnect recovery (resumable SSE, opt-in)
Every SSE event carries a deterministic, monotonically increasing `id:` field starting at 0. Calling the
stream again with the same `runId` is deterministic journal replay (the model/tools do NOT actually run
again) → fullStream produces the same chunk sequence, so the same event sequence comes out with the SAME ids.

The browser's `EventSource` automatically sends the last `id:` it saw via the `Last-Event-ID` header when
reconnecting after a dropped connection — the server reads this (or `lastEventId` in the body) and for
events with `id <= lastEventId` it **produces them but does not write them to the client** (production is
cheap: replay does not call the model/tools). Only events with `id > lastEventId` are sent. If `lastEventId`
is not given, behavior is identical to before (aside from the added id).

## Frontend
For type-safe calls use [`@gnldev/client`](../client) (core) + `@gnldev/client/react` (hooks). For REST + Studio Playground in one command use [`@gnldev/cli`](../cli) `gnl dev`.

## How it works
Every call to `/run` and `/stream` names one of two things, and exactly one:

- **`workKey`** — your name for a unit of work, not for a conversation. The engine derives the run's
  id from it and returns that id in the `X-Gnl-Run-Id` header. Calling again with the same `workKey`
  is routed to the same run: durable replay, side effects once. A `workKey` is a *business name* (the
  invoice being issued, tonight's reconciliation batch) — keep sensitive data out of it, because it
  is reflected in error details and shown on Studio screens. Coming from `thread_id`? There the same
  key means *continue this conversation*; here it means *this is the same job*. A conversation is
  `threadId`, a separate field you can send at the same time.
- **`runId`** — a raw id you already hold (a resume, a fork, an id you stored).

Sending both is a 400: two identities for one call is a question with no honest answer. Sending
neither is also a 400. `Idempotency-Key` is accepted as a `workKey` alias — it names the work, which
is what that header has always meant — and it is read only when the body named nothing itself.

A `workKey` in the default `resource` scope needs a subject to be unique *within*: name the end user
(`resourceId`, or an authenticated principal), or the call is refused rather than run for nobody.

**How long a `workKey` stays unique:** as long as the run record lives — not a minute longer. Your
retention window should not be shorter than the longest retry your clients can produce.

**Was this call new work, or an answer you already had?** Every response to `/run` and `/stream`
carries `X-Gnl-Idempotency-Status`: `new` when this call started the run, `replay` when the run had
already been driven and the answer came from the journal. Nothing re-ran in the `replay` case — no
model call, no tool, no charge. It is the header to log if you want to know how much of your traffic
is retries, and the one to assert on if you are verifying that your client's retry logic is actually
deduplicating.

**`run_busy` (409) is a narrower condition than it looks.** It does not mean "this id has been used";
it means the run is executing **right now**, in this process or another one. A per-run lock is taken
before execution and renewed by a heartbeat while it lasts, and a concurrent second call — a
double-click, two tabs, a retry racing its original — is declined instead of executing a second time.
Three consequences:

- The response carries `Retry-After`. The *same* request is correct; it is only early. Honour the
  delay and send it again — it will replay.
- A process that dies without releasing holds the run only until the lock's TTL expires (default
  300 000 ms), after which a retry is admitted and replays from the journal.
- A long run does not time itself out of its own lock: the heartbeat keeps it alive, so the TTL bounds
  crash recovery, not run length.

A run that has already **finished** does not produce this at all — it replays (see the header above).

**Auth (opt-in, but no silent openness in production):** `createRestApi(config, { auth })` accepts an `AuthProvider` (the free `@gnldev/auth` `roleAuth`, or the paid `@gnldev/auth-ee`) or a backward-compatible `{read, write}` pair. If `auth` is not given, endpoints are open; but under `NODE_ENV=production` this is only possible DELIBERATELY, via `allowOpenAccess: true` — without the flag, setup throws a clear error ("auth required in production"). Outside production, a setup without auth works, with a one-time `console.warn` on the first request, so a silent fail-open cannot survive unnoticed.

**This server is not for browsers.** It is a backend service your own backend calls; your users reach
your application, and your application reaches this. Nothing here authenticates an end user, and no
credential below is safe to ship to a client device.

**Which credential your application carries:** `client`, not `admin` — see
[@gnldev/auth](../auth/README.md) for the four classes. `admin` cancels runs, reads the whole
organization's history and reads `/usage`; an application that runs agents needs none of that. A
`client` credential is a whitelist (`agents:run`, `workflow:run`, `run:cancel`, plus reads), so routes
added in later versions are refused rather than silently granted.

**Every `client` request names the end user it acts for.** One application credential serves many
users, so `resourceId` in the body (or `?resourceId=` on a read) says which one:

```
POST /agents/:name/run   { runId, prompt, threadId, resourceId }   → 400 without resourceId
GET  /runs?resourceId=u-ayse                                       → only that user's runs
GET  /threads?resourceId=u-ayse                                    → only that user's conversations
GET  /runs/:id?resourceId=u-mehmet                                 → 403 if the run is someone else's
```

That id is what keeps two of your users' conversations, memories and runs apart — the memory layer
scopes on it. Operator credentials may omit it; they work across the organization by design.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
