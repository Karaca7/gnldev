// Starter scaffold. Two modes:
//   • static template  — copies templates/minimal|full verbatim (create-gnl + `gnl init --template`).
//   • feature compose  — copies templates/minimal as the base, drops in the chosen feature recipes
//                         (src files + package.json deps) and GENERATES a decoupled gnl.config.ts that
//                         Wires them together (`gnl init` interactive checkbox / `--features a,b,c`).
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { RECIPES, FEATURE_IDS, E2E_FEATURE, type Recipe } from './recipes.js';
import { hostById, APP_FILE, hostReadme } from './hosts.js';

const here = dirname(fileURLToPath(import.meta.url));

export type TemplateName = 'minimal' | 'full';
export const TEMPLATES: readonly TemplateName[] = ['minimal', 'full'] as const;

/** templates/<name> — reachable via '..' from both dist and src (test) (at the package root). */
function templatesDir(name: string): string {
  return resolve(here, '..', 'templates', name);
}

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, base));
    else out.push(full.slice(base.length + 1));
  }
  return out;
}

export interface ScaffoldOptions {
  /** Project name in package.json (default: target dir name). */
  name?: string;
  /** Which starter to copy (default: 'minimal'). Ignored when `features` is given. */
  template?: TemplateName;
  /** Compose a project from these feature ids (from recipes.ts + 'e2e'). Overrides `template`. */
  features?: string[];
  /** Add an end-to-end durability test (always on for 'full'; opt-in for 'minimal' / feature compose). */
  e2e?: boolean;
  /**
   * Which HTTP server this project will run on — writes `src/app.ts` + `src/server.ts` and adds the
   * Framework's dependency. Omitted means no server entry, which is the old behaviour: fine while
   * `gnl dev` is serving, and nothing to deploy the day you want to.
   */
  host?: string;
}

export interface ScaffoldResult {
  dir: string;
  files: string[];
  /** 'minimal' | 'full' for the static path; 'custom' for feature composition. */
  template: TemplateName | 'custom';
  /** The composed feature ids (only for the custom path). */
  features?: string[];
}

/**
 * Writes the two-file server half: `src/app.ts` (no server attached) and `src/server.ts` (the chosen
 * One), plus the framework dependency and a `start` script.
 *
 * Two files rather than one because the choice must not reach everywhere: the edge targets and the
 * Managed runtime consume `app.ts` and never see `server.ts`. Keeping them apart is what lets the
 * Question be answered honestly.
 */
function addHost(dir: string, hostId: string): void {
  const host = hostById(hostId);
  if (!host) throw new Error(`gnl: unknown host: ${hostId}`);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'app.ts'), APP_FILE);
  writeFileSync(join(dir, 'src', 'server.ts'), host.server);
  patchPkg(dir, (pkg) => {
    pkg.dependencies = { ...pkg.dependencies, ...(host.deps ?? {}) };
    // `@types/node` for every host: the server entry reads process.env and imports node: builtins,
    // Neither of which the base template ever did.
    pkg.devDependencies = { ...pkg.devDependencies, '@types/node': '^22.0.0', ...(host.devDeps ?? {}) };
    pkg.scripts = { ...pkg.scripts, start: 'tsx src/server.ts' };
  });
  const readme = join(dir, 'README.md');
  if (existsSync(readme)) writeFileSync(readme, readFileSync(readme, 'utf8').trimEnd() + '\n' + hostReadme(host));
}

/** Reads, mutates, and writes back a project's package.json. */
function patchPkg(dir: string, fn: (pkg: any) => void): void {
  const p = join(dir, 'package.json');
  const pkg = JSON.parse(readFileSync(p, 'utf8'));
  fn(pkg);
  writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
}

/** Adds vitest + a `test` script + an e2e test to a scaffolded project (test source chosen by caller). */
function addE2e(dir: string, testSrcDir: string): void {
  cpSync(join(testSrcDir, 'test'), join(dir, 'test'), { recursive: true });
  cpSync(join(templatesDir('_e2e'), 'vitest.config.ts'), join(dir, 'vitest.config.ts')); // self-contained test config
  patchPkg(dir, (pkg) => {
    pkg.scripts = { ...pkg.scripts, test: 'vitest run' };
    pkg.devDependencies = { ...pkg.devDependencies, vitest: '^3.0.0' };
  });
}

/**
 * The version range a scaffolded project pins the framework to: the CLI's OWN version, read at
 * Runtime. The templates and recipes used to hardcode '^0.1.0' — the packages move in lockstep
 * (VERSIONING.md), so on the first minor bump every scaffold would have installed 0.1.x while the
 * CLI that created it was 0.2.0: exactly the mixed install lockstep exists to prevent, invisible to
 * check-versions because these manifests live INSIDE the cli package. The comment two functions down
 * records the same bug in its '^0.0.0' incarnation; the mechanism, not another comment, is the fix.
 */
function frameworkRange(): string {
  const require = createRequire(import.meta.url);
  const { version } = require('../package.json') as { version: string };
  return `^${version}`;
}

/** cpSync a template into an EMPTY targetDir + gitignore→.gitignore + fill the project-name placeholder. */
function copyTemplate(dir: string, template: TemplateName, name: string): void {
  const src = templatesDir(template);
  if (!existsSync(src)) throw new Error(`gnl: template not found: ${src}`);
  cpSync(src, dir, { recursive: true });

  // Npm tarballs drop .gitignore → the template keeps it as 'gitignore', converted to .gitignore on copy.
  const gi = join(dir, 'gitignore');
  if (existsSync(gi)) renameSync(gi, join(dir, '.gitignore'));

  // Project name placeholder (in text files).
  for (const rel of ['package.json', 'README.md']) {
    const p = join(dir, rel);
    if (existsSync(p)) writeFileSync(p, readFileSync(p, 'utf8').replaceAll('__PROJECT_NAME__', name));
  }

  // Every @gnldev range in the template is re-stamped to the CLI's own version — the literal values
  // In the template files are placeholders, not truth (see frameworkRange).
  const pkgPath = join(dir, 'package.json');
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const range = frameworkRange();
    for (const field of ['dependencies', 'devDependencies'] as const) {
      for (const dep of Object.keys(pkg[field] ?? {})) {
        if (dep.startsWith('@gnldev/')) pkg[field][dep] = range;
      }
    }
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  }
}

