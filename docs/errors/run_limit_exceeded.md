# run_limit_exceeded

**HTTP 422 · `resumable: true`**

## What happened

The run hit one of the ceilings in its `limits` — the step budget, the token budget, the wall-clock
budget, or the cost budget — and stopped there. Whatever had already completed is in the journal; the
run did not fail, it was cut off.

`detail` says which ceiling and what the run had spent when it met it, so the answer to "raise it to
what?" is in the body rather than in a guess.

## Why

A limit is the answer to a specific failure: an agent that loops, or reasons its way into a much
larger job than the caller had in mind, spends real money doing it and produces nothing anyone asked
for. The ceiling exists so that the spend is bounded by a number the deployment chose, not by
whenever the model happens to stop.

**422, not 429.** A 429 tells every SDK in the world to retry after a wait, and this is not a
transient condition — the same request under the same limits meets the same ceiling. The body carries
`code` and `detail` instead, so a client can act on the reason.

**`resumable: true`, and this is the part worth reading.** Unlike the caller-conflict family, the run
is intact and continuable. Raise the limit and re-drive the **same runId**: the journal replays every
completed step and execution picks up where it stopped. You are not paying for the first half twice.

## What to do

**Look at what it spent before deciding it was wrong.**

```bash
gnl run <runId>          # the timeline, and where it stopped
```

**If the ceiling was too low for legitimate work**, raise that field and re-drive the same runId:

```jsonc
{ "runId": "<the same id>", "limits": { "maxSteps": 40 } }
```

**If the ceiling was right and the agent is looping**, raising it buys a longer loop at a higher
price. Read the timeline for the same tool being called with the same arguments — that pattern has
its own error (`tool_loop_detected`) when the framework can see it, and this one is what you get when
it cannot. Fix the prompt or the tool description instead.

**If this is happening across many runs**, the deployment's defaults are the thing to change, not
each request: set `limits` once when constructing the API rather than per call.
