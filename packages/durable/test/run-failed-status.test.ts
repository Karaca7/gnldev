// A run that ended badly said it ended well.
//
// Status was DERIVED from journal entries — 'suspended' if any tool record was suspended, otherwise
// 'completed' — and a run that throws writes no entry saying so. A 401 on the first model call, a cost
// ceiling tripping mid-run, a guard rejection: every one of them read back as 'completed', and
// exportRun handed them to OTel with SpanStatusCode.OK. Nothing in the system recorded that a run had
// FAILED, so nothing could report it.
//
// Runs now write their outcome at each terminal boundary. Three things have to hold, and the last two
// are the ones that are easy to get wrong:
//   - a failure is visible as 'failed', in every adapter and through the filter
//   - a SUSPENDED run is not a failed one — it returns normally, awaiting a human
//   - a run that failed, was fixed, and resumed to success stops being failed
import { describe, it, expect } from 'vitest';
import { newDb } from 'pg-mem';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import {
  runDurable, InMemoryStorage, InMemoryJournal, listRunsArray, readRunOutcome, runKeys,
  RunLimitExceededError,
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

const adapters: [string, () => any][] = [
  ['InMemoryStorage.runs', () => new InMemoryStorage().runs],
  ['InMemoryJournal', () => new InMemoryJournal()],
  ['SqliteStorage.runs', () => new SqliteStorage().runs],
  ['PostgresStorage.runs (pg-mem)', () => new PostgresStorage({ pool: new (newDb().adapters.createPg().Pool)() }).runs],
  ['RedisStorage.runs (fake)', () => new RedisStorage({ client: makeFakeRedis() }).runs],
];

for (const [name, make] of adapters) {
  describe(`run outcome — ${name}`, () => {
    it('reports a run that threw as failed, and one that finished as completed', async () => {
      const journal = make();
      await runDurable({ runId: 'lived', journal, model: good, prompt: 'x' } as any);
      await runDurable({ runId: 'died', journal, model: dead, prompt: 'x' } as any).catch(() => {});

      expect(await statusOf(journal, 'lived')).toBe('completed');
      expect(await statusOf(journal, 'died'), 'this used to read as completed').toBe('failed');
    });

    it('keeps the reason, so an operator does not have to guess', async () => {
      const journal = make();
      await runDurable({ runId: 'died', journal, model: dead, prompt: 'x' } as any).catch(() => {});
      const outcome = await readRunOutcome(journal, 'died');
      expect(outcome?.status).toBe('failed');
      expect(outcome?.error).toContain('401');
    });

    it('stops being failed once a resume succeeds', async () => {
      const journal = make();
      await runDurable({ runId: 'r', journal, model: dead, prompt: 'x' } as any).catch(() => {});
      expect(await statusOf(journal, 'r')).toBe('failed');
      // Same runId, working model — the operator fixed the key and re-ran.
      await runDurable({ runId: 'r', journal, model: good, prompt: 'x' } as any);
      expect(await statusOf(journal, 'r'), 'a fixed run must not stay marked failed').toBe('completed');
    });
  });
}

// InMemoryJournal is the bare JournalReader — its listRuns takes no query and returns an array. The
// Paged/filtered contract belongs to RunJournal, so only those are exercised here.
describe('the status filter', () => {
  for (const [name, make] of adapters.filter(([n]) => n !== 'InMemoryJournal')) {
    it(`partitions runs three ways — ${name}`, async () => {
      const journal = make();
      await runDurable({ runId: 'ok1', journal, model: good, prompt: 'x' } as any);
      await runDurable({ runId: 'ok2', journal, model: good, prompt: 'x' } as any);
      await runDurable({ runId: 'bad', journal, model: dead, prompt: 'x' } as any).catch(() => {});

      const ids = async (status: string) => (await journal.listRuns({ status, limit: 100 })).items.map((r: any) => r.runId).sort();
      expect(await ids('failed')).toEqual(['bad']);
      expect(await ids('completed'), 'a failed run must not be counted as completed').toEqual(['ok1', 'ok2']);
      expect(await ids('suspended')).toEqual([]);
    });
  }
});

describe('what is NOT a failure', () => {
  /** Suspends on its first tool call and returns normally, waiting for a human. */
  function suspending() {
    const t = tool({
      description: 'charge',
      inputSchema: z.object({ amount: z.number() }),
      execute: async () => ({ ok: true }),
    });
    Object.assign(t, { sideEffect: true });
    return t as any;
  }

  it('a suspended run is not marked failed — it is waiting, not broken', async () => {
    const journal = new InMemoryStorage().runs;
    const model = {
      ...base,
      doGenerate: async ({ prompt }: any) => {
        const done = (prompt ?? []).filter((m: any) => m.role === 'tool').length;
        if (done === 0) return { content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'chargeCard', input: JSON.stringify({ amount: 1 }) }], finishReason: 'tool-calls', usage, warnings: [] };
        return { content: [{ type: 'text', text: 'done' }], finishReason: 'stop', usage, warnings: [] };
      },
    } as any;
    const res = await runDurable({
      runId: 'waiting', journal, model, tools: { chargeCard: suspending() },
      guard: () => ({ action: 'require-approval', reason: 'human must confirm a charge' }),
      prompt: 'charge', stopWhen: stepCountIs(4),
    } as any);

    expect(res.interrupts.length, 'it really did suspend').toBeGreaterThan(0);
    expect(await statusOf(journal, 'waiting')).toBe('suspended');
    // The write-ahead start exists (the run DID start) but no TERMINAL verdict does — the run has
    // not ended. The original form of this assertion predates the 'running' vocabulary and asserted
    // total absence; what it was actually guarding is that suspension is never recorded as an ending.
    const outcome = await journal.get<{ status?: string }>(runKeys.outcome('waiting'));
    expect(outcome?.status).toBe('running');
    expect(outcome?.status).not.toBe('completed');
    expect(outcome?.status).not.toBe('failed');
  });

  it('a run refused because another worker holds the lock is not marked failed', async () => {
    const { acquireRunLock } = await import('../src/run-lock.js');
    const journal = new InMemoryStorage().runs;
    await acquireRunLock(journal, 'held', 'worker-A', 60_000);

    // Worker B is turned away. The run belongs to A and is very possibly succeeding right now —
    // Stamping 'failed' from here would overwrite a live run's record with a stranger's story.
    await runDurable({ runId: 'held', journal, model: good, prompt: 'x', lock: { owner: 'worker-B', ttlMs: 60_000 } } as any)
      .catch(() => {});
    expect(await readRunOutcome(journal, 'held')).toBeUndefined();
  });

  it('a run stopped by its own cost ceiling IS a failure', async () => {
    const journal = new InMemoryStorage().runs;
    const err = await runDurable({
      runId: 'over-budget', journal, model: good, prompt: 'x', limits: { maxTokens: 1 },
    } as any).catch((e) => e);
    expect(err).toBeInstanceOf(RunLimitExceededError);
    expect(await statusOf(journal, 'over-budget')).toBe('failed');
  });
});
