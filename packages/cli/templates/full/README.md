# __PROJECT_NAME__

A GNL agent that showcases the edge: **a side-effecting tool that runs exactly once**, even when
the model re-plans the same call.

```bash
pnpm install
pnpm dev       # REST API + Studio Playground → http://localhost:3000 (+ /studio)
pnpm test      # e2e proof of LLM-aware idempotency
```

## What's inside

- **`src/tools.ts`** — `chargeOrder`, a durable tool with `idempotency: 'args'` +
  `idempotencyKey: (a) => a.orderId`. The journal is keyed by the order id, not the AI SDK's
  per-call `toolCallId`, so duplicate calls (a model re-planning the same charge under a new
  `toolCallId` — a documented AI SDK pattern) collapse into a
  single execution.
- **`src/model.ts`** — a mock model (no API key) that calls `chargeOrder`, then summarizes. Swap
  `model` for a real provider and delete the mock to go live.
- **`test/e2e.test.ts`** — reproduces the duplicate-tool-call bug end-to-end and asserts the order
  is charged exactly once; plus a crash-resume test (same `runId` → the tool never runs twice).

## Inspect & operate from the terminal

```bash
gnl runs                       # list runs (status, steps, cost)
gnl run <runId>                # timeline: messages, tool calls, cost
gnl inspect <runId> --step N   # time-travel: state at step N
gnl fork <runId> --step N      # branch a run into a new, live-continuable runId
gnl resume <runId> --agent assistant   # resume a suspended/crashed run
```

## Add more

```bash
gnl add memory     # conversation memory (threads)
gnl add rag        # retrieval-augmented generation
gnl add mcp        # connect MCP servers
gnl add workflow   # durable multi-step workflow
```
