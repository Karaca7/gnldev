#!/usr/bin/env node
// VERSIONING.md promises the published packages move in lockstep. A promise in a markdown file is not
// a constraint, and the way it breaks is quiet: someone bumps the package they touched, publishes, and
// a user ends up with @gnldev/server and @gnldev/durable on different versions — which is exactly the
// combination lockstep exists to make impossible, because these packages share a journal format and a
// mismatch presents as data corruption rather than as a version conflict.
//
// So the promise is checked. Private packages are exempt: they are never published, so their version
// is not part of anyone's install.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = join(root, 'packages');

const published = [];
for (const name of readdirSync(pkgDir)) {
  const manifest = join(pkgDir, name, 'package.json');
  if (!existsSync(manifest)) continue;
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  if (pkg.private) continue;
  published.push({ name: pkg.name, version: pkg.version, dir: name });
}

if (published.length === 0) {
  console.error('check-versions: found no publishable packages — that is almost certainly a bug in this script');
  process.exit(1);
}

const byVersion = new Map();
for (const p of published) {
  if (!byVersion.has(p.version)) byVersion.set(p.version, []);
  byVersion.get(p.version).push(p.name);
}

const missing = published.filter((p) => !p.version);
if (missing.length) {
  console.error(`check-versions: no version field in ${missing.map((p) => p.name).join(', ')}`);
  process.exit(1);
}

if (byVersion.size > 1) {
  console.error('check-versions: published packages are NOT in lockstep (see VERSIONING.md)\n');
  for (const [version, names] of [...byVersion].sort((a, b) => b[1].length - a[1].length)) {
    console.error(`  ${version}  ${names.join(', ')}`);
  }
  console.error('\nBump every published package together, or update VERSIONING.md if the policy changed.');
  process.exit(1);
}

const [version] = [...byVersion.keys()];
console.log(`✓ ${published.length} published packages, all at ${version}`);
