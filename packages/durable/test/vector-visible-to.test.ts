// `visibleTo` — one rule, every vector store: an end user is answered from the general shelf and their
// own, never another user's and never an unlabelled document. Run against each implementation, because
// the rule lives in each (SQL in two, code in the rest) and a store that silently ignores an option it
// does not know would still type-check.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newDb } from 'pg-mem';
import { InMemoryStorage, withOrgStorage } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { InMemoryVectorStore, GraphRag } from '../../rag/src/index.js';
import type { VectorItem, VectorMatch, VectorQueryOptions } from '../src/storage.js';

type Store = { upsert(i: VectorItem[]): Promise<void>; query(e: number[], k: number, o?: VectorQueryOptions): Promise<VectorMatch[]> };

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const sqlitePath = () => { const d = mkdtempSync(join(tmpdir(), 'gnl-vis-')); dirs.push(d); return join(d, 't.db'); };

const STORES: Array<[string, () => Store]> = [
  ['InMemoryStorage', () => new InMemoryStorage().vectors!],
  ['SqliteStorage', () => new SqliteStorage(sqlitePath()).vectors!],
  ['PostgresStorage', () => new PostgresStorage({ pool: new (newDb().adapters.createPg().Pool)() } as never).vectors!],
  ['withOrgStorage', () => withOrgStorage(new InMemoryStorage(), 'acme').vectors!],
  ['rag InMemoryVectorStore', () => new InMemoryVectorStore()],
  ['rag GraphRag', () => new GraphRag({ threshold: 0.6, hops: 1, decay: 0.8, seeds: 2 })],
];

const Q = [1, 0, 0];
// Ayşe's documents sit CLOSER to the query than Mehmet's: a store that ranked first and filtered after
// would hand Mehmet fewer than he asked for, so the count below is part of the assertion.
const CORPUS: VectorItem[] = [
  { id: 'a1', text: 'ayse-1', owner: 'ayse', embedding: [1, 0, 0] },
  { id: 'a2', text: 'ayse-2', owner: 'ayse', embedding: [0.99, 0.14, 0] },
  { id: 'm1', text: 'mehmet-1', owner: 'mehmet', embedding: [0.8, 0.6, 0] },
  { id: 'g1', text: 'general-1', shared: true, embedding: [0.7, 0.71, 0] },
  { id: 'u1', text: 'untagged-1', embedding: [0.98, 0.2, 0] },
];
const ids = (ms: VectorMatch[]) => ms.map((m) => m.id).sort();

describe.each(STORES)('%s', (_name, make) => {
  it('an end user gets the general shelf and their own — the full count, not what survived a global top K', async () => {
    const s = make();
    await s.upsert(CORPUS);
    expect(ids(await s.query(Q, 2, { visibleTo: 'mehmet' }))).toEqual(['g1', 'm1']);
    expect(ids(await s.query(Q, 10, { visibleTo: 'ayse' }))).toEqual(['a1', 'a2', 'g1']);
  });

  it('an unlabelled document is nobody\'s, and a stranger sees only the general shelf', async () => {
    const s = make();
    await s.upsert(CORPUS);
    expect(ids(await s.query(Q, 10, { visibleTo: 'nobody-here' }))).toEqual(['g1']);
  });

  it('no end user, no narrowing', async () => {
    const s = make();
    await s.upsert(CORPUS);
    expect(ids(await s.query(Q, 10))).toEqual(['a1', 'a2', 'g1', 'm1', 'u1']);
  });

  it('the label comes back with the match', async () => {
    const s = make();
    await s.upsert(CORPUS);
    const got = Object.fromEntries((await s.query(Q, 10)).map((m) => [m.id, { owner: m.owner, shared: m.shared }]));
    expect(got.a1).toEqual({ owner: 'ayse', shared: undefined });
    expect(got.g1).toEqual({ owner: undefined, shared: true });
  });
});

describe('GraphRag: the walk cannot carry another user\'s document', () => {
  it('a neighbour strongly linked to a visible hit stays out when it is not yours', async () => {
    const g = new GraphRag({ threshold: 0.6, hops: 1, decay: 0.8, seeds: 2 });
    await g.upsert([
      { id: 'bridge', text: 'general bridge', shared: true, embedding: [0.7, 0.7, 0] },
      { id: 'far', text: 'ayse only via walk', owner: 'ayse', embedding: [0, 1, 0] },
    ]);
    expect(ids(await g.query(Q, 10))).toEqual(['bridge', 'far']); // the edge is real
    expect(ids(await g.query(Q, 10, { visibleTo: 'mehmet' }))).toEqual(['bridge']);
  });
});

describe('an existing SQLite file, the morning of the upgrade', () => {
  it('gains the columns, and its old rows are unlabelled: visible to staff, to no end user', async () => {
    const path = sqlitePath();
    const seed = new SqliteStorage(path);
    const db = (seed as unknown as { db: { exec(s: string): void; prepare(s: string): { run(...a: unknown[]): unknown } } }).db;
    db.exec('DROP TABLE IF EXISTS gnl_vectors');
    db.exec('CREATE TABLE gnl_vectors (id TEXT PRIMARY KEY, text TEXT NOT NULL, embedding TEXT NOT NULL, metadata TEXT, namespace TEXT, created_at INTEGER NOT NULL)');
    db.prepare('INSERT INTO gnl_vectors (id, text, embedding, metadata, namespace, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('old', 'old doc', '[1,0,0]', null, null, Date.now());
    (seed as unknown as { close?(): void }).close?.();

    const s = new SqliteStorage(path).vectors!;
    await s.upsert([{ id: 'new', text: 'new doc', shared: true, embedding: [1, 0, 0] }]);
    expect(ids(await s.query(Q, 10))).toEqual(['new', 'old']);
    expect(ids(await s.query(Q, 10, { visibleTo: 'mehmet' }))).toEqual(['new']);
  });
});
