# @gnl/studio

Durable run **inspector + Playground**. Run history from the journal: timeline, time-travel, reconstructed
state, cost, an OTEL-like trace waterfall, fork, approval (resume). **Playground** (when `gnl` is given):
pick an agent from the browser → prompt → **streaming** response → interrupt approval → that run's trace.
Single-file inline UI (no build step).

```bash
npm i @gnl/studio   # peer/dep: @gnl/durable, hono, @hono/node-server
```

```ts
import { createStudioApp, makeStudioRunner } from '@gnl/studio';
import { createGnl } from '@gnl/durable';

const config = { journal, agents: { support } };
const gnl = createGnl(config);

const app = createStudioApp({
  reader: journal,
  gnl: makeStudioRunner(gnl, config),   // ← turns on the Playground (run/stream agents)
  // resume: ... (for timeline approval/fork, optional)
});
// mount with app.route('/studio', app) or serve it directly.
```

CLI (standalone):
```bash
gnl-studio --db runs.db                 # inspector only
gnl-studio --config gnl.config.ts       # + Playground (run agents in the browser)
```

By default the CLI only binds to `127.0.0.1` (so an auth-less Studio doesn't unintentionally spread across
the network); pass `--host 0.0.0.0` for external access. `createStudioApp`/`createStudioApi` without `auth`
can only be set up open in `NODE_ENV=production` DELIBERATELY, via the `allowOpenAccess: true` option — if
the flag is missing, setup throws with a clear error; outside production it warns once via `console.warn`
on the first request (audit #2: silent fail-open closed). The CLI treats binding to loopback as an
intentional choice for open access.

## API
- `createStudioApp(reader | options)` / `createStudioApi(options)` / `createStudioAdmin({ apiBase })`
- `options`: `reader` · `resume?` · `chat?` · **`gnl?`** (Playground runner) · `auth?: { read, write }` ·
  `allowOpenAccess?` · `apiBase?`
- `makeStudioRunner(gnl, config)` → Playground runner from a createGnl instance
- `bearerAuth(token)` · `basicAuth({ user, pass })`
- `capabilities` → `{ resume, chat, fork, playground, stream }`

### Playground endpoints (when `gnl` is given, write-gated)
`GET /api/agents` · `POST /api/agents/:name/run` · `POST /api/agents/:name/stream` (SSE — same schema as
[`@gnl/server`](../server)).

## How it works
**Runs view note:** nested runs (network steps `net:<parentRunId>:<i>`, agent-tool sub-agents
`agent:<toolCallId>`) show up in the list as SEPARATE top-level runs — by design (two-level durability;
details: `docs/CORE-HARDENING.md` §9). To see the network's dynamic tree hierarchically, use the Networks
view (`getNetworkTrace`).

The UI rewrites `./api` relative to `apiBase` (admin↔API separation, can be mounted under any prefix). The
Playground's approval flow doesn't go through a separate resume — it goes to `/run` with the **same runId +
prompt + approvals** → the suspended tool is released (exactly-once is preserved). REST + Studio in one
command: [`@gnl/cli`](../cli) `gnl dev`.
