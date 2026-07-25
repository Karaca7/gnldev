# @gnldev/cli

The `gnl` developer CLI. Three groups of commands, all wired straight to `@gnldev/durable`'s own exports
(`listRuns`/`readRun`/`reconstructState`/`forkRun`/`resumeRun`/`sweepRuns`/`purgeRun`/`getRunCost`) —
nothing here reimplements durability, it just puts it in your terminal. **Zero new runtime
dependencies**: no commander/yargs/chalk/ora, colors and tables are hand-rolled ANSI (see
[Supply-chain hygiene](../../README.md#supply-chain-hygiene)).

```bash
npm i -g @gnldev/cli   # or: npx @gnldev/cli <command>
```

## Project

| Command | What |
|---|---|
| `gnl init [dir]` | Scaffold a new project (mock model, no API key required). In an interactive terminal it opens a **checkbox feature picker** (↑/↓ move · SPACE toggle · `a` all/none · ENTER confirm · `q`/Esc cancel) — pick from `idempotency-tool` (GNL's edge), `rag`, `mcp`, `memory`, `workflow`, `auth`, `e2e`, and a wired `gnl.config.ts` is generated for exactly those features. |
| `gnl init [dir] --features a,b,c` | Non-interactive compose (skips the checkbox). Same feature ids; an unknown id errors with the valid list (exit 1). |
| `gnl init [dir] --template minimal\|full [--e2e]` | Preset static starters (non-interactive). `--template full` ships a durable `idempotency: 'args'` tool + an e2e test; `--e2e` adds the durability test to `minimal` too. |
| `gnl init [dir] --yes` | Non-interactive `minimal`. The prompt also **never opens without a TTY** (`stdin` not a terminal → `minimal`), so CI is safe. |
| `gnl add <idempotency-tool\|rag\|mcp\|memory\|workflow\|auth>` | Add a feature recipe to an existing project: writes `src/<feature>.ts` (never overwrites) + prints the `gnl.config.ts` wiring (the config is decoupled — you edit the plain config object, no `defineConfig`). |
| `gnl dev [--config gnl.config.ts]` | Hot-reload dev server: REST API + Studio Playground on one port. Restarts when `gnl.config.ts` or `src/` changes. |
| `gnl studio [--config ...] [--port 4111]` | Studio (inspector + Playground) standalone |

```bash
gnl init my-agent --template full && cd my-agent && pnpm install && pnpm test   # proves idempotency
```

### Templates
- **`minimal`** (default) — one agent, mock model, SQLite storage, `gnl dev`. The smallest thing that runs.
- **`full`** — the same, plus a side-effecting `chargeOrder` tool with `idempotency: 'args'`
  (`idempotencyKey: (a) => a.orderId`) and `test/e2e.test.ts` that reproduces a documented
  duplicate-toolCallId pattern end-to-end and asserts the order is
  charged exactly once. This is the template that shows GNL's edge.

## Inspect (read-only)
These need a `gnl.config.ts` with `storage` (recommended, e.g. `SqliteStorage`) or a raw `journal` —
same rule `gnl dev`/`gnl studio` already follow: no storage/journal configured → a clear error, nothing silent.

| Command | What |
|---|---|
| `gnl runs [--status completed\|suspended] [--limit N] [--json]` | List runs: id · status · model steps · tool calls · cost · thread, newest first |
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
`import { commands, commandList } from '@gnldev/cli'` — the same `Command` registry `cli.ts` dispatches
through, for embedding/tests that want to drive a command's `run()` without spawning the `gnl` binary.
Also re-exported: `defineConfig`/`loadConfig`, `buildDevApp`/`serveDev`, `scaffold`.
