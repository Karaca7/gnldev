// Task 2 — Redis WAIT opt-in (RedisStorageOptions.waitReplicas): closes the async-replication gap
// (CORE-HARDENING §8.2 — a claim acked only by the primary can be LOST on the replica promoted during
// failover) with an OPT-IN strong guarantee: after a GENUINE new claim (putIfAbsent/putIfMatch actually
// wrote something new, not a lost race), call native Redis `WAIT replicas timeoutMs` and act on the ack
// shortfall per `onTimeout`. Default (`waitReplicas` undefined) is BYTE-FOR-BYTE unchanged — `wait()` is
// never called. Uses a fake RedisLike (test/fake-redis.ts) — no real Redis.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { RedisStorage, ReplicationNotAcknowledgedError } from '../src/index.js';
import type { RedisLike } from '../src/redis-storage.js';
import { makeFakeRedis } from './fake-redis.js';
import type { FakeRedis } from './fake-redis.js';

/** Wraps a real FakeRedis and adds a controllable `wait()` — `waitImpl` undefined → the `wait` field is
 *  ABSENT ENTIRELY (mimics a custom/legacy RedisLike client that doesn't implement native WAIT). */
function waitClient(
  inner: FakeRedis,
  waitImpl?: (replicas: number, timeout: number) => Promise<number> | number,
): { client: RedisLike; calls: { wait: number; args: [number, number][] } } {
  const calls = { wait: 0, args: [] as [number, number][] };
  const base: RedisLike = {
    get: (key: string) => inner.get(key),
    set: (key: string, value: string, ...args: (string | number)[]) => inner.set(key, value, ...args),
    del: (...keys: string[]) => inner.del(...keys),
    scan: (cursor: string | number, ...args: (string | number)[]) => inner.scan(cursor, ...args),
    mget: (...keys: string[]) => inner.mget(...keys),
    eval: (script: string, numKeys: number, ...args: (string | number)[]) => inner.eval(script, numKeys, ...args),
  };
  const client: RedisLike = waitImpl === undefined
    ? base
    : {
        ...base,
        wait: async (replicas: number, timeout: number) => {
          calls.wait++;
          calls.args.push([replicas, timeout]);
          return waitImpl(replicas, timeout);
        },
      };
  return { client, calls };
}

describe('RedisStorage · Task 2 waitReplicas (opt-in strong replication guarantee)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn> | undefined;
  afterEach(() => { warnSpy?.mockRestore(); warnSpy = undefined; });

  it('(a) ack sufficient: wait() is called ONCE per genuine claim, with (replicas, timeoutMs); no warning/throw', async () => {
    const { client, calls } = waitClient(makeFakeRedis(), async () => 2);
    const storage = new RedisStorage({ client, waitReplicas: { replicas: 2, timeoutMs: 50 } });
    const ok = await storage.runs.putIfAbsent('r1:tool:call-1', { status: 'succeeded', output: {} });
    expect(ok).toBe(true);
    expect(calls.wait).toBe(1);
    expect(calls.args[0]).toEqual([2, 50]);
  });

  it("(b) ack insufficient + onTimeout:'throw' → ReplicationNotAcknowledgedError; the claim itself already happened", async () => {
    const { client } = waitClient(makeFakeRedis(), async () => 1);
    const storage = new RedisStorage({ client, waitReplicas: { replicas: 2, timeoutMs: 50, onTimeout: 'throw' } });
    await expect(storage.runs.putIfAbsent('r2:tool:call-1', { status: 'succeeded', output: {} }))
      .rejects.toBeInstanceOf(ReplicationNotAcknowledgedError);
    // WAIT cannot undo a write — a second putIfAbsent for the SAME key still loses the claim (NX).
    const second = await storage.runs.putIfAbsent('r2:tool:call-1', { status: 'succeeded', output: {} });
    expect(second).toBe(false);
  });

  it("(c) ack insufficient + onTimeout:'warn' (default) → warns ONCE per instance, claim(s) still succeed", async () => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client } = waitClient(makeFakeRedis(), async () => 0);
    const storage = new RedisStorage({ client, waitReplicas: { replicas: 1, timeoutMs: 10 } }); // onTimeout omitted → 'warn'
    const ok1 = await storage.runs.putIfAbsent('r3:tool:call-1', { status: 'succeeded', output: {} });
    const ok2 = await storage.runs.putIfAbsent('r3:tool:call-2', { status: 'succeeded', output: {} });
    expect(ok1).toBe(true);
    expect(ok2).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1); // ONCE per instance, not once per shortfall
  });

  it('(d) waitReplicas not given → wait() is NEVER called (existing behavior byte-for-byte unchanged)', async () => {
    const { client, calls } = waitClient(makeFakeRedis(), async () => 5);
    const storage = new RedisStorage({ client }); // no waitReplicas
    const ok = await storage.runs.putIfAbsent('r4:tool:call-1', { status: 'succeeded', output: {} });
    expect(ok).toBe(true);
    expect(calls.wait).toBe(0);
  });

  it('(e) client without a wait() method → silently passes (fail-open), claim still succeeds even with onTimeout:"throw"', async () => {
    const { client } = waitClient(makeFakeRedis()); // no waitImpl → `wait` field absent entirely
    const storage = new RedisStorage({ client, waitReplicas: { replicas: 3, timeoutMs: 10, onTimeout: 'throw' } });
    const ok = await storage.runs.putIfAbsent('r5:tool:call-1', { status: 'succeeded', output: {} });
    expect(ok).toBe(true); // no throw — the client simply can't WAIT, so the check silently no-ops
  });

  it('wait() throwing (network hiccup) is swallowed — fail-open, the already-successful claim still returns true', async () => {
    const { client, calls } = waitClient(makeFakeRedis(), async () => { throw new Error('ECONNRESET'); });
    const storage = new RedisStorage({ client, waitReplicas: { replicas: 1, timeoutMs: 10, onTimeout: 'throw' } });
    const ok = await storage.runs.putIfAbsent('r6:tool:call-1', { status: 'succeeded', output: {} });
    expect(ok).toBe(true);
    expect(calls.wait).toBe(1);
  });

  it('wait() is only triggered by a GENUINE new claim: a LOSING putIfAbsent does not call it', async () => {
    const { client, calls } = waitClient(makeFakeRedis(), async () => 5);
    const storage = new RedisStorage({ client, waitReplicas: { replicas: 1, timeoutMs: 10 } });
    await storage.runs.putIfAbsent('r7:tool:call-1', { status: 'succeeded', output: {} });
    expect(calls.wait).toBe(1);
    const second = await storage.runs.putIfAbsent('r7:tool:call-1', { status: 'succeeded', output: {} }); // already exists → loses
    expect(second).toBe(false);
    expect(calls.wait).toBe(1); // NOT called again for the losing attempt
  });

  it('wait() also gates putIfMatch (H1 lock takeover) on a genuine CAS win, not on a failed match', async () => {
    const { client, calls } = waitClient(makeFakeRedis(), async () => 5);
    const storage = new RedisStorage({ client, waitReplicas: { replicas: 1, timeoutMs: 10 } });
    await storage.runs.put('r8:lockkey', { holder: 'a' });
    const mismatch = await (storage.runs as any).putIfMatch('r8:lockkey', { holder: 'WRONG' }, { holder: 'b' });
    expect(mismatch).toBe(false);
    expect(calls.wait).toBe(0); // no genuine write → wait() not called
    const ok = await (storage.runs as any).putIfMatch('r8:lockkey', { holder: 'a' }, { holder: 'b' });
    expect(ok).toBe(true);
    expect(calls.wait).toBe(1);
  });
});
