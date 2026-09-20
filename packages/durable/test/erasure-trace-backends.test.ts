// The ownership trace (`resthr:<person>:<thread>`) is what lets an erasure request reach a thread
// whose runs retention already deleted. Its two halves are pure ADAPTER behaviour — a prefix scan
// and a prefix delete — so they are measured on every storage rather than argued from one.
//
// The neighbour row is the point of the matrix. `resthr:p-1:` and `resthr:p-1X:` differ by one
// character at the boundary, which is exactly the shape a range scan gets wrong: erasing one person
// must not touch the next one along. A backend that implements listKeys as `LIKE prefix || '%'`
// without escaping, or as a range with the wrong upper bound, passes every single-tenant test and
// fails this one.
import { describe, it, expect } from 'vitest';
import { newDb } from 'pg-mem';
import { InMemoryStorage, RedisStorage, toJournal } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { makeFakeRedis } from './fake-redis.js';
import { purgeResource } from '../src/retention.js';

const backends: [string, () => Promise<any>][] = [
  ['InMemoryStorage', async () => toJournal(new InMemoryStorage().runs)],
  ['PostgresStorage(pg-mem)', async () => { const { Pool } = newDb().adapters.createPg(); const s = new PostgresStorage({ pool: new Pool() }); await (s as any).init?.(); return toJournal(s.runs); }],
  ['RedisStorage(fake)', async () => toJournal(new RedisStorage({ client: makeFakeRedis() }).runs)],
];
try {
  const probe = new SqliteStorage();
  (probe as any).close?.();
  backends.splice(1, 0, ['SqliteStorage', async () => { const s = new SqliteStorage(':memory:'); await (s as any).init?.(); return toJournal(s.runs); }]);
} catch {
  // node:sqlite unavailable → the row is skipped, visibly, rather than silently shrinking the matrix.
}

for (const [name, make] of backends) {
  describe(`erasure through the ownership trace — ${name}`, () => {
    it('follows the trace to the thread, erases the trace too, and stops at the next person', async () => {
      const j = await make();
      // A threadId containing ':' — the key is `resthr:<person>:<thread>` and everything after the
      // person's boundary is the threadId, colons and all.
      await j.put('resthr:p-1:th:a', { at: 1 });
      await j.put('xthr:th:a:sem-pay-h1', { v: 1, canonical: 'pay: iban-tr55' });
      // The neighbour whose id EXTENDS the purged one.
      await j.put('resthr:p-1X:other', { at: 1 });
      await j.put('xthr:other:sem-pay-h2', { v: 1, canonical: 'pay: someone-else' });

      await purgeResource(j, 'p-1');

      expect(await j.listKeys('xthr:th:a:'), "the person's own argument survived their erasure request").toEqual([]);
      expect(await j.listKeys('resthr:p-1:'), 'the trace names a person and must not outlive them').toEqual([]);
      expect((await j.listKeys('resthr:p-1X:')).length, 'erasing one person swept the next one along').toBe(1);
      expect((await j.listKeys('xthr:other:')).length).toBe(1);
    });
  });
}
