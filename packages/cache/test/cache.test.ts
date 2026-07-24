// @gnl/cache: getOrCompute computes once; cross-run sharing; get/set; best-effort (store down → run continues).
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '@gnl/durable';
import type { CacheStore } from '@gnl/durable';
import { createCache } from '../src/index.js';

/** A CacheStore that blows up on every call (simulates cache storage down). */
const downStore: CacheStore = {
  async get() { throw new Error('cache down'); },
  async set() { throw new Error('cache down'); },
  async delete() { throw new Error('cache down'); },
};

describe('@gnl/cache', () => {
  it('getOrCompute: same key → compute runs once', async () => {
    const cache = createCache(new InMemoryStorage().cache, 'embeds');
    let calls = 0;
    const compute = () => (calls++, [1, 2, 3]);
    const a = await cache.getOrCompute('hello', compute);
    const b = await cache.getOrCompute('hello', compute);
    expect(a).toEqual([1, 2, 3]);
    expect(b).toEqual([1, 2, 3]);
    expect(calls).toBe(1); // second call comes from cache
  });

  it('cross-run: what is written in one "run" is read in another "run" given the same store+namespace', async () => {
    const store = new InMemoryStorage().cache;
    let calls = 0;
    const c1 = createCache(store, 'q');
    await c1.getOrCompute({ query: 'refund' }, () => (calls++, 'vector'));
    // different cache instance (different logical run) but same store+ns → shared
    const c2 = createCache(store, 'q');
    const v = await c2.getOrCompute({ query: 'refund' }, () => (calls++, 'AGAIN'));
    expect(v).toBe('vector'); // cross-run cache hit
    expect(calls).toBe(1);
  });

  it('get/set plain usage', async () => {
    const cache = createCache(new InMemoryStorage().cache);
    expect(await cache.get('missing')).toBeUndefined();
    await cache.set('k', { a: 1 });
    expect(await cache.get('k')).toEqual({ a: 1 });
  });

  it('best-effort: cache store down → getOrCompute still computes, run does not blow up', async () => {
    const errs: string[] = [];
    const cache = createCache(downStore, 'q', { onError: (op) => errs.push(op) });
    let calls = 0;
    const v = await cache.getOrCompute('x', () => (calls++, 42)); // compute still returns even if store get/set blows up
    expect(v).toBe(42);
    expect(calls).toBe(1);
    expect(await cache.get('x')).toBeUndefined(); // get down → miss (run continues)
    await cache.set('x', 1); // set down → no-op (doesn't throw)
    expect(errs).toContain('get');
    expect(errs).toContain('set');
  });

  // ── stats()/invalidate() — Studio Cache view (hit/miss ratio + manual invalidate) ──────
  it('stats: hit/miss counters + ratio computed correctly', async () => {
    const cache = createCache(new InMemoryStorage().cache, 'stats-ns');
    expect(cache.stats()).toEqual({ hits: 0, misses: 0, hitRate: 0, size: 0 }); // no requests at all → 0 (no division error)
    await cache.get('missing'); // miss
    await cache.set('k', 1);
    await cache.get('k'); // hit
    await cache.get('k'); // hit
    const s = cache.stats();
    expect(s).toEqual({ hits: 2, misses: 1, hitRate: 2 / 3, size: 1 });
  });

  it('stats: getOrCompute hit/miss is also counted', async () => {
    const cache = createCache(new InMemoryStorage().cache, 'ns');
    await cache.getOrCompute('a', () => 1); // miss → compute
    await cache.getOrCompute('a', () => 2); // hit → from cache
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1 });
  });

  it('invalidate(key): deletes only that key → next get is a miss', async () => {
    const cache = createCache(new InMemoryStorage().cache, 'ns');
    await cache.set('a', 1);
    await cache.set('b', 2);
    const deleted = await cache.invalidate('a');
    expect(deleted).toBe(1);
    expect(await cache.get('a')).toBeUndefined();
    expect(await cache.get('b')).toBe(2); // untouched
  });

  it('invalidate(): deletes all known keys if key is not given', async () => {
    const cache = createCache(new InMemoryStorage().cache, 'ns');
    await cache.set('a', 1);
    await cache.set('b', 2);
    const deleted = await cache.invalidate();
    expect(deleted).toBe(2);
    expect(await cache.get('a')).toBeUndefined();
    expect(await cache.get('b')).toBeUndefined();
    expect(cache.stats().size).toBe(0);
  });

  it('invalidate: store down → error is swallowed, returns 0 (run does not blow up)', async () => {
    const errs: string[] = [];
    const cache = createCache(downStore, 'q', { onError: (op) => errs.push(op) });
    const deleted = await cache.invalidate('x');
    expect(deleted).toBe(0);
    expect(errs).toContain('delete');
  });
});
