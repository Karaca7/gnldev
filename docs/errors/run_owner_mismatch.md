# run_owner_mismatch

**HTTP 409 · no `resumable`**

## What happened

The run you addressed belongs to somebody else, and the engine refused rather than answer you with
their result.

This only happens on **engine-derived runs** — ids that start with `run1_`, which the engine mints from
a `workKey`. `detail.owner` is the subject the run was born under and `detail.requested` is the subject
your call named. Nothing was written, and the run itself is untouched: its owner's result, status and
history are exactly as they were.

## Why

A derived id is a hash of the agent, the scope and your `workKey`. That makes it stable — the same job
always lands on the same run, which is the whole point — but it also makes it **computable**: an id is
no longer a secret that only its owner could know. Unguessability was never the defence here; this
check is.

The specific accident it exists for is quiet rather than dramatic. Declare `workScope: 'org'` where you
meant `'resource'`, and every customer's `invoice-4471` derives the **same id**. The second caller then
gets a perfectly ordinary replay — of the first caller's answer. From the outside it looks like a cache
hit: the request is well-formed, the id exists, the reply is a legitimate record of a run that really
is under that id. Nothing upstream can see the problem, which is why the check lives in the engine
rather than at the HTTP edge — the edge is one of several doors, and an embedded deployment has none.

The refusal also does **not** count as a failure of the run it protected. A rejected stranger may not
rewrite a finished run's outcome to `failed`; the owner's history stays theirs.

## What to do

**Check the agent's `workScope` first.** This error usually means an `'org'` scope on work that
belongs to a person. `'resource'` (the default) puts the subject into the identity, so two customers
with the same `workKey` get two runs, which is almost always what you wanted. Getting this wrong in the
other direction is cheap and loud — the job runs twice — so when in doubt, choose `'resource'`.

**If the work really is shared**, the callers need a scope they both belong to: an organization-scoped
run addressed by an org, or an installation-wide job (`'org'` on a deployment with no organizations,
which runs under the `~deployment` address). Sharing has to be declared, not inherited from whoever
called first.

**If your subject changed identity between calls** — an anonymous session that later signs in, a job
re-driven by a background worker under a service account — then the second call is genuinely a
different subject and needs its own `workKey`, or must run as the original subject. Carrying work
across owners silently is the thing this gate exists to notice.

**Raw runIds are unaffected.** Outside the `run1_` namespace an id is a name you chose, and handing a
run between workers under your own rules is still legal. The engine only enforces the promise it made
itself.

**The gate needs BOTH subjects, and passes when it has fewer.** It compares the subject frozen at the
run's birth against the subject this call names, and it can only refuse when both are present. Two
cases therefore go through without a refusal, on purpose: a call that names nobody (the operator and
installation-wide-job case, which the ownership rule exempts by design), and a run that was born
without an owner and never claimed one. Refusing either would mean inventing an owner in order to
enforce ownership.

That is a **fail-open arm**, and it is worth being plain about where it bites: on the raw
`runDurable` surface a caller can hand over a derived id with no `resourceId` and pass this check. The
doors that actually *mint* derived ids — the registry gate and the HTTP surfaces — refuse a scope with
no address before they ever reach here, which is where fail-closed belongs. So the guarantee is
"ownership is enforced wherever ownership was established", not "every derived id is guarded". If
runs in your deployment are being born ownerless, that is the thing to fix; this check has nothing to
compare and will not tell you.

## See also

- [`thread_owner_mismatch`](./thread_owner_mismatch.md) — the same shape, one axis over: a subject and
  a conversation that belong to different people.
- [`run_actor_mismatch`](./run_actor_mismatch.md) — the opt-in `critical`-profile check on the opaque
  `actor` identity, rather than on the run's subject.
