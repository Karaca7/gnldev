// Architecture probe: the `<ns>:<id>` rename lives in 4 places (org-storage + 3 adoptIntoOrg). Same input to each.
import { describe, it } from 'vitest';
import { newDb } from 'pg-mem';
import { InMemoryStorage, withOrgStorage } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';

const Q = [1, 0, 0];
const MK: Array<[string, () => any]> = [
  ['InMemory', () => new InMemoryStorage()],
  ['Sqlite', () => new SqliteStorage(':memory:')],
  ['Postgres(pg-mem)', () => new PostgresStorage({ pool: new (newDb().adapters.createPg().Pool)() } as never)],
];

describe('zz-arch adopt collision', () => {
  for (const [name, mk] of MK) {
    it(name, async () => {
      const root = mk();
      await withOrgStorage(root, 'acme').vectors!.upsert([{ id: 'd1', text: 'ACME-OWN', shared: true, embedding: Q }]);
      await root.vectors!.upsert([{ id: 'd1', text: 'LEGACY', shared: true, embedding: Q }]);
      let outcome: string;
      try { const r = await root.adoptIntoOrg('acme', { allowUnregistered: true }); outcome = 'ok ' + JSON.stringify(r).slice(0, 120); }
      catch (e: any) { outcome = 'THROW ' + String(e?.message).slice(0, 90); }
      const seen = (await withOrgStorage(root, 'acme').vectors!.query(Q, 10)).map((m: any) => `${m.id}=${m.text}`).join(',');
      const rootAll = (await root.vectors!.query(Q, 10)).map((m: any) => `${m.id}|${m.namespace ?? 'null'}=${m.text}`).join(',');
      console.log(`PROBE ${name} | adopt: ${outcome} | acme sees: ${seen} | root rows: ${rootAll}`);
    });
  }
});
