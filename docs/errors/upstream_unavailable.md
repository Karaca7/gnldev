# upstream_unavailable

**HTTP 502**

## What happened

The model provider failed, and not in one of the ways that has its own code. Two shapes reach here:

- **The provider answered with a status** that is not 429, 401/403, 408 or 504 — a 500, a 503, or a
  4xx it blamed on the request body. The status is in `upstreamStatus`.
- **Nothing answered at all** — DNS, connection refused, a reset socket. The AI SDK reports these as
  `AI_APICallError` with no status, so there is no `upstreamStatus` to carry.

## Why

**A provider 4xx becomes a 502 too, which surprises people.** The request the provider rejected is
the one the framework built — the prompt assembly, the tool schemas, the model id — not the one the
caller sent. Passing a 400 through would tell the caller to fix a request they never wrote. If the
provider is rejecting the body, that is a bug or a misconfiguration on this side of the wire, and a
502 is what says so.

`upstreamStatus` is kept in the body precisely because the distinction still matters to whoever
debugs it: a 503 is the provider being down, a 400 is the framework sending something the provider
would not take.

## What to do

**Read `upstreamStatus` first** — it splits the two cases immediately.

- **5xx / no status**: the provider or the network. Retry with backoff; re-driving the same runId
  replays whatever completed and only redoes the failed step.
- **4xx**: stop retrying and look at what is being sent. Common causes: a model id the provider does
  not serve, a context window overflow, a tool schema the provider rejects, or a content filter.

**The provider's own message is in `error`.** It is passed through verbatim, and it is usually the
fastest way to tell which of the two you are in.

**If this is frequent and the run matters**, the durable path is the answer to it: the journal makes
a retry cheap, and `@gnldev/queue` in front makes the retry policy explicit instead of leaving it to
whatever the caller happens to do.
