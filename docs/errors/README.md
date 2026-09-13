# Error codes

Every error code this framework puts on the wire has a page here, named by its code. A check keeps
that true in both directions: a code with no page fails `pnpm check:errors`, and a page whose code no
longer exists fails it too.

**What "every" is checked against, precisely.** Five exported maps, and nothing else:

| Map | Package | What it holds |
| --- | --- | --- |
| `CALLER_CONFLICT_CODES` | `@gnldev/durable` | 409s about the id, its content, or who is asking |
| `BLOCKED_ERROR_CODES` | `@gnldev/durable` | runs waiting on a decision |
| `UPSTREAM_ERROR_CODES` | `@gnldev/durable` | the model provider failed |
| `EDGE_ERROR_CODES` | `@gnldev/server` | refusals the HTTP layer writes itself |
| `STUDIO_ERROR_CODES` | `@gnldev/studio` | the operator console's own refusals |

All five are enumerable values, so the check reads them and keeps no list of its own. It used to keep
one — three edge codes typed into the script by hand, under a comment admitting that a fourth added
tomorrow would be caught by nothing. That was measured before it was replaced, and it had already
happened: the edge was printing **nine** codes, and the upstream family existed only as a TypeScript
union, which disappears at compile time and so was invisible to a check that reads built modules. Ten
codes were on the wire with no page. Since then the check also binds the **status**: each codes map
has a `*_STATUS` sibling (`WIRE_ERROR_STATUS`, `EDGE_ERROR_STATUS`, `STUDIO_ERROR_STATUS`), and every
page's `**HTTP nnn` line and every status column below must equal it — measured need, not caution: one
code taught 409 on two doc surfaces here while its route answered 429, and CI stayed green. The maps
are what make that impossible rather than unlikely, and
`wire-codes-are-enumerable.test.ts` (in `@gnldev/server`) is what stops a route from opting out of
them: it reads the source of every package on the agent wire and fails on a `code:` literal that no
map holds.

The code is the stable part — the same string in the HTTP body, the SSE `error` frame and the client
library. The sentence beside it is written for the moment of failure; these pages are for the ten
minutes afterwards.

## Caller conflicts — 409, no `resumable`

Something about the request needs fixing: the id, its content, or who is asking. No retry clears
them.

| Code | In one line |
| --- | --- |
| [`run_thread_mismatch`](./run_thread_mismatch.md) | This runId already belongs to a different conversation. |
| [`thread_owner_mismatch`](./thread_owner_mismatch.md) | The subject and the thread belong to different people. |
| [`run_input_mismatch`](./run_input_mismatch.md) | Same runId, different content (`critical` profile). |
| [`run_actor_mismatch`](./run_actor_mismatch.md) | Same runId, different actor (`critical` profile). |
| [`run_owner_mismatch`](./run_owner_mismatch.md) | A derived (`run1_`) run addressed by a different subject. |
| [`run_swept`](./run_swept.md) | Retention deleted this run; a late retry would repeat its effects. |
| [`not_an_agent_run`](./not_an_agent_run.md) | This runId belongs to a workflow, network or batch. |
| [`batch_plan_mismatch`](./batch_plan_mismatch.md) | The items do not match the plan that was approved. |

## Blocked — the run is waiting on you

The same runId succeeds once the block clears.

| Code | Status | In one line |
| --- | --- | --- |
| [`run_busy`](./run_busy.md) | 409 | Already running under this id — the duplicate was declined. |
| [`side_effect_retry_blocked`](./side_effect_retry_blocked.md) | 409 | A side-effecting tool cannot be retried without a decision. |
| [`step_retry_blocked`](./step_retry_blocked.md) | 409 | The workflow form of the above. |
| [`retry_limit_exceeded`](./retry_limit_exceeded.md) | 422 | A tool hit `maxRetries` and is permanently failed. |

## The model provider failed

Not your request and not the framework's refusal — the upstream said no, or said nothing. The status
is chosen for what the caller should DO, never copied from the provider: only a rate limit stays as
itself.

| Code | Status | In one line |
| --- | --- | --- |
| [`upstream_rate_limited`](./upstream_rate_limited.md) | 429 | The provider is rate limiting; `Retry-After` when it said so. |
| [`upstream_unauthorized`](./upstream_unauthorized.md) | 502 | The provider refused the operator's key — never the caller's. |
| [`upstream_unavailable`](./upstream_unavailable.md) | 502 | The provider broke, or rejected the request we built. |
| [`upstream_timeout`](./upstream_timeout.md) | 504 | The provider took too long. |

## Written at the HTTP edge

Refusals the route layer makes on its own, before or around the run — `EDGE_ERROR_CODES` in
`@gnldev/server`. The first two are `resumable`: raise the ceiling or fix the cause and re-drive the
**same** runId, and the journal replays what already completed.

| Code | Status | In one line |
| --- | --- | --- |
| [`run_limit_exceeded`](./run_limit_exceeded.md) | 422 | The run met a `limits` ceiling and stopped there. |
| [`tool_loop_detected`](./tool_loop_detected.md) | 422 | One tool, the same arguments, over and over — no progress. |
| [`agent_not_approved`](./agent_not_approved.md) | 403 | The agent is pending, changed since approval, or blocked. |
| [`resource_denied`](./resource_denied.md) | 403 | A fine-grained policy refused this principal for this agent. |
| [`budget_exceeded`](./budget_exceeded.md) | 402 | The organization's budget is spent; a new run is refused. |
| [`a2a_signature_missing`](./a2a_signature_missing.md) | 401 | A signed agent-to-agent call arrived unsigned. |
| [`a2a_timestamp_invalid`](./a2a_timestamp_invalid.md) | 401 | Outside the ±300s replay window — usually clock skew. |
| [`a2a_signature_invalid`](./a2a_signature_invalid.md) | 401 | The HMAC did not verify over the bytes received. |
| [`body_consumed_upstream`](./body_consumed_upstream.md) | 500 | A body parser mounted ahead of the handler drained the request. |

## The operator console — Studio's own refusals

These never reach a caller of the agent API; they answer an operator using Studio. Enrolling them
closed the exclusion the wire test used to carry — which, measured, was already wrong by one: it
counted four codes, and five were on the wire.

| Code | | In one line |
| --- | --- | --- |
| [`org_scope_refused`](./org_scope_refused.md) | 403 | The request's org scope does not cover this object. |
| [`version_conflict`](./version_conflict.md) | 409 | Another operator saved first; re-read and reapply. |
| [`dead_scan_busy`](./dead_scan_busy.md) | 429 | Scan quota or queue saturated; honour `Retry-After`. An identical request joins the running scan instead. |
| [`dead_scan_store_wedged`](./dead_scan_store_wedged.md) | 503 | Repeated scans found the store not answering. |
| [`dead_scan_timeout`](./dead_scan_timeout.md) | 504 | One scan ran past its time budget. |
