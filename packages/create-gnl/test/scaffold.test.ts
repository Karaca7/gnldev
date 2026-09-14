// Runs the create-gnl bin as a real child process: verifies end-to-end that it correctly
// wires up to `@gnldev/cli`'s scaffold (workspace resolution + dist output). npm install is NOT performed.
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const repoRoot = resolve(pkgRoot, '..', '..');
const binPath = join(pkgRoot, 'dist', 'index.js');

const created: string[] = [];
afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

beforeAll(() => {
  // If dist is stale (e.g. src changed but wasn't built) build before the test.
  execFileSync('pnpm', ['--filter', 'create-gnl', 'build'], { cwd: repoRoot, stdio: 'pipe' });
  expect(existsSync(binPath)).toBe(true);
  // 120s, because the default 30s hookTimeout is not a safe ceiling for a real build and a hook that
  // times out takes EVERY test in this file with it. Measured here: a warm build is ~1s, but a cold
  // one under 64 busy processes is 10-12s — and that is on sixteen cores. CI runners have two, where
  // the same work is several times slower and 30s stops being generous. Same reasoning as
  // vitest.config.ts's raised testTimeout: a red that means "the machine was busy" on the first CI
  // run of a public repository reads as "the project does not build".
}, 120_000);

describe('create-gnl bin (child process)', () => {
  it('writes the config, the agents, the tool and the proof into the target dir', () => {
    const base = mkdtempSync(join(tmpdir(), 'create-gnl-'));
    created.push(base);
    const target = join(base, 'my-agent');

    // `--yes` because this bin IS `gnl init` now (a 20-line door, not a second scaffolder): without
    // it the gate would wait for a keypress on a TTY. There is none in a test, so the prompt never
    // opens — but saying so here keeps the reason visible if that ever changes.
    const out = execFileSync('node', [binPath, target, '--yes'], { encoding: 'utf8' });
    expect(out).toContain('created');

    expect(existsSync(join(target, 'package.json'))).toBe(true);
    expect(existsSync(join(target, 'gnl.config.ts'))).toBe(true);
    // The taxonomy a project grows into, present from the first file — and the proof that the
    // charge tool actually works, which is the one thing a starter has to demonstrate.
    expect(existsSync(join(target, 'src', 'agents', 'assistant.ts'))).toBe(true);
    expect(existsSync(join(target, 'src', 'agents', 'charge-demo.ts'))).toBe(true);
    expect(existsSync(join(target, 'src', 'tools', 'charge-order.ts'))).toBe(true);
    expect(existsSync(join(target, 'test', 'proof.test.ts'))).toBe(true);
    expect(existsSync(join(target, 'README.md'))).toBe(true);
    expect(existsSync(join(target, '.gitignore'))).toBe(true);

    const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('my-agent');
    expect(pkg.scripts.dev).toBe('gnl dev');
    expect(pkg.dependencies['@gnldev/durable']).toBeDefined();
    expect(pkg.dependencies['@gnldev/server']).toBeDefined();
    expect(pkg.dependencies['@gnldev/studio']).toBeDefined();

    const readme = readFileSync(join(target, 'README.md'), 'utf8');
    expect(readme).toContain('my-agent');
    expect(readme).not.toContain('__PROJECT_NAME__');
  });

  it('errors and returns exit code 1 if the target directory is not empty', () => {
    const base = mkdtempSync(join(tmpdir(), 'create-gnl-'));
    created.push(base);
    // first run should succeed
    execFileSync('node', [binPath, join(base, 'a'), '--yes'], { encoding: 'utf8' });

    expect(() => execFileSync('node', [binPath, base, '--yes'], { encoding: 'utf8', stdio: 'pipe' })).toThrow();
  });
});
