# Changelog

All notable changes to the `@gnldev/*` packages, which are versioned and released together — see
[VERSIONING.md](./VERSIONING.md).

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [Unreleased]

**Nothing has been published yet.** This will become `0.1.0`, the first release. There is no earlier
version to diff against, so the entries below are the changes worth knowing about from the point this
file was introduced — reconstructing a plausible-looking history for a project that has never shipped
would be worse than saying that.

### Security

- **`gnl dev` and `gnl studio` now bind `127.0.0.1`.** They passed no hostname, so Node bound *every*
  interface while the startup line printed `http://localhost:…`. On a shared network that offered an
  admin surface — run purge, managed-agent promote, cache invalidation, and a Playground that spends
  your API keys — to anyone who could reach the port. **If you run `gnl dev` in a container, add
  `--host 0.0.0.0`**; exposing an *unauthenticated* server additionally requires
  `--allow-open-network`, so the decision is recorded in the command line rather than inherited from a
  default.
- **`gnl studio` now applies your auth configuration.** It never called `resolveAuthProvider`, so its
  admin API was open regardless of what `gnl.config` or `GNL_ADMIN_TOKEN` said. `gnl dev` was already
  correct.
- **`/swagger` no longer loads a floating dependency from a CDN.** It fetched `swagger-ui-dist@5` from
  unpkg with no integrity attribute and no CSP, on the same origin whose `localStorage` holds the
  Studio bearer token — so publishing any `5.x`, or tampering with what unpkg served, put attacker code
  in reach of it. Pinned to an exact version with SRI on both assets, plus a page-level CSP whose
  `connect-src 'self'` means injected code cannot post the token anywhere. Its `script-src` now names
  the bundle by its sha384 (a CSP3 hash-source, the same hash the tag's `integrity` carries) instead of
  allowlisting the whole unpkg origin, which would have admitted any path on it with no integrity —
  defence in depth, not a live hole, since the page's markup is static.
- **`piiRedactor` masked the reply but wrote raw PII into thread memory.** A deployment that added
  `processors: [piiRedactor()]` alongside `memory` got exactly the masking it asked for everywhere it
  could see it — the model's prompt, the journal, and the value returned to the caller all carried
  `[REDACTED_EMAIL]` — while the conversation store received the **unredacted** text. Both directions
  leaked: the user's own message (the memory path captured a reference to the caller's raw array
  before the processor chain ran, and processors are pure, so the transformed copy was a different
  object that never reached the write) and the model's reply (the output-processor pass shadowed
  `text`/`response.messages`, but the memory append re-derived its messages from `result.steps`, which
  is not shadowed). So the email address, card number or identifier a redactor exists to contain was
  persisted in plaintext, then read back into the prompt of every later turn on that thread, exported
  by any thread read, and left in whatever backup the store keeps — reachable by anyone with database
  or thread-read access, and by the model itself on the next turn. Both halves are closed and pinned
  against the real shipped redactor (`packages/processors/test/pii-memory-e2e.test.ts`). **Known
  residual, stated rather than hidden:** `result.steps` still holds the model's raw output in the run
  journal — processors transform a `{text, messages}` view, they do not own the step records. If you
  ran `piiRedactor` with memory enabled, treat existing threads as containing unmasked data.
- **`streamDurable` handed the model's raw output straight back to the caller, `piiRedactor` or not.**
  The other half of the same leak, on the other entry point. On the stream path the output-processor
  chain ran only over the messages heading for memory; every terminal promise the caller awaited was
  the model's own text. Measured with one redactor configured and the same agent on both entry points:
  `runDurable` returned a masked `await result.text`; `streamDurable` returned the model's own text,
  **raw**. So an HTTP handler that streams for the
  durability and then returns, logs or stores `await result.text` served precisely what the redactor
  exists to contain, while the identical code under `runDurable` did not; the reachable surface is any
  consumer of the terminal promises, which is what a chat backend, an audit log and a "copy the final
  answer into the ticket" step all read. `text` and `response.messages` are masked on both paths now,
  pinned in `packages/durable/test/processor-output-surface.test.ts` against a stand-in with the
  shipped redactor's shape — `@gnldev/durable` cannot import `@gnldev/processors` (the dependency runs
  the other way), so no test in this package can exercise the shipped `piiRedactor`. It is pinned
  end-to-end only on the memory path, in `packages/processors/test/pii-memory-e2e.test.ts`; the stream
  path's terminal promises have no such test.
  **Known residual, the same line `runDurable` draws:** `result.steps` and `result.content` are still
  raw. That is not an oversight — `processOutput` is a `{text, messages} -> {text, messages}` hook
  called once for the whole turn, and its output arity is unconstrained (a summarising processor
  legitimately returns one message for a turn that produced three), so there is no total mapping back
  onto the per-step records; distributing by index when the counts happen to line up would mask a
  character-wise redactor and silently do nothing for a summariser, which is a worse outcome than a
  documented raw field. **On the stream path `textStream`/`fullStream` are raw as well, and cannot be
  otherwise**: those deltas are flushed to the client before the turn ends, and a whole-turn hook has
  no chunk-wise meaning (a masked value can straddle two deltas). Read `text` / `response.messages`;
  if the delta stream itself must never carry the value, use an input processor or `runDurable`. A
  suspended or blocked turn is left raw on both paths — the chain does not run on a turn that has not
  finished — which is parity with `runDurable`, not a new gap.
- **`GET /dead-events` handed the payload to a caller that may not read payloads, in the field next to
  the one saying it had been withheld.** The event body was already gated; the handler's `error` was
  left behind on purpose, on the reasoning that it is the only evidence column and Studio cannot clean
  someone else's string. That was true and it was not enough. `error` is
  `String(err?.message ?? err)` from the **host's** handler, which ran *on* the payload — and every
  validation library in common use quotes the value it rejected. Re-measured end to end against a real
  `@gnldev/events` quarantine, a grant of exactly `['runs:read','catalog:read']` got back
  `[{"error":"ValidationError: ssn '123-45-6789' invalid for customer jane@customer.example",
  "attempts":2,…,"payloadRestricted":true}]` — one row contradicting itself, and in the **default**
  answer, so unlike `payload` it did not even need `?payload=1` to be asked for. `error` now sits
  behind `payloads:read` (see *Added*), with `errorRestricted: true` in its place and only on records
  that actually have an error, since claiming it for a record with none would be inventing one. The
  permission is now evaluated on every request rather than only for a caller that asked for bodies —
  the old ordering existed so nobody was measured against a permission they did not need, and `error`
  is exactly the case that made that premise false. **No `?payload=1`-style opt-in for it,
  deliberately:** the opt-in guards a *body*, which is bulk data a client can receive by accident;
  `error` is one short field rendered in every row, and an opt-in would blank that column for every
  caller including the entitled ones. **Rejected: truncating `error` to N characters** — PII arrives
  at the *front* of a validation message. `ValidationError: ssn '123-45-6789'` is 34 characters,
  `ECONNREFUSED 10.0.0.5:5432` is 26, `502 Bad Gateway from https://api.stripe.com/v1/charges` is 53;
  every threshold that keeps the short infrastructure errors readable keeps the whole SSN, and every
  threshold that cuts the SSN cuts them too. The number would only be there to look like a control.
  `catalog:read`'s own description lost its "no customer data" promise in the same pass — see
  *Known limits* for the one route that still breaks it.
- **Input processors were skipped on a same-`runId` retry, so the model received the raw prompt.**
  `runDurable`/`streamDurable` freeze the resolved input on first entry and skip the chain when that
  record already exists — correct for `resumeRun`, which reads the frozen (already-masked) copy back,
  but the direct-retry path kept using the *caller's own* array. With `piiRedactor` configured, the
  second attempt sent the unredacted address to the provider and wrote it to thread memory; measured,
  the retry's prompt carried the masked copy *and* the raw one, side by side. An attacker
  reaches this by making the first attempt fail after the input was frozen — a provider 500, a
  transient journal error — which is exactly what a retry is for. The chain is now rehydrated from
  the frozen record instead; if that record cannot be read the turn is refused and stamped
  (`incomingUnrecoverable`) rather than persisted raw.
