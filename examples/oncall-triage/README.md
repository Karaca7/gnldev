# On-call Incident Triage

An alert fires at 3am. Something has to read the runbook, gather the numbers, say what is wrong, and —
if the runbook calls for it — **ask a human for permission to restart a service**. Then watch for
thirty minutes, because the runbook says to.

This is the framework's tutorial example. It runs with **no API key**.

```bash
pnpm install
pnpm --filter @gnldev/oncall-triage start
# → http://localhost:3200          alerts in, incidents out
# → http://localhost:3200/studio   the journal, the approval queue, time travel
```

```bash
curl -XPOST localhost:3200/alerts -H 'content-type: application/json' \
  -d '{"incidentId":"INC-1","service":"checkout","severity":"sev1","text":"memory leak suspected"}'

curl localhost:3200/incidents        # → status: awaiting-approval, with the toolCallId that is waiting
```

Open Studio, find the suspended run, approve the restart. Or from the shell:

```bash
curl -XPOST localhost:3200/incidents/triage:INC-1/approve \
  -H 'content-type: application/json' \
  -d '{"toolCallId":"rs-checkout-35","approved":true}'
```

## Why this scenario

Durable execution is usually demonstrated with a payment: *don't charge the card twice*. That example
is easy to follow and slightly dishonest, because a double charge is **reversible**. You refund it and
apologise.

A restart is not. Restart the database twice during an incident and you have caused a second outage
on top of the one you were called for, and there is nothing to give back. Page the same engineer twice
and you have taught them that the pager lies — which is a cost that arrives weeks later, when they
miss the one that mattered.

So this example puts the framework's guarantees where they are load-bearing rather than convenient:

| Guarantee | What it is worth here |
|---|---|
| **Approval** | A person decides before production is touched — and the run *suspends* rather than blocking, because approval can take an hour and a process holding a socket open for an hour is a process that gets restarted before the answer arrives |
| **At-most-once** | The restart is not fired a second time across double-clicks, retries and crash-resume; where the outcome is genuinely unknown the run stops and asks rather than guessing |
| **Cross-run idempotency** | The same incident pages once, even when the alert fires again as a brand-new run |
| **Redaction** | The logs this agent reads carry a database password. Without a redactor, running it means posting that password to a model provider |
| **Durability** | The thirty-minute watch survives the deploy that lands at 3:10am |

## The runbooks

The agent does not improvise. It reads a runbook first, and the runbooks are the source of every rule
in the code (`src/runbooks.ts`):

- **rb-memory** — over 1800MB RSS: read the log, confirm the pattern, restart. *Restart needs SRE
  approval.* Then watch for 30 minutes; a leak that returns is a code bug, escalate rather than
  restart again.
- **rb-latency** — p99 over 2000ms: **do not restart.** Latency is downstream. Restarting moves the
  queue, it does not shorten it.
- **rb-disk** — rotate logs first; never delete data during an incident.
- **rb-escalation** — page the on-call engineer **once and only once** per incident. For a second
  opinion, ask the database specialist instead of paging again.

## What each package does here

Every package earns its place by a sentence in a runbook. Nothing is included to complete a set.

| File | Packages | What it is for |
|---|---|---|
| `src/agent.ts` | `durable` `memory` `processors` `tool-schema` | The agent: what it may read, what it may do, what it must ask about |
| `src/runbooks.ts` | `rag` `cache` | The runbooks, retrieved by meaning; embeddings computed once |
| `src/tools.ts` | `durable` | Four tools; the two that change production declare how they dedup |
| `src/workflow.ts` | `workflow` | The incident pipeline: triage → escalate → close, each step journaled |
| `src/specialist.ts` | `a2a` `mcp` `server` | A second agent, its own blast radius, its tools from an MCP server |
| `src/schedule.ts` | `queue` `events` `scheduler` | Alerts arrive as jobs; a restart publishes a fact; the watch is a row with a time on it |
| `src/server.ts` | `server` `chat-adapter` `studio` `auth` | The surface an engineer touches, and the gate on the approval |
| `src/observe.ts` | `evals` `otel` | Did it follow the runbook, and what did it cost |

## Three things worth reading the source for

### 1. The redactor was installed and the password still leaked

`piiRedactor` masks **personal** data — email, phone, card, IBAN, SSN, IP. A DSN password is a
*credential*, not PII, and the built-in set does not cover it. With only the defaults, the log line
reaching the model was:

```
INFO  boot: connected postgres://svc:hunter2@pg-primary/orders
```

…while the customer's email address beside it was correctly masked. The fix is one `extraPatterns`
entry (`src/agent.ts`), and it keeps the host:

```
INFO  boot: connected postgres://[REDACTED_DSN_CREDENTIALS]@pg-primary/orders
```

The host stays because at 3am *which database* is the question, and `[REDACTED]` for the whole URL
answers none of it.

### 2. "Page once" needs two different guards

The runbook sentence is one line. Enforcing it takes two mechanisms that fail in opposite directions:

- the **workflow journal** stops a *replay* of this run from paging again — crash, resume, fork
- **cross-run idempotency** stops a *different run* for the same incident from paging again — the
  alert re-fires, a queue redelivers, an operator retries

Remove the first and a resumed run re-pages. Remove the second and a re-fired alert re-pages. Neither
covers the other. Both are asserted in `test/`, and each assertion was written by first removing the
guard and watching the count go to 2.

### 3. Declaring idempotency on a tool is not enough to get it

`pageEngineer` declares `idempotency: 'args'` and `idempotencyWindow: 'cross-run'`. Those fields are
read by the **durable tool layer**, which the agent loop applies. The workflow calls the page outside
any agent turn — so calling `pageEngineer.execute(...)` there would look correct, read correctly, and
dedup nothing. `withIdempotency` is what puts the call back on that layer (`src/index.ts`).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3200` | HTTP port |
| `HOST` | `127.0.0.1` | Loopback unless you name an address |
| `ONCALL_ADMIN` | *unset* | Bearer token required to approve a restart. Unset = open, and the console says so |
| `ONCALL_VIEWER` | *unset* | Bearer token for read-only access |
| `WATCH_MS` | `1800000` | The post-restart watch window |
| `NVIDIA_API_KEY` + `NVIDIA_MODEL` | *unset* | Use a real model instead of the deterministic one |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | *unset* | Where `traceIncident` sends spans |

With `ONCALL_ADMIN` set, an unauthenticated approval is refused with 403 and **no restart happens** —
that is a test, not a claim.

## The model

`src/model.ts` is deterministic and needs no key: it plans the same sequence a real model would —
read the runbook, pull the metric, read the log, act if the runbook says to. It is deterministic on
purpose, because a tutorial whose output changes between runs cannot teach what a durable run
guarantees.

Set `NVIDIA_API_KEY` and `NVIDIA_MODEL` (or `OPENAI_API_KEY`) to swap in a real one — nothing else in
the app changes. No model id is hard-coded as a default: provider catalogues change, and a constant
naming a retired model turns a working example into an error for everyone who clones it.

## Tests

```bash
pnpm vitest run examples/oncall-triage
```

Eleven assertions, each one a claim this README makes. They are not a smoke test — the DSN test and
the two paging tests exist because the example was *wrong* when it was first written, in exactly the
ways described above.

## License

Apache-2.0 — see [LICENSE](../../LICENSE).
