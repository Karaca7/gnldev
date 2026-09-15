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
> caller-supplied `resourceId` unchecked.

### `superAdmin` is stated, never inferred

An identity belonging to no organization is **not** treated as an operator by accident. Once `org` is
configured, an unbound identity is refused unless it is declared `superAdmin`; otherwise a forgotten
`orgId` would quietly mint a cross-organization super-admin.

## The contract

| Export | What it is |
|---|---|
| `AuthProvider` | `authenticate(request)` → a `Principal` or `null`, then `authorize(principal, request, ctx)` → `{ allow }` |
| `roleAuth` | The bundled provider above |
| `CLIENT_WRITES` | The exact set of writes a `client` may perform — read it rather than guessing |
| `PLATFORM_ADMIN_ROLE` / `isPlatformAdmin` | The reserved cross-organization grant `superAdmin` carries |
| `makeGate` | Turns a provider into a gate a host can apply to routes |
| `principalOf` | Reads the principal a gate resolved for a request |
| `normalizeAuth` / `fromReadWrite` | Accepts the older `{ read, write }` predicate pair and adapts it to the provider interface |

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
