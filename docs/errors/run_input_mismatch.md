# run_input_mismatch

**HTTP 409 · no `resumable`**

## What happened

This `runId` already froze its input, and the content that just arrived under the same id hashes
differently. Only the hashes are compared and only the hashes are reported — the error carries no
prompt text.

This check is part of the `critical` profile (`strictInput`). It is off by default.

## Why

`strictInput` makes a runId mean *one request*, not *one slot*. Without it, a caller that reuses an id
with new content gets the old run's replayed answer — correct by the letter of call-scoped dedup, and
almost never what anybody wanted. The `critical` profile is for the deployments where "almost never"
is not good enough: a run that pays out money should not be addressable by an id that someone else's
request already claimed.

No `resumable`: what needs fixing is the pair (this id, this content). No retry clears it.

## What to do

**Send new content under a new `runId`.** One request, one id.

**If you meant to retry the identical request**, send it identically — byte-for-byte on
`prompt` / `messages` / `system`. A retry that rebuilds the payload (re-serialising, re-ordering keys,
adding a timestamp) is a different request as far as the fingerprint is concerned.

**If this is an approval re-post**, it is already exempt: an approval addressed to a `toolCallId`
whose journal record is genuinely `suspended` is allowed to carry a grown message history, because
that is what the chat approval flow legitimately does.

**If you do not want this strictness**, it comes from `preset: 'critical'`. A per-call
`RunOptions.strictInput` still wins over the profile.
