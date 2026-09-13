# resource_denied

**HTTP 403**

## What happened

The deployment configured `resourceAuth`, and it refused this principal for this specific resource
and action. The `error` sentence names the resource — `resource access denied: agent:invoices` — and
the action is one of `run`, `read`, `cancel` or `resume`.

The caller was already past the coarse permission gate. Having the `agents:run` permission is what
got the request this far; `resourceAuth` is the second, narrower question: *this* agent, *this*
principal.

## Why

**A distinct, additive layer, never a replacement.** The coarse gate answers "may this credential run
agents at all", which is a deployment-wide fact. Fine-grained authorization answers "which ones", and
that is per-customer policy the framework cannot guess. Keeping them separate means a deployment that
never configures `resourceAuth` behaves exactly as it did before the layer existed — the hook is
unset, the function returns immediately, and no request changes shape.

**Its own `code`, unlike the coarse 403.** The coarse gate's refusal carries no `code` at all. That
asymmetry is useful rather than sloppy: a client that sees `resource_denied` knows a policy function
made a decision about a named resource, and that a support answer exists ("ask for access to this
agent"). A bare 403 means the credential is not allowed here at all, which is a different
conversation.

**Not `resumable`.** Nothing about the run clears this. The policy has to change, or the caller has
to be a different principal.

## What to do

**Ask what the policy decided, not whether the credential is valid.** `resourceAuth` receives the
principal, the resource and the action; the answer is a boolean your deployment computed. Log the
three inputs at the policy function if you cannot tell why.

**If the caller should have access**, grant it in whatever system backs the policy — the framework
holds no grant table of its own here, deliberately: the paid FGA surface delegates to yours.

**If you did not expect any policy at all**, check whether `resourceAuth` is configured in this
environment and not in the one you tested against. An unset hook cannot produce this code.
