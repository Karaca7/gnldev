# Versioning

## Where the version lives

Every published `@gnldev/*` package (plus `create-gnl`) moves in **lockstep**: one version number for
all of them, bumped together, released together.

This is a deliberate trade. Independent versions let a package that did not change keep its old number,
which is tidier — and it makes the compatibility question ("does `@gnldev/server@0.4` work with
`@gnldev/durable@0.2`?") a real question that someone has to answer, for every pair, forever. These
packages share a journal format, a status vocabulary and a set of internal key schemas; a mismatched
pair fails in ways that look like data corruption rather than like a version conflict. Lockstep makes
the answer "the numbers match" and costs nothing but some no-op version bumps.

So: install them at the same version. `pnpm up "@gnldev/*"` upgrades the set.

## What the numbers mean

The project is at **0.x**, and 0.x in semver means *anything may change*. That is technically true and
practically useless, so here is what we actually do:

| Change | Bump |
|---|---|
| Breaking: an API is removed, renamed, or behaves differently in a way that requires you to edit code or configuration | **minor** (`0.1.0` → `0.2.0`) |
| Additive: new API, new option, new capability — existing code keeps working | **patch** (`0.1.0` → `0.1.1`) |
| Fixes, performance, docs, internals | **patch** |

When 1.0 arrives this becomes ordinary semver (breaking → major). Until then, **read the changelog
before a minor bump**; that is where the migration notes are.

## What counts as breaking

Not everything that changes a type is a break in practice, and not every break changes a type. The
tests for it are behavioural:

**Breaking** — you may have to change something:

- Removing or renaming an exported function, type, option or route.
- Changing a default in a way that alters what a running deployment does. *(Example: `gnl dev` binding
  loopback instead of every interface. No API changed; a container setup stops working.)*
- Adding a value to a union that code is expected to handle exhaustively. *(Example: `RunStatus`
  gaining `'failed'`. A TypeScript `switch` with no default now fails to compile — which is the point:
  we would rather you were told than silently mislabel a failed run.)*
- Changing a persisted key schema, or the meaning of a stored field.
- Tightening validation so an input that used to be accepted is now rejected.

**Not breaking** — additive:

- New exports, new optional fields, new routes, new adapter capabilities.
- New *optional* database columns that migrate themselves, where the pre-migration state stays readable.
  *(Adapters do this: a journal written before a column existed reads exactly as it did before.)*
- Warnings, log output, error *messages* (the error `code`/`name`/class is the contract; the prose is
  not).

## Storage compatibility

The journal is append-only and forward-compatible on purpose: a record written by an older version
stays readable, and a missing field means "the old behaviour", never "throw". Adapters add columns via
`ALTER TABLE … IF NOT EXISTS`-style migrations at startup, and `checkSchema()` / `migrateSchema()`
exist for deployments that would rather migrate out of band than have a process do it on boot.

**Downgrades are not supported.** Data written by a newer version may carry fields an older one does not
know, and while it will typically ignore them, we do not test that direction and will not fix it.

## Deprecation

Anything scheduled for removal keeps working for at least one minor release, warns at runtime when it
is used, and is listed under `Deprecated` in the changelog with the replacement named. Nothing is
removed in a patch.

## Security fixes

Released as a patch on the current minor, listed under `Security` in the changelog with the impact
stated plainly — what an attacker could reach, not just that something was hardened. There is no
backport window while the project is 0.x: upgrade to the current version.

## Release checklist

1. `pnpm -r build && pnpm -r typecheck && pnpm test && pnpm check:docs` — all green.
2. Move `[Unreleased]` in `CHANGELOG.md` to the new version, dated. Migration notes go under
   `Breaking`, written as instructions, not descriptions.
3. Bump every package to the same version.
4. Tag `v<version>`.
5. Publish. Then verify the published tarballs actually install — `pnpm pack` output, not `link:`,
   because a workspace link hides missing `files` entries and unlisted dependencies.
