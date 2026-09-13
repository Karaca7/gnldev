# @gnldev/cli

The `gnl` developer CLI. Three groups of commands, all wired straight to `@gnldev/durable`'s own exports
(`reconstructState`/`forkRun`/`resumeRun`/`sweepRuns`/`purgeRun`/`getRunCost`, plus the journal's own
`listRuns`/`readRun`) —
nothing here reimplements durability, it just puts it in your terminal. **One runtime dependency** (`tsx`, to load your
`gnl.config.ts`): no commander/yargs/chalk/ora/inquirer — colors, tables and the checkbox are
hand-rolled ANSI (see
[Supply-chain hygiene](../../README.md#supply-chain-hygiene)).

> **Not on npm yet** — no `@gnldev/*` package has been published, so neither line below resolves today. Until the first release, run the CLI from a [repo clone](https://github.com/Karaca7/gnl-framework) (`pnpm install && pnpm -r build`, then `node packages/cli/dist/cli.js <command>`).

```bash
npm i -g @gnldev/cli   # or: npx @gnldev/cli <command>
```

## Project

| Command | What |
|---|---|
| `gnl init [dir]` | Scaffold a new project (mock model, no API key required). In an interactive terminal it opens **one gate question** — Recommended · Let me choose · Same as last time — and, if you choose, **at most three more**: who sets the work going (`--preset`), whose runs these are (`--identity`), where the journal lives (`--store`). Ends by printing the protections matrix it just configured. |
| `gnl init [dir] --features a,b,c` | Non-interactive compose (skips the checkbox). Same feature ids; an unknown id errors with the valid list (exit 1). |
| `gnl init [dir] --template minimal [--e2e]` | The static starter (non-interactive). `--e2e` adds a durability test. The retired `--template full` is accepted and resolves to `--features idempotency-tool,e2e`. |
| `gnl init [dir] --preset ... --identity ... --store ...` | A flag **answers** its question, so that question is not asked. Values: `assistant\|headless\|critical`, `internal\|end-users`, `sqlite\|pg`. A misspelled value exits 1 rather than scaffolding an unprotected project. |
| `gnl init [dir] --yes` | Every unanswered question takes its recommended default. The prompt also **never opens without a TTY** (`stdin` not a terminal → defaults), so CI and agents are safe. |
| `gnl add <idempotency-tool\|rag\|mcp\|memory\|workflow\|auth>` | Add a feature recipe to an existing project: writes `src/<feature>.ts` (never overwrites) + prints the `gnl.config.ts` wiring (the config is decoupled — you edit the plain config object, no `defineConfig`). |
| `gnl dev [--config gnl.config.ts] [--host] [--allow-open-network]` | Hot-reload dev server: REST API + Studio Playground on one port. Restarts when `gnl.config.ts` or `src/` changes. |
| `gnl studio [--config ...] [--port 4747] [--host] [--allow-open-network]` | Studio (inspector + Playground) standalone |
| `gnl doctor [--share]` | What is protecting this project (the same matrix `gnl dev` prints, from `describeProtections`), plus two local stamps read out of the journal: the first run, the first time a duplicate guard actually refused something, and the gap between them. `--share` prints a copyable block with **no names in it** — no telemetry, no network call. |

```bash
gnl init my-agent --features idempotency-tool,e2e && cd my-agent && pnpm install && pnpm test   # proves idempotency
```

### Templates

- **`minimal`** (default, and the only one) — one agent, mock model, the journal you chose, `gnl dev`.
  The smallest thing that runs.
- **`full`** — **retired.** It was a five-file fork of `minimal` that existed to add one tool and one
  test, and it drifted from the original in three separate places before anyone noticed. The name
  still works and produces the same project: it now resolves to
  `--features idempotency-tool,e2e` — a side-effecting `chargeOrder` tool with `idempotency: 'args'`
  (`idempotencyKey: (a) => a.orderId`), a mock model that actually calls it, and a `test/e2e.test.ts`
  reproducing the documented duplicate-toolCallId pattern end to end.

### Where these listen

Both commands bind `127.0.0.1` — reachable only from your machine. They previously passed no hostname
at all, which made Node bind *every* interface while the startup line said `http://localhost:…`; on a
shared network that published an admin surface (run purge, managed-agent promote, cache invalidation,
and a Playground that spends your API keys) to anyone who could reach the port.

To reach the server from elsewhere — a container, another machine — name the address:

```bash
gnl dev --host 0.0.0.0            # refused unless auth is configured
GNL_ADMIN_TOKEN=… gnl dev --host 0.0.0.0
gnl dev --host 0.0.0.0 --allow-open-network   # deliberately open, on a network you trust
```

Auth comes from `gnl.config` (`auth: { admin: { token: … } }`) or from `GNL_ADMIN_TOKEN` /
`GNL_VIEWER_TOKEN`. `gnl studio` now reads it the same way `gnl dev` always has — it previously ignored
auth entirely, so its admin API was open no matter what you had configured.

**If you run `gnl dev` inside a container**, add `--host 0.0.0.0`; without it the port is no longer
reachable from the host.

## Inspect (read-only)
These need a `gnl.config.ts` with `storage` (recommended, e.g. `SqliteStorage`) or a raw `journal` —
same rule `gnl dev`/`gnl studio` already follow: no storage/journal configured → a clear error, nothing silent.

| Command | What |
|---|---|
| `gnl runs [--status completed\|suspended] [--work-key <key>] [--limit N] [--json]` | List runs: id · status · model steps · tool calls · cost · thread, newest first. `--work-key` matches the caller's declared name for the work EXACTLY (never a prefix) — the readable question an opaque `run1_` id can no longer answer; a WORK KEY column appears when any run declared one |
| `gnl run <runId> [--raw] [--json]` | A single run's timeline (materialized messages/tool-calls + cost). `--raw` prints the underlying journal entries instead. |
| `gnl inspect <runId> --step N [--json]` | **Time-travel in the terminal**: the materialized state at journal entry N (`reconstructState`) — messages so far + any tool-calls still pending. `N` ranges `0..<entries for that run>`; the command tells you the valid range if you're out of bounds. |

```bash
$ gnl runs --config gnl.config.ts
RUN ID    STATUS     MODEL STEPS  TOOL CALLS  COST (USD)  THREAD
order-9   completed  2            1           $0.0004     -
order-8   suspended  1            1           $0.0001     -

$ gnl inspect order-9 --step 1
order-9  step 1/3
  assistant  [{"type":"tool-call","toolCallId":"c","toolName":"charge","input":"{\"amount\":20}"}]
  pending (awaiting result): charge[c]
```

## Operate (mutating)
| Command | What |
|---|---|
| `gnl fork <runId> [--step N] [--to newRunId] [--json]` | **Differentiator**: non-destructively copies a run's first `N` model steps (+ referenced tool results) into a new runId (`forkRun`) — continue LIVE from a past step instead of just looking at it. `N` defaults to the run's full length (a complete, independently-continuable copy). The source run is never touched. |
| `gnl resume <runId> --agent <name> [--approve id1,id2] [--deny id3] [--json]` | Resume a suspended (Guard `require-approval`) or crashed run with a registered `config.agents[name]` — `resumeRun` reads the original prompt/messages back from the journal itself, you only supply the agent + any approval decisions. |
| `gnl sweep [--older-than 30d] [--include-suspended] [--yes] [--json]` | Retention sweep (`sweepRuns`): permanently deletes runs whose last activity is older than the threshold. **Dry-run by default** — prints what *would* be deleted; pass `--yes` (or `--force`) to actually delete. Suspended runs are kept unless `--include-suspended` is given. |
| `gnl pricing [list] \| set <model> --input <usd> --output <usd> [--cached <usd>] \| rm <model> \| test <model> --in <tok> --out <tok>` | The price table `maxCostUsd` and organization spend limits read. `DEFAULT_PRICING` ships compiled into `@gnldev/durable`, so it is stale the day it ships — and a model missing from it prices at **$0**, which means a ceiling cannot fire at any threshold. `set` writes the journal's `__pricing__` document, LAYERED over the shipped table so adding tomorrow's model cannot un-price `gpt-4o`. `test` prices a hypothetical run and names **which entry answered**: `priceFor` matches by longest prefix, so a whole model family can share one row and a wrong answer looks exactly like a right one. Writes are compare-and-set — a concurrent edit is reported, not swallowed. |
| `gnl rm <runId> [--yes] [--json]` | Permanently delete one run and its sub-agent/network children (`purgeRun`). Refuses without confirmation: `--yes` skips the prompt, otherwise you get a `y/N` prompt in a TTY, and a hard refusal (exit 1) non-interactively — never a silent no-op. |

```bash
$ gnl resume order-8 --agent billing --approve call-42
order-8  →  completed  (agent: billing)
  Charged.

$ gnl sweep --older-than 30d
(dry-run — pass --yes to actually delete; older than 30d)
Would delete 3 run(s):
  order-1  (completed, last activity 2026-05-01T00:00:00.000Z)
  ...
```

## Other
- `gnl --version` / `-v` — installed version.
- `gnl help [command]` — this help, or one command's usage.
- `gnl --help` — grouped list (Project / Inspect / Operate) of every command actually implemented.
- Unknown command → an error + a "did you mean" suggestion, exit code 1.
- `--json` is supported everywhere it's useful (scriptable, stable-shaped output); errors always go to
  stderr with a non-zero exit code, never a silently-empty stdout.

## Config
Every storage command accepts `--config` (default `gnl.config.ts`). See
[templates/minimal/gnl.config.ts](templates/minimal/gnl.config.ts) for the shape (`defineConfig` /
`GnlDevConfig`: a `CreateGnlConfig` — `journal` or `storage`, `agents` — plus dev server options like
`port`/`studio`/`auth`).

## Programmatic surface
Two entry points, split by what they need installed.

**`@gnldev/cli`** — `defineConfig`/`loadConfig`, `scaffold`/`generateConfig`, the `RECIPES` feature
list, the checkbox prompt reducer, and `commands`/`commandList`: the same `Command` registry `cli.ts`
dispatches through, for embedding/tests that want to drive a command's `run()` without spawning the
`gnl` binary. Nothing here names an optional peer, so it type-checks in a project that has only
`@gnldev/durable` — including under `skipLibCheck: false`.

**`@gnldev/cli/dev`** — `buildDevApp`/`serveDev`/`loadDevRuntime`/`resolveAuthProvider` and the `load*`
runtime resolvers. Everything here is typed against the optional peers (`@gnldev/durable`, `server`,
`studio`, `studio/ai`, `memory`, `auth`, `hono`, `@hono/node-server`), because it exists to boot them
from the target project. Importing this subpath means you are running the dev server and therefore
have them.

These used to be one entry, which put those peer type references into the program of anyone importing
the package at all: `import { scaffold } from '@gnldev/cli'` in a project with none of them installed
produced 16 `TS2307: Cannot find module` errors. Nothing was removed — the dev half moved.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
