# @gnldev/studio

Durable run **inspector + Playground**. Run history from the journal: timeline, time-travel, reconstructed
state, cost, an OTEL-like trace waterfall, fork, approval (resume). **Playground** (when `gnl` is given):
pick an agent from the browser → prompt → **streaming** response → interrupt approval → that run's trace.
The UI is @gnldev/studio-ui — a React + Vite build, served as prebuilt static assets. It must be built before running; without it the server answers with a "dist not found" page.

> **Not on npm yet** — no `@gnldev/*` package has been published. From a [repo clone](https://github.com/Karaca7/gnl-framework), `pnpm install && pnpm -r build` builds the server *and* the UI bundle the inspector serves.

```bash
npm i @gnldev/studio   # peer/dep: @gnldev/durable, hono, @hono/node-server
```

```ts
import { createStudioApp, createStudioRunner } from '@gnldev/studio';
import { createGnl } from '@gnldev/durable';

const config = { journal, agents: { support } };
const gnl = createGnl(config);

const studio = createStudioApp({
  reader: journal,
  gnl: createStudioRunner(gnl, config),   // ← turns on the Playground (run/stream agents)
  // resume: ... (for timeline approval/fork, optional)
});
```

`createStudioApp` returns a **web-standard fetch handler**, not a framework object, so it binds to
whatever your app already runs on:

```ts
// Hono
app.mount('/studio', studio);

// Express, Fastify, Koa, Nest, bare node:http — anything on Node
import { createServer } from 'node:http';
import { toNodeHandler } from '@gnldev/studio/node';
express().use('/studio', toNodeHandler(studio));       // mount BEFORE express.json()
await fastify.register(middie);                        // @fastify/middie
fastify.use('/studio', toNodeHandler(studio));
koa.use(c2k(mw));                                      // koa-connect, before koa-bodyparser
createServer(toNodeHandler(studio)).listen(4321);      // node:http

// On its own port
serve({ fetch: studio.fetch, port: 4321 });
```

Mount it **before** whatever parses request bodies. A parser that runs first reads the stream to the
end and hands the result to the framework, not to us — the handler then sees a POST with no body.
It is the one ordering rule this package has, it is the same rule better-auth's Node handler carries,
and getting it wrong now answers with `body_consumed_upstream` instead of blaming your request.
Your own routes keep the parser: it still runs for everything mounted after.

Bind at the **middleware** layer, not as a route. On Fastify that is the whole difference: middleware
runs before body parsing, a route runs after it — which is why `fastify.all('/studio/*', ...)` looks
correct, passes every GET, and answers 400 to a perfectly good POST.

Two things that bite quietly, so they are worth reading once:

**Mount order.** `app.mount()` registers one blanket wildcard per call, unlike `app.route()`. A
catch-all mount at `/` swallows everything registered after it — mount the specific paths first, or
Studio answers 404 and looks broken when it is only buried.

**Sub-path prefixes.** A host that mounts under a prefix has already stripped it from the request;
do not add it back when bridging by hand. `toNodeHandler` exists partly to keep you out of this, and
partly because a hand-written Node bridge that forgets `res.flushHeaders()` serves SSE with the head
withheld until the first chunk — a quiet event stream then hangs the browser and nothing throws.

CLI (standalone):
```bash
gnl-studio --db runs.db                 # inspector only
gnl-studio --config gnl.config.ts       # + Playground (run agents in the browser)
```

By default the CLI only binds to `127.0.0.1` (so an auth-less Studio doesn't unintentionally spread across
the network); pass `--host 0.0.0.0` for external access — which requires either `auth` in the config or an
explicit `--allow-open-network`, because an unauthenticated admin surface on a network address is
refused rather than warned about (it exits 1 and says which of the two to pick). `createStudioApp`/`createStudioApi` without `auth`
can only be set up open in `NODE_ENV=production` DELIBERATELY, via the `allowOpenAccess: true` option — if
the flag is missing, setup throws with a clear error; outside production it warns once via `console.warn`
on the first request, so a silent fail-open cannot survive a deploy unnoticed. The CLI treats binding to loopback as an
intentional choice for open access.

## API

Every factory returns a `FetchHandler`, and every one accepts a bare `JournalReader` as shorthand
for `{ reader }`:

- `createStudioApi(reader | StudioApiOptions)` — JSON API only, no UI.
- `createStudioApp(reader | StudioAppOptions)` — the API **plus** the served UI.
  `StudioAppOptions extends StudioApiOptions` with one extra field, `apiBase`.
- `createStudioAdmin({ apiBase? })` — the admin HTML on its own, for an API mounted elsewhere.

`StudioApiOptions` is one option per surface, and a surface is off until you pass its option:

| Option | Turns on |
|---|---|
| `reader` (**required**) | the run list and run detail |
| `resume` | approval, fork, the Approvals view |
| `compensate` | `POST /runs/:id/compensate` (irreversible; write-gated + audited) |
| `chat` | live chat |
| `gnl` | the **Playground** — `createStudioRunner(gnl, config)` builds one from a `createGnl` instance |
| `memory` / `memoryFactory` | the Memory/Threads view |
| `workflows`, `workflowInputs`, `workflowStore`, `compileWorkflow` | the Workflows views |
| `scorers`, `datasets` | the Scorers and Evals views |
| `mcp`, `a2a`, `queue`, `cache`, `vectors` | the MCP, Networks, Jobs, Cache and Knowledge views |
| `org` | multi-organization mode |
| `auth: { read, write }`, `allowOpenAccess` | the auth gate (see the note above) |
| `users` | the Users view (a paid surface — the contract is here, the implementation is in `@gnldev/auth-ee`) |
| `apiBase` | *(`createStudioApp`/`createStudioAdmin` only)* the prefix the UI fetches against |

Also exported: `bearerAuth(token)` · `basicAuth({ user, pass })` · `roleAuth(...)` ·
`PERMISSION_CATALOG` · `ROLE_PERMISSION_PRESETS` · `pipeAgentStream` · `interruptsFromSteps`.

**`capabilities` is not an export** — it is the body of `GET /capabilities`, computed per request
from the options above (and reported *for the calling identity*, so an organization-scoped caller
sees `false` for anything its scope cannot reach). The UI builds itself from it, which is why the
endpoint is deliberately public. Around three dozen booleans, including `resume`, `fork`, `chat`,
`playground`, `stream`, `tools`, `memory`, `workflows`, `queue`, `cache`, `knowledge`, `approvals`,
`audit`, `organizations`, `authRequired`.

### Playground endpoints (when `gnl` is given, write-gated)
`GET /api/agents` · `POST /api/agents/:name/run` · `POST /api/agents/:name/stream` (SSE — same schema as
[`@gnldev/server`](../server)).

## How it works
**Runs view note:** nested runs (network steps `net:<parentRunId>:<i>`, agent-tool sub-agents
`agent:<toolCallId>`) show up in the list as SEPARATE top-level runs — by design (two-level durability;
details: the core-hardening review). To see the network's dynamic tree hierarchically, use the Networks
view (`getNetworkTrace`).

The UI rewrites `./api` relative to `apiBase` (admin↔API separation, can be mounted under any prefix). The
Playground's approval flow doesn't go through a separate resume — it goes to `/run` with the **same runId +
prompt + approvals** → the suspended tool is released (exactly-once is preserved). REST + Studio in one
command: [`@gnldev/cli`](../cli) `gnl dev`.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
