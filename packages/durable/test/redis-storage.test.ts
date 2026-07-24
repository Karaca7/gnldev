// RedisStorage — unit tests running against a fake RedisLike (test/fake-redis.ts). No real Redis.
// Verifies the ports (runs/work/cache/meta) provided by RedisStorage; memory/vectors='none' (override).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { RedisStorage } from '../src/redis-storage.js';
import type { RedisLike } from '../src/redis-storage.js';
import { InMemoryStorage, composite, requireCapability, CapabilityError } from '../src/index.js';
import { FakeRedis, makeFakeRedis } from './fake-redis.js';
import type { RedisPipeline } from '../src/redis-storage.js';

/** Counting wrapper: wraps a real FakeRedis to observe the number of get/mget calls.
 *  withMget=false → the mget field DOES NOT EXIST AT ALL (triggers the bulkGet fallback path, mimicking non-ioredis legacy clients). */
function countingSpy(inner: FakeRedis, withMget: boolean): { client: RedisLike; calls: { get: number; mget: number } } {
  const calls = { get: 0, mget: 0 };
  const base: RedisLike = {
    get: async (key: string) => { calls.get++; return inner.get(key); },
    set: (key: string, value: string, ...args: (string | number)[]) => inner.set(key, value, ...args),
    del: (...keys: string[]) => inner.del(...keys),
    scan: (cursor: string | number, ...args: (string | number)[]) => inner.scan(cursor, ...args),
  };
  const client: RedisLike = withMget
    ? { ...base, mget: async (...keys: string[]) => { calls.mget++; return inner.mget(...keys); } }
    : base;
  return { client, calls };
}

const mk = (client = makeFakeRedis()) => new RedisStorage({ client });

/** H11 (CORE-HARDENING §8.2 advisory) mock: wraps a real FakeRedis and adds an `info()` field ONLY if
 *  `infoResult` is given (`undefined` → the `info` key is absent entirely, mimicking a custom/legacy
 *  RedisLike client that doesn't implement INFO). `infoResult` may be a string (INFO reply) or an Error
 *  (to exercise the fail-open/swallow-the-rejection path). Counts calls to `info` separately, so tests
 *  can assert it fires AT MOST ONCE (the one-time check) or NOT AT ALL (`replicationWarning: false`). */
function infoClient(inner: FakeRedis, infoResult?: string | Error): { client: RedisLike; calls: { info: number } } {
  const calls = { info: 0 };
  const base: RedisLike = {
    get: (key: string) => inner.get(key),
    set: (key: string, value: string, ...args: (string | number)[]) => inner.set(key, value, ...args),
    del: (...keys: string[]) => inner.del(...keys),
    scan: (cursor: string | number, ...args: (string | number)[]) => inner.scan(cursor, ...args),
    mget: (...keys: string[]) => inner.mget(...keys),
  };
  const client: RedisLike = infoResult === undefined
    ? base
    : {
        ...base,
        info: async (_section?: string) => {
          calls.info++;
          if (infoResult instanceof Error) throw infoResult;
          return infoResult;
        },
      };
  return { client, calls };
}

/** Waits past the microtask queue (client.info()'s own promise resolution + its `.then`) so the
 *  fire-and-forget replication check (which the caller never awaits) has had a chance to run. */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

/** Round-trip counter: wraps a real (multi-supporting) FakeRedis and counts `get`/direct `set`/`zadd`/`eval`
 *  calls AND pipeline `exec()` calls SEPARATELY. When the pipeline branch is taken, the `set`/`zadd`/`eval`
 *  COUNTERS DO NOT INCREASE (they are only queued on the pipe, never hit the wire) — only `multiExec`
 *  increases; this is direct proof of the claim "SET+ZADD collapsed into a single round-trip". */
