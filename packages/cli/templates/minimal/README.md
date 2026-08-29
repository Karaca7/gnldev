# __PROJECT_NAME__

Durable agent project created with `create-gnl`. **No API key required** (echo mock model).

```bash
pnpm install
pnpm dev      # REST API + Studio Playground → open http://localhost:3000/studio
              # (bare http://localhost:3000 answers 404 — the REST API has no index route)
```

- **`gnl dev`** — hot-reload. Restarts when `gnl.config.ts` or `src/` changes.
  - REST: `POST /agents/assistant/run` · `POST /agents/assistant/stream` (SSE) · `GET /openapi.json`
  - Studio Playground: `http://localhost:3000/studio` → pick an agent, write a prompt, get a streaming response.
- **`pnpm studio`** — Studio only (inspector + playground), on `:4747`.

## Inspecting & operating on runs
Once `gnl.config.ts` has a `storage` (or `journal`), the CLI can inspect and operate on runs directly
from the terminal — no need to open Studio for a quick look:

```bash
gnl runs                              # list runs (status, steps, cost)
gnl run <runId>                       # a single run's timeline
gnl inspect <runId> --step N          # time-travel: materialized state at step N
gnl fork <runId> --step N             # copy a run into a new, live-continuable runId
gnl resume <runId> --agent assistant  # resume a suspended/crashed run
gnl sweep --older-than 30d            # retention sweep (dry-run by default; --yes to delete)
gnl rm <runId> --yes                  # permanently delete one run
```

Run `gnl --help` for the full list, or `gnl help <command>` for one command's usage. Every command
supports `--json` for scripting and `--config` to point at a non-default config file.

## Switching to a real model
Edit the `assistant` export at the bottom of [src/model.ts](src/model.ts) — `AgentConfig` is already
imported there:

```ts
export const assistant: AgentConfig = {
  model: 'anthropic/claude-opus-4-8',   // or: import { anthropic } from '@ai-sdk/anthropic'
  system: '...',
  maxSteps: 8,
};
```

## Frontend
For type-safe calls, use [`@gnldev/client`](https://www.npmjs.com/package/@gnldev/client):

```ts
import { GnlClient } from '@gnldev/client';
const gnl = new GnlClient({ baseUrl: 'http://localhost:3000' });
const { text } = await gnl.run('assistant', { prompt: 'hello' });
```

React: `import { useChat } from '@gnldev/client/react'`.

## Note

The dev tokens in `src/auth.ts` (if you scaffolded with `--features auth`) were generated for this
project and live in your source tree — treat them as public. In production the process refuses to
start without `GNL_ADMIN_TOKEN` / `GNL_VIEWER_TOKEN` from the environment.
