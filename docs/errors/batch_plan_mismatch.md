# batch_plan_mismatch

**HTTP 409 · no `resumable`**

## What happened

A `batchId` carries one plan. The items in this request do not match the plan that was approved for
that id.

## Why

This is the batch form of [`run_input_mismatch`](./run_input_mismatch.md), and it exists for the same
reason: an approval is an approval *of something*. If the item list can change after the plan was
approved, then approving a batch approves whatever arrives next under that id — which is not what the
approver agreed to, and no record anywhere would show the difference.

`detail.expectedToken` is the plan token that was approved; `detail.actualToken` is what this request
computed. Tokens only — the items themselves are not echoed.

## What to do

**Send the batch that was approved.** If your client rebuilds the item list before re-posting, rebuild
it deterministically: same items, same order, same shape.

**If the work genuinely changed**, it needs a new `batchId` and a new approval. Reusing the id would
carry the old decision onto new work.

**If you did not expect an approval to be involved at all**, check whether this batch is running under
a profile that suspends on repeats — the plan token is recorded when the batch is first planned.
