# run_actor_mismatch

**HTTP 409 · no `resumable`**

## What happened

This `runId` was started by one actor and re-used by another. The first actor is bound into the run's
frozen input, first-wins, and the later one was refused.

**Nothing has to be switched on for this to fire.** The check reads two values and refuses when they
disagree, so it is live wherever both exist: the run carries a stamped `actor`, and the call arrives
with one. On the REST host both are true as soon as an auth provider is configured — the stamp is
printed from the verified identity at every birth — which is why you can meet this on a plain
`createRestApi` with no `preset` and `strictInput` off. What the `critical` profile adds around it is
the rest of the package (frozen-input fingerprinting, the conflict ledger, tombstone rejection), not
the actor comparison itself. An earlier version of this page said the check was part of that profile
and off by default; measured, it is not.

## Why

A runId is an address. If anyone who learns one can re-enter it, then knowing an id is enough to
resume someone else's work, read what it replays, and push it forward. Binding the actor at run start
makes the id useless to anybody but its owner.

**No actor on either side means no check** — and that is documented rather than silent. A profile with
no authenticated identity has no protection here, because there is nothing to compare. That is
exactly why the identity row exists in the protections matrix (`gnl doctor`): an ownership gate with
no verified owner refuses nobody.

## Over REST you will often see a 403 instead — and that is not a different protection

The REST host has its own gate in front of the engine (`ownershipDenied`, `server/index.ts`), and it
runs first. When a caller STATES whose run they believe this to be — `?resourceId=` or `resourceId`
in the body — and the run says otherwise, the answer is `403 {"error":"access denied: this run
belongs to a different resourceId"}` and the engine is never reached. So a REST caller can hold a
runId belonging to somebody else and never once see this code.

Measured, so the two are not confused:

| what the caller does | answer |
| --- | --- |
| declares a subject that disagrees with the run | **403** at the edge; the engine never runs |
| declares nothing | edge silent (nothing to compare) → **409 `run_actor_mismatch`** from the engine |
| declares the OWNER's name, while authenticated as someone else | edge satisfied → **409** from the engine |

The third row is the reason both gates exist. The edge compares what the request SAYS, and a request
can say anything; the engine compares the stamp against the identity the server sealed, which the
caller does not write. Neither is a subset of the other, so the code you get tells you which door
answered, not how well the run was protected.

One place used to escape both: `POST /agents/:name/resume` re-seals the run's OWN owner as the
subject (a resume is self-contained), so the engine compared the owner with itself and could not
disagree — and a caller who declared nothing passed the edge too. That route now asks the engine's
question at the edge and answers 403 in the same wording (`actorParityDenied`, same file), which is
why a mismatched resume reports 403 rather than this code.

## What to do

**Re-enter the run as the actor that started it.** `detail.ownerActor` and `detail.requestedActor`
name both sides.

**If the run is legitimately being continued by another party** — a background worker finishing a
user's job — give it a new `runId` and carry the state forward explicitly, or run it as the same
actor. Silently changing owners mid-run is the thing the gate exists to notice.

**If you are getting this where no identity should exist**, check what is writing `actor`. On the REST
host the seal wins over any caller-supplied value: a verified identity stamps the run, and a body
field cannot overwrite it. That precedence is deliberate — a self-issued stamp is not a lock.