- **`exportRun` can now redact the one free-text value a span carries (`@gnldev/otel`).** A failed
  run's error message travels as `gnl.error` and as the root span's status message, and it is not
  always your own text — a provider refusing a request commonly echoes the offending input back inside
  it. `piiRedactor` did not cover this path and could not: it hooks
  `processInput`/`processOutput`/`processToolResult`, while a run's verdict is written by
  `recordRunOutcome`, which no processor is consulted about. Measured with the redactor installed, an
  address in a provider's refusal still reached the span raw, and from there whatever collector
  `endpoint` names. New `redact` option, plus `piiTextRedactor()` in `@gnldev/processors` so the
  wiring is one line and shares `piiRedactor`'s defaults. Left **off by default** — the message is the
  main debugging value a trace carries and the package cannot know whether the endpoint is your own.
  A redactor that throws or returns a non-string drops the message rather than falling back to the raw
  text. The zero-dependency `exportRunToOtlp` path and `live.ts` never carried the message and are
  unchanged.

### Breaking

Read this section before upgrading — each entry says what to do, not just what changed. Nothing has
been published yet, so no installed base is affected; the entries are here because these are the
changes that *would* require an edit, and the rules in [VERSIONING.md](./VERSIONING.md) say so
whether or not anyone is on the other side of them yet.

- **`streamDurable`'s terminal promises now return the output-processed value.** If a deployment has
  output processors configured, `await result.text` and `await result.response` (`.messages`) return
  what the chain produced instead of what the model emitted — a running deployment that streams and
  then returns `result.text` from a handler starts serving a different string. That is the security
  fix above, and the reason it is listed here too: changing the value a live handler returns is a
  break under `VERSIONING.md`'s "behaves differently in a way that requires you to edit code" test.
  **What to do:** nothing, if you want the masking (this is parity with `runDurable`, which behaved
  this way already). If some downstream step genuinely needs the untouched model output — a raw
  transcript archive, a provider-side debugging dump — read it off `result.steps`, which is
  deliberately not transformed. Deployments with no output processors are byte-for-byte unaffected:
  the mask is only wired in when a processor chain exists.
- **`@gnldev/events` consumers now give up on an event instead of retrying it forever, and the first
  retry is a minute away rather than a poll away.** Previously a handler that threw was retried on
  every poll, indefinitely; the defaults are now `maxAttempts: 8` on a `retryDelayMs` schedule of
  60s doubling to a 1h cap (≈2 hours total). Two things change for a running deployment: an event
  whose handler keeps failing is **quarantined and stops being delivered** after the budget, and a
  transient failure that used to be retried ~200 ms later (`pollMs`) now waits ~60 s. The defaults
  are what they are because `maxAttempts` counts attempts, not time — a five-attempt budget at
  `pollMs: 200` burned out in about a second, so a one-second downstream blip would have
  dead-lettered everything in flight. **What to do:** if you were relying on infinite retries, pass
  `{ maxAttempts: Infinity }`, and read the load-profile note under *Known limits* first — an
  event that is never quarantined parks that consumer's bookmark forever. To restore the exact old
  timing as well, pass `{ maxAttempts: Infinity, retryDelayMs: 0 }`. Otherwise: watch
  `listDeadEvents(work, topic, consumer)`, because events that used to sit in an invisible retry loop
  now land somewhere you have to look at (Studio's Dead-letter view, or `retryDeadEvent`). The new
  API itself is additive — see *Added*.
- **`@gnldev/events`' keys now escape their components (`:` → `%3A`, `%` → `%25`), and so does
  `RedisWorkStore`'s namespace.** Both are a *persisted key schema* — the five marker families
  (`evtack:`, `evtatt:`, `evtdead:`, `evtcursor:`, `evtrescan:`, each joining topic, consumer name and
  event id on `:`), the append-log namespace `evt:<topic>`, and the Redis adapter's own `wl:<ns>:<id>`
  — and a changed persisted key format is breaking under [VERSIONING.md](./VERSIONING.md), by the same
  rule that puts `argsHash` here. Concretely: a topic, consumer name or event id that actually
  contains `:` or `%` is now stored under a different key than it was, so on a live store the old
  markers are orphaned and every event on that consumer is delivered once more (handlers are
  contractually idempotent, which is what makes that survivable — it is not free), and on Redis every
  `wl:` record whose namespace contains one of those characters moves
  (`wl:evt:orders:e1` → `wl:evt%3Aorders:e1`) and is invisible to `list` until renamed. Names
  containing neither character — every test, every example in these READMEs, every key family
  documented in the GUIDE, and `qjob` — are **byte-identical** to before; that was a constraint on the
  fix rather than a happy accident. Redis's KV/ack half (`wk:`) is a whole-key GET/SET and is
  untouched. **What to do:** nothing if your topics, consumer names, event ids and queue namespaces
  are plain; drain in-flight deliveries across this point if any of them carries a `:` or a `%`, and
  if you query `gnl_work_kv`/`gnl_work_log` by hand, look for the escaped form. See *Fixed* for the
  two defects.
- **`argsHash` returns a different value for `Date`, `Map`, `Set`, `RegExp`, `URL`, `URLSearchParams`
  and `BigInt` arguments.** That hash is a *persisted key schema*: it names the journal records behind
  `idempotency: 'args'` and `'cross-run'` (`runKeys.toolByArgs` / `runKeys.toolCrossRun`) and it feeds
  the drift detector, and a changed persisted key format is breaking under
  [VERSIONING.md](./VERSIONING.md). Concretely: a run suspended mid-flight under an older build and
  resumed under this one would not find the journal record for a tool call whose arguments contain one
  of those types, and would re-execute it. Arguments made only of plain JSON — strings, numbers,
  booleans, null, arrays, plain objects, which is the overwhelming majority — hash
  **byte-identically** to before; that was an explicit constraint on the fix rather than a happy
  accident, and it is why the blast radius is limited to the types that were provably broken (they all
  collapsed to the hash of `{}`, and `BigInt` threw outright). **What to do:** drain in-flight runs
  across this point if your durable tools take arguments of those types. See *Fixed* for the defect
  itself.
- **A circular value now fails `argsHash`/`stableStringify` with `TypeError`, where it used to fail
  with `RangeError: Maximum call stack size exceeded`.** The error class is the contract under
  `VERSIONING.md` (the prose is not), so a changed class is listed here even though both cases are
  failures. The new error is prefixed `@gnldev/durable:` and names the path where the loop closes
  (`$.a.b.self` for `{ a: { b: x } }` where `x.self === x` — measured). **What to
  do:** if you catch `RangeError` around a durable tool call to detect this, catch `TypeError`. The
  rationale for the change is under *Changed*.
- **`:memctx.incomingCount` now counts the turn as it was persisted, not as the caller sent it.** It
  used to be the length of the caller's own array; it is now the trailing block of the frozen
  `:input`, which is what regression replay slices with. For a run without input processors the two
  are the same number. They diverge when a chain adds or removes rows: the new value is the one that
  makes `stripMemoryContext` reconstruct the turn correctly, and the old one made it replay a
  processor's own note as the user's message. `VERSIONING.md` counts the meaning of a stored field as
  breaking, which is why this is here rather than under *Fixed*. **What to do:** nothing, unless you
  read `:memctx` yourself — if you do, `incomingCount - chainAppended` is what memory holds, and the
  new `chainInserted` says how many rows a chain added inside the turn. `incomingDedupedByShape` marks
  a turn that was recognised as already stored.

### Added

- **`RunStatus` gained `'failed'`.** A run that threw recorded nothing, so a 401 on the first model
  call or a cost ceiling tripping mid-run read back as `'completed'` — and `exportRun` sent it to OTel
  with `SpanStatusCode.OK`. Runs now write an outcome at each terminal boundary. A *suspended* run is
  not a failed one, a run refused because another worker holds the lock is not a failure of that run,
  and a run that failed and later resumed to success stops being failed. Surfaced through
  `/runs?status=failed`, `gnl runs`, Studio, and OTel (which now reports `ERROR` with the reason).
- **`RunStatus` gained `'running'` — a run can now say it has not ended.** Every attempt writes a
  write-ahead outcome at entry; the terminal verdict overwrites it. The closed defect: a run
  SIGKILLed mid-work read back as `'completed'`, because "no terminal record" and "ended fine" were
  the same absence — proven closed at the process level (a child killed with SIGKILL mid-model-call
  reads `running` from the same SQLite file, and a resume closes it). Precedence is
  suspended > failed > running > completed; journals written before outcomes existed still read
  exactly as they did. Surfaced through `?status=running`, `gnl runs` (cyan), the Inspector (tab +
  info-blue dot), and OTel — where an unfinished run now exports **UNSET**, never OK: the dashboard
  no longer shows green precisely while the process is dead.
- **`RunStatus` gained `'canceled'` — a cancelled run no longer looks like a successful one.**
  `cancelAgentRun` journaled a flag and nothing else, and the `RunCanceledError` it causes is
  deliberately classified as *not a failure* — so the throw site recorded nothing, a run cancelled
  before it started read `'completed'`, and one cancelled mid-flight kept reading `'running'` forever.
  The cancel choke point now writes the verdict itself, once: the flag is what makes every downstream
  refusal possible, so recording from the throw sites would be several writers racing over one fact.
  Precedence is canceled > suspended > failed > running > completed — canceled outranks even
  `'suspended'`, because a cancelled run's pending approval can never be applied (`assertNotCanceled`
  refuses every resume, and there is deliberately no uncancel). Two things it deliberately does *not*
  do: a cancel that arrives after a run has already ended does not relabel it (the run's output is
  sitting right there in the timeline), and no straggling write-ahead can resurrect it. Surfaced
  through `?status=canceled`, `gnl runs` (dim), the Inspector (tab + muted dot — an operator stopping
  a run is not an incident, and colouring it like one buries the failures that are), and OTel, where
  it exports **UNSET** rather than ERROR: the semantic conventions reserve ERROR for *unexpected*
  endings, and paging an on-call because someone pressed cancel is the false alarm that trains people
  to ignore the signal.
