# __PROJECT_NAME__

Durable agent project created with `create-gnl`. **No API key required** — both agents run on
deterministic mock models, so everything below works right now.

```bash
pnpm install
pnpm dev      # REST API + Studio Playground → open http://localhost:3000/studio
              # (bare http://localhost:3000 answers 404 — the REST API has no index route)
```

## See the point in two minutes

This project ships the thing the framework exists for, already wired: a **side-effecting tool** that
is never silently run twice.

```bash
pnpm test     # 3 duplicate tool-calls in one turn → charged once. Crash + retry → still once.
```

Then watch it happen. With `pnpm dev` running, in another terminal:

```bash
curl -si localhost:3000/agents/charge-demo/run \
  -H 'content-type: application/json' \
  -d '{"workKey":"order-42","resourceId":"me","prompt":"charge order 42"}' | grep -i x-gnl
```

`x-gnl-idempotency-status: new` on the first call. **Send the exact same command again:** `replay` —
the model was not called, the tool did not run, and the recorded answer came back. Now change the
prompt while keeping the same `workKey`: `409 run_input_mismatch`, because one workKey is one job.

Open the run in Studio (`http://localhost:3000/studio`) to see the timeline, the tool call, and the
cost of each step.

## What is where

```
gnl.config.ts        the one place agents, tools and protections are wired together
src/agents/          one file per agent   — assistant (chat), charge-demo (calls the tool)
src/tools/           one file per tool    — charge-order.ts (sideEffect + idempotency: 'args')
test/proof.test.ts   the duplicate-call proof you just ran
```

Growing: `gnl add memory | auth | rag | mcp | workflow` writes the file and prints the one line to
add to `gnl.config.ts`. Folders appear as you need them (`src/workflows/`, `src/models/`, …) — none
are created empty.

## Going live: a real model

```bash
npx gnl add model nvidia        # or: openai · anthropic · openai-compatible
```

It writes `src/models/<provider>.ts` and tells you the one import line to change in
`src/agents/assistant.ts`. Put the key in `.env` in this directory — `gnl dev` and `gnl studio` load
it at startup, and anything already set in your shell wins. **`.env` is gitignored; keep it that way.**

## Inspecting and operating on runs

The CLI reads the same journal the server writes, so a quick look does not need Studio:

```bash
gnl runs                              # list runs (status, steps, cost)
gnl run <runId>                       # a single run's timeline
gnl inspect <runId> --step N          # time-travel: materialized state at step N
gnl fork <runId> --step N             # copy a run into a new, live-continuable runId
gnl resume <runId> --agent assistant  # resume a suspended/crashed run
gnl doctor                            # what is protecting this project right now
gnl sweep --older-than 30d            # retention sweep (dry-run by default; --yes to delete)
```

`gnl --help` lists everything; `gnl help <command>` explains one. Every command takes `--json` for
scripting and `--config` for a non-default config path.

## Frontend

```ts
import { GnlClient } from '@gnldev/client';
const gnl = new GnlClient({ baseUrl: 'http://localhost:3000' });
const { text } = await gnl.run('assistant', { prompt: 'hello' });
```

React: `import { useChat } from '@gnldev/client/react'`.

## Note

Dev tokens written by `gnl add auth` live in your source tree — treat them as public. In production
the process refuses to start without `GNL_ADMIN_TOKEN` / `GNL_VIEWER_TOKEN` from the environment.
