# @gnl/server

Exposes the `createGnl` registry as **auto-REST + OpenAPI + SSE**. Every endpoint bottoms out in `runDurable` → exactly-once/durability inherited for free. (The durable counterpart to the common auto-REST pattern.)

```bash
npm i @gnl/server   # peer: @gnl/durable  ·  dep: hono
```

```ts
import { createRestApi } from '@gnl/server';
import { serve } from '@hono/node-server';
import { SqliteJournal } from '@gnl/durable/sqlite';

const api = createRestApi({
  journal: new SqliteJournal('runs.db'),
  agents: { support: { model: 'anthropic/claude-opus-4-8', tools, guard, maxSteps: 8 } },
});
serve({ fetch: api.fetch, port: 3000 });
```

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
`event` + JSON `data`: `text-delta {text}` · `tool-call {toolCallId,toolName,input}` · `tool-result {...}` · `error {error}` · `interrupt {interrupts[]}` (when the stream ends) · `done {runId,finishReason,usage}`. The same schema is also used in the `@gnl/studio` playground → [`@gnl/client`](../client) connects to both ends.

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
For type-safe calls use [`@gnl/client`](../client) (core) + `@gnl/client/react` (hooks). For REST + Studio Playground in one command use [`@gnl/cli`](../cli) `gnl dev`.

## How it works
`runId` is the idempotency key; calling `/run` or `/stream` again with the same runId triggers durable replay → side effects happen only once. `runId` is required (400 if missing).

**Auth (opt-in, but no silent openness in production):** `createRestApi(config, { auth })` accepts an `AuthProvider` (the free `@gnl/auth` `roleAuth`, or the paid `@gnl/auth-ee`) or a backward-compatible `{read, write}` pair. If `auth` is not given, endpoints are open; but under `NODE_ENV=production` this is only possible DELIBERATELY, via `allowOpenAccess: true` — without the flag, setup throws a clear error ("auth required in production"). Outside production, a setup without auth works, with a one-time `console.warn` on the first request (audit #2: silent fail-open closed).
