#!/usr/bin/env node
// The real-backend gate, runnable locally instead of only on a push.
//
// WHY THIS EXISTS, precisely. `.github/workflows/ci.yml` already has an `integration` job that brings
// up Postgres (two collations) and Redis and runs the env-gated suite. It is well built and it would
// have caught the defect described below. It has also never run on this repository's work, because the
// repository has no remote: development happens locally and the public snapshot is pushed separately.
// A gate that only fires on `git push` protects nothing in a workflow with no push.
//
// What that cost, measured: commit bd393b29 turned twelve transaction-scoped Postgres statements into
// pool statements, which silently removed `applyBatch`'s atomicity and made `put`'s run-row lock a
// no-op — two of the guarantees exactly-once rests on. The default suite stayed green at 3579 tests
// for a full day, and it could not have done otherwise: it runs Postgres on pg-mem, which accepts
// BEGIN/COMMIT/ROLLBACK without undoing on rollback and does not enforce row locking (see the comment
// at postgres-storage.ts:186). The tests that CAN see it are skipped without a live server. So the
// suite was not merely silent — it was structurally incapable of speaking.
//
// This script closes the loop the way it can be closed locally: bring the servers up, run every
// env-gated test against them, tear the servers down.
//
//   node scripts/check-real-backends.mjs          # Postgres + Redis (+ the model provider if a key is set)
//   node scripts/check-real-backends.mjs --failover  # also the kill-the-primary scenario
//   node scripts/check-real-backends.mjs --keep      # leave the containers up afterwards
//
// The provider leg runs only when NVIDIA_API_KEY or OPENAI_API_KEY is present, and says so when it
// skips. The failover leg is opt-in because it KILLS a container and needs a fresh compose each run.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const withFailover = args.has('--failover');
const keep = args.has('--keep');

// docker-compose.yml sets POSTGRES_PASSWORD and POSTGRES_DB but not POSTGRES_USER, so the role is the
// image default `postgres` — the same URL integration-real.test.ts falls back to when GNL_PG_URL is unset.
const PG_URL = 'postgres://postgres:gnl@localhost:55432/gnl';
const REDIS_URL = 'redis://localhost:6380';

const run = (cmd, argv, opts = {}) =>
  spawnSync(cmd, argv, { cwd: root, stdio: 'inherit', encoding: 'utf8', ...opts });
const quiet = (cmd, argv) =>
  spawnSync(cmd, argv, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });

/**
 * `docker compose` (v2 plugin) or `docker-compose` (v1 binary), whichever this machine has.
 * Resolved rather than assumed: v2 rejects `-f` as an unknown shorthand when only v1 is installed,
 * and the error names the flag rather than the missing plugin, which reads as a broken script.
 */
function composeCmd() {
  if (quiet('docker', ['compose', 'version']).status === 0) return ['docker', ['compose']];
  if (quiet('docker-compose', ['version']).status === 0) return ['docker-compose', []];
  return null;
}

const compose = composeCmd();
if (!compose) {
  console.error('check-real-backends: neither `docker compose` nor `docker-compose` is available.\n'
    + '  These tests need a real Postgres and a real Redis — there is no in-process substitute that\n'
    + '  can prove transaction rollback or row locking. Install Docker, or run the suite on a machine\n'
    + '  that has it, before calling the real-backend gate passed.');
  process.exit(2);
}
const [bin, pre] = compose;
const composeRun = (file, ...rest) => run(bin, [...pre, '-f', file, ...rest]);

/** Polls until Postgres answers a real query, or gives up. `pg_isready` is not enough — it reports
 *  ready while the initdb bootstrap is still creating the database the URL names.
 *
 *  The container is resolved through `compose ps -q` rather than named: v1 and v2 generate different
 *  names for the same service (`<project>_postgres_1` vs `<project>-postgres-1`), and a hardcoded guess
 *  fails on whichever machine has the other one — as a timeout, which reads as "the database is
 *  broken" rather than "the script looked for the wrong container". */
function waitForPostgres(seconds = 90) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const id = quiet(bin, [...pre, '-f', 'docker-compose.yml', 'ps', '-q', 'postgres']).stdout?.trim().split('\n')[0];
    if (id) {
      const r = quiet('docker', ['exec', id, 'psql', '-U', 'postgres', '-d', 'gnl', '-c', 'SELECT 1']);
      if (r.status === 0) return true;
    }
    if (Date.now() > deadline) {
      console.error(id ? '  postgres is up but never answered a query' : '  the postgres container was never found');
      return false;
    }
    spawnSync('sleep', ['2']);
  }
}

