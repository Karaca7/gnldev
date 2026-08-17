#!/usr/bin/env node
// VERSIONING.md promises the published packages move in lockstep. A promise in a markdown file is not
// a constraint, and the way it breaks is quiet: someone bumps the package they touched, publishes, and
// a user ends up with @gnldev/server and @gnldev/durable on different versions — which is exactly the
// combination lockstep exists to make impossible, because these packages share a journal format and a
// mismatch presents as data corruption rather than as a version conflict.
//
// So the promise is checked. What the check covers is "every package whose version ends up in somebody's
// install", which is not the same set as "every package npm publishes" — see the private-but-distributed
// note below.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = join(root, 'packages');

// `private: true` used to mean "exempt", full stop. That exempted @gnldev/auth-ee, which is private and
// distributed: it is the paid tier, packed and shipped to customers out of band (docs/RELEASE.md), and a
// customer who installs it alongside @gnldev/auth is running the same shared-format pairing lockstep
// exists to protect. The audit fixture was auth-ee at 0.0.7 with the rest of the workspace at 0.1.0 —
// exit 0, a mismatched paid tier waved through.
//
// The signal used here is `files`, because `files` is a publish-only field: it selects what goes into a
// tarball and has literally no effect on a package that is never packed. A private package that declares
// one has therefore been packaged for delivery by somebody, deliberately. Note which way this errs — a
// genuinely internal package that picked up a `files` array by copy-paste gets pulled into lockstep and
// fails loudly, and the fix is to delete a field that was doing nothing for it anyway; whereas a name
// list would have let the next private-but-distributed package escape in silence until someone
// remembered to edit the list. Loud and wrong beats quiet and wrong for a release guard.
const isDistributed = (pkg) => !pkg.private || (Array.isArray(pkg.files) && pkg.files.length > 0);

const lockstep = [];
for (const name of readdirSync(pkgDir)) {
  const manifest = join(pkgDir, name, 'package.json');
  if (!existsSync(manifest)) continue;
  // Per-package try/catch: a malformed manifest used to abort with a bare SyntaxError stack that named
  // no file, leaving whoever hit it in CI to guess which of ~27 packages it came from.
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  } catch (err) {
    console.error(`check-versions: cannot parse ${manifest}: ${err.message}`);
    process.exit(1);
  }
  if (!isDistributed(pkg)) continue;
  lockstep.push({ name: pkg.name, version: pkg.version, dir: name, private: Boolean(pkg.private) });
}

if (lockstep.length === 0) {
  console.error('check-versions: found no distributed packages — that is almost certainly a bug in this script');
  process.exit(1);
}

const byVersion = new Map();
for (const p of lockstep) {
  if (!byVersion.has(p.version)) byVersion.set(p.version, []);
  byVersion.get(p.version).push(p.name);
}

const missing = lockstep.filter((p) => !p.version);
if (missing.length) {
  console.error(`check-versions: no version field in ${missing.map((p) => p.name).join(', ')}`);
  process.exit(1);
}

if (byVersion.size > 1) {
  console.error('check-versions: distributed packages are NOT in lockstep (see VERSIONING.md)\n');
  for (const [version, names] of [...byVersion].sort((a, b) => b[1].length - a[1].length)) {
    console.error(`  ${version}  ${names.join(', ')}`);
  }
  console.error('\nBump every distributed package together, or update VERSIONING.md if the policy changed.');
  process.exit(1);
}

const [version] = [...byVersion.keys()];

// A prerelease version passes lockstep — every package agrees on `0.2.0-rc.1` — and then release.yml
// runs a plain `pnpm -r publish`, which carries no `--tag`. npm's default dist-tag is `latest`, so the
// rc becomes what `npm i @gnldev/server` resolves to for everyone, and the only way back is a manual
// dist-tag repair on every package in the set. That is not a state to arrive at by inheritance, so the
// guard refuses unless the invocation says otherwise: GNL_ALLOW_PRERELEASE=1 is recorded in the command
// that ran, the same reason `gnl dev` makes you type --allow-open-network rather than reading a config.
// (Build metadata after `+` is not a prerelease — strip it before looking for the `-`.)
const isPrerelease = version.split('+')[0].includes('-');
if (isPrerelease && process.env.GNL_ALLOW_PRERELEASE !== '1') {
  console.error(`check-versions: every distributed package is at ${version}, which is a PRERELEASE.\n`);
  console.error('  release.yml publishes with `pnpm -r publish` and no --tag, so npm would tag this as');
  console.error('  `latest` — every `npm i @gnldev/*` would install the rc, and undoing it means a manual');
  console.error(`  \`npm dist-tag\` repair on all ${lockstep.length} packages.\n`);
  console.error('  If this run IS the rc pipeline, say so in the invocation: GNL_ALLOW_PRERELEASE=1 pnpm');
  console.error('  check:versions — and make sure the publish step passes --tag next (e.g. --tag next).');
  process.exit(1);
}

