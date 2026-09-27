// A REFUSAL is not a failure — and the list that says so was missing four of the eight.
//
// `classifyRunError` decides whether a thrown error ends the run as `failed`. Refusals that the
// CALLER caused — a conflicting input, a stranger's actor, a swept id, a changed batch plan — are not
// the run failing; the run was never re-entered. `NOT_A_RUN_FAILURE` listed six names, and two of the
// four it missed are reachable from the edge:
//
//   measured, 0.6.0: a completed run, re-driven with a different prompt → 409 run_input_mismatch
//   (the guard worked), and the victim's row flipped `completed` → `failed`. `gnl run <id>` still
//   said completed; `gnl runs`, `gnl runs --status failed`, and Studio said failed. Anyone who can
//   spell a live run's id — and for a `workKey` the digest is computable — could mark somebody
//   else's finished run failed, by being refused.
//
// The list is matched by NAME because importing the error classes here would be a cycle — but that
// is only true of `run.ts`'s side of the graph. `errors.ts` imports NOTHING, and this file already
// imports `RunBusyError` from it, so `CALLER_CONFLICT_CODES` is reachable and is the same set by
// construction: every entry in it is, by definition, a conflict the caller caused.
//
// The first test below is the invariant; the two after it are the reachable symptoms. A new
// caller-conflict error added to the table is covered by the first without anyone remembering this file.
import { describe, it, expect } from 'vitest';
import { runDurable, InMemoryJournal, listRunsArray, CALLER_CONFLICT_CODES } from '../src/index.js';
import { classifyRunError } from '../src/outcome.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const model = {
  specificationVersion: 'v2', provider: 'scripted', modelId: 'm', supportedUrls: {},
  doStream: async () => { throw new Error('gen-only'); },
  doGenerate: async () => ({ content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage, warnings: [] }),
} as any;

const statusOf = async (j: any, runId: string) =>
  (await listRunsArray(j)).find((r) => r.runId === runId)?.status;

describe('a caller conflict is not a run failure', () => {
  it('EVERY error in CALLER_CONFLICT_CODES classifies as not-a-failure', () => {
    // The invariant, not the two instances. The table names the errors the CALLER caused; none of
    // them is the run failing. A name added to the table and forgotten here is what this catches.
    const wrong = Object.keys(CALLER_CONFLICT_CODES)
      .filter((name) => classifyRunError({ name } as Error) === 'failure');
    expect(wrong,
      'a caller-conflict error is being recorded as a run FAILURE — it overwrites the owner\'s outcome')
      .toEqual([]);
  });

  it('a refused re-drive with different input leaves the finished run completed', async () => {
    const j = new InMemoryJournal();
    await runDurable({ journal: j, runId: 'r1', model, prompt: 'A', strictInput: true } as any);
    expect(await statusOf(j, 'r1')).toBe('completed');

    await expect(
      runDurable({ journal: j, runId: 'r1', model, prompt: 'B', strictInput: true } as any),
    ).rejects.toThrow();

    expect(await statusOf(j, 'r1'),
      'the refusal rewrote the owner\'s outcome — being denied edited the run it was denied from')
      .toBe('completed');
  });

  it('the refusal is still a refusal — the second input never ran', async () => {
    // The control: the fix must not turn the guard off. Only ONE model answer is in the journal.
    const j = new InMemoryJournal();
    await runDurable({ journal: j, runId: 'r2', model, prompt: 'A', strictInput: true } as any);
    await expect(
      runDurable({ journal: j, runId: 'r2', model, prompt: 'B', strictInput: true } as any),
    ).rejects.toThrow();
    const rows = await listRunsArray(j);
    expect(rows.filter((r) => r.runId === 'r2')).toHaveLength(1);
  });
});
