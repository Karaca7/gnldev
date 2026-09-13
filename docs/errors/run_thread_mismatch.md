# run_thread_mismatch

**HTTP 409 · no `resumable`**

## What happened

This `runId` already froze its input under a **different** `threadId`, and the request that just
arrived names another one. Nothing was written for this attempt — the check runs before the run is
marked started and before any approval is journaled.

## Why

A run belongs to one conversation. Its frozen `:input` entry holds the thread it was started for, and
every replay reads that entry to rebuild what the model saw. Letting a second thread adopt the same
runId would mean one set of journal records answering for two conversations: the timeline of one
would contain the other's messages, and a resume would load the wrong history into the prompt.

`resumable` is absent rather than `false`. The blocked errors carry `resumable: true` because the same
runId succeeds once the block clears; this one never will for this thread, so advertising it as
retryable would put a client in a loop.

## What to do

**Use a fresh `runId` for the new thread.** The id is how work is addressed, and two conversations are
two pieces of work.

**If the id is derived, check the derivation.** `@gnldev/chat-adapter` builds its runId as
`${body.id}:${lastMessage.id}` — a client that reuses a message id across conversations produces this
collision without meaning to.

**If you expected the same thread**, read what the run actually recorded:

```bash
gnl run <runId>       # the run's timeline, including the thread it was started for
```

`detail.startedForThread` and `detail.requestedThread` in the error body name both sides.