function pipelineSpy(inner: FakeRedis): { client: RedisLike; calls: { get: number; set: number; zadd: number; eval: number; multiExec: number } } {
  const calls = { get: 0, set: 0, zadd: 0, eval: 0, multiExec: 0 };
  const client: RedisLike = {
    get: async (key: string) => { calls.get++; return inner.get(key); },
    set: async (key: string, value: string, ...args: (string | number)[]) => { calls.set++; return inner.set(key, value, ...args); },
    del: (...keys: string[]) => inner.del(...keys),
    scan: (cursor: string | number, ...args: (string | number)[]) => inner.scan(cursor, ...args),
    mget: (...keys: string[]) => inner.mget(...keys),
    eval: async (script: string, numKeys: number, ...args: (string | number)[]) => { calls.eval++; return inner.eval(script, numKeys, ...args); },
    zadd: async (key: string, score: number, member: string) => { calls.zadd++; return inner.zadd(key, score, member); },
    zrangebyscore: (key: string, min: number | string, max: number | string) => inner.zrangebyscore(key, min, max),
    zrem: (key: string, ...members: string[]) => inner.zrem(key, ...members),
    time: () => inner.time(),
    strlen: (key: string) => inner.strlen(key),
    hincrbyfloat: (key: string, field: string, delta: number) => inner.hincrbyfloat(key, field, delta),
    hgetall: (key: string) => inner.hgetall(key),
    multi: inner.multi
      ? (): RedisPipeline => {
          const pipe = inner.multi!();
          const wrapped: RedisPipeline = {
            set: (...a) => { pipe.set(...a); return wrapped; },
            zadd: (...a) => { pipe.zadd(...a); return wrapped; },
            eval: (...a) => { pipe.eval(...a); return wrapped; },
            exec: async () => { calls.multiExec++; return pipe.exec(); },
          };
          return wrapped;
        }
      : undefined,
  };
  return { client, calls };
}

describe('RedisStorage · RunJournal', () => {
  it('putIfAbsent is ATOMIC (SET NX): first true, second false, value preserved', async () => {
    const b = mk();
    expect(await b.runs.putIfAbsent('claim', 1)).toBe(true);
    expect(await b.runs.putIfAbsent('claim', 2)).toBe(false); // NX → does not write
    expect(await b.runs.get('claim')).toBe(1);
  });

  it('put/get roundtrip + superjson type preservation (Date)', async () => {
    const b = mk();
    const d = new Date('2026-07-08T00:00:00.000Z');
    await b.runs.put('r1:input', { a: 1, when: d, u: undefined });
    const got = await b.runs.get<{ a: number; when: Date; u: undefined }>('r1:input');
    expect(got!.a).toBe(1);
    expect(got!.when).toBeInstanceOf(Date);
    expect(got!.when.getTime()).toBe(d.getTime());
    // put overwrite works (unlike putIfAbsent)
    await b.runs.put('r1:input', { a: 2, when: d });
    expect((await b.runs.get<{ a: number }>('r1:input'))!.a).toBe(2);
  });

  it('listKeys(prefix) returns only keys matching the prefix', async () => {
    const b = mk();
    await b.runs.put('om:t1:observe:0', { x: 1 });
    await b.runs.put('om:t1:observe:1', { x: 2 });
    await b.runs.put('om:t2:observe:0', { x: 3 });
    const keys = (await b.runs.listKeys('om:t1:')).sort();
    expect(keys).toEqual(['om:t1:observe:0', 'om:t1:observe:1']);
  });

  it('readRun: (created_at,key) ordering invariant + contiguous seq; input is not visible', async () => {
    const b = mk();
    await b.runs.put('rx:tool:b', { status: 'succeeded', output: 2 });
    await b.runs.put('rx:model:0', { text: 'hi' });
    await b.runs.put('rx:tool:a', { status: 'succeeded', output: 1 });
    await b.runs.put('rx:input', { prompt: 'p' }); // NOT model/tool → invisible to readRun
    const entries = await b.runs.readRun('rx');
    expect(entries.map((e) => e.key).sort()).toEqual(['rx:model:0', 'rx:tool:a', 'rx:tool:b']);
    expect(entries.map((e) => e.seq)).toEqual([0, 1, 2]); // contiguous, follows insertion order
    // Contract (Decision #4): created_at ASCENDING, key as tie-break on equality — an invariant independent of timing.
    for (let i = 1; i < entries.length; i++) {
      const p = entries[i - 1]!, c = entries[i]!;
      expect(p.ts! < c.ts! || (p.ts === c.ts && p.key <= c.key)).toBe(true);
    }
  });

  it('readRun: tool running→succeeded UPSERT does not double-count (single key)', async () => {
    const b = mk();
    await b.runs.put('ry:model:0', { text: 'hi' });
    await b.runs.put('ry:tool:t1', { status: 'running', startedAt: 1 });
    await b.runs.put('ry:tool:t1', { status: 'succeeded', output: 1 });
    const entries = await b.runs.readRun('ry');
    expect(entries.length).toBe(2);
    const page = await b.runs.listRuns();
    const ry = page.items.find((r) => r.runId === 'ry')!;
    expect(ry.modelSteps).toBe(1);
    expect(ry.toolCalls).toBe(1);
  });

  it('listRuns is PAGINATED (cursor) + 5 distinct runs', async () => {
    const b = mk();
    for (let i = 0; i < 5; i++) await b.runs.put(`run${i}:model:0`, { ok: true });
    const p1 = await b.runs.listRuns({ limit: 2 });
    expect(p1.items.length).toBe(2);
    expect(p1.nextCursor).toBeDefined();
    const p2 = await b.runs.listRuns({ limit: 2, cursor: p1.nextCursor });
    const p3 = await b.runs.listRuns({ limit: 2, cursor: p2.nextCursor });
    expect(p3.nextCursor).toBeUndefined();
    const ids = [...p1.items, ...p2.items, ...p3.items].map((r) => r.runId);
    expect(new Set(ids).size).toBe(5);
  });

  it('deletePrefix: permanently deletes keys starting with the prefix', async () => {
    const b = mk();
    await b.runs.put('rz:model:0', { text: 'hi' });
    await b.runs.put('rz:tool:t1', { status: 'succeeded', output: 1 });
    expect(await (b.runs as any).deletePrefix('rz:')).toBe(2);
    expect((await b.runs.readRun('rz')).length).toBe(0);
    expect(await b.runs.get('rz:model:0')).toBeUndefined();
  });
});

