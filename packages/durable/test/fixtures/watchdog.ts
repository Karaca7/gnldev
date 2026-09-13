// Every cross-process fixture in this directory is spawned by a test and is expected to exit on its
// own. Two things break that expectation, and both happened:
//
//   1. The fixture blocks — on a run lock, a claim, a SQLite busy timeout — and simply never returns.
//   2. The test runner is interrupted (Ctrl-C, a killed CI job) while spawnSync is waiting. The child
//      is not in the runner's process group for signal purposes and keeps running, reparented to init.
//
// Neither leaves anything to clean up later: the process has no controlling terminal, its command line
// says `tsx .../fixtures/<name>.ts`, so `pkill -f vitest` does not match it, and it burns a core until
// someone finds it by PID. This session accumulated 126 of them, the oldest over five hours old, which
// starved the machine enough that unrelated suites began timing out — a failure that looks like
// flakiness and is not.
//
// So a fixture supervises itself: it exits if it outlives its purpose, and it exits once nobody is
// waiting for its result.
//
// "Nobody is waiting" is deliberately NOT `process.ppid`, which was the obvious choice and the wrong
// one. Fixtures run under tsx, and tsx forks: measured, the fixture's ppid is the tsx wrapper, not the
// test runner (`self=585183 ppid=585172` while the runner was 585164). Watching ppid therefore detects
// the death of tsx and nothing else — a watchdog that does not watch. So the runner passes its own pid
// down explicitly and the fixture polls THAT with signal 0, which is unaffected by however many
// processes sit in between.

// Below the 60s ceiling every cross-process test declares, so a hang is reported BY the watchdog
// (with a reason on stderr) rather than by a bare vitest timeout that says nothing about why.
const DEFAULT_DEADLINE_MS = 45_000;
const PARENT_POLL_MS = 500;

/** Carries the RUNNER's pid across however many processes (tsx, shells) sit between it and a fixture. */
export const FIXTURE_RUNNER_PID_ENV = 'GNL_FIXTURE_RUNNER_PID';

/** Spread into a spawn's `env` so the child can tell when the runner that wanted it has gone away. */
export function spawnFixtureEnv(): NodeJS.ProcessEnv {
  return { ...process.env, [FIXTURE_RUNNER_PID_ENV]: String(process.pid) };
}

/**
 * Arms the watchdog. Call once, at the top of a fixture, before any work.
 *
 * `unref()` on both timers is essential: they must not be the reason the process stays alive, or the
 * watchdog would itself become the leak it exists to prevent.
 */
export function armFixtureWatchdog(deadlineMs = DEFAULT_DEADLINE_MS): void {
  const deadline = setTimeout(() => {
    process.stderr.write(`fixture watchdog: still running after ${deadlineMs}ms — exiting rather than leaking\n`);
    process.exit(97);
  }, deadlineMs);
  deadline.unref();

  // Set by spawnFixtureEnv() on the test side. Absent → this fixture was started by hand; the deadline
  // above still bounds it, and there is no runner whose death would mean anything.
  const runner = Number(process.env[FIXTURE_RUNNER_PID_ENV]);
  if (!Number.isInteger(runner) || runner <= 0) return;

  const orphanCheck = setInterval(() => {
    if (!isAlive(runner)) {
      process.stderr.write(`fixture watchdog: runner ${runner} is gone — orphaned, exiting\n`);
      process.exit(98);
    }
  }, PARENT_POLL_MS);
  orphanCheck.unref();
}

/** Signal 0 delivers nothing; it only asks whether the process exists (and is reachable). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists but belongs to someone else — alive for our purposes. ESRCH means gone.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
