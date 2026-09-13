# agent_not_approved

**HTTP 403**

## What happened

The agent exists and is registered, but it is not approved to serve. The deployment runs with
`requireAgentApproval`, and under that flag an agent may only answer requests once a platform admin
has approved the exact version of it that is running.

An agent is unservable in three different situations, and they are not the same problem:

- **Pending** — nobody has approved it yet. Normal for a newly deployed agent.
- **Changed** — it *was* approved, and its fingerprint no longer matches. The model, the system
  prompt or the toolset moved after approval.
- **Blocked** — an admin deliberately stopped it.

## Why

Approval is a governance control, and the case it exists for is the third bullet's inverse: an agent
whose behaviour changed after somebody signed off on it. Without a fingerprint, "we approved this
agent" degrades into "we approved this agent's *name*" — and the name is the one part that survives
a rewrite of everything the agent actually does.

**403, not 404.** A 404 is what an *unknown* agent gets, and the distinction is deliberate: this
response confirms the agent exists, because the caller is inside the deployment and hiding it from
them would only cost debugging time. An agent that is invisible to the requesting organization gets
the 404 instead — visibility is decided before approval is.

**Not `resumable`.** No retry clears this. Nothing about the request is wrong; the state of the
deployment is what has to change.

## What to do

**Find out which of the three it is** — the remedy differs for each:

```bash
gnl agents                 # the registry, with each agent's approval state
```

**Pending**: a platform admin approves it.

```bash
POST /agent-registry/:name/approve
```

**Changed**: read what moved before re-approving. The fingerprint covers the model, the system prompt
and the tool set, so a diff of those three explains it. Re-approving records the new fingerprint —
which is the whole point, so do it deliberately rather than to clear the error.

**Blocked**: this one is a decision, not an oversight. Find out why before undoing it; the audit
record carries who blocked it and the note they left.

**If you did not mean to run with this control on**, `requireAgentApproval` is opt-in — turning it
off restores byte-for-byte the behaviour of a deployment that never had it. Turn it off because you
decided the control is not for you, not because it fired.
