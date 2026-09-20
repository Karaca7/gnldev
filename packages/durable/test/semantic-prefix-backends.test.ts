// The semantic gate's cross-tool and cross-thread filters rest on a claim about STORAGE, so the claim
// is measured on storage rather than argued from the InMemory journal the rest of the semantic suite
// uses. Two things are pinned here, and the first is the reason the second exists:
//
//   1) `listKeys(prefix)` is a BYTE prefix on every adapter — nothing more and nothing less. It does
//      NOT expand SQL LIKE wildcards ('_', '%') on SQLite/Postgres, and it does NOT expand Redis glob
//      metacharacters ('*', '[') on Redis. A threadId is frequently an id from somebody else's
//      system, so a wildcard smuggled into one would otherwise read another tenant's keys.
//   2) Exactly BECAUSE it is a plain byte prefix, `xthr:<threadId>:sem-<toolName>-` is AMBIGUOUS: the
//      key is built from separators that threadIds and tool names may contain themselves. Every
//      adapter returns tool 'order-cancel' when asked for the prefix of tool 'order'. That is correct
//      prefix behavior and a wrong candidate set — which is why the cross-tool and cross-thread gates
//      are enforced on the RECORD (semantic-dup.ts scanCandidates), never on the prefix.
import { describe, it, expect } from 'vitest';
import { newDb } from 'pg-mem';
import { InMemoryStorage, RedisStorage, toJournal } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { makeFakeRedis } from './fake-redis.js';
import { InMemoryJournal } from '../src/journal.js';
import { findSemanticCandidate, writeSemRecord, extractSemFields, canonicalTextOf, semKey } from '../src/semantic-dup.js';
import type { SemPlan, SemanticIdentity } from '../src/semantic-dup.js';

const constEmbed = async (texts: string[]): Promise<number[][]> => texts.map(() => [1, 0, 0, 0]);
const id: SemanticIdentity = { keys: ['sku'] };

function planOf(threadId: string, toolName: string, args: unknown, hash: string): SemPlan {
  const fields = extractSemFields(id, args);
  return {
    cfg: { embed: constEmbed, embedModelId: 'm1' },
    id, threadId, toolName, argsHash: hash, fields,
    canonical: canonicalTextOf(id, toolName, args, fields),
  };
}

const backends: [string, () => Promise<any>][] = [
  ['InMemoryJournal', async () => new InMemoryJournal()],
  ['InMemoryStorage', async () => toJournal(new InMemoryStorage().runs)],
  ['PostgresStorage(pg-mem)', async () => {
    const { Pool } = newDb().adapters.createPg();
    const s = new PostgresStorage({ pool: new Pool() });
    await (s as any).init?.();
    return toJournal(s.runs);
  }],
  ['RedisStorage(fake)', async () => toJournal(new RedisStorage({ client: makeFakeRedis() }).runs)],
];
try {
  const probe = new SqliteStorage();
  (probe as any).close?.();
  backends.splice(2, 0, ['SqliteStorage', async () => {
    const s = new SqliteStorage(':memory:');
    await (s as any).init?.();
    return toJournal(s.runs);
  }]);
} catch {
  // node:sqlite unavailable (old Node / flag) → that row is skipped, and its absence is visible here
  // rather than silently reducing the matrix.
}

// THE ROWS THAT CAN ACTUALLY SETTLE THE CLAIM. Everything above runs against pg-mem and a fake
// Redis, and the claim under test is about what a REAL server does with '_' , '%' and '[' — which is
// precisely what a simulation cannot answer: the fake Redis has no character classes at all, so it
// returns the right answer for the wrong reason, and pg-mem implements its own SQL. If the adapters
// ever moved from a range scan to `LIKE prefix || '%'`, only these two rows would notice.
//
// Gated on GNL_INTEGRATION=1 like the rest of the real-backend suite, so a plain `pnpm test` still
// runs the matrix above and nothing here is silently skipped without the gate being visible.
if (process.env.GNL_INTEGRATION === '1') {
  const PG_URL = process.env.GNL_PG_URL ?? 'postgres://postgres:gnl@localhost:55432/gnl';
  const REDIS_URL = process.env.GNL_REDIS_URL ?? 'redis://localhost:6380';
  // A schema of its own per run: these tests write threadIds containing '%' and '[', and a leftover
  // from a previous run would make the prefix assertions read another run's keys.
  const tag = `p${Date.now().toString(36)}`;
  backends.push(['REAL Postgres', async () => {
    const s = new PostgresStorage({ connectionString: PG_URL });
    await (s as any).init?.();
    return toJournal(s.runs);
  }]);
  backends.push(['REAL Redis', async () => {
    const { default: Redis } = await import('ioredis');
    return toJournal(new RedisStorage({ client: new Redis(REDIS_URL), keyPrefix: `${tag}:` } as never).runs);
  }]);
}

