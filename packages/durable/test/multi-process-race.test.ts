// REAL multi-process CONCURRENCY (the distributed exactly-once proof, SQLite edition — runs in every
// CI, no external services): two SEPARATE OS PROCESSES race the SAME journal file through a file
// barrier. process-kill.test.ts proves crash→resume SEQUENTIALLY; THIS file proves the concurrent
// window: run-lock, tool claim, putIfAbsent, putIfMatch and incrBy each pick exactly one winner /
// lose nothing under genuine cross-process contention (WAL + busy_timeout=5000). The same class of
// proof for REAL Postgres lives in integration-real.test.ts (two pools, env-gated).
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { runDurable } from '../src/run.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

const here = dirname(fileURLToPath(import.meta.url));
const tsxBin = join(here, '..', '..', '..', 'node_modules', '.bin', 'tsx');
const workerScript = join(here, 'fixtures', 'race-worker.ts');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Spawns TWO workers in the given mode against the same db, releases the barrier once BOTH are
 *  ready (so the contended operation overlaps for real), and returns their structured results. */
async function runPair(mode: string, dir: string): Promise<{ a: any; b: any }> {
  const dbPath = join(dir, 'runs.db');
  const spawnOne = (id: string) =>
    new Promise<void>((resolve, reject) => {
      const p = spawn(tsxBin, [workerScript, mode, dbPath, dir, id], { stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => (err += d));
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`worker ${id} exited ${code}: ${err}`))));
    });
  const workers = Promise.all([spawnOne('A'), spawnOne('B')]);
  // Barrier: wait until BOTH children announce readiness, then release them together.
  const deadline = Date.now() + 20_000;
  while (!(existsSync(join(dir, 'ready-A')) && existsSync(join(dir, 'ready-B')))) {
    if (Date.now() > deadline) throw new Error('workers never reached the barrier');
    await sleep(10);
  }
  writeFileSync(join(dir, 'go'), '1');
  await workers;
  return {
    a: JSON.parse(readFileSync(join(dir, 'out-A.json'), 'utf8')),
    b: JSON.parse(readFileSync(join(dir, 'out-B.json'), 'utf8')),
  };
}

const withDir = async (fn: (dir: string) => Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), 'gnl-race-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** The charge-side-effect count = lines in charges.txt (each REAL execution appends exactly one). */
const chargeCount = (dir: string): number =>
  existsSync(join(dir, 'charges.txt')) ? readFileSync(join(dir, 'charges.txt'), 'utf8').split('\n').filter(Boolean).length : 0;

/** After the race: the surviving journal must both REPLAY cleanly and still hold exactly one charge. */
async function assertCleanReplay(dir: string): Promise<void> {
  const chargeCard = tool({
    description: 'charge', inputSchema: z.object({ amount: z.number() }),
    execute: async ({ amount }) => {
      writeFileSync(join(dir, 'REPLAY-EXECUTED'), '1'); // must never appear
      return { charged: amount };
    },
  });
  const model = createMockModel(async ({ prompt }: any) =>
    countToolResults(prompt) === 0 ? toolCallResult('chargeCard', 'call-charge', { amount: 20 }) : finalTextResult('Charged.'));
  const s = new SqliteStorage(join(dir, 'runs.db'));
  const res = await runDurable({ runId: 'race-charge', journal: s.runs, model, tools: { chargeCard }, prompt: 'charge', stopWhen: stepCountIs(6) });
  const rec = await s.runs.get<any>('race-charge:tool:call-charge');
  await s.close();
  expect(res.text).toContain('Charged');
  expect(rec).toMatchObject({ status: 'succeeded' });
  expect(existsSync(join(dir, 'REPLAY-EXECUTED'))).toBe(false); // replay re-executed NOTHING
}

