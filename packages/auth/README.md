# @gnldev/auth

The auth contract the rest of the framework speaks, plus a role-based default you can use as-is.

Auth is **opt-in**: leave it out and the REST API and Studio stay open (fine for local work). Wire a
provider in and every route is gated. In production, a missing provider is an error rather than a
silent open door.

## Install

> Install: `pnpm add @gnldev/auth` — or use it from a [repo clone](https://github.com/Karaca7/gnldev): `pnpm install && pnpm -r build`.

```bash
npm i @gnldev/auth
```

## Four credential classes

Pick the class by **who holds the token**, not by how much it needs to do. Credentials can be a bearer
token or a user/password pair for basic auth — comparison is constant-time.

| Class | Who holds it | Organization | Can |
|---|---|---|---|
| `superAdmin` | you, running the platform | none, by design | everything, across every organization |
| `admin` | a customer's operator | bound | manage that organization: Studio, budgets, users, workflows |
| `client` | a customer's **backend server** | bound | run agents, cancel runs, read — nothing else |
| `viewer` | a read-only operator | bound | read |

```ts
import { roleAuth } from '@gnldev/auth';
import { createRestApi } from '@gnldev/server';

const auth = roleAuth({
  // The credential your APPLICATION carries. It serves many end users under one token, so every
  // request names the end user it acts for (see below).
  client: { token: process.env.GNL_CLIENT_TOKEN, orgId: 'acme' },
  // The credential a PERSON carries, for Studio.
  admin: { token: process.env.GNL_ADMIN_TOKEN, orgId: 'acme' },
});

const app = createRestApi(config, { auth });
```

`roleAuth` returns `undefined` when no class is configured — that is what keeps auth opt-in.

### Give your application `client`, not `admin`

`admin` is an operator credential: it cancels runs, edits budgets, manages users and reads the whole
organization's history. An application that only needs to run an agent has no business holding that,
and if it leaks, none of those are things you wanted a leaked key to reach.

`client` is a **whitelist** — `agents:run`, `workflow:run`, `run:cancel`, plus reads. Anything else is
refused, including routes added in later versions. That is the direction you want the default to fail.

### A `client` names the end user it acts for

One application credential serves many end users, so the request says which one:

```ts
const GNL = process.env.GNL_URL!;
const CLIENT_TOKEN = process.env.GNL_CLIENT_TOKEN!;

await fetch(`${GNL}/agents/support/run`, {
  method: 'POST',
  headers: { authorization: `Bearer ${CLIENT_TOKEN}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    runId: 'r-882',
    prompt: 'where is my order',
    threadId: 't-ayse-1',
    resourceId: 'u-ayse',   // ← WHOSE request this is
  }),
});
```

`resourceId` is what separates one end user's conversation, memory and runs from another's. A `client`
request that omits it is refused (`400`) rather than served unscoped — without a subject there is
nothing to keep two of your users apart. Operator classes may omit it: they work across the
organization by design.

You can then ask for one user's data, and have ownership checked:

```
GET /runs?resourceId=u-ayse             → only that user's runs
GET /threads?resourceId=u-ayse          → only that user's conversations
GET /runs/r-882?resourceId=u-mehmet     → 403, the run belongs to someone else
```

> **Keep the client token on your server.** It is trusted to say who it acts for, so anyone holding it
> can claim any `resourceId`. That is safe in your backend, where you already know who your user is.
> It is not safe in a browser or a mobile app — ship neither the token nor a proxy that forwards a
> caller-supplied `resourceId` unchecked. To let a browser call GNL directly, give it an end-user
> token instead (next section).

### An end user can carry its own token

When your user logs in, your backend signs a short-lived token for that one user. The browser or app
calls GNL with it. The holder is that user and nobody else:

```ts
import { roleAuth, signSubjectToken } from '@gnldev/auth';

// In GNL's config:
const auth = roleAuth({
  endUsers: { secret: process.env.GNL_END_USER_SECRET!, orgId: 'acme' },
});

