import { createRequire } from 'node:module';
import type { VectorStore, VectorItem, VectorMatch, QueryOptions, DeleteWhere } from './vector-store.js';

/** Minimal pg.Pool surface — injectable for tests/custom setups (same pattern as PostgresJournal). */
export interface PoolLike {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
  end?: () => Promise<void>;
}

export interface PostgresVectorStoreOptions {
  /** pg connection string (a Pool is built from this if `pool` isn't given). */
  connectionString?: string;
  /** Bring your own `pg.Pool` (test/custom setup); if given, `pg` isn't imported. */
  pool?: PoolLike;
  /** Table name (default `gnl_vectors`). */
  table?: string;
  /** Embedding dimension; inferred from the first upsert/query vector if not given. */
  dimension?: number;
  /** Similarity index (default 'hnsw'); 'none' → no index is created. */
  index?: 'hnsw' | 'ivfflat' | 'none';
}

/**
 * Production VectorStore: Postgres + pgvector. SAME interface as `InMemoryVectorStore` → drop-in.
 * `pg` is an optional peer dependency; it's only loaded lazily via `createRequire` when `pool` isn't
 * given (bundlers can't see it statically). Single table: (id PK, text, embedding vector(dim), metadata jsonb, created_at).
 * Cosine: pgvector `<=>` distance; score = `1 - distance` (higher = better, same as InMemoryVectorStore).
 *
 * Correctness: runs durable-wrapped inside `createRagTool` → the query result is journaled →
 * the pg query does NOT RE-RUN on resume/replay. Even if ANN/HNSW is approximate, the result comes back from the journal.
 */
export class PostgresVectorStore implements VectorStore {
  private pool: PoolLike;
  private table: string;
  private dimension?: number;
  private index: 'hnsw' | 'ivfflat' | 'none';
  private ready?: Promise<void>;

  constructor(opts: PostgresVectorStoreOptions = {}) {
    this.table = opts.table ?? 'gnl_vectors';
    this.dimension = opts.dimension;
    this.index = opts.index ?? 'hnsw';
    if (opts.pool) {
      this.pool = opts.pool;
    } else {
      const { Pool } = createRequire(import.meta.url)('pg') as { Pool: new (config: any) => any };
      this.pool = new Pool(opts.connectionString ? { connectionString: opts.connectionString } : {});
    }
  }

  /** Sets up the extension+table+index (idempotent) using the first vector's dimension; then caches it. */
  private ensureReady(dim: number): Promise<void> {
    if (!this.ready) {
      const dimension = this.dimension ?? dim;
      this.dimension = dimension;
      const booting = (async () => {
        await this.pool.query('CREATE EXTENSION IF NOT EXISTS vector');
        await this.pool.query(
          `CREATE TABLE IF NOT EXISTS ${this.table} (
             id TEXT PRIMARY KEY,
             text TEXT NOT NULL,
             embedding vector(${dimension}) NOT NULL,
             metadata JSONB,
             namespace TEXT,
             created_at BIGINT NOT NULL
           )`,
        );
        // 7.2: add the column in a backward-compatible way on old (namespace-less) tables.
        await this.pool.query(`ALTER TABLE ${this.table} ADD COLUMN IF NOT EXISTS namespace TEXT`);
        if (this.index === 'hnsw') {
          await this.pool.query(
            `CREATE INDEX IF NOT EXISTS ${this.table}_embedding_idx
               ON ${this.table} USING hnsw (embedding vector_cosine_ops)`,
          );
        } else if (this.index === 'ivfflat') {
          await this.pool.query(
            `CREATE INDEX IF NOT EXISTS ${this.table}_embedding_idx
               ON ${this.table} USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)`,
          );
        }
      })();
      this.ready = booting;
      // Same reasoning as `PostgresStorage.ensureReady`, and found by looking for the same shape
      // after CI caught it there: memoising the promise is right, memoising a REJECTED one turns a
      // dropped connection during setup into a store that never works again, on a database that
      // recovered seconds later. Clearing the memo lets the next `upsert`/`query` retry the DDL.
      // `dimension` is deliberately NOT cleared — it was taken from the caller's first vector, not
      // from the database, so it is still the right answer on the retry.
      booting.catch(() => { if (this.ready === booting) this.ready = undefined; });
      return booting;
    }
    return this.ready;
  }

