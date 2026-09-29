# user_runs_in_flight

**HTTP 409 · operator console**

## What happened

You deleted a user (`DELETE /users/:id`) while some of their runs were still writing — a turn inside
the model, for example. Studio revoked the user at once, then waited `userErasure.settleMs` (10 seconds
by default) for those runs to finish. They did not. So it cancelled them and erased nothing.

The answer lists them in `runs`. The user is still in the directory, revoked: their token no longer
works on any door.

## Why the framework can't guess

A revoke stops new requests. It does not stop a turn that is already running. That turn writes its
answer, the thread's messages and its outcome when the model returns. If the erasure had run first,
those writes would land after it, under ids it had just cleared. That was measured: the delete answered
`complete: true` and the turn's text was still in the thread afterwards.

Erasing now and hoping would give a false report. Erasing later needs the owner records that an
erasure now would take. So nothing is erased until the runs have stopped.

A cancelled run stops at its next model step, on any worker. The step it is in finishes first.

## What to do

- Wait a little, then send the same `DELETE /users/:id` again. When nothing of the user's is still
  writing, it erases and answers `complete: true`.
- For turns that take long, raise `userErasure.settleMs`, so the delete waits for them itself.
- A run whose worker died never finishes; it stays listed here. Check it in the run view. If it is
  dead, purge it (`DELETE /runs/:id`, a platform operator) and delete the user again.
