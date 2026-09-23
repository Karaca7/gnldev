// AUDIT FINDINGS — round 12, finding #26 (audit-log.md): every `cli.ts` in the monorepo sat at 0%.
//
// `expose.ts` decides whether a host/auth combination may be served and `expose.test.ts` covers that
// decision thoroughly — but nothing checked that the CLI ACTS on it. A refusal that is computed and
// then not honoured is worse than no refusal at all: the banner would say "protected" while the
// socket is open. Driven as a SUBPROCESS, so the exit code is the real one.
//
// Coverage cannot see subprocess work; these lines still read 0% in a coverage run (same shape as
// docs-mcp/test/cli.test.ts).
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CLI = join(__dirname, '..', 'dist', 'cli.js');
const run = (...args: string[]): { out: string; code: number } => {
  try {
    return { out: execFileSync('node', [CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 }), code: 0 };
  } catch (e: any) {
    return { out: String(e.stdout ?? '') + String(e.stderr ?? ''), code: e.status ?? 1 };
  }
};

// These tests drive `dist/`, and no `test` script rebuilds it. A stale build silently turns them
// into a test of yesterday's source; a MISSING build makes `execFileSync` throw ENOENT, which the
// helper maps to exit code 1 — the very code several assertions below expect. Both failures must
// announce themselves rather than pass or lie.
beforeAll(() => {
  if (!existsSync(CLI)) throw new Error(`${CLI} is missing — run \`pnpm build\` in this package first.`);
  const newestIn = (dir: string): number => {
    if (!existsSync(dir)) return 0;
    return readdirSync(dir, { withFileTypes: true }).reduce((max, e) => {
      const p = join(dir, e.name);
      return Math.max(max, e.isDirectory() ? newestIn(p) : statSync(p).mtimeMs);
    }, 0);
  };
  const srcMs = newestIn(join(__dirname, '..', 'src'));
  const builtMs = statSync(CLI).mtimeMs;
  if (srcMs > builtMs) {
    throw new Error(`src is newer than ${CLI} by ${Math.round((srcMs - builtMs) / 60000)} min — run \`pnpm build\`; these tests measure the build, not the working tree.`);
  }
});

describe('gnl-studio entry point', () => {
  it('no arguments → usage on stderr, exit 1', () => {
    const r = run();
    expect(r.code, 'exiting 0 would look like a server started').toBe(1);
    expect(r.out).toContain('Usage: gnl-studio --db');
    expect(r.out, 'the config form must be offered too').toContain('--config');
  });

  it('a flag where the db path belongs is caught, not used as a filename', () => {
    const r = run('--db', '--port');
    expect(r.code).toBe(1);
    expect(r.out).toContain('Usage: gnl-studio --db');
  });

  // The one that matters: binding a non-loopback host with no auth must REFUSE.
  it('a non-loopback --host without auth refuses and exits 1', () => {
    const r = run('--db', join(__dirname, 'nonexistent-for-refusal.db'), '--host', '0.0.0.0');
    expect(r.code, 'an open socket must never be the default outcome').toBe(1);
    expect(r.out.toLowerCase(), 'the refusal must say why').toMatch(/auth|open|network|host/);
    expect(r.out, 'it must not announce a listening server').not.toContain('gnl studio →');
  });

  it('the usage text names the escape hatch rather than leaving the reader stuck', () => {
    expect(run().out).toContain('--allow-open-network');
  });
});
