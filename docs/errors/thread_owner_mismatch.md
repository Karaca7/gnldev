# thread_owner_mismatch

**HTTP 409 · no `resumable`**

## What happened

The request named a **subject** (`resourceId`) and a **thread** (`threadId`) that belong to different
people. The thread was not loaded and the turn was not appended.

## Why

Before this check, the only thing a thread id had to be was a string. Whoever sent one got that
conversation's history loaded into the model's prompt — and this turn appended to it. Measured, with
one application credential serving two end users: posting `{ threadId: 'thread-alice',
resourceId: 'mallory' }` returned Alice's history verbatim, including what she had typed into it.

Worse than the disclosure is the write. The turn is appended, so the next reader of Alice's own
conversation finds a stranger's message inside it.

`@gnldev/server` refuses this at the edge too (403). The check also lives next to the memory load
because the edge is only one way in: chat-adapter, AG-UI and batch reach the engine directly.

## What to do

**Send the subject the thread actually belongs to.** `detail.owner` is the recorded owner and
`detail.requested` is what the request claimed.

**Derive the subject from something the server trusts** — a session cookie, a verified JWT,
`principalOf(req)?.id` — and never from the request body on the adapter routes. A body-supplied
subject is the caller naming whoever they like.

**If the thread is genuinely being handed over**, that is a data change, not a request parameter:
update the thread's `resourceId` in your own store deliberately.

Note what is *not* refused: a first turn creates the thread and has no owner yet, and a caller that
names no subject is the operator case the ownership rule exempts. Refusing an unknown owner would
refuse every new conversation.
