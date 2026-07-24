// Runs the create-gnl bin as a real child process: verifies end-to-end that it correctly
// wires up to `@gnl/cli`'s scaffold (workspace resolution + dist output). npm install is NOT performed.
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
});

describe('create-gnl bin (child process)', () => {
  it('writes gnl.config.ts + src/model.ts + package.json + README.md to the target dir', () => {
    const base = mkdtempSync(join(tmpdir(), 'create-gnl-'));
    created.push(base);
    const target = join(base, 'my-agent');

    const out = execFileSync('node', [binPath, target], { encoding: 'utf8' });
    expect(out).toContain('gnl project created');

    expect(existsSync(join(target, 'package.json'))).toBe(true);
    expect(existsSync(join(target, 'gnl.config.ts'))).toBe(true);
    expect(existsSync(join(target, 'src', 'model.ts'))).toBe(true);
    expect(existsSync(join(target, 'README.md'))).toBe(true);
    expect(existsSync(join(target, '.gitignore'))).toBe(true);

    const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('my-agent');
    expect(pkg.scripts.dev).toBe('gnl dev');
    expect(pkg.dependencies['@gnl/durable']).toBeDefined();
    expect(pkg.dependencies['@gnl/server']).toBeDefined();
    expect(pkg.dependencies['@gnl/studio']).toBeDefined();

    const readme = readFileSync(join(target, 'README.md'), 'utf8');
    expect(readme).toContain('my-agent');
    expect(readme).not.toContain('__PROJECT_NAME__');
  });

  it('errors and returns exit code 1 if the target directory is not empty', () => {
    const base = mkdtempSync(join(tmpdir(), 'create-gnl-'));
    created.push(base);
    // first run should succeed
    execFileSync('node', [binPath, join(base, 'a')], { encoding: 'utf8' });

    expect(() => execFileSync('node', [binPath, base], { encoding: 'utf8', stdio: 'pipe' })).toThrow();
  });
});
