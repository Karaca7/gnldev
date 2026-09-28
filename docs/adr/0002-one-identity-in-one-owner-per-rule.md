# ADR-0002: One way in for identity, one owner per rule, one table that proves it

- **Status:** Accepted, 2026-09-28
- **Builds on:** ADR-0001 (end users isolated by default). This decision does not change what is
  isolated; it changes where the rules live so that a new door or a new run kind cannot miss them.
- **Where:** the 0.7.0 entry in CHANGELOG.md

## Context

ADR-0001 put the isolation rules in place. Two audits of the result (base `15e10409`) found that most
of the leaks still open came from the same place: the rule existed, but it was written, or read, in
more than one place, and the copies drifted.

- **Identity enters every package in its own shape.** Only `@gnldev/server` and `@gnldev/studio`
  depend on `@gnldev/auth`. The others take:
  - chat-adapter, agui: `GnlIdentity = (req) => { resourceId?, orgId?, threadId? }` (defined in durable);
  - mcp: `identity: (caller) => McpCallerIdentity { resourceId?, orgId?, actor? }`;
  - queue, rag tool: a plain `resourceId` string.

  None of these shapes can say "this caller is staff". Measured consequence: the standalone
  chat-adapter let an end user read a staff member's ownerless thread (SECRET-2). `admitThreadRun` lets
  an ownerless thread through "because the server refuses it", and chat-adapter has no server in front.
- **"Does this run exist, and whose is it" has 5+ definitions** in server and engine gates. The
  results: a legacy/ownerless run taken over through REST (D2). A crash inside `forkRun`, between the
  row copy and the `:input` write, leaving an ownerless fork that another user took over. A drifted
  public helper, `threadOwnerFromRuns` (D1b).
- **Identity inside the engine is passed by hand**, as `resourceId`, 27 times. Workflow steps,
  agent-as-step, `withIdempotency` and a tool calling another tool lost it (measured).
- **A central rule alone did not protect.** A prototype "ownership kernel" caught 0 of 9 ownership
  mutations, because the product routes did not call it. The existing conformance tests caught 4/9, a
  generated door × scenario matrix 5/9, and both together 7/9.

## Decision

### Principle: every package stays usable on its own

0. **A door package works without any other door package and without a composition package.** A
   developer can install only `@gnldev/chat-adapter`, or only `@gnldev/mcp`, and get the same
   isolation as through `@gnldev/server`. The rules therefore travel as a shared contract and shared
   functions that each door calls, not as a package that builds the doors. The table in point 7 is
   what makes "each door calls them" hold.

### Outside: one way in

1. **Every door takes identity in one shape: `(req) => Principal`** from `@gnldev/auth`. The doors are
   server, chat-adapter, agui, mcp and studio, plus the queue/scheduler/events workers when they are
   given a request. The developer writes "who is this caller" once and hands the same function to
   every door. `GnlIdentity` and `McpCallerIdentity` are removed.
2. **The door translates, the engine does not import auth.** A door reads the principal through
   `callerKind` and gives the engine a small `Caller`: `{ user, id, orgId }`, `{ staff, orgId? }` or
   `unknown`. `@gnldev/durable` keeps depending on no other `@gnldev/*` package. `@gnldev/auth`
   depends on none either, so no cycle is possible.

### Inside: one owner per rule

3. **`runOwnerOf` is the one answer to "does this run exist, and whose is it".** It includes the
   `_v` rule, a bounded probe and one read-error policy: an unreadable record is denied, never read
   as "not started". Every run birth calls it: agent, workflow, network, batch, fork/replay/rollover,
   MCP-derived, agent-tool child. So does every door. `forkRun` writes the owner record **first**.
4. **The engine's gates take the `Caller` explicitly.** These are `admitThreadRun`, run admission and
   cross-run dedup. The engine refuses an end user on an ownerless record itself, instead of trusting
   a server gate that a standalone door may not have.
5. **Identity reaches tools, workflow steps and child runs through one typed channel.** It is sourced
   from the same value as the owner record, and `unknown` is closed. The old `options.resourceId` is
   removed. A type error cannot enforce that (measured: a tool reading it still compiles), so reading
   it throws at runtime.
5a. **A queued job's run belongs to the job's recorded owner without the handler passing it.** The owner
   is recorded when the job is enqueued. Today the handler must pass `resourceId: ctx.resourceId` on
   to `runDurable` again (queue README), and forgetting it gives an ownerless run that the user cannot
   see. `JobCtx` hands the handler a way to start the run that is already bound to that owner, e.g.
   `ctx.run({ model, prompt })`. `@gnldev/queue` keeps depending only on `@gnldev/durable`.
6. **Existing single owners stay single:** `threadOwnerOf` (the public `threadOwnerFromRuns` is
   removed), `ownedName`, the subject view, org scoping.

### Proof: one table

7. **A conformance registry is a release gate.** It covers run births × record states × doors. The
   states are normal, ownerless, record missing with rows present, and unreadable. A birth or door
   that is not listed FAILS the test, like the "unclassified route" rule of
   `subject-isolation-conformance.test.ts`. A parity test holds `runOwnerOf` to the definitions it
   replaces.

