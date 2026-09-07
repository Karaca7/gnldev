// FAZ-9 — WorkStore.deletePrefix and the organization erasure it completes.
//
// The gap this closes was documented, not hypothetical: `purgeOrganization` swept the Journal and
// left everything @gnldev/queue and @gnldev/events had written, because the WorkStore port had no
// delete at all. The legal brief listed that as a promise the framework could not keep.
//
// The same contract runs against all four adapters, because a purge that works in memory and misses
// rows on Postgres is worse than no purge — the operator has a green run and a live record.
import { describe, it, expect } from 'vitest';
import { newDb } from 'pg-mem';
import { InMemoryStorage, RedisStorage, purgeOrganization, purgeOrganizationWork, withOrgStorage, toJournal } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { makeFakeRedis } from './fake-redis.js';
import type { Storage } from '../src/index.js';

const backends: Array<[string, () => Promise<Storage> | Storage]> = [
  ['in-memory', () => new InMemoryStorage()],
  ['sqlite', () => new SqliteStorage(':memory:')],
  ['postgres', () => { const { Pool } = newDb().adapters.createPg(); return new PostgresStorage({ pool: new Pool() }); }],
  ['redis', () => new RedisStorage({ client: makeFakeRedis() as never })],
];

for (const [name, make] of backends) {
  describe(`WorkStore.deletePrefix — ${name}`, () => {
    it('sweeps BOTH families (log namespaces and KV keys) and respects the prefix boundary', async () => {
      const s = await make();
      const w = s.work;
      // Two organizations whose ids are prefixes of one another — 'acme' must never take 'acme2'.
      // This is the boundary that decides whether an erasure is legally usable, so it is asserted
      // on every backend rather than assumed from the in-memory one.
      await w.append('org:acme:events:order', { id: 1 }, 'e1');
      await w.append('org:acme:jobs:mail', { id: 2 }, 'j1');
      await w.append('org:acme2:events:order', { id: 3 }, 'e2');
      await w.append('other:events:order', { id: 4 }, 'e3');
      await w.put('org:acme:qdone:j1', true);
      await w.put('org:acme2:qdone:j9', true);
      await w.put('other:qdone:j9', true);

      const removed = await w.deletePrefix!('org:acme:');
      expect(removed).toBeGreaterThanOrEqual(3); // 2 log records + 1 kv (adapters may count more)

      expect((await w.list('org:acme:events:order')).items).toHaveLength(0);
      expect((await w.list('org:acme:jobs:mail')).items).toHaveLength(0);
      expect(await w.get('org:acme:qdone:j1')).toBeUndefined();
      // The neighbour org and the unprefixed deployment are untouched.
      expect((await w.list('org:acme2:events:order')).items).toHaveLength(1);
      expect(await w.get('org:acme2:qdone:j9')).toBe(true);
      expect((await w.list('other:events:order')).items).toHaveLength(1);
      expect(await w.get('other:qdone:j9')).toBe(true);
    });

    it('an erased namespace can be written again (delete, not tombstone)', async () => {
      const s = await make();
      const w = s.work;
      await w.append('org:acme:events:x', { v: 1 }, 'a');
      await w.deletePrefix!('org:acme:');
      await w.append('org:acme:events:x', { v: 2 }, 'a'); // same id, fresh log
      expect((await w.list('org:acme:events:x')).items).toHaveLength(1);
      // ackOnce is a CAS marker: after erasure the first ack must win again, or a re-created
      // organization would inherit the previous tenancy's "already handled" answers.
      expect(await w.ackOnce('org:acme:ack:1')).toBe(true);
      await w.deletePrefix!('org:acme:');
      expect(await w.ackOnce('org:acme:ack:1')).toBe(true);
    });
  });
}

describe('purgeOrganizationWork — the runbook half', () => {
  it('erases an org through the SCOPED storage the deployment actually writes through', async () => {
    const root = new InMemoryStorage();
    // withOrgStorage is how a deployment addresses one tenant; the purge is expressed on the ROOT
    // store, and this asserts the two agree about where the tenant's records live.
    const acme = withOrgStorage(root, 'acme');
    const other = withOrgStorage(root, 'acme2');
    await acme.work.append('events:order', { id: 1 }, 'e1');
    await acme.work.put('qdone:j1', true);
    await other.work.append('events:order', { id: 2 }, 'e2');

    const n = await purgeOrganizationWork(root.work, 'acme');
    expect(n).toBeGreaterThan(0);
    expect((await acme.work.list('events:order')).items).toHaveLength(0);
    expect(await acme.work.get('qdone:j1')).toBeUndefined();
    expect((await other.work.list('events:order')).items).toHaveLength(1);
  });

  it('THROWS on a WorkStore without deletePrefix — an erasure may not report a silent success', async () => {
    const bare = { append: async () => 'x', list: async () => ({ items: [] }), get: async () => undefined, put: async () => {}, ackOnce: async () => true };
    await expect(purgeOrganizationWork(bare as never, 'acme')).rejects.toThrow(/deletePrefix/);
  });

  it("rejects an org id containing ':' — the same boundary rule as the journal half", async () => {
    const root = new InMemoryStorage();
    await expect(purgeOrganizationWork(root.work, 'a:b')).rejects.toThrow(/must not contain/);
  });

  it('journal half + work half together leave nothing of the organization', async () => {
    const root = new InMemoryStorage();
    const acme = withOrgStorage(root, 'acme');
    const journal = toJournal(acme.runs);
    await journal.put('r1:model:0', { hello: 'world' });
    await acme.work.append('jobs:mail', { to: 'a@b' }, 'j1');
    await acme.work.put('qdone:j1', true);

    await purgeOrganization(toJournal(root.runs), 'acme');
    await purgeOrganizationWork(root.work, 'acme');

    expect(await journal.get('r1:model:0')).toBeUndefined();
    expect((await acme.work.list('jobs:mail')).items).toHaveLength(0);
    expect(await acme.work.get('qdone:j1')).toBeUndefined();
  });
});
