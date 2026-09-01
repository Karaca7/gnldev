// The SIXTH key family: the event LOG NAMESPACE (`evt:<topic>`), which key-ambiguity.test.ts
// deliberately left out.
//
// That exclusion was argued from the WorkStore PORT: `list(ns)` is defined as "the records appended
// under exactly this ns", so a namespace needs no escaping — the store matches it whole. Three of the
// four shipped adapters do exactly that (InMemory: a Map keyed by ns; SQLite/Postgres: `WHERE ns = ?`).
// The fourth did not. RedisWorkStore stored a record at `<pfx>wl:<ns>:<id>` and read a namespace back
// with `SCAN MATCH <pfx>wl:<ns>:*` — a PREFIX scan with `:` as an unescaped delimiter on BOTH sides of
// the join. Measured on a real Redis 7 before the fix:
//
//   F1  'orders' consumer received: 2 ["global-order","EU-ONLY-ORDER"]   <- never subscribed to 'orders:eu'
//   F2  emit returns: ["x","eu:x"]                                        <- both reported success
//       'inv:eu' consumer saw: ["A-first"]                                <- 'B-PAID' was never written
//       KEYS: [... "wl:evt:inv:eu:x" ...]                                 <- ONE key for TWO events
//
// F2 is the worse half: `emit` returns an event id for a record that `SET NX` silently refused,
// because a different topic's (ns, id) split hashed onto the same Redis key. No dead-letter row, no
// log line — the exact class of loss the escaping round existed to remove.
//
// This file pins BOTH layers, because they fail independently:
//   1. The ADAPTER (the load-bearing fix): RedisWorkStore now escapes `ns` when it derives a key, so
//      the ns→key mapping is injective and `list` cannot see a neighbour's records.
//   2. The PACKAGE (defence in depth): events escapes the topic into the namespace as well, so it
//      does not depend on a property of the store that it cannot observe. WorkStore is a public port;
//      the store that got this wrong for months was one of our own.
//
// …and it pins them in TWO SEPARATE describes, because going through `emit`/`createConsumer` cannot
// reach the adapter's bug at all. MEASURED (mutation): with `encNs` reduced to `return ns`, every
// test in the `describe.each` below stays GREEN on the Redis case — the package escape has already
// turned the topic into `evt:orders%3Aeu` by the time the adapter sees it, so `SCAN MATCH
// wl:evt:orders:*` no longer matches it. The end-to-end case therefore MASKS layer 1 rather than
// covering it; the adapter is asserted directly, on plain namespaces, in the first describe.
// (The `describe.each` Redis case is kept anyway: it is the only place the two layers run composed,
// and it costs one fake-Redis instance. It is a composition smoke test, not the adapter's pin.)
import { describe, it, expect } from 'vitest';
import type { WorkStore, ListQuery, Page, LogRecord } from '@gnldev/durable';
import { RedisStorage } from '../../durable/src/redis-storage.js';
import { makeFakeRedis } from '../../durable/test/fake-redis.js';
import { emit, createConsumer } from '../src/index.js';

/** The shipped Redis adapter over the SCAN/MATCH-faithful fake — the layout the bug lived in. */
const redisWork = (): WorkStore => new RedisStorage({ client: makeFakeRedis(), keyPrefix: 'gnl:' }).work;

/**
 * A WorkStore that derives its storage key by joining `ns` and `id` with `:` and answers `list` with
 * a prefix match — i.e. RedisWorkStore as it shipped, distilled to nine lines and with no Redis in it.
 *
 * It is here on purpose, and it is NOT a bug being pinned: it is the stand-in for any store that
 * addresses a record by a concatenated key (a Redis/Valkey/DynamoDB/S3-prefix implementation a user
 * writes against the public `WorkStore` port). The tests that use it assert a property of THIS
 * package — that events' own namespaces are self-disambiguating — which stays true no matter what
 * the adapter underneath does. Fixing the adapter alone would leave that property untested.
 */
