// Emits dist/THIRD-PARTY-NOTICES.txt after the Vite build.
//
// WHY this package and no other: the other 24 packages compile with `tsc`, so their dist contains
// only their OWN code and their dependencies stay declared in package.json for npm to resolve.
// studio-ui is bundled with Vite — React, recharts, framer-motion, the Geist fonts and everything
// they pull in are COPIED INTO dist/assets/*.js. Redistributing that code carries the licenses'
// one condition: MIT/ISC/BSD all require the copyright notice to travel with the copy, and the
// fonts' OFL-1.1 is more explicit still. This file is that notice.
//
// Generated on every build on purpose. A hand-maintained notices file rots the moment a dependency
// changes and then quietly misstates compliance; this one cannot drift.
//
// Scope is the full PRODUCTION dependency tree, not just the direct ones. Vite inlines transitive
// code too (react-markdown alone pulls in the whole unified/remark/micromark family), and
// over-attributing is harmless while under-attributing is the thing to avoid.
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(PKG_DIR, '..', '..');
const OUT = join(PKG_DIR, 'dist', 'THIRD-PARTY-NOTICES.txt');

const LICENSE_FILES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md', 'license', 'COPYING'];

/** pnpm keeps every package at node_modules/.pnpm/<name>@<version>/node_modules/<name>. Direct deps
 *  are symlinks into that store, so resolving a name means checking the local link first, then the
 *  store (whose directory name mangles scopes as `@scope+name`). */
function resolvePackageDir(name, fromDir) {
  const local = join(fromDir, 'node_modules', name);
  if (existsSync(join(local, 'package.json'))) return local;

  const rootLocal = join(REPO_ROOT, 'node_modules', name);
  if (existsSync(join(rootLocal, 'package.json'))) return rootLocal;

  const store = join(REPO_ROOT, 'node_modules', '.pnpm');
  if (!existsSync(store)) return null;
  const mangled = `${name.replace('/', '+')}@`;
  const hit = readdirSync(store).find((d) => d.startsWith(mangled));
  if (!hit) return null;
  const dir = join(store, hit, 'node_modules', name);
  return existsSync(join(dir, 'package.json')) ? dir : null;
}

function readLicenseText(dir) {
  for (const f of LICENSE_FILES) {
    const p = join(dir, f);
    if (existsSync(p)) {
      try { return readFileSync(p, 'utf8').trim(); } catch { /* unreadable → fall through */ }
    }
  }
  return null;
}

const seen = new Map();   // "name@version" -> record
const missing = [];       // packages with neither a license file nor an SPDX field

function collect(name, fromDir) {
  const dir = resolvePackageDir(name, fromDir);
  if (!dir) return;

  let pkg;
  try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); } catch { return; }

  const key = `${pkg.name}@${pkg.version}`;
  if (seen.has(key)) return;

  const spdx = typeof pkg.license === 'string'
    ? pkg.license
    : (pkg.license?.type ?? (Array.isArray(pkg.licenses) ? pkg.licenses.map((l) => l.type).join(' OR ') : null));
  const text = readLicenseText(dir);

  seen.set(key, { name: pkg.name, version: pkg.version, spdx, text, homepage: pkg.homepage ?? null });
  if (!text && !spdx) missing.push(key);

  for (const dep of Object.keys(pkg.dependencies ?? {})) collect(dep, dir);
}

const rootPkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'));
// devDependencies, not dependencies: this package PUBLISHES only `dist` (Vite has already inlined
// every library into the bundle), so nothing needs to be resolved at install time and the whole tree
// is declared as dev. The attribution duty is unchanged — the code still travels inside dist — so the
// walk must start from the dev tree. (Both are read, so the file stays correct either way.)
const rootDeps = { ...(rootPkg.dependencies ?? {}), ...(rootPkg.devDependencies ?? {}) };
// Build-only tooling is NOT redistributed (vite/vitest/tsc/postcss and friends never enter dist), so
// attributing them would misstate what's actually shipped.
const TOOLING = new Set([
  'vite', '@vitejs/plugin-react', 'vitest', 'typescript', 'postcss', 'autoprefixer', 'tailwindcss',
  'jsdom', '@testing-library/dom', '@testing-library/react', '@types/react', '@types/react-dom',
]);
for (const dep of Object.keys(rootDeps)) {
  if (!TOOLING.has(dep)) collect(dep, PKG_DIR);
}

// A package with no license file AND no `license` field is a genuine unknown — someone has to look
// at it. Failing here is deliberate: shipping a notices file that silently omits a package is worse
// than a red build.
if (missing.length) {
  console.error(`third-party-notices: no license information for ${missing.length} package(s):`);
  for (const m of missing) console.error(`  - ${m}`);
  process.exit(1);
}

const entries = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
const bySpdx = entries.reduce((acc, e) => ({ ...acc, [e.spdx ?? 'UNKNOWN']: (acc[e.spdx ?? 'UNKNOWN'] ?? 0) + 1 }), {});

const header = [
  `${rootPkg.name} — third-party notices`,
  '',
  'This build bundles the packages below into dist/assets/*.js. Their licenses permit that; the',
  'condition they share is that these notices travel with the copy. Generated at build time from',
  'the installed dependency tree — do not edit by hand.',
  '',
  `Packages: ${entries.length}`,
  ...Object.entries(bySpdx).sort((a, b) => b[1] - a[1]).map(([l, n]) => `  ${String(n).padStart(4)}  ${l}`),
  '',
].join('\n');

const body = entries.map((e) => {
  const head = [
    '='.repeat(78),
    `${e.name}@${e.version}${e.spdx ? ` — ${e.spdx}` : ''}`,
    ...(e.homepage ? [e.homepage] : []),
    '',
  ].join('\n');
  // No license file shipped: the SPDX identifier in package.json is the grant. Say so plainly
  // rather than pasting a canonical text the author never actually included.
  return head + (e.text ?? `(No license file shipped with this package; declared as ${e.spdx} in its package.json.)`);
}).join('\n\n');

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${header}\n${body}\n`);

const noFile = entries.filter((e) => !e.text).length;
console.log(`third-party-notices: ${entries.length} package(s) → dist/THIRD-PARTY-NOTICES.txt${noFile ? ` (${noFile} without a license file, SPDX recorded)` : ''}`);
