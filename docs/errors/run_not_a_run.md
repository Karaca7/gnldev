# run_not_a_run

**HTTP 409 · operator console**

## What happened

You asked the console to purge a run, and the id you named is not a run. It is a row in the run
index that no run ever wrote — so the purge was refused before it deleted anything.

The row is real. It lists in `GET /runs` like any other run, usually as `completed` with one model
step, which is why the delete control was reachable at all. What it does not have is
`<id>:input` — the record a run writes before its first model call, unconditionally, for every run.

## Why the framework can't guess

A run's keys are found by prefix: everything under `<runId>:` belongs to that run, and purging it is
one `deletePrefix`. The index is derived from key shape — `parseJournalKey` claims any key with a
`:model:` or `:tool:` segment, whatever namespace it started in.

A caller-supplied id can put those words in a middle segment. A thread named `model` produces
`mem:model:working`, which reads as a run called `mem`; an organization named `tool` produces
`org:tool:…`, which reads as a run called `org`. Purging that "run" by prefix would delete the whole
`mem:` or `org:` keyspace — every thread, every organization, not one run.

Measured on Postgres, Redis and SQLite: one such id, one purge, and two unrelated users' threads
were gone.

The answer is 409 rather than 404 deliberately. The row is there and you can see it listed;
answering "not found" about something on your screen would be its own kind of lie.

## What to do

- Run `gnl doctor`. It lists every run row that no run wrote, and prints the keys that sit under
  each prefix — so you can see whose data the purge would have taken.
- Leave the row alone. It is inert: the retention sweep already refuses it too (`skippedGhosts` in
  the sweep result), so nothing deletes those keys on a schedule.
- Find the id that made it. The row is named after a keyspace (`mem`, `xthr`, `org`), and the id
  that minted it is the segment after that prefix — a thread, resource or organization literally
  named `model` or `tool`. Renaming it stops new rows appearing; the existing row stays until the
  keys under it are removed through their own surface (`purgeThread`, `purgeResource`).
- If the data under that prefix really should go, delete it by its own identity — the thread or the
  resource — not by the run id the index invented.