// In your backend, after YOUR login succeeds:
const token = signSubjectToken({ sub: 'u-ayse' }, process.env.GNL_END_USER_SECRET!, { ttlSec: 900 });
```

Only `sub` is read. The holder is always a `subject`, with the organization from `orgId` above. A
`kind`, `roles` or `orgId` claim in the token is ignored, so a token cannot make its holder staff or
move it to another organization. Writes are the same whitelist as `client`.

A token signed with a different key, an expired one, or one without `sub` is nobody (`401`). Tokens
last 15 minutes by default. Use `publicKey` instead of `secret` if you sign with RS256 or Ed25519, and
`issuer`/`audience` to pin those claims.

**Rules a token must meet.** The `secret` is at least 32 bytes; a shorter one is a startup error. The
`sub` follows the same rules as a `resourceId` (1–200 characters, no control characters) and may not
start with `operator:`, `application:`, `role:` or `token:`, which name staff and synthetic ids.

**How long a token may live.** At most 1 hour (`maxTtlSec`, default 3600). A token claiming a later
`exp` is refused. If you can take tokens back, pass `isRevoked` and you may allow up to 30 days: for a
credential pasted into an MCP client's config, or a link in an email.

```ts
import { roleAuth } from '@gnldev/auth';

const loggedOut = new Set<string>(); // your store: a jti deny-list (at logout: add sessionTokenId(sid)), or a per-user logout time

export const auth = roleAuth({
  endUsers: {
    secret: process.env.GNL_END_USER_SECRET!,
    orgId: 'acme',
    maxTtlSec: 7 * 24 * 3600,
    // Asked on every request after the signature checks. `true` refuses; a throw refuses too.
    isRevoked: ({ jti }) => (jti ? loggedOut.has(jti) : false),
  },
});
```

Without `isRevoked`, a token lives until its `exp` even after logout; that is what the 1-hour bound is
for. A per-user logout time (`iat < loggedOutAt(sub)`) needs `iat` in the token: `signSubjectToken`
and `subjectTokenEndpoint` set it, but a token minted elsewhere may not — deny by `jti`, or refuse
tokens with no `iat` in `isRevoked`.

### Refreshing an end user's token

GNL keeps no session, so refresh belongs to your app, whose session already knows whether the user is
still logged in. Add one route that mints a fresh token from that session, and let the browser client
call it:

```ts
import { subjectTokenEndpoint } from '@gnldev/auth';

// Your session lookup; `null` = logged out → 401. The token's `jti` is `sessionTokenId(sid)`, a
// one-way id of the session: the session cookie's value never reaches the browser's JavaScript.
// At logout, deny `sessionTokenId(sid)` and `isRevoked` refuses every token of that session.
declare function sessionOf(req: Request): Promise<{ sub: string; sid?: string } | null>;

