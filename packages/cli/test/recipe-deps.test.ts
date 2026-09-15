// What a recipe WRITES against what a recipe INSTALLS — the gap that only a real install can see.
//
// Two measured failures, one missing function between them:
//
//   `gnl add model openai`  wrote `"@ai-sdk/openai": "^0.1.0"` into package.json. The range came
//   from `frameworkRange()`, which returns the CLI's OWN version — correct for `@gnldev/*`, where
//   the packages move in lockstep, and meaningless for a third-party provider. `^0.1.0` either does
//   not resolve or silently installs a provider generation behind the `ai` the template pins, and
//   the failure arrives at the first model call rather than at install. This is the step the
//   template README itself tells every reader to take to get off the mock model.
//
//   `gnl add otel`  wrote a file importing `piiTextRedactor` from `@gnldev/processors` and declared
//   only `@gnldev/otel`. `Recipe.dep` is singular, so the second import had nowhere to be declared
//   and nobody noticed: the recipe's own file is never compiled in this repo.
//
// Both are the same shape — a dependency the generated TEXT needs and the manifest does not name —
// so the check is on the text, not on a list somebody maintains. Every import in every recipe file
// (including every variant) must be resolvable from what a project would actually have: the base
// template's manifest plus what the recipe installs. A new recipe that imports something new fails
// here, in the repo, instead of in a stranger's `pnpm install`.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { RECIPES, recipeContents, defaultVariants, type Recipe } from '../src/recipes.js';
import { recipeDeps, scaffold } from '../src/scaffold.js';
import { captureLog } from './helpers.js';

const require = createRequire(import.meta.url);
const templatePkg = require('../templates/minimal/package.json') as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};
const durablePkg = require('../../durable/package.json') as {
  peerDependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

/** Everything a scaffolded project has before any recipe runs. */
const BASE_DEPS = new Set([
  ...Object.keys(templatePkg.dependencies),
  ...Object.keys(templatePkg.devDependencies),
]);

/**
 * The package specifiers a file imports, as npm package NAMES.
 *
 * Deliberately regex over the text and not the TypeScript AST: the thing under test is a string in
 * recipes.ts, and parsing it would mean compiling it, which is exactly the step that does not happen
 * anywhere in this repo — the reason both bugs above survived.
 */
function importedPackages(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)) {
    const spec = m[1]!;
    if (spec.startsWith('.') || spec.startsWith('node:')) continue;
    // '@scope/name/sub' → '@scope/name';  'name/sub' → 'name'
    const parts = spec.split('/');
    out.add(spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!);
  }
  return [...out];
}

/** Every text a recipe can produce: its default, plus each variant on its own. */
function everyRendering(r: Recipe): string[] {
  const texts = [recipeContents(r, defaultVariants(r))];
  for (const v of r.variants ?? []) texts.push(recipeContents(r, [v.id]));
  return texts;
}

describe('recipe dependencies match what the recipe writes', () => {
  for (const [id, r] of Object.entries(RECIPES)) {
    it(`${id}: every import is declared`, () => {
      const declared = new Set([...BASE_DEPS, ...Object.keys(recipeDeps(r))]);
      for (const text of everyRendering(r)) {
        for (const pkg of importedPackages(text)) {
          expect(declared, `${id} writes ${r.file} importing '${pkg}'`).toContain(pkg);
        }
      }
    });
  }

  it('a non-@gnldev dependency without its own range is a build error, not a user surprise', () => {
    // The mechanism, stated as a test: lockstep is a property of @gnldev/*, so anything else has to
    // say what it wants. `recipeDeps` throws rather than guessing — a guess is how '^0.1.0' got onto
    // an AI SDK provider in the first place.
    expect(() => recipeDeps({ dep: '@some/third-party' })).toThrow(/depRange/);
    expect(recipeDeps({ dep: '@gnldev/queue' })['@gnldev/queue']).toMatch(/^\^\d+\.\d+\.\d+/);
    expect(recipeDeps({ dep: 'left-pad', depRange: '^1.3.0' })).toEqual({ 'left-pad': '^1.3.0' });
  });

  it('the provider the ENGINE uses is the one a scaffold installs', () => {
    // Only for `@ai-sdk/openai`, because it is the only provider this repo itself depends on. A
    // provider-major bump in @gnldev/durable has to reach the scaffold, or a project resolves two
    // copies. The other providers have no local truth to compare against — see the registry test
    // below, which is the check that actually covers them.
    const engineRange = durablePkg.devDependencies['@ai-sdk/openai'];
    expect(engineRange, '@gnldev/durable must declare @ai-sdk/openai for this check to mean anything').toBeTruthy();
    expect(recipeDeps(RECIPES['model-openai']!)['@ai-sdk/openai']).toBe(engineRange);
  });

  it('the four model recipes do not all share one range — they are different packages', () => {
    // The shape of the bug this replaced: one constant applied to four recipes. `@ai-sdk/openai` is
    // on 4.x and `@ai-sdk/openai-compatible` has never published a 4.x, so any single value is wrong
    // for at least one of them. If this ever collapses back to one number, it is wrong again.
    const ranges = new Set(
      ['model-nvidia', 'model-openai', 'model-anthropic', 'model-openai-compatible']
        .map((id) => Object.entries(recipeDeps(RECIPES[id]!)).find(([d]) => d.startsWith('@ai-sdk/'))![1]),
    );
    expect(ranges.size, 'all four providers carry the same range — that was the bug').toBeGreaterThan(1);
  });
});