describe('REAL multi-process races (same SQLite journal, two OS processes)', () => {
  it('run-lock race: same runId concurrently → the LOCK picks one runner; charge is EXACTLY 1; journal replays clean', { timeout: 60_000 }, async () => {
    await withDir(async (dir) => {
      const { a, b } = await runPair('charge-lock', dir);
      // THE exactly-once claim, under a real concurrent window (the tool holds the lock for 300ms):
      expect(chargeCount(dir)).toBe(1);
      // At least one worker completed; a loser (if the overlap caught it) failed ONLY with RunBusyError.
      expect([a, b].some((r) => r.ok)).toBe(true);
      for (const r of [a, b]) if (!r.ok) expect(r.error).toBe('RunBusyError');
      await assertCleanReplay(dir);
      expect(chargeCount(dir)).toBe(1); // still 1 after the replay
    });
  });

  it('tool-claim race (NO run-lock): both enter the loop → the CLAIM picks one executor; charge is EXACTLY 1', { timeout: 60_000 }, async () => {
    await withDir(async (dir) => {
      const { a, b } = await runPair('charge-claim', dir);
      // The second, independent defense layer (putIfAbsent NX on the tool record) must hold ON ITS OWN.
      expect(chargeCount(dir)).toBe(1);
      expect([a, b].some((r) => r.ok)).toBe(true);
      for (const r of [a, b]) if (!r.ok) expect(r.error).toBe('RunBusyError');
      await assertCleanReplay(dir);
      expect(chargeCount(dir)).toBe(1);
    });
  });

  it('incrBy storm: 2 × 250 blind increments from two processes → EXACT totals (H8a engine arithmetic loses nothing)', { timeout: 60_000 }, async () => {
    await withDir(async (dir) => {
      const { a, b } = await runPair('incr', dir);
      expect(a.ok && b.ok).toBe(true);
      const s = new SqliteStorage(join(dir, 'runs.db'));
      const counters = await s.runs.getCounters!('race:ctr');
      await s.close();
      // Not "roughly" — EXACT. A single lost update anywhere fails this line.
      expect(counters).toEqual({ n: 500, cost: 250 });
    });
  });

  it('putIfAbsent grid: both processes sweep the SAME 120 keys → every key has EXACTLY ONE winner and the winners partition the grid', { timeout: 60_000 }, async () => {
    await withDir(async (dir) => {
      const { a, b } = await runPair('grid', dir);
      const winsA = new Set<number>(a.wins);
      const winsB = new Set<number>(b.wins);
      // Partition proof: disjoint + complete — no key double-claimed, no key unclaimed.
      for (const i of winsA) expect(winsB.has(i)).toBe(false);
      expect(winsA.size + winsB.size).toBe(120);
      // The stored value agrees with the reported winner (the boolean wasn't lying).
      const s = new SqliteStorage(join(dir, 'runs.db'));
      for (const i of [0, 33, 77, 119]) {
        const v = await s.runs.get<{ w: string }>(`race:grid:k${i}`);
        expect(v?.w).toBe(winsA.has(i) ? 'A' : 'B');
      }
      await s.close();
    });
  });

  it('compensation race: two processes unwind the SAME run → every compensation hook runs EXACTLY once across both', { timeout: 60_000 }, async () => {
    await withDir(async (dir) => {
      // Seed a 3-step compensable run in the PARENT (the same journal file the workers will fight over).
      const seedCharge = tool({
        description: 'charge', inputSchema: z.object({ orderId: z.string() }),
        execute: async () => ({ ok: true }),
      });
      (seedCharge as any).compensate = async () => ({}); // presence → the run stores `input` on success
      const model = createMockModel(async ({ prompt }: any) => {
        const done = countToolResults(prompt);
        if (done < 3) return toolCallResult('chargeCard', `call-${done + 1}`, { orderId: `O${done + 1}` });
        return finalTextResult('Done.');
      });
      const seed = new SqliteStorage(join(dir, 'runs.db'));
      await runDurable({ runId: 'race-saga', journal: seed.runs, model, tools: { chargeCard: seedCharge }, prompt: 'x', stopWhen: stepCountIs(10) });
      await seed.close();

      const { a, b } = await runPair('compensate', dir);
      expect(a.ok && b.ok).toBe(true);
      // THE saga exactly-once claim, cross-process: each of the 3 compensations ran EXACTLY once in total.
      const lines = readFileSync(join(dir, 'comps.txt'), 'utf8').split('\n').filter(Boolean);
      const byCall = new Map<string, number>();
      for (const l of lines) byCall.set(l.split(':')[1], (byCall.get(l.split(':')[1]) ?? 0) + 1);
      expect([...byCall.values()]).toEqual([1, 1, 1]); // no double-refund anywhere
      expect(new Set(byCall.keys())).toEqual(new Set(['call-1', 'call-2', 'call-3']));
      // And the combined reports account for every entry as compensated/already/busy/not-attempted —
      // never a 'failed' invented by contention.
      for (const r of [a, b]) for (const [, status] of r.entries) {
        expect(['compensated', 'already-compensated', 'busy', 'not-attempted']).toContain(status);
      }
    });
  });

  it('putIfMatch takeover race: both processes read the SAME stale record → the engine-side CAS admits EXACTLY ONE', { timeout: 60_000 }, async () => {
    await withDir(async (dir) => {
      // Seed the stale record the two workers will fight over.
      const seedStorage = new SqliteStorage(join(dir, 'runs.db'));
      await seedStorage.runs.put('race:lockrec', { holder: 'stale' });
      await seedStorage.close();

      const { a, b } = await runPair('lock', dir);
      expect([a.won, b.won].filter(Boolean)).toHaveLength(1); // exactly one takeover
      const s = new SqliteStorage(join(dir, 'runs.db'));
      const rec = await s.runs.get<{ holder: string }>('race:lockrec');
      await s.close();
      expect(rec?.holder).toBe(a.won ? 'A' : 'B'); // and the record belongs to that winner
    });
  });
});
