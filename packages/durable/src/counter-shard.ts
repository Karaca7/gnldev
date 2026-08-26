// Counter sharding for the `__metrics__:*` counters.
//
// `__usage__` (budget.ts) was sharded here too and the code has been removed: measured against a
// remote-latency database it was indistinguishable from noise (42.3/40.2 off vs 40.8/42.5 on, 3ms
// injected delay, 4 workers, 64 concurrent). It is written 3 statements per run, not 21, and not
// inside a long-held lock -- it was never the contended row. The module stays separate anyway
// because metrics.ts already imports budget.ts and the reverse import would close a cycle.
//
// WHY IT EXISTS — measured, not assumed. On a 4-worker PM2 cluster at 512 concurrent conversations,
// every completed run incremented the SAME handful of counter rows. 84% of active database
// connections were blocked on row locks, 92.7% of sampled active queries were one counter upsert,
// and throughput capped at ~90 req/s per organization while 14 of 16 cores sat idle.
//
// A shard suffix spreads one logical counter across N physical rows (`__usage__#3`), so N runs can
// increment it at the same time. Every field on these counters is ADDITIVE — `runs`, `tokens`,
// `costUsd`, duration buckets — which is the whole reason this is safe: N partial sums and one total
// are the same number.

/** Parses a shard-count env knob. Absent → `fallback`; 0/garbage → 1, i.e. off. */
function shardCount(raw: string | undefined, fallback: number): number {
  return Math.max(1, Math.floor(Number(raw ?? fallback)) || 1);
}

/**
 * `__metrics__:*` shard count. Default 8, ON.
 *
 * Measured with a fixed per-query delay standing in for a remote database (Neon/RDS at 1-5ms), 4 PM2
 * workers, 64 concurrent conversations:
 *
 * ```
 *   shards      1      4      8     16
 *   req/s    12.0   35.8   42.7   43.8
 *   p99      14.8s   3.1s   2.4s   2.3s
 * ```
 *
 * The knee is 8: it takes 97% of 16's throughput for half the read amplification. On a LOCAL database
 * the same sweep is flat (54.8 -> 56.0), so this default costs nothing in development and pays for
 * itself in production. Single-worker deployments benefit too (10.6 -> 21.4 at 3ms) — the contention
 * is between concurrent runs, not between processes.
 *
 * The cost is on the read side: `readMetricsSummary` does 1+N point reads per bucket, so 15 reads
 * becomes 135. That is an operator page, not a hot path, and it collapses to one query per bucket if
 * `sumShards` is ever moved onto the existing `key = ANY($1)` batch read.
 *
 * `GNL_METRICS_SHARDS=1` restores the previous single-row behaviour exactly.
 */
export const METRICS_SHARDS = shardCount(process.env.GNL_METRICS_SHARDS, 8);

/**
 * FNV-1a over the id — deterministic, so the same run always lands on the same shard. That matters:
 * a retry that re-counted on a different shard would be invisible to the claim marker that is
 * supposed to stop it.
 */
export function shardSuffix(id: string, shards: number): string {
  if (shards <= 1) return '';
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `#${(h >>> 0) % shards}`;
}

/**
 * Sums a logical counter across its shards AND the unsuffixed key.
 *
 * Reading the bare key too is what makes switching sharding on a non-event: counters written before
 * the switch keep counting, and no rebuild is forced. Lowering the count later HIDES the higher
 * shards until `rebuildMetrics` runs — the reader only sums shards it is currently configured to
 * know about.
 */
export async function sumShards(
  get: (key: string) => Promise<Record<string, number> | undefined>,
  key: string,
  shards: number,
): Promise<Record<string, number> | undefined> {
  const keys = [key, ...Array.from({ length: shards <= 1 ? 0 : shards }, (_, i) => `${key}#${i}`)];
  const parts = await Promise.all(keys.map((k) => get(k)));
  const present = parts.filter((p): p is Record<string, number> => p !== undefined);
  if (present.length === 0) return undefined; // no data in this bucket — same signal as an unsharded miss
  const out: Record<string, number> = {};
  for (const p of present) for (const [f, v] of Object.entries(p)) out[f] = (out[f] ?? 0) + v;
  return out;
}
