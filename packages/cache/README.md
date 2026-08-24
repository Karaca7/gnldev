# @gnldev/cache

**Cross-run content-hash cache** on top of a storage's **`cache` port** (`CacheStore`), not the run
journal. The key is run-independent (`<namespace>:<argsHash(key)>`) → a result computed in one run is
**reused in other runs**. (Within-run reuse is already journal replay; this closes the across-run gap.)

**Best-effort by design.** A cache is an accelerator, so a store error never fails the run: a failed
`get` counts as a miss, a failed `set` is a no-op, and `getOrCompute` computes anyway. Pass
`onError` if you want to see those. (`runs`/`memory` stay strict — this leniency is the cache's alone.)

> **Not on npm yet** — no `@gnldev/*` package has been published. Until the first release, use it from a [repo clone](https://github.com/Karaca7/gnl-framework): `pnpm install && pnpm -r build`.

```bash
npm i @gnldev/cache   # peer: @gnldev/durable
```

```ts
import { createCache } from '@gnldev/cache';
import { SqliteStorage } from '@gnldev/durable/sqlite';

const storage = new SqliteStorage('runs.db');
const cache = createCache(storage.cache, 'embeddings');   // the CACHE port, not storage.runs

// Same input → embed computed once; later runs read it back from the cache store.
const vec = await cache.getOrCompute({ text: 'hello' }, () => embed('hello'));
```

## API
- `createCache(store: CacheStore, namespace = 'default', opts?: { onError?(op, err) }) → Cache`
  — the first argument is a **`CacheStore`** (`storage.cache`), not a journal.
- `cache.get(key)` · `cache.set(key, value, opts?)` · `cache.getOrCompute(key, compute, opts?)`
  — the trailing `opts` is `{ ttlMs? }`, honoured by stores whose capability is `'ttl'`
  (SQLite/Postgres/Redis; `InMemory` is `'full'`).
- `cache.stats() → { hits, misses, hitRate, size }` — **in-process** counters, not persistent: they
  reset when the process does, and `size` is only the keys *this instance* has touched, because
  `CacheStore` offers no enumeration.
- `cache.invalidate(key?) → number` — with a key, deletes that one; without, deletes every key this
  instance knows about. For the same reason as `size`, that is **not** "clear the whole store".

Studio's Cache view is a wrapper over these last two (`packages/studio/src/server.ts`, `StudioCache`).

`key` can be any value (hashed stably with `argsHash`). Values are wrapped as `{ v }` before storing,
which is how a cached `undefined` stays distinguishable from a miss.

## How it works
The content-hash key is independent of the run id, so the cache outlives a single run's lifetime. It's
ideal for expensive, pure computations (embed, retrieval, price calculation).

## License

Apache-2.0 — see [LICENSE](./LICENSE).
