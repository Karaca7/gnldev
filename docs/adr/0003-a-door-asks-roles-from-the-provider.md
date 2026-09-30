# ADR-0003: A standalone door asks the provider for roles, as it asks it for identity

- **Status:** Accepted, 2026-09-30
- **Builds on:** ADR-0002 (one way in for identity, one owner per rule). This decision does not change
  who a caller is; it lets a standalone door ask what that caller may do, from the same owner.

## Context

A role is decided by the provider's `authorize` (auth-ee's RBAC, or the free `roleAuth`). Only
`makeGate` asked it, and only @gnldev/server and @gnldev/studio use `makeGate`. The standalone chat and
AG-UI routes take `identify` and nothing else, so they checked identity and ownership and never roles.

Measured on 0.8.0, same provider, same token: a `viewer` got 403 from `POST /agents/a/stream` on the
REST API and ran the agent through `createChatRoute` and `createAguiRoute` (200, model ran). The same
held on the free tier with `roleAuth`. Chat and AG-UI mounted on the REST API with `surfaces` were
refused (403): the gap was the standalone routes only. MCP already had its hook (`allowTool`).

The READMEs said the routes "authorize nothing" themselves, but also showed
`identify: (req) => auth.authenticate(req)`, which reads as if the provider — roles included — applied.

## Decision

The chat and AG-UI routes take an optional `authorize` next to `identify`, the provider's own
`AuthProvider['authorize']`:

```ts
createChatRoute(config, {
  identify: (req) => auth.authenticate(req),
  authorize: (principal, req, ctx) => auth.authorize(principal, req, ctx),
});
```

Given, the route asks for `agents:run` before a run through one helper in @gnldev/auth
(`authorizeDoorRequest`), with the context `makeGate` asks with (`permissionContext`, one function for
both), and answers a refusal with 403 (401 with no caller). The verdict is noted, so `onDecision`
records it as `rbac`. Without `authorize` nothing changes. MCP keeps `allowTool`.

The rule has one owner: the provider. A door depends on @gnldev/auth only (ADR-0002 point 0; checked by
`check:hygiene` section 3).

## Alternatives rejected

- **A warning when roles are not checked.** Does not close the gap, and measured a false alarm: a
  `roleAuth` end user (`roles: ['end-user']`) is a legitimate caller and triggered it.
- **Documentation only.** Does not close the gap.
- **Roles checked by default, or the door taking the whole `auth: AuthProvider`.** Closes the gap for
  everyone, but breaks every standalone door deployment and contradicts ADR-0002 point 1 (a door takes
  identity through `identify` only). Not prototyped.

## Consequences

- Not breaking: `authorize` is optional.
- The weak point: an optional hook can be forgotten. A door that is handed a provider's `authenticate`
  but not its `authorize` still runs any identified caller. Closing that would mean an RBAC column in the
  ADR-0002 conformance table, so a new door cannot leave it out.
- @gnldev/auth gains exports: `authorizeDoorRequest`, `AGENTS_RUN`, the `Authorize` type.

## This decision is wrong if

A door handed `authorize` accepts a request the REST API refuses for the same principal and permission,
or the two build a different context for the same permission.
