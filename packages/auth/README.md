# @gnldev/auth

The auth contract the rest of the framework speaks, plus a role-based default you can use as-is.

Auth is **opt-in**: leave it out and the REST API and Studio stay open (fine for local work). Wire a
provider in and every route is gated. In production, a missing provider is an error rather than a
silent open door.

## Install

> **Not on npm yet** — no `@gnldev/*` package has been published. Until the first release, use it from a [repo clone](https://github.com/Karaca7/gnl-framework): `pnpm install && pnpm -r build`.

```bash
npm i @gnldev/auth
```

## Role-based default

Two roles: `admin` may read and write, `viewer` may only read. Credentials can be a bearer token or
a user/password pair for basic auth — comparison is constant-time.

```ts
import { roleAuth } from '@gnldev/auth';
import { createRestApi } from '@gnldev/server';

const auth = roleAuth({
  admin: { token: process.env.GNL_ADMIN_TOKEN },
  viewer: { token: process.env.GNL_VIEWER_TOKEN },
});

const app = createRestApi(config, { auth });
```

`roleAuth` returns `undefined` when no role is configured — that is what keeps auth opt-in.

## The contract

| Export | What it is |
|---|---|
| `AuthProvider` | `authenticate(request)` → a `Principal` or `null`, then `authorize(principal, request, ctx)` → `{ allow }` |
| `roleAuth` | The bundled provider above |
| `makeGate` | Turns a provider into a gate a host can apply to routes |
| `principalOf` | Reads the principal a gate resolved for a request |
| `normalizeAuth` / `fromReadWrite` | Accepts the older `{ read, write }` predicate pair and adapts it to the provider interface |

## Extending it

`AuthProvider` is the seam. Anything implementing it works: your own JWT logic, an identity service,
or the paid `@gnldev/auth-ee`, which plugs into this same interface to add SSO, RBAC, fine-grained
authorization and a relational user store. Nothing in this package needs to change to swap providers.

A provider may also declare `capabilities()` — that is how a host learns whether features like
role-based access or multi-organization scoping are available.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