// ── the scaffold's dependency ranges must agree with what the packages actually peer on ─────────
// These manifests are NOT workspace members, so nothing above sees them and no install resolves
// them — which is exactly how they drifted: the workspace moved to AI SDK 7 and both templates kept
// `"ai": "^5.0.0"`. The result was invisible here and fatal there: `npm create gnl` produced a
// project whose first `npm install` died with ERESOLVE against `peer ai@^7.0.0`, and the advertised
// entry point of the whole framework did not work. A range that a published peer contradicts is a
// broken scaffold, so it is checked here rather than trusted to review.
const templateDir = join(pkgDir, 'cli', 'templates');
// Read peers from the manifest on disk. `lockstep` carries only name/version/dir/private, so an
// earlier version of this check looked up `p.peerDependencies`, got undefined for every package, and
// passed unconditionally — a guard that could not fail, which is worse than no guard because a green
// line says the templates were checked. Caught by reintroducing the broken range and watching it
// exit 0.
const peerOf = (name, dep) => {
  const entry = lockstep.find((x) => x.name === name);
  if (!entry) return undefined;
  const file = join(pkgDir, entry.dir, 'package.json');
  return JSON.parse(readFileSync(file, 'utf8')).peerDependencies?.[dep];
};
// A fixture workspace (test/check-versions.test.ts builds several) has packages but no CLI
// templates. Absent directory means there is nothing to contradict, so there is nothing to check —
// the same reading as the `existsSync(manifest)` skip above. The real repo has the directory, so
// this cannot quietly disable the check where it matters.
const tmplProblems = [];
const templates = existsSync(templateDir)
  ? readdirSync(templateDir, { withFileTypes: true }).filter((d) => d.isDirectory())
  : [];
for (const t of templates) {
  const file = join(templateDir, t.name, 'package.json');
  if (!existsSync(file)) continue;
  const tpl = JSON.parse(readFileSync(file, 'utf8'));
  const deps = { ...(tpl.dependencies ?? {}), ...(tpl.devDependencies ?? {}) };
  for (const [dep, range] of Object.entries(deps)) {
    if (!dep.startsWith('@gnldev/')) continue;
    // Every gnldev package the template pulls in: its peers must be satisfiable by what the
    // template itself pins. Compared as strings — this catches a stale major, which is the failure
    // that actually happens; it deliberately does not try to be a semver range intersector.
    for (const peerDep of ['ai', 'zod']) {
      const peer = peerOf(dep, peerDep);
      const pinned = deps[peerDep];
      if (!peer || !pinned) continue;
      const major = (r) => (r.match(/(\d+)\./) ?? [])[1];
      if (major(pinned) && major(peer) && !peer.includes(`^${major(pinned)}.`)) {
        tmplProblems.push(`  templates/${t.name}: pins ${peerDep}@${pinned}, but ${dep} peers ${peerDep}@${peer}`);
      }
    }
    if (range.startsWith('workspace:')) {
      tmplProblems.push(`  templates/${t.name}: ${dep}@${range} — workspace: protocol cannot resolve outside this repo`);
    }
  }
}
if (tmplProblems.length) {
  console.error('check-versions: scaffold templates contradict the packages they install.\n');
  console.error([...new Set(tmplProblems)].join('\n'));
  console.error('\n  These manifests are not workspace members, so nothing else checks them and no');
  console.error('  install here exercises them. A user hits it on the first `npm install` after');
  console.error('  `npm create gnl`, as an ERESOLVE with no node_modules.\n');
  process.exit(1);
}

const heldBack = lockstep.filter((p) => p.private).map((p) => p.name);
const suffix = heldBack.length ? ` (incl. private-but-distributed: ${heldBack.join(', ')})` : '';
const prereleaseNote = isPrerelease ? ' — PRERELEASE, allowed by GNL_ALLOW_PRERELEASE=1' : '';
console.log(`✓ ${lockstep.length} distributed packages, all at ${version}${suffix}${prereleaseNote}`);
if (templates.length) console.log(`✓ ${templates.length} scaffold templates agree with the published peer ranges`);
