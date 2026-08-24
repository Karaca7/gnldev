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

## Where the boundary is

gnl is a **backend service**. Your users reach your application; your application reaches gnl. Nothing
here authenticates an end user, and no gnl credential is safe to ship to a browser or a mobile app.

That split decides what a report is about:

| | who owns it |
|---|---|
| Who your end users are, and whether one may act as another | **your application** |
| Keeping one organization's runs, threads and memory away from another's | gnl |
| Keeping one end user's data apart, once your application says whose it is (`resourceId`) | gnl |
| Refusing a credential that reaches beyond its class | gnl |

An application credential (`client`) is trusted to state which of *its own* users a request is for —
that trust is what makes one token able to serve many people. It is sound on your server, where you
have already authenticated the user. Putting that token in a client device, or proxying a
caller-supplied `resourceId` without checking it, hands every user the ability to name any other; that
is a deployment mistake rather than a gnl vulnerability, and it is the one most worth avoiding.

## Scope

In scope: everything in this repository — the durable engine and its journal, the REST server,
Studio, the auth providers, the CLI, and the MCP/A2A surfaces.

Particularly interesting, because they are the guarantees the framework sells:

- **Durability** — anything that makes a journal replay diverge, double-charge a step, or lose a
  committed record
- **Isolation** — anything that lets one organization observe or affect another's runs, threads,
  or memory; or, within one organization, anything that lets a credential reach an end user's data
  after naming a different one
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
