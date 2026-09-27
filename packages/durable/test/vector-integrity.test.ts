// A document stays whose it is. Found by the isolation audit, all measured:
//  - ids were one global space: globex upserting `doc-1` replaced acme's `doc-1` (the scaffold's own
//    example id), and Mallory upserting Ayşe's id took her document over;
//  - a label from untyped input (`shared: "false"`) read as "shared" in the SQL stores only;
//  - erasing a person left their documents behind: there was no way to delete by owner.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newDb } from 'pg-mem';
import { InMemoryStorage, withOrgStorage, purgeResource, toJournal } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { InMemoryVectorStore, GraphRag } from '../../rag/src/index.js';
import type { Storage, VectorItem, VectorMatch, VectorQueryOptions } from '../src/storage.js';

type Store = {
  upsert(i: VectorItem[]): Promise<void>;
  query(e: number[], k: number, o?: VectorQueryOptions): Promise<VectorMatch[]>;
  delete?(w: { ids?: string[]; owner?: string; namespace?: string }): Promise<number>;
};

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const sqlitePath = () => { const d = mkdtempSync(join(tmpdir(), 'gnl-vi-')); dirs.push(d); return join(d, 't.db'); };

const STORAGES: Array<[string, () => Storage]> = [
  ['InMemoryStorage', () => new InMemoryStorage()],
  ['SqliteStorage', () => new SqliteStorage(sqlitePath())],
  ['PostgresStorage', () => new PostgresStorage({ pool: new (newDb().adapters.createPg().Pool)() } as never)],
];
const STORES: Array<[string, () => Store]> = [
  ...STORAGES.map(([n, mk]) => [n, () => mk().vectors!] as [string, () => Store]),
  ['rag InMemoryVectorStore', () => new InMemoryVectorStore()],
  ['rag GraphRag', () => new GraphRag({ threshold: 0.6 })],
];
const Q = [1, 0, 0];
// Matched by code, which is what a caller branches on: the rag stores throw the class from @gnldev/durable's
// build, this file imports its source, and two copies of one class are not `instanceof` each other.
const CONFLICT = { code: 'vector_owner_conflict', name: 'VectorOwnerConflictError' };
const texts = (ms: VectorMatch[]) => ms.map((m) => m.text).sort();

describe.each(STORES)('%s', (_n, make) => {
  it('one user cannot take over another\'s document, or replace a shared one', async () => {
    const s = make();
    await s.upsert([{ id: 'inv', text: 'AYSE', owner: 'ayse', embedding: Q }, { id: 'hb', text: 'HANDBOOK', shared: true, embedding: Q }]);
    await expect(s.upsert([{ id: 'inv', text: 'MALLORY', owner: 'mallory', embedding: Q }])).rejects.toMatchObject(CONFLICT);
    await expect(s.upsert([{ id: 'hb', text: 'MINE NOW', owner: 'mallory', embedding: Q }])).rejects.toMatchObject(CONFLICT);
    expect(texts(await s.query(Q, 10))).toEqual(['AYSE', 'HANDBOOK']);
  });

  it('the owner updates her own document', async () => {
    const s = make();
    await s.upsert([{ id: 'inv', text: 'v1', owner: 'ayse', embedding: Q }]);
    await s.upsert([{ id: 'inv', text: 'v2', owner: 'ayse', embedding: Q }]);
    expect(texts(await s.query(Q, 10))).toEqual(['v2']);
  });

  it('a label must be a label: shared is true or absent, owner a non-empty string', async () => {
    const s = make();
    await expect(s.upsert([{ id: 'a', text: 'x', shared: 'false' as never, owner: 'ayse', embedding: Q }])).rejects.toThrow(TypeError);
    await expect(s.upsert([{ id: 'b', text: 'x', owner: 42 as never, embedding: Q }])).rejects.toThrow(TypeError);
    await expect(s.upsert([{ id: 'c', text: 'x', owner: '', embedding: Q }])).rejects.toThrow(TypeError);
    expect(await s.query(Q, 10)).toEqual([]);
  });

  it('delete by owner takes that person\'s documents and nothing else', async () => {
    const s = make();
    if (!s.delete) throw new Error('this store has no delete');
    await s.upsert([
      { id: 'a1', text: 'A1', owner: 'ayse', embedding: Q },
      { id: 'a2', text: 'A2', owner: 'ayse', embedding: Q },
      { id: 'm1', text: 'M1', owner: 'mallory', embedding: Q },
      { id: 'h', text: 'H', shared: true, embedding: Q },
    ]);
    expect(await s.delete({ owner: 'ayse' })).toBe(2);
    expect(texts(await s.query(Q, 10))).toEqual(['H', 'M1']);
  });
});

describe.each(STORAGES)('%s through withOrgStorage', (_n, make) => {
  it('two organizations with the same document id keep both', async () => {
    const root = make();
    const acme = withOrgStorage(root, 'acme').vectors!;
    const globex = withOrgStorage(root, 'globex').vectors!;
    await acme.upsert([{ id: 'doc-1', text: 'ACME', shared: true, embedding: Q }]);
    await globex.upsert([{ id: 'doc-1', text: 'GLOBEX', shared: true, embedding: Q }]);
    const a = await acme.query(Q, 10);
    expect(a.map((m) => [m.id, m.text])).toEqual([['doc-1', 'ACME']]);
    expect(texts(await globex.query(Q, 10))).toEqual(['GLOBEX']);
  });

  it('delete stays inside the organization', async () => {
    const root = make();
    const acme = withOrgStorage(root, 'acme').vectors!;
    const globex = withOrgStorage(root, 'globex').vectors!;
    await acme.upsert([{ id: 'x', text: 'ACME-AYSE', owner: 'ayse', embedding: Q }]);
    await globex.upsert([{ id: 'x', text: 'GLOBEX-AYSE', owner: 'ayse', embedding: Q }]);
    expect(await acme.delete!({ owner: 'ayse' })).toBe(1);
    expect(texts(await globex.query(Q, 10))).toEqual(['GLOBEX-AYSE']);
  });

  it('a document adopted into an organization is the same document afterwards', async () => {
    const root = make();
    await root.vectors!.upsert([{ id: 'doc-1', text: 'OLD', shared: true, embedding: Q }]);
    await root.adoptIntoOrg!('acme', { allowUnregistered: true } as never);
    const acme = withOrgStorage(root, 'acme').vectors!;
    await acme.upsert([{ id: 'doc-1', text: 'NEW', shared: true, embedding: Q }]);
    expect((await acme.query(Q, 10)).map((m) => [m.id, m.text])).toEqual([['doc-1', 'NEW']]);
  });
});

describe('erasing a person takes their documents', () => {
  it('purgeResource with the vector store', async () => {
    const storage = new InMemoryStorage();
    await storage.vectors!.upsert([{ id: 'a', text: 'A', owner: 'ayse', embedding: Q }, { id: 'h', text: 'H', shared: true, embedding: Q }]);
    await purgeResource(toJournal(storage.runs) as never, 'ayse', { vectors: storage.vectors! });
    expect(texts(await storage.vectors!.query(Q, 10))).toEqual(['H']);
  });
});