function prefixJoinWork(): WorkStore {
  const log = new Map<string, LogRecord<any>>();
  const kv = new Map<string, unknown>();
  return {
    async append(ns, payload, id) {
      const eid = id ?? `${ns}-${log.size}`;
      const key = `${ns}:${eid}`;
      if (!log.has(key)) log.set(key, { id: eid, payload, ts: Date.now() } as LogRecord<any>);
      return eid;
    },
    async list<T = unknown>(ns: string, _q?: ListQuery): Promise<Page<LogRecord<T>>> {
      const items = [...log.entries()].filter(([k]) => k.startsWith(`${ns}:`)).map(([, v]) => v as LogRecord<T>);
      return { items, nextCursor: undefined };
    },
    async get<T = unknown>(key: string) { return kv.get(key) as T | undefined; },
    async put(key, value) { kv.set(key, value); },
    async ackOnce(key) { if (kv.has(key)) return false; kv.set(key, true); return true; },
  };
}

// ── LAYER 1: the adapter, on its own ─────────────────────────────────────────────────────────────
// No `emit`, no `createConsumer`, no `evt:` prefix — just `WorkStore.append`/`list` with plain
// namespaces, which is the contract EVERY caller of the port gets (the queue's `qjob`, a durable
// run's log, a user's own namespace), not only this package's. These assertions live in the events
// package purely because the audit round that produced them may touch only this file and this is
// where the fake Redis is already wired up; they belong to @gnldev/durable and the real-Redis half
// of them is in durable/test/integration-real.test.ts, behind Docker. This describe is the copy
// that runs in the DEFAULT suite.
describe('@gnldev/durable — RedisWorkStore: the ns→key mapping is injective (no events involved)', () => {
  const work = () => new RedisStorage({ client: makeFakeRedis(), keyPrefix: 'gnl:' }).work;

  // READ direction. `list(ns)` is specified as a whole-value match; this adapter answers it with a
  // `SCAN MATCH <pfx>wl:<ns>:*` prefix scan, so an unescaped `:` in the ns makes a parent namespace's
  // scan pattern a prefix of its child's key space.
  it('list(ns) does not return a neighbouring namespace\'s records', async () => {
    const w = work();
    await w.append('nspar', { tag: 'PARENT' }, 'p-1');
    await w.append('nspar:child', { tag: 'CHILD' }, 'c-1');
    expect((await w.list('nspar')).items.map((i) => i.id)).toEqual(['p-1']); // ['c-1','p-1'] = leak
    expect((await w.list('nspar:child')).items.map((i) => i.id)).toEqual(['c-1']);
  });

  // WRITE direction, the silent-loss half: ('nsbnd:eu','x') and ('nsbnd','eu:x') are two different
  // records that used to address ONE key. `append` is SET NX, so the second one was refused with no
  // error while `append` still returned its id.
  it('two records whose ns/id split differs are not collapsed onto one key', async () => {
    const w = work();
    const first = await w.append('nsbnd:eu', { tag: 'A-first' }, 'x');
    const second = await w.append('nsbnd', { tag: 'B-PAID' }, 'eu:x');
    expect([first, second]).toEqual(['x', 'eu:x']); // both reported success before the fix too
    expect((await w.list('nsbnd:eu')).items.map((i) => (i.payload as any).tag)).toEqual(['A-first']);
    expect((await w.list('nsbnd')).items.map((i) => (i.payload as any).tag)).toEqual(['B-PAID']);
  });

  // The `%` half of `encNs`, which nothing else pins: escaping ONLY `:` is not injective, because
  // then the namespace literally named `a%3Ab` and the namespace `a:b` both map to `a%3Ab` and the
  // leak comes straight back one level down. MEASURED: dropping the `%` replace from `encNs` leaves
  // the whole durable+events suite green EXCEPT this test — one failure out of 1616 — and the audit
  // that found the hole measured the Docker integration run green under the same mutation too.
  it('a namespace containing the escape sequence itself stays a separate namespace', async () => {
    const w = work();
    await w.append('a%3Ab', { tag: 'LITERAL' }, 'r1');
    await w.append('a:b', { tag: 'COLON' }, 'r2');
    expect((await w.list('a%3Ab')).items.map((i) => (i.payload as any).tag)).toEqual(['LITERAL']);
    expect((await w.list('a:b')).items.map((i) => (i.payload as any).tag)).toEqual(['COLON']);
  });

  // globEscape's job, at the SCAN site that already had it: a `*`/`?`/`[` inside the NAMESPACE must
  // match itself, not widen the pattern. Distinct from encNs — `:` is not a glob metacharacter and a
  // glob escape cannot fix a delimiter ambiguity, which is why both escapes exist. `encNs` leaves
  // glob characters alone on purpose (it is not a general encoder), so this line is the only thing
  // standing between a topic named `g*` and every namespace beginning with `g`.
  it('a glob metacharacter in the namespace matches literally', async () => {
    const w = work();
    await w.append('g*', { tag: 'STAR' }, 'k1');
    await w.append('ga', { tag: 'PLAIN' }, 'k2');
    expect((await w.list('g*')).items.map((i) => (i.payload as any).tag)).toEqual(['STAR']);
    expect((await w.list('ga')).items.map((i) => (i.payload as any).tag)).toEqual(['PLAIN']);
  });

  // …and the same for the caller's `keyPrefix`, which was going into nine of the ten SCAN patterns
  // RAW. A metacharacter there makes the pattern match the keys of the store NEXT DOOR, so
  // `listKeys`/`readRun`/`listRuns` return another store's data — and `listKeys` then slices its own
  // (longer) prefix length off those keys and hands back corrupted key text.
  //
  // The originally measured prefix was `X[a]:` (a character class matching `Xa:`); `X*:` is used here
  // because fake-redis.ts's `globToRegExp` implements `\`, `*` and `?` but NOT `[...]`, so a bracket
  // would be matched literally by the fake and this test could not go red on it. `*` is the same bug
  // through the same line. The bracket form is exercised against a real server in
  // durable/test/integration-real.test.ts.
  it('a glob metacharacter in keyPrefix does not read the neighbouring store', async () => {
    const client = makeFakeRedis();
    const meta = new RedisStorage({ client, keyPrefix: 'X*:' });
    const neighbour = new RedisStorage({ client, keyPrefix: 'Xabc:' });
    await neighbour.runs.put('nrun:model:0', { who: 'NEIGHBOUR' });
    await meta.runs.put('brun:model:0', { who: 'MINE' });

    // ['j:nrun:model:0', 'brun:model:0'] = the neighbour's key, sliced at MY prefix length.
    expect(await meta.runs.listKeys!('')).toEqual(['brun:model:0']);
    expect(await meta.runs.readRun('nrun')).toEqual([]); // the neighbour's run is not mine
    expect((await meta.runs.listRuns()).items.map((r) => r.runId)).toEqual(['brun']);
    // and the neighbour is unharmed in the other direction (its prefix has no metacharacter).
    expect(await neighbour.runs.listKeys!('')).toEqual(['nrun:model:0']);
  });
});

