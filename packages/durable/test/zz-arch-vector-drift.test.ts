// Architecture probe (not product test): feed the SAME inputs to every vector store, record answers.
import { describe, it, expect } from 'vitest';
import { newDb } from 'pg-mem';
import { InMemoryStorage } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { InMemoryVectorStore, GraphRag } from '../../rag/src/index.js';

const STORES: Array<[string, () => any]> = [
  ['durable InMemory', () => new InMemoryStorage().vectors!],
  ['durable Sqlite', () => new SqliteStorage(':memory:').vectors!],
  ['durable Postgres(pg-mem)', () => new PostgresStorage({ pool: new (newDb().adapters.createPg().Pool)() } as never).vectors!],
  ['rag InMemoryVectorStore', () => new InMemoryVectorStore()],
  ['rag GraphRag', () => new GraphRag({ threshold: 0.6 })],
];
const E = [1, 0, 0];
const res: Record<string, Record<string, string>> = {};
const rec = (store: string, k: string, v: unknown) => { (res[store] ??= {})[k] = typeof v === 'string' ? v : JSON.stringify(v); };
const tryIt = async (f: () => Promise<unknown>) => { try { const r = await f(); return 'ok:' + JSON.stringify(r ?? null); } catch (e: any) { return 'THROW:' + (e?.name ?? ''); } };
const ids = async (s: any, o?: any) => (await s.query(E, 10, o)).map((m: any) => `${m.id}/${m.owner ?? '-'}${m.shared ? '/S' : ''}`).sort().join(',');

describe('zz-arch vector drift', () => {
  for (const [name, mk] of STORES) {
    it(name, async () => {
      // V1: one batch, same id twice, two owners
      let s = mk();
      rec(name, 'V1 batch dup-id 2 owners', await tryIt(() => s.upsert([{ id: 'x', text: 'a', embedding: E, owner: 'alice' }, { id: 'x', text: 'b', embedding: E, owner: 'bob' }])));
      rec(name, 'V1 stored', await ids(s));
      // V2: cross-user id conflict (existence oracle)
      s = mk();
      await s.upsert([{ id: 'd1', text: 'a', embedding: E, owner: 'alice', namespace: 'n' }]);
      rec(name, 'V2 bob reuses alice id', await tryIt(() => s.upsert([{ id: 'd1', text: 'b', embedding: E, owner: 'bob', namespace: 'n' }])));
      // V3: namespace '' vs undefined
      s = mk();
      rec(name, 'V3 upsert ns=""', await tryIt(() => s.upsert([{ id: 'e1', text: 'a', embedding: E, namespace: '', shared: true }])));
      rec(name, 'V3 query ns=""', await ids(s, { namespace: '' }));
      // V4: delete shapes
      s = mk();
      await s.upsert([
        { id: 'a1', text: 'a', embedding: E, owner: 'alice', namespace: 'n' },
        { id: 'b1', text: 'b', embedding: E, owner: 'bob', namespace: 'n' },
        { id: 's1', text: 's', embedding: E, shared: true, namespace: 'n' },
        { id: 'u1', text: 'u', embedding: E, namespace: 'n' },
      ]);
      rec(name, 'V4 delete({})', await tryIt(() => s.delete({})));
      rec(name, 'V4 delete({ids:[]})', await tryIt(() => s.delete({ ids: [] })));
      rec(name, 'V4 delete({filter})', await tryIt(() => s.delete({ filter: { k: 1 } })));
      rec(name, 'V4 visibleTo alice', await ids(s, { visibleTo: 'alice' }));
      rec(name, 'V4 visibleTo ""', await ids(s, { visibleTo: '' }));
      rec(name, 'V4 delete({owner:alice})', await tryIt(() => s.delete({ owner: 'alice' })));
      rec(name, 'V4 after', await ids(s));
      // V5: same doc re-upserted with shared:false vs absent
      s = mk();
      await s.upsert([{ id: 'f1', text: 'a', embedding: E, owner: 'alice', shared: false }]);
      rec(name, 'V5 reupsert shared absent', await tryIt(() => s.upsert([{ id: 'f1', text: 'b', embedding: E, owner: 'alice' }])));
    });
  }
  it('print', () => {
    const keys = Object.keys(Object.values(res)[0]!);
    for (const k of keys) {
      const vals = Object.entries(res).map(([n, r]) => `${n}=${r[k]}`);
      const same = new Set(Object.values(res).map((r) => r[k])).size === 1;
      console.log(`${same ? 'SAME ' : 'DRIFT'} | ${k} | ${vals.join(' | ')}`);
    }
    expect(true).toBe(true);
  });
});