export const gnlToken = subjectTokenEndpoint(sessionOf, process.env.GNL_END_USER_SECRET!, { ttlSec: 300 });
// Mount it as POST /gnl-token on your app's own origin.
```

The endpoint answers POST only, refuses cross-site requests, and marks the answer `no-store`. Do not
add CORS headers to it. On the browser side, `@gnldev/client`'s `getToken` option refreshes before
the token expires and after a `401`, one refresh for all concurrent requests. A stream is authorized
when it starts and is not cut off when its token expires.

GNL can check that your backend signed the token. It cannot check that your backend signed it for the
right person; that part is your login.

### `superAdmin` is stated, never inferred

An identity belonging to no organization is **not** treated as an operator by accident. Once `org` is
configured, an unbound identity is refused unless it is declared `superAdmin`; otherwise a forgotten
`orgId` would quietly mint a cross-organization super-admin.

## What a caller is: `kind`

Every `Principal` says **whose data it acts on**. The one who mints the principal decides it; the request
never does.

| `kind` | Who | Acts on |
|---|---|---|
| `operator` | staff: `superAdmin`, `admin`, `viewer` | anyone's data inside its scope |
| `application` | your backend: `client` | the end user it names on each request |
| `subject` | an end user | its own data, and only its own |

`roleAuth` stamps it for you. A credential in your config is staff, because whoever can edit that file
already runs the deployment. A provider you write has to stamp it too; `kind` is required on the type.

Read it with `callerKind(principal)`, not `principal.kind`. It adds one more answer: `unnamed`, for no
principal, or a subject with no `id`. It also reads an unstamped principal, from a JavaScript provider or
a cast, **fail-closed**: a user if it has an `id`, `unnamed` if not. Never an operator. Staff is a grant,
and a missing grant stays missing.

Roles do not change the kind. A `subject` that holds the `admin` role is still a user. Only an operator
may create an operator or an application: `assertAssignablePrivileges(assigner, { kind })` refuses
everyone else.

## The contract

| Export | What it is |
|---|---|
| `AuthProvider` | `authenticate(request)` → a `Principal` or `null`, then `authorize(principal, request, ctx)` → `{ allow }` |
| `roleAuth` | The bundled provider above |
| `CLIENT_WRITES` | The exact set of writes a `client` (and an end user) may perform — read it rather than guessing |
| `signSubjectToken` / `verifyJwt` | Sign an end user's token in your backend; the verifier every GNL token goes through. `verifyJwt`'s `onClaims` receives the claims once signature and time checks pass, for a caller that needs more than the `Principal` (e.g. `iat`/`jti` for revocation) |
| `subjectTokenEndpoint` | Your app's refresh route: session → fresh short-lived token |
| `actorIdOf` | The name identity comparisons use: a user's own id, `operator:<id>` for staff |
| `Identify` | `(req) => Principal \| null \| undefined` (may be async): "who is this request", written once and handed to every door — `@gnldev/server`, `@gnldev/chat-adapter`, `@gnldev/agui`, `@gnldev/mcp`. A provider's `authenticate` is one: `(req) => auth.authenticate(req)` |
| `engineCallerOf` | The one mapping from a principal to the engine's caller: `subject` → that user, `operator` → staff, `application` → the user it names on the request (unknown if none), nothing → unknown |
| `callerOfRequest` | What a standalone door does with a request: `identify` once, then `engineCallerOf`. An application's user is read from the request's `resourceId` for an application only; an application naming nobody is refused (`APPLICATION_NAMES_NO_USER`) |
| `PLATFORM_ADMIN_ROLE` / `isPlatformAdmin` | The reserved cross-organization grant `superAdmin` carries |
| `callerKind` / `isPrincipalKind` / `PRINCIPAL_KINDS` | What a caller is (see above), read fail-closed |
| `assertAssignablePrivileges` | The ceiling for user management: no one hands out a grant they do not hold |
| `makeGate` | Turns a provider into a gate a host can apply to routes |
| `principalOf` | Reads the principal a gate resolved for a request |
| `normalizeAuth` / `fromReadWrite` | Accepts the older `{ read, write }` predicate pair and adapts it to the provider interface |
| `AuthProvider.onDecision` / `AccessDecision` | Optional. Called once per request, after the host answered, with what the caller GOT: `{ principal, kind, orgId, path, method, action, permission, allowed, reason, detail, status }`. See below |
| `markRefusal` / `RefusalReason` | How a host records why it refused a request (`unauthenticated`, `rbac`, `ownership`, `organization`, `resource`, `policy`) — including a refusal it answers as a 404 |
| `settleDecision` / `outcomeOf` | The one rule that turns a request's notes into an `AccessDecision`; `makeGate(...).settle(req, status)` calls it |

### Recording decisions: `onDecision`, not `authorize`

`authorize` answers **before** the host's own gates — whose run this is, which organization, which
resource. So its verdict is not the answer: a request it allowed can still be refused. Measured on
0.7 before this hook: `GET /runs/<another user's run>` answered 404, and a record written from
`authorize` said "allowed".

A provider that keeps a record implements `onDecision`. `@gnldev/server` and `@gnldev/studio` call it
once per request with the final outcome. A refusal answered as a 404 (to hide that a run exists) is
still `allowed: false, reason: 'ownership'` in the record. A real miss is `allowed: true, status: 404`.
A 401 or 403 that no gate explained is reported as refused (`unauthenticated` / `policy`), never as
allowed. If `onDecision` throws, the host answers 500 instead: the response is not delivered unrecorded.

The standalone doors have no provider, only `identify`. `@gnldev/chat-adapter` and `@gnldev/agui` take
an `onDecision` option for this; `@gnldev/mcp` has none, so its calls are not recorded (see its README).

`identityFromAuth` (the MCP-only adapter) was removed in 0.7: `@gnldev/mcp` takes `identify` like every
other door, and a provider's `authenticate` is already one.

## Extending it

`AuthProvider` is the seam. Anything implementing it works: your own JWT logic, an identity service,
or the paid `@gnldev/auth-ee`, which plugs into this same interface to add SSO, RBAC, fine-grained
authorization and a relational user store. Nothing in this package needs to change to swap providers.

A provider may also declare `capabilities()` — that is how a host learns whether features like
role-based access or multi-organization scoping are available.

### What the paid provider adds on top of these four

The four classes above are **fixed**: `viewer` reads everything inside its organization, and there is
no way to narrow it. `@gnldev/auth-ee` replaces the classes with per-user permissions, so you choose
what each person sees:

```
Ayşe   runs:read ✓   threads:read ✗   money:read ✗    → sees that a run failed,
                                                         not what the customer typed into it
```

Reads are named the same way writes are — `runs`, `threads`, `money`, `audit`, `users`, `catalog` —
and `*:read` still means all of them, so nothing an existing grant could reach becomes unreachable.
Isolation itself is **not** the paid part: the organization boundary, the `client` whitelist and the
`resourceId` rules above are all in this package, and none of them turn on when you pay.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
