# @gnldev/studio

Durable run **inspector + Playground**. Run history from the journal: timeline, time-travel, reconstructed
state, cost, an OTEL-like trace waterfall, fork, approval (resume). **Playground** (when `gnl` is given):
pick an agent from the browser → prompt → **streaming** response → interrupt approval → that run's trace.
The UI is @gnldev/studio-ui — a React + Vite build, served as prebuilt static assets. It must be built before running; without it the server answers with a "dist not found" page.

> Install: `pnpm add @gnldev/studio` — it ships with the prebuilt UI bundle the inspector serves. (Or build both from a [repo clone](https://github.com/Karaca7/gnl-framework): `pnpm install && pnpm -r build`.)

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
refused rather than warned about, and the message says which of the two to pick. The port is never opened
either way. `gnl studio` then exits 1; `gnl dev` prints the refusal but does NOT exit — it runs the server
in a `tsx watch` child, and a watcher stays up waiting for a file change. Nothing is listening, but a
supervisor or CI step waiting on an exit code waits forever, so use `gnl studio` where an exit code is
what you are checking. `createStudioApp`/`createStudioApi` without `auth`
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
| `events` | the **Dead-letter** view — quarantined `@gnldev/events` deliveries (see below) |
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
`playground`, `stream`, `tools`, `memory`, `workflows`, `queue`, `queueManage`, `cache`, `cacheManage`,
`deadEvents`, `eventsManage`, `knowledge`, `approvals`, `audit`, `organizations`, `authRequired`.
The `*Manage` pairs are button visibility only — the write action behind each one is enforced
server-side on every request regardless.

### Playground endpoints (when `gnl` is given, write-gated)
`GET /api/agents` · `POST /api/agents/:name/run` · `POST /api/agents/:name/stream` (SSE — same schema as
[`@gnldev/server`](../server)).

### Dead-letter (when `events` is given)

`@gnldev/events` quarantines a delivery after `maxAttempts` failures. `events: StudioEvents` gives the
inspector a view of those records — and Studio takes **no dependency on `@gnldev/events`**: you wrap
your own `WorkStore`, the same pattern `queue` and `cache` use.

```ts
import { listDeadEvents, retryDeadEvent } from '@gnldev/events';

createStudioApp({
  reader: journal,
  events: {
    orgScoped: true,                                   // required before an org-scoped caller is served
    topics: () => [{ topic: 'refunds', consumers: ['refunder'] }],
    listDead: (topic, consumer) => listDeadEvents(storage.work, topic, consumer),
    release: (topic, consumer, id) => retryDeadEvent(storage.work, topic, consumer, id),
  },
});
```

- `topics` (optional) is the inventory the view is pointed at; without it the view asks for a topic
  and a consumer as free text, because `listDead` needs both.
- `listDead` is **expensive by construction** — it scans the topic log and does one `get` per event.
  It is a management call, not a feed: Studio never polls it, and the UI refreshes only on an explicit
  operator action.
- `release` (optional) turns on the release action. It is *not* the queue's retry: `queue.retry`
  re-enqueues under a new id and leaves two rows, a release stamps the existing record
  (`status: 'released'`, `releases` incremented) and leaves one. It is per-consumer on purpose —
  re-emitting the event would redeliver it to every healthy consumer too. Return `false` when there is
  nothing to release (never quarantined, or since delivered); the server answers 409. Note that
  `retryDeadEvent` has a **third** `false`: it gives up rather than clobbering a record that keeps
  changing underneath it (5 lost compare-and-swaps in a row — two operators, two tabs, a script racing
  a human). The 409 body names only the first two reasons, so a release that fails while the record is
  visibly still `quarantined` is worth simply retrying; nothing was overwritten.

Routes — `GET /dead-events/topics` · `GET /dead-events?topic=&consumer=` (both parameters required;
400 without them) · `POST /dead-events/release` `{ topic, consumer, id }` (write-gated, audited as
`event.release`).

**The event body is not in the default answer, and neither is the handler's error text.** The list
route requires `catalog:read`, the *configuration* permission, and a quarantined event's `payload` is
whatever the producer emitted. So two things must be true before a body leaves the process: the
caller **asked** (`?payload=1`) and the caller **may** (the `payloads:read` permission, new in
`PERMISSION_CATALOG`). A caller that asked without the permission still gets the list, with
`payloadRestricted: true` on each row — reading the quarantine is legitimately part of
`catalog:read`; only the bodies are not.

**`error` sits behind the same permission, and it is the sharper of the two restrictions** — it ships
in the *default* answer, so unlike `payload` it never needed asking for. It is
`String(err?.message ?? err)` from **your** handler, which ran on the payload, and every validation
library in common use quotes the value it rejected: measured against a real quarantine, a grant of
exactly `['runs:read','catalog:read']` got back
`{"error":"ValidationError: ssn '123-45-6789' invalid for customer jane@customer.example",…,"payloadRestricted":true}`
— one row announcing that the body was withheld while handing over its contents. A caller without
`payloads:read` now gets `errorRestricted: true` in its place, and only on records that actually have
an error (claiming it for a record with none would be inventing one). There is deliberately **no
`?payload=1`-style opt-in for it**: the opt-in guards `payload` because a body is bulk data a client
can receive by accident, while `error` is one short field the table renders in every row, and an
opt-in would blank that column for everyone including the callers entitled to it.

**So "the error column is empty" is a permission answer, not a bug.** Without `payloads:read` a
caller still gets id, topic, consumer, status, attempts, releases and both timestamps — enough for
"how much is stuck, is it growing, did releasing help" — but not "why". `@gnldev/events` also logs
the full error to the host's console at quarantine time, so the answer still exists for whoever may
read the logs.

**The same permission gates `GET /scheduler/triggers`.** `TriggerInfo.input` is the scheduled
workflow's own argument (the exact analogue of an event payload) and `TriggerInfo.lastError` is the
same `String(err?.message ?? err)` about it, so a caller without `payloads:read` gets the trigger
list with `input` **dropped entirely** and `lastError` replaced by `lastErrorRestricted: true`.
`input` gets no marker and `lastError` does because nothing in the UI has ever rendered `input` — its
absence cannot be misread — while a failed trigger with no `lastError` would read as "failed for no
stated reason".

Existing grants are unaffected: `*:read` matches `payloads:read` through the same wildcard every
other named read uses, and every role preset starts from `*:read`. Only an admin who has deliberately
narrowed someone to a named subset has to add it.

**One scan at a time, deployment-wide.** `GET /dead-events` is the most expensive read this API
serves (a whole topic log, one `get` per event — 1 470 ms for 20 000 events, measured on SQLite), so
exactly one runs at a time. What happens to everyone else depends on whether this deployment can tell
its callers apart:

* **Identical requests coalesce.** Two operators or two tabs on the same `(org, topic, consumer)`
  share the one scan and both get the real answer.
* **A different scan WAITS**, FIFO, and gets its answer a scan later. Past
  `deadEventScan.queueWaitMs` (default 5 s) or `deadEventScan.queueDepth` (default 64 waiting) it is
  refused with **429** + `Retry-After` and `code: 'dead_scan_busy'` — the deployment is saturated.
  A caller this process can NAME may hold the full queue depth; ones it cannot share half of it, so an
  anonymous flood cannot take every slot away from an authenticated operator.
* **An identified caller may hold TWO scans at once**, and is refused with the same 429 past that.
  The key is `Principal.credentialId` (what `roleAuth` derives from the presented bearer token) or
  `Principal.id`. A CAP, not a lock on one: `gnl add host` scaffolds a single bearer token for a team,
  so one holder taking the whole allowance and refusing every colleague on sight is the common case,
  not the exotic one — measured with one shared token and a single sequential attacker connection, a
  legitimate operator was served **0 times out of 20**, against 20 of 20 on the same deployment with
  no identity at all. Naming the caller has to help, not hurt.
* **A caller this process cannot name is charged nothing** and queues like everyone else; the only
  refusal it can see is the saturation one, which is true about the deployment rather than false about
  a scan it never started. If your auth provider supplies neither field, Studio says so once per
  process at runtime — the budget is off, and two callers it cannot tell apart cannot be protected
  from each other.
* **`Retry-After` is a measurement**, an EWMA of completed scans kept **per organization** (a single
  global number reports one tenant's dead-letter log size to another). Before this deployment has
  completed a scan, it is the queue budget rather than a hard-coded `1`.
* **A host that stops answering is not asked again.** `deadEventScan.timeoutMs` (default 30 s) gives
  up waiting and answers **504** `dead_scan_timeout`; the host's query may still be running, so those
  are counted, and past `deadEventScan.maxAbandonedScans` (default 2) new scans are refused with
  **503** `dead_scan_store_wedged` until they settle.

The UI cannot trip any of this on its own — its Load/Refresh button is disabled while a scan is in
flight.

Everything is addressed by the **triple** `(topic, consumer, id)` rather than an id:
a topic fans out, so one event carries one quarantine record per consumer and an id alone names N of
them. The triple travels in the query string / body rather than the path because topic names routinely
contain `.`, `:` and `/`. The routes are deliberately not under `/events` — that path is already this
API's SSE change stream — which is also why the capability is named `deadEvents`.

## How it works
**Runs view note:** nested runs (network steps `net:<parentRunId>:<i>`, agent-tool sub-agents
`agent:<toolCallId>`) show up in the list as SEPARATE top-level runs — by design (two-level durability;
details: the core-hardening review). To see the network's dynamic tree hierarchically, use the Networks
view (`getNetworkTrace`).

The UI rewrites `./api` relative to `apiBase` (admin↔API separation, can be mounted under any prefix). The
Playground's approval flow doesn't go through a separate resume — it goes to `/run` with the **same runId +
prompt + approvals** → the suspended tool is released (the run's [at-most-once guarantee](../durable/README.md#what-never-charged-twice-actually-means) is preserved). REST + Studio in one
command: [`@gnldev/cli`](../cli) `gnl dev`.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
