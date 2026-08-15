// A canceled run said it completed.
//
// `cancelAgentRun` journaled a flag and nothing else. The flag stops the run at its next fresh model
// step and refuses every later resume — but the run's OUTCOME record was never written, because
// `classifyRunError` (correctly) calls RunCanceledError a not-a-failure, so the throw site recorded
// nothing. The result: a run canceled before it ever started read 'completed', and one canceled
// mid-flight kept whatever its write-ahead had left. Deliberate cancellation and success were the same
// answer — the one distinction an operator ordering a cancel actually needs.
//
// The cancel choke point now records {status:'canceled'} itself. Four things have to hold:
//   - a canceled run reads 'canceled' in EVERY adapter, through the filter and the aggregate
//   - canceled beats suspended — a canceled run's pending approval can never be applied
//   - the resume refusal that follows a cancel does not flip the status back
//   - a run that already ENDED is not relabelled by a cancel that arrived afterwards
import { describe, it, expect } from 'vitest';
import { newDb } from 'pg-mem';
import { tool } from 'ai';
import { z } from 'zod';
import {
  runDurable, InMemoryStorage, InMemoryJournal, listRunsArray, readRunOutcome, deriveRunStatus,
  recordRunOutcome, runStarted, cancelAgentRun, RunCanceledError, runKeys,
} from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { RedisStorage } from '../src/index.js';
import { makeFakeRedis } from './fake-redis.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const base = { specificationVersion: 'v2', provider: 'scripted', modelId: 'm', supportedUrls: {}, doStream: async () => { throw new Error('gen-only'); } };
const good = { ...base, doGenerate: async () => ({ content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage, warnings: [] }) } as any;
const dead = { ...base, doGenerate: async () => { throw new Error('401 invalid api key'); } } as any;

const statusOf = async (journal: any, runId: string) =>
  (await listRunsArray(journal)).find((r) => r.runId === runId)?.status;

/**
 * Wait until a run reaches `want`, up to a deadline. The abandoned-run cases below start a run and
 * Never await it, so the write-ahead lands whenever the event loop gets to it — a fixed sleep passed
 * In isolation and failed inside the full suite, where the machine is saturated (measured). Polling
 * Tests the same fact without encoding a machine's speed into the assertion.
 */
async function waitForStatus(journal: any, runId: string, want: string, timeoutMs = 5_000): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  let seen: string | undefined;
  do {
    seen = await statusOf(journal, runId);
    if (seen === want) return seen;
    await new Promise((r) => setTimeout(r, 10));
  } while (Date.now() < deadline);
  return seen;
}

describe('deriveRunStatus with the canceled vocabulary', () => {
  it('orders canceled > suspended > failed > running > completed', () => {
    // The one call that is not obvious. 'suspended' comes from TOOL records, which outlive the
    // cancel — so a run canceled while it waited on a human would keep advertising an approval that
    // runDurableGuarded's assertNotCanceled refuses to ever apply. Every other status describes a run
    // that could still move; a canceled one is terminally over.
    expect(deriveRunStatus(true, { status: 'canceled' })).toBe('canceled');
    expect(deriveRunStatus(true, { status: 'running' })).toBe('suspended');
    expect(deriveRunStatus(false, { status: 'canceled' })).toBe('canceled');
    expect(deriveRunStatus(false, { status: 'failed' })).toBe('failed');
    expect(deriveRunStatus(false, { status: 'running' })).toBe('running');
    expect(deriveRunStatus(false, { status: 'completed' })).toBe('completed');
    // A journal with NO outcome — written before outcomes existed — reads exactly as it always did.
    expect(deriveRunStatus(false, null)).toBe('completed');
    expect(deriveRunStatus(true, null)).toBe('suspended');
  });
});

const adapters: [string, () => any][] = [
  ['InMemoryStorage.runs', () => new InMemoryStorage().runs],
  ['InMemoryJournal', () => new InMemoryJournal()],
  ['SqliteStorage.runs', () => new SqliteStorage().runs],
  ['PostgresStorage.runs (pg-mem)', () => new PostgresStorage({ pool: new (newDb().adapters.createPg().Pool)() }).runs],
  ['RedisStorage.runs (fake)', () => new RedisStorage({ client: makeFakeRedis() }).runs],
];

