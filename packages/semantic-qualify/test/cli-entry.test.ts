// AUDIT FINDINGS — round 12, finding #26 (audit-log.md): every `cli.ts` in the monorepo sat at 0%.
//
// Here the EXIT CODE is the product. The header states the contract — "0 passed (certificate
// written), 1 failed, 2 usage/loading error … that makes the exam usable as a CI gate" — and a CI
// gate whose exit codes nobody tested is a gate in name only. A `2` that leaked out as `0` would
// turn a judge that never loaded into a build that passed.
//
// Driven as a SUBPROCESS; coverage cannot see that, so these lines still read 0% in a coverage run.
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(__dirname, '..', 'dist', 'cli.js');
const run = (...args: string[]): { out: string; code: number } => {
  try {
    return { out: execFileSync('node', [CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }), code: 0 };
  } catch (e: any) {
    return { out: String(e.stdout ?? '') + String(e.stderr ?? ''), code: e.status ?? 1 };
  }
};
const tmp = mkdtempSync(join(tmpdir(), 'gnl-qualify-'));
const writeJudge = (name: string, body: string): string => {
  const p = join(tmp, name);
  writeFileSync(p, body, 'utf8');
  return p;
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

describe('gnl-semantic-qualify entry point', () => {
  it('missing arguments → exit 2 (usage), not 0 and not 1', () => {
    const r = run();
    expect(r.code, '0 would pass a CI gate that never ran; 1 would read as "judge failed"').toBe(2);
    expect(r.out).toContain('usage: gnl-semantic-qualify');
  });

  it('--judge without --model is still a usage error', () => {
    expect(run('--judge', './x.mjs').code).toBe(2);
  });

  it('a judge module that exports no closure → exit 2, naming the file', () => {
    const p = writeJudge('not-a-judge.mjs', 'export const somethingElse = 1;\n');
    const r = run('--judge', p, '--model', 'test-model');
    expect(r.code, 'a judge that did not load is a LOADING error, not a verdict').toBe(2);
    expect(r.out).toContain(p);
    expect(r.out).toContain('default-export');
  });

  it('a judge that exports a non-function default → exit 2', () => {
    const p = writeJudge('default-not-fn.mjs', 'export default { nope: true };\n');
    expect(run('--judge', p, '--model', 'test-model').code).toBe(2);
  });

  it('CONTROL: a loadable judge gets PAST loading (verdict, not a loading error)', () => {
    // Answers nonsense on purpose: the point is that it LOADS, so the exit code becomes a verdict
    // (0 or 1) rather than 2. Kept to the smallest legal bench so the test stays fast.
    const p = writeJudge('loads.mjs', 'export default async () => "no";\n');
    const r = run('--judge', p, '--model', 'test-model', '--limit', '20', '--concurrency', '8');
    expect([0, 1], `expected a verdict, got ${r.code}: ${r.out.slice(0, 300)}`).toContain(r.code);
  });
});
