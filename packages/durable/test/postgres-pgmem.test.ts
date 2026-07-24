// PostgresJournal against REAL SQL: a pg-mem (in-memory Postgres) pool is injected.
// CREATE TABLE / INSERT ON CONFLICT / SELECT LIKE really run. Full runDurable + crash/resume.
import { describe, it, expect } from 'vitest';
import { newDb } from 'pg-mem';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { PostgresStorage } from '../src/postgres-storage.js';
import { runDurable } from '../src/run.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

function pgmemPool() {
  const { Pool } = newDb().adapters.createPg();
  return new Pool();
}

describe('PostgresStorage.runs — pg-mem (real SQL)', () => {
  it('put/get + upsert + readRun over real SQL', async () => {
    const b = new PostgresStorage({ pool: pgmemPool() });
    const journal = b.runs;
    await journal.put('o1:model:0', { when: new Date('2026-06-19T00:00:00.000Z') });
    await journal.put('o1:tool:c1', { status: 'failed' });
    await journal.put('o1:tool:c1', { status: 'succeeded', output: 1 }); // ON CONFLICT DO UPDATE
    const got = await journal.get<any>('o1:tool:c1');
    expect(got.status).toBe('succeeded');
    const entries = await journal.readRun('o1');
    expect(entries.map((e) => e.kind)).toEqual(['model', 'tool']);
    expect((await journal.get<any>('o1:model:0')).when instanceof Date).toBe(true);
    await b.close();
  });

  it('full runDurable cycle + crash/resume → charge=1 (pg-mem)', async () => {
    const b = new PostgresStorage({ pool: pgmemPool() });
    const journal = b.runs;
    const counter = { charges: 0 };
    const tools = () => ({
      chargeCard: tool({
        description: 'charge',
        inputSchema: z.object({ amount: z.number() }),
        execute: async ({ amount }) => {
          counter.charges++;
          return { charged: amount };
        },
      }),
    });
    const crash = { active: true };
    const model = () =>
      createMockModel(async ({ prompt }: any) => {
        const done = countToolResults(prompt);
        if (done === 0) return toolCallResult('chargeCard', 'call-c', { amount: 20 });
        if (crash.active && done === 1) throw new Error('CRASH');
        return finalTextResult('Charged.');
      });

    await expect(
      runDurable({ runId: 'pg1', journal, model: model(), tools: tools(), prompt: 'charge', stopWhen: stepCountIs(6) }),
    ).rejects.toThrow('CRASH');
    expect(counter.charges).toBe(1);

    crash.active = false;
    const res = await runDurable({ runId: 'pg1', journal, model: model(), tools: tools(), prompt: 'charge', stopWhen: stepCountIs(6) });
    expect(counter.charges).toBe(1); // exactly-once holds over Postgres too
    expect(res.text).toContain('Charged');
    await b.close();
  });
});