// ── LAYER 2: the package ─────────────────────────────────────────────────────────────────────────
const CASES: Array<[string, () => WorkStore]> = [
  ['the shipped Redis adapter (SCAN/MATCH)', redisWork],
  ['a store that joins ns and id into one key', prefixJoinWork],
];

describe.each(CASES)('@gnldev/events — the event log namespace on %s', (_name, makeWork) => {
  // F1. `orders` and `orders:eu` are two ordinary topic names (the same regional convention
  // key-ambiguity.test.ts pins for consumers). A subscriber to the parent must not be handed the
  // child's events: it never subscribed, its handler is written for a different payload shape, and
  // on a fan-out bus "a topic I did not name" is an authorization boundary, not a nuisance.
  it('a topic does not receive a neighbouring topic\'s events', async () => {
    const work = makeWork();
    const got: string[] = [];
    const c = createConsumer(work, 'orders', (p: any) => void got.push(p.tag), { name: 'plain' });

    await emit(work, 'orders', { tag: 'global-order' }, { id: 'o-1' });
    await emit(work, 'orders:eu', { tag: 'EU-ONLY-ORDER' }, { id: 'o-2' });

    expect(await c.poll()).toBe(1); // 2 = 'orders:eu' leaked into the 'orders' scan
    expect(got).toEqual(['global-order']);
  });

  // ...and the leak is not one-directional bleed-through: the child must still get its own event
  // exactly once, so a fix that simply narrowed the scan into losing records is not green here.
  it('the neighbouring topic still receives its own event', async () => {
    const work = makeWork();
    const got: string[] = [];
    const c = createConsumer(work, 'orders:eu', (p: any) => void got.push(p.tag), { name: 'plain' });

    await emit(work, 'orders', { tag: 'global-order' }, { id: 'o-1' });
    await emit(work, 'orders:eu', { tag: 'EU-ONLY-ORDER' }, { id: 'o-2' });

    expect(await c.poll()).toBe(1);
    expect(got).toEqual(['EU-ONLY-ORDER']);
    expect(await c.poll()).toBe(0); // still exactly-once
  });

  // F2, the silent-loss half. `(topic 'inv:eu', id 'x')` and `(topic 'inv', id 'eu:x')` are two
  // different events by every rule this package states; they collapsed onto one storage key, and
  // append is first-write-wins, so the SECOND emit returned an id for a record that does not exist.
  it('an emit is never silently dropped by another topic\'s record', async () => {
    const work = makeWork();
    const first = await emit(work, 'inv:eu', { tag: 'A-first' }, { id: 'x' });
    const second = await emit(work, 'inv', { tag: 'B-PAID' }, { id: 'eu:x' });
    expect([first, second]).toEqual(['x', 'eu:x']); // both reported success before the fix too

    const seenEu: string[] = [];
    const seenPlain: string[] = [];
    const cEu = createConsumer(work, 'inv:eu', (p: any) => void seenEu.push(p.tag), { name: 'mail' });
    const cPlain = createConsumer(work, 'inv', (p: any) => void seenPlain.push(p.tag), { name: 'mail' });

    await cEu.poll();
    await cPlain.poll();
    expect(seenEu).toEqual(['A-first']);
    expect(seenPlain).toEqual(['B-PAID']); // [] = the second emit's payload was never stored
  });

  // The escape has to be injective for the namespace exactly as it is for the five marker families:
  // a topic literally named `inv%3Aeu` and the topic `inv:eu` are different topics, and a `%`-blind
  // escape maps them onto one namespace and re-creates the leak one level down.
  it('a topic containing the escape sequence itself stays a separate topic', async () => {
    const work = makeWork();
    const literal: string[] = [];
    const colon: string[] = [];
    const cL = createConsumer(work, 'inv%3Aeu', (p: any) => void literal.push(p.tag), { name: 'm' });
    const cC = createConsumer(work, 'inv:eu', (p: any) => void colon.push(p.tag), { name: 'm' });

    await emit(work, 'inv%3Aeu', { tag: 'LITERAL' }, { id: 'e1' });
    await emit(work, 'inv:eu', { tag: 'COLON' }, { id: 'e2' });

    expect(await cL.poll()).toBe(1);
    expect(await cC.poll()).toBe(1);
    expect(literal).toEqual(['LITERAL']);
    expect(colon).toEqual(['COLON']);
  });

  // The `evt:` PREFIX, the other half of `logNsOf` and the one with no coverage at all: deleting it
  // left all 61 events tests green, because every one of them reads back through the same function.
  // It is not decoration. A WorkStore is SHARED — @gnldev/queue keeps every job in the plain
  // namespace `qjob` (queue/src/index.ts:111,153) and the caller can use any name it likes — so
  // without the prefix a topic named `qjob` IS the queue's job log: the consumer is handed job
  // records its handler was never written for, and `listJobs` is handed events it will try to run.
  it('an event topic cannot collide with a non-events namespace of the same name', async () => {
    const work = makeWork();
    // The queue, writing its own log through the same store (its real ns, no events involved).
    await work.append('qjob', { type: 'send-mail', payload: {} }, 'j-1');

    const got: unknown[] = [];
    const c = createConsumer(work, 'qjob', (p: any) => void got.push(p), { name: 'w' });
    await emit(work, 'qjob', { tag: 'AN-EVENT' }, { id: 'e-1' });

    expect(await c.poll()).toBe(1); // 2 = the queue's job was delivered as an event
    expect(got).toEqual([{ tag: 'AN-EVENT' }]);
    // …and the other direction: the queue's own log is not polluted with events.
    expect((await work.list('qjob')).items.map((i) => i.id)).toEqual(['j-1']);
  });
});
