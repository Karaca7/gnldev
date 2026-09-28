// THE VECTOR WRITE RULE, one contract, every store (R19).
//
// The same input goes to every VectorStore in the repository, and every store must give the SAME
// answer — the one written in each scenario, not merely each other's. Before the rule lived in one
// place (storage.ts: vectorWriteBatch / assertSameVectorOwner / vectorQueryScope / vectorDeletePlan,
// orgVectorId + vectorAdoptCollision for adoption), measured on this input:
//   one batch, id `x` under alice then bob  → memory: bob's; SQLite: refused after alice's half was
//                                              written; Postgres (pg-mem): "ok", alice's, bob's dropped
//   adopt with `d1` legacy + acme's own `d1` → memory: TWO documents `d1` for acme; SQL: raw UNIQUE error
//
// Stores: durable InMemory / SQLite / Postgres (pg-mem), rag InMemoryVectorStore / GraphRag. With
// GNL_PG_URL, durable Postgres on a real server too; with GNL_PGVECTOR_URL, rag PostgresVectorStore.
import { describe, it, expect, afterAll } from 'vitest';
import { newDb } from 'pg-mem';
import pg from 'pg';
import { InMemoryStorage, withOrgStorage, type VectorStore, type VectorDeleteWhere } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { InMemoryVectorStore, GraphRag, PostgresVectorStore } from '../../rag/src/index.js';

const E = [1, 0, 0];
const PG_URL = process.env.GNL_PG_URL;
const PGVECTOR_URL = process.env.GNL_PGVECTOR_URL;

// Real-server stores get a schema of their own, dropped at the end, so the contract never sees or
// leaves another test's rows.
const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => { for (const c of cleanups) await c(); });
let schemas = 0;
async function realPool(url: string, pgvector = false): Promise<pg.Pool> {
  const schema = `vcontract_${process.pid}_${Date.now().toString(36)}_${schemas++}`;
  const admin = new pg.Pool({ connectionString: url, max: 1 });
  // In `public`, once: created by the store under this search_path, the type would live in (and be
  // dropped with) the first test's schema.
  if (pgvector) await admin.query('CREATE EXTENSION IF NOT EXISTS vector SCHEMA public');
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: url, max: 4, options: `-c search_path=${schema},public` });
  cleanups.push(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  return pool;
}

type Durable = InMemoryStorage | SqliteStorage | PostgresStorage;
type Store = { name: string; vectors: () => Promise<VectorStore>; storage?: () => Promise<Durable> };

const durable = (name: string, mk: () => Promise<Durable>): Store => ({ name, storage: mk, vectors: async () => (await mk()).vectors! });
const STORES: Store[] = [
  durable('durable InMemory', async () => new InMemoryStorage()),
  durable('durable SQLite', async () => new SqliteStorage(':memory:')),
  durable('durable Postgres (pg-mem)', async () => new PostgresStorage({ pool: new (newDb().adapters.createPg().Pool)() })),
  { name: 'rag InMemoryVectorStore', vectors: async () => new InMemoryVectorStore() as VectorStore },
  { name: 'rag GraphRag', vectors: async () => new GraphRag({ threshold: 0.6 }) as VectorStore },
  ...(PG_URL ? [durable('durable Postgres (real)', async () => new PostgresStorage({ pool: await realPool(PG_URL) }))] : []),
  ...(PGVECTOR_URL ? [{ name: 'rag PostgresVectorStore (real)', vectors: async () => new PostgresVectorStore({ pool: await realPool(PGVECTOR_URL, true), index: 'none' }) as VectorStore }] : []),
];

