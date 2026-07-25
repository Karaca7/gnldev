// Task 3 — suite-consistency guard: assertSuiteConsistent + versionsEqual (see src/suite-consistency.ts).
// Builds a FAKE project dir (node_modules/@gnldev/<pkg>/package.json) and points `fromDir` at it — no real
// sibling packages are touched. @gnldev/durable's OWN version is read from the real package.json (whatever
// it happens to be — the tests derive the "equal"/"mismatch" versions FROM it, so they stay correct
// even if the version is bumped later).
import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSuiteConsistent, versionsEqual, SuiteVersionMismatchError } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OWN_VERSION: string = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version;
// A version that is GUARANTEED to differ from OWN_VERSION (bump the patch).
const [maj, min, pat] = OWN_VERSION.split('.').map((n) => Number(n) || 0);
const MISMATCHED_VERSION = `${maj}.${min}.${pat + 1}`;

/** Creates `<tmp>/node_modules/@gnldev/<name>/package.json` with the given version. */
function fakeSibling(root: string, name: string, version: string): void {
  const dir = join(root, 'node_modules', '@gnldev', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@gnldev/${name}`, version }));
}

describe('versionsEqual (pure function)', () => {
  it('equal major.minor.patch → true', () => {
    expect(versionsEqual('1.2.3', '1.2.3')).toBe(true);
  });
  it('different patch/minor/major → false', () => {
    expect(versionsEqual('1.2.3', '1.2.4')).toBe(false);
    expect(versionsEqual('1.2.3', '1.3.3')).toBe(false);
    expect(versionsEqual('1.2.3', '2.2.3')).toBe(false);
  });
  it('prerelease/build metadata is ignored (core only)', () => {
    expect(versionsEqual('1.2.3-beta.1', '1.2.3')).toBe(true);
    expect(versionsEqual('1.2.3+build.5', '1.2.3')).toBe(true);
    expect(versionsEqual('1.2.3-rc.1+build.5', '1.2.3')).toBe(true);
  });
  it('malformed input defaults each unparsable component to 0 (same "don\'t know" philosophy as cli/runtime.ts gte())', () => {
    expect(versionsEqual('not-a-version', '0.0.0')).toBe(true);
  });
});

describe('assertSuiteConsistent (fake project dir, no real sibling packages touched)', () => {
  let dir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'gnl-suite-consistency-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  afterEach(() => {
    warnSpy?.mockRestore();
  });

  it('equal versions → silent (no warn, no throw)', () => {
    fakeSibling(dir, 'memory', OWN_VERSION);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => assertSuiteConsistent({ packages: ['memory'], fromDir: dir })).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("mismatched version + onMismatch:'warn' (default) → ONE clear console.warn, does not throw", () => {
    fakeSibling(dir, 'server', MISMATCHED_VERSION);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => assertSuiteConsistent({ packages: ['server'], fromDir: dir })).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = warnSpy.mock.calls[0]![0] as string;
    expect(msg).toContain('@gnldev/server@' + MISMATCHED_VERSION);
    expect(msg).toContain('@gnldev/durable@' + OWN_VERSION);
    expect(msg).toContain('version skew');
  });

  it("mismatched version + onMismatch:'throw' → SuiteVersionMismatchError with detail", () => {
    fakeSibling(dir, 'studio', MISMATCHED_VERSION);
    let caught: unknown;
    try {
      assertSuiteConsistent({ packages: ['studio'], fromDir: dir, onMismatch: 'throw' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SuiteVersionMismatchError);
    const err = caught as InstanceType<typeof SuiteVersionMismatchError>;
    expect(err.detail.durableVersion).toBe(OWN_VERSION);
    expect(err.detail.mismatches).toEqual([{ pkg: '@gnldev/studio', version: MISMATCHED_VERSION }]);
  });

  it('an uninstalled sibling package is silently skipped (no warn, no throw)', () => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() =>
      assertSuiteConsistent({ packages: ['this-package-does-not-exist-in-the-fake-dir'], fromDir: dir, onMismatch: 'throw' }),
    ).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('multiple mismatches are all listed in a single warning', () => {
    fakeSibling(dir, 'rag', MISMATCHED_VERSION);
    fakeSibling(dir, 'evals', MISMATCHED_VERSION);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    assertSuiteConsistent({ packages: ['rag', 'evals'], fromDir: dir });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = warnSpy.mock.calls[0]![0] as string;
    expect(msg).toContain('@gnldev/rag@' + MISMATCHED_VERSION);
    expect(msg).toContain('@gnldev/evals@' + MISMATCHED_VERSION);
  });

  it('default `packages` list is the documented common suite (memory/server/studio/rag/workflow/evals/processors/mcp/auth) — none installed here → silent', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'gnl-suite-consistency-empty-'));
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => assertSuiteConsistent({ fromDir: emptyDir })).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
    rmSync(emptyDir, { recursive: true, force: true });
  });
});
