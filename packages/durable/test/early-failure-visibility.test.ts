// A run that dies before its first model step used to leave no trace an operator could act on.
//
// The adapters derived their run index from `parseJournalKey`, which by design only recognises the two
// REPLAYABLE kinds (`:model:`, `:tool:`). Every other run-scoped key — `:input`, `:proc:`, `:cfg:`,
// `:approval:` — is invisible to it, on purpose: readRun/reconstructState/time-travel must not replay
// them. But "not a replayable entry" is not "not part of a run", and conflating the two meant a run
// killed at step 0 (an upstream 401, a guard rejection, a limit tripped before the first token) had
// written its prompt to disk and then vanished from:
//
//   listRuns / `gnl runs` / studio  → the operator cannot see the failure at all
//   sweepRuns                       → and this is the one that costs something: the persisted prompt
//                                     sits outside every retention window, indefinitely
//
// runIdOfKey answers the ownership question separately from the entry question, so the run appears in
// the index with genuinely zero entries — readRun and time-travel are untouched.
import { describe, it, expect } from 'vitest';
import { newDb } from 'pg-mem';
import { runDurable, sweepRuns, InMemoryStorage, InMemoryJournal, runIdOfKey, listRunsArray } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { RedisStorage } from '../src/index.js';
import { makeFakeRedis } from './fake-redis.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const base = { specificationVersion: 'v2', provider: 'scripted', modelId: 'm', supportedUrls: {} };
const good = { ...base, doGenerate: async () => ({ content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage, warnings: [] }), doStream: async () => { throw new Error('gen-only'); } } as any;
/** The provider rejects the very first call — nothing is ever journaled as an entry. */
const dead = { ...base, doGenerate: async () => { throw new Error('401 invalid api key'); }, doStream: async () => { throw new Error('gen-only'); } } as any;

async function seed(journal: any) {
  await runDurable({ runId: 'lived', journal, model: good, prompt: 'hello' } as any);
  await runDurable({ runId: 'died-at-step-0', journal, model: dead, prompt: 'my secret prompt' } as any)
    .catch(() => { /* the run really does fail */ });
}

describe('runIdOfKey', () => {
  it('claims every run-scoped key family, and nothing else', () => {
    expect(runIdOfKey('r1:input')).toBe('r1');
    expect(runIdOfKey('r1:memctx')).toBe('r1');
    expect(runIdOfKey('r1:model:0')).toBe('r1');
    expect(runIdOfKey('r1:tool:call-1')).toBe('r1');
    // A runId may contain ':' — resolve it the same greedy way parseJournalKey does.
    expect(runIdOfKey('agent:parent:call-1:input')).toBe('agent:parent:call-1');
    // Keys that belong to no run keep returning null: queues, events, cache, cross-run dedupe.
    expect(runIdOfKey('qdone:worker1:job-3')).toBeNull();
    expect(runIdOfKey('mem-user-appended:r1')).toBeNull();
    expect(runIdOfKey('xrun:args-charge-abc')).toBeNull();
  });

  it('refuses the three-segment families, because claiming one can DELETE a foreign namespace', () => {
    // A claimed key puts its "run" in the index, and sweepRuns purges an indexed run by `${runId}:`
    // Prefix. Had `:proc:` been accepted, a memory thread named 'proc' would make `mem:proc:messages`
    // Read as run 'mem' — and one sweep would erase the entire memory keyspace.
    expect(runIdOfKey('mem:proc:messages')).toBeNull();
    expect(runIdOfKey('mem:cfg:working')).toBeNull();
    expect(runIdOfKey('r1:proc:__gnl_model_claim:0')).toBeNull();
    expect(runIdOfKey('r1:cfg:model')).toBeNull();
    expect(runIdOfKey('r1:approval:call-9')).toBeNull();
    expect(runIdOfKey('r1:incident:call-1:loop-detection:block')).toBeNull();
    // Nothing is lost by that refusal: run.ts writes `:input` unconditionally, before the first model
    // Call, so any run that persisted anything is still claimed through it.
  });
});

// Every adapter, on its REAL engine (pg-mem executes actual SQL) — the defect lived in each one's own
// Write path, so a single-backend test would have proved almost nothing.
function pgStorage() {
  const { Pool } = newDb().adapters.createPg();
  return new PostgresStorage({ pool: new Pool() }).runs;
}

for (const [name, make] of [
  ['InMemoryStorage.runs', () => new InMemoryStorage().runs],
  ['InMemoryJournal', () => new InMemoryJournal()],
  ['SqliteStorage.runs', () => new SqliteStorage().runs],
  ['PostgresStorage.runs (pg-mem)', () => pgStorage()],
  ['RedisStorage.runs (fake)', () => new RedisStorage({ client: makeFakeRedis() }).runs],
] as [string, () => any][]) {
  describe(`a run that died before its first step (${name})`, () => {
    it('is visible to listRuns', async () => {
      const journal = make();
      await seed(journal);
      const runs = await listRunsArray(journal);
      expect(runs.map((r) => r.runId).sort()).toEqual(['died-at-step-0', 'lived']);
      const died = runs.find((r) => r.runId === 'died-at-step-0')!;
      expect(died.modelSteps, 'it genuinely completed no steps').toBe(0);
      expect(died.toolCalls).toBe(0);
    });

    it('does NOT become a replayable journal entry', async () => {
      const journal = make();
      await seed(journal);
      // The whole point of the `:input`/`:proc:` families is that replay never sees them.
      expect(await journal.readRun('died-at-step-0')).toEqual([]);
    });

    it('is reached by the retention sweep, so its prompt does not outlive the window', async () => {
      const journal = make();
      await seed(journal);
      expect(await journal.listKeys('died-at-step-0'), 'it really did persist the prompt').not.toEqual([]);

      const res = await sweepRuns(journal, { olderThanMs: 0, now: Date.now() + 60_000 });
      expect(res.purged.sort()).toEqual(['died-at-step-0', 'lived']);
      expect(await journal.listKeys('died-at-step-0'), 'nothing left behind').toEqual([]);
    });
  });
}