/** What a call did, as a comparable string: `ok:<value>` or the error's name. */
async function outcome(f: () => Promise<unknown>): Promise<string> {
  try { const r = await f(); return `ok:${JSON.stringify(r ?? null)}`; } catch (e) { return `throw:${(e as Error).name}`; }
}
/** Every stored document, as `id/owner[/S]=text`, sorted — the whole store, not a query's view of it. */
async function all(s: VectorStore, opts?: Parameters<VectorStore['query']>[2]): Promise<string> {
  return (await s.query(E, 100, opts)).map((m) => `${m.id}/${m.owner ?? '-'}${m.shared ? '/S' : ''}=${m.text}`).sort().join(',');
}
const doc = (id: string, labels: { owner?: string; shared?: boolean; namespace?: string } = {}, text = id) => ({ id, text, embedding: E, ...labels });

describe.each(STORES)('vector write rule — $name', (store) => {
  it('labels: every refused label refuses the upsert, and nothing is written', async () => {
    const s = await store.vectors();
    const bad: Array<[string, unknown]> = [
      ['shared "false"', { shared: 'false' }],
      ['owner ""', { owner: '' }],
      ['owner reserved', { owner: 'operator:ops' }],
      ['owner too long', { owner: 'x'.repeat(201) }],
      ['owner control char', { owner: 'bob\n' }],
      ['owner lone surrogate', { owner: 'u\uD800' }],
      ['namespace ""', { namespace: '' }],
    ];
    const got = [];
    for (const [what, labels] of bad) got.push(`${what}: ${await outcome(() => s.upsert([doc('ok1'), { ...doc('d'), ...(labels as object) }]))}`);
    expect(got).toEqual([
      'shared "false": throw:TypeError',
      'owner "": throw:OwnerIdError',
      'owner reserved: throw:OwnerIdError',
      'owner too long: throw:OwnerIdError',
      'owner control char: throw:OwnerIdError',
      'owner lone surrogate: throw:OwnerIdError',
      'namespace "": throw:TypeError',
    ]);
    expect(await all(s)).toBe('');
  });

  it('conflict: an upsert updates a document, it never hands it to another owner or label', async () => {
    const s = await store.vectors();
    await s.upsert([doc('d1', { owner: 'alice', namespace: 'n' }, 'alice-v1'), doc('s1', { shared: true }), doc('f1', { owner: 'alice', shared: false })]);
    expect(await outcome(() => s.upsert([doc('d1', { owner: 'bob', namespace: 'n' }, 'bob')]))).toBe('throw:VectorOwnerConflictError');
    expect(await outcome(() => s.upsert([doc('d1', { owner: 'alice' }, 'moved')]))).toBe('throw:VectorOwnerConflictError');
    expect(await outcome(() => s.upsert([doc('s1', { owner: 'alice' }, 'mine')]))).toBe('throw:VectorOwnerConflictError');
    expect(await outcome(() => s.upsert([doc('d1', { owner: 'alice', namespace: 'n' }, 'alice-v2')]))).toBe('ok:null');
    // `shared: false` and no `shared` are one label.
    expect(await outcome(() => s.upsert([doc('f1', { owner: 'alice' }, 'f1-v2')]))).toBe('ok:null');
    expect(await all(s)).toBe('d1/alice=alice-v2,f1/alice=f1-v2,s1/-/S=s1');
  });

  it('V1: one batch naming one id under two owners is refused whole — nobody gets it', async () => {
    const s = await store.vectors();
    expect(await outcome(() => s.upsert([doc('x', { owner: 'alice' }, 'a'), doc('x', { owner: 'bob' }, 'b')]))).toBe('throw:VectorOwnerConflictError');
    expect(await all(s)).toBe('');
    // Sibling: the same id twice under the SAME labels is one document, the last copy.
    expect(await outcome(() => s.upsert([doc('y', { owner: 'alice' }, 'first'), doc('y', { owner: 'alice' }, 'last')]))).toBe('ok:null');
    expect(await all(s)).toBe('y/alice=last');
  });

  it('half-batch: a batch refused on its last document writes none of it', async () => {
    const s = await store.vectors();
    await s.upsert([doc('d1', { owner: 'alice' })]);
    expect(await outcome(() => s.upsert([doc('n1', { owner: 'bob' }), doc('n2', { shared: true }), doc('d1', { owner: 'bob' })]))).toBe('throw:VectorOwnerConflictError');
    expect(await all(s)).toBe('d1/alice=d1');
  });

  it('visibleTo: theirs and the shared shelf; SHARED_ONLY and an id no document can carry read the shelf only', async () => {
    const s = await store.vectors();
    await s.upsert([doc('a1', { owner: 'alice', namespace: 'n' }), doc('b1', { owner: 'bob', namespace: 'n' }), doc('s1', { shared: true, namespace: 'n' }), doc('u1', { namespace: 'n' }), doc('r1', { owner: 'u\uFFFD', namespace: 'n' })]);
    expect(await all(s, { visibleTo: 'alice' })).toBe('a1/alice=a1,s1/-/S=s1');
    expect(await all(s, { visibleTo: '' })).toBe('s1/-/S=s1');
    // `u\uD800` names nobody; Postgres would compare it as U+FFFD and answer with r1.
    expect(await all(s, { visibleTo: 'u\uD800' })).toBe('s1/-/S=s1');
    expect(await all(s, { namespace: 'n', visibleTo: 'bob' })).toBe('b1/bob=b1,s1/-/S=s1');
    expect(await all(s, { namespace: 'other' })).toBe('');
    expect(await all(s, { namespace: '' })).toBe('');
    expect(await all(s)).toBe('a1/alice=a1,b1/bob=b1,r1/u\uFFFD=r1,s1/-/S=s1,u1/-=u1');
  });

  it('delete: no condition removes nothing; every given condition must match; a lone surrogate names nobody', async () => {
    const s = await store.vectors();
    await s.upsert([doc('a1', { owner: 'alice', namespace: 'n' }), doc('a2', { owner: 'alice' }), doc('b1', { owner: 'bob', namespace: 'n' }), doc('s1', { shared: true, namespace: 'n' }), doc('r1', { owner: 'u\uFFFD' })]);
    const del = (w: unknown) => outcome(() => s.delete!(w as VectorDeleteWhere));
    expect([await del({}), await del({ ids: [] }), await del({ filter: {} }), await del({ ids: ['a\uD800'] }), await del({ owner: 'u\uD800' })])
      .toEqual(['ok:0', 'ok:0', 'ok:0', 'ok:0', 'ok:0']);
    expect(await del({ ids: ['a1'], owner: 'bob' })).toBe('ok:0');
    await s.upsert([doc('t1'), doc('t2'), doc('t3')]);
    expect(await del({ ids: ['t1', 't2', 'nope'] })).toBe('ok:2');
    expect(await del({ ids: ['t3'] })).toBe('ok:1');
    expect(await del({ owner: 'alice', namespace: 'n' })).toBe('ok:1');
    expect(await del({ owner: 'alice' })).toBe('ok:1');
    expect(await del({ namespace: 'n' })).toBe('ok:2');
    expect(await all(s)).toBe('r1/u\uFFFD=r1');
  });

  it('filter: metadata narrows a query before ranking and a delete to exactly its matches', async () => {
    const s = await store.vectors();
    const m = (id: string, owner: string, k: number) => ({ ...doc(id, { owner }), metadata: { k } });
    await s.upsert([m('a1', 'alice', 1), m('a2', 'alice', 2), m('b1', 'bob', 1)]);
    expect(await all(s, { filter: { k: 1 } })).toBe('a1/alice=a1,b1/bob=b1');
    expect((await s.query(E, 1, { visibleTo: 'alice', filter: { k: 2 } })).map((x) => x.id)).toEqual(['a2']);
    const del = (w: unknown) => outcome(() => s.delete!(w as VectorDeleteWhere));
    // A filter is a condition: it narrows, it never widens — `{ filter, owner }` is not "all of owner's".
    expect(await del({ filter: { k: 1 }, owner: 'alice' })).toBe('ok:1');
    expect(await del({ filter: { k: 9 } })).toBe('ok:0');
    expect(await del({ filter: { k: 1 } })).toBe('ok:1');
    expect(await all(s)).toBe('a2/alice=a2');
  });

  it('a stored document is a copy: changing the item after the upsert changes nothing', async () => {
    const s = await store.vectors();
    const item = { ...doc('m1', { owner: 'alice' }, 'orig'), metadata: { k: 'orig' } };
    await s.upsert([item]);
    item.text = 'changed'; item.metadata.k = 'changed'; item.owner = 'bob';
    const [m] = await s.query(E, 1);
    expect([m!.text, m!.owner, m!.metadata]).toEqual(['orig', 'alice', { k: 'orig' }]);
  });
});