const failures = [];
const skipped = [];

function step(label, fn) {
  console.log(`\n\x1b[1m▸ ${label}\x1b[0m`);
  const ok = fn();
  if (ok === 'skip') return;
  if (!ok) failures.push(label);
}

try {
  step('postgres + redis up', () => composeRun('docker-compose.yml', 'up', '-d').status === 0);
  if (failures.length) throw new Error('compose up failed');

  if (!waitForPostgres()) {
    failures.push('postgres never became reachable');
    throw new Error('postgres unreachable');
  }

  // The env names matter and have been wrong before: the CI job originally exported PG_URL/REDIS_PORT,
  // which the tests never read, so it connected to the built-in defaults and failed on a retry timeout
  // while looking like a real-backend run. These are the names integration-real.test.ts actually reads.
  const env = { ...process.env, GNL_INTEGRATION: '1', GNL_PG_URL: PG_URL, GNL_REDIS_URL: REDIS_URL };

  step('real Postgres + Redis (integration-real, prefix ranges, pgvector)', () =>
    run('pnpm', ['exec', 'vitest', 'run',
      'packages/durable/test/integration-real.test.ts',
      'packages/durable/test/prefix-astral-postgres.test.ts',
      'packages/rag/test/postgres-vector-store.test.ts',
      // Organization isolation for the metrics export: an in-memory journal addresses counters by
      // exact key, so the cross-tenant read this guards against cannot even be written against it.
      'packages/otel/test/metrics-org-postgres.test.ts'], { env }).status === 0);

  step('real model provider', () => {
    if (!process.env.NVIDIA_API_KEY && !process.env.OPENAI_API_KEY) {
      skipped.push('real model provider — no NVIDIA_API_KEY or OPENAI_API_KEY in the environment');
      console.log('  skipped: no NVIDIA_API_KEY or OPENAI_API_KEY set');
      return 'skip';
    }
    return run('pnpm', ['exec', 'vitest', 'run', 'packages/durable/test/real-provider.test.ts']).status === 0;
  });

  if (withFailover) {
    const file = 'docker-compose.failover.yml';
    if (!existsSync(join(root, file))) {
      skipped.push(`failover — ${file} is not present`);
    } else {
      // A fresh stack every time: the scenario kills the primary and promotes the replica, so a
      // second run against the same volumes tests a promoted node pretending to be a primary.
      composeRun(file, 'down', '-v');
      step('failover: kill the primary, promote the replica', () => {
        if (composeRun(file, 'up', '-d').status !== 0) return false;
        const deadline = Date.now() + 120_000;
        for (;;) {
          const r = quiet('docker', ['exec', 'gnl-failover-primary', 'psql', '-U', 'gnl', '-d', 'gnl',
            '-tc', 'SELECT sync_state FROM pg_stat_replication']);
          if (r.status === 0 && r.stdout.includes('sync')) break;
          if (Date.now() > deadline) {
            console.error('  the replica never reached sync_state=sync — the scenario would prove nothing');
            return false;
          }
          spawnSync('sleep', ['2']);
        }
        return run('pnpm', ['exec', 'vitest', 'run', 'packages/durable/test/failover-real.test.ts'],
          { env: { ...process.env, GNL_FAILOVER: '1' } }).status === 0;
      });
      if (!keep) composeRun(file, 'down', '-v');
    }
  } else {
    skipped.push('failover — pass --failover to include it (it kills a container)');
  }
} finally {
  if (!keep) composeRun('docker-compose.yml', 'down');
}

console.log('');
for (const s of skipped) console.log(`\x1b[33m∼ not run:\x1b[0m ${s}`);
if (failures.length) {
  console.error(`\n\x1b[31m✗ real-backend gate failed:\x1b[0m\n${failures.map((f) => `    ${f}`).join('\n')}`);
  process.exit(1);
}
// Deliberately does not say "everything passes". What was skipped is printed above, and a run with the
// provider and failover legs skipped has not covered them — reporting a clean bill for a partial run is
// how a gate turns into decoration.
console.log('\x1b[32m✓ every real-backend leg that ran, passed.\x1b[0m'
  + (skipped.length ? ' See the not-run list above before calling this a full pass.' : ''));
