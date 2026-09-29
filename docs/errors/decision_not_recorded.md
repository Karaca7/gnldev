# decision_not_recorded

**HTTP 500 · decision record**

## What happened

The request was decided — allowed or refused — but the auth provider's `onDecision` hook failed while
recording that decision (for example, @gnldev/auth-ee's audit sink could not write its row). The host
withheld the response instead of sending it with no record behind it.

## Why the framework can't guess

A deployment that records decisions has promised that every answer it gives is in the record. Sending
the answer anyway would break that promise silently; dropping the record and pretending nothing
happened is the same break. Neither side can be repaired afterwards, so the request is not delivered.

## What to do

- Look at the server log: the host prints the hook's error (`@gnldev/auth: onDecision failed`).
- Fix the sink — its storage, credentials or capacity — then retry the request. A read is safe to retry;
  a write is safe too when it carries its run id or idempotency key, because the journal replays it.
- If your deployment does not need a decision record, do not pass `audit` to `createEnterpriseAuth`
  (or an `onDecision` to the door); the hook is then never called.
