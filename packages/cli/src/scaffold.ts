// Starter scaffold. Two modes:
//   • static template  — copies templates/minimal verbatim (create-gnl + `gnl init --template`).
//   • feature compose  — copies templates/minimal as the base, drops in the chosen feature recipes
//                         (src files + package.json deps) and GENERATES a decoupled gnl.config.ts that
//                         wires them together (`gnl init` interactive checkbox / `--features a,b,c`).
//
// THERE USED TO BE A SECOND TEMPLATE. `templates/full` was a whole parallel project — its own
// package.json, README, tsconfig, gitignore and gnl.config.ts — that existed to add ONE tool and ONE
// test on top of the first one. Every fix to the shared five files had to be made twice, and the
// second copy is the one that was forgotten: the mangled `// IdempotencyWindow:` line, the `.env`
// entry an assertion only covered for `minimal`, the v4 finish-reason shape. A template matrix costs
// its own maintenance forever and buys a starting point once.
//
// So `full` is now an ALIAS for the composition that produces the same project — see
// RETIRED_TEMPLATES. The two files that were genuinely its own (the tool-calling mock model and the
// idempotency e2e) moved to `templates/_idempotency`, which is not a template at all: it is the
// idempotency recipe's other half, copied in only when that feature is chosen.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { RECIPES, FEATURE_IDS, E2E_FEATURE, recipeContents, type Recipe } from './recipes.js';
import { DEFAULT_ANSWERS, type InitAnswers } from './init-answers.js';
import { IDENTITY_FILE } from './identity-file.js';
import { hostById, APP_FILE, hostReadme } from './hosts.js';

const here = dirname(fileURLToPath(import.meta.url));

export type TemplateName = 'minimal';
export const TEMPLATES: readonly TemplateName[] = ['minimal'] as const;

/**
 * Template names that no longer name a directory, and the feature set each one now means.
 *
 * Kept as an alias rather than removed outright because the name is in READMEs, in tutorials nobody
 * controls, and in the muscle memory of anyone who used it — and the composition genuinely produces
 * the same project, so there is nothing to warn about beyond the new spelling. One line on screen,
 * the project people expected, and a name that stops being special.
 */
export const RETIRED_TEMPLATES: Record<string, readonly string[]> = {
  full: ['idempotency-tool', 'e2e'],
};

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
  /** Which starter to copy (default: 'minimal'). Ignored when `features` is given.
   *  A retired name (see RETIRED_TEMPLATES) is accepted and resolves to its feature set. */
  template?: TemplateName | keyof typeof RETIRED_TEMPLATES;
  /** Compose a project from these feature ids (from recipes.ts + 'e2e'). Overrides `template`. */
  features?: string[];
  /**
   * What `gnl init` was told (see init-answers.ts). Present → the GENERATED config path is taken even
   * with no features, because a copied template cannot carry an answer without being rewritten.
   */
  answers?: InitAnswers;
  /** Add an end-to-end durability test (opt-in for 'minimal' / feature compose). */
  e2e?: boolean;
  /**
   * Which HTTP server this project will run on — writes `src/app.ts` + `src/server.ts` and adds the
   * framework's dependency. Omitted means no server entry, which is the old behaviour: fine while
   * `gnl dev` is serving, and nothing to deploy the day you want to.
   */
  host?: string;
}

export interface ScaffoldResult {
  dir: string;
  files: string[];
  /** 'minimal' for the static path; 'custom' for feature composition (including a retired alias). */
  template: TemplateName | 'custom';
  /** The composed feature ids (only for the custom path). */
  features?: string[];
  /** Set when a retired template name was asked for — the caller says so in one line. */
  aliasedFrom?: string;
}

