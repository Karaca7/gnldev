# org_scope_refused

**HTTP 403 · operator console**

## What happened

The request reached Studio with an organization scope that does not cover the object it addressed —
a run, thread, policy or budget belonging to another organization. Serving it would hand one
organization another one's data, so the console refused instead.

## Why the framework can't guess

Multi-org isolation is enforced by key prefixing (`org:<id>:` — see `withOrg`); an object outside
your prefix is structurally another tenant's. There is no safe partial answer.

## What to do

- Switch the console to the organization that owns the object (the org picker / `x-gnl-org` scope
  your deployment uses), then retry.
- If the operator genuinely needs cross-org access, that is a platform-admin capability — grant it
  through your auth provider rather than widening a single request.
