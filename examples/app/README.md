# @gnldev/app — Durable AI Support Desk

A real reference app that uses our framework **end to end**. **No API key required** (deterministic support agent).

```bash
cd ../../ && pnpm -r build && cd examples/app   # build the packages
pnpm start
# 🎫 http://localhost:3100  (web UI)   🔍 http://localhost:3100/studio  (ops studio)
# One port, not two: Studio is mounted into the same app under /studio (see src/index.ts).
# Override with PORT=… — 3100 is the default in src/index.ts.
```

## Flow (try it)
1. Open a ticket for **cust-1** in the UI.
2. Type `I want a refund for ORD-1042` → the agent searches the policy (RAG) → calls the refund tool.
3. 80₺ > 50₺ → **guard requires approval** → shows "⏸ Awaiting approval" + **Approve/Deny**.
4. **Approve** → the refund is processed (**at-most-once** — an approved refund already recorded as done is not repeated), triggering a background email job (`@gnldev/queue`) + a refund event (`@gnldev/events`).
5. The refund/email/notification counters on the ops bar increase. Inspect the run with time-travel in **Ops Studio**.

> **No auth, on purpose — and that is what makes the `customerId` here wrong for production.** This
> demo takes the customer from the request body (`src/server.ts`), which is exactly what
> `docs/QUICKSTART-PROTECTED.md` and the resolver `gnl init --identity end-users` writes both spell as
> **NEVER**: a subject read out of the body is the caller naming whoever they like. It is harmless
> here because there is no credential to lie about — every caller is the operator — and it keeps the
> example about the packages. In a real app the subject comes from something the SERVER verified; see
> [@gnldev/server](../../packages/server/README.md#identity). The row below says per-customer recall
> because the memory layer does scope on the id it is handed; nothing here checks who handed it.

## Which packages, where
| Package | Usage |
|---|---|
| `@gnldev/durable` | `createGnl` agent + a **durable run** per message (refund at-most-once) + `resumeRun` (approval) |
| `@gnldev/memory` | `AgentMemory` per-customer recall (`scope:'resource'`) + schema working memory |
| `@gnldev/rag` | policy knowledge base (`searchPolicy` tool) |
| `@gnldev/cache` | embeddings cached cross-run |
| `@gnldev/processors` | PII redaction + moderation (on every input) |
| `@gnldev/queue` | **send-email** background job after refund |
| `@gnldev/events` | **refunds** event publish (idempotent `emit` + CAS ack marking) → notification |
| `@gnldev/otel` | `/api/tickets/:id/trace` → OTEL span + cost |
| `@gnldev/studio` | ops view, mounted at `/studio` on the same port: time-travel/fork/approval queue |

Extension points: `@gnldev/a2a` (remote expert agent), `@gnldev/mcp` (external tools), `@gnldev/workflow` (refund pipeline), `@gnldev/evals` (quality scores).