describe.each(STORES.filter((s) => s.storage))('adopt rename — $name', (store) => {
  it('A1: a legacy id the organization already uses refuses the adoption, and nothing moves', async () => {
    const root = await store.storage!();
    await withOrgStorage(root, 'acme').vectors!.upsert([{ id: 'd1', text: 'ACME-OWN', shared: true, embedding: E }]);
    await root.vectors!.upsert([{ id: 'd1', text: 'LEGACY', shared: true, embedding: E }]);
    await root.runs.put('job:1', { v: 1 });
    expect(await outcome(() => root.adoptIntoOrg('acme', { allowUnregistered: true, dryRun: true }))).toBe('throw:VectorOwnerConflictError');
    expect(await outcome(() => root.adoptIntoOrg('acme', { allowUnregistered: true }))).toBe('throw:VectorOwnerConflictError');
    expect(await all(withOrgStorage(root, 'acme').vectors!)).toBe('d1/-/S=ACME-OWN');
    expect((await root.vectors!.query(E, 10)).map((m) => `${m.id}|${m.namespace ?? '-'}`).sort()).toEqual(['d1|-', 'org:acme:d1|org:acme']);
    // Sibling: the journal row was not moved either — the vectors are checked before anything moves.
    expect(await root.runs.get('job:1')).toEqual({ v: 1 });
  });

  it('A1 sibling: without a clash the adopted document keeps its id, and the next upsert updates it', async () => {
    const root = await store.storage!();
    await root.vectors!.upsert([{ id: 'd2', text: 'LEGACY', shared: true, embedding: E }]);
    const r = await root.adoptIntoOrg('acme', { allowUnregistered: true });
    expect(r.moved.vectors).toBe(1);
    const acme = withOrgStorage(root, 'acme').vectors!;
    await acme.upsert([{ id: 'd2', text: 'UPDATED', shared: true, embedding: E }]);
    expect(await all(acme)).toBe('d2/-/S=UPDATED');
    expect(await all(root.vectors!, { namespace: 'org:acme' })).toBe('org:acme:d2/-/S=UPDATED');
  });
});

