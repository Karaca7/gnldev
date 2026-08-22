// The typo guard: `adoptIntoOrg` refuses an organization that was never registered.
//
// The organization id is a bare argument and `orgPrefix` validates only its SHAPE, so `'acmee'` is as
// valid as `'acme'`. Measured before the guard existed:
//
//   adoptIntoOrg('acmee')        -> every row under org:acmee:, and acme sees nothing
//   adoptIntoOrg('acme') after   -> 0 moved, alreadyScoped: 1
//
// One keystroke, and the tool cannot undo it: the second run finds the rows already prefixed and
// declines. The dry run does not help either — it prints `acmee` and reads as an ordinary success.
//
// WHY THIS FILE EXISTS SEPARATELY. Registering the organization is the real upgrade flow, so every
// other adoption fixture registers it — which makes the guard invisible: those suites pass whether the
// check is there or not. Measured: removing `assertOrgRegistered` from the in-memory adapter left the
// durable suite at 1284 passed, 0 failed. A guard nothing can see is a guard nobody will keep.
import { describe, it, expect } from 'vitest';
import { newDb } from 'pg-mem';
import { InMemoryStorage } from '../src/in-memory-storage.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { RedisStorage } from '../src/redis-storage.js';
import { makeFakeRedis } from './fake-redis.js';
import type { Storage } from '../src/storage.js';

const pgmemPool = () => new (newDb().adapters.createPg().Pool)();

const ADAPTERS: Array<[string, () => Storage]> = [
  ['InMemoryStorage', () => new InMemoryStorage()],
  ['SqliteStorage', () => new SqliteStorage(':memory:')],
  ['PostgresStorage', () => new PostgresStorage({ pool: pgmemPool() } as never)],
  ['RedisStorage', () => new RedisStorage({ client: makeFakeRedis(undefined, true) } as never)],
];

/** A store with one ordinary row, and `__org__:acme` set to whatever the case under test needs. */
async function withRegistration(make: () => Storage, record: unknown | undefined) {
  const s = make();
  await s.init?.();
  await s.runs.put('r-1:model:0', { x: 1 });
  if (record !== undefined) await s.runs.put('__org__:acme', record);
  return s;
}

const keysUnder = async (s: Storage, prefix: string) =>
  (await s.runs.listKeys!('')).filter((k) => k.startsWith(prefix));

describe('an unregistered organization is refused', () => {
  it.each(ADAPTERS)('%s refuses it', async (_name, make) => {
    const s = await withRegistration(make, undefined);
    await expect(s.adoptIntoOrg!('acme'),
      'a typo in the organization name would move every row somewhere nothing reads them, irreversibly')
      .rejects.toThrow(/not registered/);
    await s.close?.();
  }, 60_000);

  // The refusal must happen BEFORE anything is written, or a half-migrated store is the result of the
  // very guard meant to prevent one.
  it.each(ADAPTERS)('%s moves nothing when it refuses', async (_name, make) => {
    const s = await withRegistration(make, undefined);
    await s.adoptIntoOrg!('acme').catch(() => undefined);

    expect(await keysUnder(s, 'org:'), 'rows were moved before the registration check ran').toEqual([]);
    expect(await s.runs.listKeys!(''), 'the original row was disturbed').toContain('r-1:model:0');
    await s.close?.();
  }, 60_000);

  it.each(ADAPTERS)('%s refuses a dry run too, rather than reporting a plausible plan', async (_name, make) => {
    const s = await withRegistration(make, undefined);
    await expect(s.adoptIntoOrg!('acme', { dryRun: true }),
      'the dry run reported a plan for an unregistered organization — which is exactly how a typo reads '
      + 'as an ordinary success before it is run for real')
      .rejects.toThrow(/not registered/);
    await s.close?.();
  }, 60_000);
});