for (const [name, make] of adapters) {
  describe(`run cancellation — ${name}`, () => {
    it('reports a canceled run as canceled, and leaves a finished one alone', async () => {
      const journal = make();
      await runDurable({ runId: 'lived', journal, model: good, prompt: 'x' } as any);
      // A run whose attempt was abandoned mid-work: its write-ahead says 'running', no terminal ever
      // landed. This is the shape an operator actually cancels.
      const never = { ...base, doGenerate: () => new Promise(() => {}) } as any;
      void runDurable({ runId: 'stopped', journal, model: never, prompt: 'x' } as any).catch(() => {});
      expect(await waitForStatus(journal, 'stopped', 'running')).toBe('running');

      await cancelAgentRun(journal, 'stopped', { reason: 'operator' });
      expect(await statusOf(journal, 'stopped'), 'this used to keep reading running forever').toBe('canceled');
      expect((await readRunOutcome(journal, 'stopped'))?.status).toBe('canceled');
      // The flag is per-run, not a switch on the journal.
      expect(await statusOf(journal, 'lived'), 'an untouched run is unaffected').toBe('completed');
    });

    it('a run canceled before it ever started reads canceled, not completed', async () => {
      const journal = make();
      // Nothing has run: no entries, no outcome. This is the case that read 'completed' — the absence
      // of a terminal record and "ended fine" were the same answer.
      await cancelAgentRun(journal, 'never-ran', { reason: 'operator' });
      expect(await statusOf(journal, 'never-ran')).toBe('canceled');
      // And the run LISTS at all: the cancel may be a run's very first key.
      expect((await listRunsArray(journal)).map((r: any) => r.runId)).toContain('never-ran');
    });

    it('canceled beats suspended — the approval can never be applied, so it must not be advertised', async () => {
      const journal = make();
      const t = tool({ description: 'c', inputSchema: z.object({ amount: z.number() }), execute: async () => ({ ok: true }) });
      Object.assign(t, { sideEffect: true });
      const model = {
        ...base,
        doGenerate: async ({ prompt }: any) => {
          const done = (prompt ?? []).filter((m: any) => m.role === 'tool').length;
          if (done === 0) return { content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'chargeCard', input: JSON.stringify({ amount: 1 }) }], finishReason: 'tool-calls', usage, warnings: [] };
          return { content: [{ type: 'text', text: 'done' }], finishReason: 'stop', usage, warnings: [] };
        },
      } as any;
      const res = await runDurable({
        runId: 'waiting', journal, model, tools: { chargeCard: t as any },
        guard: () => ({ action: 'require-approval', reason: 'human' }), prompt: 'charge',
      } as any);
      expect(res.interrupts.length).toBeGreaterThan(0);
      expect(await statusOf(journal, 'waiting')).toBe('suspended');

      await cancelAgentRun(journal, 'waiting', { reason: 'operator' });
      // The suspended TOOL record is still there — cancel never deletes journal state — so this is a
      // precedence result, not an erasure one.
      expect(await statusOf(journal, 'waiting')).toBe('canceled');

      // And the refusal is real: resuming with the approval throws, and does NOT flip the status back.
      await expect(runDurable({
        runId: 'waiting', journal, model, tools: { chargeCard: t as any },
        approvals: { c1: true }, prompt: 'charge',
      } as any)).rejects.toBeInstanceOf(RunCanceledError);
      expect(await statusOf(journal, 'waiting'), 'the refused resume must not rewrite the verdict').toBe('canceled');
      expect((await readRunOutcome(journal, 'waiting'))?.status).toBe('canceled');
    });

    it('surfaces through the status filter and the aggregate, both of which must agree', async () => {
      const journal = make();
      await runDurable({ runId: 'f-done', journal, model: good, prompt: 'x' } as any);
      await runDurable({ runId: 'f-died', journal, model: dead, prompt: 'x' } as any).catch(() => {});
      await cancelAgentRun(journal, 'f-stop', { reason: 'operator' });

      // A bare JournalReader filters through `listRunsPaged`; an adapter's RunJournal takes the query
      // on `listRuns` itself. Both must apply the SAME five-way semantics, so both are asked here.
      const filter = async (status: string): Promise<string[]> => {
        const res = typeof journal.listRunsPaged === 'function'
          ? await journal.listRunsPaged({ status, limit: 100 })
          : await journal.listRuns({ status, limit: 100 });
        return (Array.isArray(res) ? res : res.items).map((r: any) => r.runId);
      };
      expect(await filter('canceled'), 'the five-way filter must find exactly the canceled run').toEqual(['f-stop']);
      // The completed bucket does NOT absorb it — the lie this vocabulary exists to end.
      expect(await filter('completed')).toEqual(['f-done']);
      expect(await filter('failed')).toEqual(['f-died']);

      if (typeof journal.countRunsByStatus === 'function') {
        const counted = await journal.countRunsByStatus();
        expect(counted.canceled).toBe(1);
        expect(counted.completed).toBe(1);
        expect(counted.failed).toBe(1);
      }
    });

    it('a cancel does not relabel a run that had already ended', async () => {
      const journal = make();
      await runDurable({ runId: 'finished', journal, model: good, prompt: 'x' } as any);
      await runDurable({ runId: 'broke', journal, model: dead, prompt: 'x' } as any).catch(() => {});
      // The common misclick: the run finished a second before the operator hit cancel. The FLAG still
      // lands (no future resume), but the outcome says how the run ENDED, and this one ended by
      // completing — its output is sitting right there in the timeline. Same for the 401.
      await cancelAgentRun(journal, 'finished', { reason: 'too late' });
      await cancelAgentRun(journal, 'broke', { reason: 'too late' });
      expect(await statusOf(journal, 'finished')).toBe('completed');
      expect(await statusOf(journal, 'broke')).toBe('failed');
      // The refusal is in force regardless of what the status says.
      await expect(runDurable({ runId: 'finished', journal, model: good, prompt: 'x' } as any))
        .rejects.toBeInstanceOf(RunCanceledError);
    });

    it('legacy journals — no outcome record, no cancel — read exactly as they did', async () => {
      const journal = make();
      await runDurable({ runId: 'legacy', journal, model: good, prompt: 'x' } as any);
      await journal.deletePrefix(runKeys.outcome('legacy'));
      expect(await statusOf(journal, 'legacy'), 'an old run must read as it always did').toBe('completed');
    });
  });
}

