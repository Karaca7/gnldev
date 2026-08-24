# @gnldev/agui

**AG-UI protocol adapter**: converts `@gnldev/server`'s SSE contract ([see `@gnldev/server` README](../server/README.md)) into [AG-UI](https://github.com/ag-ui-protocol/ag-ui) (CopilotKit's open agent↔UI event protocol) event sequences. **Zero `@ag-ui/*` dependency** — event types are hand-defined (AG-UI is an open SSE/JSON protocol, no SDK required).

> **Not on npm yet** — no `@gnldev/*` package has been published. Until the first release, use it from a [repo clone](https://github.com/Karaca7/gnl-framework): `pnpm install && pnpm -r build`.

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
