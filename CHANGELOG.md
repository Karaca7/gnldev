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

### Fixed
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

### Known limits, stated rather than implied
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

<!-- Once v0.1.0 is tagged, this becomes .../compare/v0.1.0...HEAD -->
[Unreleased]: https://github.com/Karaca7/gnl-framework/commits/main
