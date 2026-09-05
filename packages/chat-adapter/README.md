# @gnldev/chat-adapter

Compatibility with the Vercel AI SDK's UI layer: run a durable agent on the server, render it with
`useChat` on the client.

## Install

> **Not on npm yet** — no `@gnldev/*` package has been published. Until the first release, use it from a [repo clone](https://github.com/Karaca7/gnl-framework): `pnpm install && pnpm -r build`.

```bash
npm i @gnldev/chat-adapter
```

## Chat route

```ts
import { createChatRoute } from '@gnldev/chat-adapter';

app.route('/api', createChatRoute({ gnl }));
// POST /api/agents/:name/chat — useChat({ api: '/api/agents/pay/chat' }) works unchanged.
```

The route streams back in the AI SDK's UI-message format, so an existing `useChat` frontend works
unchanged — while the run behind it is journaled, replayable and exactly-once.

You normally do NOT need `resolveRunId`: the default derivation `${body.id}:${lastMessage.id}` gives
one exactly-once run PER TURN (a network retry of the same turn replays; a new turn runs fresh).
Anti-pattern to avoid: `resolveRunId: (_c, body) => body.id` — useChat's `body.id` is stable for the
WHOLE conversation, so every later turn would replay turn 1 from the journal forever.

## The idempotency contract

- **`X-Gnl-Run-Id` on every response** (success and error): the effective runId — your client's
  retry key is a header contract, not something to re-derive from useChat internals. Explicit
  `body.runId` wins; an `Idempotency-Key` header is accepted as an alias AFTER `body.runId` and
  `resolveRunId` (a gateway-stamped header must not silently override an application decision).
- **A per-run lock is ON by default** (`lock: { ttlMs: 300_000 }`): two concurrent requests with the
  same runId (double-click, two tabs, a retry racing the original) no longer both execute — the
  loser gets a typed `409 { code: 'run_busy', resumable: true }` + `Retry-After`, and retrying the
  same runId lands on the journal replay. `lock: false` restores the old behavior. Scope note: this
  serializes CONCURRENT duplicates; serial retries were already deduped by the runId derivation.
- **`X-Gnl-Idempotency-Status` on success responses**: `new` on a fresh run, `replay` when this
  runId had prior journaled input (a retry/resume landing on journal state) — an observability
  contract for client-side reconciliation, not a byte-identity guarantee.
- **Typed errors instead of a flat 400**: `run_thread_mismatch` / `run_input_mismatch` /
  `run_actor_mismatch` / `run_swept` → 409 without `resumable` (fix the id, not the request);
  `run_busy` → 409 + `Retry-After`; `retry_limit_exceeded` → 422; upstream provider failures →
  429/502/504. Malformed `messages` stays a 400 — with the header contract intact.

## Approvals round-trip (`approve` / `approvalPayload`)

When a tool suspends (a guard's `require-approval`, the `confirm` field, a duplicate/semantic
question), the stream carries a `data-gnl-interrupt` chunk whose entries include the **suspended
run's `runId`** — the approval's ADDRESS. A naive client that just re-POSTs its messages derives a
FRESH runId from the new last-message id: the approval lands on a brand-new run and the suspended
one waits forever. Use the helpers:

```ts
import { approvalPayload, approve } from '@gnldev/chat-adapter';

// useChat-style: merge the payload into YOUR next request body (same conversation id, same messages)
sendMessage(undefined, { body: approvalPayload(interrupt) });      // { runId, approvals: { [toolCallId]: true } }

// headless/manual: a convenience fetch that re-POSTs and returns the streaming Response
await approve('/api/agents/pay/chat', { interrupt, chatId, messages });
```

`approvalPayload` THROWS on an interrupt without `runId` rather than silently targeting a fresh run.
Product rules, stated plainly: approval is a BUTTON — the route reads decisions only from
`body.approvals`; a user typing "yes, do it" starts a fresh turn, it approves nothing. And
"regenerate" with the same runId gets the journal REPLAY (the safe default); genuinely re-running a
side effect goes through the approval ladder, never a silent re-execution.

## Rebuilding history from the journal

```ts
import { toUIMessages } from '@gnldev/chat-adapter';

const messages = toUIMessages(await journal.list(runId));
```

The journal is the source of truth, so a reconnecting client can rebuild the conversation without
the server holding session state.

## Exports

| Export | What it is |
|---|---|
| `createChatRoute` | A handler that runs an agent and streams UI messages |
| `toUIMessageStream` / `toUIMessageStreamResponse` | Converts a durable stream into the UI-message wire format, masking the internal sentinels |
| `toUIMessages` | Journal records → `UIMessage[]` for history reconstruction |
| `approvalPayload` / `approve` | The approval round-trip helpers — land the decision on the SUSPENDED run (see above) |
| `maskSentinelOutput` | The shared sentinel-masking primitive (used by both live streaming and history) |

## A note on history

`useChat` posts the entire client-side history on every turn. When the agent has memory and a
`threadId`, the server owns the history instead — the client's copy is a view, not the record. That
contract is enforced in the core, not here.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