describe('the cancel verdict under a race', () => {
  it('a straggling start marker cannot resurrect a canceled run', async () => {
    const journal = new InMemoryJournal();
    await cancelAgentRun(journal, 'r', { reason: 'operator' });
    const at = (await readRunOutcome(journal, 'r'))!.at;
    // A worker that passed assertNotCanceled microseconds BEFORE the flag landed reaches runStarted
    // just after it. It will throw RunCanceledError at its next model step and — correctly — record
    // nothing, so without this rule its write-ahead is the last word and the run reads 'running'.
    await runStarted(journal, 'r', at + 5_000);
    expect((await readRunOutcome(journal, 'r'))?.status).toBe('canceled');
  });

  it('but a run that genuinely finished despite a late cancel says so', async () => {
    const journal = new InMemoryJournal();
    await cancelAgentRun(journal, 'r', { reason: 'operator' });
    const at = (await readRunOutcome(journal, 'r'))!.at;
    // The cancel takes effect at the NEXT fresh model step; against a run on its last step it simply
    // arrives too late to stop anything. Reporting that run as canceled would be the lie in the other
    // direction — it ran to completion, and the journal shows the work.
    await recordRunOutcome(journal, 'r', { status: 'completed', at: at + 5_000 });
    expect((await readRunOutcome(journal, 'r'))?.status).toBe('completed');
  });

  it('re-cancelling is idempotent and keeps the ORIGINAL decision`s moment', async () => {
    const journal = new InMemoryJournal();
    await cancelAgentRun(journal, 'r', { reason: 'first' });
    const first = (await readRunOutcome(journal, 'r'))!;
    await new Promise((r) => setTimeout(r, 5));
    await cancelAgentRun(journal, 'r', { reason: 'second' });
    const again = (await readRunOutcome(journal, 'r'))!;
    expect(again.status).toBe('canceled');
    expect(again.at, 'the audit-relevant decision is the first one').toBe(first.at);
  });

  it('is written ONCE, by the flag, not again by the error it causes', async () => {
    // The mid-flight gate throws RunCanceledError at the next fresh model step. classifyRunError calls
    // that a not-a-failure and records NOTHING — deliberately: the error only exists because
    // cancelAgentRun journaled the flag, and that call already wrote the verdict. A second writer here
    // would race the first over one fact, on a path that fires once per worker that notices.
    const journal = new InMemoryJournal();
    let steps = 0;
    const twoStep = {
      ...base,
      doGenerate: async () => {
        steps++;
        if (steps === 1) {
          await cancelAgentRun(journal, 'mid', { reason: 'operator' }); // cancelled while in flight
          return { content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'noop', input: '{}' }], finishReason: 'tool-calls', usage, warnings: [] };
        }
        return { content: [{ type: 'text', text: 'should never be reached' }], finishReason: 'stop', usage, warnings: [] };
      },
    } as any;
    const noop = tool({ description: 'n', inputSchema: z.object({}), execute: async () => ({ ok: true }) });

    await expect(runDurable({ runId: 'mid', journal, model: twoStep, tools: { noop: noop as any }, prompt: 'x' } as any))
      .rejects.toBeInstanceOf(RunCanceledError);
    const outcome = (await readRunOutcome(journal, 'mid'))!;
    expect(outcome.status, 'the abort must not overwrite the cancel with anything').toBe('canceled');
    expect(await (async () => (await listRunsArray(journal)).find((r) => r.runId === 'mid')?.status)()).toBe('canceled');
  });
});