/**
 * Writes the two-file server half: `src/app.ts` (no server attached) and `src/server.ts` (the chosen
 * one), plus the framework dependency and a `start` script.
 *
 * Two files rather than one because the choice must not reach everywhere: the edge targets and the
 * managed runtime consume `app.ts` and never see `server.ts`. Keeping them apart is what lets the
 * question be answered honestly.
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
    // neither of which the base template ever did.
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
  cpSync(join(testSrcDir, 'test'), join(dir, 'test'), { recursive: true, filter: notBuildDebris });
  cpSync(join(templatesDir('_e2e'), 'vitest.config.ts'), join(dir, 'vitest.config.ts')); // self-contained test config
  patchPkg(dir, (pkg) => {
    pkg.scripts = { ...pkg.scripts, test: 'vitest run' };
    pkg.devDependencies = { ...pkg.devDependencies, vitest: '^3.0.0' };
  });
}

/**
 * The version range a scaffolded project pins the framework to: the CLI's OWN version, read at
 * runtime. The templates and recipes used to hardcode '^0.1.0' — the packages move in lockstep
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

/**
 * Skips anything a template directory accumulates from being USED rather than from being authored.
 *
 * A template directory that the repo's own tests install and run grows a `node_modules/`, and inside
 * it `.vite/vitest/results.json`, a cache of which tests last passed. `cpSync(..., { recursive: true })`
 * copied all of it into every scaffold: a brand new project arrived with a stranger's dependency tree
 * and a test-results cache reporting runs the user never made. (The directory this was measured on was
 * `templates/full`, now retired; the filter guards every copy path, not that one.)
 *
 * The npm `files` list now excludes `templates/**\/node_modules` so the published tarball is clean, but
 * that only fixes the published path. Anyone scaffolding from a source checkout — a contributor, and
 * the repo's own e2e tests — copies straight off disk, which is where the debris actually lives.
 */
function notBuildDebris(src: string): boolean {
  const base = basename(src);
  return base !== 'node_modules' && base !== 'dist' && base !== '.vite' && base !== '.turbo';
}

