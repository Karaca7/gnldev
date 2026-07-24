# incident-proofs

A single runnable harness: reproduces 3 documented double-side-effect cases and shows that GNL
blocks each one. Every case has a real `runDurable`/`resumeRun` run behind it — not a claim, but
proof you can read off the console.

## Run
```bash
cd ../.. && pnpm -r build   # build the packages first (workspace links point at dist)
cd examples/incident-proofs
pnpm install
pnpm proofs
```
No API key required — a deterministic mock model is used.

## Cases
| # | Case | Root cause | File |
|---|---|---|---|
| 1 | duplicate-toolcall-ids | the model calls the same tool with the same arguments, in a single turn, 5 times with DIFFERENT toolCallIds | `src/duplicate-toolcall-ids.ts` |
| 2 | checkpoint-resend | a 180s+ tool call is silently resent after a crash-from-checkpoint | `src/checkpoint-resend.ts` |
| 3 | double-approval | the approval event is processed twice, the tool runs twice after approval | `src/double-approval.ts` |

Each file has two runs: **unprotected** (the default/naive path — shows how many times it runs) and
**with GNL** (`idempotency: 'args'`, `runDurable` + resume with the same `runId`, or `resumeRun` — shows
how many times it runs). `src/report.ts` prints both side by side in a table.
