# step_retry_blocked

**HTTP 409 · `resumable: true`**

## What happened

A workflow step declared `sideEffect: true` could not be resumed safely. Its `detail.state` says which
of the two cases you are in:

- `in-flight` — the step's write-ahead claim is still live (younger than its TTL). Another worker may
  be running it right now.
- `unresolved` — the step died inside the **crash window**. The claim is stale or the record is
  `failed`, and the effect may or may not have fired.

## Why

This is [`side_effect_retry_blocked`](./side_effect_retry_blocked.md) for workflows, and the reasoning
is identical: a resume that re-runs a side-effecting step is indistinguishable from doing the work
twice, and the journal alone cannot tell which side of the effect the crash landed on.

A step *without* `sideEffect: true` never reaches this — it has no claim key and resumes by replay,
exactly as before.

## What to do

**`in-flight`** — wait. The claim expires at `detail.claimTtlMs`; `detail.ageMs` says how far along it
is. If the holder really is gone, the TTL releases it without anyone deleting anything.

**`unresolved`** — resolve the crash window, in one of three ways:

1. **Give the step a `recover()` hook.** It is asked first, on exactly this path: consult the external
   system and answer `{ done: true, output }` or `{ done: false }`. This is the only option that
   scales, because it answers automatically the next hundred times too.

2. **Decide by hand, then write the answer the resume will read.** The effect landed:
   ```
   journal.put(detail.key, <the real output>)
   ```
   The effect never fired:
   ```
   journal.put(`${detail.key}:_claim`, { startedAt: Date.now(), released: true })
   ```
   The first makes the resume replay the step; the second makes it take the claim over and re-run.

3. **Make the step repeatable** so the question stops mattering — an idempotency key the downstream
   system honours, and then drop `sideEffect: true`.
