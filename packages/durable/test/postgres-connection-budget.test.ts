// A connection refusal must arrive with the arithmetic that caused it.
//
// Measured before this guard existed: two 8-worker app groups against one Postgres asked for
// 16 × 10 = 160 connections against `max_connections = 100`, and 513 of 600 requests came back as
// 500s carrying nothing but Postgres's own `sorry, too many clients already`. Nothing in gnl chose
// that 10 — it is node-postgres's default pool size — and nothing told the operator that
// processes × pool size had crossed the server's limit.
//
// These tests inject a pool rather than starving a real server: exhausting `max_connections` on the
// shared test database would break every other suite running beside this one.
import { describe, it, expect } from 'vitest';
import { PostgresStorage } from '../src/postgres-storage.js';

/** A pool that serves startup normally and then fails one way on demand. */
function poolThatFails(failure: (() => never) | undefined, opts: { max?: number; serverMax?: string } = {}) {
  const rows = (sql: string) => {
    if (/max_connections/i.test(sql)) return [{ max_connections: opts.serverMax ?? '100' }];
    if (/byte_ordered/i.test(sql)) return [{ byte_ordered: true }];
    return [];
  };
  let ready = false;
  return {
    options: { max: opts.max ?? 10 },
    async query(sql: string) {
      // Startup (DDL + probes) always succeeds; the failure is armed only afterwards, so the test
      // exercises the query path rather than the migration. The budget probe (`SHOW max_connections`)
      // is the LAST thing ensureReady does — arming before it ran left `connectionBudget` unset and the
      // advice silently absent, which is exactly the failure this test exists to catch.
      if (!ready) {
        if (/max_connections/i.test(sql)) ready = true;
        return { rows: rows(sql), rowCount: rows(sql).length };
      }
      if (failure) failure();
      return { rows: [], rowCount: 0 };
    },
  } as never;
}

const tooManyClients = () => {
  const e = new Error('sorry, too many clients already') as Error & { code: string };
  e.code = '53300';
  throw e;
};

describe('PostgresStorage: a connection refusal explains itself', () => {
  it('names the budget arithmetic and keeps the original error as `cause`', async () => {
    const st = new PostgresStorage({ pool: poolThatFails(tooManyClients, { max: 10, serverMax: '100' }) });
    await expect(st.runs.get('anything')).rejects.toThrow(/too many clients/);

    const err = await st.runs.get('anything').catch((e: unknown) => e as Error);
    // The operator needs three facts: what this process reserves, what the server allows, and the
    // product they must stay under. Without the last one the message is just a restatement.
    expect(err.message).toMatch(/reserves up to 10/);
    expect(err.message).toMatch(/server allows 100/);
    expect(err.message).toMatch(/under 80/);
    expect(err.cause).toBeDefined();
    expect((err.cause as Error).message).toBe('sorry, too many clients already');
    // The code survives, so callers that switch on it are unaffected by the wrapping.
    expect((err as { code?: string }).code).toBe('53300');
  });

  it('scales the advice to the pool it was actually given', async () => {
    const st = new PostgresStorage({ pool: poolThatFails(tooManyClients, { max: 4, serverMax: '500' }) });
    const err = await st.runs.get('anything').catch((e: unknown) => e as Error);
    expect(err.message).toMatch(/reserves up to 4/);
    expect(err.message).toMatch(/under 480/);
    expect(err.message).toMatch(/120 process/);   // (500 - 20) / 4
  });

  it('leaves every other error exactly as it was', async () => {
    const boom = () => { throw new Error('relation "gnl_run_journal" does not exist'); };
    const st = new PostgresStorage({ pool: poolThatFails(boom) });
    const err = await st.runs.get('anything').catch((e: unknown) => e as Error);
    // No wrapping, no advice, no cause chain — a schema error must not be dressed up as a capacity one.
    expect(err.message).toBe('relation "gnl_run_journal" does not exist');
    expect(err.cause).toBeUndefined();
  });
});
