// A scaffolded project must contain the template, and nothing the template picked up from being USED.
//
// A template directory that this repo's own tests install and run grows a `node_modules/` and, inside
// it, `.vite/vitest/results.json` — a cache naming which tests last passed. `cpSync(src, dir,
// { recursive: true })` copied all of it, so a brand new project arrived carrying a stranger's
// dependency tree and a test-results cache for runs its owner never made. (Measured on the retired
// `templates/full`; the debris is planted below because a clean clone has none.)
//
// Two directions are checked, because a skip list is a rule that can be too narrow OR too wide:
//   * nothing a template accumulates reaches a scaffold, on BOTH copy paths (the template copy and the
//     e2e test-directory copy);
//   * nothing a template legitimately ships shares a name with the skip list — otherwise the fix
//     silently deletes a real file from every scaffold, which is worse than the debris.
import { describe, it, expect, afterEach, afterAll, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { scaffold, TEMPLATES } from '../src/scaffold.js';

const cliRoot = join(import.meta.dirname, '..');
const templatesRoot = join(cliRoot, 'templates');
const SKIPPED = ['node_modules', 'dist', '.vite', '.turbo'];

const created: string[] = [];
afterEach(() => { for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true }); });

function tmp(): string {
  const base = mkdtempSync(join(tmpdir(), 'gnl-debris-'));
  created.push(base);
  return base;
}

/** Every path under `dir`, relative and recursive, directories included. */
function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    out.push(relative(base, full));
    if (e.isDirectory()) out.push(...walk(full, base));
  }
  return out;
}

// The debris this exists for. It is genuinely present in a working checkout (the repo's own e2e tests
// install the template), but a clean clone has none — so it is planted when absent, or the test would
// pass by having nothing to catch. `node_modules` is gitignored everywhere and no other test reads it.
const DEBRIS_FILE = join(templatesRoot, 'minimal', 'node_modules', '.vite', 'vitest', 'results.json');

// The e2e copy reads a `test/` directory, and the debris above is a SIBLING of that directory, not
// inside it — so removing the filter from that second `cpSync` changes nothing that can be observed.
// Measured: it survives as an equivalent mutant. Debris is therefore planted INSIDE the directory the
// e2e path actually copies, which is a shape a project genuinely produces (a build output beside its
// tests). `dist/` is gitignored repo-wide, so a planted directory cannot dirty the tree.
//
// TWO of them now, because there are two e2e sources: `_e2e` for the plain durability test and
// `_idempotency` for the charge-tool one. The compose branch picks between them, so planting in only
// one would leave the other branch's filter unexercised — which is how the second `cpSync` came to be
// unfiltered in the first place.
const E2E_DEBRIS_DIRS = [join(templatesRoot, '_e2e', 'test', 'dist'), join(templatesRoot, '_idempotency', 'test', 'dist')];
const E2E_DEBRIS_DIR = E2E_DEBRIS_DIRS[0]!;
const E2E_DEBRIS_FILE = join(E2E_DEBRIS_DIR, 'results.json');

beforeAll(() => {
  if (!existsSync(DEBRIS_FILE)) {
    mkdirSync(dirname(DEBRIS_FILE), { recursive: true });
    writeFileSync(DEBRIS_FILE, '{"version":"planted-by-tests"}');
  }
  for (const d of E2E_DEBRIS_DIRS) {
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'results.json'), '{"version":"planted-by-tests"}');
  }
});
afterAll(() => { for (const d of E2E_DEBRIS_DIRS) rmSync(d, { recursive: true, force: true }); });