for (const [name, make] of backends) {
  describe(`semantic key prefixes — ${name}`, () => {
    it('the prefix is AMBIGUOUS: asking for tool "order" also returns tool "order-cancel"', async () => {
      const j = await make();
      await writeSemRecord(j, planOf('th', 'order-cancel', { sku: 'A' }, 'h1'), 'call-1');
      await writeSemRecord(j, planOf('th', 'order', { sku: 'B' }, 'h2'), 'call-2');
      const keys = await j.listKeys('xthr:th:sem-order-');
      expect(keys).toContain(semKey('th', 'order-cancel', 'h1'));
      expect(keys).toContain(semKey('th', 'order', 'h2'));
    });

    it('and the record-level filter closes it anyway: a cancellation is not a candidate for an order', async () => {
      const j = await make();
      await writeSemRecord(j, planOf('th', 'order-cancel', { sku: 'A' }, 'h1'), 'call-1');
      expect((await findSemanticCandidate(j, planOf('th', 'order', { sku: 'A' }, 'h2'))).kind).toBe('none');
    });

    // The SECOND door onto the same ambiguity, and the one that crosses the tenancy boundary rather
    // than the tool one. A thread literally named 'a:sem-order-x' writes to
    // `xthr:a:sem-order-x:sem-order-<hash>`, which sits under thread 'a''s scan prefix
    // `xthr:a:sem-order-`. The tool names MATCH here, so the cross-tool filter above cannot help:
    // only the full-address check (`k !== semKey(plan.threadId, …)`) drops it.
    //
    // Added after an audit measured the gap: deleting that check left this file 15/15 green, because
    // all three tests used a single thread. The source comment says "TWO checks, because neither
    // implies the other" — and only one of the two was actually held.
    it('cross-THREAD: a thread whose NAME contains the scan prefix is not a candidate', async () => {
      const j = await make();
      await writeSemRecord(j, planOf('a:sem-order-x', 'order', { sku: 'A' }, 'h1'), 'call-1');
      // The prefix really does reach the other tenant's key — that is correct byte-prefix behavior…
      expect(await j.listKeys('xthr:a:sem-order-')).toContain(semKey('a:sem-order-x', 'order', 'h1'));
      // …and the record-level address check is what keeps it out of the candidate set.
      expect((await findSemanticCandidate(j, planOf('a', 'order', { sku: 'A' }, 'h2'))).kind).toBe('none');
    });

    it('listKeys is a BYTE prefix: a Redis glob metacharacter never widens it', async () => {
      const j = await make();
      await writeSemRecord(j, planOf('axb', 'tool', { sku: 'A' }, 'h1'), 'c1');
      await writeSemRecord(j, planOf('a%b', 'tool', { sku: 'A' }, 'h2'), 'c2');
      await writeSemRecord(j, planOf('a*b', 'tool', { sku: 'A' }, 'h3'), 'c3');
      // The one assertion here with code behind it: removing '*' from `globEscape`
      // (redis-storage.ts) turns this line red on the Redis row. On the others it is a free pass —
      // they never build a glob at all.
      expect(await j.listKeys('xthr:a*b:sem-tool-')).toEqual([semKey('a*b', 'tool', 'h3')]);
      // A REGRESSION FENCE, not a held fix, and it is worth saying which: '_' and '%' are LIKE
      // wildcards, but no adapter builds a LIKE for this — SQLite and Postgres both use a RANGE
      // (`key >= ? AND key < ?`). No mutation can turn these two red today. They exist so that a
      // future rewrite to `LIKE prefix || '%'` fails here instead of quietly reading another
      // tenant's keys. Character classes ('[a]') are deliberately NOT tested on this row: the fake
      // Redis has no character-class support, so the assertion would pass without escaping too —
      // that one is held against a real server in integration-real.test.ts.
      expect(await j.listKeys('xthr:a_b:sem-tool-')).toEqual([]);
      expect(await j.listKeys('xthr:a%b:sem-tool-')).toEqual([semKey('a%b', 'tool', 'h2')]);
    });
  });
}