describe('RedisStorage · WorkStore', () => {
  it('append is idempotent (SET NX) + list is ordered', async () => {
    const b = mk();
    await b.work!.append('qjob', { type: 'x' }, 'j1');
    await b.work!.append('qjob', { type: 'x' }, 'j1'); // same id → single record
    await b.work!.append('qjob', { type: 'y' }, 'j2');
    const page = await b.work!.list('qjob');
    expect(page.items.length).toBe(2);
    expect(page.items.map((r) => r.id)).toEqual(['j1', 'j2']);
  });

  it('KV get/put + ackOnce is ATOMIC (SET NX): first true, second false', async () => {
    const b = mk();
    await b.work!.put('qdone:x', { done: true });
    expect(await b.work!.get('qdone:x')).toEqual({ done: true });
    expect(await b.work!.ackOnce('ack:c1:e1')).toBe(true);
    expect(await b.work!.ackOnce('ack:c1:e1')).toBe(false);
  });
});

describe('RedisStorage · CacheStore (native TTL, fake clock)', () => {
  it('set/get + returns undefined once TTL expires (PX)', async () => {
    let now = 1_000_000;
    const b = mk(new FakeRedis(() => now));
    await b.cache!.set('k', 42);
    expect(await b.cache!.get('k')).toBe(42);

    await b.cache!.set('ttl', 'v', { ttlMs: 1000 });
    expect(await b.cache!.get('ttl')).toBe('v'); // still fresh
    now += 999;
    expect(await b.cache!.get('ttl')).toBe('v'); // not expired yet
    now += 2;
    expect(await b.cache!.get('ttl')).toBeUndefined(); // native TTL → expired
  });

  it('ttlMs<=0 is considered expired immediately + delete', async () => {
    const b = mk();
    await b.cache!.set('k2', 'v', { ttlMs: -1 });
    expect(await b.cache!.get('k2')).toBeUndefined();
    await b.cache!.set('k3', 'v');
    await b.cache!.delete('k3');
    expect(await b.cache!.get('k3')).toBeUndefined();
  });
});

