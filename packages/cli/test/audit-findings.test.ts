// AUDIT FINDINGS — round 12, finding #26 (audit-log.md).
//
// All SIX `cli.ts` files in the monorepo sat at 0% coverage: cli, durable/cli/chat, studio,
// semantic-qualify, auth-ee, docs-mcp. The suites measured the library and not the thing a user
// TYPES — and the gap was concrete: round 11's #24 (the runId gate) is reachable from exactly this
// surface, via `gnl chat --session`.
//
// This file closes the busiest entry point: the `gnl` binary, driven as a SUBPROCESS so the real
// behaviour of the real binary is what gets measured, with no change to the source. The remaining
// five can be closed the same way; that was not done in this round (see the scope statement).
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';

const CLI = join(__dirname, '..', 'dist', 'cli.js');
const run = (...args: string[]): { out: string; code: number } => {
  try {
    return { out: execFileSync('node', [CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), code: 0 };
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

describe('#26 the `gnl` entry point', () => {
  it('--version resolves a real version rather than falling back', () => {
    // `readVersion()` (src/cli.ts) reads package.json relative to dist/ and has a `catch` that
    // returns '0.0.0'. Comparing the output to that same file is a tautology — both sides move
    // together, and an audit proved it: setting the version to 99.99.99 kept the test green. What
    // can actually break is the RESOLUTION: a moved dist, a changed layout, a packed tarball whose
    // relative path differs. So assert the shape and the absence of the fallback.
    const out = run('--version').out.trim();
    expect(out, 'the catch in readVersion() swallowed a resolution failure').not.toBe('0.0.0');
    expect(out).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
    expect(run('-v').out.trim(), '-v and --version must not drift').toBe(out);
    // And it must be a version this workspace actually declares somewhere, not an invented string.
    const declared = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version;
    expect([declared]).toContain(out);
  });

  it('--help lists EVERY registered command', async () => {
    const { commandList } = await import('../src/commands/index.js');
    const help = run('--help').out;
    const missing = commandList.filter((c: any) => !help.includes(c.name)).map((c: any) => c.name);
    expect(missing, 'a command absent from help is a command nobody can find').toEqual([]);
  });

  it('a bare invocation prints help rather than nothing', () => {
    const r = run();
    expect(r.out).toContain('gnl');
    expect(r.out.length).toBeGreaterThan(100);
  });

  it('`gnl help <command>` prints that one command', () => {
    const r = run('help', 'doctor');
    expect(r.out).toContain('doctor');
    expect(r.code).toBe(0);
  });

  it('an unknown command exits NON-ZERO and suggests the near miss', () => {
    const r = run('doctr');
    expect(r.code, 'exiting 0 would let a script read the failure as success').toBe(1);
    expect(r.out).toContain('unknown command');
    expect(r.out, 'a near-miss should be offered').toContain('doctor');
  });

  it('a command nothing resembles gets NO invented suggestion', () => {
    const r = run('zzzzzzzz');
    expect(r.code).toBe(1);
    expect(r.out).toContain('unknown command');
    expect(r.out).not.toContain('did you mean');
  });
});
