# @gnldev/cache

**Cross-run content-hash cache** on top of the journal. The key is run-independent (`cache:<ns>:<hash>`) →
a result computed in one run is **reused in other runs**. (Within-run reuse is already journal replay; this
closes the across-run gap.)

```bash
npm i @gnldev/cache   # peer: @gnldev/durable
```

```ts
import { createCache } from '@gnldev/cache';
import { SqliteStorage } from '@gnldev/durable/sqlite';

const storage = new SqliteStorage('runs.db');
const cache = createCache(storage.cache, 'embeddings');   // the CACHE port, not storage.runs

// Same input → embed computed once; later runs get it back from the journal.
const vec = await cache.getOrCompute({ text: 'hello' }, () => embed('hello'));
```

## API
- `createCache(journal, namespace?) → Cache`
- `cache.get(key)` · `cache.set(key, value)` · `cache.getOrCompute(key, compute)`

`key` can be any value (hashed stably with `argsHash`). The value is stored in the journal → persistent +
crash-proof.

## How it works
The content-hash key is independent of the run id, so the cache outlives a single run's lifetime. It's
ideal for expensive, pure computations (embed, retrieval, price calculation).
