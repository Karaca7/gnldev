# Contributing to gnl-framework

Thanks for considering a contribution.

## Before your first pull request

This project requires a **Contributor License Agreement (CLA)** — see [CLA.md](./CLA.md) for the
full text and why it exists (short version: it lets the license evolve later without having to
track down every past contributor for consent).

Accepting it is a single checkbox: the pull request template includes a line confirming you have
read and agree to the CLA. Tick it in your first PR and you're done — it carries over to your later
contributions, so it's a one-time step per GitHub account. The CLA check has to pass before a pull
request is reviewed.

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
