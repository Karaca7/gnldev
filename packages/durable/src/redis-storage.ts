// @gnl/durable/redis — Redis implementation of RunJournal + WorkStore + CacheStore + MetaStore.
// Ports where Redis is STRONG: KV + atomic CAS (SET NX) + native TTL (SET PX) + queue/log.
// SAME serialization (serialize.ts / superjson) and SAME contracts (Page/ListQuery,
// exactly-once CAS, readRun ORDER BY created_at,key) as Sqlite/Postgres. Injectable client + lazy `createRequire`
// pattern (identical to PostgresStorage.pool and rag/PostgresVectorStore): `ioredis` is an OPTIONAL peer dependency;
// it's only loaded when `client` is not provided → the bundler can't see it statically, a fake RedisLike is given in tests.
//
// CAPABILITY DECISION (honest matrix — see storage.ts CapabilityMatrix):
//   runs='full', work='full', cache='ttl', memory='none', vectors='none'.
// Redis (WITHOUT the RediSearch/RedisJSON modules) is weak for queryable memory + vector recall:
//   recall (MemoryStore) needs vector similarity; doing that brute-force in Redis would require pulling
//   ALL messages into the app (no index) → contrary to the point of deploying Redis (memory pressure). The Sqlite
//   adapter solves recall via a table scan and offers memory='full', but that's node-local; Redis is a
//   networked cache/queue store. So the memory/vectors ports are NOT PROVIDED (undefined) and capability='none' →
//   overridden to sqlite/postgres/pgvector via composite() (storage.ts composite philosophy). runs+meta+work+cache
//   are provided locally; Redis is typically used in a composite as a cache/work override or as the
//   runs+work+cache default.
import { createRequire } from 'node:module';
import { parseJournalKey } from './journal.js';
import { stableStringify } from './hash.js';
import type { JournalBatch, JournalEntry, RunSummary, ToolJournalRecord } from './journal.js';
import { serialize, deserialize } from './serialize.js';
import { ReplicationNotAcknowledgedError } from './errors.js';
import type {
  Storage, CapabilityMatrix, Page, ListQuery,
  RunJournal, WorkStore, CacheStore, MetaStore, LogRecord,
} from './storage.js';

const SCHEMA_VERSION = '1';

/** Minimal ioredis surface — injectable for test/custom setup (same pattern as PostgresStorage.pool). */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  /** ioredis variadic SET: `set(k,v,'NX')` · `set(k,v,'PX',ms)` · `set(k,v,'PX',ms,'NX')` → 'OK' | null. */
  set(key: string, value: string, ...args: (string | number)[]): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  /** `scan(cursor,'MATCH',pattern,'COUNT',n)` → [nextCursor, keys]. */
  scan(cursor: string | number, ...args: (string | number)[]): Promise<[string, string[]]>;
  /** OPTIONAL bulk GET (available in ioredis). If absent, bulkGet() falls back to sequential get — custom clients don't break. */
  mget?(...keys: string[]): Promise<(string | null)[]>;
  /** OPTIONAL atomic hash-field increment (H8a counters) — available in ioredis. */
  hincrbyfloat?(key: string, field: string, delta: number): Promise<string>;
  /** OPTIONAL hash read (H8a counters). */
  hgetall?(key: string): Promise<Record<string, string>>;
  /** OPTIONAL Lua eval (available in ioredis) — for H1 putIfMatch CAS. Falls back to best-effort if absent. */
  eval?(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  /** OPTIONAL TIME (available in ioredis) — `[seconds, microseconds]` for H2 now(). Falls back to Date.now if absent. */
  time?(): Promise<[string, string]>;
  /** OPTIONAL STRLEN (available in ioredis) — for H8c readRunStats, measures length WITHOUT transferring
   *  the value content. Falls back to the MGET fallback in readRunStats if absent (see readRunStats comment). */
  strlen?(key: string): Promise<number>;
  /** OPTIONAL ZSET add (available in ioredis) — H8b last-activity index: score=epoch ms, member=runId. */
  zadd?(key: string, score: number, member: string): Promise<number>;
  /** OPTIONAL ZSET range query (same contract as ioredis ZRANGEBYSCORE — `'-inf'`/`'+inf'`/
   *  `'(x'` (exclusive upper bound) are supported) → member list in ASCENDING score order. */
  zrangebyscore?(key: string, min: number | string, max: number | string): Promise<string[]>;
  /** OPTIONAL ZSET member removal (available in ioredis) — used by H8b deletePrefix to drop a dead run's summary from the ZSET. */
  zrem?(key: string, ...members: string[]): Promise<number>;
  /** OPTIONAL pipeline/transaction (SAME shape as ioredis multi() — ChainableCommander) — to fold the
   *  +1 round-trip (separate ZADD call) that the H8b touch ZSET adds to put/putIfAbsent/putIfMatch into
   *  the SAME round-trip as the SET (or CAS). If absent (or zadd is absent), the existing separate-call
   *  behavior (documented, see touch() JSDoc) is PRESERVED. */
  multi?(): RedisPipeline;
  quit?(): Promise<unknown>;
  /** OPTIONAL INFO (available in ioredis) — used ONLY for the one-time async-replication advisory
   *  check in RedisRunJournal (see `checkReplicationOnce`). Absent on custom/legacy clients → the
   *  check silently no-ops (fail-open, advisory only). */
  info?(section?: string): Promise<string>;
  /** OPTIONAL native Redis WAIT (available in ioredis) — `WAIT numreplicas timeout` blocks until
   *  `numreplicas` replicas have acknowledged all writes issued by this connection so far, or until
   *  `timeout` ms elapse, returning the number that actually acknowledged. See
   *  RedisStorageOptions.waitReplicas (İŞ 2 — opt-in strong replication guarantee). Absent on
   *  custom/legacy clients → the check silently no-ops (fail-open). */
  wait?(numreplicas: number, timeout: number): Promise<number>;
}

/** Minimal ChainableCommander subset returned by RedisLike.multi() — only the three commands
 *  (SET/ZADD/EVAL) + exec that RedisRunJournal uses. ioredis's real ChainableCommander is much
 *  broader (every Redis command) but we only type the surface this task needs — consistent with
 *  the injectable client pattern (like RedisLike itself). exec() result matches the ioredis
 *  contract EXACTLY: order matches the commands one-to-one, each element is `[err, result]`. */