/** Builds a decoupled gnl.config.ts from a set of code recipes (imports only from the project runtime). */
export function generateConfig(recipes: Recipe[]): string {
  const imports = recipes.map((r) => r.wiring.import);
  const agentTools = recipes.filter((r) => r.wiring.place === 'agentTool').map((r) => r.wiring.code);
  const configFields = recipes.filter((r) => r.wiring.place === 'configField').map((r) => r.wiring.code);
  const typeExts = recipes.map((r) => r.configTypeExt).filter((t): t is string => !!t);

  const agentsLine = agentTools.length
    ? `  agents: { assistant: { ...assistant, tools: { ${agentTools.join(', ')} } } },`
    : '  agents: { assistant },';
  const fieldLines = configFields.map((c) => `  ${c},`);
  const satisfies =
    'CreateGnlConfig & { port?: number; studio?: boolean }' + typeExts.map((t) => ` & ${t}`).join('');

  return [
    "import { SqliteStorage } from '@gnldev/durable/sqlite';",
    "import type { CreateGnlConfig } from '@gnldev/durable';",
    "import { assistant } from './src/model.js';",
    ...imports,
    '',
    '// Generated by `gnl init` — decoupled config: imports only from the project runtime (@gnldev/durable),',
    '// never from the `gnl` CLI. `gnl dev` → REST API + Studio Playground on one port; `gnl studio` → inspector.',
    'export default {',
    "  storage: new SqliteStorage('runs.db'),",
    agentsLine,
    ...fieldLines,
    '  port: 3000,',
    '  studio: true,',
    `} satisfies ${satisfies};`,
    '',
  ].join('\n');
}

/** Composes templates/minimal + feature recipes + a generated gnl.config.ts. */
function scaffoldFeatures(dir: string, name: string, features: string[], forceE2e: boolean): ScaffoldResult {
  const unknown = features.filter((f) => !FEATURE_IDS.includes(f));
  if (unknown.length) {
    throw new Error(`gnl: unknown feature(s): ${unknown.join(', ')} (valid: ${FEATURE_IDS.join(', ')})`);
  }
  // Preserve recipe order (idempotency-tool first, …) regardless of input order → stable config output.
  const codeFeatures = FEATURE_IDS.filter((f) => f !== E2E_FEATURE && features.includes(f));
  const wantE2e = forceE2e || features.includes(E2E_FEATURE);

  mkdirSync(dir, { recursive: true });
  copyTemplate(dir, 'minimal', name);

  const recipes = codeFeatures.map((f) => RECIPES[f]!);

  // Write each recipe's src file + collect its dependency.
  const deps: Record<string, string> = {};
  for (const r of recipes) {
    const target = join(dir, r.file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, r.contents);
    // The CLI's own version, not a literal — the literal version of this line has been wrong twice
    // ('^0.0.0', then '^0.1.0' about to be wrong at the first minor bump). See frameworkRange.
    if (r.dep) deps[r.dep] = frameworkRange();
  }

  // Merge new deps into package.json (skips any already present from the base template).
  if (Object.keys(deps).length) {
    patchPkg(dir, (pkg) => {
      pkg.dependencies = { ...pkg.dependencies, ...deps };
    });
  }

  // Generate the wired-together gnl.config.ts (overwrites the base minimal one).
  writeFileSync(join(dir, 'gnl.config.ts'), generateConfig(recipes));

  // E2e: idempotency-tool selected → the idempotency e2e (imports ../src/tools.js); else the replay test.
  if (wantE2e) {
    const testSrc = codeFeatures.includes('idempotency-tool') ? templatesDir('full') : templatesDir('_e2e');
    addE2e(dir, testSrc);
  }

  return { dir, files: listFiles(dir).sort(), template: 'custom', features: codeFeatures.concat(wantE2e ? [E2E_FEATURE] : []) };
}

/**
 * Scaffold a new project.
 * `features` given  → compose templates/minimal + those recipes + a generated gnl.config.ts.
 * otherwise         → copy templates/<template> verbatim (minimal|full), optionally add the e2e test.
 */
export function scaffold(targetDir: string, opts: ScaffoldOptions = {}): ScaffoldResult {
  const dir = resolve(targetDir);
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`gnl: target directory is not empty: ${dir}`);
  const name = opts.name ?? basename(dir);

  if (opts.features && opts.features.length) {
    const res = scaffoldFeatures(dir, name, opts.features, !!opts.e2e);
    if (opts.host) { addHost(dir, opts.host); return { ...res, files: listFiles(dir).sort() }; }
    return res;
  }

  const template: TemplateName = opts.template ?? 'minimal';
  if (!TEMPLATES.includes(template)) throw new Error(`gnl: unknown template '${template}' (expected: ${TEMPLATES.join(' | ')})`);
  mkdirSync(dir, { recursive: true });
  copyTemplate(dir, template, name);

  // 'full' ships with an e2e test already; for 'minimal', add it on request.
  if (opts.e2e && template !== 'full') addE2e(dir, templatesDir('_e2e'));
  if (opts.host) addHost(dir, opts.host);

  return { dir, files: listFiles(dir).sort(), template };
}
