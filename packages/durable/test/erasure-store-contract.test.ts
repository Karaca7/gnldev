// ONE ERASURE, EVERY STORE. `eraseSubject` reaches a person's queued jobs and events through
// `WorkStore.deleteIdPrefix` (an owned record carries its owner in its id, `ownedName`). Measured on
// adr2/integration (889d8b24): only the in-memory store had it, so on SQLite, Postgres and Redis the
// erasure threw — a deployment on a real store could not erase a person at all.
//
// The same world goes to every store, and every store must give the SAME answer, the one written
// here (a drift test, not only a per-store test):
//  - a person with runs, threads, documents, queued jobs, triggers and events is fully erased;
//  - erasing `bob` leaves `bob:evil`, `bob%`, `bob_x` and another organization's `bob` intact;
//  - an id holding SQL LIKE or Redis glob metacharacters (`%`, `_`, `*`, `?`, `[`, `\`) is a literal
//    prefix: its neighbour that a wildcard would match survives.
//
// Stores: durable InMemory, SQLite, Postgres (pg-mem), Redis (FakeRedis). With GNL_PG_URL also a real
// Postgres; with GNL_REDIS_URL also a real Redis (the real-backend gate, `pnpm check:real`, sets both).
import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import { newDb } from 'pg-mem';
import pg from 'pg';
import {
  InMemoryStorage, RedisStorage, BasicMemory, composite, createGnl, scopeConfigToOrg, eraseSubject, toJournal, withOrgStorage, workingMemoryScope,
  type Storage, type Journal,
} from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { makeFakeRedis } from './fake-redis.js';
import type { RedisLike } from '../src/redis-storage.js';
import { indexDocuments } from '../../rag/src/index.js';
import { enqueue, createWorker, listJobs, jobEraser } from '../../queue/src/index.js';
import { emit, createConsumer, eventEraser } from '../../events/src/index.js';
import { scheduleWorkflow, pollScheduler, listTriggers, triggerEraser } from '../../scheduler/src/index.js';
import { workflow, step } from '../../workflow/src/index.js';
import { AgentMemory } from '../../memory/src/index.js';
import { createMockModel, finalTextResult } from './mock.js';

const PG_URL = process.env.GNL_PG_URL;
const REDIS_URL = process.env.GNL_REDIS_URL;

// The quarantine notices of the dead-lettering consumer are expected, one per person per store.
beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); });

const ends: Array<() => Promise<void>> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });

/** A store under test, and every record its work store holds, raw — the payloads, not a listing. */
type Backend = { storage: Storage; rawWork: () => Promise<string[]> };

