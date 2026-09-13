// @gnldev/cache — cross-run content-hash cache built on top of CacheStore. Key is run-independent (`<ns>:<hash>`)
// → a result computed in one run is reused across OTHER runs. (Within-run reuse is already
// journal replay; this closes the across-run gap — e.g. the same RAG query in two runs → embed once.)
//
// BEST-EFFORT: Cache is an optional accelerator → a store error (e.g. cache storage down) does NOT BLOW UP the run.
// get error → miss, set error → no-op, getOrCompute → still computes. (run/memory stays STRICT.)
// Value is wrapped in `{ v }` → distinguishes a cached `undefined` from "not present".
// VISIBILITY: `stats()` returns in-process hit/miss counters + known key count; `invalidate(key?)`
// deletes a single key or (best-effort, since CacheStore doesn't offer enumeration, only what this instance knows about)
// deletes all of them (the Studio Cache view wraps these — see packages/studio/src/server.ts StudioCache).
import { argsHash } from '@gnldev/durable';
import type { CacheStore } from '@gnldev/durable';

export interface CacheSetOptions {
  /** Time-to-live (ms). Applied if the storage supports the 'ttl' capability. */
  ttlMs?: number;
}

export interface CacheOptions {
  /** Called on a store error (best-effort: the error is swallowed, the run continues). */
  onError?: (op: 'get' | 'set' | 'delete', err: unknown) => void;
}

/** Hit/miss counters for the Studio Cache view (see `stats()`). */
export interface CacheStats {
  hits: number;
  misses: number;
  /** hits / (hits+misses); 0 if there are no requests at all. */
  hitRate: number;
  /** Count of keys this instance KNOWS ABOUT (touched via get/set/getOrCompute) — since CacheStore
   *  doesn't offer enumeration, this is NOT the store's ACTUAL total size (see `invalidate()`). */
  size: number;
}

export interface Cache {
  get<T = unknown>(key: unknown): Promise<T | undefined>;
  set(key: unknown, value: unknown, opts?: CacheSetOptions): Promise<void>;
  /** Returns the cached value if present; otherwise (or on a store error) runs compute(), stores it, and returns it. */
  getOrCompute<T>(key: unknown, compute: () => Promise<T> | T, opts?: CacheSetOptions): Promise<T>;
  /** In-process hit/miss counters + known key count (best-effort, NOT persistent —
   *  resets if the process restarts; the store's job is storing values, not counting). */
  stats(): CacheStats;
  /**
   * If key is given, deletes only that key from the store; if not (best-effort), deletes all keys
   * this instance KNOWS ABOUT — since CacheStore doesn't offer key enumeration (listKeys), this is
   * NOT THE SAME THING as clearing the entire store (only covers keys this process has seen through
   * this cache instance). Store errors are swallowed (same `onError` channel — 'delete').
   * Returns the number of keys deleted.
   */
  invalidate(key?: unknown): Promise<number>;
}

export function createCache(store: CacheStore, namespace = 'default', opts: CacheOptions = {}): Cache {
  const keyOf = (key: unknown) => `${namespace}:${argsHash(key)}`;
  let hits = 0;
  let misses = 0;
  const known = new Set<string>(); // full (namespaced) keys this instance has seen → basis for invalidate()

  async function safeGet<T>(k: string): Promise<{ v: T } | undefined> {
    try {
      return await store.get<{ v: T }>(k);
    } catch (err) {
      opts.onError?.('get', err); // cache down → miss
      return undefined;
    }
  }
  async function safeSet(k: string, value: unknown, set?: CacheSetOptions): Promise<void> {
    try {
      await store.set(k, value, set);
      known.add(k);
    } catch (err) {
      opts.onError?.('set', err); // cache down → no-op
    }
  }
  async function safeDelete(k: string): Promise<boolean> {
    try {
      await store.delete(k);
      known.delete(k);
      return true;
    } catch (err) {
      opts.onError?.('delete', err); // cache down → no-op
      return false;
    }
  }

  return {
    async get<T = unknown>(key: unknown): Promise<T | undefined> {
      const k = keyOf(key);
      const rec = await safeGet<T>(k);
      if (rec === undefined) { misses++; return undefined; }
      hits++;
      known.add(k); // was readable → exists in store, now known
      return rec.v;
    },
    async set(key: unknown, value: unknown, set?: CacheSetOptions): Promise<void> {
      await safeSet(keyOf(key), { v: value }, set);
    },
    async getOrCompute<T>(key: unknown, compute: () => Promise<T> | T, set?: CacheSetOptions): Promise<T> {
      const k = keyOf(key);
      const hit = await safeGet<T>(k);
      if (hit !== undefined) { hits++; known.add(k); return hit.v; }
      misses++;
      const v = await compute();
      await safeSet(k, { v }, set);
      return v;
    },
    stats(): CacheStats {
      const total = hits + misses;
      return { hits, misses, hitRate: total === 0 ? 0 : hits / total, size: known.size };
    },
    async invalidate(key?: unknown): Promise<number> {
      if (key !== undefined) {
        return (await safeDelete(keyOf(key))) ? 1 : 0;
      }
      let n = 0;
      for (const k of [...known]) {
        if (await safeDelete(k)) n++;
      }
      return n;
    },
  };
}
