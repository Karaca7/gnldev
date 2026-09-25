// scripts/check-doc-samples.mjs — the gate behind `pnpm check:docs`, which compiles every ```ts block in
// the repository so a documented sample cannot rot into a lie.
//
// It had no test, unlike its siblings check-versions.mjs and check-dist-fresh.mjs, and a defect got
// through that the gate's own comment predicted: `missingOwnImport` exists because the public snapshot
// omits @gnldev/auth-ee, so a sample importing it compiles in the private monorepo and fails with TS2307
// in the tree CI gates a release on. The function was called from the docs-mcp loop and from NOWHERE
// ELSE. @gnldev/mcp's README gained such a sample, check:docs went red on the public tree with v0.6.0
// already tagged, and fixing it cost a rewrite of published history.
//
// WHY THIS IS AN INTEGRATION TEST AND NOT A UNIT TEST, because that choice is the whole point: the bug
// was not a wrong function, it was a MISSING CALL. A unit test of `missingOwnImport` would have passed
// against the broken script. Only running the real script over a real markdown file catches it.
//
// The fixture is a temporary file under docs/, removed in `finally`. It has to be inside the repository:
// the script derives its root from its own location and shells out to `npx tsc`, so a fixture tree
// elsewhere would need typescript and every package's built dist copied beside it.
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/** Unique so a concurrent run cannot collide, and obvious in `git status` if a crash leaves it behind. */
const fixture = join(repoRoot, 'docs', `zz-doccheck-fixture-${process.pid}.md`);

afterEach(() => {
  if (existsSync(fixture)) rmSync(fixture);
});

function runChecker() {
  const r = spawnSync('node', [join(repoRoot, 'scripts', 'check-doc-samples.mjs')], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '') };
}

/** A markdown file with one ```ts block. */
const doc = (code: string) => `# fixture\n\nProse.\n\n\`\`\`ts\n${code}\n\`\`\`\n`;

describe('check-doc-samples: a sample importing a package this checkout lacks', () => {
  it('is SKIPPED, not reported — the regression that reached a published snapshot', () => {
    // The exact shape that broke: a markdown block (not a docs-mcp example) importing a first-party
    // package that is not in this checkout. Before the fix this compiled and failed with TS2307.
    writeFileSync(fixture, doc(`import { nope } from '@gnldev/definitely-not-a-package';\nvoid nope;`));
    const { code, out } = runChecker();
    expect(out, 'the skip must name the file, so a reader can tell coverage from silence')
      .toContain(`docs/zz-doccheck-fixture-${process.pid}.md`);
    expect(out).toContain('not checked here');
    expect(code, 'an absent package is a fact about the checkout, not a defect in the sample').toBe(0);
  }, 180_000);

  it('a SUBPATH import of an absent package is skipped too', () => {
    // `from '@gnldev/absent/sub'` — the regex has to match the package, not the whole specifier.
    writeFileSync(fixture, doc(`import { nope } from '@gnldev/definitely-not-a-package/deep';\nvoid nope;`));
    const { code, out } = runChecker();
    expect(out).toContain('not checked here');
    expect(code).toBe(0);
  }, 180_000);

  it('BUT a real error in a block importing a package that IS here still fails', () => {
    // The half that makes the test above mean something. Without this, a script that skipped
    // everything would pass — and "skip on absent import" is one edit away from "skip".
    writeFileSync(fixture, doc(`import { runDurable } from '@gnldev/durable';\nrunDurable({ thisOptionDoesNotExist: 1 });`));
    const { code, out } = runChecker();
    expect(code, 'a wrong option in a documented sample must still turn the gate red').not.toBe(0);
    expect(out).toContain(`docs/zz-doccheck-fixture-${process.pid}.md`);
    expect(out, 'and it must be reported as a problem rather than skipped').toMatch(/problem\(s\) in documented samples/);
  }, 180_000);

  it('a third-party import is NOT skipped — the scope is first-party names only', () => {
    // The skip must not leak past `@gnldev/*`. `_modules.d.ts` declares a FIXED list of third-party
    // modules (no wildcard), so an undeclared one is a real TS2307 and has to be REPORTED — which is
    // what keeps the gate about our API rather than about which optionals happen to be installed.
    //
    // The first version of this test asserted the opposite, on an assumption that an ambient wildcard
    // covered unknown modules. Measured: there is no wildcard. The assumption was the defect.
    writeFileSync(fixture, doc(`import { thing } from 'some-unlikely-third-party-module';\nvoid thing;`));
    const { code, out } = runChecker();
    expect(out, 'a third-party name must not take the absent-first-party path').not.toContain('not checked here');
    expect(code, 'an undeclared third-party import is a problem in the sample').not.toBe(0);
    expect(out).toContain(`docs/zz-doccheck-fixture-${process.pid}.md`);
  }, 180_000);
});
