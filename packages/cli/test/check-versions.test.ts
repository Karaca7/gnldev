// scripts/check-versions.mjs — the CI guard behind `pnpm check:versions`, which is what actually holds
// VERSIONING.md's lockstep promise. It had no test at all, and an adversarial audit walked three fixtures
// straight past it: a private-but-distributed package at the wrong version, a whole workspace at an rc,
// and a malformed manifest that died with a stack naming no file. Those three fixtures are these tests.
//
// The script is run as a child process against synthetic workspace trees, which is how the audit found
// the holes and the only way to assert on exit codes and stderr as CI sees them. The trick that makes it
// work without adding a --root flag to production code: the script derives the workspace root from its
// OWN location (`import.meta.url/..`), so copying the real file into <fixture>/scripts/ points it at the
// fixture. The bytes under test are the shipped bytes.
//
// Fixtures live under the OS temp dir rather than beside this file (unlike cli-integration.test.ts):
// check-versions imports nothing but node builtins, so it needs no workspace node_modules, and writing
// packages/*/package.json trees inside the repo is worth avoiding.
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const realScript = join(repoRoot, 'scripts', 'check-versions.mjs');

const created: string[] = [];
afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A throwaway workspace holding the real script, so it scans these manifests instead of the repo's. */
function fixtureWorkspace(manifests: Record<string, unknown | string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gnl-check-versions-'));
  created.push(dir);
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(realScript, join(dir, 'scripts', 'check-versions.mjs'));
  for (const [name, manifest] of Object.entries(manifests)) {
    mkdirSync(join(dir, 'packages', name), { recursive: true });
    writeFileSync(
      join(dir, 'packages', name, 'package.json'),
      typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2),
    );
  }
  return dir;
}

function runGuard(dir: string, env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [join(dir, 'scripts', 'check-versions.mjs')], {
    encoding: 'utf8',
    env: { ...process.env, GNL_ALLOW_PRERELEASE: undefined, ...env } as NodeJS.ProcessEnv,
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

/** A published package: public, with the `files` payload every real one carries. */
const pub = (name: string, version: string) => ({ name: `@gnldev/${name}`, version, files: ['dist'] });

describe('check-versions: private-but-distributed packages are in the lockstep set', () => {
  it('fails when @gnldev/auth-ee drifts, even though it is private (the audit fixture)', () => {
    const dir = fixtureWorkspace({
      server: pub('server', '0.1.0'),
      durable: pub('durable', '0.1.0'),
      // private:true, but packed and shipped to customers out of band — `files` is the tell.
      'auth-ee': { name: '@gnldev/auth-ee', version: '0.0.7', private: true, files: ['dist'], bin: { 'gnl-ee-license': './dist/cli.js' } },
    });
    const { status, out } = runGuard(dir);
    expect(status).toBe(1);
    expect(out).toMatch(/NOT in lockstep/);
    expect(out).toContain('@gnldev/auth-ee');
    expect(out).toContain('0.0.7');
  });

  it('still exempts a private package with no publish payload — nothing ships, nothing to match', () => {
    const dir = fixtureWorkspace({
      server: pub('server', '0.1.0'),
      // the shape of an internal-only workspace package: no `files`, so npm pack has nothing to select
      'lab-pressure': { name: '@gnldev/lab-pressure', version: '0.0.0', private: true },
    });
    expect(runGuard(dir).status).toBe(0);
  });
});

describe('check-versions: prerelease versions', () => {
  const rcWorkspace = () =>
    fixtureWorkspace({ server: pub('server', '0.2.0-rc.1'), durable: pub('durable', '0.2.0-rc.1') });

  it('fails a workspace that is uniformly on an rc, naming the npm `latest` consequence', () => {
    const { status, out } = runGuard(rcWorkspace());
    expect(status).toBe(1);
    expect(out).toMatch(/PRERELEASE/);
    expect(out).toContain('latest');
    expect(out).toContain('GNL_ALLOW_PRERELEASE=1');
  });

  it('passes when the invocation opts in explicitly', () => {
    const { status, out } = runGuard(rcWorkspace(), { GNL_ALLOW_PRERELEASE: '1' });
    expect(status).toBe(0);
    expect(out).toContain('0.2.0-rc.1');
  });

  it('build metadata is not a prerelease — `+build.5` publishes as latest legitimately', () => {
    const dir = fixtureWorkspace({ server: pub('server', '0.2.0+build.5'), durable: pub('durable', '0.2.0+build.5') });
    expect(runGuard(dir).status).toBe(0);
  });
});

describe('check-versions: malformed manifests', () => {
  it('names the file it could not parse instead of dying with an anonymous SyntaxError', () => {
    const dir = fixtureWorkspace({
      server: pub('server', '0.1.0'),
      broken: '{ "name": "@gnldev/broken", "version": 0.1.0 }', // unquoted version → invalid JSON
    });
    const { status, out } = runGuard(dir);
    expect(status).toBe(1);
    expect(out).toContain('check-versions: cannot parse');
    expect(out).toContain(join('packages', 'broken', 'package.json'));
    // the parse error itself is kept — "Unexpected token" is the part that says what is wrong
    expect(out).not.toMatch(/^\s*at /m);
  });
});

describe('check-versions: the real repository', () => {
  it('exits 0 against the actual workspace (the guard has to stay usable, not just strict)', () => {
    const result = spawnSync(process.execPath, [realScript], { encoding: 'utf8' });
    expect(`${result.stdout}${result.stderr}`).toContain('all at');
    expect(result.status).toBe(0);
  });
});
