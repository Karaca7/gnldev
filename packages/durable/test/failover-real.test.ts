// REAL FAILOVER verification — the live proof of the core-hardening review (docker-compose.failover.yml).
//   docker compose -f docker-compose.failover.yml up -d
//   GNL_FAILOVER=1 npx vitest run packages/durable/test/failover-real.test.ts
// Default SKIP. WARNING: the test KILLS the primary container and PROMOTES the replica — each run
// needs a fresh compose (down -v && up -d). The scenario tests whether the README deployment
// precondition (synchronous replication) ACTUALLY protects exactly-once across a failover:
//   1. Write N acked CAS writes to the primary (putIfAbsent → true).
//   2. Kill the primary INSTANTLY with docker kill (not graceful — a real failure mode).
//   3. Promote the replica with pg_ctl promote.
//   4. On the new primary: (a) ALL N acked writes are readable (synchronous replication → NO lost writes),
//      (b) new CAS attempts on the same keys return false (exactly-once continues), (c) a fresh CAS race
//      across two connections still produces exactly one winner (atomicity also holds on the promoted node).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { PostgresStorage } from '../src/postgres-storage.js';

const RUN = process.env.GNL_FAILOVER === '1';
const PRIMARY_URL = process.env.GNL_FAILOVER_PRIMARY ?? 'postgres://gnl:gnl@localhost:55440/gnl';
const REPLICA_URL = process.env.GNL_FAILOVER_REPLICA ?? 'postgres://gnl:gnl@localhost:55441/gnl';
const PRIMARY_CONTAINER = 'gnl-failover-primary';
const REPLICA_CONTAINER = 'gnl-failover-replica';
const N = 30; // number of CAS writes to be acked before failover

const SEED = `fo${Date.now().toString(36)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!RUN)('REAL failover: primary kill → replica promote → is CAS/exactly-once preserved?', () => {
  let primary: PostgresStorage;

  beforeAll(async () => {
    primary = new PostgresStorage({ connectionString: PRIMARY_URL });
    // Once the primary is SIGKILLed, the pg Pool's idle client emits an 'error' event (unavoidable —
    // the test itself is killing the server); suppress the unhandled-error noise.
    (primary as any).pool?.on?.('error', () => {});
    // Wait until the primary + SYNCHRONOUS replica are ready: in sync mode, INSERT BLOCKS until the
    // replica connects — so the readiness check itself is done with a real write.
    for (let i = 0; ; i++) {
      try {
        await primary.init();
        await primary.runs.put(`${SEED}:readiness`, { ok: true });
        break;
      } catch (e) {
        if (i >= 60) throw e;
        await sleep(1000);
      }
    }
  }, 120_000);

  afterAll(async () => {
    await primary?.close().catch(() => {});
  });

  it('H10a: durabilityReport reports a synchronous cluster as failover-SAFE (positive case)', async () => {
    const rep = await (primary as any).durabilityReport();
    expect(rep.syncCommit).toBe('on');
    expect(rep.syncStandbys).toBeGreaterThanOrEqual(1);
    expect(rep.safeForFailover).toBe(true); // machine-verification of the README precondition
  });

  it('under synchronous replication, acked writes are COMPLETE after promotion; CAS atomicity holds on the new primary', async () => {
    // 1) N acked CAS writes — if putIfAbsent returns true, the write is ACKED (the replica received it too, in sync mode).
    for (let i = 0; i < N; i++) {
      expect(await primary.runs.putIfAbsent(`${SEED}:claim:${i}:tool:t`, { w: 'pre-failover', i })).toBe(true);
    }

    // 2) Kill the primary INSTANTLY (SIGKILL — no chance to flush/checkpoint; a real failure).
    execSync(`docker kill ${PRIMARY_CONTAINER}`, { stdio: 'pipe' });

    // 3) Promote the replica (official image, the replica container runs as the postgres user).
    execSync(
      `docker exec ${REPLICA_CONTAINER} pg_ctl promote -D /var/lib/postgresql/data/pgdata`,
      { stdio: 'pipe' },
    );
    // A REAL RUNBOOK STEP (caught by this very test): since pg_basebackup also copies postgresql.conf,
    // the promoted node still carries `synchronous_standby_names='*'` — with no standby left, EVERY
    // write would wait forever for synchronous ack. Patroni/repmgr clear this automatically on promote;
    // anyone doing a manual failover MUST clear it too (README deployment note).
    execSync(
      `docker exec ${REPLICA_CONTAINER} psql -U gnl -c "ALTER SYSTEM SET synchronous_standby_names = ''" -c "SELECT pg_reload_conf()"`,
      { stdio: 'pipe' },
    );

    // 4) Connect to the new primary (wait until it's promoted + writable).
    const promoted = new PostgresStorage({ connectionString: REPLICA_URL });
    try {
      for (let i = 0; ; i++) {
        try {
          await promoted.runs.put(`${SEED}:promote-probe`, { ok: true }); // is it writable?
          break;
        } catch (e) {
          if (i >= 60) throw e;
          await sleep(1000);
        }
      }

      // (a) LOST-WRITE CHECK: ALL N acked writes must be readable on the promoted node.
      // (Under asynchronous replication, loss would be observed here — proof of the README's sync precondition.)
      let survived = 0;
      for (let i = 0; i < N; i++) {
        if ((await promoted.runs.get(`${SEED}:claim:${i}:tool:t`)) !== undefined) survived++;
      }
      expect(survived).toBe(N);

      // (b) EXACTLY-ONCE continues: claims won before the failover cannot be won again on the new primary.
      for (let i = 0; i < N; i++) {
        expect(await promoted.runs.putIfAbsent(`${SEED}:claim:${i}:tool:t`, { w: 'post-failover' })).toBe(false);
      }
      expect(await promoted.runs.get(`${SEED}:claim:0:tool:t`)).toMatchObject({ w: 'pre-failover' }); // value preserved

      // (c) ATOMICITY on the promoted node: two SEPARATE pools racing a fresh CAS → exactly one winner (10 rounds).
      const second = new PostgresStorage({ connectionString: REPLICA_URL });
      try {
        for (let round = 0; round < 10; round++) {
          const key = `${SEED}:post:${round}:tool:t`;
          const results = await Promise.all([
            promoted.runs.putIfAbsent(key, { w: 'a' }),
            second.runs.putIfAbsent(key, { w: 'b' }),
          ]);
          expect(results.filter(Boolean).length).toBe(1);
        }
      } finally {
        await second.close();
      }
    } finally {
      await promoted.close();
    }
  }, 180_000);
});