/** cpSync a template into an EMPTY targetDir + gitignore→.gitignore + fill the project-name placeholder. */
function copyTemplate(dir: string, template: TemplateName, name: string): void {
  const src = templatesDir(template);
  if (!existsSync(src)) throw new Error(`gnl: template not found: ${src}`);
  cpSync(src, dir, { recursive: true, filter: notBuildDebris });

  // npm tarballs drop .gitignore → the template keeps it as 'gitignore', converted to .gitignore on copy.
  const gi = join(dir, 'gitignore');
  if (existsSync(gi)) renameSync(gi, join(dir, '.gitignore'));

  // Project name placeholder (in text files).
  for (const rel of ['package.json', 'README.md']) {
    const p = join(dir, rel);
    if (existsSync(p)) writeFileSync(p, readFileSync(p, 'utf8').replaceAll('__PROJECT_NAME__', name));
  }

  // Every @gnldev range in the template is re-stamped to the CLI's own version — the literal values
  // in the template files are placeholders, not truth (see frameworkRange).
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

/**
 * Builds a decoupled gnl.config.ts from a set of code recipes (imports only from the project runtime),
 * shaped by whatever `gnl init` was told.
 *
 * EVERY ANSWER LANDS HERE AS A LINE, which is the iron rule from init-answers.ts made concrete: three
 * questions, three config lines (plus one NEW file for the end-users case), and no branch anywhere
 * that produces a structurally different project. A future fourth question that cannot be expressed
 * as a line in this function is a question that does not belong in `gnl init`.
 */
export function generateConfig(recipes: Recipe[], answers: InitAnswers = DEFAULT_ANSWERS): string {
  const imports = recipes.map((r) => r.wiring.import);
  const agentTools = recipes.filter((r) => r.wiring.place === 'agentTool').map((r) => r.wiring.code);
  const configFields = recipes.filter((r) => r.wiring.place === 'configField').map((r) => r.wiring.code);
  const typeExts = recipes.map((r) => r.configTypeExt).filter((t): t is string => !!t);

  const agentsLine = agentTools.length
    ? `  agents: { assistant: { ...assistant, tools: { ${agentTools.join(', ')} } } },`
    : '  agents: { assistant },';
  const fieldLines = configFields.map((c) => `  ${c},`);
  // `subjects` is the CLI's own field (GnlDevConfig), not durable's — it declares nothing to the
  // engine and is read by exactly one thing: the protections matrix, which uses it to print an
  // honest `○ identity` instead of the `?` a config that says nothing earns.
  const satisfies =
    "CreateGnlConfig & { port?: number; studio?: boolean; subjects?: 'internal' | 'end-users' }"
    + typeExts.map((t) => ` & ${t}`).join('');
  const endUsers = answers.identity === 'end-users';
  const pg = answers.store === 'pg';

  // The composed config gets the same three explanations the static templates carry. Kept here as
  // well as there because `gnl init` OVERWRITES the copied gnl.config.ts (see scaffoldFeatures), so
  // a user who picked features would otherwise be the only one who never read them — and would be
  // the one most likely to have declared an `effectClass` on a tool that nothing reads.
  const wroteMemory = configFields.includes('memoryFactory');

  return [
    pg
      ? "import { PostgresStorage } from '@gnldev/durable/postgres';"
      : "import { SqliteStorage } from '@gnldev/durable/sqlite';",
    "import type { CreateGnlConfig } from '@gnldev/durable';",
    "import { assistant } from './src/model.js';",
    ...imports,
    '',
    '// Generated by `gnl init` — decoupled config: imports only from the project runtime (@gnldev/durable),',
    '// never from the `gnl` CLI. `gnl dev` → REST API + Studio Playground on one port; `gnl studio` → inspector.',
    'export default {',
    ...(pg
      ? [
        '  // Postgres, because you said the journal lives in one. `DATABASE_URL` is read at startup and',
        '  // is NOT defaulted — a journal that silently falls back to a local file is a journal you',
        '  // discover is empty in production. `pnpm add pg` if it is not installed yet.',
        '  storage: new PostgresStorage({ connectionString: process.env.DATABASE_URL! }),',
      ]
      : ["  storage: new SqliteStorage('runs.db'),"]),
    agentsLine,
    '',
    '  // WHAT A REPEATED SIDE EFFECT SHOULD DO. One switch, because the honest answer depends on whether',
    "  // anyone is there to ask — and a tool's own `effectClass` declaration is read ONLY through this:",
    '  // with no profile, a tool that carefully declared itself `transactional` is treated exactly like',
    '  // one that declared nothing.',
    '  //   assistant — a human is on screen, so a repeat can be turned into a question',
    '  //   headless  — nobody is there to ask, so a repeated payment is refused outright (typed → DLQ)',
    '  //   critical  — the above, plus a run lock, input fingerprinting and tombstones',
    `  preset: '${answers.preset}',`,
    '',
    ...(endUsers
      ? [
        '  // WHO EACH RUN BELONGS TO. You said your users have accounts, so src/identity.ts holds the',
        '  // resolver and the route wiring — read it once: the one wrong answer (take the subject from',
        '  // the request body) is the hole the engine\'s context seal exists to close.',
        "  subjects: 'end-users',",
      ]
      : [
        '  // NOBODY IN PARTICULAR. You said this is an internal tool, so runs are born without an owner',
        '  // and the ownership gates have nothing to compare against — they refuse nobody. That is a',
        '  // position, not an oversight, and the protections matrix prints it as one (`○ identity`).',
        '  // The day real users arrive: write src/identity.ts (docs/QUICKSTART-PROTECTED.md has the',
        "  // skeleton), wire it into your route, and change this to 'end-users'.",
        "  subjects: 'internal',",
      ]),
    ...(wroteMemory
      ? []
      : [
        '',
        '  // CONVERSATION MEMORY, and the asymmetry it closes. `gnl dev` DERIVES a memory store from',
        '  // `storage` so the Playground has threads; `src/app.ts` — the file you deploy — does not. So',
        '  // conversations remember on your machine and quietly forget in production. `gnl add memory`',
        '  // writes src/memory.ts; then import it above and uncomment this line.',
        '  // memoryFactory,',
      ]),
    ...(fieldLines.length ? ['', ...fieldLines] : []),
    '',
    '  // RETENTION is not scheduled by anything here, deliberately. Runs stay — and a run holds the',
    '  // prompt it was given — until something sweeps them: `gnl sweep --older-than 30d` from cron or',
    '  // your scheduler, or `sweepRuns(storage.runs, { olderThanMs: 30 * 864e5 })` in your own job. One',
    '  // person\'s data is erased with `purgeResource`, not by waiting.',
    ...(endUsers
      ? [
        '  //   const onAccountDeleted = (userId: string) => purgeResource(storage, userId);',
        '  // — that one is not retention, it is erasure, and it is the request you have to answer in',
        '  // days rather than by waiting for a sweep.',
      ]
      : []),
    '',
    '  port: 3000,',
    '  studio: true,',
    `} satisfies ${satisfies};`,
    '',
  ].join('\n');
}

/** Composes templates/minimal + feature recipes + a generated gnl.config.ts, shaped by the answers. */
function scaffoldFeatures(dir: string, name: string, features: string[], forceE2e: boolean, answers: InitAnswers): ScaffoldResult {
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
    writeFileSync(target, recipeContents(r));
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
  writeFileSync(join(dir, 'gnl.config.ts'), generateConfig(recipes, answers));

  // The identity answer's other half: a NEW file, never an edit to an existing one (the iron rule —
  // see init-answers.ts). `src/app.ts` is left exactly as the host recipe wrote it; the wiring line
  // that connects the two is documented at the bottom of the file being written here.
  if (answers.identity === 'end-users') {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'identity.ts'), IDENTITY_FILE);
  }

  // THE CHARGE TOOL NEEDS A MODEL THAT CALLS IT. The base template's mock echoes text and never emits
  // a tool call — correct for a starter with no tools, and useless for the one feature that exists to
  // be watched happening. `--template full` shipped a tool-calling mock instead, and dropping it while
  // keeping the tool would have made the alias a quieter project than the template it replaces: the
  // Playground would answer "echo: charge order-1" and the ledger would stay empty.
  //
  // This is the ONE place a recipe replaces a file the base template wrote, and it is allowed here for
  // a reason that does not generalise: `src/model.ts` at this moment is generated code in an empty
  // directory, not a file anyone has touched. `gnl add idempotency-tool` deliberately does NOT do this
  // — there the file is the user's.
  if (codeFeatures.includes('idempotency-tool')) {
    cpSync(join(templatesDir('_idempotency'), 'src', 'model.ts'), join(dir, 'src', 'model.ts'));
  }

  // e2e: idempotency-tool selected → the idempotency e2e (imports ../src/tools.js); else the replay test.
  if (wantE2e) {
    const testSrc = codeFeatures.includes('idempotency-tool') ? templatesDir('_idempotency') : templatesDir('_e2e');
    addE2e(dir, testSrc);
  }

  return { dir, files: listFiles(dir).sort(), template: 'custom', features: codeFeatures.concat(wantE2e ? [E2E_FEATURE] : []) };
}

