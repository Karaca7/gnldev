# ADR-0001: End users are isolated by default, at one point, for free

- **Status:** Accepted, 2026-09-27
- **Supersedes:** an internal decision of 2026-08-24, kept on file by the maintainers and not part of this repository: its opt-in, fail-open ownership rule, its "no signed token in the free tier", and its "signed token issuance is paid"
- **Where:** the 0.7.0 entry in CHANGELOG.md lists every change this decision produced, including the
  fixes from the audit that followed it

## Context

In one organization, end users of an app built on GNL could read each other's runs, threads and
messages. The server inferred "is this caller staff?" from whether its principal carried a name, so a
named end user was staff on every read path unless a deployment found `subjectBinding: 'strict'`,
an option documented nowhere. Two review panels then measured what was left after the first fix:

- **Per-route gates, fail-open on an unknown owner.** A walk of every REST route as five kinds of
  attacker found 45 leaks on 6 routes. An end user could read a staff member's ownerless run, approve
  its pending tool call, cancel it and append to its thread. A route added without a gate passed all
  50 server test files.
- **Surfaces without auth.** The chat and AG-UI routes answered 200 to a request with no credential,
  ran the model, and filed an ownerless run in the root scope.
- **The organization was not a boundary everywhere.** On MCP, chat and AG-UI, two organizations'
  users with the same id and work key shared one run. Globex received acme's result or answer text.
- **The free-tier end-user token accepted anything a signer produced.** An empty secret, a 100-year
  lifetime, and a `sub` equal to a staff login were all accepted.

## Decision

1. **Every principal says what it is.** `Principal.kind` (`operator` | `application` | `subject`) is
   stamped where the principal is minted, and read only through `callerKind`. A role never makes a
   caller staff; `platform-admin` works for operators only.
2. **Reads go through one view.** A caller that speaks for a user (an end user, or an application
   naming one) is handed `withSubjectJournal`/`withSubjectMemory` (@gnldev/durable) by the REST API's
   `scope()`. A run or thread that is not that user's, or has no owner, reads as nothing. In the root
   scope, every organization's rows are hidden. A record you may not read answers 404, the same as a
   missing one.
3. **Writes keep their gates, which fail closed.** An existing ownerless run or thread is refused to
   anyone who is not staff. A record that does not exist yet may be created.
4. **One door per concern.** Chat and AG-UI are `surfaces` of `createRestApi`: they translate the
   wire format, and the API decides identity, organization and ownership. The standalone routes
   refuse to start in production without `identity`. MCP takes its identity from the same provider
   (`identityFromAuth`) and serves no caller it cannot place. MCP, chat, AG-UI and REST all scope an
   organization's storage through `scopeConfigToOrg`.
5. **End users hold their own token, in the free tier.** `roleAuth({ endUsers })` verifies a token the
   application signs, and reads only `sub`. The secret must be at least 32 bytes. A token lives at most
   1 hour, or up to 30 days when `isRevoked` can take it back. `sub` follows the `resourceId` rules and
   may not use a staff namespace; staff are compared as `operator:<id>`. Refresh belongs to the
   application: `subjectTokenEndpoint`, and `@gnldev/client`'s `getToken`. GNL keeps no session.
6. **Isolation is free.** Every control above ships in @gnldev/auth, @gnldev/durable and
   @gnldev/server. @gnldev/auth-ee sells management (SSO, user directory, RBAC, FGA, audit), never
   who can see what.

## Alternatives rejected

- **Per-user key prefixes in storage** (rejected once already, by the earlier decision). Closes routes by construction, but it needs
  a data migration, splits one idempotent operation into one per user, and turns every staff read
  across the organization into N queries.
- **Relationship tuples (FGA) instead of a kind.** Paid, a second write for every run, and it still
  needs a check in every route. It also cannot express "an application speaking for a user".
- **Opaque per-user tokens in a free store, as the earlier decision proposed.** Revocable, but every replica
  has to read a shared store, and GNL would hold session state the application already has. Chosen
  instead: stateless tokens with a hard lifetime bound and an optional revocation hook.

## Consequences

- **Breaking, released as 0.7.0** (0.x: no shims). See CHANGELOG [0.7.0]. The breaks: ownerless
  records are staff's; reads you may not make answer 404; tokens are validated strictly; unauthenticated
  writes answer 401; staff actor stamps are `operator:<id>`; standalone chat and AG-UI need `identity`
  in production; scaffolded chat moves to `/agents/:name/chat` on the API.
- **Guarded by** `subject-isolation-conformance.test.ts`. It walks every REST route, including
  surfaces, as five attackers and three controls, and its list of known leaks is empty and may only
  shrink. The same holds for `subject-refused-everywhere.test.ts` over Studio's routes.
- **Covered since:** queued jobs, scheduled workflows and events carry their user and organization
  (`enqueue`/`scheduleWorkflow`/`emit` take `resourceId` and `orgId`); a knowledge base answers an end
  user from shared documents and their own (`visibleTo`); a thread's owner is recorded, not derived.
- **Not covered yet:** ownership in the storage port (`ListQuery.owner`, the long-term form of point 2);
  edge runtimes.

## Prediction (to be checked by git)

A new REST read route needs **no ownership code** to be isolated, and the walk fails if it leaks. A
new write route that touches an existing run needs one gate call (`ownershipDenied`), and the walk
fails without it. If a future change needs a third kind of per-route ownership code, point 2 was not
enough and `ListQuery.owner` is due.
