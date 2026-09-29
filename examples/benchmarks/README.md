# Benchmarks

The measurements quoted on [gnl.dev](https://gnl.dev) and in the package READMEs, with the scripts
that produced them and the raw results. If a number on the site links here, this is where you can
check it — and rerun it.

| Benchmark | What it measures | Needs | Command |
|---|---|---|---|
| [Re-emission](#re-emission) | How often a real model re-emits an earlier tool call, and whether the duplicate layer catches it | NVIDIA API key, Postgres | `pnpm re-emission` |
| [Scale](#scale) | Journal cost of the duplicate layer as a thread grows to 2 000 records | Postgres | `pnpm scale` |

Setup, from the repository root: `pnpm install && pnpm -r build`, then `cd examples/benchmarks`.

## Re-emission

**Question:** in realistic conversation traffic, does the duplicate layer ask when it should, stay
silent when it should — and how often does the *model* produce a duplicate side effect on its own?

**Method.** 40 synthetic scenarios, 144 turns of realistic Turkish operations requests
([`data/re-emission/scenarios.json`](./data/re-emission/scenarios.json)). Every turn carries a
ground-truth label: `new` (should not ask), `repeat-of:N` (should ask), `near-new:N` (looks similar,
is different work). Each turn goes to a real model (`nemotron-3-super-120b-a12b` on NVIDIA NIM), which
writes the tool call and its arguments itself; a real embedder, the rule ladder and a judge model
(`gpt-oss-20b`) decide; everything is journaled to real Postgres. The prompt and tool descriptions are
Turkish because the scenarios are — they are the exact inputs of the recorded run.

**Result of the recorded run (2026-09-08)** — [`results/re-emission/`](./results/re-emission/):

| | |
|---|---|
| Turns / turns where the model called a tool | 144 / 126 (on 18 the model called no tool — a provider error or a text-only reply; the report does not record which) |
| Questions raised | 47 |
| Real repeats caught | 31 of 34 |
| **Model re-emitted an earlier call, byte-identical, on a turn that asked for new work** | **13** |
| False alarms | 3 (all from a tool schema missing the field that told the jobs apart) |
| Judge calls | 12 (0.10 per guarded call), none produced a question |

The 13 are the headline: the user asked for something new, and the model emitted the previous turn's
call again — same invoice, same order, same arguments. Without a duplicate layer each is a second
side effect nobody asked for, and no amount of care in how the user writes prevents it.

Reproduce the table from the raw result, no network needed: `pnpm re-emission:tally`.

**Limits.** Approvals are simulated, so this does not measure precision@suspend (what a real human
answers). The judge certificate in `run.ts` is hand-filled, not a committed qualification result —
qualify your own judge with `npx gnl-semantic-qualify` before trusting the judge numbers. The scenarios are synthetic. One model: another tool-calling model may re-emit more or less.

## Scale

Measured on 2026-09-06; the figures are in
[`packages/durable/README.md`](../../packages/durable/README.md#scale-characteristics-measured).
Exact dedup is a point read; semantic recall is linear in the side-effect records of *one thread*,
not in users or total volume.

The semantic recall step is not exported, so the script reproduces its cost profile (list keys, read
each record, decode a 2048-dim vector, cosine) instead of calling it. Embeddings are fake and
deterministic, so API latency does not pollute the journal cost.
