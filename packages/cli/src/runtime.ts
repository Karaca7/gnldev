// Runtime resolver: @gnldev/cli ships with ~zero hard runtime dependencies. Commands (`gnl runs`,
// `gnl dev`, …) resolve @gnldev/durable/server/studio/memory/auth and hono/@hono/node-server from the
// PROJECT's own node_modules, not the CLI's — `npx @gnldev/cli init` doesn't pull in the whole runtime,
// and commands always run against the project's installed version (no CLI ↔ project version conflict).
//
// Resolution root: the directory gnl.config lives in (projectDirOf). This follows Node's OWN module
// resolution algorithm (createRequire + require.resolve) — the SAME node_modules upward-directory walk
// that the `import '@gnldev/durable'` line inside gnl.config.ts would follow — so both loadConfig's dynamic
// import of gnl.config.ts AND loadDurable(dir) land on the SAME resolved file (the same file:// URL),
// and Node's ESM module cache (keyed by resolved URL) returns the SAME module instance to both. This is
// correctness-critical: if a journal object is built with the project's `@gnldev/durable`, the functions
// operating on it (forkRun/reconstructState/…) must come from the SAME instance — two different
// @gnldev/durable copies make the same journal transactionally incompatible with each other.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

// `import type` — gives full type checking at compile time, erased by tsc → NOT a runtime
// dependency (these packages stay in @gnldev/cli's peerDependencies + devDependencies).
import type * as Durable from '@gnldev/durable';
import type * as Server from '@gnldev/server';
import type * as Studio from '@gnldev/studio';
import type * as StudioAi from '@gnldev/studio/ai';
import type * as Memory from '@gnldev/memory';
import type * as Auth from '@gnldev/auth';
import type * as HonoNs from 'hono';
import type * as NodeServer from '@hono/node-server';

/** The directory gnl.config lives in = the resolution root (`dirname(resolve(configPath))`). */
export function projectDirOf(configPath: string): string {
  return dirname(resolve(configPath));
}

/** Resolves `spec` from `projectDir` (require.resolve semantics) + the actual imported module. */
async function resolveModuleFromProject(spec: string, projectDir: string): Promise<{ mod: Record<string, unknown>; resolvedFile: string }> {
  const req = createRequire(join(projectDir, 'noop.js'));
  let resolved: string;
  try {
    resolved = req.resolve(spec);
  } catch {
    throw new Error(
      `gnl: couldn't resolve '${spec}' from ${projectDir} — run this inside a gnl project that has it installed (e.g. \`npm i ${spec}\`).`,
    );
  }
  const mod = (await import(pathToFileURL(resolved).href)) as Record<string, unknown>;
  return { mod, resolvedFile: resolved };
}

/**
 * Resolves `spec` from `projectDir`'s node_modules + dynamically imports it (NOT from @gnldev/cli's OWN
 * dependencies). Throws a clear, actionable error if it can't be found.
 */
export async function resolveFromProject(spec: string, projectDir: string): Promise<unknown> {
  return (await resolveModuleFromProject(spec, projectDir)).mod;
}

// -- Compatibility guard (shape/capability + version) ----------------------------------------------
// Once the CLI resolves its runtime from the project, it can be OLDER/INCOMPATIBLE with what the core
// CLI expects (e.g. a new CLI + an old @gnldev/durable → an export the CLI calls doesn't exist → a bare
// "X is not a function" TypeError). We turn this into a clear error: (1) SHAPE check — do the exports
// the CLI ACTUALLY calls exist as functions on the module (version-independent, catches both
// directions: the old core is missing an export, OR the new core removed one); (2) VERSION check — if
// the version in package.json is below the CLI's minimum, a clear "upgrade" message. Zero-dep: no
// semver package, a manual major.minor.patch comparison (prerelease/build metadata is ignored).

export const REQUIRED_DURABLE_EXPORTS = [
  'forkRun',
  'reconstructState',
  'toJournal',
  'getRunCost',
  'summarizeRun',
  'sweepRuns',
  'purgeRun',
  'resumeRun',
  'createGnl',
  'resolveModel',
  'withModelFallback',
] as const;
export const REQUIRED_SERVER_EXPORTS = ['createRestApi'] as const;
export const REQUIRED_STUDIO_EXPORTS = ['createStudioApp', 'createStudioRunner'] as const;

// Every package is still at 0.0.0 (pre-release) — the floor is '0.0.0' for now to avoid false
// positives. Once published (first real minor/major), bump these to the actual minimum version the
// CLI needs; the mechanism (assertCompatible/gte) is already in place and tested.
const MIN_DURABLE = '0.0.0';
const MIN_SERVER = '0.0.0';
const MIN_STUDIO = '0.0.0';

