# side_effect_retry_blocked

**HTTP 409 · `resumable: true`**

## What happened

A tool that declares side effects did not complete, and the framework refused to run it again on its
own. Either its previous attempt is recorded as `failed`, or it died mid-execution leaving a stale
`running` claim — the **crash window**, where the effect may or may not have fired.

## Why

An automatic retry is only safe when repeating the work is safe. For a tool that charges a card,
sends an email or ships an order, "retry" and "do it twice" are the same action, and the journal
cannot tell them apart: a crash between the side effect and the record that would have remembered it
leaves exactly the same evidence as a crash before the side effect.

So the framework refuses to guess. A wrong guess here is a double charge, and a double charge is not
recoverable by a later retry.

## What to do

Pick whichever of these is true of your tool:

**The effect is genuinely repeatable** (the external system dedups it for you — an idempotency key on
the payment provider's side, an upsert, a PUT). Mark the tool `idempotent: true` and the gate stops
applying.

**You can ask the external system what happened.** Give the tool a `recover()` hook: it is called
exactly at this moment, consults the real world ("does a charge with this key exist?"), and answers
`{ done: true, output }` or `{ done: false }`. The framework then replays or re-runs with certainty
rather than with a guess.

**A human should decide.** Approve the specific call and re-send the run:

```json
{ "runId": "…", "approvals": { "<toolCallId>": true } }
```

The `toolCallId` is in the error's `detail.key` and in the run timeline (`gnl run <runId>`).

Approving is a statement that you checked. It is the right answer when there is no programmatic way
to ask, and the wrong one as a habit.
