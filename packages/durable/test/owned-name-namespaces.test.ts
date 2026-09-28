// R16/R17: owned and system names live in disjoint, totally-escaped namespaces, and one rule says
// what an owner id may be.
//
// Measured on the base before this (adr2/core): an owner holding a lone surrogate was accepted and
// written as-is, and on a real Postgres `u\uD800`, `u\uDC00` and `u\uFFFD` became ONE row — three
// owners' jobs, two of them reported as enqueued and silently dropped. An empty `resourceId` or
// `orgId` named the organization's own space, so `ownedPrefix({ orgId: 'acme', resourceId: '' })`
// matched every org-level name for erasure.
import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';
import { InMemoryStorage, ownedName, ownedPrefix, ownerOfName, OwnerIdError, ownerIdProblem, type WorkStore } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const throwsName = (f: () => unknown) => { try { f(); return 'ok'; } catch (e) { return (e as Error).name; } };

describe('owned names: disjoint from system names', () => {
  it('S1: a system id spelled like an owned one is not that owner\'s', () => {
    const system = ownedName('acme:bob:x', {});
    const bobs = ownedName('x', { orgId: 'acme', resourceId: 'bob' });
    expect(system).not.toBe(bobs);
    expect(ownerOfName(system)).toEqual({ name: 'acme:bob:x' });
    expect(ownerOfName(bobs)).toEqual({ orgId: 'acme', resourceId: 'bob', name: 'x' });
  });

  it('sibling: a system name cannot wear the owned marker, so it cannot claim an owner', () => {
    expect(throwsName(() => ownedName(ownedName('x', { resourceId: 'bob' }), {}))).toBe('TypeError');
  });

  it('sibling: separators inside owner parts cannot move a name into another owner', () => {
    const pairs: Array<[{ orgId?: string; resourceId?: string }, { orgId?: string; resourceId?: string }]> = [
      [{ orgId: 'a:b', resourceId: 'c' }, { orgId: 'a', resourceId: 'b:c' }],
      [{ orgId: 'a' }, { resourceId: 'a' }],
      [{ resourceId: 'b%3Ac' }, { resourceId: 'b:c' }],
      [{ resourceId: '~o~x' }, { resourceId: '%7Eo%7Ex' }],
      [{ resourceId: 'u%uD800' }, { resourceId: 'u\uD800' }],
    ];
    for (const [a, b] of pairs) {
      expect(ownedName('n', a)).not.toBe(ownedName('n', b));
      expect(ownedName('n', b).startsWith(ownedPrefix(a))).toBe(false);
      expect(ownerOfName(ownedName('n', a))).toEqual({ ...a, name: 'n' });
      expect(ownerOfName(ownedName('n', b))).toEqual({ ...b, name: 'n' });
    }
  });
});

describe('S2: lone surrogates — no URIError, no collision, a well-formed stored name', () => {
  const owners = ['u\uD800', 'u\uDC00', 'u\uFFFD', 'u\uD83D\uDE00'];

  it('each owner gets its own name, it round-trips, and no stored name holds a lone surrogate', () => {
    const names = owners.map((resourceId) => ownedName('k', { resourceId }));
    expect(new Set(names).size).toBe(owners.length);
    for (const n of names) expect(LONE.test(n)).toBe(false);
    expect(names.map((n) => ownerOfName(n).resourceId)).toEqual(owners);
  });

  const STORES: Array<[string, () => Promise<WorkStore>]> = [
    ['InMemory', async () => new InMemoryStorage().work!],
    ['SQLite', async () => new SqliteStorage(':memory:').work!],
  ];
  const PG_URL = process.env.GNL_PG_URL;
  const ends: Array<() => Promise<void>> = [];
  afterAll(async () => { for (const e of ends) await e(); });
  if (PG_URL) {
    STORES.push(['Postgres (real)', async () => {
      const schema = `ownedname_${process.pid}_${Date.now().toString(36)}`;
      const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
      await admin.query(`CREATE SCHEMA ${schema}`);
      const pool = new pg.Pool({ connectionString: PG_URL, max: 2, options: `-c search_path=${schema}` });
      ends.push(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
      return new PostgresStorage({ pool }).work!;
    }]);
  }

  it.each(STORES)('%s: four owners, four jobs', async (_name, mk) => {
    const work = await mk();
    for (const resourceId of owners) await work.append('qjob', { who: resourceId }, ownedName('k', { resourceId }));
    const rows = (await work.list<{ who: string }>('qjob')).items;
    expect(rows.map((r) => r.payload.who).sort()).toEqual([...owners].sort());
    expect(rows.map((r) => ownerOfName(r.id).resourceId).sort()).toEqual([...owners].sort());
  });
});

describe('R17: one owner-id rule for owned names and their erasure prefix', () => {
  const refused: Array<[string, { orgId?: string; resourceId?: string }]> = [
    ['empty user', { resourceId: '' }],
    ['empty user in an org', { orgId: 'acme', resourceId: '' }],
    ['empty org', { orgId: '', resourceId: 'bob' }],
    ['reserved prefix', { resourceId: 'operator:ops' }],
    ['too long', { resourceId: 'x'.repeat(201) }],
    ['control character', { resourceId: 'bob\u0085' }],
    ['line separator', { resourceId: 'bob\u2028' }],
    ['not a string', { resourceId: 42 as unknown as string }],
  ];
  it.each(refused)('%s: ownedName and ownedPrefix both refuse it with OwnerIdError', (_what, owner) => {
    expect(throwsName(() => ownedName('k', owner))).toBe('OwnerIdError');
    expect(throwsName(() => ownedPrefix(owner))).toBe('OwnerIdError');
  });

  it('the error is typed and says what is wrong, never the id', () => {
    try { ownedName('k', { resourceId: 'operator:ops' }); expect.unreachable(); } catch (e) {
      expect(e).toBeInstanceOf(OwnerIdError);
      expect(e).toBeInstanceOf(TypeError);
      expect((e as OwnerIdError).code).toBe('owner_id_invalid');
      expect((e as Error).message).toContain('reserved prefix');
      expect((e as Error).message).not.toContain('operator:ops');
    }
  });

  it('sibling: erasing an empty user cannot reach the organization\'s own names', () => {
    const orgLevel = ownedName('nightly', { orgId: 'acme' });
    expect(orgLevel.startsWith(ownedPrefix({ orgId: 'acme' }))).toBe(true);
    expect(throwsName(() => ownedPrefix({ orgId: 'acme', resourceId: '' }))).toBe('OwnerIdError');
  });

  it('the accepted edge: 200 characters, a colon, a tilde, a percent', () => {
    for (const id of ['x'.repeat(200), 'a:b', 'a~b', '100%']) {
      expect(ownerIdProblem(id)).toBeNull();
      expect(ownerOfName(ownedName('k', { resourceId: id })).resourceId).toBe(id);
    }
  });
});
