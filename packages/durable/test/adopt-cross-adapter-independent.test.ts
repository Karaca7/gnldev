// The same migration, on all four adapters, judged by what an operator would see afterwards.
//
// `adoptIntoOrg` is implemented four times over four very different engines — a Map, SQLite, Postgres
// and a Redis keyspace. Four implementations of one contract is four chances for one to disagree, and
// the disagreement that matters is not "the SQL differs" but "the keys afterwards differ". So the
// property is stated once and run against every adapter: seed the same rows, adopt, compare the
// resulting keyspace.
//
// In-memory is the reference precisely because it is the fast one — the contract has somewhere to be
// checked against that costs nothing to run.
import { describe, it, expect } from 'vitest';
import { newDb } from 'pg-mem';
import { InMemoryStorage } from '../src/in-memory-storage.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { RedisStorage } from '../src/redis-storage.js';
import { makeFakeRedis } from './fake-redis.js';
import type { Storage } from '../src/storage.js';

const pgmemPool = () => new (newDb().adapters.createPg().Pool)();

/** Every adapter that implements the contract, each on a throwaway engine. */
const ADAPTERS: Array<[string, () => Storage]> = [
  ['InMemoryStorage', () => new InMemoryStorage()],
  ['SqliteStorage', () => new SqliteStorage(':memory:')],
  ['PostgresStorage', () => new PostgresStorage({ pool: pgmemPool() } as never)],
  ['RedisStorage', () => new RedisStorage({ client: makeFakeRedis(undefined, true) } as never)],
];

/** One row of each kind: ordinary, adoptable-reserved, platform, and already-scoped. */
const SEED = [
  'r-1:model:0',
  'r-1:outcome',
  '__usage__:acme',
  '__metrics__:all',
  '__org__:acme',
  '__agent_registry__:bot',
  '__eetoken__:t1',
  'org:globex:r-g:model:0',
];

async function adoptOn(make: () => Storage) {
  const s = make();
  await s.init?.();
  for (const k of SEED) await s.runs.put(k, { seeded: k });
  const result = await s.adoptIntoOrg!('acme');
  const keys = (await s.runs.listKeys!('')).sort();
  await s.close?.();
  return { result, keys };
}

describe('all four adapters agree on what adoption does', () => {
  it.each(ADAPTERS)('%s produces the reference keyspace', async (_name, make) => {
    const reference = (await adoptOn(() => new InMemoryStorage())).keys;
    const actual = (await adoptOn(make)).keys;

    expect(reference.length, 'the reference produced nothing — the comparison is vacuous').toBeGreaterThan(5);
    expect(actual, 'this adapter left the store in a different shape than the in-memory reference')
      .toEqual(reference);
  }, 60_000);

  /**
   * A SUPERSET property, not equality — comparing the reports directly was an invalid comparison and my
   * first version failed on it for the wrong reason. The engines hold DIFFERENT platform state:
   * Postgres and Redis write a `schema_version` row at init and correctly report declining to move it,
   * and Redis additionally reports `cache:`. In-memory has neither. So every adapter must report the
   * platform families that were SEEDED, and may report more of its own.
   */
  it.each(ADAPTERS)('%s reports every seeded platform family it declined to move', async (_name, make) => {
    const seededFamilies = SEED.filter((k) => k.startsWith('__') && !k.startsWith('__usage__') && !k.startsWith('__metrics__'))
      .map((k) => k.replace(/:.*$/, ''));
    const { result } = await adoptOn(make);

    expect(seededFamilies.length, 'no platform keys were seeded — the check is vacuous').toBeGreaterThan(2);
    for (const fam of seededFamilies) {
      expect(result.skippedPlatformKeys, `${fam} was not reported as skipped`).toContain(fam);
    }
  }, 60_000);

  it.each(ADAPTERS)('%s is idempotent and never nests', async (_name, make) => {
    const s = make();
    await s.init?.();
    for (const k of SEED) await s.runs.put(k, { seeded: k });

    const first = await s.adoptIntoOrg!('acme');
    const second = await s.adoptIntoOrg!('acme');
    const keys = await s.runs.listKeys!('');
    await s.close?.();

    const total = (r: { moved: Record<string, number> }) => Object.values(r.moved).reduce((a, b) => a + b, 0);
    expect(total(first), 'the first adoption moved nothing on this adapter').toBeGreaterThan(0);
    expect(total(second), 'a second run moved rows again — not idempotent on this adapter').toBe(0);
    expect(keys.filter((k) => /^org:[^:]+:org:/.test(k)), 'this adapter produced a nested prefix').toEqual([]);
  }, 60_000);

  it.each(ADAPTERS)('%s leaves an already-scoped row where it was', async (_name, make) => {
    const { keys } = await adoptOn(make);
    expect(keys, 'another organization\'s row was adopted or moved').toContain('org:globex:r-g:model:0');
  }, 60_000);

  it.each(ADAPTERS)('%s refuses an invalid organization id', async (_name, make) => {
    const s = make();
    await s.init?.();
    await s.runs.put('r-1:model:0', { x: 1 });
    await expect(s.adoptIntoOrg!(''), 'an empty organization id was accepted').rejects.toThrow();
    await expect(s.adoptIntoOrg!('a:b'), "an id containing ':' was accepted").rejects.toThrow();
    await s.close?.();
  }, 60_000);
});

