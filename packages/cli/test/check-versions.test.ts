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

/**
 * The npm-page fields every published manifest must carry, filled in for fixtures that are not about
 * them. Each `describe` below tests ONE rule, and a fixture that fails a different rule tests
 * nothing — the lockstep cases would all have exited on missing metadata before reaching the
 * comparison they exist to make. The metadata rule has its own describe at the bottom, where a
 * fixture deliberately omits a field.
 */
const NPM_PAGE_FIELDS = {
  repository: { type: 'git', url: 'git+https://example.invalid/x.git' },
  homepage: 'https://example.invalid',
  bugs: { url: 'https://example.invalid/issues' },
};

/** A throwaway workspace holding the real script, so it scans these manifests instead of the repo's. */
function fixtureWorkspace(manifests: Record<string, unknown | string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gnl-check-versions-'));
  created.push(dir);
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(realScript, join(dir, 'scripts', 'check-versions.mjs'));
  for (const [name, manifest] of Object.entries(manifests)) {
    mkdirSync(join(dir, 'packages', name), { recursive: true });
    const body = typeof manifest === 'string'
      ? manifest
      : JSON.stringify({ ...NPM_PAGE_FIELDS, ...(manifest as Record<string, unknown>) }, null, 2);
    writeFileSync(join(dir, 'packages', name, 'package.json'), body);
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

  it('build metadata is not a prerelease — a `-` AFTER the `+` is not a prerelease marker', () => {
    // The fixture has to contain a hyphen in the BUILD part, or it proves nothing. `0.2.0+build.5` has
    // no hyphen anywhere, so the naive `version.includes('-')` and the corrected
    // `version.split('+')[0].includes('-')` agree on it — measured: reverting the fix left this test
    // green. `0.2.0+build-5` is the shape that separates them.
    const dir = fixtureWorkspace({ server: pub('server', '0.2.0+build-5'), durable: pub('durable', '0.2.0+build-5') });
    const { status, out } = runGuard(dir);
    expect(status, 'build metadata was mistaken for a prerelease').toBe(0);
    expect(out, 'a legitimate latest release was announced as a prerelease').not.toContain('PRERELEASE');
  });

  it('a real prerelease is still refused, so the fix above did not open a hole', () => {
    const dir = fixtureWorkspace({ server: pub('server', '0.2.0-rc.1+build-5'), durable: pub('durable', '0.2.0-rc.1+build-5') });
    expect(runGuard(dir).status).toBe(1);
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

// ── the scaffold's ranges against the packages' peers ────────────────────────────────────────────
// The failure this covers reached the publish candidate: the workspace moved to AI SDK 7 while
// packages/cli/templates/*/package.json kept `"ai": "^5.0.0"`. Nothing noticed, because those
// manifests are not workspace members — no install resolves them and no other check reads them. The
// user finds out on the first `npm install` after `npm create gnl`, as an ERESOLVE with no
// node_modules, on the entry point the root README advertises.
//
// Note what the first version of the guard did: it looked up `peerDependencies` on the lockstep
// entry, which only carries name/version/dir/private. Every lookup was undefined, so it passed
// unconditionally AND printed a line saying the templates agreed. These fixtures exist so that
// cannot come back — the first asserts it FAILS, which is the direction a broken guard gets wrong.
function withTemplate(dir: string, name: string, manifest: unknown): string {
  const d = join(dir, 'packages', 'cli', 'templates', name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'package.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

describe('check-versions: scaffold templates', () => {
  const peering = (name: string, peer: Record<string, string>, version = '0.1.0') => ({
    name: `@gnldev/${name}`, version, files: ['dist'], peerDependencies: peer,
  });

  it('fails when a template pins a major the package it installs does not peer on', () => {
    const dir = withTemplate(
      fixtureWorkspace({ durable: peering('durable', { ai: '^7.0.0' }) }),
      'minimal',
      { name: 'app', dependencies: { '@gnldev/durable': '^0.1.0', ai: '^5.0.0' } },
    );
    const { status, out } = runGuard(dir);
    expect(status, 'a scaffold that cannot install must fail the guard').toBe(1);
    expect(out).toContain('templates/minimal');
    expect(out).toContain('pins ai@^5.0.0');
    expect(out).toContain('peers ai@^7.0.0');
  });

  it('passes when they agree', () => {
    const dir = withTemplate(
      fixtureWorkspace({ durable: peering('durable', { ai: '^7.0.0' }) }),
      'minimal',
      { name: 'app', dependencies: { '@gnldev/durable': '^0.1.0', ai: '^7.0.0' } },
    );
    expect(runGuard(dir).status).toBe(0);
  });

  it('rejects a workspace: protocol left in a template, which cannot resolve for a user', () => {
    const dir = withTemplate(
      fixtureWorkspace({ durable: peering('durable', { ai: '^7.0.0' }) }),
      'full',
      { name: 'app', dependencies: { '@gnldev/durable': 'workspace:*', ai: '^7.0.0' } },
    );
    const { status, out } = runGuard(dir);
    expect(status).toBe(1);
    expect(out).toContain('workspace: protocol');
  });

  it('a workspace with no templates at all passes, and does NOT claim it checked any', () => {
    const { status, out } = runGuard(fixtureWorkspace({ durable: peering('durable', { ai: '^7.0.0' }) }));
    expect(status).toBe(0);
    expect(out, 'an absent directory must not print a confirmation').not.toContain('scaffold templates agree');
  });

  /** A workspace at `version` whose template pins @gnldev/durable at `pin`. */
  function withTemplatePin(version: string, pin: string) {
    const dir = fixtureWorkspace({ durable: peering('durable', { ai: '^7.0.0' }, version) });
    const tpl = join(dir, 'packages', 'cli', 'templates', 'minimal');
    mkdirSync(tpl, { recursive: true });
    writeFileSync(join(tpl, 'package.json'), JSON.stringify({
      name: 'app', dependencies: { '@gnldev/durable': pin, ai: '^7.0.0' },
    }));
    return dir;
  }

  // The template's own @gnldev pin was never compared to the version being published. Measured on the
  // real script: packages at 0.2.0 with a template pinning ^0.1.0 exited 0, and so did ^9.9.9 — a
  // version that will never exist. The gate then printed "1 scaffold template agree with the published
  // peer ranges", claiming an agreement it had not looked for. A user meets it as an ERESOLVE on the
  // first `npm install` after `npm create gnl`, with no node_modules to inspect.
  it('refuses a template pinned a minor BEHIND the version being published', () => {
    const { status, out } = runGuard(withTemplatePin('0.2.0', '^0.1.0'));
    expect(status, 'a stale template pin shipped').toBe(1);
    expect(out).toContain('does not accept 0.2.0');
  });

  it('refuses a template pinned to a version that will never exist', () => {
    const { status, out } = runGuard(withTemplatePin('0.2.0', '^9.9.9'));
    expect(status).toBe(1);
    expect(out).toContain('does not accept 0.2.0');
  });

  it('refuses a pin it cannot verify rather than assuming it is fine', () => {
    // `latest` resolves to whatever npm has at install time, which is the opposite of a lockstep
    // guarantee. Unverifiable and wrong are the same problem here: nobody is checking either way.
    const { status, out } = runGuard(withTemplatePin('0.2.0', 'latest'));
    expect(status).toBe(1);
    expect(out).toContain('unrecognised');
  });

  it.each(['^0.2.0', '~0.2.0', '0.2.0'])('accepts %j against 0.2.0', (pin) => {
    expect(runGuard(withTemplatePin('0.2.0', pin as string)).status, `${pin} was refused`).toBe(0);
  });

  it('knows that ^0.x is not the same rule as ^1.x', () => {
    // The case this repo is actually in. `^0.1.0` does NOT accept 0.2.0 (a 0.x minor is a breaking
    // change by convention), while `^1.1.0` DOES accept 1.2.0. A checker that missed this would pass
    // exactly the pins that break a scaffold.
    expect(runGuard(withTemplatePin('1.2.0', '^1.1.0')).status, '^1.1.0 should accept 1.2.0').toBe(0);
    expect(runGuard(withTemplatePin('0.2.0', '^0.1.0')).status, '^0.1.0 must not accept 0.2.0').toBe(1);
  });

  it('counts the templates it READ, not the directories it found', () => {
    // The case the `examined` counter exists for, and the one no fixture had: a template directory
    // with NO manifest. templates/_e2e is exactly that in the real repo — an add-on with no
    // package.json — so `templates.length` claimed one more than was examined. Measured before this
    // test: reverting `examined` to `templates.length` left all ten fixtures green, because none of
    // them had a manifest-less directory and no assertion read the number.
    const dir = fixtureWorkspace({ durable: peering('durable', { ai: '^7.0.0' }) });
    const tpl = join(dir, 'packages', 'cli', 'templates');
    mkdirSync(join(tpl, 'minimal'), { recursive: true });
    writeFileSync(join(tpl, 'minimal', 'package.json'), JSON.stringify({
      name: 'app', dependencies: { '@gnldev/durable': '^0.1.0', ai: '^7.0.0' },
    }));
    mkdirSync(join(tpl, '_e2e'), { recursive: true }); // an add-on, deliberately without a manifest

    const { status, out } = runGuard(dir);
    expect(status).toBe(0);
    expect(out, 'the count included a directory that was never read').toContain('1 scaffold template ');
    expect(out).not.toContain('2 scaffold template');
  });
});

// THE FIELDS AN npm PAGE IS BUILT FROM, checked at the one gate a TAG runs.
//
// 26 of the 27 manifests were written by copying a sibling, so they all carried `repository`,
// `homepage` and `bugs` without anyone deciding to. The 27th — @gnldev/semantic-qualify — was
// written later and from scratch, and reached the publish set with none of them. Nothing failed:
// npm publishes a manifest with no repository perfectly happily, and the result is a package page
// with nowhere to click, plus a `--provenance` claim in the README that wants the field.
//
// It lives in check-versions rather than in a test of its own because this script is the gate a tag
// push runs, and a tag is the only event that publishes.
describe('check-versions: the fields an npm page is built from', () => {
  const ok = (name: string) => ({ name: `@gnldev/${name}`, version: '0.1.0', files: ['dist'] });

  it('refuses a published package with no repository, and names the field', () => {
    const dir = fixtureWorkspace({ durable: ok('durable') });
    // Rewrite it WITHOUT the fields the helper fills in — that omission is this test's subject.
    writeFileSync(
      join(dir, 'packages', 'durable', 'package.json'),
      JSON.stringify({ ...ok('durable'), homepage: 'https://x.invalid', bugs: { url: 'https://x.invalid/i' } }, null, 2),
    );
    const { status, out } = runGuard(dir);
    expect(status).toBe(1);
    expect(out).toContain('missing "repository"');
    expect(out).toContain('@gnldev/durable');
  });

  it('reports every missing field across every package, not just the first', () => {
    const dir = fixtureWorkspace({ durable: ok('durable'), server: ok('server') });
    for (const p of ['durable', 'server']) {
      writeFileSync(join(dir, 'packages', p, 'package.json'), JSON.stringify(ok(p), null, 2));
    }
    const { status, out } = runGuard(dir);
    expect(status).toBe(1);
    for (const field of ['repository', 'homepage', 'bugs']) expect(out).toContain(`missing "${field}"`);
    expect(out).toContain('@gnldev/server');
  });

  it('holds a PRIVATE package to a different standard — it has no npm page to build', () => {
    // auth-ee is distributed (packed and shipped out of band) and so is in the lockstep set, but it
    // is never on npm. Demanding a registry page's fields from it would be a rule about nothing.
    const dir = fixtureWorkspace({ durable: ok('durable') });
    mkdirSync(join(dir, 'packages', 'auth-ee'), { recursive: true });
    writeFileSync(
      join(dir, 'packages', 'auth-ee', 'package.json'),
      JSON.stringify({ name: '@gnldev/auth-ee', version: '0.1.0', private: true, files: ['dist'] }, null, 2),
    );
    expect(runGuard(dir).status).toBe(0);
  });

  it('an EMPTY repository object does not count as declared', () => {
    // `"repository": {}` passes a truthy check and renders as nothing on the npm page. The guard's
    // first cut used `!pkg[field]`, so the one shape a careless copy-paste actually produces would
    // have walked straight through it.
    const dir = fixtureWorkspace({ durable: ok('durable') });
    writeFileSync(
      join(dir, 'packages', 'durable', 'package.json'),
      JSON.stringify({ ...ok('durable'), repository: {}, homepage: '  ', bugs: { url: 'https://x.invalid/i' } }, null, 2),
    );
    const { status, out } = runGuard(dir);
    expect(status).toBe(1);
    expect(out).toContain('missing "repository"');
    expect(out, 'a whitespace-only homepage is not a homepage').toContain('missing "homepage"');
  });

  it('a PUBLISHED package may not runtime-depend on a private one', () => {
    // The live case this gate was written for: @gnldev/cli listed @gnldev/deploy in `dependencies`
    // while deploy is private. `pnpm publish` rewrites `workspace:^` to `^0.1.0`, so the tarball
    // names a package npm has never seen and every install of the CLI ends in E404. It survived
    // because releases come from a different tree where a script strips that line — a protection
    // made of shell, holding only until someone tags the wrong repo.
    const dir = fixtureWorkspace({
      cli: { ...ok('cli'), dependencies: { '@gnldev/deploy': '^0.1.0' } },
      deploy: { name: '@gnldev/deploy', version: '0.1.0', private: true, files: ['dist'] },
    });
    const { status, out } = runGuard(dir);
    expect(status).toBe(1);
    expect(out).toContain('depends on one that is never published');
    expect(out).toContain('dependencies.@gnldev/deploy');
    expect(out, 'the message has to say what to do instead').toContain('devDependencies');
  });

  it('...and peerDependencies count too, since npm resolves those for the installer', () => {
    const dir = fixtureWorkspace({
      cli: { ...ok('cli'), peerDependencies: { '@gnldev/auth-ee': '^0.1.0' } },
      'auth-ee': { name: '@gnldev/auth-ee', version: '0.1.0', private: true, files: ['dist'] },
    });
    expect(runGuard(dir).status).toBe(1);
  });

  it('but devDependencies on a private package are fine — npm never installs them', () => {
    const dir = fixtureWorkspace({
      cli: { ...ok('cli'), devDependencies: { '@gnldev/deploy': 'workspace:^' } },
      deploy: { name: '@gnldev/deploy', version: '0.1.0', private: true, files: ['dist'] },
    });
    expect(runGuard(dir).status).toBe(0);
  });

  it('a repository object with every field EXCEPT the url does not count', () => {
    // The shape a careless copy-paste actually produces: type and directory kept, url forgotten.
    // npm builds its link from `url` alone, and `--provenance` reads the same field.
    const dir = fixtureWorkspace({ durable: ok('durable') });
    writeFileSync(
      join(dir, 'packages', 'durable', 'package.json'),
      JSON.stringify({
        ...ok('durable'),
        repository: { type: 'git', directory: 'packages/durable' },
        homepage: 'https://x.invalid',
        bugs: { url: 'https://x.invalid/i' },
      }, null, 2),
    );
    const { status, out } = runGuard(dir);
    expect(status).toBe(1);
    expect(out).toContain('missing "repository"');
  });
});