/**
 * Scaffold a new project.
 * `features` given  → compose templates/minimal + those recipes + a generated gnl.config.ts.
 * a retired name    → the same compose path, with the feature set that name used to mean.
 * otherwise         → copy templates/minimal verbatim, optionally add the e2e test.
 */
export function scaffold(targetDir: string, opts: ScaffoldOptions = {}): ScaffoldResult {
  const dir = resolve(targetDir);
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`gnl: target directory is not empty: ${dir}`);
  const name = opts.name ?? basename(dir);

  const answers = opts.answers ?? DEFAULT_ANSWERS;
  const compose = (features: readonly string[], aliasedFrom?: string): ScaffoldResult => {
    const res = scaffoldFeatures(dir, name, [...features], !!opts.e2e, answers);
    if (opts.host) addHost(dir, opts.host);
    return { ...res, files: listFiles(dir).sort(), ...(aliasedFrom ? { aliasedFrom } : {}) };
  };

  if (opts.features && opts.features.length) return compose(opts.features);

  // A retired name resolves BEFORE the answers check below, or `--template full` with answers (which
  // is every interactive run, since init always has answers) would silently drop its feature set.
  const retired = opts.template ? RETIRED_TEMPLATES[opts.template] : undefined;
  if (retired) return compose(retired, opts.template);

  // Validated HERE, above the answers branch, so a typo cannot slip past it into a composed project
  // that quietly ignored the flag. `--template nope` has to fail on every path, not just the one that
  // happens to look the name up in a directory.
  const named = (opts.template ?? 'minimal') as TemplateName;
  if (!TEMPLATES.includes(named)) {
    throw new Error(
      `gnl: unknown template '${named}' (expected: ${TEMPLATES.join(' | ')}${
        Object.keys(RETIRED_TEMPLATES).length ? `, or the retired ${Object.keys(RETIRED_TEMPLATES).join('/')}` : ''
      })`,
    );
  }

  // ANSWERS TAKE THE COMPOSE PATH, even with no features at all.
  //
  // The static path copies `templates/minimal/gnl.config.ts` verbatim, and that file is a fixed text
  // carrying `preset: 'assistant'` and a sqlite storage. Making the answers land there would mean
  // rewriting lines inside a copied file — three answers editing one template is the matrix the iron
  // rule exists to prevent, in the file most likely to be read. `generateConfig` already builds the
  // whole config from parts, so an answered init composes from zero features and gets its lines
  // written rather than patched in.
  if (opts.answers) return compose([]);

  mkdirSync(dir, { recursive: true });
  copyTemplate(dir, named, name);

  if (opts.e2e) addE2e(dir, templatesDir('_e2e'));
  if (opts.host) addHost(dir, opts.host);

  return { dir, files: listFiles(dir).sort(), template: named };
}
