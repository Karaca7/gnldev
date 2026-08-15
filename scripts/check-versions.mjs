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

const heldBack = lockstep.filter((p) => p.private).map((p) => p.name);
const suffix = heldBack.length ? ` (incl. private-but-distributed: ${heldBack.join(', ')})` : '';
const prereleaseNote = isPrerelease ? ' — PRERELEASE, allowed by GNL_ALLOW_PRERELEASE=1' : '';
console.log(`✓ ${lockstep.length} distributed packages, all at ${version}${suffix}${prereleaseNote}`);