  async upsert(items: VectorItem[]): Promise<void> {
    if (items.length === 0) return;
    await this.ensureReady(items[0]!.embedding.length);
    for (const it of items) {
      await this.pool.query(
        `INSERT INTO ${this.table} (id, text, embedding, metadata, namespace, created_at)
           VALUES ($1, $2, $3::vector, $4, $5, $6)
           ON CONFLICT (id) DO UPDATE SET
             text = EXCLUDED.text,
             embedding = EXCLUDED.embedding,
             metadata = EXCLUDED.metadata,
             namespace = EXCLUDED.namespace`,
        [it.id, it.text, toVectorLiteral(it.embedding), it.metadata ? JSON.stringify(it.metadata) : null, it.namespace ?? null, Date.now()],
      );
    }
  }

  /**
   * 7.2: opts is backward compatible. namespace + metadata filter (jsonb `@>` containment) + minScore
   * are applied in SQL. NOTE: hybrid keyword blending (`opts.text`/`keywordWeight`) is NOT SUPPORTED
   * in pg (would require a tsvector/BM25 setup) — InMemoryVectorStore has full hybrid; pg here is
   * limited to vector + minScore (keywordWeight is IGNORED even if given). This is a documented, deliberate limit.
   */
  async query(embedding: number[], topK: number, opts?: QueryOptions): Promise<VectorMatch[]> {
    await this.ensureReady(embedding.length);
    const params: unknown[] = [toVectorLiteral(embedding)];
    const where: string[] = [];
    if (opts?.namespace !== undefined) {
      params.push(opts.namespace);
      where.push(`namespace = $${params.length}`);
    }
    if (opts?.filter && Object.keys(opts.filter).length > 0) {
      params.push(JSON.stringify(opts.filter));
      where.push(`metadata @> $${params.length}::jsonb`);
    }
    if (opts?.minScore !== undefined) {
      params.push(opts.minScore);
      where.push(`1 - (embedding <=> $1::vector) >= $${params.length}`);
    }
    params.push(topK);
    const limitParam = `$${params.length}`;
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const res = await this.pool.query(
      `SELECT id, text, metadata, namespace, 1 - (embedding <=> $1::vector) AS score
         FROM ${this.table}
         ${whereSql}
         ORDER BY embedding <=> $1::vector
         LIMIT ${limitParam}`,
      params,
    );
    return res.rows.map((r) => ({
      id: r.id,
      text: r.text,
      metadata: parseMetadata(r.metadata),
      namespace: r.namespace ?? undefined,
      score: typeof r.score === 'number' ? r.score : Number(r.score),
    }));
  }

  /** 7.2: delete by id/filter/namespace (count deleted via RETURNING). Empty where → deletes nothing. */
  async delete(where: DeleteWhere): Promise<number> {
    if (!where.ids && where.namespace === undefined && !where.filter) return 0; // safe side
    await this.ensureReady(this.dimension ?? 1);
    const params: unknown[] = [];
    const conds: string[] = [];
    if (where.ids) {
      params.push(where.ids);
      conds.push(`id = ANY($${params.length})`);
    }
    if (where.namespace !== undefined) {
      params.push(where.namespace);
      conds.push(`namespace = $${params.length}`);
    }
    if (where.filter && Object.keys(where.filter).length > 0) {
      params.push(JSON.stringify(where.filter));
      conds.push(`metadata @> $${params.length}::jsonb`);
    }
    const res = await this.pool.query(
      `DELETE FROM ${this.table} WHERE ${conds.join(' AND ')} RETURNING id`,
      params,
    );
    return res.rows.length;
  }

  async close(): Promise<void> {
    if (this.pool.end) await this.pool.end();
  }
}

/** number[] → pgvector literal '[0.1,0.2,...]'. */
function toVectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}

/** The JSONB column can come back from pg as either an object or a string; normalize it. */
function parseMetadata(m: unknown): Record<string, unknown> | undefined {
  if (m == null) return undefined;
  if (typeof m === 'string') {
    try {
      return JSON.parse(m) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  return m as Record<string, unknown>;
}