export interface RedisPipeline {
  set(key: string, value: string, ...args: (string | number)[]): RedisPipeline;
  zadd(key: string, score: number, member: string): RedisPipeline;
  eval(script: string, numKeys: number, ...args: (string | number)[]): RedisPipeline;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}

export interface RedisStorageOptions {
  /** ioredis connection string (if `client` is not given, an ioredis is set up from this). */
  connectionString?: string;
  /** Bring your own ioredis (or compatible) client (test/custom setup); if given, `ioredis` is not imported. */
  client?: RedisLike;
  /** Namespace prefixed to all keys (default 'gnl:'). For multi-instance/isolation. */
  keyPrefix?: string;
  /** CORE-HARDENING §8.2: Redis replication is ALWAYS asynchronous — a claim (SET NX) acknowledged by
   *  the primary can be lost on the replica promoted during failover → exactly-once may be VIOLATED.
   *  When `true` (default), RunJournal does a ONE-TIME, fire-and-forget `INFO replication` check on the
   *  first putIfAbsent/putIfMatch call and console.warn's ONCE if replicas are attached. Set `false` to
   *  silence the advisory (e.g. single-node dev, or the risk is already knowingly accepted). */
  replicationWarning?: boolean;
  /**
   * GOREV (İŞ 2 — opt-in STRONG replication guarantee, closes the gap `replicationWarning` above only
   * WARNS about): if given, EVERY SUCCESSFUL claim (putIfAbsent/putIfMatch returning `true` — i.e. this
   * call genuinely wrote a NEW record, not a no-op loss) is followed by a native Redis `WAIT
   * replicas timeoutMs` call, requiring at least `replicas` replicas to have acknowledged the write
   * before the claim is considered final. Default: `undefined` — BYTE-FOR-BYTE unchanged behavior (no
   * WAIT call, no extra latency on the claim path).
   *   onTimeout ('warn', default): fewer than `replicas` acknowledged in time → logs ONCE per
   *     RedisRunJournal instance and lets the (already-happened) claim stand.
   *   onTimeout: 'throw': raises `ReplicationNotAcknowledgedError` instead — the claim already wrote
   *     the record (WAIT cannot undo a write), this only surfaces the ack shortfall as a hard error so
   *     the caller can decide how to react (e.g. treat this attempt as untrusted, alert, retry policy).
   * FAIL-OPEN: if the client doesn't implement `wait` (custom/legacy `RedisLike`) or the WAIT call
   * itself throws (network hiccup), this is swallowed SILENTLY — WAIT is an extra assurance layer, it
   * must never turn a genuinely successful claim into a thrown error for an UNRELATED reason.
   */
  waitReplicas?: { replicas: number; timeoutMs: number; onTimeout?: 'throw' | 'warn' };
}

// Per-store sub-namespaces — kept separate so SCANs don't collect each other's keys.
const RJ = 'rj:';     // RunJournal entries (value envelope)
const CTR = 'ctr:';   // incrBy/getCounters counter hashes (H8a) — own sub-namespace, swept by deletePrefix
const WL = 'wl:';     // WorkStore append-log
const WK = 'wk:';     // WorkStore KV + ack markers
const CACHE = 'cache:';
const META = 'meta:';
// H8b: per-run last-activity ZSET — a SINGLE key (score=last write epoch ms, member=runId).
// The Redis counterpart of gnl_runs.updated_at: RjEnv.t PRESERVES created_at (unchanged on put) → that
// field is INSUFFICIENT for measuring "last activity" (if a tool is upserted suspended→succeeded, `t`
// stays fixed, and a resumed run would INCORRECTLY look stale). So a separate index is needed, updated
// on every model/tool write — RJT.
const RJT = 'rjt:activity';

// ── Common helpers ─────────────────────────────────────────────────────────
function offset(q?: ListQuery) { return { start: q?.cursor ? Number(q.cursor) || 0 : 0, limit: q?.limit ?? 50 }; }
function pageOf<T>(all: T[], start: number, limit: number): Page<T> {
  const next = start + limit;
  return { items: all.slice(start, start + limit), nextCursor: next < all.length ? String(next) : undefined };
}
/** Escape Redis glob (MATCH) meta-characters → a dynamic prefix/id matches literally. */
function globEscape(s: string): string {
  return s.replace(/[\\*?[\]]/g, (c) => '\\' + c);
}
/** Collect all matching keys by rolling SCAN forward until cursor '0' (NOT KEYS → doesn't block in prod).
 *  Redis SCAN's guarantee is at-least-once: the same key CAN come back MULTIPLE TIMES during a rehash →
 *  dedupe with a Set (otherwise readRun produces duplicate entries, listRuns produces double counts). */