describe('RedisStorage · MetaStore + init + capability', () => {
  it('init writes schema_version (idempotent) + meta get/set', async () => {
    const b = mk();
    await b.init();
    expect(await b.meta.get('schema_version')).toBe('1');
    await b.init(); // idempotent
    expect(await b.meta.get('schema_version')).toBe('1');
    await b.meta.set('foo', 'bar');
    expect(await b.meta.get('foo')).toBe('bar');
  });

  it('the capability matrix is honest: memory/vectors=none, requireCapability throws', () => {
    const b = mk();
    expect(b.capabilities).toEqual({ runs: 'full', memory: 'none', vectors: 'none', work: 'full', cache: 'ttl' });
    expect(b.memory).toBeUndefined();
    expect(b.vectors).toBeUndefined();
    expect(() => requireCapability(b, 'runs')).not.toThrow();
    expect(() => requireCapability(b, 'work')).not.toThrow();
    expect(() => requireCapability(b, 'cache')).not.toThrow();
    expect(() => requireCapability(b, 'memory')).toThrow(CapabilityError);
    expect(() => requireCapability(b, 'vectors')).toThrow(CapabilityError);
  });

  it('composite: Redis default (runs/work/cache) + memory/vectors overridden', async () => {
    const redis = mk();
    const mem = new InMemoryStorage();
    const b = composite({ default: redis, overrides: { memory: mem, vectors: mem } });
    expect(b.capabilities.runs).toBe('full');
    expect(b.capabilities.cache).toBe('ttl');
    expect(b.capabilities.memory).toBe('full'); // from the override
    expect(b.capabilities.vectors).toBe('full');
    expect(b.runs).toBe(redis.runs); // runs always comes from default
    expect(() => requireCapability(b, 'memory')).not.toThrow();
    await b.memory!.upsertThread({ id: 't1', resourceId: 'u1', createdAt: 1, updatedAt: 1 });
    expect((await mem.memory.getThread('t1'))!.id).toBe('t1');
  });
});

describe('RedisStorage · SCAN at-least-once resilience', () => {
  it('readRun/listRuns do not double-count even if SCAN returns the same key twice', async () => {
    // Real Redis SCAN's guarantee is at-least-once: during a rehash the same key can appear on more
    // than one page. We wrap the fake so every SCAN result is DUPLICATED across two pages.
    const inner = makeFakeRedis();
    const dup: typeof inner = Object.create(inner);
    let page: string[] | null = null;
    dup.scan = async (cursor, ...args) => {
      if (cursor === '0' && page == null) {
        const [, keys] = await inner.scan('0', ...args);
        page = keys;
        return ['1', keys]; // page 1
      }
      const keys = page ?? [];
      page = null;
      return ['0', keys]; // page 2: SAME keys again
    };
    const b = new RedisStorage({ client: dup });
    await b.runs.put('r1:model:0', { x: 1 });
    await b.runs.put('r1:tool:t1', { status: 'succeeded' });

    const entries = await b.runs.readRun('r1');
    expect(entries).toHaveLength(2); // a single entry despite the duplicate SCAN

    const runs = await b.runs.listRuns();
    expect(runs.items).toEqual([{ runId: 'r1', status: 'completed', modelSteps: 1, toolCalls: 1 }]);

    expect(await b.runs.listKeys('r1:')).toHaveLength(2);
  });
});

