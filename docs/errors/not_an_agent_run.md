# not_an_agent_run

**HTTP 409 · no `resumable`**

## What happened

An agent run was attempted against a `runId` that belongs to something else — a workflow, a network,
or a batch item. `detail.kind` says which.

## Why

The `<runId>:input` key does two jobs. On the agent path it holds the **frozen input**
(`prompt` / `messages` / `system`). On the workflow, network and batch paths it holds only an
**identity** (`{ resourceId, workflow | network | batch, … }`), because the ownership gate,
`listRuns({ resourceId })` and `purgeResource` all read that key.

The agent path reads the *presence* of the key as "input is frozen, adopt it". Adopting an identity
record sets `prompt`, `messages` and `system` to `undefined` — so the model is called with an empty
request, and its records land under an id that already belongs to a different kind of run. Both halves
are silent.

No `resumable`: what needs fixing is the id itself.

## What to do

**Use a fresh `runId` for the agent run.** Ids are cheap; a collision between two kinds of work is not.

**If you meant to operate on the existing run**, use the surface that matches its kind — the workflow
routes for a workflow run, the network routes for a network run. `gnl run <runId>` shows what is
actually recorded there.

**If the collision was accidental**, look at how the id is generated. Deriving run ids from a shared
counter, a request id, or a user-supplied string is where two kinds of run end up sharing a namespace.