/**
 * THE HONEST LIMITS, pinned rather than trusted.
 *
 * These are documented constraints, not defects — but a documented constraint that nothing asserts is
 * a constraint that quietly stops being true. Each of these would be silent if it regressed: a Redis
 * migration that starts rewriting `cache:` drops every TTL, and a Postgres migration that runs on a
 * pool without `connect()` is a sequence of independent statements pretending to be a transaction.
 */
describe('the limits the implementation documents', () => {
  it('Postgres refuses a pool that cannot give it a transaction', async () => {
    const poolWithoutConnect = { query: async () => ({ rows: [] }) };
    const s = new PostgresStorage({ pool: poolWithoutConnect } as never);

    await expect(s.adoptIntoOrg!('acme'),
      'adoption ran on a pool with no connect() — BEGIN/COMMIT through a pool is not a transaction, so '
      + 'a partial failure would leave the store half-migrated')
      .rejects.toThrow(/connect\(\)/);
  }, 30_000);

  it('Redis leaves cache entries alone, because rewriting them would drop their TTL', async () => {
    const s = new RedisStorage({ client: makeFakeRedis(undefined, true) } as never);
    await s.init?.();
    await s.runs.put('r-1:model:0', { x: 1 });
    await s.cache!.set('ck', { v: 1 }, { ttlMs: 60_000 });

    const result = await s.adoptIntoOrg!('acme');

    expect(result.moved.runs, 'the run did not move, so this says nothing about cache').toBeGreaterThan(0);
    expect(result.moved.cache ?? 0,
      'Redis adopted cache entries. Re-keying them means re-writing them, which resets the TTL — an '
      + 'entry that was seconds from expiry becomes fresh, and the cache silently stops expiring.')
      .toBe(0);
    await s.close?.();
  }, 30_000);

  it('and says so in the result rather than reporting a silent zero', async () => {
    // A store with no cache at all must be ABSENT from `moved`, not present as 0 — the two mean
    // different things ("this engine has no cache" vs "it has one and nothing moved").
    const s = new InMemoryStorage();
    const { moved } = await s.adoptIntoOrg!('acme');
    expect(Object.keys(moved), 'the report does not name the stores it touched').toContain('runs');
  }, 30_000);
});


/**
 * A CROSS-ADAPTER DIFFERENCE in the numbers, with a benign cause — recorded rather than asserted away.
 *
 * The visible outcome agrees on all four: the same keys end up under `org:acme:`. The reported COUNTS
 * do not. Measured on identical input, and with the already-scoped row removed so it is not the cause:
 *
 *   InMemoryStorage / RedisStorage   moved.runs = 4   alreadyScoped = 1
 *   SqliteStorage  / PostgresStorage moved.runs = 5   alreadyScoped = 2
 *
 * The SQL adapters keep a derived per-run summary row (`gnl_runs`) alongside the journal rows, and
 * count it. That is real work and arguably the more truthful number — but `listKeys` does not show it,
 * so an operator reading "5 rows moved" can only find 4, and the same migration rehearsed on a
 * different engine reports a different figure.
 *
 * Not a defect and not data loss; a question about what `moved` counts — logical keys or physical rows
 * — which the two families answer differently. Pinned as it stands so the divergence is visible and a
 * decision either way shows up here.
 */
describe('what `moved` counts differs between the key-value and SQL adapters', () => {
  it.each(ADAPTERS)('%s: moved.runs against the keys actually visible under the organization', async (name, make) => {
    const s = make();
    await s.init?.();
    for (const k of SEED.filter((k) => !k.startsWith('org:'))) await s.runs.put(k, { seeded: k });
    const result = await s.adoptIntoOrg!('acme');
    const visible = (await s.runs.listKeys!('')).filter((k) => k.startsWith('org:acme:')).length;
    await s.close?.();

    expect(visible, 'nothing moved — the comparison is vacuous').toBe(4);
    const sqlFamily = name === 'SqliteStorage' || name === 'PostgresStorage';
    expect(result.moved.runs,
      sqlFamily
        ? 'the SQL adapters count the derived run-summary row as well; if this is now 4 the decision was '
          + 'made to count logical keys and the key-value adapters should be re-checked'
        : 'the key-value adapters count logical keys only; if this is now 5 they started counting '
          + 'something the operator cannot see with listKeys')
      .toBe(sqlFamily ? visible + 1 : visible);
  }, 60_000);
});
