# A protected GNL in five minutes

Not "a running GNL". Running takes one command and proves nothing. This page ends with you having
**watched a duplicate get refused**, and knowing which protections are on, which are off, and what
each of the off ones costs.

---

## 1. One command

```bash
npx @gnldev/cli init my-agent --yes && cd my-agent && pnpm install
```

`--yes` takes the recommended answers. Drop it and you get one gate question and at most four more —
[what they are and why only four](#appendix-the-four-questions).

No API key. The starter ships a mock model, so everything below happens on your machine.

## 2. Read what you got

The last thing `init` prints is a matrix, and it is worth ten seconds:

```text
what is protecting it   ✓ on · ○ off · ─ dev-only · ? per-call
  ✓ journal          SqliteStorage                         explicit
  ✓ dedup profile    assistant                             explicit
      a human is on screen: money/notification repeats ask, idempotent writes stay silent
  ○ identity         not bound — runs are born ownerless   explicit
  ? work identity    per call: a workKey names it, or a raw runId is it
  ○ thread gate      no memory — threadId carries nothing  default
  ○ retention        not wired                             default
```

(Abbreviated. `gnl doctor` prints the full thing, any time, from the config as it actually loads.)

The `?` row is not a gap: whether a call names its work (`workKey`, and the engine derives the run's
id from it) or hands over a raw `runId` is decided per request, so no config can answer it. What is
worth carrying away is the one sentence attached to it — **a `workKey` is recognised only for as long
as the run record it opened still lives**, which is why the `○ retention` row two lines down is not a
housekeeping setting. One more sentence in the same spirit: the agent's **name** and its `workScope`
are part of the work's identity — renaming an agent (or switching its scope) on a live system starts
a new identity for its unfinished work, so retries of in-flight `workKey`s land on fresh runs while
the old ones stay suspended. Do it behind a drain, not mid-traffic.

The rows are **computed from your config**, not recited. That distinction is the whole reason this
screen exists: an earlier version of this CLI printed "(auth: protected)" whenever an auth provider
existed — including when that provider's only credential was a token published in the npm tarball.
A list of protections maintained next to the thing it describes says whatever it last said.

## 3. Ask for the same thing twice

This is the part that is worth the five minutes.

```bash
gnl dev
```

Open <http://localhost:3000/studio>, pick the `assistant` agent, and send a message. Then send **the
exact same message again**.

With `preset: 'assistant'`, a repeated side effect does not silently happen twice and does not
silently get swallowed — it becomes **a question**. The second attempt suspends and waits for
somebody to say whether they meant it.

Then look at what was recorded:

```bash
gnl run <runId>      # the timeline: the tool call, and the decision taken about the repeat
gnl doctor           # "time to first protected run" — now a real number instead of "never"
```

That number is the only honest measure of whether any of this is wired up. A profile that has never
declined anything looks, from the config alone, exactly like one wired to nothing.

## 4. The three ○ rows, one command each

Each row that is off is off for a reason, and each has one thing to do about it.

**`○ thread gate` — conversations do not remember.**

```bash
gnl add memory
```

Writes `src/memory.ts`; uncomment `memoryFactory` in `gnl.config.ts`. Without it a `threadId` is a
label, not a boundary — the engine warns once per process when it is handed one with nowhere to put
it.

**`○ retention` — nothing is ever deleted.**

```bash
gnl sweep --older-than 30d        # dry-run by default; --yes to actually delete
```

Nothing sweeps on its own, deliberately. A run holds the prompt it was given, indefinitely, until a
human or a cron entry runs this. Put it on a schedule; the window has to be **longer than your
clients' retry horizon**, or a late retry meets a swept run
([`run_swept`](./errors/run_swept.md)).

**`○ identity` — runs are born with no owner.**

```bash
gnl init my-agent --identity end-users     # for a new project: writes src/identity.ts
```

This is the only row that is genuinely expensive to change later: a journal full of runs that were
born ownerless cannot be retro-fitted with an owner, because nothing recorded who they were for.
For an existing project, write `src/identity.ts` yourself — the resolver is about fifteen lines, and
the one wrong answer is worth stating out loud:

```
// NEVER: const resourceId = (await req.json()).resourceId;
```

A subject read out of the request body is the caller naming whoever they like. Read it from something
the server established: a verified session, a checked JWT, `principalOf(req)?.id`.

## 5. Before you deploy: the `─` row

Run `gnl dev` again and look for a `─` in the matrix:

```text
  ─ thread gate      memory derived from storage           default
      memory is on HERE (gnl dev) and off in src/app.ts — `gnl add memory`
```

`─` means **this process turned it on and your deployment will not have it**. `gnl dev` derives a
memory store from `storage` so the Playground has threads; `src/app.ts` — the file you actually
deploy — does not. Same config, two behaviours: conversations remember on your machine and quietly
forget in production.

Every `─` is that shape. It is the one mark on this screen you should never ship.

---

## Appendix: the four questions

`gnl init` asks about exactly four things, because these are the decisions a project cannot discover
by reading its own code and cannot cheaply change later:

| Question | Flag | Why it is not a default |
| --- | --- | --- |
| If the same work arrives twice, what should happen? | `--preset assistant\|headless\|critical` | A tool's `effectClass` is read **only** through a profile. Pick wrong and every declaration in the project is inert, silently. |
| Who does each run belong to? | `--identity internal\|end-users` | Ownership cannot be added to runs that were born without it. |
| Where should the record of every run be kept? | `--store sqlite\|pg` | One line apart on day one, a migration on day ninety. |
| How will people reach this? | `--serving dev\|own\|mount` | `gnl dev` serves everything while you build, so "not yet" is a real answer — and the same one a worker or cron process keeps. The other two write files, and which files differs: `own` gets `src/server.ts`, `mount` gets the lines for the server you already have (`--host` names the framework). |

Any flag you pass **answers** its question, so it is not asked. `--yes`, or no terminal at all (CI, an
agent), takes the defaults and never blocks.

Features are deliberately **not** questions: `gnl add <feature>` adds them the day you need them, and
a project that skipped them lost nothing. The server entry was in that category once and moved out —
see the fourth row: the FILES are additive, but "I already have a server" and "I am a worker with no
server" are answers nobody could express, so the command guessed for them.

---

## Where to go next

- **[The guide](./GUIDE.md)** — every layer, in order, with the failure each one exists for.
- **[Error codes](./errors/README.md)** — one page per code on the wire: what happened, why, what to do.
- **[`@gnldev/durable`](../packages/durable/README.md)** — the dedup ladder itself: hash, claim, confirm, critical, semantic.
