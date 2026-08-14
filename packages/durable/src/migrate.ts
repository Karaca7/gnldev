// @gnldev/durable/migrate — P2 migration tooling .
//
// Gnl's original migration story was `CREATE TABLE IF NOT EXISTS` + inline ALTERs run eagerly at
// Construction time (SqliteStorage's constructor, PostgresStorage's lazy ensureReady()) — safe (additive,
// Idempotent) but opaque for ops: no way to preview what a deploy WOULD change, no DDL export for CI
// Diffing, no "disable auto-init, run migrations out-of-band" production path (a pattern some other
// Storage adapters support). This module adds that surface ON TOP OF the exact same additive DDL the
// Adapters already run — nothing here is a new migration engine; it's introspection (checkSchema) plus a
// Deliberate, additive-only application of the gap (migrateSchema). exportSchema/checkSchema/migrateSchema
// Themselves live on SqliteStorage/PostgresStorage (sqlite-storage.ts / postgres-storage.ts) since they
// Need adapter-specific DDL + connections; this file holds the SHARED bits: the types, the DDL→expected-
// Schema parser (so "expected" can never drift from the DDL text the adapters actually execute), and the
// Duck-typed `runMigrationCheck` a CLI/CI script calls without caring which adapter it got.
//
// Scope (v1, deliberate): SQL adapters only. Redis/in-memory storage are schema-free by construction (no
// Tables/columns to diff) — runMigrationCheck reports them as "not supported" rather than pretending to
// Check something that doesn't exist.
//
// Deliberately OUT of scope: dropping/renaming columns or tables. The run journal (gnl_run_journal) is
// This system's append-only source of truth — destructive schema surgery is a separate, much higher-
// Stakes decision that has no business hiding inside an additive auto-migration helper. migrateSchema
// Only ever CREATEs a missing table or ADDs a missing column.
//
// Postgres note (the one place this genuinely delivers the "out-of-band" production pattern): checkSchema/
// MigrateSchema on PostgresStorage deliberately bypass `ensureReady()` — the ONLY methods on that class
// That do — so calling them does not silently auto-create the schema first. PostgresStorage's ensureReady
// Is already lazy (only triggered by `.runs`/`.memory`/etc. or an explicit `.init()`), so simply not
// Routing through it is enough. SqliteStorage's constructor is eager by contrast (unconditional
// `db.exec(DDL)` + the H11b suspended_count backfill, both untouched by this change) — checkSchema/
// MigrateSchema there still do real, live introspection each call, so they correctly report schema DRIFT
// That happens after construction (e.g. an operator manually altered a table); they just can't observe a
// "never migrated" state through the constructor itself, since the constructor already fixes that before
// You get an instance to call checkSchema on.

export interface MissingColumn {
  table: string;
  column: string;
}

export interface SchemaCheckResult {
  ok: boolean;
  missingTables: string[];
  missingColumns: MissingColumn[];
  /** Tables present in the live DB (under the `gnl_` prefix) but not part of the expected schema — informational only, never acted on. */
  unknownTables?: string[];
}

export interface SchemaMigrationResult {
  /** Statements that were applied (or, under `dryRun`, WOULD be applied) to close the gap checkSchema reported. */
  statements: string[];
  dryRun: boolean;
}

/** The structural surface a storage adapter must implement to participate in P2 migration tooling. */
export interface MigratableStorage {
  readonly name: string;
  exportSchema(): string[];
  checkSchema(): Promise<SchemaCheckResult>;
  migrateSchema(opts?: { dryRun?: boolean }): Promise<SchemaMigrationResult>;
}

export type MigrationCheckResult =
  | { supported: true; storage: string; check: SchemaCheckResult }
  | { supported: false; storage: string; reason: string };

/**
 * Duck-types the given storage for `checkSchema`/`exportSchema` — structural, so it works with
 * SqliteStorage, PostgresStorage, or any future adapter shaped the same way, with zero import coupling to
 * Which concrete adapters exist. Storages without a schema (RedisStorage, InMemoryStorage) get an honest
 * "not supported" result instead of a crash. This is the entry point a CLI or CI script calls.
 */
export async function runMigrationCheck(storage: {
  name?: string;
  checkSchema?: () => Promise<SchemaCheckResult>;
  exportSchema?: () => string[];
}): Promise<MigrationCheckResult> {
  const storageName = storage?.name ?? 'unknown';
  if (typeof storage?.checkSchema !== 'function' || typeof storage?.exportSchema !== 'function') {
    return {
      supported: false,
      storage: storageName,
      reason: `storage '${storageName}' does not implement checkSchema()/exportSchema() — schema-free by construction (e.g. redis/in-memory) or an adapter that predates P2-migrate`,
    };
  }
  const check = await storage.checkSchema();
  return { supported: true, storage: storageName, check };
}

// ── DDL → expected-schema parser (shared by sqlite-storage.ts / postgres-storage.ts) ──────────────
// Parses `CREATE TABLE IF NOT EXISTS <name> (<cols...>)` straight out of the adapters' own DDL text so
// The "expected schema" used by checkSchema/migrateSchema can never drift from what the constructor
// Actually creates — one parse of the real DDL instead of a hand-maintained column list living next to
// It. Returns table -> (column name -> full column-definition text, e.g. `"suspended_count INTEGER NOT
// NULL DEFAULT 0"`) so migrateSchema can synthesize a correct `ALTER TABLE ... ADD COLUMN <def>` for ANY
// Future column the DDL grows, not just the ones known about today.
export function tablesFromDDL(ddl: string | string[]): Map<string, Map<string, string>> {
  const text = Array.isArray(ddl) ? ddl.join(';\n') : ddl;
  const out = new Map<string, Map<string, string>>();
  const tableRe = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\)\s*(?:;|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = tableRe.exec(text))) {
    const table = m[1]!;
    const body = m[2]!;
    const cols = new Map<string, string>();
    for (const rawPart of splitTopLevel(body)) {
      const part = rawPart.trim();
      if (!part || /^(PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CHECK|CONSTRAINT)\b/i.test(part)) continue; // table-level constraint, not a column
      const name = part.split(/\s+/)[0]!.replace(/"/g, '');
      cols.set(name, part);
    }
    out.set(table, cols);
  }
  return out;
}

/** Splits a SQL column-list body on top-level commas — ignores commas nested inside parens (e.g. `PRIMARY KEY (a, b)`). */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}
