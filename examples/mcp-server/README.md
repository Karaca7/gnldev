# A multi-tenant MCP server over real HTTP

```bash
pnpm demo        # stands up a real server, connects real clients, prints what each one got
pnpm typecheck
```

Every number in this README is produced by `src/scenarios.ts`, and `test/mcp-server.test.ts` asserts the
same functions the demo calls — so the table and the suite cannot disagree. That is the arrangement
[`examples/incident-proofs`](../incident-proofs) uses, for the same reason: a demo that prints its own
numbers while a test computes different ones is how a README ends up citing something that stopped being
true.

## Five questions, and only three of them are GNL's

Authorizing a tool call is not one check. Answering any of these tells you nothing about the next:

| | question | who answers | in this example |
|---|---|---|---|
| ① | is this token real? | **you** | `startServer`'s middleware sets `req.auth` |
| ② | who is calling? | `identity` | `caller.authInfo.clientId` → a tenant |
| ③ | may they call this tool? | `allowTool` | the token's scopes, on **list and call** |
| ④ | is this object theirs? | **the tool** | `refund` closes over the sealed caller |
| ⑤ | are they calling too much? | `rateLimit` | per caller, per minute |

**① is yours and stays yours.** The MCP spec makes authorization OPTIONAL, says an STDIO implementation
**SHOULD NOT** follow it (credentials come from the environment), and for HTTP requires the server to
validate that a token was issued for *it* as the audience. `serveMcp` never opens the socket, so it cannot
do any of that — it reads what your transport already validated, out of `extra.authInfo`.

**④ cannot be delegated.** Only your code knows what an invoice is. What GNL can do is make the check
*possible*: the tool set is built per call from a sealed context, so `refund` closes over **whose** call it
is instead of trusting an id that arrived in its arguments.

## What the demo prints

```
① a request with no token                                 HTTP 401
                                                          refused by YOUR middleware, before any MCP handler ran

③ tools/list, two tokens with different scopes            2 vs 1 tools
                                                          acme sees [read_invoice, refund]; the reporting integration sees [read_invoice]

③ a tool the scope omits, vs a name that does not exist   identical
                                                          both answer: MCP server: no such tool: <name>

④ acme asks for globex's invoice                          refused by the tool
                                                          own invoice: returned; the other tenant's: {"error":"not your invoice"}

5 refunds of one invoice, sent at the same moment         1 side effect
                                                          1 got the result, 4 were told to retry the same key, 0 escaped as an exception

retrying the same key after losing the race               result returned, nothing re-ran

6 clients connect; 3 say goodbye, 3 vanish                6 → 3 of this row's own; 0 left in total

acme asks for its data to be deleted                      9 records removed
                                                          3 runs were attributed to acme; 0 left; globex still has 1
```

## Three things worth reading the code for

### A forbidden tool answers exactly like one that does not exist

Filtering `tools/list` is a claim that the caller does not see these tools. If the call door then answers
`Not permitted: 'refund'` for a real tool and `no such tool` for an invented one, a caller shown an **empty
list** can still enumerate the whole namespace by trying names — the text and structured-error-versus-
exception both give it away. Both cases answer the same way here.

The cost is a misleading message while debugging. The place to answer "why can't my client call this" is
your own `allowTool`, which already knows the reason and can log it without sending it to the caller being
refused.

### Concurrent calls under one key are the normal case, not an edge case

A double-click, a client retrying on timeout, two workers draining one queue. Five simultaneous refunds of
one invoice produce **one** side effect — and the four that lose the race are told so in a way they can act
on:

```
[run_busy] 'refund' (...) is being executed by another executor — retry the SAME call with the
SAME idempotencyKey; the work is in flight or awaiting a decision, and retrying is how you
collect its result. It has NOT been run twice.
```

The code comes from `@gnldev/durable`'s `blockedErrorCode`, the same source `@gnldev/server` uses to map
`run_busy` to HTTP 409 + `resumable: true`. The demo then retries and gets the first call's result without
refunding again — asserted, not just described.

### Sessions need a timeout, not just a close hook

The SDK's own examples keep a `Map` of transports by session id. Kept without a matching delete it grows
one entry per client that ever connected. `onsessionclosed` is the obvious fix and it is **not sufficient**
— measured against this server:

| | result |
|---|---|
| `client.close()` | the server **still holds** the session (1 → 1) |
| `client.terminateSession()` | the session is dropped (2 → 1) |

`close()` closes the *client's* transport; the DELETE that ends the server-side session is a separate call.
So an orderly goodbye is opt-in on the client, and a client that crashes or loses the network sends
neither. `sweepIdleSessions` is what bounds the map for those.

A `transport.onclose` handler was also here and was **removed**: a mutation showed that deleting it broke
no test, and deleting `onsessionclosed` instead broke none either — for the orderly path the two are
interchangeable, and the case `onclose` was added for is exactly the one where it does not fire. Only
removing both broke a test. Every line left in this example fails a test when you delete it.

## Not shown here

- **A shared rate counter.** `rateLimit: { maxCalls, windowMs }` counts in **one process**; two instances
  behind a load balancer each allow `maxCalls`. Pass a function and keep the counter where your other
  counters live.
- **Real credentials.** `TOKENS` is a literal map standing in for an OAuth introspection or a JWT verify.
- **Row-level permissions.** `allowTool` filters by tool, not by row. "May refund invoice inv-1" is ④'s
  job, which is why it lives in the tool.

## License

Apache-2.0