### Deliberately not central

- HTTP and transport status stay in each door. The engine answers `allow | deny | missing`.
- Adapters, wire formats, token verification, rate limits, budgets and roles are not moved.
- No package builds the doors for the developer (see Alternatives). An optional helper that wires
  several doors with one `identify` may come later, if it never becomes the only way to build a door.
- Splitting the god-functions (durable-tool `execute`, server `restApiApp`, `studio/server.ts`) is a
  separate track after 0.7.0.

## Alternatives rejected

- **Ambient identity (AsyncLocalStorage).** Nothing to pass by hand, but identity silently disappears
  across a queue, a timer or a third-party callback, and nothing in a signature shows it.
- **Owner inside the storage ports** (`ListQuery.owner`). Closes reads by construction, but breaks
  every third-party storage adapter. Kept as the long-term form in ADR-0001.
- **An ownership kernel called from routes.** 0/9 mutations caught, because a rule nobody is forced
  to call protects nothing. The table in point 7 is what forces it.
- **A central package that constructs every door ("push", e.g. `openAccess`).** Rejected, because it
  breaks point 0: a door could no longer be built on its own, and every standalone user would install
  and construct the central package too. It would also not reach the engine called directly
  (`runDurable`, `gnl.run()`) unless it wrapped the engine as well, and that is the all-knowing package
  the panels warned about. The one thing push offers, that a door cannot skip the rule, is covered by
  the table in point 7 instead. Not measured with a prototype.

## Open point, to be measured before it is decided

- **a2a does not tell the remote server whose work it is.** `@gnldev/a2a` calls a remote
  `@gnldev/server` with the service's own credential (headers, optional HMAC). The remote run is
  therefore ownerless, or the service's, not the end user's. This was found by reading the code, not
  by a test. If a test confirms it: the a2a tool reads the user from the channel in point 5 and calls
  the remote as an `application` naming that user (the kind `roleAuth`'s `client` already has). Used
  outside a GNL run, it sends no user, as today.

## Consequences

- **Breaking, in 0.7.0** (0.x: no shims):
  - `identity` on chat-adapter, agui and mcp now returns a `Principal`;
  - `GnlIdentity`, `McpCallerIdentity` and `threadOwnerFromRuns` are removed;
  - a tool reading `options.resourceId` throws;
  - chat-adapter, agui and mcp depend on `@gnldev/auth`.
- **Fixed by this decision (to be shown red → green):** SECRET-2, D2, the fork crash takeover, D1b,
  S1b, and the identity leaks in workflow steps, agent-as-step, `withIdempotency` and nested tools.
- **Implementation base:** the "explicit typed identity" candidate the panels measured, trimmed to this decision. Conditions:
  measure PostgreSQL before release; the table is green on B before merge; add a row for the
  workflow-listing mutation (M5), which nothing caught.

## Prediction (to be checked by git)

A new door, or a new run kind, is covered for identity and ownership by adding one row to the table
and touching **≤ 3 files**, without editing `runOwnerOf` or any other door. Check after the next three
doors or run kinds land.

**Checked, 2026-09-28** (the 0.7.0 architecture panel, one new door and one new run kind added on a
branch):

- **A new door took 2 files. Held.**
- **A new run kind took 4 files. Falsified.** The fourth file is the test itself:
  `packages/server/test/ownership-matrix.test.ts` keeps an `EXPECTED` map of how many start-point calls
  each source file holds, and a new run kind changes that count. The map repeats what `BIRTHS[*].sites`
  in `conformance-registry.ts` already says.
- **Proposed fix, for a follow-up:** derive `EXPECTED` from `BIRTHS`' `sites`, so a new run kind is
  one row in the registry and no edit to the test.

## Scope

- **Measured:** the base findings, the mutation counts and the dependency direction (package.json).
- **Not measured:**
  - the "push" alternative (rejected on the principle, not on a prototype);
  - PostgreSQL cost of `runOwnerOf`;
  - M10–M12 mutations;
  - bundle size for chat-adapter/mcp with `@gnldev/auth` added.
- **Known limit: the table finds doors by name.** The completeness check in
  `packages/server/test/ownership-matrix.test.ts` lists a package's exports that match
  `/^(create|serve)\w*$|Surface$|^pipe\w+Stream$/` and fails on any that is not a `DOOR` or in
  `NOT_A_DOOR`. A door exported under another name is not seen. Measured by the architecture panel
  (2026-09-28): a door exported as `webhookHandler` passed the check without a row in the table.
  Proposed fix, for a follow-up: every source file that calls an engine starter (`createGnl(`,
  `runDurable(`, `streamDurable(`, `resumeRun(`, `.runWorkflow(`, `admitRun(`) must be listed in a
  `DOOR`'s files or in `NOT_A_DOOR`. The panel sized this at two files.
- **This decision is wrong if:**
  - a door package cannot be used on its own anymore;
  - a door can still be written that passes the table while taking identity in another shape;
  - the table stops catching mutations that the full suite catches.