- **`GET /health` and `GET /ready`.** Liveness touches nothing, so a failing database cannot cause a
  healthy process to be killed and restarted; readiness reads the journal with a 2s budget and returns
  503 when storage is unreachable. Both are unauthenticated by design and report reachability only —
  never the underlying error, which for a database failure carries the host, database and user.
- **Status labels are translated (en/tr).** `StatusBadge` printed the raw enum, so every run row, table
  and filter tab read `completed` / `suspended` in English regardless of language. Observability also
  gained a failed count, which it could always have computed and never did.
- `listRunsArray` / `asReaderJournal` / `runIdOfKey` / `deriveRunStatus` are exported from
  `@gnldev/durable` for hosts that read the journal directly.
- **This changelog, and [VERSIONING.md](./VERSIONING.md).** `pnpm check:versions` enforces the lockstep
  promise in CI, because the way lockstep breaks is quiet: someone bumps the one package they touched.
- **`@gnldev/events` gained a dead-letter: `maxAttempts`, `retryDelayMs`, `listDeadEvents`,
  `retryDeadEvent`.** A handler that keeps throwing is retried on a spaced-out schedule and then
  quarantined for that consumer — the same `qatt → qfail` shape `@gnldev/queue` already had, here
  `evtatt → evtdead`, so there is one dead-letter vocabulary rather than two. A quarantined event is
  deliberately **not** acked — "we gave up on it" is not "the consumer saw it" — and `retryDeadEvent`
  is per-consumer, because re-emitting would fan the event back out to healthy consumers too. The
  *options* are additive; **the defaults are not** — they change what a running consumer does, so the
  behaviour change and its migration note are under *Breaking*, and the standing cost under
  *Known limits*.
- **A quarantined delivery is visible and releasable from Studio.** `StudioEvents` (the host-supplied
  view, same wrap-your-own-store pattern as `StudioQueue`/`StudioCache`, so `@gnldev/studio` takes no
  dependency on `@gnldev/events`) turns on `GET /dead-events/topics`, `GET /dead-events` and
  `POST /dead-events/release`, the `deadEvents` / `eventsManage` capabilities, and a Dead-letter view
  in the UI; a release is audited as `event.release`. Everything is addressed by the **triple**
  `(topic, consumer, id)` rather than an id, because a topic fans out — one event has one quarantine
  record per consumer, and an id alone names N of them. The routes are deliberately not under
  `/events`, which is already the SSE change stream. Three constraints are part of the surface rather
  than bolted onto it, and are worth knowing before you wire a host up: the **event body is withheld**
  unless the caller both asks (`?payload=1`) and holds the new `payloads:read` permission — the list
  route only requires `catalog:read`, the configuration permission, and a
  payload is whatever the producer emitted (a caller that asks without the permission still gets the
  list, marked `payloadRestricted: true` per row); the **handler's error text is withheld on the same
  permission**, and unlike the body it needs no asking, because it ships in the default answer
  (`errorRestricted: true` in its place — see *Security*); and **one dead-letter scan runs at a time**
  deployment-wide, because it reads a whole topic log — a request for a different `(org, topic,
  consumer)` while one is in flight **waits in a bounded FIFO queue** and is answered a scan later,
  identical requests coalesce onto the one scan, and `429` + `Retry-After` (`code: 'dead_scan_busy'`)
  is what a caller gets once it is past its own allowance or the queue is saturated — see *Fixed* for
  the admission model and what it is measured to hold. `payloads:read` is matched by the `*:read` wildcard,
  so no existing grant or role preset loses anything. See [`@gnldev/studio`](./packages/studio) for
  the host contract.