async function scanAll(client: RedisLike, match: string): Promise<string[]> {
  const out = new Set<string>();
  let cursor: string | number = '0';
  do {
    const [next, keys] = await client.scan(cursor, 'MATCH', match, 'COUNT', 1000);
    for (const k of keys) out.add(k);
    cursor = next;
  } while (cursor !== '0');
  return [...out];
}
function cmpStr(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

// N+1 efficiency fix: instead of a sequential GET per key after SCAN, use a SINGLE (or a few chunked)
// round-trip if the client supports `mget`. The returned array's ORDER matches `keys` one-to-one (mget
// contract) → the caller can match by index. For very large key lists, split into MGET_CHUNK-sized
// chunks to avoid a single MGET blocking Redis / hitting command-size limits.
const MGET_CHUNK = 500;
async function bulkGet(client: RedisLike, keys: string[]): Promise<(string | null)[]> {
  if (keys.length === 0) return [];
  if (!client.mget) {
    // Fallback: no mget → existing sequential GET (custom/legacy RedisLike clients don't break).
    const out: (string | null)[] = [];
    for (const k of keys) out.push(await client.get(k));
    return out;
  }
  if (keys.length <= MGET_CHUNK) return client.mget(...keys);
  const out: (string | null)[] = [];
  for (let i = 0; i < keys.length; i += MGET_CHUNK) {
    out.push(...(await client.mget(...keys.slice(i, i + MGET_CHUNK))));
  }
  return out;
}

// ── RunJournal ──────────────────────────────────────────────────────────────────
// Value envelope: value + derived meta (runId/kind/suspended/createdAt) in a single key → readRun/listRuns
// are resolved via SCAN + JS-side grouping without maintaining a secondary index (Redis has no secondary
// index; listRuns is an admin/observability path, NOT a hot path). The superjson envelope preserves the
// type of the nested value.
interface RjEnv { v: unknown; r: string | null; k: 'model' | 'tool' | null; s: boolean; t: number }
function rjEnv(value: unknown, p: { runId: string; kind: 'model' | 'tool' } | null, s: boolean, t: number): RjEnv {
  return { v: value, r: p?.runId ?? null, k: p?.kind ?? null, s, t };
}
function isSuspended(p: { kind: string } | null, value: unknown): boolean {
  return p?.kind === 'tool' && (value as ToolJournalRecord | undefined)?.status === 'suspended';
}

// H1 CAS Lua script: if GET==ARGV[1] then SET ARGV[2] → 1, else 0. The Redis script runs atomically →
// this closes the race window between putIfMatch's JS-side comparison and the SET.
const CAS_LUA = `if redis.call('GET',KEYS[1])==ARGV[1] then redis.call('SET',KEYS[1],ARGV[2]) return 1 else return 0 end`;

/**
 * P1.6b applyBatch Lua script: claim (putIfAbsent semantics) + HINCRBYFLOAT counters + SET puts, as ONE
 * atomic server-side script — claim key EXISTS → return 0 (nothing else runs); otherwise SET the claim,
 * apply every counter increment, SET every put, return 1. The whole batch is encoded as a SINGLE JSON
 * descriptor in ARGV[1] (cjson.decode, available in stock Redis) rather than a dynamic KEYS/ARGV layout —
 * the batch's shape (how many incrs/puts, how many fields per incr) is variable per call, and JSON keeps
 * both the real-Redis script and the fake-client mimic (fake-redis.ts) simple. All key names inside the
 * descriptor are ALREADY fully-prefixed by the caller (RedisRunJournal.applyBatch) — same envelope
 * (`rjEnv`) as put()/putIfAbsent() for run-journal keys, plain values for counter/put keys outside that
 * namespace — so this script never needs to know about prefixes itself.
 */
const APPLY_BATCH_LUA = `
local desc = cjson.decode(ARGV[1])
if desc.claim then
  if redis.call('EXISTS', desc.claim.key) == 1 then return 0 end
  redis.call('SET', desc.claim.key, desc.claim.value)
end
for _, incr in ipairs(desc.incrs or {}) do
  for field, delta in pairs(incr.fields) do
    redis.call('HINCRBYFLOAT', incr.key, field, delta)
  end
end
for _, p in ipairs(desc.puts or {}) do
  redis.call('SET', p.key, p.value)
end
for _, z in ipairs(desc.zadds or {}) do
  redis.call('ZADD', z.key, z.score, z.member)
end
return 1
`;

class RedisRunJournal implements RunJournal {
  /**
   * H8b (optional fast path — AUDIT FINDING fix): assigned in the constructor only if the client
   * supports `zadd`+`zrangebyscore`; OTHERWISE the field stays UNDEFINED. Deliberate choice: it
   * would be WRONG to ALWAYS define the method and return an empty array on an unsupported client —
   * sweepRuns (retention.ts) does feature-detection via `typeof journal.listStaleRuns === 'function'`;
   * if the method exists but incorrectly returns empty, sweepRuns thinks "there are no stale runs" and
   * SILENTLY skips retention (it never falls back to the real O(full-DB) scan fallback) → that would be
   * WORSE behavior than not defining the method at all. So the method's PRESENCE (or absence) is
   * controlled based on capability.
   *
   * KNOWN LIMITATION (documented risk): the ZSET is only populated by put/putIfAbsent/putIfMatch calls
   * made AFTER this code is deployed. Runs written BEFORE the upgrade and never touched AGAIN never
   * enter the ZSET → the fast-path listStaleRuns will never see them as "stale" (sweepRuns's fast path
   * won't clean up these old runs). If needed, a one-time backfill script (SCANning existing
   * `rj:*:model:*`/`rj:*:tool:*` keys and ZADDing them) could be run; that is out of scope for this task.
   */
  listStaleRuns?: (cutoffTs: number, opts?: { includeSuspended?: boolean }) => Promise<string[]>;

  /**
   * P1.6b (optional — SAME conditional-presence idiom as `listStaleRuns` above): assigned in the
   * constructor ONLY if the client supports `eval` (the atomic batch script needs server-side Lua);
   * otherwise the field stays UNDEFINED (recordRunMetrics/callers fall back to the sequential
   * claim→incrBy path, which is correct — just without the atomicity closing the crash window).
   * NOT implemented: `countRunsByStatus` — Redis has no cheap indexed status aggregate here (the
   * `rj:` keyspace has no secondary index by status, only a brute-force SCAN would produce it, which is
   * exactly the O(all runs) cost this capability exists to AVOID) — left undefined rather than faked with
   * a full scan; callers fall back to `listRuns`.
   */
  applyBatch?: (batch: JournalBatch) => Promise<boolean>;

  /** CORE-HARDENING §8.2 advisory (see `checkReplicationOnce`) — flips true after the first check attempt
   *  (whether or not it warned) so it only ever runs ONCE per RedisRunJournal instance. */
  private replicationChecked = false;
  /** İŞ 2: flips true after the first `waitReplicas` ack-shortfall WARNING (onTimeout:'warn', the
   *  default) — like `replicationChecked` above, this keeps the console quiet after the first hit
   *  instead of warning on every claim in a degraded cluster. Does NOT gate 'throw' mode (every
   *  shortfall there raises — the caller asked to be told every time). */
  private waitReplicasWarned = false;

  constructor(
    private client: RedisLike,
    private pfx: string,
    private replicationWarning = true,
    private waitReplicas?: { replicas: number; timeoutMs: number; onTimeout?: 'throw' | 'warn' },
  ) {
    if (client.eval) {
      this.applyBatch = async (batch: JournalBatch): Promise<boolean> => {
        const desc: { claim?: { key: string; value: string }; incrs?: { key: string; fields: Record<string, number> }[]; puts?: { key: string; value: string }[]; zadds?: { key: string; score: number; member: string }[] } = {};
        // H8b parity: run-shaped keys written through applyBatch must ALSO touch the activity ZSET
        // (put/putIfAbsent do — see touch()); otherwise listStaleRuns would treat a run written only via
        // applyBatch as never-active and sweep it as stale. Collected here, applied inside the SAME Lua unit.
        const zadds: { key: string; score: number; member: string }[] = [];
        const now = Date.now();
        const touchOf = (p: ReturnType<typeof parseJournalKey>) => {
          if (p && client.zadd) zadds.push({ key: this.activityKey(), score: now, member: p.runId });
        };
        if (batch.claim) {
          const p = parseJournalKey(batch.claim.key);
          desc.claim = { key: this.full(batch.claim.key), value: serialize(rjEnv(batch.claim.value, p, isSuspended(p, batch.claim.value), now)) };
          touchOf(p);
        }
        if (batch.incrs?.length) desc.incrs = batch.incrs.map(({ key, fields }) => ({ key: this.pfx + CTR + key, fields }));
        if (batch.puts?.length) {
          desc.puts = batch.puts.map(({ key, value }) => {
            const p = parseJournalKey(key);
            touchOf(p);
            return { key: this.full(key), value: serialize(rjEnv(value, p, isSuspended(p, value), now)) };
          });
        }
        if (zadds.length) desc.zadds = zadds;
        const res = await client.eval!(APPLY_BATCH_LUA, 0, JSON.stringify(desc));
        return Number(res) === 1;
      };
    }
    if (client.zadd && client.zrangebyscore) {
      this.listStaleRuns = async (cutoffTs, opts) => {
        // Score comes back in ASCENDING order (ioredis ZRANGEBYSCORE) → min='-inf', max=`(cutoffTs`
        // (EXCLUSIVE upper bound) = "updated_at < cutoffTs" (identical semantics to sqlite/pg).
        const candidates = await client.zrangebyscore!(this.activityKey(), '-inf', `(${cutoffTs}`);
        if (opts?.includeSuspended) return candidates;
        // Safe side: suspended runs are EXCLUDED by default. Suspended detection is only done for
        // CANDIDATE runs (NOT a full-keyspace scan — only that run's own keys, see isRunSuspended)
        // → cost stays O(stale-candidate-count × entries-per-run).
        const out: string[] = [];
        for (const runId of candidates) {
          if (!(await this.isRunSuspended(runId))) out.push(runId);
        }
        return out;
      };
    }
  }
  private ns = () => this.pfx + RJ;
  private full(key: string) { return this.ns() + key; }
  private activityKey(): string { return this.pfx + RJT; }
  /** H8b helper: does this run have a tool record that is CURRENTLY suspended? Only that run's OWN
   *  keys are scanned (unlike listRuns's full-keyspace scan) — listStaleRuns only calls this for
   *  stale CANDIDATES, so it does NOT incur full-keyspace cost. */
  private async isRunSuspended(runId: string): Promise<boolean> {
    const keys = await scanAll(this.client, this.ns() + globEscape(runId + ':') + '*');
    const values = await bulkGet(this.client, keys);
    for (const s of values) {
      if (s == null) continue;
      const e = deserialize<RjEnv>(s);
      if (e.r === runId && e.k === 'tool' && e.s) return true;
    }
    return false;
  }
  /** H8b: refreshes the run's last-activity ZSET score whenever a model/tool key is written. Cost:
   *  +1 round-trip per write (ZADD) — ADDED to put()'s existing GET+SET, putIfAbsent's SET NX,
   *  or putIfMatch's GET+(eval|SET). O(1) constant cost, in the same spirit as sqlite/pg's
   *  touchRunDelta upsert that runs on every write. NO-OP (skipped) if client.zadd is absent →
   *  listStaleRuns is already left undefined in that case, so this call adds no cost at all.
   *  `this.now()` is used (NOT Date.now()) — with H2 server-time support this stays independent of
   *  worker wall-clock skew (in tests the fake clock also flows through here via `client.time()`).
   *  PIPELINE (audit fix): if the client ALSO supports `multi()`, this +1 RTT is folded into the SAME
   *  round-trip as put/putIfAbsent/putIfMatch's write command (SET / SET NX / eval) — see `canPipe()`
   *  and the pipeline branches inside those three methods. `touch()` itself is only used on the
   *  separate-call path for clients without pipelining (no multi support); its behavior is UNCHANGED. */
  private async touch(p: { runId: string; kind: 'model' | 'tool' } | null): Promise<void> {
    if (p && this.client.zadd) await this.client.zadd(this.activityKey(), await this.now(), p.runId);
  }
  /** Is pipelining (sending SET/eval + ZADD in a single round-trip) possible? The run key (`p`) must
   *  EXIST and the client must support BOTH `multi()` and `zadd` — if either is missing, the
   *  separate-call (touch()) path is used. */
  private canPipe(p: { runId: string; kind: 'model' | 'tool' } | null): p is { runId: string; kind: 'model' | 'tool' } {
    return !!(p && this.client.multi && this.client.zadd);
  }

  /**
   * CORE-HARDENING §8.2 (AUDIT FINDING — made VOCAL, same rationale as journal.ts claim()'s
   * putIfAbsent-fallback warning): Redis replication is ALWAYS asynchronous — a claim (SET NX)
   * acknowledged by the primary can be LOST on the replica promoted during failover → another worker
   * can win the SAME claim → exactly-once may be VIOLATED. Nothing checked or surfaced this before —
   * a silent risk in a correctness product. This does a ONE-TIME (per instance), FIRE-AND-FORGET
   * `INFO replication` probe on the first putIfAbsent/putIfMatch call: it is NEVER awaited by the
   * caller (must never delay or be able to break the claim path) and any error (client doesn't
   * implement `info`, network failure, parse miss) is swallowed SILENTLY — fail-open, this is an
   * advisory only, not a gate. Silenced entirely via `replicationWarning: false`.
   */
  private checkReplicationOnce(): void {
    if (this.replicationChecked || !this.replicationWarning || !this.client.info) return;
    this.replicationChecked = true; // flip BEFORE the async call resolves → never re-entered, even under concurrent claims
    void this.client
      .info('replication')
      .then((info) => {
        const m = /connected_slaves:(\d+)/.exec(info);
        if (m && Number(m[1]) > 0) {
          console.warn(
            '@gnl/durable redis: replicas are fed asynchronously — on failover, an acknowledged claim ' +
              '(SET NX) can be lost on the promoted replica, so exactly-once may be VIOLATED ' +
              '(see CORE-HARDENING.md §8.2). Configure WAIT / min-replicas-to-write, or knowingly accept ' +
              'the risk (silence this warning via `replicationWarning: false`).',
          );
        }
      })
      .catch(() => {}); // fail-open: the advisory must never break the claim path
  }

  /**
   * İŞ 2 (opt-in strong replication guarantee): AWAITED (unlike `checkReplicationOnce` above, which is
   * fire-and-forget advisory) — called AFTER a claim already succeeded (putIfAbsent/putIfMatch about to
   * return `true`), so it can only ever ADD a delay or a thrown ack-shortfall error, never change
   * whether the write happened. No-op if `waitReplicas` wasn't configured, or the client doesn't
   * implement `wait` (fail-open — see RedisStorageOptions.waitReplicas JSDoc).
   */
  private async waitForReplicas(): Promise<void> {
    if (!this.waitReplicas || !this.client.wait) return;
    const { replicas, timeoutMs, onTimeout = 'warn' } = this.waitReplicas;
    let acked: number;
    try {
      acked = await this.client.wait(replicas, timeoutMs);
    } catch {
      return; // fail-open: WAIT itself errored (unsupported/network) — never fail an already-successful claim
    }
    if (acked >= replicas) return;
    const message =
      `@gnl/durable redis: WAIT requested ${replicas} replica ack(s) within ${timeoutMs}ms, only ${acked} ` +
      'acknowledged — the claim already happened, but on failover it may be LOST on a replica that never ' +
      'caught up (see CORE-HARDENING.md §8.2).';
    if (onTimeout === 'throw') {
      throw new ReplicationNotAcknowledgedError(message, { requested: replicas, acknowledged: acked, timeoutMs });
    }
    if (!this.waitReplicasWarned) {
      this.waitReplicasWarned = true;
      console.warn(`${message} Configure onTimeout: 'throw' to fail loudly instead, or raise timeoutMs / lower replicas.`);
    }
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const s = await this.client.get(this.full(key));
    return s == null ? undefined : (deserialize<RjEnv>(s).v as T);
  }
  /** P1.6b: batch point-read — reuses `bulkGet` (the SAME N+1 fix readRun/listRuns already rely on),
   *  order-preserving, `undefined` for misses (getMany contract, journal.ts); decodes the SAME RjEnv
   *  envelope as `get`. */
  async getMany<T = unknown>(keys: string[]): Promise<(T | undefined)[]> {
    if (keys.length === 0) return [];
    const values = await bulkGet(this.client, keys.map((k) => this.full(k)));
    return values.map((s) => (s == null ? undefined : (deserialize<RjEnv>(s).v as T)));
  }
  async put(key: string, value: unknown): Promise<void> {
    const p = parseJournalKey(key);
    const full = this.full(key);
    // Preserve created_at (sqlite ON CONFLICT DO UPDATE doesn't update created_at) → readRun order stays stable.
    // DELIBERATE 2-RTT (GET+SET) — NOT OPTIMIZED with bulkGet: put() operates on a single key,
    // there's no bulk read; the N+1 problem was in multi-key reads after SCAN (readRun/listRuns/list).
    // Alternatives that would improve atomicity (Lua script CAS / separate created_at key) were NOT
    // IMPLEMENTED — see docs/CORE-HARDENING.md §5 (Recommendations) — this task's scope is only N+1 GET efficiency.
    const prev = await this.client.get(full);
    const t = prev != null ? deserialize<RjEnv>(prev).t : Date.now();
    const payload = serialize(rjEnv(value, p, isSuspended(p, value), t));
    // PIPELINE (audit fix — H8b touch +1 RTT): touch() is already UNCONDITIONAL here (it would run on
    // every put whenever p exists) → sending SET+ZADD in the SAME round-trip does NOT CHANGE behavior
    // (both would run in every case; it just drops from 2 RTT to 1 RTT). If canPipe() is false
    // (client.multi/zadd absent), the separate-call path below (old behavior, documented) runs UNCHANGED.
    if (this.canPipe(p)) {
      await this.client.multi!().set(full, payload).zadd(this.activityKey(), await this.now(), p.runId).exec();
      return;
    }
    await this.client.set(full, payload);
    await this.touch(p);
  }
  /** REQUIRED (exactly-once): ATOMIC CAS via SET NX — no get-then-set. First writer gets 'OK', later ones get null. */
  async putIfAbsent(key: string, value: unknown): Promise<boolean> {
    this.checkReplicationOnce(); // fire-and-forget — never awaited, never delays the claim
    const p = parseJournalKey(key);
    const full = this.full(key);
    const payload = serialize(rjEnv(value, p, isSuspended(p, value), Date.now()));
    if (this.canPipe(p)) {
      // PIPELINE — DOCUMENTED BEHAVIOR DIFFERENCE (in the SAFE DIRECTION): commands in a pipeline can't
      // be conditioned on each other's RESULT (without Lua) → the ZADD runs even if SET NX LOSES (the
      // key already existed) — a deviation from the original "touch only if OK" behavior. The deviation
      // is in the SAFE direction: marking activity earlier/more than warranted only DELAYS when
      // listStaleRuns triggers (it NEVER LEADS TO early/false-positive deletion — see the "safe side"
      // principle at the top of the file) and it DOES reflect the fact that the losing worker was ALSO
      // attempting to write to this run at that moment. The round-trip count does NOT get WORSE: on a
      // win it drops from 2→1 RTT, on a loss it was already 1 RTT (the ZADD rides in the same packet).
      const results = await this.client.multi!().set(full, payload, 'NX').zadd(this.activityKey(), await this.now(), p.runId).exec();
      const ok = results?.[0]?.[1] === 'OK';
      if (ok) await this.waitForReplicas(); // İŞ 2: only after a GENUINE new claim (NX won)
      return ok;
    }
    const res = await this.client.set(full, payload, 'NX');
    const ok = res === 'OK';
    if (ok) {
      await this.touch(p);
      await this.waitForReplicas(); // İŞ 2: only after a GENUINE new claim (NX won)
    }
    return ok;
  }
  /**
   * H1: atomic conditional replace (expired run-lock takeover, see journal.ts JSDoc).
   * The STORED FORM is the RjEnv envelope (v + derived meta, including `t`=createdAt) — the caller's
   * `expected` is only the inner value (`v`), and the envelope has `t` → a byte-for-byte serialize match
   * is IMPOSSIBLE. Hence the pattern: (1) raw GET, (2) JS-side env.v ↔ expected stableStringify
   * comparison, (3) if it matches, run the Lua CAS with the RAW OLD STRING (ARGV[1] = the raw we read)
   * → the GET↔SET TOCTOU window is closed inside Lua (atomic server-side). The new value is wrapped
   * with rjEnv, `t` is PRESERVED (readRun order stays stable — same as put()'s created_at preservation behavior).
   */
  async putIfMatch(key: string, expected: unknown, value: unknown): Promise<boolean> {
    this.checkReplicationOnce(); // fire-and-forget — never awaited, never delays the claim
    const full = this.full(key);
    const raw = await this.client.get(full);
    if (raw == null) return false; // key absent → no match
    const env = deserialize<RjEnv>(raw);
    if (stableStringify(env.v) !== stableStringify(expected)) return false; // safe side: don't touch
    const p = parseJournalKey(key);
    const next = serialize(rjEnv(value, p, isSuspended(p, value), env.t)); // t is preserved
    if (this.client.eval) {
      if (this.canPipe(p)) {
        // PIPELINE — same "safe-direction deviation" (see putIfAbsent comment): eval (CAS) + ZADD go in
        // the SAME round-trip; the ZADD runs even if the CAS loses (safe direction: late cleanup, never early).
        const results = await this.client.multi!().eval(CAS_LUA, 1, full, raw, next).zadd(this.activityKey(), await this.now(), p.runId).exec();
        const ok = Number(results?.[0]?.[1]) === 1;
        if (ok) await this.waitForReplicas(); // İŞ 2: only after a GENUINE takeover (CAS won)
        return ok;
      }
      const res = await this.client.eval(CAS_LUA, 1, full, raw, next);
      const ok = Number(res) === 1;
      if (ok) {
        await this.touch(p); // a resume/takeover is ALSO "last activity" — prevents stale-false-positives
        await this.waitForReplicas(); // İŞ 2: only after a GENUINE takeover (CAS won)
      }
      return ok;
    }
    // custom client without eval: best-effort compare-then-set (equivalent to the old get→put behavior;
    // documented risk, CORE-HARDENING §2.2 — a real ioredis always goes through the atomic eval path).
    if (this.canPipe(p)) {
      // touch() is already UNCONDITIONAL here (the best-effort branch always returns true) → the
      // pipeline behavior is IDENTICAL, just 2 RTT → 1 RTT.
      await this.client.multi!().set(full, next).zadd(this.activityKey(), await this.now(), p.runId).exec();
      await this.waitForReplicas(); // İŞ 2: this branch always writes (best-effort, no CAS) → always a genuine write
      return true;
    }
    await this.client.set(full, next);
    await this.touch(p);
    await this.waitForReplicas(); // İŞ 2: this branch always writes (best-effort, no CAS) → always a genuine write
    return true;
  }
  /** H8a: engine-internal atomic counter via HINCRBYFLOAT (if the client supports it; otherwise the
   *  method is considered undefined — budget.ts falls back to the legacy path). Key lives in its own
   *  sub-namespace (ctr:). */
  async incrBy(key: string, fields: Record<string, number>): Promise<void> {
    if (!this.client.hincrbyfloat) throw new Error('@gnl/durable redis: client does not support hincrbyfloat');
    for (const [f, d] of Object.entries(fields)) await this.client.hincrbyfloat(this.pfx + CTR + key, f, d);
  }
  async getCounters(key: string): Promise<Record<string, number> | undefined> {
    if (!this.client.hgetall) return undefined;
    const h = await this.client.hgetall(this.pfx + CTR + key);
    const entries = Object.entries(h ?? {});
    if (!entries.length) return undefined;
    return Object.fromEntries(entries.map(([f, v]) => [f, Number(v)]));
  }

  /** H2: Redis server time (TIME → sec+µs) as epoch ms. Falls back to Date.now if `time` is absent. */
  async now(): Promise<number> {
    if (!this.client.time) return Date.now();
    const [sec, usec] = await this.client.time();
    return Number(sec) * 1000 + Math.floor(Number(usec) / 1000);
  }
  async listKeys(prefix: string): Promise<string[]> {
    const keys = await scanAll(this.client, this.ns() + globEscape(prefix) + '*');
    const cut = this.ns().length;
    return keys.map((k) => k.slice(cut));
  }
  /** Retention/GDPR: PERMANENTLY delete keys starting with the prefix (parity with sqlite/pg deletePrefix).
   *  H8b parity: sqlite/pg's deletePrefix(`<runId>:`) call also drops the gnl_runs summary row
   *  (see sqlite-storage.ts/postgres-storage.ts deletePrefix) — the equivalent here is ZREMming the
   *  ZSET member: otherwise the purged run's dead member stays in the ZSET FOREVER → every subsequent
   *  listStaleRuns call thinks it's "stale" AGAIN and re-triggers purgeRun (harmless but unnecessary —
   *  deletePrefix already returns 0) AND the ZSET grows like a leak. `rid` may not always be a real
   *  runId (e.g. `mem-appended:<runId>` or `net:<runId>:` prefixes also pass through here) — in that
   *  case ZREM deletes a non-matching member (no-op, a harmless extra round-trip). */
  async deletePrefix(prefix: string): Promise<number> {
    const keys = await scanAll(this.client, this.ns() + globEscape(prefix) + '*');
    const n = keys.length ? await this.client.del(...keys) : 0;
    if (this.client.zrem) {
      const rid = prefix.endsWith(':') ? prefix.slice(0, -1) : prefix;
      await this.client.zrem(this.activityKey(), rid);
    }
    // Counters (incrBy/H8a) live in the `ctr:` sub-namespace (`<pfx>ctr:<key>` hashes), OUTSIDE the
    // `rj:` namespace scanned above — but they are keys too per the deletePrefix contract (journal.ts):
    // an org purge (GDPR) must not leave `org:<id>:__usage__` behind, and rebuildMetrics's wipe must
    // not keep stale `__metrics__:` counters. Not included in the return count (parity with sqlite/pg,
    // which don't count the gnl_counters rows either).
    const ctrKeys = await scanAll(this.client, this.pfx + CTR + globEscape(prefix) + '*');
    if (ctrKeys.length) await this.client.del(...ctrKeys);
    return n;
  }
  /**
   * H8c (AUDIT FINDING fix): CHEAP stats for a run — COUNT + total size, measured WITHOUT transferring
   * the VALUES (where possible). loadReplayCache (journal.ts) uses this as a RAM guard rail: it checks
   * the journal's size before pulling it entirely into memory; the bulk cache is skipped if over the threshold.
   * Measurement path:
   *  - if the client supports STRLEN: only the length is queried (the value CONTENT does NOT CROSS the
   *    network). Cost: 1 round-trip per key — but SCAN is already LIMITED to `<runId>:*` (as many as
   *    this run's entries, NOT the WHOLE keyspace) → typically small (as many as a run's model/tool step count).
   *  - if STRLEN is absent (custom/legacy client — documented fallback): values are transferred via MGET
   *    (there's a bandwidth cost) but ONLY for this run's keys — again NOT a full-keyspace scan, using
   *    the same path as the bulkGet from the N+1 efficiency fix.
   */
  async readRunStats(runId: string): Promise<{ entries: number; bytes: number }> {
    const keys = await scanAll(this.client, this.ns() + globEscape(runId + ':') + '*');
    const cut = this.ns().length;
    // As in readRun, only this run's model/tool entries are counted (input/proc/cfg are EXCLUDED) —
    // here, WITHOUT fetching the value, filtering is done via parseJournalKey on the key TEXT itself.
    const relevant = keys.filter((k) => {
      const p = parseJournalKey(k.slice(cut));
      return p != null && p.runId === runId;
    });
    if (relevant.length === 0) return { entries: 0, bytes: 0 };
    if (this.client.strlen) {
      let bytes = 0;
      for (const k of relevant) bytes += await this.client.strlen(k);
      return { entries: relevant.length, bytes };
    }
    const values = await bulkGet(this.client, relevant);
    let bytes = 0;
    for (const v of values) if (v != null) bytes += v.length;
    return { entries: relevant.length, bytes };
  }
  async readRun(runId: string): Promise<JournalEntry[]> {
    const keys = await scanAll(this.client, this.ns() + globEscape(runId + ':') + '*');
    const cut = this.ns().length;
    const values = await bulkGet(this.client, keys);
    const entries: JournalEntry[] = [];
    for (let i = 0; i < keys.length; i++) {
      const s = values[i];
      if (s == null) continue;
      const e = deserialize<RjEnv>(s);
      if (e.k == null || e.r !== runId) continue; // only this run's model/tool entries
      entries.push({ key: keys[i]!.slice(cut), runId, kind: e.k, value: e.v, seq: 0, ts: e.t });
    }
    // Decision #4 (journal.ts): created_at ASCENDING, `key` tie-break on equality → deterministic (same as sqlite/pg).
    entries.sort((a, b) => (a.ts! - b.ts!) || cmpStr(a.key, b.key));
    entries.forEach((e, i) => { e.seq = i; });
    return entries;
  }
  async listRuns(q?: ListQuery): Promise<Page<RunSummary>> {
    // Brute-force: scan all rj: entries, summarize per run. Even if the same key is written twice (UPSERT)
    // it's a SINGLE Redis key → NOT DOUBLE-COUNTED (same result as sqlite touchRun's recompute semantics).
    const keys = await scanAll(this.client, this.ns() + '*');
    const values = await bulkGet(this.client, keys);
    const cut = this.ns().length;
    const byRun = new Map<string, { m: number; t: number; s: boolean; c0: number }>();
    // AUDIT (threadId first-class): `:input` keys are not visible to parseJournalKey → the r/k fields
    // in the RjEnv envelope they're written under are null (rjEnv(value, p=null, ...)). So runId is
    // derived NOT from the ENVELOPE but from the raw key text itself (the `<runId>:input` suffix) —
    // since SCAN already fetches ALL rj: keys in one pass (keys/values above), this is NOT a SEPARATE
    // round-trip, it's part of the same scan.
    const threadIds = new Map<string, string>();
    const agents = new Map<string, string>();
    for (let i = 0; i < keys.length; i++) {
      const s = values[i];
      if (s == null) continue;
      const e = deserialize<RjEnv>(s);
      if (e.r != null && e.k != null) {
        const cur = byRun.get(e.r) ?? { m: 0, t: 0, s: false, c0: e.t };
        if (e.k === 'model') cur.m++; else { cur.t++; if (e.s) cur.s = true; }
        if (e.t < cur.c0) cur.c0 = e.t;
        byRun.set(e.r, cur);
        continue;
      }
      const rawKey = keys[i]!.slice(cut);
      if (rawKey.endsWith(':input')) {
        const runId = rawKey.slice(0, -':input'.length);
        const inp = e.v as { threadId?: string; agent?: string } | undefined;
        if (inp?.threadId) threadIds.set(runId, inp.threadId);
        if (inp?.agent) agents.set(runId, inp.agent);
      }
    }
    // P0.3 (AUDIT-R2) filters: listRuns is ALREADY a full brute-force SCAN here (Redis has no
    // secondary index by status/agent — same "no cheap indexed status aggregate" limitation documented
    // on countRunsByStatus above) — so status/agent filtering costs nothing EXTRA beyond the scan this
    // path already pays; the only requirement is applying it BEFORE the offset/limit slice (pageOf),
    // never after.
    let all = [...byRun.entries()]
      .sort(([ra, va], [rb, vb]) => (va.c0 - vb.c0) || cmpStr(ra, rb))
      .map(([runId, v]): RunSummary => {
        const threadId = threadIds.get(runId);
        const agent = agents.get(runId);
        return {
          runId, status: v.s ? 'suspended' : 'completed', modelSteps: v.m, toolCalls: v.t,
          ...(threadId ? { threadId } : {}),
          ...(agent ? { agent } : {}),
        };
      });
    if (q?.status) all = all.filter((r) => r.status === q.status);
    if (q?.agent) all = all.filter((r) => r.agent === q.agent);
    const { start, limit } = offset(q);
    return pageOf(all, start, limit);
  }
}

// ── WorkStore (append-log + KV + CAS ack) ─────────────────────────────────────
class RedisWorkStore implements WorkStore {
  constructor(private client: RedisLike, private pfx: string) {}
  private logNs = (ns: string) => `${this.pfx}${WL}${ns}:`;
  private kvKey = (key: string) => `${this.pfx}${WK}${key}`;

  async append(ns: string, payload: unknown, id?: string): Promise<string> {
    const eid = id ?? `${ns}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    // idempotent: SET NX → the same (ns,id) is not written a second time (first-write-wins).
    await this.client.set(this.logNs(ns) + eid, serialize({ id: eid, payload, ts: Date.now() }), 'NX');
    return eid;
  }
  async list<T = unknown>(ns: string, q?: ListQuery): Promise<Page<LogRecord<T>>> {
    const keys = await scanAll(this.client, this.logNs(globEscape(ns)) + '*');
    const values = await bulkGet(this.client, keys);
    const rows: LogRecord<T>[] = [];
    for (const s of values) {
      if (s != null) rows.push(deserialize<LogRecord<T>>(s));
    }
    rows.sort((a, b) => (a.ts - b.ts) || cmpStr(a.id, b.id));
    const { start, limit } = offset(q);
    return pageOf(rows, start, limit);
  }
  async get<T = unknown>(key: string): Promise<T | undefined> {
    const s = await this.client.get(this.kvKey(key));
    return s == null ? undefined : deserialize<T>(s);
  }
  async put(key: string, value: unknown): Promise<void> {
    await this.client.set(this.kvKey(key), serialize(value));
  }
  /** Exactly-once ack: ATOMIC via SET NX — the first call is true, subsequent ones are false. */
  async ackOnce(key: string): Promise<boolean> {
    const res = await this.client.set(this.kvKey(key), serialize(true), 'NX');
    return res === 'OK';
  }
  /**
   * 8.2: uses RunJournal's Lua CAS (CAS_LUA, defined in the same module — shared with RedisRunJournal) —
   * but WorkStore has NO RjEnv envelope (put() writes plain `serialize(value)`) → unlike RunJournal, no
   * pre-GET is needed: `expected`'s serialized form is passed directly as Lua's ARGV[1], the
   * GET==ARGV[1] check + SET happen in A SINGLE round-trip (a genuinely atomic CAS, NO TOCTOU window). On
   * custom clients that don't support `eval`, it falls back to best-effort get→compare→set (documented risk).
   */
  async putIfMatch(key: string, expected: unknown, value: unknown): Promise<boolean> {
    const full = this.kvKey(key);
    const expectedRaw = serialize(expected);
    const nextRaw = serialize(value);
    if (this.client.eval) {
      const res = await this.client.eval(CAS_LUA, 1, full, expectedRaw, nextRaw);
      return Number(res) === 1;
    }
    const raw = await this.client.get(full);
    if (raw == null || raw !== expectedRaw) return false;
    await this.client.set(full, nextRaw);
    return true;
  }
}

// ── CacheStore (Redis NATIVE TTL) ─────────────────────────────────────────────
class RedisCacheStore implements CacheStore {
  constructor(private client: RedisLike, private pfx: string) {}
  private ck = (key: string) => `${this.pfx}${CACHE}${key}`;

  async get<T = unknown>(key: string): Promise<T | undefined> {
    // Redis itself drops the expired key → an expiry check in get is NOT NEEDED (native TTL).
    const s = await this.client.get(this.ck(key));
    return s == null ? undefined : deserialize<T>(s);
  }
  async set(key: string, value: unknown, opts?: { ttlMs?: number }): Promise<void> {
    const s = serialize(value);
    if (opts?.ttlMs != null) {
      // ttlMs<=0 → Redis PX requires a positive value; immediate "expired" = delete the key (same result as sqlite/pg semantics).
      if (opts.ttlMs <= 0) { await this.client.del(this.ck(key)); return; }
      await this.client.set(this.ck(key), s, 'PX', Math.ceil(opts.ttlMs));
      return;
    }
    await this.client.set(this.ck(key), s);
  }
  async delete(key: string): Promise<void> { await this.client.del(this.ck(key)); }
}

// ── MetaStore (plain string KV — schema_version/capability persistence) ──────────
class RedisMetaStore implements MetaStore {
  constructor(private client: RedisLike, private pfx: string) {}
  private mk = (key: string) => `${this.pfx}${META}${key}`;
  async get(key: string): Promise<string | undefined> {
    const s = await this.client.get(this.mk(key));
    return s == null ? undefined : s;
  }
  async set(key: string, value: string): Promise<void> { await this.client.set(this.mk(key), value); }
}

export class RedisStorage implements Storage {
  readonly name = 'redis';
  readonly capabilities: CapabilityMatrix = { runs: 'full', memory: 'none', vectors: 'none', work: 'full', cache: 'ttl' };
  private client: RedisLike;
  readonly runs: RunJournal;
  readonly work: WorkStore;
  readonly cache: CacheStore;
  readonly meta: MetaStore;
  // memory/vectors: NOT PROVIDED (undefined) — capability='none', overridden via composite() (see comment above).

  constructor(opts: RedisStorageOptions = {}) {
    const pfx = opts.keyPrefix ?? 'gnl:';
    if (opts.client) {
      this.client = opts.client;
    } else {
      const mod = createRequire(import.meta.url)('ioredis') as any;
      const Redis = (mod.default ?? mod) as new (c?: any) => RedisLike;
      this.client = new Redis(opts.connectionString ?? undefined);
    }
    this.runs = new RedisRunJournal(this.client, pfx, opts.replicationWarning ?? true, opts.waitReplicas);
    this.work = new RedisWorkStore(this.client, pfx);
    this.cache = new RedisCacheStore(this.client, pfx);
    this.meta = new RedisMetaStore(this.client, pfx);
  }
  /** Redis is schemaless → no table setup; write schema_version idempotently (parity with sqlite/pg meta). */
  async init(): Promise<void> {
    if ((await this.meta.get('schema_version')) == null) await this.meta.set('schema_version', SCHEMA_VERSION);
  }
  async close(): Promise<void> { if (this.client.quit) await this.client.quit(); }
}
