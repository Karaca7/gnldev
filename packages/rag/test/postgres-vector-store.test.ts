// @gnldev/rag PostgresVectorStore — since pg-mem doesn't support pgvector (no vector type/<=>),
// two layers: (1) adapter glue via fakePool (SQL/params/result + cosine in JS), (2) env-gated real DB.
import { describe, it, expect } from 'vitest';
import { PostgresVectorStore, type PoolLike } from '../src/postgres-vector-store.js';
import { indexDocuments } from '../src/index.js';

// Fake pool that mimics pgvector: captures the SQL, keeps the embedding in memory, uses JS cosine instead of <=>.
function fakePool(): PoolLike {
  const rows: { id: string; text: string; embedding: number[]; metadata: string | null }[] = [];
  return {
    async query(sql: string, params: unknown[] = []) {
      if (/CREATE\s+(EXTENSION|TABLE|INDEX)/i.test(sql)) return { rows: [] };
      if (/^\s*INSERT\s+INTO/i.test(sql)) {
        const [id, text, vec, metadata] = params as [string, string, string, string | null];
        const embedding = JSON.parse(vec) as number[];
        const existing = rows.find((r) => r.id === id);
        if (existing) {
          existing.text = text;
          existing.embedding = embedding;
          existing.metadata = metadata;
        } else {
          rows.push({ id, text, embedding, metadata });
        }
        return { rows: [] };
      }
      if (/ORDER\s+BY\s+embedding/i.test(sql)) {
        const [vec, topK] = params as [string, number];
        const q = JSON.parse(vec) as number[];
        const scored = rows
          .map((r) => ({ id: r.id, text: r.text, metadata: r.metadata, score: cosine(q, r.embedding) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, topK);
        return { rows: scored };
      }
      return { rows: [] };
    },
  };
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! ** 2;
    nb += b[i]! ** 2;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

describe('PostgresVectorStore (fakePool)', () => {
  it('upsert + query: nearest neighbor + score ordering', async () => {
    const store = new PostgresVectorStore({ pool: fakePool() });
    await store.upsert([
      { id: 'a', text: 'cat', embedding: [1, 0, 0] },
      { id: 'b', text: 'dog', embedding: [0, 1, 0] },
      { id: 'c', text: 'car', embedding: [0, 0, 1] },
    ]);
    const res = await store.query([1, 0, 0], 2);
    expect(res).toHaveLength(2);
    expect(res[0]!.id).toBe('a');
    expect(res[0]!.score).toBeGreaterThan(res[1]!.score);
  });

  it('ON CONFLICT: re-upsert of the same id updates it (no duplicate)', async () => {
    const store = new PostgresVectorStore({ pool: fakePool() });
    await store.upsert([{ id: 'a', text: 'old', embedding: [1, 0] }]);
    await store.upsert([{ id: 'a', text: 'new', embedding: [0, 1] }]);
    const res = await store.query([0, 1], 5);
    expect(res).toHaveLength(1);
    expect(res[0]!.text).toBe('new');
  });

  it('metadata round-trip (JSONB)', async () => {
    const store = new PostgresVectorStore({ pool: fakePool() });
    await store.upsert([{ id: 'a', text: 't', embedding: [1, 0], metadata: { src: 'doc1', n: 3 } }]);
    const res = await store.query([1, 0], 1);
    expect(res[0]!.metadata).toEqual({ src: 'doc1', n: 3 });
  });

  it('topK limit is applied', async () => {
    const store = new PostgresVectorStore({ pool: fakePool() });
    await store.upsert([
      { id: 'a', text: 'a', embedding: [1, 0] },
      { id: 'b', text: 'b', embedding: [0.9, 0.1] },
      { id: 'c', text: 'c', embedding: [0, 1] },
    ]);
    expect(await store.query([1, 0], 1)).toHaveLength(1);
    expect(await store.query([1, 0], 2)).toHaveLength(2);
  });

  it('empty upsert is a no-op', async () => {
    const store = new PostgresVectorStore({ pool: fakePool() });
    await store.upsert([]);
    expect(await store.query([1, 0], 5)).toHaveLength(0);
  });

  it('drop-in with indexDocuments (in place of InMemoryVectorStore)', async () => {
    const store = new PostgresVectorStore({ pool: fakePool() });
    const embed = async (t: string) => [t.includes('cat') ? 1 : 0, t.includes('car') ? 1 : 0];
    await indexDocuments(store, embed, [
      { id: 'd1', text: 'cat food' },
      { id: 'd2', text: 'car tire' },
    ]);
    const res = await store.query(await embed('where is the cat'), 1);
    expect(res[0]!.id).toBe('d1');
  });
});

// Real pgvector integration — only runs if GNL_PGVECTOR_URL is given (SKIP by default).
const REAL = process.env.GNL_PGVECTOR_URL;
describe.skipIf(!REAL)('PostgresVectorStore — real pgvector (env-gated)', () => {
  it('upsert + query nearest neighbor with real <=>', async () => {
    const store = new PostgresVectorStore({ connectionString: REAL, table: 'gnl_vectors_test' });
    await store.upsert([
      { id: 'a', text: 'cat', embedding: [1, 0, 0], metadata: { k: 1 } },
      { id: 'b', text: 'car', embedding: [0, 0, 1] },
    ]);
    const res = await store.query([1, 0, 0], 1);
    expect(res[0]!.id).toBe('a');
    expect(res[0]!.metadata).toEqual({ k: 1 });
    await store.close();
  });
});

// A connection dropped during setup must not be permanent. `ensureReady` memoises its promise so
// the DDL runs once per store — but memoising a REJECTED promise makes one bad moment final: every
// later call replays that dead error against a database that recovered long ago. Found on the
// durable side first (a real Postgres failover in CI), then here by looking for the same shape.
describe('setup interrupted by a dropped connection', () => {
  function flakyPool(failFirstDdl: { n: number }): PoolLike {
    const inner = fakePool();
    return {
      async query(sql: string, params: unknown[] = []) {
        if (/CREATE\s+(EXTENSION|TABLE|INDEX)/i.test(sql) && failFirstDdl.n > 0) {
          failFirstDdl.n--;
          throw Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' });
        }
        return inner.query(sql, params);
      },
    };
  }

  it('retries the DDL on the next call instead of replaying the old error forever', async () => {
    const budget = { n: 1 };                    // exactly one DDL failure, then the backend is fine
    const store = new PostgresVectorStore({ pool: flakyPool(budget) });
    const item = [{ id: 'a', text: 'hello', embedding: [1, 0, 0], metadata: {} }];

    await expect(store.upsert(item)).rejects.toThrow(/terminating connection/);
    expect(budget.n, 'the DDL never ran — the test proved nothing').toBe(0);

    // Same store, healthy backend. Before the fix this threw the identical error, forever.
    await expect(store.upsert(item)).resolves.toBeUndefined();
    const res = await store.query([1, 0, 0], 1);
    expect(res[0]?.id, 'the retry set the table up but the write did not land').toBe('a');
    await store.close();
  });
});