/** Zero-dep semver `>=`: numerically compares only major.minor.patch; prerelease/build is ignored. */
export function gte(version: string, min: string): boolean {
  const parse = (v: string): [number, number, number] => {
    const core = v.split('-')[0]!.split('+')[0]!;
    const [maj, min_, pat] = core.split('.');
    return [Number(maj) || 0, Number(min_) || 0, Number(pat) || 0];
  };
  const [va, vb, vc] = parse(version);
  const [ma, mb, mc] = parse(min);
  if (va !== ma) return va > ma;
  if (vb !== mb) return vb > mb;
  return vc >= mc;
}

/** Walks up from `resolvedEntryFile` looking for the package.json with `name === pkgName`
 *  (the package root — node_modules/<pkgName>/package.json). '0.0.0' if not found (unresolved version
 *  is treated as "don't know", not as a hard failure — the capability check still guards correctness). */
function findPackageVersion(resolvedEntryFile: string, pkgName: string): string {
  let dir = dirname(resolvedEntryFile);
  for (let i = 0; i < 8; i++) {
    const pj = join(dir, 'package.json');
    if (existsSync(pj)) {
      try {
        const json = JSON.parse(readFileSync(pj, 'utf8')) as { name?: string; version?: string };
        if (json.name === pkgName) return json.version ?? '0.0.0';
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

/**
 * Throws a clear, actionable error if `mod` (already-imported) is version-too-old or missing an
 * export the CLI actually calls. Exported for direct unit testing (see runtime.test.ts).
 */
export function assertCompatible(
  mod: Record<string, unknown>,
  spec: string,
  projectDir: string,
  resolvedFile: string,
  required: readonly string[],
  minVersion: string,
): void {
  const version = findPackageVersion(resolvedFile, spec);
  if (!gte(version, minVersion)) {
    throw new Error(
      `gnl CLI needs ${spec} >= ${minVersion}, but this project (${projectDir}) has ${version} — upgrade with \`npm i ${spec}@latest\`.`,
    );
  }
  const missing = required.filter((name) => typeof mod[name] !== 'function');
  if (missing.length > 0) {
    throw new Error(
      `gnl: the ${spec} in this project (v${version}) is missing: ${missing.join(', ')} — it's incompatible with this gnl CLI (needs >= ${minVersion}). Upgrade with \`npm i ${spec}@latest\`, or use a matching gnl CLI version.`,
    );
  }
}

/** The project's @gnldev/durable — forkRun/reconstructState/toJournal/getRunCost/summarizeRun/sweepRuns/… */
export async function loadDurable(projectDir: string): Promise<typeof Durable> {
  const { mod, resolvedFile } = await resolveModuleFromProject('@gnldev/durable', projectDir);
  assertCompatible(mod, '@gnldev/durable', projectDir, resolvedFile, REQUIRED_DURABLE_EXPORTS, MIN_DURABLE);
  return mod as unknown as typeof Durable;
}

/** The project's @gnldev/server — createRestApi. */
export async function loadServer(projectDir: string): Promise<typeof Server> {
  const { mod, resolvedFile } = await resolveModuleFromProject('@gnldev/server', projectDir);
  assertCompatible(mod, '@gnldev/server', projectDir, resolvedFile, REQUIRED_SERVER_EXPORTS, MIN_SERVER);
  return mod as unknown as typeof Server;
}

/** The project's @gnldev/studio — createStudioApp/createStudioRunner. */
export async function loadStudio(projectDir: string): Promise<typeof Studio> {
  const { mod, resolvedFile } = await resolveModuleFromProject('@gnldev/studio', projectDir);
  assertCompatible(mod, '@gnldev/studio', projectDir, resolvedFile, REQUIRED_STUDIO_EXPORTS, MIN_STUDIO);
  return mod as unknown as typeof Studio;
}

/** The project's @gnldev/studio/ai — aiToolSchema. */
export async function loadStudioAi(projectDir: string): Promise<typeof StudioAi> {
  return (await resolveFromProject('@gnldev/studio/ai', projectDir)) as typeof StudioAi;
}

/** The project's @gnldev/memory — memoryPreset (default dev studio/playground memory, optional). */
export async function loadMemory(projectDir: string): Promise<typeof Memory> {
  return (await resolveFromProject('@gnldev/memory', projectDir)) as typeof Memory;
}

/** The project's @gnldev/auth — roleAuth (opt-in role-based REST + Studio auth). */
export async function loadAuth(projectDir: string): Promise<typeof Auth> {
  return (await resolveFromProject('@gnldev/auth', projectDir)) as typeof Auth;
}

/** The project's hono — Hono (dev server app body). */
export async function loadHono(projectDir: string): Promise<typeof HonoNs> {
  return (await resolveFromProject('hono', projectDir)) as typeof HonoNs;
}

/** The project's @hono/node-server — serve (Node HTTP boot). */
export async function loadNodeServer(projectDir: string): Promise<typeof NodeServer> {
  return (await resolveFromProject('@hono/node-server', projectDir)) as typeof NodeServer;
}
