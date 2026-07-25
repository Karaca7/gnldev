# @gnldev/app — Durable AI Support Desk

A real reference app that uses our framework **end to end**. **No API key required** (deterministic support agent).

```bash
cd ../../ && pnpm -r build && cd examples/app   # build the packages
pnpm start
# 🎫 http://localhost:3000  (web UI)   🔍 http://localhost:4321  (ops studio)
```

## Flow (try it)
1. Open a ticket for **cust-1** in the UI.
2. Type `I want a refund for ORD-1042` → the agent searches the policy (RAG) → calls the refund tool.
3. 80₺ > 50₺ → **guard requires approval** → shows "⏸ Awaiting approval" + **Approve/Deny**.
4. **Approve** → the refund is processed (**exactly-once**), triggering a background email job (`@gnldev/queue`) + a refund event (`@gnldev/events`).
5. The refund/email/notification counters on the ops bar increase. Inspect the run with time-travel in **Ops Studio**.

## Which packages, where
| Package | Usage |
|---|---|
| `@gnldev/durable` | `createGnl` agent + a **durable run** per message (refund exactly-once) + `resumeRun` (approval) |
| `@gnldev/memory` | `GnlMemory` per-customer recall (`scope:'resource'`) + schema working memory |
| `@gnldev/rag` | policy knowledge base (`searchPolicy` tool) |
| `@gnldev/cache` | embeddings cached cross-run |
| `@gnldev/processors` | PII redaction + moderation (on every input) |
| `@gnldev/queue` | **send-email** background job after refund |
| `@gnldev/events` | **refunds** exactly-once event publish → notification |
| `@gnldev/otel` | `/api/tickets/:id/trace` → OTEL span + cost |
| `@gnldev/studio` | ops view (separate port: time-travel/fork/approval queue) |

Extension points: `@gnldev/a2a` (remote expert agent), `@gnldev/mcp` (external tools), `@gnldev/workflow` (refund pipeline), `@gnldev/evals` (quality scores).
