# @gnldev/chat-adapter

Compatibility with the Vercel AI SDK's UI layer: run a durable agent on the server, render it with
`useChat` on the client.

## Install

> Install: `pnpm add @gnldev/chat-adapter` — or use it from a [repo clone](https://github.com/Karaca7/gnldev): `pnpm install && pnpm -r build`.

```bash
npm i @gnldev/chat-adapter
```

## On the REST API (recommended)

Mount the chat format on `@gnldev/server`'s REST API. The API's auth decides who the caller is, which
organization they are in and whose run this is — the same gates as every REST route — and there is
no second identity resolver to write:

```ts
import { createRestApi } from '@gnldev/server';
import { chatSurface } from '@gnldev/chat-adapter';
import { roleAuth } from '@gnldev/auth';
import type { CreateGnlConfig } from '@gnldev/durable';

declare const config: CreateGnlConfig;

export const api = createRestApi(config, {
  auth: roleAuth({ endUsers: { secret: process.env.GNL_END_USER_SECRET!, orgId: 'acme' } }),
  surfaces: [chatSurface()], // POST /agents/:name/chat — useChat({ api: '/agents/pay/chat' })
  cors: { origins: ['https://app.example.com'] }, // if the browser calls this API directly
});
```

A request with no valid credential is refused before the model runs. An end user's turn is filed
under that user and their organization, shows up in their `GET /runs`, and is visible to their
organization's staff in Studio. `chatSurface({ path })` changes the mount path.

**Sending the user's token from `useChat`.** With end users, a request without a token is a 401, so
the browser attaches one on every request. `headers` may be an async function, so each request asks
your token route for a current one:

<!-- doccheck: skip — @ai-sdk/react is the browser app's dependency, not this repository's -->
```ts
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { tokenFrom } from '@gnldev/client';

const getToken = tokenFrom('/gnl-token'); // your app's route (subjectTokenEndpoint in @gnldev/auth)

const chat = useChat({
  transport: new DefaultChatTransport({
    api: 'https://api.example.com/agents/pay/chat',
    headers: async () => ({ authorization: `Bearer ${await getToken()}` }),
  }),
});
```

## Chat route (standalone)

For a host that authenticates the request itself (a session cookie, a verified token) and tells the
route who is calling through `identify`. In production it refuses to start without `identify`; pass
`identify: () => undefined` to say, explicitly, that there is no per-user identity.

```ts
import { createChatRoute } from '@gnldev/chat-adapter';
import type { Principal } from '@gnldev/auth';

// Your session lookup: who this request is, as YOUR server established it.
declare function userOf(req: Request): Promise<string | undefined>;

app.route('/api', createChatRoute({ gnl }, {
  identify: async (req): Promise<Principal | undefined> => {
    const id = await userOf(req);
    return id ? { kind: 'subject', id, roles: [] } : undefined;
  },
}));
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

## Who is calling? (`identify`)

This route ships with **no auth of its own** — deliberately, and the same posture as `@gnldev/agui`.
What that leaves you responsible for is one function: `identify(req)`, which returns a `Principal`
from `@gnldev/auth`. It is the same function `@gnldev/agui`, `@gnldev/mcp` and `@gnldev/server` take, so you
write "who is this caller" once. An `AuthProvider` is one as it is:

```ts
import { createChatRoute } from '@gnldev/chat-adapter';
import { roleAuth } from '@gnldev/auth';

const auth = roleAuth({ endUsers: { secret: process.env.GNL_END_USER_SECRET!, orgId: 'acme' } })!;

const chat = createChatRoute(config, {
  identify: (req) => auth.authenticate(req), // an end user's signed token → that user, in acme
});
```

The route maps the principal to the engine's caller with `engineCallerOf`, the one mapping every door
uses:

| `principal.kind` | The run acts for | Reaches |
|---|---|---|
| `subject` | that user (`principal.id`) | its own runs and threads |
| `operator` | staff | every run and thread in its organization |
| `application` | the end user it names in the body's `resourceId` | that user's runs and threads |
| *(nothing)* | `unknown` | nothing that belongs to a user or to staff |

The **organization** is `principal.orgId`. It is never read from the body: an org is an isolation
boundary, and a caller who picks their own has none. A run of an org-bound caller is stored in that
organization's partition, where the REST API and Studio read it.

**The thread is checked, not trusted.** `resolveThreadId`, then `body.threadId`, then `body.id` picks
the conversation — choosing one is not an identity claim. The engine checks the thread's owner against
the caller: a user naming staff's thread or another user's thread gets `409 thread_owner_mismatch`,
and the model never sees that thread's history.

### An application acting for its users

An `application` principal (a backend holding an application credential, `roleAuth`'s `client`) speaks
**for** one of its users on each request. It names that user in the body:

<!-- doccheck: skip — a JSON request body, not TypeScript -->
```json
{ "id": "conv-1", "messages": [ ... ], "resourceId": "u-ayse" }
```

`resourceId` is read **for an application only** — the same field, and the same rule, as
`@gnldev/server`'s REST routes. A user who sends it is still itself; staff is still staff. An
application that names nobody, or a name no user can carry (`operator:…`), gets a `400` and nothing
runs: it is never treated as staff and never as anonymous.

**Read the principal from something the server trusts** — a session cookie, a verified JWT, your
`AuthProvider` — and **never from the request body**. The route always seals the request context too,
so a body carrying `{"context":{"__gnl_resourceId":"VICTIM"}}` names nobody.

**If `identify` answers nothing** (or `identify: () => undefined`), the caller is `unknown`. Its runs
are closed to every user and to staff's threads. Memory has nothing to scope on, so per-user recall
and `listThreads` have no subject to key by.

**Honest bound.** An `identify` that trusts an *unauthenticated* request asserts a caller nobody
verified. Put auth in front of this route — or mount `chatSurface()` on `@gnldev/server` instead.

**Breaking in 0.7.** `identity: (req) => ({ resourceId, orgId, threadId })` was replaced by
`identify: (req) => Principal`: the old shape could not say "this caller is staff", and the standalone
route let an end user read a staff member's ownerless thread (measured). Passing `identity` now throws
at construction. `threadId` is no longer taken from the identity hook — use `resolveThreadId`. The
package now depends on `@gnldev/auth`.

## The idempotency contract

**Two regimes, decided by whether the route can name a subject.** The per-turn key
(`${body.id}:${lastMessage.id}`, or an `Idempotency-Key` header when a gateway sends one) is this
route's name for *the work this turn is*. When `identify` names a user for that turn (its
owner), the key is promoted to a **`workKey`**: the engine derives the run's id from it
(`run1_<digest>`) and the string you sent stops being a journal key. When there is nobody to name —
the anonymous quickstart, no auth, no session store — the same string stays the raw runId it has
always been, byte for byte. Deriving an id from a name needs an *address* to make it unique within,
and a route with no subject has none; refusing those requests would replace a working first five
minutes with an error message. Your retry contract is identical in both: the same message ids
produce the same key, and the same key lands on the same run.

One migration note, because the regime is decided by the resolver: **adopting this version — or
wiring `identify` into a deployment that ran without it — changes which id an in-flight turn's retry
lands on** (raw key on the old pods, `run1_` on the new). During that window a retried turn can run
once more. Close the window by draining in-flight requests over the deploy rather than rolling
through it.

**Turns stored before 0.7.** A turn whose caller belongs to an organization is stored in that
organization's partition (`org:<id>:`), the same place the REST API and Studio read. Earlier versions
stored every turn in the shared root, so those older turns are not in any organization's history.

- **One organization:** move the root into it once, with the deployment stopped. Check the counts
  first with `dryRun`:

  ```ts
  import type { Storage } from '@gnldev/durable';

  export async function moveOldTurns(storage: Storage) {
    const preview = await storage.adoptIntoOrg?.('acme', { dryRun: true });
    console.log(preview);
    return storage.adoptIntoOrg?.('acme');
  }
  ```

- **Several organizations:** the old rows do not record which organization they came from, so they
  cannot be split automatically. They stay readable to platform staff in the root scope. Move them
  only if you can tell them apart yourself.

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
