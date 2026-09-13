// The cross-process fixtures are spawned with spawnSync and are trusted to exit on their own. Twice
// they did not — a fixture blocked on a lock, and the runner was interrupted mid-spawnSync — and each
// time the child kept running, reparented, with a command line (`tsx .../fixtures/<name>.ts`) that
// `pkill -f vitest` does not match. This session accumulated 126 of them, the oldest over five hours
// old; they saturated the CPU until unrelated suites started timing out, which reads as flakiness and
// is not.
//
// This pins the watchdog that stops it. The interesting assertion is the orphan one, because the
// obvious implementation of it does not work: fixtures run under tsx, and tsx FORKS, so a fixture's
// process.ppid is the tsx wrapper rather than the runner. A ppid-based watchdog therefore notices only
// tsx dying — it would have looked correct and caught nothing. The runner's pid is passed down
// explicitly instead, which is what this test exercises, through a real tsx in the middle.
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { FIXTURE_RUNNER_PID_ENV } from './fixtures/watchdog.js';

const require = createRequire(import.meta.url);
const tsxBin = join(dirname(require.resolve('tsx/package.json')), 'dist/cli.mjs');
const watchdogPath = join(import.meta.dirname, 'fixtures', 'watchdog.ts');

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fixture that never exits by itself — exactly the shape that leaked. */
function neverEndingFixture(deadlineMs: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'gnl-wd-'));
  const file = join(dir, 'hang.ts');
  writeFileSync(file, [
    `import { armFixtureWatchdog } from ${JSON.stringify(watchdogPath)};`,
    `armFixtureWatchdog(${deadlineMs});`,
    'process.stdout.write(`up pid=${process.pid}\\n`);',
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  return file;
}

/** Starts the fixture under tsx and resolves the REAL fixture pid (not tsx's). */
function startFixture(file: string, runnerPid: number): Promise<{ pid: number; kill: () => void }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxBin, file], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, [FIXTURE_RUNNER_PID_ENV]: String(runnerPid) },
    });
    const t = setTimeout(() => reject(new Error('fixture never reported its pid')), 30_000);
    child.stdout.on('data', (d) => {
      const m = /up pid=(\d+)/.exec(String(d));
      if (!m) return;
      clearTimeout(t);
      resolve({ pid: Number(m[1]), kill: () => { try { child.kill('SIGKILL'); process.kill(Number(m[1]), 9); } catch { /* already gone */ } } });
    });
    child.on('error', reject);
  });
}

describe('the cross-process fixture watchdog', () => {
  it('exits a fixture whose runner has gone away, with tsx in between', { timeout: 60_000 }, async () => {
    // A stand-in for the runner. Its death is the signal; it is NOT the fixture's parent (tsx is),
    // which is the whole reason the pid is passed explicitly. Its lifetime is EVENT-driven, not a
    // timer: the first version gave it two seconds and under full-suite CPU saturation the tsx
    // fixture could not even boot inside them — the stand-in was already dead before the watchdog
    // armed, and the test timed out. Ordered explicitly (fixture up → THEN kill the runner), the
    // saturation has nothing left to race.
    const stand_in = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 600000)'], { stdio: 'ignore' });
    const standInExited = new Promise((r) => stand_in.once('exit', r));
    const fixture = await startFixture(neverEndingFixture(300_000), stand_in.pid!);

    expect(alive(fixture.pid), 'the fixture is up while its runner lives').toBe(true);
    stand_in.kill('SIGKILL');
    await standInExited;

    let died = false;
    for (let i = 0; i < 20 && !died; i++) { await sleep(500); died = !alive(fixture.pid); }
    fixture.kill();
    expect(died, 'an orphaned fixture must not survive its runner — this is the 126-zombie case').toBe(true);
  });

  it('exits a fixture that simply hangs, even while its runner is alive', { timeout: 60_000 }, async () => {
    const fixture = await startFixture(neverEndingFixture(1_500), process.pid);
    let died = false;
    for (let i = 0; i < 20 && !died; i++) { await sleep(500); died = !alive(fixture.pid); }
    fixture.kill();
    expect(died, 'the deadline bounds a blocked fixture too').toBe(true);
  });

  it('leaves a hand-run fixture alone when no runner pid was passed', { timeout: 60_000 }, async () => {
    const file = neverEndingFixture(300_000);
    const child = spawn(process.execPath, [tsxBin, file], { stdio: ['ignore', 'pipe', 'ignore'] });
    const pid = await new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no pid')), 30_000);
      child.stdout.on('data', (d) => { const m = /up pid=(\d+)/.exec(String(d)); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
    });
    // No GNL_FIXTURE_RUNNER_PID → nothing to watch. It must not guess and kill itself; only the
    // deadline (long, here) applies.
    await sleep(2_000);
    const stillUp = alive(pid);
    try { child.kill('SIGKILL'); process.kill(pid, 9); } catch { /* gone */ }
    expect(stillUp).toBe(true);
  });
});
