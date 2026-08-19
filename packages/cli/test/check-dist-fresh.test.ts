// The gate that stops the suite running against a stale build.
//
// Cross-package imports resolve through each package's exports map to `dist`, so a package whose src
// has moved since the last build is exercised by every OTHER package's tests as it was at build time.
// That is not a hypothetical: this gate found @gnldev/auth-ee 249 minutes stale the first time it ran,
// and it has already caught a mutation-testing session in this repo where a src file was restored from
// a copy (touching its mtime) without a rebuild.
//
// Of the three release gates it was one of the two with no test at all. A gate nobody tests is a gate
// whose failure mode is "it silently stopped failing" — the same defect it exists to prevent, one level
// up.
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const realScript = join(repoRoot, 'scripts', 'check-dist-fresh.mjs');

const created: string[] = [];
afterEach(() => { for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true }); });

type Pkg = { src?: string[]; dist?: string[]; srcAt?: number; distAt?: number };

/**
 * A throwaway workspace holding the real script. mtimes are set explicitly rather than by writing in
 * order: a filesystem with coarse timestamps would otherwise make "newer" and "older" the same number,
 * and the test would pass or fail on the machine rather than on the code.
 */
function workspace(packages: Record<string, Pkg>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gnl-dist-fresh-'));
  created.push(dir);
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(realScript, join(dir, 'scripts', 'check-dist-fresh.mjs'));

  const base = Math.floor(Date.now() / 1000) - 10_000;
  mkdirSync(join(dir, 'packages'), { recursive: true });
  for (const [name, p] of Object.entries(packages)) {
    mkdirSync(join(dir, 'packages', name), { recursive: true }); // exists even with no src/dist
    for (const [sub, files, at] of [['src', p.src, p.srcAt], ['dist', p.dist, p.distAt]] as const) {
      if (!files) continue;
      const d = join(dir, 'packages', name, sub);
      mkdirSync(d, { recursive: true });
      for (const f of files) {
        const full = join(d, f);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, '// x\n');
        const t = base + (at ?? 0);
        utimesSync(full, t, t);
      }
    }
  }
  return dir;
}

function run(dir: string) {
  const r = spawnSync(process.execPath, [join(dir, 'scripts', 'check-dist-fresh.mjs')], { encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('check-dist-fresh', () => {
  it('passes when every dist is at least as new as its src', () => {
    const { status, out } = run(workspace({
      durable: { src: ['run.ts'], srcAt: 100, dist: ['run.js', 'run.d.ts'], distAt: 200 },
    }));
    expect(status).toBe(0);
    expect(out).toContain('at least as new');
  });

  it('fails when src is newer than dist, and names the package and the gap', () => {
    // The real case: someone edits a file and runs the suite. Other packages then exercise this one as
    // it was at build time, and every assertion about it is about code that is no longer there.
    const { status, out } = run(workspace({
      durable: { src: ['run.ts'], srcAt: 9000, dist: ['run.js'], distAt: 100 },
    }));
    expect(status, 'the suite would have run against a stale build').toBe(1);
    expect(out).toContain('durable');
    expect(out, 'a gap with no size is a gap nobody acts on').toMatch(/\d+ min/);
  });

  it('fails when a package has src but no dist at all', () => {
    // Never built, rather than built-and-outdated. Distinguished because the fix is different: this one
    // is a first build, not a rebuild.
    const { status, out } = run(workspace({ durable: { src: ['run.ts'], srcAt: 100 } }));
    expect(status).toBe(1);
    expect(out).toContain('durable');
  });

  it('ignores a directory under packages/ that has no src', () => {
    // `packages/` also holds directories that are not build targets — the lab-* folders in this repo
    // have no package.json and nothing to compile. Treating them as unbuilt would make the gate cry
    // wolf on every run, which is how a gate gets ignored.
    const { status } = run(workspace({
      durable: { src: ['run.ts'], srcAt: 100, dist: ['run.js'], distAt: 200 },
      'lab-notes': {},
    }));
    expect(status, 'a directory with nothing to compile was reported as unbuilt').toBe(0);
  });

  it('ignores a src directory that holds no source files', () => {
    // Present but empty is a real intermediate state (a package being started, or one whose sources
    // moved). `srcAt === 0` means there is nothing to be stale against.
    const { status } = run(workspace({ empty: { src: ['README.md'], srcAt: 100 } }));
    expect(status).toBe(0);
  });

  it('looks at nested source files, not only the top level', () => {
    const { status, out } = run(workspace({
      durable: { src: ['rules/openai.ts'], srcAt: 9000, dist: ['index.js'], distAt: 100 },
    }));
    expect(status, 'a change in a subdirectory did not count as a change').toBe(1);
    expect(out).toContain('durable');
  });

  it('counts a .d.ts as build output, not as source', () => {
    // dist holds `.d.ts` files. If the src scan matched them too, a package would be permanently stale
    // against itself and the gate would be unusable.
    const { status } = run(workspace({
      durable: { src: ['run.ts'], srcAt: 100, dist: ['run.d.ts'], distAt: 200 },
    }));
    expect(status).toBe(0);
  });

  it('reports every stale package, not just the first', () => {
    // A one-at-a-time gate turns one rebuild into three runs.
    const { status, out } = run(workspace({
      durable: { src: ['a.ts'], srcAt: 9000, dist: ['a.js'], distAt: 100 },
      studio: { src: ['b.ts'], srcAt: 9000, dist: ['b.js'], distAt: 100 },
    }));
    expect(status).toBe(1);
    expect(out).toContain('durable');
    expect(out).toContain('studio');
  });
});
