# retry_limit_exceeded

**HTTP 422 · no `resumable`**

## What happened

A tool failed, was retried, and reached its `maxRetries` limit. Its journal record is now permanently
`failed`. Re-running the same `runId` will not attempt it again.

## Why

Automatic retry is bounded on purpose. An unbounded one turns a permanent fault — a bad credential,
a schema the provider rejects, a bug in the tool — into an infinite loop that spends money and
produces nothing. Past the limit the framework stops and leaves the failure visible instead of
burying it in another attempt.

422 rather than 409, and no `resumable`: there is nothing the caller can retry that would change the
outcome. The same runId will keep answering this.

## What to do

**Read the failure, not the limit.** The limit is a symptom; the journal holds every attempt and the
error each one raised:

```bash
gnl run <runId>                 # the timeline, with the failed tool record
gnl inspect <runId> --step N    # materialized state at the step that failed
```

**Once the underlying cause is fixed**, start a new run. If the work is safe to redo, fork the old
one so the successful steps before the failure are kept:

```bash
gnl fork <runId> --step N       # copy into a new, live-continuable runId
```

**If the limit itself was wrong** — a flaky dependency that genuinely needs more attempts — raise
`maxRetries` for that tool. Raising it to hide a deterministic failure only moves the same error
later and costs more to get there.