describe('a version range is a claim about npm, so npm is asked', () => {
  // THE TEST THAT WOULD HAVE CAUGHT BOTH BUGS, and the one neither earlier version was.
  //
  // `gnl add model openai` shipped `"@ai-sdk/openai": "^0.1.0"` (the CLI's own version), and the fix
  // for it shipped `"@ai-sdk/openai-compatible": "^4.0.0"` (a major that does not exist). Both were
  // reviewed, both had tests, and both tests compared the range to ANOTHER FILE IN THIS REPO —
  // `durable`'s manifest. That comparison can only ever catch drift between two things we control.
  // Neither package appears in this repo's lockfile, so nothing local could know `^4.0.0` resolves
  // to nothing.
  //
  // Hitting the registry in a test is a real cost and it is the right one here: the assertion is
  // literally "a user running `pnpm install` will not get E404", and only npm can answer that.
  // Skipped when the network is unavailable rather than failing — a laptop on a plane should not
  // see a red suite — and the skip is LOUD (the reason names what went unchecked).
  const THIRD_PARTY = ['model-nvidia', 'model-openai', 'model-anthropic', 'model-openai-compatible']
    .flatMap((id) => Object.entries(recipeDeps(RECIPES[id]!)).filter(([d]) => !d.startsWith('@gnldev/')))
    .concat([['pg', JSON.parse(readFileSync(new URL('../../durable/package.json', import.meta.url), 'utf8')).peerDependencies.pg]] as [string, string][]);

  const seen = new Map<string, string>();
  for (const [pkg, range] of THIRD_PARTY) seen.set(pkg, range);

  for (const [pkg, range] of seen) {
    it(`${pkg}@${range} resolves to something that exists`, async (ctx) => {
      const { spawnSync } = await import('node:child_process');
      const res = spawnSync('npm', ['view', pkg, 'versions', '--json'], { encoding: 'utf8', timeout: 10_000 });
      if (res.status !== 0 || !res.stdout) {
        // `ctx.skip()`, not `return`. A `return` makes vitest count this as PASSED, so a CI runner
        // with no registry access would report a green suite in which nothing was actually checked —
        // the precise failure mode this whole file exists to end.
        ctx.skip(`no registry access: ${pkg}@${range} was NOT verified`);
      }
      const versions = JSON.parse(res.stdout) as string[] | string;
      const all = Array.isArray(versions) ? versions : [versions];
      // `^X.Y.Z` on a published major: enough for the failure being guarded against, which is a
      // major that was never published at all. A full semver satisfier here would be a second
      // implementation of something npm already does at install time.
      const wantedMajor = range.replace(/^[\^~]/, '').split('.')[0];
      const majors = new Set(all.map((v) => v.split('.')[0]));
      expect(
        majors.has(wantedMajor),
        `${pkg} has no ${wantedMajor}.x on npm (published majors: ${[...majors].join(', ')}) — `
        + 'a project running `gnl add model …` would get E404 from `pnpm install`',
      ).toBe(true);
    });
  }
});

