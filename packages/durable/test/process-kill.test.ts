// REAL multi-process durability: the child process performs a charge and then hard-crashes (process.exit),
// the parent resumes with the same SQLite journal file → charge is EXACTLY 1 (unlike the in-memory test,
// a real process boundary is crossed here).

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { runDurable } from '../src/run.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';
import { spawnFixtureEnv } from './fixtures/watchdog.js';

const here = dirname(fileURLToPath(import.meta.url));
const tsxBin = join(here, '..', '..', '..', 'node_modules', '.bin', 'tsx');
const childScript = join(here, 'fixtures', 'crash-run.ts');

describe('real process-kill resume', () => {
  // 60s, above the child's own 50s spawnSync bound. Without it the test inherits the 30s default and
  // dies FIRST, so the subprocess guard — the thing that produces a readable "the child hung" — can
  // never fire. multi-process-race, sigkill-status and fixture-watchdog already order it this way.
  it('child crashes → parent resumes with the same SQLite → charge exactly 1', { timeout: 60_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gnl-durable-'));
    const dbPath = join(dir, 'runs.db');
    const sePath = join(dir, 'charges.txt');
    try {
      // Run 1 — child process: performs the charge, then process.exit(1)
      const child = spawnSync(tsxBin, [childScript, dbPath, sePath], { encoding: 'utf8', timeout: 50_000, env: spawnFixtureEnv() });
      // `not.toBe(0)` alone is not enough: `spawnSync` reports a TIMED-OUT child as `status: null`,
      // and `null !== 0` passes — a hung child would read as "it really crashed". Harmless while the
      // test ceiling was below the child's 50s bound, because the run died before the timeout could
      // happen; raising the ceiling to 60s made that path reachable. Assert the spawn itself was
      // clean, then that the exit was a real non-zero CODE.
      expect(child.error, 'the child did not exit on its own — spawnSync gave up on it').toBeUndefined();
      expect(typeof child.status).toBe('number');
      expect(child.status).not.toBe(0); // it really crashed
      // ...by crashing, not by the fixture watchdog giving up — otherwise this passes for the wrong reason.
      expect(child.stderr ?? '').not.toContain('fixture watchdog');
      expect(Number(readFileSync(sePath, 'utf8'))).toBe(1); // charge happened once

      // Run 2 — parent: resumes with the SAME SqliteStorage FILE
      const chargeCard = tool({
        description: 'charge',
        inputSchema: z.object({ amount: z.number() }),
        execute: async ({ amount }) => {
          const n = Number(readFileSync(sePath, 'utf8')) || 0;
          writeFileSync(sePath, String(n + 1));
          return { charged: amount };
        },
      });
      const model = createMockModel(async ({ prompt }: any) => {
        const done = countToolResults(prompt);
        if (done === 0) return toolCallResult('chargeCard', 'call-charge', { amount: 20 });
        return finalTextResult('Charged.');
      });

      const b = new SqliteStorage(dbPath);
      const res = await runDurable({
        runId: 'order-kill',
        journal: b.runs,
        model,
        tools: { chargeCard },
        prompt: 'charge',
        stopWhen: stepCountIs(6),
      });
      await b.close();

      expect(Number(readFileSync(sePath, 'utf8'))).toBe(1); // NO repeated charge on resume
      expect(res.text).toContain('Charged');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
