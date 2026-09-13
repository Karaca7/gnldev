# version_conflict

**HTTP 409 · operator console**

## What happened

Two operators edited the same document (a policy, a pricing table) at the same time, and the other
save landed first. Your save was **not applied** — applying it would have silently overwritten an
edit you never saw.

## Why the framework can't guess

The console cannot merge two intents; last-writer-wins is exactly the failure this code exists to
prevent. The response carries the `current` version so nothing has to be re-fetched blindly.

## What to do

- Re-read the current document (it is in the response's `current` field where provided), reapply
  your change on top of it, and save again.
- If this happens constantly, two operators are working the same object — coordinate ownership
  rather than racing the save button.
