// The root entry must not drag the seven optional peers into a consumer's type graph.
//
// `GnlDevConfig.auth` referenced `Cred` from `@gnldev/auth`, so `defineConfig` — the one thing every
// `gnl.config.ts` calls — put an uninstalled package into the emitted `config.d.ts`, and a consumer on
// `skipLibCheck: false` got `TS2307` for a package they deliberately did not install. The dev-server
// half was re-exported from the root for the same reason and moved to `@gnldev/cli/dev`.
//
// The check that matters is TRANSITIVE and covers EVERY exported symbol, not one import of one symbol:
// a single probe misses a peer reached through a sibling module. `dist/index.d.ts` is walked through
// its relative imports and every external specifier is collected.
//
// Comments are stripped first, and that is not a detail: `dist/config.d.ts` mentions `@gnldev/auth`
// five times in preserved JSDoc while importing it zero times. A naive grep reports the fix as broken.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const cliRoot = join(import.meta.dirname, '..');
const distDir = join(cliRoot, 'dist');
const pkg = JSON.parse(readFileSync(join(cliRoot, 'package.json'), 'utf8'));

/** The peers a consumer is entitled not to have installed. */
const OPTIONAL_PEERS = Object.entries(pkg.peerDependenciesMeta ?? {})
  .filter(([, v]) => (v as { optional?: boolean }).optional)
  .map(([k]) => k);

/** `@gnldev/durable` is the one peer a project with a gnl.config has by definition. */
const ALLOWED_ON_ROOT = '@gnldev/durable';

const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Module specifiers of real import/export statements (and `import(...)` types), comments removed. */
function specifiersOf(file: string): string[] {
  const src = stripComments(readFileSync(file, 'utf8'));
  return [...src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
}

/** Every external package the .d.ts graph rooted at `entry` depends on. */
function externalDeps(entry: string): Set<string> {
  const seen = new Set<string>();
  const external = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file) || !existsSync(file)) return;
    seen.add(file);
    for (const spec of specifiersOf(file)) {
      if (!spec.startsWith('.')) { external.add(spec); continue; }
      visit(resolve(dirname(file), spec.replace(/\.js$/, '.d.ts')));
    }
  };
  visit(entry);
  return external;
}

describe('the root entry type graph', () => {
  it('reaches no optional peer, transitively, from any exported symbol', () => {
    const deps = externalDeps(join(distDir, 'index.d.ts'));
    const leaked = OPTIONAL_PEERS.filter((p) => p !== ALLOWED_ON_ROOT)
      .filter((p) => [...deps].some((d) => d === p || d.startsWith(`${p}/`)));

    expect(OPTIONAL_PEERS.length, 'no optional peers are declared — the check is vacuous').toBeGreaterThan(0);
    expect(leaked, 'importing @gnldev/cli forces a consumer to install a package they opted out of').toEqual([]);
  });

  it('reaches @gnldev/durable and nothing else outside the package', () => {
    const deps = [...externalDeps(join(distDir, 'index.d.ts'))].sort();
    expect(deps, 'a new external dependency appeared on the root entry').toEqual([ALLOWED_ON_ROOT]);
  });

  // The mechanism, asserted where it lives: the `import('@gnldev/auth')` sits in a function body so
  // declaration emit elides it.
  it('emits a config.d.ts that imports @gnldev/durable only', () => {
    const file = join(distDir, 'config.d.ts');
    const specs = specifiersOf(file);

    expect(specs, 'the Cred import came back into the emitted declaration').toEqual([ALLOWED_ON_ROOT]);
    // ...and the naive check that would have said otherwise, so the distinction is on the record.
    expect(readFileSync(file, 'utf8'), 'the JSDoc explaining the split was dropped').toContain('@gnldev/auth');
  });
});

describe('GnlCred and the Cred it stands in for', () => {
  /** Top-level field names of `export type <name> = { ... }` in a source file. */
  function fieldsOf(file: string, typeName: string): string[] {
    const src = stripComments(readFileSync(file, 'utf8'));
    const start = src.indexOf(`export type ${typeName} = {`);
    expect(start, `${typeName} was not found in ${file}`).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('};', start));
    return [...body.matchAll(/^\s{2}(\w+)\??\s*:/gm)].map((m) => m[1]!).sort();
  }

  // `assertCredCompatible` pins mutual ASSIGNABILITY, which catches a field becoming required and a
  // field changing type — measured, 4 and 5 build errors respectively. It does NOT catch a field being
  // ADDED as optional or REMOVED: both directions still assign, because excess-property checking does
  // not apply to non-literal assignments. Measured, both produce ZERO build errors.
  //
  // Adding an optional field is the likeliest way `Cred` evolves, and the failure is silent: the CLI's
  // config type quietly stops offering it. This closes that half.
  it('declare exactly the same fields', () => {
    const cred = fieldsOf(join(cliRoot, '..', 'auth', 'src', 'types.ts'), 'Cred');
    const gnlCred = fieldsOf(join(cliRoot, 'src', 'config.ts'), 'GnlCred');

    expect(cred.length, 'Cred parsed as empty — the parser broke, not the types').toBeGreaterThan(0);
    expect(gnlCred, 'GnlCred has drifted from @gnldev/auth\'s Cred in a way the compile-time assertion cannot see')
      .toEqual(cred);
  });
});

