import { createRequire } from 'node:module';
import { vectorWriteBatch, assertSameVectorOwner, vectorDeletePlan, VECTOR_OUTSIDE_ORGANIZATIONS_SQL, vectorQueryScope } from '@gnldev/durable';
import type { VectorStore, VectorItem, VectorMatch, QueryOptions, DeleteWhere } from './vector-store.js';

/** Minimal pg.Pool surface — injectable for tests/custom setups (same pattern as PostgresJournal). */
export interface PoolLike {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
  end?: () => Promise<void>;
  /** A real `pg.Pool` has it: an upsert batch then runs in one transaction. Without it, statement by statement. */
  connect?: () => Promise<{ query: PoolLike['query']; release?: () => void }>;
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
  readonly deleteOutsideOrganizations = true;
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
             owner TEXT,
             shared BOOLEAN,
             created_at BIGINT NOT NULL
           )`,
        );
        // 7.2: add the column in a backward-compatible way on old (namespace-less) tables.
        await this.pool.query(`ALTER TABLE ${this.table} ADD COLUMN IF NOT EXISTS namespace TEXT`);
        // Same for the end-user label. Existing rows stay NULL: unlabelled, so visible to no end user.
        await this.pool.query(`ALTER TABLE ${this.table} ADD COLUMN IF NOT EXISTS owner TEXT`);
        await this.pool.query(`ALTER TABLE ${this.table} ADD COLUMN IF NOT EXISTS shared BOOLEAN`);
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
    const batch = vectorWriteBatch(items);
    await this.ensureReady(batch[0]!.embedding.length);
    // One transaction when the pool can hand out a connection: a batch refused half-way, by a writer
    // that took an id after the check, is rolled back rather than left half-written.
    const client = typeof this.pool.connect === 'function' ? await this.pool.connect() : undefined;
    const q = client ? (sql: string, p?: unknown[]) => client.query(sql, p) : (sql: string, p?: unknown[]) => this.pool.query(sql, p);
    try {
      if (client) await q('BEGIN');
      await this.writeBatch(q, batch);
      if (client) await q('COMMIT');
    } catch (e) {
      if (client) await q('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client?.release?.();
    }
  }

  private async writeBatch(q: PoolLike['query'], items: VectorItem[]): Promise<void> {
    const probe = async (id: string) =>
      (await q(`SELECT namespace, owner, shared FROM ${this.table} WHERE id = $1`, [id])).rows[0] as
        { namespace: string | null; owner: string | null; shared: boolean | null } | undefined;
    // Whole batch checked first: a refused batch leaves no half (assertSameVectorOwner).
    for (const it of items) assertSameVectorOwner(await probe(it.id), it);
    // Then two statements, neither of which can overwrite another owner's document: update only when
    // the labels match, else insert only when the id is free. Neither landing = taken under other labels.
    for (const it of items) {
      const labels = [it.namespace ?? null, it.owner ?? null, it.shared ? true : null];
      const updated = await q(
        `UPDATE ${this.table} SET text = $2, embedding = $3::vector, metadata = $4
           WHERE id = $1 AND COALESCE(namespace, '') = COALESCE($5, '') AND COALESCE(owner, '') = COALESCE($6, '')
             AND COALESCE(shared, false) = COALESCE($7, false)
           RETURNING id`,
        [it.id, it.text, toVectorLiteral(it.embedding), it.metadata ? JSON.stringify(it.metadata) : null, ...labels],
      );
      if (updated.rows.length) continue;
      const inserted = await q(
        `INSERT INTO ${this.table} (id, text, embedding, metadata, namespace, owner, shared, created_at)
           VALUES ($1, $2, $3::vector, $4, $5, $6, $7, $8)
           ON CONFLICT (id) DO NOTHING
           RETURNING id`,
        [it.id, it.text, toVectorLiteral(it.embedding), it.metadata ? JSON.stringify(it.metadata) : null, ...labels, Date.now()],
      );
      if (!inserted.rows.length) assertSameVectorOwner((await probe(it.id)) ?? { namespace: '\u0000' }, it);
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
    const scope = vectorQueryScope(opts);
    if (scope.none) return [];
    const params: unknown[] = [toVectorLiteral(embedding)];
    const where: string[] = [];
    if (scope.namespace !== undefined) {
      params.push(scope.namespace);
      where.push(`namespace = $${params.length}`);
    }
    if (opts?.filter && Object.keys(opts.filter).length > 0) {
      params.push(JSON.stringify(opts.filter));
      where.push(`metadata @> $${params.length}::jsonb`);
    }
    if (scope.visibleTo !== undefined) {
      params.push(scope.visibleTo);
      where.push(`(shared IS TRUE OR owner = $${params.length})`);
    }
    if (opts?.minScore !== undefined) {
      params.push(opts.minScore);
      where.push(`1 - (embedding <=> $1::vector) >= $${params.length}`);
    }
    params.push(topK);
    const limitParam = `$${params.length}`;
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const res = await this.pool.query(
      `SELECT id, text, metadata, namespace, owner, shared, 1 - (embedding <=> $1::vector) AS score
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
      ...(r.owner != null ? { owner: r.owner as string } : {}),
      ...(r.shared ? { shared: true } : {}),
      score: typeof r.score === 'number' ? r.score : Number(r.score),
    }));
  }

  /** 7.2: delete by id/filter/namespace (count deleted via RETURNING). Empty where → deletes nothing. */
  async delete(where: DeleteWhere): Promise<number> {
    const w = vectorDeletePlan(where); // no condition (`{}`, `{ ids: [] }`, `{ filter: {} }`) → nothing
    if (!w) return 0;
    await this.ensureReady(this.dimension ?? 1);
    const params: unknown[] = [];
    const conds: string[] = [];
    if (w.ids) {
      params.push(w.ids);
      conds.push(`id = ANY($${params.length})`);
    }
    if (w.namespace !== undefined) {
      params.push(w.namespace);
      conds.push(`namespace = $${params.length}`);
    }
    if (w.outsideOrganizations) conds.push(VECTOR_OUTSIDE_ORGANIZATIONS_SQL);
    if (w.filter && Object.keys(w.filter).length > 0) {
      params.push(JSON.stringify(w.filter));
      conds.push(`metadata @> $${params.length}::jsonb`);
    }
    if (w.owner !== undefined) {
      params.push(w.owner);
      conds.push(`owner = $${params.length}`);
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
