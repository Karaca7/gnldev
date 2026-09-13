# tool_loop_detected

**HTTP 422 · `resumable: true`**

## What happened

The same tool was called with the same arguments enough times in a row that the framework stopped the
run rather than let it continue. `detail` names the tool and how many repeats it took.

This is not the general step ceiling — that is `run_limit_exceeded`. This is the narrower, more
specific finding: the run was not making progress, it was repeating itself.

## Why

A loop is the most expensive way for an agent to fail, because it looks like work. Each turn costs
tokens, each tool call may cost money, and the run would otherwise keep going until some other
ceiling caught it — by which time the bill is real and the answer is still nothing.

Catching the repeat itself is worth more than catching the spend, for one reason: the ceiling tells
you a number was too small, and this tells you **which tool** and **which arguments**. That is the
difference between "raise maxSteps" and a fix.

The usual causes, in the order they turn up:

- The tool returns something the model does not read as an answer — an empty array, `null`, a
  success envelope with no content — so the model tries again, identically.
- The tool's description promises something it does not do, so the model keeps asking for the part
  it did not get.
- The tool genuinely failed and reported it in a way that reads as retryable.

**`resumable: true`**: the run is intact. Whatever completed before the loop is journaled, and the
same runId can be re-driven once the cause is fixed.

## What to do

**Read the repeated call, not the count.**

```bash
gnl run <runId>          # the timeline — the repeated tool and its arguments are adjacent
```

Then look at what that tool **returned**. The loop is almost always a conversation between a model
and a return value that does not say what the model needs, and it is visible the moment the two are
read together.

**Fix the tool's answer or its description**, then re-drive the same runId. Making the tool return an
explicit "nothing found" instead of an empty result closes most of these outright: a model can act on
a stated negative and cannot act on silence.

**If the repetition is legitimate** — a poll, a retry the tool owns — that work does not belong in
the agent's tool loop. Put the repeat inside the tool, where it can have a real backoff and a real
bound, and let the agent call it once.
