# @gnldev/chat-adapter

Compatibility with the Vercel AI SDK's UI layer: run a durable agent on the server, render it with
`useChat` on the client.

## Install

> Install: `pnpm add @gnldev/chat-adapter` — or use it from a [repo clone](https://github.com/Karaca7/gnl-framework): `pnpm install && pnpm -r build`.

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
unchanged — while the run behind it is journaled, replayable, and its side effects are
[at-most-once](../durable/README.md#what-never-charged-twice-actually-means).

You normally do NOT need `resolveRunId`: the default derivation `${body.id}:${lastMessage.id}` gives
one durable run PER TURN (a network retry of the same turn replays; a new turn runs fresh).
Anti-pattern to avoid: `resolveRunId: (_c, body) => body.id` — useChat's `body.id` is stable for the
WHOLE conversation, so every later turn would replay turn 1 from the journal forever. What that
derived string *is* — a name the engine hashes into an id, or the id itself — depends on whether the
route can name the user; see [the idempotency contract](#the-idempotency-contract).

## Who is this request for? (`identity` / `resolveResourceId`)

This route ships with **no auth of its own** — deliberately, and the same posture as `@gnldev/agui`.
What that leaves you responsible for is one thing: naming the end user each run acts for.

**Why it is not optional.** GNL has no end-user identity of its own. An end user is a *subject* a
trusted application names, not a principal GNL authenticates. The engine treats a few reserved
context keys as "the server established this" — and an early version of this route forwarded
`body.context` verbatim, so the reserved key arrived from whoever sent the request. Measured against
a running app: a plain POST carrying `{"context":{"__gnl_resourceId":"VICTIM"}}` produced a run owned
by that name, and the ownership stamp followed it.

The route now **always seals** the context, so that specific forgery is closed whether or not you
pass a resolver. What a resolver decides is the other half: whether the run has an owner at all.

```ts
import { createChatRoute } from '@gnldev/chat-adapter';

const chat = createChatRoute({ gnl }, {
  // ONE hook for both fields. The same signature @gnldev/agui's route takes.
  identity: (req) => {
    const session = db.sessions.get(req.headers.get('cookie'));   // YOUR session store
    return session ? { resourceId: session.userId, threadId: session.conversationId } : undefined;
  },
});
```

`identity` receives the **web `Request`**, not the Hono context, so a host bridging this route from
Express or Fastify can use it. It is called once per request and may return `undefined`.

**Read it from something the server trusts** — a session cookie, a verified JWT,
`principalOf(req)?.id` — and **never from the request body**. A body-supplied subject is the caller
naming whoever they like, which is the hole the context seal exists to close.

**If you give none.** Nothing is asserted and nothing is forged: runs are born **ownerless**. That is
safe against impersonation and weak in the other direction — an ownership gate with no owner to
compare against refuses nobody, so the protection reads as present and is not. Memory also has
nothing to scope on, so per-user recall and `listThreads` have no subject to key by. In
`NODE_ENV=production` the route says so once, at construction, with a `console.warn` — it never
throws, because a deployment whose boundary genuinely lives in front of this route is not broken.

**Precedence**, field by field:

| Field | Order |
|---|---|
| `resourceId` | `resolveResourceId(c, body)` → `identity(req).resourceId` → *(none)* |
| `threadId` | `resolveThreadId(c, body)` → `identity(req).threadId` → `body.threadId` → `body.id` → the runId |

`resolveResourceId` / `resolveThreadId` still win: they are the existing contract, and a newer
convenience must not quietly take a working deployment's answer away. `identity` outranks the body,
because it is server-derived and the body is not.

**Honest bound.** A resolver reading an *unauthenticated* request asserts a subject nobody verified.
Put auth in front of this route — or compose `@gnldev/server`'s `createRestApi` auth middleware
around it — or the subject is only as trustworthy as the caller.

## The idempotency contract

**Two regimes, decided by whether the route can name a subject.** The per-turn key
(`${body.id}:${lastMessage.id}`, or an `Idempotency-Key` header when a gateway sends one) is this
route's name for *the work this turn is*. When `identity` / `resolveResourceId` gives that turn an
owner, the key is promoted to a **`workKey`**: the engine derives the run's id from it
(`run1_<digest>`) and the string you sent stops being a journal key. When there is nobody to name —
the anonymous quickstart, no auth, no session store — the same string stays the raw runId it has
always been, byte for byte. Deriving an id from a name needs an *address* to make it unique within,
and a route with no subject has none; refusing those requests would replace a working first five
minutes with an error message. Your retry contract is identical in both: the same message ids
produce the same key, and the same key lands on the same run.

One migration note, because the regime is decided by the resolver: **adopting this version — or
wiring `identity` into a deployment that ran without it — changes which id an in-flight turn's retry
lands on** (raw key on the old pods, `run1_` on the new). During that window a retried turn can run
once more. Close the window by draining in-flight requests over the deploy rather than rolling
through it.

- **`X-Gnl-Run-Id` on every response** (success and error): the opaque id of the run this call
  landed on — a **correlation handle** for logs, traces and Studio. It is **not your retry key**: to
  retry, send the same turn again (the same conversation id and the same last-message id). Explicit
  `body.runId` and `resolveRunId` still win, and both stay raw — they name an *id*, and a host
  holding one has already decided the addressing. The `Idempotency-Key` header is read AFTER them (a
  gateway-stamped header must not silently override an application decision).
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
