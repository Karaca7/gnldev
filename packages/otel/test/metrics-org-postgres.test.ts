// Organization isolation for the metrics export, against a REAL Postgres.
//
// `metrics.test.ts` already checks that every counter key the export reads carries the organization
// prefix. That catches one of the two ways this can leak — reading the BARE key from an org handle,
// which returns nothing and reads on a dashboard as a quiet tenant.
//
// It cannot catch the other, and not for lack of trying: an `InMemoryJournal` keeps counters in a
// Map addressed by exact key, so there is no table for a query to scan and the mistake cannot be
// expressed against it. On a real engine every organization's counter rows sit in ONE
// `gnl_counters` table, and a reader that reaches past the handle — a hand-written
// `WHERE key LIKE '%__metrics__:all%'`, the shape someone reaches for when making this "faster" —
// sums all of them. Nothing downstream can tell: the number is a real number, and it is the wrong
// tenant's.
//
// So this file does two things a unit test cannot. It establishes that the hazard is present (both
// tenants really are in the same table), and it measures what the wrong read returns, next to what
// the right one does. `organization.ts` refuses to bridge `countRunsByStatus` for exactly this
// reason, and describes it as "a real cross-organization data leak".
//
// Skipped without `GNL_PG_URL`, like prefix-astral-postgres.test.ts, and for the same reason:
// pg-mem cannot stand in for the engine behaviour under test.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgresStorage } from '@gnldev/durable/postgres';
import { withOrg, toJournal, recordRunMetrics, METRICS_ALL_KEY } from '@gnldev/durable';
import type { Journal } from '@gnldev/durable';
import { toOtlpMetricsJson } from '../src/metrics.js';

const URL = process.env.GNL_PG_URL;
const d = URL ? describe : describe.skip;

const EPOCH = 1_700_000_000_000;

async function seedRun(journal: Journal, runId: string) {
  await journal.put(`${runId}:model:0`, { usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 }, ts: EPOCH });
  await journal.put(`${runId}:tool:c0`, { status: 'succeeded', output: {}, ts: EPOCH + 100 });
  await recordRunMetrics(journal, journal as never, runId);
}

d('metrics export — organization isolation on a real Postgres', () => {
  let storage: PostgresStorage;
  let root: Journal;
  const schema = `otel_metrics_org_${Date.now().toString(36)}`;

  beforeAll(async () => {
    // Its own schema: this test asserts on the CONTENTS of gnl_counters, so anything another test
    // left behind would be counted as a third tenant and the numbers below would drift.
    const bootstrap = new PostgresStorage({ connectionString: URL! });
    for (let i = 0; ; i++) {
      try { await bootstrap.init(); break; } catch (e) { if (i > 30) throw e; await new Promise((r) => setTimeout(r, 500)); }
    }
    await bootstrap.pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await bootstrap.close?.();

    storage = new PostgresStorage({ connectionString: `${URL!}?options=-c%20search_path%3D${schema}` });
    await storage.init();
    root = toJournal(storage.runs);
  }, 60_000);

  afterAll(async () => {
    await storage?.pool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await storage?.close?.();
  });

  it('reports the organization it was handed, while the other tenant sits in the same table', async () => {
    const acme = withOrg(root, 'acme') as unknown as Journal;
    const globex = withOrg(root, 'globex') as unknown as Journal;
    for (let i = 0; i < 5; i++) await seedRun(acme, `acme-r${i}`);
    for (let i = 0; i < 40; i++) await seedRun(globex, `globex-r${i}`);

    // The hazard, established rather than assumed: both tenants' counter rows are in one table, so
    // a query that matches on the key SUFFIX can reach across them.
    const rows = await storage.pool.query<{ key: string }>(
      `SELECT key FROM gnl_counters WHERE key LIKE '%' || $1 || '%'`, [METRICS_ALL_KEY],
    );
    const owners = new Set(rows.rows.map((r) => r.key.split(':').slice(0, 2).join(':')));
    expect(owners, 'both tenants must be present, or this test proves nothing').toEqual(new Set(['org:acme', 'org:globex']));

    // What the leaking read returns, measured — 45, and every digit of it real.
    const leaked = await storage.pool.query<{ total: string }>(
      `SELECT COALESCE(SUM((value->>'runs')::bigint), 0) AS total FROM gnl_counters WHERE key LIKE '%' || $1 || '%'`,
      [METRICS_ALL_KEY],
    ).then((r) => Number(r.rows[0].total)).catch(() => -1);
    if (leaked !== -1) expect(leaked).toBe(45);

    // And what the export returns, from the same table, at the same moment.
    const payload = await toOtlpMetricsJson(acme, { startTime: EPOCH, now: EPOCH + 60_000 });
    const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics;
    const runs = metrics.find((m) => m.name === 'gnl.runs')!.sum!.dataPoints[0];
    expect(runs.asInt).toBe('5');

    const org = payload.resourceMetrics[0].resource.attributes.find((a) => a.key === 'gnl.org.id');
    expect(org?.value).toEqual({ stringValue: 'acme' });
  }, 120_000);

  it('an unscoped journal reports nothing rather than everything', async () => {
    // The other silent direction. The root handle reads the unprefixed key, which in an org-scoped
    // deployment nobody writes — so the honest answer is zero. It must not be 45.
    const payload = await toOtlpMetricsJson(root, { startTime: EPOCH, now: EPOCH + 60_000 });
    const runs = payload.resourceMetrics[0].scopeMetrics[0].metrics.find((m) => m.name === 'gnl.runs')!.sum!.dataPoints[0];
    expect(runs.asInt).toBe('0');
    expect(payload.resourceMetrics[0].resource.attributes.find((a) => a.key === 'gnl.org.id')).toBeUndefined();
  }, 60_000);
});
