# Contributors

Everyone whose work is in this project, and the record that each of them accepted the
[CLA](./CLA.md) before their first change was merged.

## Why this file exists

The authoritative record of acceptance is the pull request itself: the ticked CLA box lives in the
PR description, tied to a GitHub account, with a timestamp GitHub keeps for the life of the
repository. The `CLA` workflow (`.github/workflows/cla.yml`) fails its check while that box is
unticked, and once the repository is public that check is required before a merge — branch
protection is not enforced on a private repository under a free plan, so until then the check is a
signal the maintainer honours rather than a gate GitHub imposes.

This file is the index over those records. If the project's license ever changes — the CLA permits
it, which is precisely why contributors are asked to read it — the question that has to be answered
is "whose consent do we already hold?". Answering it from one table is possible; answering it by
re-reading every merged pull request is not.

## How a row gets added

The maintainer adds one row when a contributor's **first** pull request is merged. Later
contributions from the same account are already covered — the CLA is accepted once per account,
even though the checkbox is ticked on every PR so that each change carries its own record.

| Contributor | Accepted in | CLA version | Date |
|---|---|---|---|
| [@Karaca7](https://github.com/Karaca7) | original author — holds the copyright in the work that predates any contribution | v1.0 | — |

<!--
Row format for the next entry:

| [@handle](https://github.com/handle) | [#123](https://github.com/Karaca7/gnl-framework/pull/123) | v1.0 | 2026-08-11 |

Add the row in the same commit that merges the PR, or immediately after. If a contributor asks to
have their name removed, the row can go; the acceptance recorded in the pull request cannot, and is
what the grant rests on.
-->
