# run_busy

**HTTP 409 · `resumable: true`**

## What happened

A run with this `runId` was already in flight, holding its run lock, when a second request arrived
for the same id. The second one was **not started**.

Most callers never chose that id. If you sent a `workKey`, the engine derived the run's id from it
(`run1_<digest>`), so "the same id" means **the same work, named the same way, inside the same
scope** — a second call for a job that is already running.

## Why

The run lock exists so that one `runId` means one execution. Without it, two workers that picked up
the same job would both call the model, both execute its side-effecting tools, and both write to the
same journal keys — and the tool records would be decided by whichever finished last.

So this is usually not a failure. It is the protection reporting that it declined a duplicate, which
is what it was asked to do. Nothing ran twice, and no partial work was left behind.

The lock's identity is the `runId` itself. Two genuinely different jobs that happen to share one id
are, as far as this gate can tell, one job — and when the id came from a `workKey`, "sharing one id"
means sharing one name: two different jobs sent under `nightly-batch` are one job here.

This is the `onConflict: 'reject'` axis, which in v1 has exactly this one behaviour. Its sibling is
`onReuse: 'replay'` — the same key arriving after the work **finished** gets the recorded answer
back rather than a 409. The asymmetry worth knowing: a run that ended in **failure** has no answer to
replay, so the same `workKey` is free to run again.

## What to do

**If the duplicate was accidental** — a retry, a double-click, two workers off the same queue
message — there is nothing to fix. The first run is still going and will produce the answer. Follow
it by its id; responses carry the effective one in the `X-Gnl-Run-Id` header.

**If the two requests are genuinely different work**, give them different names. One `workKey` is
one job, so two jobs need two keys. On the raw engine surface (`runDurable`, `resumeRun`, `forkRun`)
the id *is* the name — there, pass a different `runId`.

**Do not wrap this in a retry loop.** A retry loop around a lock turns a transient collision into a
stampede: every retry arrives while the first run is still holding the lock, and the load grows with
the number of retriers rather than shrinking.

**If nobody is actually running it** — the holder crashed — the lock is released by its TTL
(`lock.ttlMs`, renewed on a heartbeat while the run lives). Wait out the TTL rather than deleting
the key: a lock deleted while its owner is alive is no lock at all.
