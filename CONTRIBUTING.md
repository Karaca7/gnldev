# Contributing to gnl-framework

Thanks for considering a contribution.

## Before your first pull request

This project requires a **Contributor License Agreement (CLA)** — see [CLA.md](./CLA.md) for the
full text. The short version, stated plainly because the detail is the part that matters: it lets
the Maintainer relicense your contribution under any terms — including source-available or
proprietary ones — without tracking down every past contributor for consent. If that is not
acceptable to you, this is the right moment to know it. What the CLA does NOT do: it asks for no
indemnity, and you keep every right to your own work.

Accepting it is a single checkbox: the pull request template includes a line confirming you have
read and agree to the CLA. Tick it in every pull request: the check reads the PR body each time (it runs on `opened`, `edited`,
`reopened` and `synchronize`), so it is a per-PR line rather than a one-time registration. Reading
the CLA is the one-time part. The check has to pass before a pull request is reviewed.

## Using an AI assistant

You may. Much of this repository was written with one, and the commits say so — there is nothing to
hide and nothing to declare.

What does not change is who signs. The CLA asks you to state that the work is yours to give and that
you know of no third-party claim on it; a tool cannot make that statement, and a generator can
reproduce code it was trained on. So ticking the box means the same thing either way: **you read
what you are submitting and you stand behind it.**

Two practical consequences:

- Open the pull request from your own account. If a machine account opened it, add a comment saying
  `I, @your-handle, accept the CLA, v1.1 for this contribution.` — otherwise it is not merged.
- Review the diff before you send it, in the ordinary sense: you should be able to answer "why is
  this line here?" for every line. A change nobody can explain costs a reviewer more than it saves a
  contributor, which is the whole reason this paragraph exists rather than a ban.

(`dependabot`, `renovate` and `github-actions` are exempt from the check by name: a version bump is
not original work, so there is nothing to license. That exemption is for dependency bots only —
see [CLA.md](./CLA.md#machine-accounts-and-why-a-person-still-signs).)

## About this repository's history

The first commit here is a snapshot. Development happens in a private monorepo that also holds
work not part of this project — a commercial tier, internal audits, unrelated experiments — so
what is published is the subset that makes up the framework, taken at a point in time rather than
replayed commit by commit.

Two things follow, and both are the point of saying this out loud. The history above the first
commit is not missing, it is simply not this repository's; and everything below it is real —
every commit from here on is the actual change that was made, with the reasoning that produced it.

## Provenance commitment

Before every major version release, an independent-development audit is re-run — this codebase is
compared against prior art in the space by verbatim-overlap and distinctive-string-literal analysis,
and the result is kept on file. The report itself is not published; it names third-party codebases
and there is no reason to broadcast that. It can be produced if the question is ever put seriously.

## Working in this repo

```bash
pnpm install
pnpm -r build
pnpm -r typecheck
pnpm test
pnpm check:docs      # every code sample in the docs is compiled against the built packages
pnpm check:versions  # the published packages must stay in lockstep (see VERSIONING.md)
```

All of these must pass before a PR is reviewed. See [docs/GUIDE.md](./docs/GUIDE.md) for the
architecture walkthrough. Releases are cut by the maintainer from CI, so there is nothing a
contributor needs to run for one.

**If your change is user-visible, add a line to `[Unreleased]` in
[CHANGELOG.md](./CHANGELOG.md).** Anything that breaks goes under `Breaking`, written as an
instruction ("add `--host 0.0.0.0` if you run in a container") rather than a description of what
changed. [VERSIONING.md](./VERSIONING.md) has the test for what counts as breaking — it is behavioural,
not "did a type change".

## Reporting issues

Open a GitHub issue. For anything security-sensitive, please don't open a public issue — see the
repository's security policy instead.