describe('RedisStorage · N+1 efficiency (bulkGet — batched read after SCAN)', () => {
  it('client supporting mget: readRun gives the right result with a SINGLE mget call, get is NEVER called', async () => {
    const inner = makeFakeRedis();
    const { client, calls } = countingSpy(inner, true);
    const b = new RedisStorage({ client });
    await b.runs.put('m1:model:0', { text: 'hi' });
    await b.runs.put('m1:tool:t1', { status: 'succeeded', output: 1 });
    calls.get = 0; calls.mget = 0; // exclude put()'s own GET+SET from the count
    const entries = await b.runs.readRun('m1');
    expect(entries.map((e) => e.key).sort()).toEqual(['m1:model:0', 'm1:tool:t1']);
    expect(calls.mget).toBe(1);
    expect(calls.get).toBe(0);
  });

  it('client WITHOUT mget: sequential GET fallback produces the SAME result as the mget-capable client', async () => {
    const innerA = makeFakeRedis();
    const { client: withMget } = countingSpy(innerA, true);
    const a = new RedisStorage({ client: withMget });

    const innerB = makeFakeRedis();
    const { client: withoutMget, calls } = countingSpy(innerB, false);
    const b = new RedisStorage({ client: withoutMget });

    for (const s of [a, b]) {
      await s.runs.put('m2:model:0', { text: 'hi' });
      await s.runs.put('m2:tool:t1', { status: 'succeeded', output: 1 });
      await s.runs.put('m2:tool:t2', { status: 'suspended', resumeToken: 'x' });
    }
    const expected = (await a.runs.readRun('m2')).map((e) => ({ key: e.key, kind: e.kind, value: e.value }));
    calls.get = 0;
    const got = (await b.runs.readRun('m2')).map((e) => ({ key: e.key, kind: e.kind, value: e.value }));
    expect(got.sort((x, y) => x.key.localeCompare(y.key)))
      .toEqual(expected.sort((x, y) => x.key.localeCompare(y.key)));
    expect(calls.get).toBeGreaterThan(0); // no mget → the fallback really used sequential GET

    // listRuns also takes the same fallback path and produces a consistent result.
    const page = await b.runs.listRuns();
    expect(page.items.find((r) => r.runId === 'm2')).toEqual({ runId: 'm2', status: 'suspended', modelSteps: 1, toolCalls: 2 });
  });

  it('501 keys: correct result via MGET_CHUNK(500) splitting + 2 mget round-trips', async () => {
    const inner = makeFakeRedis();
    const { client, calls } = countingSpy(inner, true);
    const b = new RedisStorage({ client });
    const N = 501;
    for (let i = 0; i < N; i++) await b.work!.append('bigns', { i }, `id${i}`);
    calls.mget = 0;
    const page = await b.work!.list('bigns', { limit: N + 10 });
    expect(page.items.length).toBe(N);
    expect(new Set(page.items.map((r) => r.id)).size).toBe(N);
    expect(calls.mget).toBe(2); // ceil(501/500) chunks
  });
});

// AUDIT FINDING fix: when readRunStats was absent, loadReplayCache's RAM guardrail was disabled;
// when listStaleRuns was absent, retention sweepRuns fell into the O(entire-keyspace) slow path.
describe('RedisStorage · H8c readRunStats (cheap stats for the RAM guardrail)', () => {
  it('client supporting STRLEN (default FakeRedis): entries/bytes correct, input is not visible', async () => {
    const b = mk();
    await b.runs.put('s1:model:0', { text: 'hi' });
    await b.runs.put('s1:tool:t1', { status: 'succeeded', output: 1 });
    await b.runs.put('s1:input', { prompt: 'p' }); // invisible to parseJournalKey → excluded from stats
    const stats = await (b.runs as any).readRunStats('s1');
    expect(stats.entries).toBe(2);
    expect(stats.bytes).toBeGreaterThan(0);
  });

  it('client WITHOUT STRLEN: MGET fallback produces the SAME result as the STRLEN-based reference', async () => {
    const inner = makeFakeRedis();
    const { client } = countingSpy(inner, true); // countingSpy's base never forwards STRLEN
    const b = new RedisStorage({ client });
    await b.runs.put('s2:model:0', { text: 'hi' });
    await b.runs.put('s2:tool:t1', { status: 'succeeded', output: 1 });

    const ref = mk(); // separate store, real FakeRedis with STRLEN
    await ref.runs.put('s2:model:0', { text: 'hi' });
    await ref.runs.put('s2:tool:t1', { status: 'succeeded', output: 1 });

    const stats = await (b.runs as any).readRunStats('s2');
    const refStats = await (ref.runs as any).readRunStats('s2');
    expect(stats).toEqual(refStats); // same content → same entries/bytes (STRLEN vs MGET fallback)
  });

  it('an empty/nonexistent run: entries=0, bytes=0', async () => {
    const b = mk();
    expect(await (b.runs as any).readRunStats('yok')).toEqual({ entries: 0, bytes: 0 });
  });
});

