# upstream_rate_limited

**HTTP 429 · `Retry-After` when the provider named one**

## What happened

The model provider answered 429. Your request was fine and the framework did nothing wrong — the
account or key behind this deployment is over its rate limit at the provider, right now.

The body carries `upstreamStatus: 429`, and `retryAfter` (seconds) whenever the provider's own
`Retry-After` header could be read. The same number is set as a real `Retry-After` header, so a
client that already honours it needs no special case for this code.

## Why

**429 is passed through, and it is the only status in this family that is.** A rate limit is the one
upstream failure where the caller's own backoff is the correct response, so the answer has to be the
status every HTTP client already knows how to wait on. The rest of the family becomes 502/504
instead — see `upstream_unavailable` for why a provider's 401 must never reach you as a 401.

Before this code existed the same failure arrived as `400 "Failed after 3 attempts. Last error: Too
Many Requests"`. Measured on a live rig against a free endpoint. A 400 tells a retrying client that
its request is malformed and must never be repeated, which is precisely backwards from what a 429 is
asking for.

## What to do

**Wait `retryAfter` seconds and re-drive the SAME runId.** Nothing was committed by the failed
attempt, and the journal replays whatever completed before it, so a retry costs only the steps that
did not finish.

**If it is constant rather than occasional**, it is a capacity problem and no retry policy fixes it:
raise the provider quota, spread the load across keys, or put a queue in front (`@gnldev/queue`) so
the concurrency the provider sees is one you chose.

**Do not translate this into your own 429 for your end users** without thinking about it — your user
is not the one who is rate limited, and telling them to slow down hides the real cause from the
person who can act on it.