describe('a registered organization is unaffected', () => {
  it.each(ADAPTERS)('%s adopts normally', async (_name, make) => {
    const s = await withRegistration(make, { id: 'acme', createdAt: 1 });
    const result = await s.adoptIntoOrg!('acme');

    expect(result.moved.runs, 'a registered organization was not adopted').toBeGreaterThan(0);
    expect(await keysUnder(s, 'org:acme:'), 'the row did not move').toContain('org:acme:r-1:model:0');
    await s.close?.();
  }, 60_000);
});

describe('allowUnregistered is the explicit way out', () => {
  it.each(ADAPTERS)('%s adopts when the caller opts out', async (_name, make) => {
    const s = await withRegistration(make, undefined);
    const result = await s.adoptIntoOrg!('acme', { allowUnregistered: true });

    expect(result.moved.runs, 'the opt-out did not get through — a deployment with no registration path '
      + 'has no way to migrate at all').toBeGreaterThan(0);
    await s.close?.();
  }, 60_000);

  it.each(ADAPTERS)('%s still refuses without it, so the opt-out is what carries it', async (_name, make) => {
    const s = await withRegistration(make, undefined);
    await expect(s.adoptIntoOrg!('acme', { allowUnregistered: false })).rejects.toThrow(/not registered/);
    await s.close?.();
  }, 60_000);
});

/**
 * The half you asked about: a DELETED organization must be refused as firmly as one that never existed.
 *
 * Studio marks a deletion by writing `__org__:<id>` as `null` rather than removing the row — its own
 * `listOrganizations` filters on `get(...) != null` for that reason. So the guard's `rec != null` has to
 * treat a tombstone as absent, and it does. Measured across every shape the key can hold:
 *
 *   absent / undefined / null (tombstone)  -> refused
 *   { id: 'acme' }                         -> adopted
 *
 * Adopting into a deleted organization would put every row under a prefix whose registration record
 * says the organization is gone — invisible to studio's list, and irreversible by the same argument as
 * the typo.
 */
describe('a deleted organization is refused like an absent one', () => {
  it.each(ADAPTERS)('%s refuses a deletion tombstone', async (_name, make) => {
    const s = await withRegistration(make, null);
    await expect(s.adoptIntoOrg!('acme'),
      'adoption into a DELETED organization was allowed — the rows land under a prefix studio no longer '
      + 'lists, which is the typo failure with a registration record attached')
      .rejects.toThrow(/not registered/);
    await s.close?.();
  }, 60_000);

  /**
   * A boundary, recorded rather than reported: the guard tests `!= null`, so a record holding a FALSY
   * SCALAR (`false`, `0`, `''`) passes as registered. None of those are shapes the product writes —
   * studio writes a record object or `null` — so this is unreachable rather than a defect. Pinned so
   * that if the guard is ever tightened to "a valid record", the change is visible here.
   */
  it('but a falsy scalar record still counts as registered', async () => {
    for (const scalar of [false, 0, '']) {
      const s = await withRegistration(() => new InMemoryStorage(), scalar);
      await expect(s.adoptIntoOrg!('acme'),
        `__org__:acme holding ${JSON.stringify(scalar)} is now refused — the guard was tightened beyond `
        + '`!= null`, which is fine, but this boundary moved')
        .resolves.toBeTruthy();
    }
  }, 30_000);
});

/**
 * ORDERING ON POSTGRES: the `connect()` check must come BEFORE the registration read.
 *
 * A pool that cannot give a transaction is a CONFIGURATION error, and reporting "organization not
 * registered" for it would send the operator to create an organization that already exists — or worse,
 * to create one and then run a non-atomic migration. My existing limits test asserts the message; this
 * asserts the ORDER, by putting the two failures in conflict: an unregistered organization AND a pool
 * with no `connect()`. The configuration error must win.
 */
describe('a configuration error outranks a data error', () => {
  it('a pool without connect() reports the pool, not the missing registration', async () => {
    const s = new PostgresStorage({ pool: { query: async () => ({ rows: [] }) } } as never);

    await expect(s.adoptIntoOrg!('never-registered'),
      'the registration read ran first, so an operator with a mis-configured pool is told to create an '
      + 'organization instead of to fix the pool')
      .rejects.toThrow(/connect\(\)/);
  }, 30_000);
});
