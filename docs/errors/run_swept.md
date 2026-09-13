# run_swept

**HTTP 409 · no `resumable`**

## What happened

This `runId` was deleted by a retention sweep, and a late retry arrived afterwards. A `${runId}:swept`
tombstone records that it existed; the journal records that would have deduplicated this retry are
gone.

This refusal is part of the `critical` profile (`tombstonePolicy: 'reject'`). By default the policy is
`ignore` and a swept runId simply runs again. **On an engine-derived (`run1_`) id the refusal does not
wait for a profile**: that id was minted from a `workKey`, so the caller never chose it and cannot
choose a different one — see "For this particular request" below.

**What the tombstone keeps, and what it deliberately does not.** A swept run leaves behind its sweep
instant, its `workScope` kind, and a **hash** of its `workKey` — never the key itself. The key is a
business name and frequently personal data; reading it back out of storage to put in an error body
would undo the deletion that just happened. So `detail.workKeyHash` is what you get from the run, and
the workKey in the response is the one **your request sent** — reflected back, not recovered. If the
two are the same job, the hashes match.

## Why

Retention deletes a run's journal entries — and a run's journal entries *are* its dedup state. Once
they are gone, re-running the same id is not a replay: it is a first execution that repeats every side
effect the deleted records used to suppress.

`ignore` and `reject` are two honest answers to that, and which one is right depends on what the run
does. `reject` refuses rather than repeat; the caller learns the request is too old instead of being
charged twice.

## What to do

**Fix the window, not the run.** The real contract is:

> retention window ≥ client retry horizon

If a client may retry for 7 days, a 24-hour sweep will keep producing this. Either sweep less
aggressively or shorten the retry horizon:

```bash
gnl sweep --older-than 30d        # dry-run by default; --yes to delete
```

**For this particular request**, start it under a new `runId`. It is a new execution either way — the
only question the tombstone answers is whether you find that out here or in your ledger.

**If you sent a `workKey` rather than a runId**, "use a fresh runId" is not advice you can act on:
the id is derived, and the same four inputs will keep producing the same dead id. Name the work
differently — the `workKey` is the half you own. Before you do, check the external system: the
sweep removed the record that would have told you whether the effects already happened, which is the
entire reason this refusal exists.

**If repeating is genuinely safe**, `tombstonePolicy: 'ignore'` is the default for exactly that case,
and a per-call `RunOptions.tombstonePolicy` overrides the profile.

`detail.sweptAt` says when the run was removed.
