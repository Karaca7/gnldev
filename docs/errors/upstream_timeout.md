# upstream_timeout

**HTTP 504**

## What happened

The model provider took too long. Either it said so itself — a 408 or a 504, which arrives as
`upstreamStatus` — or the call was abandoned locally and surfaced as a `TimeoutError`.

## Why

**504 rather than 502**, because a timeout is a distinct operational fact and deserves to stay one.
"The dependency answered badly" and "the dependency did not answer in time" have different fixes:
one is usually a configuration or provider fault, the other is usually load, a very long generation,
or a timeout set shorter than the work takes. Collapsing them into a single 502 costs exactly the
information a dashboard needs to tell a slow week from a broken one.

**A timeout does not mean nothing happened upstream.** The provider may well have completed the
generation and lost the race to your deadline; you were billed for it either way. That is a reason to
retry the SAME runId rather than start a new one — see below.

## What to do

**Re-drive the same runId.** The journal holds every step that completed, so a retry resumes rather
than restarts. A fresh runId would re-run everything, including any tool call that already had an
effect.

**If it repeats on the same agent**, look at the shape of the work before the timeout value: a very
large context, a long tool chain, or a model that streams slowly. A timeout that fires reliably is
usually the honest signal that the request is too big for one call, and `@gnldev/workflow` exists to
break that into steps that each fit.

**If it repeats across every agent**, it is the provider or the network path, not your prompt.
