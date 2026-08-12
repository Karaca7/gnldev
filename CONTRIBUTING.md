# Contributing to gnl-framework

Thanks for considering a contribution.

## Before your first pull request

This project requires a **Contributor License Agreement (CLA)** — see [CLA.md](./CLA.md) for the
full text and why it exists (short version: it lets the license evolve later without having to
track down every past contributor for consent).

Accepting it is a single checkbox: the pull request template includes a line confirming you have
read and agree to the CLA. Tick it in your first PR and you're done — it carries over to your later
contributions, so it's a one-time step per GitHub account. A PR can't be merged with it unticked.

## Provenance commitment

Before every major version release, we re-run an independent-development audit — comparing this
codebase against prior art in the space using verbatim-overlap and distinctive-string-literal
methods — to keep the project's provenance record current.

## Working in this repo

```bash
pnpm install
pnpm -r build
pnpm -r typecheck
pnpm test
```

All four must pass before a PR is reviewed. See [docs/GUIDE.md](./docs/GUIDE.md) for the
architecture walkthrough and [docs/RELEASE.md](./docs/RELEASE.md) for the release process.

## Reporting issues

Open a GitHub issue. For anything security-sensitive, please don't open a public issue — see the
repository's security policy instead.