describe('RedisStorage · H8b listStaleRuns (last-activity ZSET index)', () => {
  it('client supporting zadd/zrangebyscore: an old run is returned, a suspended one is EXCLUDED by default', async () => {
    let now = 1_000_000;
    const b = mk(new FakeRedis(() => now));
    await b.runs.put('eski:model:0', { x: 1 });
    now = 1_010_000;
    await b.runs.put('taze:model:0', { x: 1 });
    now = 1_010_001;
    await b.runs.put('askida:tool:t1', { status: 'suspended', output: {} });

    // cutoff=1_010_000 → only 'eski' (score < cutoff); 'taze' score EQUALS cutoff → not included.
    expect(await (b.runs as any).listStaleRuns(1_010_000)).toEqual(['eski']);

    // cutoff greater than all of them → both 'eski'+'taze' are stale; 'askida' is EXCLUDED by default (the safe side).
    const stale = (await (b.runs as any).listStaleRuns(1_010_002)).sort();
    expect(stale).toEqual(['eski', 'taze']);

    // includeSuspended:true → 'askida' is included too.
    const staleAll = (await (b.runs as any).listStaleRuns(1_010_002, { includeSuspended: true })).sort();
    expect(staleAll).toEqual(['askida', 'eski', 'taze']);
  });

  it('putIfMatch (resume/takeover) refreshes last-activity — is no longer considered stale', async () => {
    let now = 1_000_000;
    const b = mk(new FakeRedis(() => now));
    await b.runs.put('r:tool:t1', { status: 'suspended', output: {} });
    now = 2_000_000;
    const ok = await b.runs.putIfMatch(
      'r:tool:t1', { status: 'suspended', output: {} }, { status: 'succeeded', output: 1 },
    );
    expect(ok).toBe(true);
    // If only created_at (`t`) were used, this run would still appear timestamped at 1_000_000 and be
    // WRONGLY considered stale; thanks to the touch ZSET it is now fresh (cutoff is NOT BEFORE 1_500_000).
    expect(await (b.runs as any).listStaleRuns(1_500_000)).toEqual([]);
  });

  it('deletePrefix: a purged run also drops from the ZSET (no leak, never seen "stale" again)', async () => {
    let now = 1_000_000;
    const b = mk(new FakeRedis(() => now));
    await b.runs.put('olu:model:0', { x: 1 });
    await (b.runs as any).deletePrefix('olu:');
    now = 2_000_000;
    expect(await (b.runs as any).listStaleRuns(1_500_000)).toEqual([]); // 'olu' is no longer in the ZSET
  });

  it('client NOT supporting zadd/zrangebyscore: listStaleRuns remains UNDEFINED (type-based feature detection)', async () => {
    const inner = makeFakeRedis();
    const { client } = countingSpy(inner, true); // base has no zadd/zrangebyscore at all
    const b = new RedisStorage({ client });
    await b.runs.put('x:model:0', { x: 1 });
    expect(typeof (b.runs as any).listStaleRuns).toBe('undefined');
  });

  it('touch write-path does NOT CHANGE put/putIfAbsent/putIfMatch return values (no regression)', async () => {
    const b = mk();
    expect(await b.runs.putIfAbsent('t:tool:c1', { status: 'running', startedAt: 1 })).toBe(true);
    expect(await b.runs.putIfAbsent('t:tool:c1', { status: 'running', startedAt: 2 })).toBe(false);
    await b.runs.put('t:model:0', { text: 'hi' });
    expect(await b.runs.get('t:model:0')).toEqual({ text: 'hi' });
  });
});

