# @gnldev/a2a

**Remote agent-to-agent**: calls a remote agent on a `@gnldev/server` REST endpoint as an AI SDK tool. **Deduped across the network:** runId is deterministic — `` a2a:${idempotencyKey ?? toolCallId} `` → the remote `runDurable` replays the same runId, so a second POST has no side effect ([at-most-once for the remote effect](../durable/README.md#what-never-charged-twice-actually-means)).

> **A runId has two shapes, and this one is deliberate.** Most runIds are opaque `run1_…` digests the engine mints from a caller's `workKey`. Engine-issued runs keep **readable composite ids** on purpose (`sched:`, `job:`, `a2a:`, `eval:`, `wf:`, `batch:`): the engine writes them itself, they are already deterministic, and nothing is stored that a hash would protect. `a2a:` in particular *must* stay readable — hashing it would make the two deployments derive different ids for the same call, and cross-network dedup is precisely what that would break. `idempotencyKey` is what `durableTool` injects (parent-run-scoped, so it is globally unique); the bare `toolCallId` is only the fallback for a plain AI SDK loop, where two different parent runs can emit the same short id (`call_1`) and collide. When wrapped in durableTool inside a parent `runDurable`, the remote call is skipped on parent resume.

> Install: `pnpm add @gnldev/a2a` on **both ends** of the call — or run both from a [repo clone](https://github.com/Karaca7/gnl-framework) (`pnpm install && pnpm -r build`).

```bash
npm i @gnldev/a2a   # peer: ai, zod
```

```ts
import { createA2ATool } from '@gnldev/a2a';

const tools = {
  research: createA2ATool({ endpoint: 'https://agents.internal', agentName: 'researcher' }),
};

// Router/parent agent calls the 'research' tool → POSTs to remote /agents/researcher/run.
await runDurable({ runId: 'parent-1', journal, model, tools, prompt: 'Research X' });
```

## API
- `createA2ATool({ endpoint, agentName, description?, headers?, fetchImpl?, timeoutMs?, secret?, budgetGuard? })` → AI SDK tool
  - `fetchImpl`: for test/custom transport (e.g. Hono `app.request`).
  - `timeoutMs`: remote-call timeout, default `30_000`. On expiry a `StepTimeoutError` is thrown, so the
    wrapping `durableTool` journals a `failed` record and the model sees the real error — never a silent hang.
  - `secret`: opt-in HMAC-SHA256 request signing. The body goes out with `x-gnl-signature`
    (`HMAC(secret, timestamp + '.' + body)`) and `x-gnl-timestamp`; the remote verifies it via
    `createRestApi({ a2aSecret })`. Omit it and requests are unsigned, exactly as before.
  - `budgetGuard`: called *before* the fetch — typically `@gnldev/durable`'s `assertBudget`. It gates the
    call made **from this process** only; a2a cannot see or enforce the remote endpoint's own quota. Throwing
    propagates as-is. Omit it and no quota check happens.

## How it works
The tool POSTs to the remote REST endpoint with a deterministic runId. Since both the remote and parent are durable, there's no double-execution even across the network — deterministic for distributed agent calls.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
