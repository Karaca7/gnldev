// The known limit, closed and proven at the process level.
//
// "SIGKILL between the throw and the outcome write → the run reads 'completed'" sat in the
// CHANGELOG's Known-limits section because the vocabulary could not express a run that had started
// and not ended. The in-process tests (running-status.test.ts) prove the mechanism; this one proves
// it against the real thing — a child OS process killed with SIGKILL mid-model-call, a parent
// reading the same SQLite file afterwards. No exit handler runs on SIGKILL, which is precisely why
// the write-AHEAD is the only design that can survive it: the truth is recorded before the work.
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnFixtureEnv } from './fixtures/watchdog.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { runDurable, listRunsArray, readRunOutcome } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const tsxBin = join(dirname(require.resolve('tsx/package.json')), 'dist/cli.mjs');
const childScript = join(here, 'fixtures', 'sigkill-run.ts');

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const good = {
  specificationVersion: 'v2', provider: 'scripted', modelId: 'm', supportedUrls: {},
  doGenerate: async () => ({ content: [{ type: 'text', text: 'recovered' }], finishReason: 'stop', usage, warnings: [] }),
  doStream: async () => { throw new Error('gen-only'); },
} as any;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('a run whose process is SIGKILLed mid-work', () => {
  it('reads running — never completed — and a resume can close it', { timeout: 60_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gnl-sigkill-'));
    const dbPath = join(dir, 'runs.db');
    const readyPath = join(dir, 'ready.txt');
    try {
      // The child starts the run and signals when the model call is in flight.
      const child = spawn(process.execPath, [tsxBin, childScript, dbPath, readyPath], {
        stdio: ['ignore', 'ignore', 'pipe'], env: spawnFixtureEnv(),
      });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += String(d); });
      // Attached AT SPAWN, not after the kill: 'exit' fires exactly once, and a listener attached
      // after it has fired waits forever — which is precisely how the first version of this test
      // hung for its full timeout whenever the child lost the race.
      const exited = new Promise((r) => child.once('exit', r));

      for (let i = 0; i < 200 && !existsSync(readyPath); i++) await sleep(100);
      expect(existsSync(readyPath), `the child never reached mid-flight: ${stderr}`).toBe(true);

      // SIGKILL: no exit handler, no catch, no flush — the process simply stops existing.
      child.kill('SIGKILL');
      await exited;

      // The parent opens the SAME file the dead process was writing to.
      const journal = new SqliteStorage(dbPath).runs;
      const victim = (await listRunsArray(journal)).find((r) => r.runId === 'victim');
      expect(victim, 'the run must be visible at all').toBeDefined();
      expect(victim!.status, "this is the CHANGELOG's known limit: it used to read 'completed'").toBe('running');
      expect((await readRunOutcome(journal, 'victim'))?.status).toBe('running');

      // And the vocabulary is not a dead end: an operator resumes, the run truly finishes.
      await runDurable({ runId: 'victim', journal, model: good, prompt: 'work that will be interrupted' } as any);
      const after = (await listRunsArray(journal)).find((r) => r.runId === 'victim');
      expect(after!.status, 'a resume closes what the kill left open').toBe('completed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