// Audit fix: touch (H8b ZSET) ZADD used to be added to put/putIfAbsent/putIfMatch's write command
// (+1 RTT). If the client supports `multi()`, it is now pipelined into the SAME round-trip. The
// default FakeRedis (used by ALL tests above) does NOT DEFINE multi → those tests still run the old
// (separate-call) path UNCHANGED (see fake-redis.ts). Here the pipeline branch is verified with a
// fake client where `withMulti=true`.
describe('RedisStorage · H8b touch pipeline (multi() — audit fix)', () => {
  it('put: SET+ZADD in a SINGLE round-trip (multiExec=1, separate set/zadd are NEVER called); value + touch produce the same result', async () => {
    const inner = makeFakeRedis(undefined, true); // multi-capable
    const { client, calls } = pipelineSpy(inner);
    const b = new RedisStorage({ client });

    await b.runs.put('p1:model:0', { text: 'hi' });
    expect(calls.set).toBe(0); // pipelined → direct SET never called
    expect(calls.zadd).toBe(0); // pipelined → direct ZADD never called
    expect(calls.multiExec).toBe(1); // only a SINGLE pipeline round-trip (GET is still separate: created_at guard)

    // Behavior identical: value can be read, ZSET is refreshed (listStaleRuns sees it as "fresh").
    expect(await b.runs.get('p1:model:0')).toEqual({ text: 'hi' });
    expect(await (b.runs as any).listStaleRuns(Date.now() + 1)).toEqual(['p1']);
  });

  it('putIfAbsent (winner): SET NX+ZADD in a SINGLE round-trip, returns true, value preserved', async () => {
    const inner = makeFakeRedis(undefined, true);
    const { client, calls } = pipelineSpy(inner);
    const b = new RedisStorage({ client });

    const ok = await b.runs.putIfAbsent('p2:tool:c1', { status: 'running', startedAt: 1 });
    expect(ok).toBe(true);
    expect(calls.set).toBe(0);
    expect(calls.zadd).toBe(0);
    expect(calls.multiExec).toBe(1);
    expect(await b.runs.get('p2:tool:c1')).toEqual({ status: 'running', startedAt: 1 });
  });

  it('putIfAbsent (loser): returns false, the FIRST value is preserved (behavior identical to the non-pipeline result)', async () => {
    // Reference: the SAME scenario with a non-pipelined FakeRedis must produce the same return/value result.
    const ref = mk();
    expect(await ref.runs.putIfAbsent('p3:tool:c1', { w: 1 })).toBe(true);
    expect(await ref.runs.putIfAbsent('p3:tool:c1', { w: 2 })).toBe(false);

    const inner = makeFakeRedis(undefined, true);
    const { client, calls } = pipelineSpy(inner);
    const b = new RedisStorage({ client });
    expect(await b.runs.putIfAbsent('p3:tool:c1', { w: 1 })).toBe(true);
    calls.multiExec = 0;
    const second = await b.runs.putIfAbsent('p3:tool:c1', { w: 2 });
    expect(second).toBe(false); // DO NOTHING → return/data IDENTICAL to the non-pipeline case
    expect(await b.runs.get('p3:tool:c1')).toEqual(await ref.runs.get('p3:tool:c1'));
    // The losing call is ALSO pipelined (SET NX + ZADD in the same packet) → still a SINGLE round-trip.
    expect(calls.multiExec).toBe(1);
    // DOCUMENTED behavior difference (the safe direction — see the putIfAbsent comment in redis-storage.ts):
    // in the pipeline, ZADD runs EVEN on the losing call (cannot be conditioned without Lua) → run 'p3'
    // already appears fresh (NO premature deletion; it can only DELAY retention, never trigger it EARLY).
    expect(await (b.runs as any).listStaleRuns(Date.now() + 1)).toEqual(['p3']);
  });

  it('putIfMatch (eval CAS, winner): eval+ZADD in a SINGLE round-trip, returns true, value updated', async () => {
    const inner = makeFakeRedis(undefined, true);
    const { client, calls } = pipelineSpy(inner);
    const b = new RedisStorage({ client });

    await b.runs.put('p4:tool:c1', { status: 'suspended', output: {} });
    calls.set = 0; calls.zadd = 0; calls.eval = 0; calls.multiExec = 0; calls.get = 0;

    const ok = await b.runs.putIfMatch('p4:tool:c1', { status: 'suspended', output: {} }, { status: 'succeeded', output: 1 });
    expect(ok).toBe(true);
    expect(calls.get).toBe(1); // raw read is still separate (needed for the CAS)
    expect(calls.eval).toBe(0); // pipelined → direct eval never called
    expect(calls.zadd).toBe(0); // pipelined → direct zadd never called
    expect(calls.multiExec).toBe(1); // eval+zadd in a SINGLE round-trip
    expect(await b.runs.get('p4:tool:c1')).toEqual({ status: 'succeeded', output: 1 });
  });

  it('putIfMatch (no eval, best-effort branch): SET+ZADD in a SINGLE round-trip, returns true (behavior identical)', async () => {
    // A client WITHOUT the eval field but WITH multi support — putIfMatch's best-effort (compare-then-set) branch.
    const inner = makeFakeRedis(undefined, true);
    const { client: withEval } = pipelineSpy(inner);
    const noEval: RedisLike = { ...withEval, eval: undefined };
    const b = new RedisStorage({ client: noEval });

    await b.runs.put('p5:model:0', { text: 'v1' });
    const ok = await b.runs.putIfMatch('p5:model:0', { text: 'v1' }, { text: 'v2' });
    expect(ok).toBe(true); // the best-effort branch always returns true — pipelined or not, SAME result
    expect(await b.runs.get('p5:model:0')).toEqual({ text: 'v2' });
  });

  it('client WITHOUT multi(): the old separate-call behavior still works UNCHANGED (no regression)', async () => {
    const b = mk(); // default FakeRedis — multi is UNDEFINED
    expect(await b.runs.putIfAbsent('p6:tool:c1', { w: 1 })).toBe(true);
    expect(await b.runs.putIfAbsent('p6:tool:c1', { w: 2 })).toBe(false);
    await b.runs.put('p6:model:0', { text: 'hi' });
    expect(await b.runs.get('p6:model:0')).toEqual({ text: 'hi' });
    expect(await b.runs.get('p6:tool:c1')).toEqual({ w: 1 });
  });
});

