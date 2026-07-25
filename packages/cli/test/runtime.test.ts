// runtime.ts: resolves @gnldev/durable/server/studio/… from the TARGET PROJECT (not @gnldev/cli's own deps),
// plus the compatibility guard (assertCompatible/gte) that turns a version/shape mismatch into a clear
// error instead of a bare "X is not a function" crash.
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveFromProject,
  loadDurable,
  gte,
  assertCompatible,
  REQUIRED_DURABLE_EXPORTS,
} from '../src/runtime.js';

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(here, '..'); // packages/cli — has a real node_modules/@gnldev/durable workspace symlink

const created: string[] = [];
afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpProjectDir(): string {
  const dir = mkdtempSync(join(here, '.tmp-runtime-'));
  created.push(dir);
  return dir;
}

/** Writes a minimal fake `pkgName` package (package.json + index.js) into `baseDir/node_modules/...`,
 *  each name in `exportNames` becomes an exported no-op function. */
function writeFakePackage(baseDir: string, pkgName: string, version: string, exportNames: readonly string[]): void {
  const pkgDir = join(baseDir, 'node_modules', ...pkgName.split('/'));
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: pkgName, version, type: 'module', main: 'index.js' }));
  writeFileSync(join(pkgDir, 'index.js'), exportNames.map((n) => `export function ${n}() {}`).join('\n') + '\n');
}

describe('resolveFromProject', () => {
  it('resolves a real package from a project that has it installed (workspace symlink)', async () => {
    const mod = (await resolveFromProject('@gnldev/durable', cliRoot)) as Record<string, unknown>;
    expect(typeof mod.forkRun).toBe('function');
  });

  it('a package that is not installed anywhere in the resolution chain -> a clear, actionable error', async () => {
    const dir = tmpProjectDir();
    await expect(resolveFromProject('@definitely-not-a-real-gnl-package-xyz', dir)).rejects.toThrow(
      /couldn't resolve '@definitely-not-a-real-gnl-package-xyz'.*run this inside a gnl project/,
    );
  });
});

describe('gte (zero-dep semver >=, prerelease/build ignored)', () => {
  it('equal versions are gte', () => {
    expect(gte('1.2.3', '1.2.3')).toBe(true);
  });
  it('greater patch/minor/major are gte', () => {
    expect(gte('1.2.4', '1.2.3')).toBe(true);
    expect(gte('1.3.0', '1.2.9')).toBe(true);
    expect(gte('2.0.0', '1.9.9')).toBe(true);
  });
  it('lower versions are not gte', () => {
    expect(gte('1.2.3', '1.3.0')).toBe(false);
    expect(gte('0.9.0', '1.0.0')).toBe(false);
  });
  it('prerelease/build metadata is ignored (core version only)', () => {
    expect(gte('1.2.3-beta.1', '1.2.3')).toBe(true);
    expect(gte('1.2.3+build5', '1.2.3')).toBe(true);
  });
});

describe('assertCompatible (shape/capability + version guard)', () => {
  it('a module missing required exports -> a clear error naming exactly what is missing', () => {
    const dir = tmpProjectDir();
    writeFakePackage(dir, '@gnldev/durable', '0.1.0', ['forkRun', 'reconstructState']); // missing the rest
    const req = createRequire(join(dir, 'noop.js'));
    const resolvedFile = req.resolve('@gnldev/durable');
    const mod = { forkRun: () => {}, reconstructState: () => {} };
    expect(() => assertCompatible(mod, '@gnldev/durable', dir, resolvedFile, REQUIRED_DURABLE_EXPORTS, '0.0.0')).toThrow(
      /missing: .*toJournal.*getRunCost/,
    );
  });

  it('a real disk-resolved package.json below the required minimum -> a clear version error', () => {
    const dir = tmpProjectDir();
    writeFakePackage(dir, '@gnldev/durable', '0.5.0', REQUIRED_DURABLE_EXPORTS);
    const req = createRequire(join(dir, 'noop.js'));
    const resolvedFile = req.resolve('@gnldev/durable');
    const mod = Object.fromEntries(REQUIRED_DURABLE_EXPORTS.map((n) => [n, () => {}]));
    expect(() => assertCompatible(mod, '@gnldev/durable', dir, resolvedFile, REQUIRED_DURABLE_EXPORTS, '1.0.0')).toThrow(
      /needs @gnldev\/durable >= 1\.0\.0, but this project .* has 0\.5\.0/,
    );
  });

  it('a fully-shaped, version-satisfying module -> no throw', () => {
    const dir = tmpProjectDir();
    writeFakePackage(dir, '@gnldev/durable', '0.5.0', REQUIRED_DURABLE_EXPORTS);
    const req = createRequire(join(dir, 'noop.js'));
    const resolvedFile = req.resolve('@gnldev/durable');
    const mod = Object.fromEntries(REQUIRED_DURABLE_EXPORTS.map((n) => [n, () => {}]));
    expect(() => assertCompatible(mod, '@gnldev/durable', dir, resolvedFile, REQUIRED_DURABLE_EXPORTS, '0.0.0')).not.toThrow();
  });
});

describe('loadDurable (end-to-end through the guard)', () => {
  it('a real, compatible project -> resolves and returns the full module', async () => {
    const d = await loadDurable(cliRoot);
    expect(typeof d.forkRun).toBe('function');
    expect(typeof d.createGnl).toBe('function');
  });

  it("an installed but incompatible @gnldev/durable (old shape, missing exports) -> a clear 'incompatible' error, not a raw crash", async () => {
    const dir = tmpProjectDir();
    writeFakePackage(dir, '@gnldev/durable', '0.1.0', ['forkRun', 'toJournal']); // old core: most of what the CLI calls is missing
    await expect(loadDurable(dir)).rejects.toThrow(/incompatible with this gnl CLI/);
    await expect(loadDurable(dir)).rejects.toThrow(/missing: .*resumeRun/);
  });

  it('a fake but fully-shaped @gnldev/durable -> loads successfully (all required exports present)', async () => {
    const dir = tmpProjectDir();
    writeFakePackage(dir, '@gnldev/durable', '1.2.3', REQUIRED_DURABLE_EXPORTS);
    const d = await loadDurable(dir);
    for (const name of REQUIRED_DURABLE_EXPORTS) expect(typeof (d as any)[name]).toBe('function');
  });
});