describe('an answered question does not leave homework', () => {
  it('choosing Postgres installs the driver that choice requires', () => {
    // `pg` is an OPTIONAL peer of @gnldev/durable — right for the engine, wrong for a project that
    // has ALREADY answered "where should the record be kept?". The generated config imports
    // PostgresStorage on its first line, so without this the answer produced a project that could
    // not start, and the error named a package the reader was never asked about.
    const dir = mkdtempSync(join(tmpdir(), 'gnl-pg-'));
    try {
      scaffold(dir, { name: 'pg-proj', answers: { preset: 'assistant', identity: 'internal', store: 'pg', serving: 'dev' } });
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
      expect(pkg.dependencies['pg'], 'a Postgres project must ship the pg driver').toBe(durablePkg.peerDependencies['pg']);
      expect(readFileSync(join(dir, 'gnl.config.ts'), 'utf8')).toContain('PostgresStorage');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the file store answer does not drag a database driver in', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gnl-file-'));
    try {
      scaffold(dir, { name: 'file-proj', answers: { preset: 'assistant', identity: 'internal', store: 'sqlite', serving: 'dev' } });
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
      expect(pkg.dependencies['pg']).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a config written once stays editable', () => {
  it('the satisfies clause admits fields a later `gnl add` will paste in', () => {
    // `gnl add auth` prints an `auth,` line for the reader to paste. If the satisfies clause froze
    // at whatever init happened to pick, that paste is TS2353 in the editor while `tsx` runs it
    // fine — an error that only shows up where nobody is looking. Every recipe's configTypeExt is
    // named up front; they are optional fields, so admitting one the config does not use costs
    // nothing.
    const dir = mkdtempSync(join(tmpdir(), 'gnl-satisfies-'));
    try {
      scaffold(dir, { name: 'plain', answers: { preset: 'assistant', identity: 'internal', store: 'sqlite', serving: 'dev' } });
      const config = readFileSync(join(dir, 'gnl.config.ts'), 'utf8');
      for (const r of Object.values(RECIPES)) {
        if (!r.configTypeExt) continue;
        expect(config, `a project that did not pick ${r.id} still has to accept its config field later`).toContain(r.configTypeExt);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the OTHER install path: an existing project', () => {
  // `gnl init` in a project that already has a package.json never edits that manifest — it prints the
  // `pnpm add` line instead, which makes that line the install. The scaffold path was fixed to ask
  // `recipeDeps`; this one still built its list from `r.dep`, so the same two bugs survived here in
  // full: `gnl init --features otel` wrote a file importing @gnldev/processors and left it out of the
  // line, and `--store pg` wrote a config importing PostgresStorage and left out the driver. The
  // reader's only instruction was incomplete, and nothing failed — there is no manifest to typecheck
  // against, just a person copying a line.
  async function initLines(dir: string, argv: string[]): Promise<string> {
    const { initCommand } = await import('../src/commands/init.js');
    const lines = await captureLog(async () => {
      await initCommand.run({ argv: [dir, ...argv, '--yes'] });
    });
    return lines.join('\n');
  }

  function existingProject(): string {
    const dir = mkdtempSync(join(tmpdir(), 'gnl-existing-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'existing-app', dependencies: { hono: '^4.6.0' } }, null, 2));
    return dir;
  }

  it('names every package the files it just wrote import', async () => {
    const dir = existingProject();
    try {
      const out = await initLines(dir, ['--features', 'otel', '--store', 'pg']);
      const add = out.split('\n').find((l) => l.includes('pnpm add') && !l.includes('-D'))!;
      expect(add, 'the otel recipe imports it — see recipes.ts extraDeps').toContain('@gnldev/processors');
      expect(add, 'the generated config imports PostgresStorage on its first line').toContain('pg');
      expect(add).toContain('@gnldev/otel');
      // and the manifest is still the reader's — this path writes files, never package.json
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
      expect(pkg.dependencies, 'an existing manifest must come back untouched').toEqual({ hono: '^4.6.0' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not name a database driver the answer did not ask for', async () => {
    const dir = existingProject();
    try {
      const out = await initLines(dir, ['--store', 'sqlite']);
      const add = out.split('\n').find((l) => l.includes('pnpm add') && !l.includes('-D'))!;
      expect(add.split(/\s+/)).not.toContain('pg');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
