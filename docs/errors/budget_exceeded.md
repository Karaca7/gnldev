# budget_exceeded

**HTTP 402**

## What happened

The organization has spent its budget, and a NEW run was refused before it started. The body carries
what the decision was made on:

```json
{ "error": "budget/quota exceeded — new run rejected", "code": "budget_exceeded",
  "usage": { "...": "tokens and cost so far" }, "limit": { "...": "the effective ceiling" } }
```

The effective limit is the journal record managed from Studio (`__budget__:*`) when there is one, and
`opts.budgets` (per-org, else `default`) otherwise.

## Why

**402 and not 429.** A 429 says "you are going too fast"; waiting fixes it. This one says "the money
for this period is gone", and waiting fixes nothing until somebody raises the ceiling or the period
rolls over. The two are not interchangeable to a client with retry logic, which is the whole argument
for a separate status.

**Budgets are per ORGANIZATION, not per user or per run.** When multi-org is configured, a request
that resolves to no organization lands in the root scope — which spans every organization's spend and
is therefore NOT checked against the per-org `default`, because that would produce a 402 for a limit
that does not apply to it.

**A resume is not a new run.** The gate is skipped when the journal already holds state for this
runId (a pending approval, a suspended workflow, an exactly-once repeat). Refusing a resume would
strand work that was already paid for halfway through — and a human approval sitting on a tool call
would become unresolvable the moment the budget ran out.

**It can fail OPEN, and says so at boot.** Enforcement needs a journal that can enumerate runs. With
one that cannot, the server logs `budgets configured but journal does not support listRuns → quota
CANNOT be enforced (fail-open)` once at startup, and no request is ever refused. If you expected a
402 and never got one, that line is the first thing to look for.

## What to do

**Raise the budget** for the organization (Studio, or `opts.budgets`), then re-drive the same runId.

**Check whose budget it is.** In a multi-org deployment the answer depends on which organization the
request resolved to; a missing `x-gnl-org` header can put a request somewhere you did not intend.

**Read `usage` before raising anything.** It is the same data `GET /usage` serves, and a budget that
is exhausted far earlier than expected is usually a retry loop or a runaway tool chain rather than
real demand — see `run_limit_exceeded` and `tool_loop_detected`.