let seq = 0;
const BACKENDS: Array<[string, () => Promise<Backend>]> = [
  ['InMemory', async () => {
    const storage = new InMemoryStorage();
    const w = storage.work as unknown as { logs: Map<string, Array<{ id: string; payload: unknown }>>; kv: Map<string, unknown> };
    return {
      storage,
      rawWork: async () => [
        ...[...w.logs].flatMap(([ns, log]) => log.map((r) => `${ns}|${r.id}|${JSON.stringify(r.payload)}`)),
        ...[...w.kv].map(([k, v]) => `${k}|${JSON.stringify(v)}`),
      ],
    };
  }],
  ['SQLite', async () => {
    const storage = new SqliteStorage(':memory:');
    const db = (storage as unknown as { db: { prepare(s: string): { all(): Array<Record<string, string>> } } }).db;
    return {
      storage,
      rawWork: async () => [
        ...db.prepare('SELECT ns, id, payload FROM gnl_work_log').all().map((r) => `${r.ns}|${r.id}|${r.payload}`),
        ...db.prepare('SELECT key, value FROM gnl_work_kv').all().map((r) => `${r.key}|${r.value}`),
      ],
    };
  }],
  ['Postgres (pg-mem)', async () => pgBackend(new (newDb().adapters.createPg().Pool)())],
  ['Redis (fake)', async () => redisBackend(makeFakeRedis(), 'gnl:')],
];
if (PG_URL) {
  BACKENDS.push(['Postgres (real)', async () => {
    const schema = `erasecontract_${process.pid}_${Date.now().toString(36)}_${seq++}`;
    const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
    const pool = new pg.Pool({ connectionString: PG_URL, max: 4, options: `-c search_path=${schema}` });
    // An idle connection the server drops (another suite on the same database may terminate every
    // backend) must reject the next query, not end the process as an unhandled 'error' event.
    for (const p of [admin, pool]) p.on('error', () => {});
    await admin.query(`CREATE SCHEMA ${schema}`);
    ends.push(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
    return pgBackend(pool);
  }]);
}
if (REDIS_URL) {
  BACKENDS.push(['Redis (real)', async () => {
    const { default: Redis } = await import('ioredis');
    const client = new Redis(REDIS_URL) as unknown as RedisLike & { quit(): Promise<unknown> };
    // A key prefix of its own, holding glob characters on purpose: the erasure's SCAN pattern must
    // escape the prefix too, or it reads (and deletes) a neighbouring store's keys.
    const pfx = `gnl-erase-[${process.pid}]*${seq++}:`;
    ends.push(async () => {
      const keys = await scanRaw(client, pfx);
      if (keys.length) await client.del(...keys);
      await client.quit();
    });
    return redisBackend(client, pfx);
  }]);
}

async function pgBackend(pool: pg.Pool): Promise<Backend> {
  const storage = new PostgresStorage({ pool });
  return {
    storage,
    rawWork: async () => [
      ...(await pool.query('SELECT ns, id, payload FROM gnl_work_log')).rows.map((r) => `${r.ns}|${r.id}|${r.payload}`),
      ...(await pool.query('SELECT key, value FROM gnl_work_kv')).rows.map((r) => `${r.key}|${r.value}`),
    ],
  };
}

const globEscape = (s: string) => s.replace(/[\\*?[\]]/g, (c) => '\\' + c);
async function scanRaw(client: RedisLike, pfx: string): Promise<string[]> {
  const out = new Set<string>();
  let cursor: string | number = '0';
  do {
    const [next, keys] = await client.scan(cursor, 'MATCH', globEscape(pfx) + '*', 'COUNT', 1000);
    for (const k of keys) out.add(k);
    cursor = next;
  } while (String(cursor) !== '0');
  return [...out];
}

function redisBackend(client: RedisLike, pfx: string): Backend {
  const redis = new RedisStorage({ client, keyPrefix: pfx, replicationWarning: false });
  // Redis keeps no documents and no memory store: those come from another store, as `composite` documents.
  const side = new InMemoryStorage();
  const storage = composite({ default: redis, overrides: { vectors: side, memory: side } });
  return {
    storage,
    rawWork: async () => {
      const keys = (await scanRaw(client, pfx)).filter((k) => k.startsWith(`${pfx}wl:`) || k.startsWith(`${pfx}wk:`));
      const out: string[] = [];
      for (const k of keys) out.push(`${k}|${await client.get(k)}`);
      return out;
    },
  };
}

type Person = { who: string; orgId?: string };
const tagOf = (p: Person) => `${p.who}@${p.orgId ?? '-'}`;
/** The kinds of record a person leaves, each carrying the person's tag in its text. */
const KINDS = ['JOB', 'JOBRUN', 'FAIL', 'EVT', 'DEAD', 'WF', 'DOC', 'THREAD'] as const;

const model = () => createMockModel(async () => finalTextResult('ok'));

async function world(b: Backend, people: Person[]) {
  const { storage } = b;
  const root = toJournal(storage.runs);
  const work = storage.work!;
  const wf = workflow<{ who: string }>().then(step('s', async (i) => ({ text: `WF|${i.who}|` })));
  const config = {
    storage,
    workflows: { weekly: wf },
    agents: { a: { model: model() } },
    memoryFactory: (s: Storage | Journal) => new BasicMemory(('runs' in s ? toJournal(s.runs) : s) as Journal),
  };
  const gnlFor = (org: string) => createGnl(scopeConfigToOrg(config as never, org).config);
  for (const [i, p] of people.entries()) {
    const tag = tagOf(p);
    const owner = { resourceId: p.who, ...(p.orgId ? { orgId: p.orgId } : {}) };
    // A document of theirs, in their organization's partition.
    const vectors = (p.orgId ? withOrgStorage(storage, p.orgId) : storage).vectors!;
    await indexDocuments(vectors, async () => [1, 0], [{ id: `d${i}`, text: `DOC|${tag}|`, owner: p.who }]);
    // A conversation thread of theirs.
    const gnl = p.orgId ? gnlFor(p.orgId) : createGnl(config as never);
    await gnl.run('a', { runId: `chat-${i}`, prompt: `THREAD|${tag}|`, threadId: `th-${i}`, resourceId: p.who });
    await enqueue(work, 'weekly', { note: `${tag}|`, record: `JOB|${tag}|` }, owner);
    await emit(work, 'audit', { note: `${tag}|` }, owner);
    await scheduleWorkflow(root, { id: 'weekly', name: 'weekly', input: { who: tag }, at: 0, ...owner }, 0);
  }
  // Each job runs as its owner (a job run) and fails once with an error naming them (a `qfail`).
  await createWorker(storage, {
    weekly: async (p, ctx) => { const n = (p as { note: string }).note; await ctx.run({ model: model(), prompt: `JOBRUN|${n}` }); throw new Error(`FAIL|${n}`); },
  }, { maxAttempts: 1 }).drain();
  // One consumer dead-letters every event (a record holding the error text), one acks.
  await createConsumer(work, 'audit', (p) => { throw new Error(`DEAD|${(p as { note: string }).note}`); }, { name: 'bad', maxAttempts: 1 }).poll();
  await createConsumer(work, 'audit', () => {}, { name: 'ok' }).poll();
  await pollScheduler(root, createGnl(config as never), 1, { runnerForOrg: gnlFor });
  return { root, work };
}

/** Everything the store holds, as text: the journal (every organization), jobs, events, documents, triggers, raw work records. */
async function dump(b: Backend, people: Person[]): Promise<string> {
  const { storage } = b;
  const root = toJournal(storage.runs);
  const keys = await storage.runs.listKeys!('');
  const journal = await Promise.all(keys.map(async (k) => `${k}=${JSON.stringify(await storage.runs.get(k))}`));
  const jobs = (await listJobs(storage.work!)).map((j) => JSON.stringify(j));
  const events: string[] = [];
  await createConsumer(storage.work!, 'audit', (p) => { events.push(`EVT|${(p as { note: string }).note}`); }, { name: `probe-${seq++}` }).poll();
  const docs: string[] = [];
  for (const org of new Set(people.map((p) => p.orgId))) {
    const v = (org ? withOrgStorage(storage, org) : storage).vectors!;
    docs.push(...(await v.query([1, 0], 100)).map((m) => m.text));
  }
  const triggers = (await listTriggers(root)).map((t) => `${t.id}:${JSON.stringify(t.input)}`);
  const raw = await b.rawWork();
  return [...journal, ...jobs, ...events, ...docs, ...triggers, ...raw].join('\n');
}

/** Which kinds of record survive, per person — the comparable answer. */
function survivors(text: string, people: Person[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const p of people) {
    const tag = tagOf(p);
    // Stored as JSON too, where a `\\` in the id is written doubled.
    out[tag] = KINDS.filter((k) => text.includes(`${k}|${tag}|`) || text.includes(JSON.stringify(`${k}|${tag}|`).slice(1, -1)));
  }
  return out;
}

const erasers = (storage: Storage, root: ReturnType<typeof toJournal>) => [jobEraser(storage), triggerEraser(root), eventEraser(storage.work!)];

async function erase(b: Backend, root: ReturnType<typeof toJournal>, p: Person) {
  return eraseSubject(b.storage, p.who, { ...(p.orgId ? { orgId: p.orgId } : {}), erasers: erasers(b.storage, root) });
}

// ── Scenario 1: bob in acme, and every id that begins like his ────────────────────────────────────
const BOB = { who: 'bob', orgId: 'acme' };
const NEIGHBOURS: Person[] = [
  { who: 'bob:evil', orgId: 'acme' }, { who: 'bob%', orgId: 'acme' }, { who: 'bob_x', orgId: 'acme' },
  { who: 'bob', orgId: 'globex' }, { who: 'bob' }, { who: 'ayse', orgId: 'acme' },
];
// ── Scenario 2: ids holding LIKE / glob metacharacters, each next to the id its wildcard would match ─
// (the `%` of an id is written `%25` in the stored name, so `pz25q` is what `p%25q` as LIKE matches).
const LITERAL_TARGETS: Person[] = ['p%q', 'p_q', 'p*q', 'p?q', 'p[ab]q', 'p\\q', 'p%_*[x'].map((who) => ({ who, orgId: 'acme' }));
const LITERAL_NEIGHBOURS: Person[] = ['pz25q', 'pzq', 'pzzq', 'paq', 'pq', 'p%25_*[x', 'pX25Y*[x', 'p%Z*[x'].map((who) => ({ who, orgId: 'acme' }));
// ── Scenario 3: the organization-less bob, next to the bobs of two organizations (E1b) ──────────────
const LONE_BOB: Person = { who: 'bob' };
const LONE_NEIGHBOURS: Person[] = [{ who: 'bob', orgId: 'acme' }, { who: 'bob', orgId: 'globex' }, { who: 'bob:evil' }, { who: 'ayse' }];

const EVERYTHING = [...KINDS];
const results: Record<string, Record<string, unknown>> = {};

describe.each(BACKENDS)('eraseSubject on %s', (name, make) => {
  it('bob in acme: everything of his is gone; bob:evil, bob%, bob_x, globex\'s bob and the organization-less bob stay whole', async () => {
    const b = await make();
    const people = [BOB, ...NEIGHBOURS];
    const { root } = await world(b, people);
    const before = survivors(await dump(b, people), people);
    for (const p of people) expect(before[tagOf(p)], `seeded ${tagOf(p)}`).toEqual(EVERYTHING);

    const report = await erase(b, root, BOB);
    expect(report.workRecords, 'owned log records found by id prefix').toBeGreaterThan(0);

    const text = await dump(b, people);
    const after = survivors(text, people);
    expect(after[tagOf(BOB)]).toEqual([]);
    // No key, id or payload left that names him — in the journal, the work log, the markers.
    expect(text.split('\n').filter((l) => l.includes('~o~acme:bob:') || l.includes('bob@acme|'))).toEqual([]);
    for (const p of NEIGHBOURS) expect(after[tagOf(p)], tagOf(p)).toEqual(EVERYTHING);
    (results[name] ??= {}).neighbours = { after, report };
  });

  it('the organization-less bob: everything of his is gone; acme\'s bob, globex\'s bob, bob:evil and ayse stay whole', async () => {
    const b = await make();
    const people = [LONE_BOB, ...LONE_NEIGHBOURS];
    const { root } = await world(b, people);
    const before = survivors(await dump(b, people), people);
    for (const p of people) expect(before[tagOf(p)], `seeded ${tagOf(p)}`).toEqual(EVERYTHING);

    await erase(b, root, LONE_BOB);

    const after = survivors(await dump(b, people), people);
    expect(after[tagOf(LONE_BOB)]).toEqual([]);
    for (const p of LONE_NEIGHBOURS) expect(after[tagOf(p)], tagOf(p)).toEqual(EVERYTHING);
    (results[name] ??= {}).lone = after;
  });

  it('an id with LIKE or glob metacharacters is a literal prefix: each target goes, each lookalike stays', async () => {
    const b = await make();
    const people = [...LITERAL_TARGETS, ...LITERAL_NEIGHBOURS];
    const { root } = await world(b, people);
    const before = survivors(await dump(b, people), people);
    for (const p of people) expect(before[tagOf(p)], `seeded ${tagOf(p)}`).toEqual(EVERYTHING);

    for (const p of LITERAL_TARGETS) await erase(b, root, p);

    const after = survivors(await dump(b, people), people);
    for (const p of LITERAL_TARGETS) expect(after[tagOf(p)], `erased ${tagOf(p)}`).toEqual([]);
    for (const p of LITERAL_NEIGHBOURS) expect(after[tagOf(p)], `lookalike ${tagOf(p)}`).toEqual(EVERYTHING);
    (results[name] ??= {}).literal = after;
  });

  it('deleteIdPrefix itself: every namespace, only ids that start with the prefix, and the count', async () => {
    const { storage } = await make();
    const work = storage.work!;
    expect(typeof work.deleteIdPrefix).toBe('function');
    // `pre:~o~acme:bob:1` CONTAINS the prefix after a colon: a store that matched "ends in" or "contains"
    // rather than "starts with" would take it.
    const ids = ['~o~acme:bob:1', '~o~acme:bob:2', '~o~acme:bob:evil:1', '~o~acme:bob%25:1', 'x~o~acme:bob:1', 'pre:~o~acme:bob:1', 'sys-1'];
    for (const ns of ['qjob', 'evt:audit', 'org:acme:qjob']) for (const id of ids) await work.append(ns, { id }, id);
    // A KV key spelled like an owned id is not a log record: deleteIdPrefix leaves it.
    await work.put('~o~acme:bob:kv', 1);
    const n = await work.deleteIdPrefix!('~o~acme:bob:');
    const left: Record<string, string[]> = {};
    for (const ns of ['qjob', 'evt:audit', 'org:acme:qjob']) left[ns] = (await work.list(ns, { limit: 100 })).items.map((r) => r.id).sort();
    const expected = ['sys-1', 'x~o~acme:bob:1', 'pre:~o~acme:bob:1', '~o~acme:bob%25:1'].sort();
    expect({ n, left, kv: await work.get('~o~acme:bob:kv') }).toEqual({ n: 9, left: { qjob: expected, 'evt:audit': expected, 'org:acme:qjob': expected }, kv: 1 });
    // A prefix that matches nothing deletes nothing.
    expect(await work.deleteIdPrefix!('~o~acme:nobody:')).toBe(0);
    (results[name] ??= {}).primitive = { n, left };
  });
});

// ── Scenario 4: what AgentMemory keeps (M-1/M-2 of the 0.7.0 release panel) ──────────────────────
// The person's threads and messages, their own working memory (`workingMemoryScope.resource`), a
// thread's working memory, and observational memory's journal records (the observer's summary). Asked
// with nothing but the storage: no store is listed, so none can be forgotten. Measured before: the
// person's working memory survived every erasure, and without `memory` so did every thread.
//
// And what the final 0.7.0 panel measured left behind on f9dd23ad: working memory 0.6.0 wrote
// (`res:<id>` for the person, the thread's bare id — `LEGRES`, `LEGTHR`), and observational memory's
// vectors (`OMVEC`), written with no owner and so outside every erasure.
const MEM_KINDS = ['MEMTHREAD', 'WMRES', 'WMTHR', 'OM', 'LEGRES', 'LEGTHR', 'OMVEC'] as const;
const MEM_TARGETS: Person[] = [{ who: 'ayse' }, { who: 'bob', orgId: 'acme' }];
const MEM_NEIGHBOURS: Person[] = [{ who: 'ayse', orgId: 'acme' }, { who: 'ayse:x' }, { who: 'bob' }, { who: 'bob', orgId: 'globex' }, { who: 'bob%' , orgId: 'acme' }];
const memThread = (i: number) => `mt-${i}`;

/**
 * A store that withdraws its memory port after `init` (pg-mem: no `pg_advisory_xact_lock`) gets one
 * from another store, as its own refusal tells a deployment to. Real Postgres keeps its own.
 */
async function withMemoryPort(b: Backend): Promise<Backend> {
  await b.storage.init?.();
  if (b.storage.capabilities.memory !== 'none') return b;
  return { ...b, storage: composite({ default: b.storage, overrides: { memory: new InMemoryStorage() } }) };
}

async function memoryWorld(b: Backend, people: Person[]) {
  for (const [i, p] of people.entries()) {
    const tag = tagOf(p);
    const view = p.orgId ? withOrgStorage(b.storage, p.orgId) : b.storage;
    const observer = createMockModel(async () => finalTextResult(`OM|${tag}|`));
    const omVectors = { store: view.vectors!, embed: async (texts: string[]) => texts.map(() => [1, 0]) };
    const mem = new AgentMemory({ storage: view, workingMemory: { scope: 'resource' }, observationalMemory: { enabled: true, observerModel: observer, observation: { messageThreshold: 3 }, omVectors } });
    const t = memThread(i);
    // Where 0.6.0 kept working memory: `res:<id>` and the bare thread id (the view adds `org:<id>:`).
    await view.memory!.setWorkingMemory(`res:${p.who}`, { v: `LEGRES|${tag}|` });
    await view.memory!.setWorkingMemory(t, { v: `LEGTHR|${tag}|` });
    await mem.createThread({ id: t, resourceId: p.who });
    for (let n = 0; n < 4; n++) await mem.append(t, [{ role: 'user', content: `MEMTHREAD|${tag}| ${n}` }]);
    await mem.compact(t);
    await mem.applyWorkingMemoryUpdate(t, { v: `WMRES|${tag}|` }, p.who);
    await new AgentMemory({ storage: view, workingMemory: { scope: 'thread' } }).applyWorkingMemoryUpdate(t, { v: `WMTHR|${tag}|` });
  }
}

/** The journal (every organization), and every person's threads, messages and working memory, as text. */
async function memoryDump(b: Backend, people: Person[]): Promise<string> {
  const keys = await b.storage.runs.listKeys!('');
  const out = await Promise.all(keys.map(async (k) => `${k}=${JSON.stringify(await b.storage.runs.get(k))}`));
  for (const [i, p] of people.entries()) {
    const m = (p.orgId ? withOrgStorage(b.storage, p.orgId) : b.storage).memory!;
    out.push(JSON.stringify((await m.getMessages(memThread(i), { limit: 100 })).items.map((r) => r.message)));
    out.push(JSON.stringify(await m.getObservations(memThread(i))));
    out.push(JSON.stringify(await m.getWorkingMemory(workingMemoryScope.resource(p.who)) ?? null));
    out.push(JSON.stringify(await m.getWorkingMemory(workingMemoryScope.thread(memThread(i))) ?? null));
    out.push(JSON.stringify(await m.getWorkingMemory(`res:${p.who}`) ?? null));
    out.push(JSON.stringify(await m.getWorkingMemory(memThread(i)) ?? null));
  }
  // Observation vectors, from every partition: the observer's `OM|…|` text, read back as `OMVEC|…|`.
  for (const org of new Set(people.map((p) => p.orgId))) {
    const v = (org ? withOrgStorage(b.storage, org) : b.storage).vectors!;
    for (const m of await v.query([1, 0], 1000)) out.push(m.text.replace(/^OM\|/, 'OMVEC|'));
  }
  return out.join('\n');
}

function memSurvivors(text: string, people: Person[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const p of people) {
    const tag = tagOf(p);
    out[tag] = MEM_KINDS.filter((k) => text.includes(`${k}|${tag}|`) || text.includes(JSON.stringify(`${k}|${tag}|`).slice(1, -1)));
  }
  return out;
}

describe.each(BACKENDS)('eraseSubject(storage) and AgentMemory on %s', (name, make) => {
  it('the person\'s threads, messages, working memory and observations go; namesakes and lookalikes keep theirs', async () => {
    const b = await withMemoryPort(await make());
    const people = [...MEM_TARGETS, ...MEM_NEIGHBOURS];
    await memoryWorld(b, people);
    const before = memSurvivors(await memoryDump(b, people), people);
    for (const p of people) expect(before[tagOf(p)], `seeded ${tagOf(p)}`).toEqual([...MEM_KINDS]);

    const root = toJournal(b.storage.runs);
    const reports = [];
    for (const p of MEM_TARGETS) reports.push(await erase(b, root, p));

    const after = memSurvivors(await memoryDump(b, people), people);
    for (const p of MEM_TARGETS) expect(after[tagOf(p)], `erased ${tagOf(p)}`).toEqual([]);
    for (const p of MEM_NEIGHBOURS) expect(after[tagOf(p)], `kept ${tagOf(p)}`).toEqual([...MEM_KINDS]);
    // Working memory: the 0.7 record and the 0.6 one.
    for (const r of reports) expect({ threads: r.memoryThreads, wm: r.workingMemory, unreached: r.unreachedThreads }).toEqual({ threads: 1, wm: 2, unreached: [] });
    (results[name] ??= {}).memory = after;
  });
});

describe('drift: every store gives the in-memory store\'s answer', () => {
  it('the same scenarios, the same survivors, on every store', () => {
    const names = BACKENDS.map(([n]) => n);
    const ran = names.filter((n) => results[n]?.neighbours && results[n]?.literal && results[n]?.lone && results[n]?.primitive && results[n]?.memory);
    expect(ran, 'every store completed every scenario').toEqual(names);
    const strip = (r: Record<string, unknown>) => ({ ...r, neighbours: (r.neighbours as { after: unknown }).after });
    const reference = strip(results.InMemory!);
    for (const n of names) expect(strip(results[n]!), n).toEqual(reference);
  });
});