describe('the @gnldev/cli/dev subpath', () => {
  const MOVED = [
    'buildDevApp', 'serveDev', 'loadDevRuntime', 'resolveAuthProvider',
    'projectDirOf', 'resolveFromProject', 'loadDurable', 'loadServer', 'loadStudio',
    'loadStudioAi', 'loadMemory', 'loadAuth', 'loadHono', 'loadNodeServer',
  ];

  it('is declared in `exports` with both a types and a default condition', () => {
    const entry = pkg.exports?.['./dev'];
    expect(entry, '`./dev` is not exported, so the subpath cannot resolve at all').toBeTruthy();
    expect(entry.types).toBe('./dist/dev.d.ts');
    expect(entry.default).toBe('./dist/dev.js');
    expect(existsSync(join(cliRoot, entry.types)), 'the declared types file does not exist').toBe(true);
    expect(existsSync(join(cliRoot, entry.default)), 'the declared entry file does not exist').toBe(true);
  });

  // The specifier is assembled at runtime so vite's dependency scan cannot resolve it at collection
  // time. With a literal, removing `./dev` from `exports` makes the whole FILE fail to load ("no
  // tests") instead of failing this assertion — a loud error, but not a test result.
  it('resolves at runtime and exports every moved symbol', async () => {
    const spec = ['@gnldev', 'cli', 'dev'].join('/');
    const mod = await import(/* @vite-ignore */ spec);
    for (const name of MOVED) {
      expect(typeof (mod as Record<string, unknown>)[name], `${name} is missing from @gnldev/cli/dev`).toBe('function');
    }
  });

  it('and the root entry exports none of them', async () => {
    const root = await import(/* @vite-ignore */ ['@gnldev', 'cli'].join('/'));
    const stillThere = MOVED.filter((n) => n in (root as Record<string, unknown>));

    expect(stillThere, 'a dev-server symbol is still on the root entry, so its peer types come with it').toEqual([]);
  });

  it('while the root entry keeps the surface it is meant to keep', async () => {
    const root = await import(/* @vite-ignore */ ['@gnldev', 'cli'].join('/')) as Record<string, unknown>;
    for (const name of ['defineConfig', 'loadConfig', 'scaffold', 'generateConfig', 'RECIPES', 'isFeature', 'commands']) {
      expect(root[name], `${name} was lost from the root entry`).toBeTruthy();
    }
  });
});

describe('nothing in the repo imports a moved symbol from the root path', () => {
  // `create-gnl` imports `scaffold` and nothing else, which is the case the split exists for. This
  // catches a sibling that was overlooked — the failure mode of every previous round.
  it('across sources, tests, docs and templates', () => {
    const moved = 'buildDevApp|serveDev|loadDevRuntime|resolveAuthProvider|DevRuntimeModules|projectDirOf|resolveFromProject|loadDurable|loadServer|loadStudioAi|loadStudio|loadMemory|loadAuth|loadNodeServer|loadHono';
    const hits = execFileSync('git', ['grep', '-nE', `from '@gnldev/cli'`, '--', '*.ts', '*.tsx', '*.mjs', '*.js', '*.md'], {
      cwd: join(cliRoot, '..', '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).split('\n').filter(Boolean).filter((l) => new RegExp(moved).test(l));

    expect(hits, 'a consumer still imports a dev-server symbol from the root entry').toEqual([]);
  });
});

describe('the published tarball', () => {
  const packed = (): string[] => {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: cliRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return (JSON.parse(out)[0]?.files ?? []).map((f: { path: string }) => f.path);
  };

  // The `files` list also gained a node_modules negation in the same round; a negation can remove more
  // than intended, and a missing `dist/dev.js` would make the new subpath a 404 for every consumer.
  it('ships both entry points', () => {
    const files = packed();
    for (const f of ['dist/index.js', 'dist/index.d.ts', 'dist/dev.js', 'dist/dev.d.ts']) {
      expect(files, `the tarball is missing ${f}`).toContain(f);
    }
  });

  it('ships every file the `exports` map points at', () => {
    const files = packed();
    const targets = Object.values(pkg.exports as Record<string, unknown>)
      .flatMap((v) => (typeof v === 'string' ? [v] : Object.values(v as Record<string, string>)))
      .map((p) => p.replace(/^\.\//, ''));

    for (const t of targets) {
      expect(files, `\`exports\` points at ${t}, which the tarball does not contain`).toContain(t);
    }
  });
});