- **`payloads:read` — a named permission for "the data a host's code was handed, and the text it
  produced from it".** `PERMISSION_CATALOG` gained `{ id: 'payloads:read', label: 'View payloads and
  failure text' }`, and it covers **four fields on two `catalog:read` routes**, not one: a dead-letter
  record's `payload` (the producer's event body) and its `error` (`String(err?.message ?? err)` from
  the host's handler, which ran *on* that body), plus `GET /scheduler/triggers`' `input` (the
  scheduled workflow's own argument) and `lastError` (the same string about it, written by
  `@gnldev/scheduler` at `sched:fail:`). One permission rather than four gates, because gating one of
  them is a patch and the rule is what was missing: `catalog:read` is the configuration permission,
  `payloads:read` is the one for what flows through the configuration. It is deliberately **not**
  folded into `threads:read` either — a checkbox labelled "View conversations" controlling event
  bodies would surprise the admin who ticks it. Backward compatible by construction: `*:read` matches
  it through the same wildcard every other named read uses, and every role preset starts from
  `*:read`, so only an admin who has deliberately narrowed someone to a named subset has to add it.
- **`GET /scheduler/triggers` projects its fields for a caller without `payloads:read`.** It used to
  return `listTriggers()` verbatim under `catalog:read` alone. `input` is now **dropped entirely** and
  `lastError` is replaced by `lastErrorRestricted: true`. The asymmetry is deliberate: nothing in the
  UI has ever rendered `input`, so its absence cannot be misread, while `lastError` *is* rendered
  under a failed trigger, where a silently missing one would read as "failed for no stated reason".
- **`@gnldev/scheduler` gained `lockTtlMs`** (on `pollScheduler` and `createScheduler`, default 60s) —
  how long a fire lock is held before another poller may reclaim it.
- **A tool that takes no arguments can use `idempotency: 'args'`.** `argsHash(undefined)` used to die
  inside `createHash` with `TypeError: The "data" argument must be of type string…` — `undefined` has
  no JSON form, so `stableStringify` returned `undefined` and it was fed to the digest unguarded. It
  now returns a stable hash of a reserved token in the type-tag namespace (so no real JSON output can
  spell it), which makes "this tool takes no arguments" an expressible key rather than a crash.
  Nothing can break on it: every one of these inputs threw before, so no journal record was ever
  written under them. A function or symbol argument still throws, now with a message that names
  `argsHash` and the type instead of pointing at Node's crypto internals.
- **`Principal.credentialId` — which credential spoke, as distinct from who the caller is.** Optional
  and additive; `roleAuth` fills it for every class from a `sha256` of the presented bearer token
  (`token:<64 hex>`, never the token itself), and `Principal.id` keeps its old meaning exactly — the
  basic-auth `user`, otherwise absent. Rate limiting, admission control and quota accounting may key
  on it. **Memory scoping, ownership and access control must not**: `resolveResourceId` treats
  `principal.id` as the SUBJECT of a run and prefers it over the `resourceId` a request named, so a
  synthetic value there is not a budget key but an owner. Measured while it briefly lived on `id`: an
  operator that sent `resourceId: 'user-42'` and one that sent `'user-99'` were both answered from a
  single `token:<hash>` memory bucket, with no error — the cross-user regression `resolveResourceId`'s
  own history records as measured and fixed, arriving through a different door. Hence two fields. The
  absence of `id` is load-bearing information (it is how a deployment says "no per-caller subject"),
  and nothing reads `credentialId` as an owner.
- **`RunThreadMismatchError`** — the typed error for a `runId` re-used on a different thread, replacing
  a bare `Error`. Carries `name`, and `detail` of `{ runId, startedForThread, requestedThread }`, so an
  HTTP layer can map it instead of pattern-matching a message. It is classified `not-a-run-failure`
  alongside `CompensatedRunError`/`RunCanceledError`: the mismatch is the caller's mistake and must not
  overwrite the verdict of the runId's own earlier, correctly-scoped attempt.

### Fixed
- **`piiRedactor` checks an identifier's own check digit before masking it.** Any sixteen digits were
  a card: measured, `order 1234567812345678` came back `[REDACTED_CREDITCARD]`, losing the order
  number without protecting anything. `creditCard` is now validated with Luhn and the new `iban` type
  with mod-97, so a match that fails its own arithmetic is left alone. The trade is stated rather than
  hidden — a card typed with a wrong digit fails Luhn and is then not masked; `validate: false`
  restores masking on shape alone. Custom patterns take a `test` of their own, because shipping
  checksums for the built-ins while handing callers a bare regex would be the asymmetry.
- **`iban` is a built-in type.** It carries a checksum, so it has no false positives to trade against,
  and it covers ~80 countries — a better-founded default than `ssn`, which is one country's. Before
  it, an IBAN was picked up by the phone pattern: `TR330006100519786457841326` came out
  `TR[REDACTED_PHONE]`, leaving the country prefix behind under the wrong name.
- **The `phone` pattern no longer eats text that is not a phone number.** It counted CHARACTERS, and
  its character class held spaces and dashes, so three digits spread over a wide span cleared the bar.
  Measured: it masked `2024-01-15 10` out of a timestamp, the whole of `1.2.3 - 4.5.6`, a run id, and
  two digits separated by eight spaces — text corruption in exactly the payload it most often runs
  over, since error messages and logs carry timestamps. Now bounded by digit groups, with single-
  character separators and no match starting on an ISO date. Verified in both directions rather than
  tightened by eye: eleven real formats (E.164, parenthesised, dotted, Turkish local, unbroken
  international) all still mask. A loose pattern with a rejecting validator was tried first and
  measured DANGEROUS — a greedy candidate swallows `1234-56-78 555-123-4567` whole, fails the check,
  and the span is already consumed, leaving a real number in the clear.
- **`piiRedactor` can now mask identifiers its built-in types cannot name (`extraPatterns`).** The
  five built-ins are US-shaped — `ssn` exists nowhere else — so a national id, an IBAN, a patient
  record number or an internal customer id had no type that matched it, and the only ways to react
  were to drop a built-in from `types` (which removes coverage rather than adding any) or to mutate
  the exported `PII_PATTERNS`, which changes behavior for every redactor in the process. Custom
  patterns run **before** the built-ins, which is load-bearing rather than cosmetic: the built-in
  `phone` pattern is greedy enough to swallow an 11-digit national id (measured — it comes back
  `[REDACTED_PHONE]`), so one applied afterwards would find its text already masked under the wrong
  name. Custom names are counted in `recordProcessorReport` too, so the audit trail cannot describe
  fewer types than the redaction masked. A pattern missing the `g` flag gets it added instead of
  quietly masking only the first occurrence. `piiTextRedactor` takes the same option.
- **A `types` entry with no pattern behind it is refused instead of silently masking nothing.**
  `piiRedactor({ types: ['iban'] })` returned the text untouched and reported nothing, so a
  deployment could believe a type was covered while the value went through in the clear. TypeScript
  caught it only for callers passing a literal — config arriving from JS, JSON or an env var reached
  it unchecked. Now throws at construction (config time, not mid-run), as does a malformed
  `extraPatterns` entry.
- **An optional tool parameter is no longer silently promoted to mandatory on OpenAI
  (`@gnldev/tool-schema`).** The `openai-strict` rule listed every property in `required` — strict mode
  demands that — but never did the other half, so `z.string().optional()` arrived as required with
  `type: "string"` and no `null`: the model could neither supply nothing nor say nothing was supplied.
  The rule's own comment claimed optionality was carried "via nullable", making this an unwritten step
  rather than a documented limit, and `strictJsonSchema` defaults to `true` in the AI SDK's OpenAI
  provider, so it was enforced rather than advisory. Previously-optional keys are now widened to accept
  `null`; genuinely required keys are untouched. An `enum` has `null` added to its **values** as well,
  since widening only `type` leaves a node nothing can satisfy. Nested objects included.
- **The dead-letter scan no longer lets one caller starve the rest — and naming a caller is no longer
  worse than not naming one.** Three rounds of measurement on the same endpoint, recorded together
  because each fix exposed the next:
  - *Admission was keyed on `Principal.id`, which a bearer token leaves undefined.* `gnl add host`
    scaffolds a bearer token and `GNL_ADMIN_TOKEN` is one, so the budget was silently off in the
    deployments the framework itself generates — auth ON, valid token, and still in the "cannot be
    named" branch, where no admission is charged at all. Now keyed on `credentialId ?? id`, and a
    deployment whose provider supplies neither **warns once per process** instead of failing open in
    silence.
  - *The per-caller allowance was a single-owner lock, and a lock is not a shared budget.* Under one
    shared token the first arrival held the whole allowance and every colleague behind it was refused
    on sight — measured, one **sequential** attacker connection: operator served **0 of 20**, against
    **20 of 20** on the same deployment with no identity at all. It is now a cap of two with the excess
    queued, which bounds the concurrent flood the lock was written against while letting a second party
    behind one credential take its turn.
  - *The FIFO queue was drop-tail, so one source could hold every slot.* Measured with an
    unidentifiable attacker: the operator is served in full up to 8 connections and **0 of 10 at 65**,
    which is the drop-tail cliff — where between the two it falls depends on how long a scan takes
    relative to the queue budget, so no single intermediate number is quoted here. Callers that can be
    named now have the full depth reserved to them and unnameable ones share half.
  Measured after all three, 65 attacker connections: attacker anonymous + operator holding a token
  → **20/20**; attacker on token A + operator on token B → **20/20**. Two cases remain at 0/20 and are
  not solvable here — both parties anonymous, and both behind the *same* credential. A shared
  credential is shared fate; the fix is that identifying a caller now helps instead of hurting.
- **A regenerate under an input processor no longer grows the thread.** `dropEchoedHistory` decides
  whether the client echoed back what the thread already holds, and it compared the RAW rows a client
  re-POSTs against the MASKED rows the chain had stored — two things that can never be equal. So every
  regenerate under `piiRedactor` read as new, and because each unmatched turn left more unmatched
  history for the next one, the cost grew per turn rather than staying at the "duplicate row" an
  earlier note described. Measured over four regenerates, one per turn: `2 → 5 → 9 → 14 → 20` rows
  against a no-processor baseline of `2 → 3 → 4 → 5 → 6`; a long conversation was quadratic in the
  thread store and sent more history to the model every turn. The comparison now runs against the rows
  as the chain will render them, while the messages actually used are still the client's — a
  deployment with no input processors compares exactly what it did before. What is stored is unchanged:
  the thread still holds only the processor's output.
- **`POST /knowledge/search` is gated on `payloads:read`, not on `catalog:read` alone.** It returned
  indexed corpus text verbatim under the CONFIGURATION permission — the one whose own description
  promises "not the data flowing through them", and the one an admin reads before granting. Measured:
  an acme-bound identity got back `[{"text":"globex private doc"}]`. Every sibling that reaches through
  the configuration to the data behind it (a dead-letter body, a scheduled trigger's input) was already
  gated this way; this was the exception that made the description false. Closed ROUTE-LEVEL rather
  than by projection, because the whole response is the corpus and a search result without its text is
  not a narrower answer but no answer. Backward compatible by construction: `*:read` matches
  `payloads:read` through the wildcard every named read uses, and every role preset starts from
  `*:read`, so only an admin who deliberately narrowed someone to a named subset has to add it.
- **The dead-letter and job projections check a field's SHAPE, not just its name.** The allowlist
  stopped a host attaching an undeclared field, so the same data one level in walked back through:
  measured, `consumers: [{name, dbDsn, lastFailure}]` on a topic row and
  `attempts: {n, workerHost, dsn}` on a dead-letter row were served whole to a `catalog:read`-only
  caller, as was a value whose own `toJSON` produced the DSN. Shapes come from the declared wire types
  (`StudioDeadEvent`/`StudioJob` are scalars; `StudioEventTopic.consumers` is `string[]`) and a
  mismatch is dropped rather than coerced. It is a structural boundary, not a content one — see
  *Known limits*.
- **`GET /dead-events/topics` survives a host row it cannot read.** A throwing getter on an
  allowlisted field answered `500 Internal Server Error`; the row is now skipped and the readable
  topics are still returned, matching the defence `GET /dead-events` already had against a `listDead`
  returning `[null, 42]`.
- **The abandoned-scan brake is re-read once the scan slot is held.** Checked only at the door, it was
  walked past by the queue: with a deadline shorter than the queue wait, requests admitted while the
  counter was 0 each opened a fresh whole-log read against a store already known to be wedged —
  measured, 17 unwatched reads and 9 outstanding against `maxAbandonedScans: 2`. Unreachable on the
  defaults (30 s deadline vs 5 s queue wait), which is why nothing documented the interaction.
- **`Retry-After`'s per-organization estimates are evicted least-recently-used.** A `Map` keeps
  insertion order and `set` does not move an existing key, so touching a bucket did not protect it and
  a tenant scanning throughout the noise was still evicted in arrival order, then answered from the
  fallback about its own scans. It does not save an *idle* tenant — 256 buckets and 256 newcomers is a
  full map under any policy — and the attack neither leaked memory nor was cheap.
- **A `runId` re-used on a different thread no longer corrupts the run it names.** The mismatch used
  to be caught inside `applyInputProcessors`, after `runStarted` had written a `running` verdict and
  `resolveApprovals` had claimed the caller's `approvals`. Two consequences, both measured: a runId
  that had already **completed** read `failed` after a later mismatched call, because the outcome
  record is monotonic-by-time rather than "don't touch a terminal verdict"; and the rejected call's
  `approvals` were journaled as decisions for a call that never ran. The check now reads `:input` and
  asserts ownership before either write. The two halves are independent, which is worth stating
  because it is not obvious: reverting only the `outcome.ts` classification, with the new ordering
  intact, still flips the completed run to `failed` — being early means nothing was written *before*
  the throw, not that nothing is written after.
- **`GET /runs` no longer repeats rows when a run is written mid-pagination.** The `cursor` was a
  newest-first offset, and the window for each page was recomputed from a total read at request time,
  so any run appended between two page requests pushed the window back onto rows already shown:
  measured at 10 runs and `limit=3`, page 2 came back byte-identical to page 1 and the two rows that
  belonged on it were unreachable. Well-formed envelope, correct count, real rows — entirely silent.
  The cursor is now an *ascending anchor* (the exclusive end of the next page's window), which an
  append cannot move. **The value is different, and it is opaque** — send back what the server gave
  you; an offset written by hand against the old meaning now lands somewhere else. Honest limit: this
  is a trade, not a strict win. Deleting the oldest runs (`sweepRuns`) moves an ascending index the
  way an insert moved an offset, so a page taken across a retention sweep can repeat — the old
  reading survived that case and this one does not. Inserts happen on every run and sweeps only when
  retention runs, which is why the trade goes this way. Both readings repeat rather than skip, and a
  cursor keyed on the row itself (`created_at` + `runId`) is what would survive both.
- **The Studio no longer displays a fabricated run count.** `RunsPage.total` was typed as required
  but `@gnldev/server`'s `/runs` has never sent it, so the value arrived `undefined` and a `?? 0`
  rendered a confident **0 runs** above a list that plainly had runs in it — and `1/0` on the load-more
  button. `total` is now optional; when it is absent the Inspector says how many are loaded and that
  more exist, and its search box drops the count from the placeholder (which, having no `aria-label`,
  is also the field's accessible name).
- **Concurrent turns on one thread no longer lose messages.** `AgentMemory.append` read the thread,
  took `existing.length` as the next position and wrote there, so two runs answering the same thread
  claimed the same positions and `ON CONFLICT DO NOTHING` silently discarded the loser — a third of
  all messages under a three-way concurrent turn. When the discarded row was a `tool-result`, the
  thread was left holding an unanswered tool call and *every* later turn on it failed at the provider
  with `HTTP 400 "Tool result is missing for tool call …"` until the orphan slid out of the recent
  window — five consecutive failures, measured, each a real error the user saw. The store now
  assigns positions itself, under a per-thread lock, inside the transaction that writes the rows.
  Measured against real Postgres, 160 concurrent appends across 40 threads: 9 request errors and
  16/30 orphaned tool calls before, 0 and 0 after — all 40 threads hold exactly 26 messages with no
  gap in `seq`, where message counts previously scattered between 12 and 20.
- **A message batch is now all-or-nothing.** `sqlite` and `postgres` wrote it as a loop of autocommit
  INSERTs, each potentially on a different pooled connection, so a batch of
  `[assistant(tool-call), tool(tool-result)]` could half-commit and orphan the call. Both adapters now
  write the batch in one transaction on one pinned connection. Measured over 900 requests against real
  Postgres: 7 errors (0.78%) and 7 orphaned calls at 96.4 req/s before, 0 and 0 at 99.8 req/s after —
  it is fewer round trips, not more, because the batch travels on one client instead of N checkouts.
- **Importing a transcript alongside a live run is now ordered rather than racing.** The lock was
  taken only when the store had to assign positions, so a caller supplying explicit positions raced
  against one that did not: 20 of 60 turns lost rows. The lock is now taken on every append, whichever
  mode it is in. Note what this does and does not buy: the two writes are serialised, but an explicit
  position that is already occupied is still swallowed by `ON CONFLICT DO NOTHING`, because for
  caller-supplied positions that is the documented idempotent behaviour. The loss is deterministic
  now instead of racy — it is not gone. A large import can also now time out a live turn on the same
  thread (`lock_timeout`, 5s); import into a thread that is not taking turns.

- **`pnpm check:versions` now covers the packages it was waving through.** `@gnldev/auth-ee` is
  `private` but distributed — packed and shipped to customers under licence — so the unconditional
  private exemption let the paid tier sit at a different version from the `@gnldev/auth` it plugs into,
  which is the shared-format mismatch lockstep exists to prevent; a private package that declares
  `files` (a publish-only field) is now in the set. The guard also refuses a prerelease version, because
  `pnpm -r publish` passes no `--tag` and would make `0.2.0-rc.1` the `latest` that every
  `npm i @gnldev/*` installs — deliberate rc pipelines pass `GNL_ALLOW_PRERELEASE=1`, so the decision is
  recorded in the invocation. A malformed `package.json` now names its path instead of dying with a
  stack that named no file.
- **The third-party notices are reachable from the running Studio** (`/THIRD-PARTY-NOTICES.txt`, linked
  in the sidebar). They were generated into `dist/` and served by nothing, so they 404'd — and the
  bundle inlines ~220 packages whose licences, the Geist fonts' OFL-1.1 most explicitly, ask that the
  notice travel with the copy. The generator also excluded `tailwindcss` and `vite` as build-only
  tooling; both in fact write code into the output (preflight into the CSS, the modulepreload polyfill
  into the JS), so both are attributed now.
- **`GET /runs` with any query parameter returned 500** when the host passed `journal:
  new SqliteStorage(…).runs` — which is what the README's own first code block shows. Adapters answer
  `listRuns` with a `Page`; the array bridge was only applied when `storage` was configured, so the raw
  page reached every array-assuming consumer. The same fault took `withOrg(…).listRuns()` down, and
  with it per-org quota accounting. Affected every persistent adapter, not only Postgres.
- **A run that died before its first model step was invisible.** It had written its prompt and a claim
  marker, neither of which the run index recognised, so it appeared in no listing — and, more to the
  point, `sweepRuns` never reached it, leaving that prompt outside every retention window
  indefinitely. Fixed in all five adapters.
- **Sub-agent runs are scoped to their parent.** The nested id was `agent:<toolCallId>`, and a
  toolCallId is unique within one completion rather than across runs — so two unrelated parents whose
  provider minted the same id shared a single nested run, and the second read the first's answer as its
  own. Mainstream providers mint random ids, so this bit on OSS endpoints, proxies, replayed fixtures
  and test harnesses with stable ids.
- **A crash between "the tool ran" and "the stream ended" could run a side effect twice.** The streamed
  model step was journaled in `flush()`, after tool execution, so a resume re-planned and a fresh
  toolCallId slipped past the per-call gate.
- **The write-ahead copy that closes that window no longer works in silence.** It is cut off at the
  tool call — no closing text, no finish reason, no usage — yet a resume replayed it as the turn the
  model had finished, and a journal that rejected the write had its error swallowed, quietly reopening
  the very window the checkpoint exists to close. Both now say so on `console.warn`, naming the run and
  step (once per replayed step, once per stream); replay still happens and the stream is still never
  broken, because re-planning would be the worse outcome.
- **Claim staleness is measured against the shared clock** (`journal.now()`) rather than each worker's
  local one, and against the tool's own declared `timeoutMs` rather than a flat 30s — a tool that
  declared two minutes was being declared crashed at thirty seconds and its side effect run alongside
  itself.
- **A GDPR purge walked past workflow children.** `purgeRun` cascaded into sub-agent runs and stopped
  there, so a parent that had started a workflow as a tool was deleted *around* its child: the
  workflow's journaled step outputs — prompts, tool results, whatever personal data flowed through
  them — stayed behind under a `wf:` namespace nothing would ever sweep again. Both nested id shapes are
  followed now, the parent-scoped one and the bare pre-scoping one. The top-level `wfrun:` run-registry
  record goes with it (it is deliberately not under `<runId>:`, so every prefix delete had been missing
  it, and a purged run kept advertising itself — suspend reason and waitId included — in
  `listWorkflowRuns`). That key ends where the runId ends, so it is deleted neighbour-safely: purging
  `r-1` does not take `r-10`'s record with it.
- **`GET /metrics/runs` contradicted `GET /runs` about the same run.** Observability's metrics table
  served the status off the materialized per-run row, which is written once — the first time a run
  finishes successfully — so a run that succeeded, was re-run and *failed* (or was cancelled) read
  `failed` in the list and `completed` in the table directly below it. Status is served from the
  journal now, where it is derived; cost and tokens stay materialized in the row, which is what the
  fast path exists for. It costs nothing: the handler had already fetched the run list. The row's own
  `status` field is a finalize-time record and is typed as the two values it can actually hold, rather
  than the five it advertised.
- Every documented code sample is typechecked in CI (`pnpm check:docs`), which caught a quickstart that
  had never compiled.
- **`argsHash` collapsed whole classes of argument to one hash, so `idempotency: 'args'` swallowed
  calls that were not duplicates.** `stableStringify` reached values through `JSON.stringify`, which
  enumerates own keys — and `Date`, `Map`, `Set`, `RegExp`, `URL` and `URLSearchParams` have none, so
  every one of them serialized to `{}` and shared a single hash. Two *different* `Date`s therefore
  looked like identical arguments: a durable tool declared `idempotency: 'args'` returned the first
  call's journaled result for the second, which for a billable tool means the second call silently did
  not happen. `URLSearchParams` is the same fault seen from the query-string side — `new
  URLSearchParams('a=1')` and `('a=2')` both hashed as `{}` (measured), so a tool called with two
  different query sets deduplicated into one billable call. `BigInt` was worse still —
  `JSON.stringify` throws on it, so hashing those arguments failed outright. Each type now serializes
  under a NUL-prefixed type tag; `Map`/`Set` members are order-normalized so insertion order does not
  change the hash, while `URLSearchParams` deliberately **preserves** order and duplicate keys
  (`a=1&a=2` and `a=2&a=1` are different query strings, and `URL` already commits to order by hashing
  `href`); a class whose state is reachable only through `toJSON` is no longer flattened to `{}`
  either, because `toJSON` lives on the prototype and the old key-copy dropped it; and caller keys
  that already begin with NUL are escaped so a hand-crafted object cannot forge a tag (that collision
  class did not exist before the tags and is closed with them). Plain JSON hashes are
  **byte-identical** to before, deliberately — see *Breaking* for the key-schema consequence.
- **The same flattening made three `putIfMatch` comparators say "unchanged" about values that had
  changed.** `stableStringify` is not only the idempotency hash: `journal.ts`, `in-memory-storage.ts`
  and `redis-storage.ts` use it as their compare-and-set comparator (the SQL adapters compare
  serialized strings in SQL instead). So a stored record whose `expected` differed *only* in a `Date`,
  `Map`, `Set`, `RegExp`, `URL` or `URLSearchParams` field compared **equal** — `{"at":{}}` on both
  sides, measured — and the CAS returned `true`, overwriting a record that had in fact moved on. That
  is the one failure mode a CAS exists to make impossible, and it was silent. `BigInt` failed the
  other way: the comparator threw rather than returning a verdict. Reachable where such a value
  survives to the comparison — the in-memory journal stores through `structuredClone`, which keeps a
  `Date` a `Date`, and any host calling the `putIfMatch` port directly can pass one; the SQL and Redis
  adapters round-trip through JSON, so a `Date` has already become a string by the time they compare.
  The type tags fix the comparator and the hash in one place, because they are one function.
- **One poison event no longer blocks every event behind it on a topic.** `@gnldev/events` conflated
  "don't move the bookmark past an unacked event" (correct — moving it is silent loss) with "stop the
  pass" (wrong), so a single failing handler halted delivery at its page and everything after it
  waited indefinitely. Measured on real SQLite with 120 events whose 4th always threw: `poll1 = 49`,
  `poll2 = 0`, `poll3 = 0` — events 50–119 were never delivered at all. They were not *lost* (fixing
  the handler released all 120), but nothing recorded that they were stuck. The pass now runs to the
  end of the log while only the persisted bookmark stays parked, and the parked bookmark is finite
  because the failing event is eventually quarantined. Rejected fix: advancing the cursor past the
  failure, which is precisely the silent loss this package refuses.
- **Two entirely reasonable pairs of names made one consumer's events permanently invisible.**
  `@gnldev/events` builds its bookkeeping keys by joining the topic, the consumer name and the event
  id on `:` — which is also an ordinary character in all three (`billing:eu`, `orders:created`, a URN
  as an event id). Measured before the fix: topic `a` + consumer `b:c` and topic `a:b` + consumer `c`
  both produced `evtack:a:b:c:order-42`, so the first consumer's ack marker made the second one's
  event invisible — `poll()` returned 0 forever, `listDeadEvents` came back empty, and nothing was
  logged. Silent, permanent loss of exactly the at-least-once delivery this package exists for, from
  two name pairs that are each entirely sensible on their own. Every component is now escaped before
  it is joined (`:` → `%3A`, `%` → `%25`), which is *injective* — those two sequences are the only way
  a `%` can appear in the output, so a key decomposes back to exactly one triple — and injective is
  the whole requirement. Pinned per key family in `packages/events/test/key-ambiguity.test.ts`.
  **Not `encodeURIComponent`:** it throws `URIError` on a lone surrogate, which a truncated UTF-16
  string yields, and these key builders run inside `poll()`, whose throws `createPollLoop` swallows —
  a key escape would have become a new way to stop the poll loop in silence. This escape is total:
  every string has one. The topic is escaped into the append-log namespace `evt:<topic>` as well —
  defence in depth against exactly the adapter defect below, because `WorkStore` is a public port and
  this package cannot see what key a store derives from a namespace. The persisted-key consequence is
  under *Breaking*.
- **`RedisWorkStore` broke the `WorkStore.list(ns)` contract in both directions, and one half lost
  events with no error.** `list(ns)` is specified on the port as "the records appended under exactly
  this ns" — a whole-value match, which is what the other three adapters do (InMemory keys a Map by
  `ns`; SQLite/Postgres run `WHERE ns = ?`). The Redis adapter has no `ns` column: it stored a record
  at `<pfx>wl:<ns>:<id>` and read a namespace back with a `SCAN MATCH <pfx>wl:<ns>:*` **prefix** scan,
  with `:` unescaped on both sides of the join. Measured on a real Redis 7: reading `evt:orders`
  scanned `wl:evt:orders:*`, which also matches every record of the *separate* namespace
  `evt:orders:eu`, so a consumer of topic `orders` was handed `orders:eu`'s events; and
  `append(ns:'evt:inv:eu', id:'x')` and `append(ns:'evt:inv', id:'eu:x')` both addressed
  `wl:evt:inv:eu:x` — `append` is `SET NX`, first write wins, so the second record was **never
  written while `append` still returned its id**. No dead-letter row, no log line. The namespace is
  escaped now (`encNs`, the same `%3A`/`%25` shape `@gnldev/events` uses — one escape ontology, not
  two), which makes the escaped ns colon-free, so the first `:` after the `wl:` prefix is always the
  ns/id boundary: one namespace ↔ one key space, and no namespace's scan prefix can be another's. This
  is the load-bearing half of the escaping round — it restores the port contract for *every* caller,
  not only for the events package. Pinned in `packages/events/test/log-namespace.test.ts`, against the
  shipped adapter and against a nine-line stand-in for any store that concatenates a key.
- **Two releases of the same dead-lettered event no longer overwrite each other.** `retryDeadEvent`
  read the dead-letter record, stamped it and wrote it back, so two releases landing together — an
  operator double-click, two panels, a retry script racing a human — both read the same record and
  both wrote `releases: n + 1` from it: both returned `true` and the record showed `releases: 1`
  (measured). `releases` is an operator-facing number answering "how many times was this handed back",
  and answering it wrongly is worse than not answering. The write is now a compare-and-swap that
  re-reads and re-applies on top of the winner, so a lost release becomes a *later* release rather
  than a vanished one, and the attempt-counter reset carries the release's own stamp
  (`StoredAttempts.gen`) — without it every reset is byte-identical, and a poll holding the previous
  release's record would win a CAS it should have lost (the ABA case: equal `releases` plus, in the
  same millisecond, equal `releasedAt`). **This adds a third way `retryDeadEvent` returns `false`, and
  it is user-visible contract:** after 5 lost compare-and-swaps in a row it gives up rather than
  clobbering, logs on `console.warn`, and the remedy is to call it again. The other two — never
  quarantined, already delivered — are unchanged, and the record itself tells them apart: an abandoned
  release leaves the event still there and still `quarantined`. Studio surfaces all three as the same
  409, whose text names only the first two.
- **`@gnldev/scheduler` re-fired any trigger whose workflow ran longer than 60 seconds.** The fire lock
  took a fixed 60s TTL and was never renewed, so the lock simply expired underneath a long workflow, a
  second poller took it over and ran the same trigger again — and the late first poller then wrote its
  now-stale state back on top, rolling `fireCount`/`nextRunAt` back and resurrecting `attempts`, which
  set up a third fire. The lock is now renewed every `lockTtlMs / 3` while the workflow is in flight,
  and every state write is a CAS against the record read at the start of the fire, so a poller that
  lost the lock cannot write its result at all. See *Known limits* for what this does not cover.
- **A row an input processor appends behind the turn is no longer written into thread memory — and it
  compounded.** The turn was taken to run to the end of the message array, so a processor that adds
  its own message after the caller's (a compliance reminder, a `[trimmed]` marker, an injected policy
  line) had that row stored as if the user had sent it. Because it was *stored* it came back as
  history and the chain appended a fresh one on top: measured over 10 turns, 30 messages in memory of
  which 10 were the processor's note — a third of the rows, and more than double the characters — and the model saw the
  reminder **once on turn 1 and ten times on turn 10**, which is the same "a per-turn injection
  accumulating in the store" family as the memory leak under *Security*. The turn now ends where the
  caller stopped writing: the note reaches the model exactly once per turn and the thread holds the
  conversation only. The end is located by identity, then by shape, and the caller's own message
  *count* is used only as a **veto** — a narrowed span may never come out shorter than the number of
  messages the caller contributed — so a processor that reorders the turn falls back to the old
  behavior, which over-persists rather than losing caller content. A row inserted *inside* the turn is
  not eliminable the same way — it is indistinguishable from a turn that genuinely contributed that
  many messages — so it is counted instead: `:memctx` gained `chainInserted`, a number, so an operator
  reading the record can tell that a turn carried more rows than the caller sent. `:memctx` gained
  `chainAppended`
  (absent when the chain appended nothing, i.e. every run without input processors): `incomingCount`
  still counts the frozen input's whole trailing block, because that is what regression replay slices
  with, and `chainAppended` says how many of those were the chain's — "what memory holds" is
  `incomingCount - chainAppended`. **Residual, measured and pinned**
  (`packages/durable/test/processor-memory-redaction.test.ts`): one processor that both rewrites every
  message *and* appends destroys identity and changes the shape, so nothing locates the turn's last
  message and the note is persisted with the turn — splitting the same work across two processors
  (redact, then append) is fully tracked.
- **A processor that reorders the turn no longer has its output silently stored as the user's
  question.** Locating the turn fell back, as a last resort, to "the message count did not change, so
  the turn is still where it was" — which is an assumption, not evidence. Measured with one processor
  in two permutations: rotating left happened to leave the turn at the old index (right by luck),
  rotating right put a rewritten copy of the *previous turn's assistant reply* there, and it was
  persisted as the user's message with `incomingCount: 1`, no stamp and no warning. A rule with a
  counter-example in both directions is not a rule, so it is gone; that case now refuses the turn and
  says so. This is a deliberate trade, not a free win: in the permutation that happened to leave the
  turn at its old index the positional guess was *right*, and that turn is now refused instead of
  stored. A guess that is right by luck in one direction and wrong in the other is not something to
  keep for the sake of the cases it wins.
- **A client that sends the conversation with an assistant message last lost the user's question.**
  `dropEchoedHistory` anchored on the final message to decide where the echo of the stored history
  ended. A trailing `assistant` block — a prefill, a regenerate, a tool result being resent — made the
  whole turn read as echo, so the question was dropped, `echoTrimmed` counted it, and nothing warned.
  The anchor now skips a trailing assistant/tool block. Filed here rather than under *Security*: there
  is no reachable data, only a turn that silently failed to persist.
- **Under `prefers-reduced-motion`, four Studio tables stopped being tables.** `Stagger` and
  `StaggerItem` dropped the `as` prop on their reduced-motion branch and returned a bare `<div>`.
  Jobs, Scheduler, Observability and Dead-letter pass `motion.tbody` / `motion.tr`, so with the
  preference on, the DOM became `<table><thead>…</thead><div><div>…</div></div></table>`: the row
  group and every row turned into divs and the `<td>`s lost their row context. An accessibility
  preference was therefore removing the table semantics from the users most likely to be relying on
  them. The element is kept now and only the *animation* is dropped — a motion component with no
  `variants`/`initial`/`animate` emits its plain host element and animates nothing, so the
  reduced-motion promise is unchanged while the markup stays correct. `Spinner` also gained
  `role="status"`, so its label is announced when it appears instead of being a silent DOM change.

### Known limits, stated rather than implied
- **The dead-letter projection bounds a field's SHAPE, not its CONTENT.** Measured after the fix:
  `consumers: ["billing ssn 123-45-6789"]` and `topic: "orders 123-45-6789"` still reach the wire,
  because a `string[]` of names is exactly what the declared type asks for and Studio cannot know what
  a consumer is called in your deployment. What the allowlist stops is a host attaching data it never
  declared — an object, a getter, a `toJSON` — which is the shape every measured leak on these routes
  actually had. A host that writes a secret into a field whose declared purpose is a name is outside
  its reach; that is why the two fields known to carry host data (`error`, `payload`) are gated on the
  `payloads:read` permission instead.
- **Two callers the deployment cannot tell apart cannot be protected from each other.** The scan
  admission budget is per credential, so a deployment with no auth provider, or one where every
  operator shares a single bearer token, still has no fairness between them: measured with 65 attacker
  connections, the operator is served 0 of 20 in both. This is not a bug with a pending fix — a caller
  that picks its own identity mints a fresh one per request, and socket or header identity is either
  forgeable or shared behind a proxy. The answer is an auth provider that returns a stable `id` or
  `credentialId` per caller, which Studio now warns about once per process when it gets neither.
- **An output processor governs `text` and `response.messages` — not every surface the model's words
  reach.** `result.steps` and `result.content` carry the raw output on both entry points, and on the
  stream path so do `textStream` and `fullStream`. Neither is closable without changing what a
  processor *is* (see the `streamDurable` entry under *Security* for the arity and
  already-flushed-delta arguments, and `@gnldev/processors`' `piiRedactor` docs). Thread memory is
  written from the processed messages, so nothing reaches the conversation store unmasked; `content`
  is not persisted at all. What remains is the run journal, which does record the raw step output
  (stated under *Security* too), and anything you hand a client yourself — if `steps`, `content` or a
  delta stream leaves your process, a redactor is not covering it.
- **Cycle detection made the maximum nesting depth `argsHash` can handle lower.** Guarding each
  descent costs a stack frame per level, so a very deep *acyclic* value that hashed before can now end
  in `RangeError: Maximum call stack size exceeded`. The reduction was measured — it is real, not
  theoretical — but no number is quoted, because the ceiling is stack-size dependent and two
  measurements on two hosts disagreed by a wide margin; treat "how deep can this go" as a property of
  the machine, which it always was. No depth cap is imposed on purpose: a cap would
  reject values that hash successfully today, and any number chosen would have to sit below a ceiling
  that is not a contract to begin with. Values a thousand levels deep are not a shape tool arguments
  take; buying unbounded depth means an explicit-stack rewrite of a function whose byte-exact output
  is a journal key.
- **The per-thread lock is cooperative, so a mixed-version window is not protected.** `postgres`
  serialises appends with `pg_advisory_xact_lock`, which constrains only writers that ask for it. A
  pre-0.1.0 process computed positions itself and took no lock at all, so while both versions are live
  against one database, an append from the old one can still collide with an append from the new one
  on a thread they both touch, and one of the two is lost. The production probe does not help here: it
  proves the *server* can serialise appends, not that every *client* is asking it to. Drain in-flight
  runs across that boundary if a thread can be written by two revisions at once.
  Downgrading, by contrast, is data-safe: no column, index or stored format changed, `seq` is the same
  dense integer sequence, and rows written by the new version read identically to the old one. What
  comes back on a rollback is the defect, not a database the older version cannot read.

- **In-flight nested runs do not survive the id-scheme change.** Scoping sub-agent/workflow runIds to
  their parent means a run that crashed MID-nested-work under the old scheme resumes into a fresh
  namespace: completed nested steps re-run, and the old `wf:`-shaped namespace becomes an unsweepable
  orphan. Nothing is published, so this can only affect our own deployments — drain in-flight runs
  before upgrading across this point.
- **The step-0 visibility fix is forward-looking on sqlite/postgres.** Their run index is derived at
  write time and there is no backfill: a run that died before its first step *under an older build*
  stays outside listings and retention on those engines (redis/in-memory derive at read time and
  self-heal). If this matters for a database, `checkSchema`/a manual `:input`-scan backfill is the
  path.
- **A failing or waiting event makes every `@gnldev/events` poll re-scan the topic log.** A consumer's
  persisted bookmark cannot advance past an event that is still retryable — that is what makes a retry
  safe rather than a silent skip — so while one is parked, each poll re-lists from the bookmark to the
  end of the log and does one `get` per already-acked event it passes. Measured (real SQLite, 5 000
  events, one failing event at index 10): an idle poll with the bookmark frozen costs 100 `list` +
  5 004 `get`; once the event is quarantined and the bookmark moves, the same poll costs 1 `list` +
  52 `get` — **~96×**. In wall clock on a 50 000-event log the idle poll goes from ~60 ms to ~10 s.
  It scales with the length of the log, not with the number of events waiting, and on Postgres every
  one of those `get`s is a network round-trip. Two things widen the window: `retryDelayMs` extended it
  from about a second to about **two hours** (the bookmark stays parked for the whole retry schedule,
  not only while the handler is actively failing), and empty-poll backoff does not relieve it on a
  busy topic, because the interval only grows when a poll delivers *nothing* — any successful delivery
  in the same pass resets it to `pollMs`. **This applies on the default path, not only under
  `maxAttempts: Infinity`.** It is not a regression — the old behavior blocked those events entirely —
  but it is a cost that was not previously stated. Lower `maxAttempts`/`retryDelayMs` to quarantine
  sooner, raise `pollMs`, or keep topics short with retention sweeps.

### Changed
- **`MemoryStore.appendMessages` now takes `MessageAppend[]`, and the store assigns `seq`.**
  `MessageAppend` (newly exported) is `Omit<MessageRecord, 'seq'> & { seq?: number }`: omit `seq` — the
  normal case — and the store picks the next positions itself, inside the same transaction that writes
  the rows and serialised per thread. Supply `seq` only to reproduce positions that already have
  meaning (`cloneThread`, transcript import); those rows are written exactly where you say, and
  `(threadId, seq)` stays a CAS key, so writing the same row twice still leaves one copy.
  **If you call it, nothing changes** — `MessageRecord[]` is still assignable, and passing explicit
  positions behaves as it did. **If you implement `MemoryStore`, this needs a code change, and the
  compiler will tell you so**: the member is declared as a property with a function type rather than a
  method, so its parameter is checked contravariantly under `strict`. An implementation still typed
  `rows: MessageRecord[]` fails to compile — `TS2416` on a class method, `TS2322` on an object
  literal — instead of compiling clean and receiving `undefined` at runtime. Widen the parameter to
  `MessageAppend[]`, then read the thread's tail under a per-thread lock and assign from it when
  `seq` is absent.
- **A batch must supply `seq` on every row or on none; a mixed batch throws.** With `[{seq:2}, {}, {}]`
  the store computed `next = MAX(seq)+1 = 2`, the explicit row claimed 2 as well, and one of the two
  was dropped — five rows expected, four stored, *inside* the transaction that is supposed to make
  partial batches impossible. There is no legitimate mixed caller: `AgentMemory.append` supplies none,
  `cloneThread` and transcript import supply all. `assertUniformSeq` is exported so an adapter can
  enforce the same rule with the same message rather than reimplementing it.
- **`ON CONFLICT DO NOTHING` is gone from positions the store assigned.** It is kept for
  caller-supplied positions, where re-writing the same row is the documented idempotent case. On an
  assigned position a conflict cannot happen unless something is wrong, and swallowing it would
  silently drop a message — the exact defect this change exists to remove. It raises now.
- **`postgres` refuses to start against a server without `pg_advisory_xact_lock` when
  `NODE_ENV=production`.** The per-thread lock is what makes concurrent appends safe, and a backend
  that cannot take it loses messages with no error anywhere; shipping that silently is not a trade we
  will make for you. The check runs once per storage instance, from `ensureReady`, outside any
  transaction, and asks the catalog (`to_regprocedure`) rather than calling the function — no lock is
  taken and the server logs nothing. Outside production it warns and continues, which is what test
  doubles need (pg-mem has no advisory locks). **If you run a Postgres-compatible proxy or derivative,
  verify it exposes `pg_advisory_xact_lock(int, int)` before upgrading.** Note that with lazy
  initialisation this surfaces on the first query, not at process start — for a deployment whose first
  query is a health probe, it appears as a failing health check.

- **`@gnldev/ai-sdk` is now `@gnldev/chat-adapter`.** "AI SDK" is Vercel's product name, and a package
  called `@gnldev/ai-sdk` read as if it were that product rather than an adapter for it. The new name
  follows the same function-first convention as `tool-schema`: it says what the package does (bridge a
  durable run to a chat UI). Nothing was ever published under the old name, so nothing breaks; the
  description and keywords keep "Vercel AI SDK" and "useChat" as descriptive search terms.


- `RunSummary.status` is now `'completed' | 'suspended' | 'failed' | 'running' | 'canceled'`. A
  TypeScript `switch` over it with no `default` will stop compiling — deliberately, since the
  alternative is silently mislabelling a failed, unfinished or cancelled run as completed.
- `limits.approvalScope: 'attempt'` (opt-in) spends a human approval on the attempt it unblocks, so a
  later retry asks again instead of proceeding on an answer given about an earlier attempt. The default
  is unchanged: the approval is journaled and survives a crash.
- `sqlite`/`postgres` gained `failed`, `running` and `canceled` columns on `gnl_runs` (materialized at
  write time — not indexed; the status filter is an operator path, not a hot one), migrated on startup
  like `suspended_count`. Journals written before them read exactly as they did before. Three booleans
  for one status is inelegant and known to be: they are only ever written together, from a single
  outcome status in a single statement, so they cannot disagree — collapsing them into one `outcome`
  column is a schema round of its own.
- `GET /ready` now shares one in-flight probe between concurrent requests and reuses a settled answer for
  1s, and warns at most once per 30s. It is unauthenticated, so anyone who could reach the port set how
  often it queried the database and how much it wrote to the log — and against a hanging database each
  request parked its own connection for the full 2s budget. The 2s budget and the responses are unchanged.

- **A circular argument is reported as a `TypeError` naming the path, not a stack overflow.**
  `argsHash({a:{b:selfReferencingObject}})` ended in `RangeError: Maximum call stack size exceeded`
  (measured on both the old and the new code), which reads as *resource exhaustion* and points a
  caller's error handling — and any retry policy wrapped around the tool — at a remedy that cannot
  exist: a cycle has no serialization, not on a retry and not with a bigger stack. It now throws
  `TypeError: @gnldev/durable: circular reference in the value being hashed at $.a.b.self …`, which is
  what `JSON.stringify` reports for the same input and for the same reason. The path matters because
  tool arguments arrive as one large, often model-generated object. A *shared* reference is not a
  cycle and still hashes — `{ x: shared, y: shared }` is ordinary — because the detector tracks only
  the ancestors currently open, not everything it has ever seen. The class change is listed under
  *Breaking*.
- **`retryDelayMs`'s function form has a contract:** it must return a finite number of milliseconds.
  A schedule that throws, or returns `Infinity`/`NaN`/a non-number, falls back to the default for that
  attempt and logs a warning instead of propagating — one consumer's broken schedule is not a reason
  to stop delivering every other event on the topic (a throw used to escape `poll()` and end the pass).
  `Infinity` in particular is not storable: it survives in memory as "never due again", but a
  SQLite/Postgres store round-trips it through JSON to `null` → `0` → due immediately, i.e. the same
  code behaving oppositely per adapter. "Retry forever" is `maxAttempts: Infinity`, not a delay of
  `Infinity`.

<!-- Once v0.1.0 is tagged, this becomes .../compare/v0.1.0...HEAD -->
[Unreleased]: https://github.com/Karaca7/gnl-framework/commits/main