// pg-mem cannot show this (its ROLLBACK undoes nothing, and it does not interleave), so only a real
// server can: a writer that takes an id AFTER a batch was checked makes the batch fail half-way, and
// what the batch wrote before that point must go with it.
const RACERS = STORES.filter((s) => s.name.includes('(real)'));
describe.skipIf(RACERS.length === 0).each(RACERS.length ? RACERS : STORES.slice(0, 1))('half-batch under a racing writer — $name', (store) => {
  it('a batch refused because another writer took one of its ids leaves none of itself behind', async () => {
    const v = await store.vectors();
    let refused = 0;
    let halves = 0;
    for (let i = 0; i < 40; i++) {
      const [batch] = await Promise.allSettled([
        v.upsert([doc(`n${i}`, { owner: 'bob' }), doc(`m${i}`, { owner: 'bob' }), doc(`x${i}`, { owner: 'bob' })]),
        v.upsert([doc(`x${i}`, { owner: 'carol' })]),
      ]);
      if (batch.status === 'rejected') {
        refused++;
        const left = (await v.query(E, 1000)).filter((m) => m.id === `n${i}` || m.id === `m${i}`);
        if (left.length) halves++;
      }
    }
    // Reported, not asserted: how often this machine actually hit the race.
    console.log(`[${store.name}] batches refused by the racing writer: ${refused}/40, half-written: ${halves}`);
    expect(halves).toBe(0);
  });
});
