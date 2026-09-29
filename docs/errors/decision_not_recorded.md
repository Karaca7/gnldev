# decision_not_recorded

**HTTP 500 · decision record**

## What happened

The request was decided — allowed or refused — but the auth provider's `onDecision` hook failed while
recording that decision (for example, @gnldev/auth-ee's audit sink could not write its row). The host
withheld the response instead of sending it with no record behind it.

The decision is recorded AFTER the request has been answered, because the record says what the caller
got. So the request's work has usually already been done when this 500 is sent. Only the answer was
withheld.

## Why the framework can't guess

A deployment that records decisions has promised that every answer it gives is in the record. Sending
the answer anyway would break that promise silently; dropping the record and pretending nothing
happened is the same break. Neither side can be repaired afterwards, so the request is not delivered.

## What may already have happened

| Request | Done before the 500? | A retry, once the sink works |
|---|---|---|
| A read (any `GET`) | nothing changed | safe |
| An agent run — REST `/agents/:name/run` and `/stream`, the standalone chat and AG-UI routes | **yes**: the model was called, and the run and the thread's messages are stored | replays the stored run without calling the model again when it names the same run: the same `runId`, `workKey` or `Idempotency-Key`, or, on the chat route, the same message id. Without a name it is a new run |
| Studio `POST /users` | the user was created, then **removed again**; the answer says `rolledBack: true` | creates the user and returns its token |
| Studio `POST /users`, with `rolledBack: false` | the user exists (the removal failed too); its token was never delivered, so nobody can log in as it, and it holds a seat | delete that user (`DELETE /users/:id?keepData=true`), then create it again |
| Other Studio writes (revoke, `PATCH /users/:id`, organizations, policy, pricing, runs, …) | **yes**, the change was made | revoke and `PATCH` give the same result again. `DELETE /users/:id` answers 404: the user is already gone, and Studio's own audit log (`GET /audit`, `user.delete`) holds the erasure report |

`POST /users` is the one write that is undone. Its token exists only in the withheld response, so the
user could never be used, and it held its email and a seat: the retry answered 400 "already exists"
(measured). Removing it is safe for the same reason: the token never left the server.

## What to do

- Look at the server log: the host prints the hook's error (`@gnldev/auth: onDecision failed`).
- Fix the sink — its storage, credentials or capacity — then retry as the table says.
- If your deployment does not need a decision record, do not pass `audit` to `createEnterpriseAuth`
  (or an `onDecision` to the door); the hook is then never called.
