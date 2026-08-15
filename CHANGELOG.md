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
  `connect-src 'self'` means injected code cannot post the token anywhere.

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
- **Claim staleness is measured against the shared clock** (`journal.now()`) rather than each worker's
  local one, and against the tool's own declared `timeoutMs` rather than a flat 30s — a tool that
  declared two minutes was being declared crashed at thirty seconds and its side effect run alongside
  itself.
- Every documented code sample is typechecked in CI (`pnpm check:docs`), which caught a quickstart that
  had never compiled.

### Known limits, stated rather than implied

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
- **Workflow (`wf:`) children are not part of the purge cascade** — a pre-existing gap the audit
  surfaced: purging a parent run does not purge a workflow-as-tool child's journal. On the backlog.

### Changed

- `RunSummary.status` is now `'completed' | 'suspended' | 'failed' | 'running'`. A TypeScript `switch`
  over it with no `default` will stop compiling — deliberately, since the alternative is silently
  mislabelling a failed or unfinished run as completed.
- `limits.approvalScope: 'attempt'` (opt-in) spends a human approval on the attempt it unblocks, so a
  later retry asks again instead of proceeding on an answer given about an earlier attempt. The default
  is unchanged: the approval is journaled and survives a crash.
- `sqlite`/`postgres` gained `failed` and `running` columns on `gnl_runs` (materialized at write time —
  not indexed; the status filter is an operator path, not a hot one), migrated on startup like
  `suspended_count`. Journals written before them read exactly as they did before.

<!-- Once v0.1.0 is tagged, this becomes .../compare/v0.1.0...HEAD -->
[Unreleased]: https://github.com/Karaca7/gnl-framework/commits/main