describe('a scaffolded project', () => {
  it.each(TEMPLATES)('%s carries no build debris from the template directory', (template) => {
    const dir = join(tmp(), 'my-agent');
    scaffold(dir, { template });

    const paths = walk(dir);
    for (const skipped of SKIPPED) {
      expect(paths.filter((p) => p.split(sep).includes(skipped)),
        `a scaffold from '${template}' carries ${skipped} out of the template directory`).toEqual([]);
    }
  });

  // The e2e path is a SECOND `cpSync`, into `test/`. It was the one easier to forget, and the test
  // directory it copies sits inside the same tree that accumulates the debris.
  it.each(TEMPLATES)('%s with e2e carries none either — the second copy path is filtered too', (template) => {
    const dir = join(tmp(), 'my-agent');
    scaffold(dir, { template, e2e: true } as never);

    expect(existsSync(join(dir, 'test')), 'the e2e path did not run, so it was not exercised').toBe(true);
    expect(existsSync(E2E_DEBRIS_FILE), 'the planted debris is missing — the e2e filter is not being exercised').toBe(true);
    const paths = walk(dir);
    for (const skipped of SKIPPED) {
      expect(paths.filter((p) => p.split(sep).includes(skipped)),
        `the e2e copy carried ${skipped} into the scaffold`).toEqual([]);
    }
    expect(paths.filter((p) => p.endsWith('results.json')), 'the e2e copy brought a build output sitting beside the tests').toEqual([]);
  });

  // The COMPOSE path: `features` builds from templates/minimal plus generated files, and its e2e copy
  // points at `templates/_idempotency/test` — the directory sitting next to the debris. It reaches
  // `addE2e` through a different branch than the plain `e2e: true` above, so it is exercised separately.
  it('composed from features carries no debris either', () => {
    const dir = join(tmp(), 'my-agent');
    const res = scaffold(dir, { features: ['idempotency-tool'], e2e: true } as never);

    expect(res.template, 'the compose branch did not run').toBe('custom');
    expect(existsSync(join(dir, 'test')), 'the composed project got no e2e directory').toBe(true);
    const paths = walk(dir);
    for (const skipped of SKIPPED) {
      expect(paths.filter((p) => p.split(sep).includes(skipped)),
        `the compose path carried ${skipped} into the scaffold`).toEqual([]);
    }
    expect(paths.filter((p) => p.endsWith('results.json')), 'the compose e2e copy brought the results cache').toEqual([]);
  });

  // Named explicitly, because it is the file the whole change exists to stop shipping.
  it('does not contain a vitest results cache', () => {
    expect(existsSync(DEBRIS_FILE), 'the debris is absent, so this test cannot prove anything').toBe(true);

    const dir = join(tmp(), 'my-agent');
    scaffold(dir, { template: 'full' as never }); // the retired alias — the compose path, not a copy

    expect(walk(dir).filter((p) => p.endsWith('results.json')),
      "a new project arrived with a cache of test runs its owner never made").toEqual([]);
  });

  // The complement: the filter must not have eaten the template. Asserted against the files git tracks,
  // so adding a template file without updating anything here still holds.
  it.each(TEMPLATES)('%s still contains every file the template actually ships', (template) => {
    const tracked = execFileSync('git', ['ls-files', `templates/${template}`], { cwd: cliRoot, encoding: 'utf8' })
      .split('\n').filter(Boolean)
      .map((p) => relative(`templates/${template}`, p))
      // `gitignore` is renamed on copy — npm tarballs drop a real `.gitignore`.
      .map((p) => (p === 'gitignore' ? '.gitignore' : p));

    const dir = join(tmp(), 'my-agent');
    scaffold(dir, { template });
    const got = new Set(walk(dir));

    for (const f of tracked) {
      expect(got.has(f), `the filter removed '${f}', which the template genuinely ships`).toBe(true);
    }
  });
});

describe('the skip list', () => {
  // The over-exclusion question. `notBuildDebris` matches on BASENAME, so a template file named
  // `dist` — at any depth, file or directory — would vanish from every scaffold with no error.
  it('shares no name with any file the templates track', () => {
    const tracked = execFileSync('git', ['ls-files', 'templates'], { cwd: cliRoot, encoding: 'utf8' })
      .split('\n').filter(Boolean);

    expect(tracked.length, 'git tracked no template files — the check is vacuous').toBeGreaterThan(0);
    const collisions = tracked.filter((p) => p.split('/').some((seg) => SKIPPED.includes(seg)));
    expect(collisions, 'a tracked template path collides with the skip list and is being deleted from every scaffold')
      .toEqual([]);
  });

  // NOT asserted here: that the filter compares whole names rather than substrings. No current
  // template file name CONTAINS one of the skipped words, so an `includes()` rewrite is measurably
  // indistinguishable from the exact comparison — it survives as an equivalent mutant. The
  // over-exclusion question is answered by the collision check above, which is the form that stays
  // meaningful as the templates change.
  it('leaves the template body itself alone', () => {
    const dir = join(tmp(), 'my-agent');
    scaffold(dir, { template: 'full' as never }); // the retired alias: template body + composed e2e
    const paths = walk(dir);

    expect(paths.some((p) => basename(p) === 'gnl.config.ts'), 'the template body did not arrive at all').toBe(true);
    expect(paths.some((p) => basename(p) === 'e2e.test.ts'), 'the template test file was filtered out').toBe(true);
  });
});

describe('the published tarball', () => {
  // `files` gained `!templates/**/node_modules`. A negation in that list can quietly remove more than
  // intended, and the failure mode is a published CLI whose `gnl init` finds no template at all.
  const packed = (): string[] => {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: cliRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return (JSON.parse(out)[0]?.files ?? []).map((f: { path: string }) => f.path);
  };

  it('still contains every template file', () => {
    const files = packed();
    const tracked = execFileSync('git', ['ls-files', 'templates'], { cwd: cliRoot, encoding: 'utf8' })
      .split('\n').filter(Boolean);

    expect(files.length, 'npm pack reported no files').toBeGreaterThan(0);
    for (const f of tracked) {
      expect(files, `the tarball lost '${f}' — the negation in \`files\` over-excluded`).toContain(f);
    }
  });

  it('contains no template node_modules', () => {
    expect(packed().filter((p) => p.split('/').includes('node_modules')),
      'the published tarball ships a dependency tree inside its templates').toEqual([]);
  });

  it('still contains the built CLI', () => {
    expect(packed().some((p) => p.startsWith('dist/')), 'the negation removed the package\'s own dist').toBe(true);
  });
});