// CORE-HARDENING §8.2 (AUDIT FINDING — made vocal): Redis replication is ALWAYS asynchronous — a claim
// (SET NX) acknowledged by the primary can be lost on the replica promoted during failover, so
// exactly-once may be violated. Previously nothing checked or surfaced this. RedisRunJournal now does a
// ONE-TIME, fire-and-forget `INFO replication` probe on the first putIfAbsent/putIfMatch call and warns
// (once) if replicas are attached; the probe must NEVER be able to delay or break the claim itself.
describe('RedisStorage · H11 replication advisory (CORE-HARDENING §8.2)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('connected_slaves>0: warns ONCE after the first putIfAbsent, NOT again on the second', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client, calls } = infoClient(makeFakeRedis(), 'role:master\r\nconnected_slaves:2\r\n');
    const b = new RedisStorage({ client });

    expect(await b.runs.putIfAbsent('rep1:tool:c1', { w: 1 })).toBe(true); // claim itself is UNAFFECTED
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/replica/i);
    expect(calls.info).toBe(1);

    expect(await b.runs.putIfAbsent('rep1:tool:c2', { w: 2 })).toBe(true);
    await flush();
    expect(warn).toHaveBeenCalledTimes(1); // NOT warned again
    expect(calls.info).toBe(1); // the probe itself only ever runs once per instance
  });

  it('connected_slaves:0: no warning (no replicas → no async-replication risk)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client } = infoClient(makeFakeRedis(), 'role:master\r\nconnected_slaves:0\r\n');
    const b = new RedisStorage({ client });
    expect(await b.runs.putIfAbsent('rep2:tool:c1', { w: 1 })).toBe(true);
    await flush();
    expect(warn).not.toHaveBeenCalled();
  });

  it('client without `info` at all: no warning, claim still works normally (fail-open)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client } = infoClient(makeFakeRedis()); // `info` field absent entirely
    const b = new RedisStorage({ client });
    expect(await b.runs.putIfAbsent('rep3:tool:c1', { w: 1 })).toBe(true);
    expect(await b.runs.putIfAbsent('rep3:tool:c1', { w: 2 })).toBe(false); // NX semantics unaffected
    await flush();
    expect(warn).not.toHaveBeenCalled();
  });

  it('`info` rejects: fails open SILENTLY (no warning, no throw), claim still succeeds', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client } = infoClient(makeFakeRedis(), new Error('ECONNRESET'));
    const b = new RedisStorage({ client });
    await expect(b.runs.putIfAbsent('rep4:tool:c1', { w: 1 })).resolves.toBe(true);
    await flush();
    expect(warn).not.toHaveBeenCalled();
  });

  it('replicationWarning:false → `info` is never called at all, no warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client, calls } = infoClient(makeFakeRedis(), 'connected_slaves:3');
    const b = new RedisStorage({ client, replicationWarning: false });
    expect(await b.runs.putIfAbsent('rep5:tool:c1', { w: 1 })).toBe(true);
    await flush();
    expect(calls.info).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('putIfMatch also triggers the one-time check (first-caller-wins, either method)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client, calls } = infoClient(makeFakeRedis(), 'connected_slaves:1');
    const b = new RedisStorage({ client });
    await b.runs.put('rep6:tool:c1', { status: 'suspended', output: {} }); // put() does NOT trigger the check
    const ok = await b.runs.putIfMatch(
      'rep6:tool:c1', { status: 'suspended', output: {} }, { status: 'succeeded', output: 1 },
    );
    expect(ok).toBe(true);
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(calls.info).toBe(1);
  });
});
