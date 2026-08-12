# Security Policy

## Reporting a vulnerability

Please do **not** open a public issue for a security problem.

Report it through GitHub's private vulnerability reporting instead:

1. Go to the [Security tab](https://github.com/Karaca7/gnl-framework/security) of this repository
2. Click **Report a vulnerability**

That opens a private thread visible only to you and the maintainer. It needs no email exchange and
no account beyond the GitHub one you already have.

## What to include

The more of this you can provide, the faster it gets fixed:

- Which package and version (`@gnldev/durable`, `@gnldev/server`, …)
- What an attacker can do — read another organization's runs, replay a charged step, bypass an
  approval gate, escape a tool's sandbox
- A minimal reproduction: a config, a run, or a failing test is ideal
- Whether it needs authentication, and at what privilege level

## Scope

In scope: everything in this repository — the durable engine and its journal, the REST server,
Studio, the auth providers, the CLI, and the MCP/A2A surfaces.

Particularly interesting, because they are the guarantees the framework sells:

- **Durability** — anything that makes a journal replay diverge, double-charge a step, or lose a
  committed record
- **Isolation** — anything that lets one organization observe or affect another's runs, threads,
  or memory
- **Approval gates** — anything that executes a tool call that was interrupted for approval, or
  that was explicitly rejected

Out of scope: vulnerabilities in dependencies (report those upstream), findings that require
already having the operator's credentials or filesystem access, and reports from automated scanners
without a demonstrated impact.

## Response

You will get a first response within a week. If a report is confirmed, the fix and the advisory are
published together through GitHub Security Advisories, and you are credited unless you prefer not
to be.

This project is maintained by one person. Serious reports are taken seriously, but please calibrate
your expectations on response speed accordingly — there is no on-call rotation behind this.
