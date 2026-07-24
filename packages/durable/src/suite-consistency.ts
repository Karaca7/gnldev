// İŞ 3 — suite-consistency guard: packages/cli/src/runtime.ts already guards CLI↔runtime compatibility
// (the CLI's own minimum version requirement against the PROJECT's installed @gnl/durable). But a
// project can bypass its package manager's caret (^) range entirely — `--force`, dependency
// `overrides`, or hand-edited node_modules — and end up with a SIBLING @gnl/* suite that is internally
// INCOMPATIBLE (e.g. @gnl/durable@0.2.0 next to @gnl/memory@0.1.0), with no version-range mechanism to
// stop it. That kind of skew fails SILENTLY at runtime (a stale export shape, a changed journal record
// contract) rather than at install time. This module is an OPT-IN runtime check that closes that gap:
// compare every installed sibling package's version against @gnl/durable's OWN version and surface any
// difference loudly (warn or throw) instead of letting it fail mysteriously later.
//
// Zero-dep: no semver package — plain major.minor.patch parsing, same style as
// packages/cli/src/runtime.ts's `gte()` (prerelease/build metadata ignored).
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { SuiteVersionMismatchError } from './errors.js';

/** The common suite packages checked when `packages` isn't given. Short names (WITHOUT the '@gnl/'
 *  prefix) — resolved as `@gnl/<name>`. A package that doesn't resolve (not installed in this project)
 *  is silently skipped — this guard only checks packages that are actually part of the running suite. */
const DEFAULT_SIBLINGS = ['memory', 'server', 'studio', 'rag', 'workflow', 'evals', 'processors', 'mcp', 'auth'] as const;

/** Zero-dep parse: major.minor.patch only (prerelease/build metadata after `-`/`+` is ignored) — same
 *  parsing style as packages/cli/src/runtime.ts's `gte()`. */
function parseCore(v: string): [number, number, number] {
  const core = v.split('-')[0]!.split('+')[0]!;
  const [maj, min, pat] = core.split('.');
  return [Number(maj) || 0, Number(min) || 0, Number(pat) || 0];
}

/**
 * Pure, zero-dep version equality — major.minor.patch only (prerelease/build metadata ignored, e.g.
 * `1.2.3` and `1.2.3+build5` are equal). Exported for direct unit testing (see
 * suite-consistency.test.ts) independent of any filesystem/require.resolve setup. Unlike
 * cli/runtime.ts's `gte()` (a MINIMUM-version floor: "at least this new"), a co-versioned suite cares
 * about ANY drift — older OR newer siblings are both a skew signal — so this is equality, not `>=`.
 */
export function versionsEqual(a: string, b: string): boolean {
  const [a1, a2, a3] = parseCore(a);
  const [b1, b2, b3] = parseCore(b);
  return a1 === b1 && a2 === b2 && a3 === b3;
}

/** Reads a package.json's `version` field. '0.0.0' if unreadable/malformed/absent — "don't know" is
 *  treated as a non-failure (mirrors cli/runtime.ts findPackageVersion's philosophy: false positives
 *  are worse than a missed check). */
function readVersion(pkgJsonPath: string): string {
  try {
    const json = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { version?: string };
    return json.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Walks up from `startDir` looking for the nearest package.json named '@gnl/durable' — this module's
 *  OWN installed version. Works both from `dist/` (published: package.json sits one level above
 *  dist/index.js) and `src/` (dev/tsx: one level above src/*.ts) — the walk (not a fixed relative
 *  path) makes it robust to either layout. '0.0.0' if not found within a few levels. */
function findOwnVersion(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    const pj = join(dir, 'package.json');
    if (existsSync(pj)) {
      try {
        const json = JSON.parse(readFileSync(pj, 'utf8')) as { name?: string; version?: string };
        if (json.name === '@gnl/durable') return json.version ?? '0.0.0';
      } catch {
        // malformed package.json at this level — keep walking up.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '0.0.0';
}

export interface AssertSuiteConsistentOptions {
  /** Sibling @gnl/* short names to check (WITHOUT the '@gnl/' prefix) — default: DEFAULT_SIBLINGS.
   *  Only packages that actually RESOLVE (installed) are checked; the rest are skipped silently. */
  packages?: string[];
  /** 'warn' (default): a single console.warn listing every mismatch, does not throw. 'throw': raises
   *  `SuiteVersionMismatchError` instead (see errors.ts). */
  onMismatch?: 'throw' | 'warn';
  /** Resolution root for `require.resolve('@gnl/<pkg>/package.json', { paths: [fromDir] })` — default
   *  `process.cwd()`. Same purpose as cli/runtime.ts's `projectDir`: points resolution at the actual
   *  project root instead of wherever this code happens to be imported from. */
  fromDir?: string;
}

/**
 * GOREV (İŞ 3, opt-in — see module header): compares every INSTALLED sibling @gnl/* package's version
 * against @gnl/durable's OWN version; if any differ, warns (default) or throws
 * (`onMismatch: 'throw'`) — surfacing a `--force`/overrides-installed incompatible suite instead of
 * letting it fail silently at runtime later.
 *
 * NOTE (pre-release honesty): every @gnl/* package currently ships at `0.0.0` — so this NEVER triggers
 * today (durableVersion === every resolvable sibling's version, always; no false positives). The
 * mechanism is in place and tested; it activates automatically the first time the suite ships real,
 * independent version numbers (same "activates on first real release" note as
 * packages/cli/src/runtime.ts's MIN_DURABLE/MIN_SERVER/MIN_STUDIO header comment).
 */
export function assertSuiteConsistent(opts: AssertSuiteConsistentOptions = {}): void {
  const fromDir = opts.fromDir ?? process.cwd();
  const req = createRequire(join(fromDir, 'noop.js'));
  const durableVersion = findOwnVersion(dirname(fileURLToPath(import.meta.url)));
  const mismatches: { pkg: string; version: string }[] = [];
  for (const short of opts.packages ?? DEFAULT_SIBLINGS) {
    const spec = `@gnl/${short}`;
    let resolved: string;
    try {
      resolved = req.resolve(`${spec}/package.json`);
    } catch {
      continue; // not installed → not part of the running suite, skip silently
    }
    const version = readVersion(resolved);
    if (!versionsEqual(version, durableVersion)) mismatches.push({ pkg: spec, version });
  }
  if (mismatches.length === 0) return;
  const list = mismatches.map((m) => `${m.pkg}@${m.version}`).join(', ');
  const message =
    `@gnl/durable: version skew: ${list} vs @gnl/durable@${durableVersion} — install matching versions ` +
    '(the package manager\'s caret range was likely bypassed — --force / overrides / manual node_modules edits).';
  if (opts.onMismatch === 'throw') {
    throw new SuiteVersionMismatchError(message, { durableVersion, mismatches });
  }
  console.warn(message);
}
