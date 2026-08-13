# @gnldev/server

Exposes the `createGnl` registry as **auto-REST + OpenAPI + SSE**. Every endpoint bottoms out in `runDurable` → exactly-once/durability inherited for free. (The durable counterpart to the common auto-REST pattern.)

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
`runId` is the idempotency key; calling `/run` or `/stream` again with the same runId triggers durable replay → side effects happen only once. `runId` is required (400 if missing).

**Auth (opt-in, but no silent openness in production):** `createRestApi(config, { auth })` accepts an `AuthProvider` (the free `@gnldev/auth` `roleAuth`, or the paid `@gnldev/auth-ee`) or a backward-compatible `{read, write}` pair. If `auth` is not given, endpoints are open; but under `NODE_ENV=production` this is only possible DELIBERATELY, via `allowOpenAccess: true` — without the flag, setup throws a clear error ("auth required in production"). Outside production, a setup without auth works, with a one-time `console.warn` on the first request (audit #2: silent fail-open closed).
