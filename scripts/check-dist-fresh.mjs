#!/usr/bin/env node
// `pnpm test` can go green about code that is no longer there.
//
// Cross-package imports resolve through the exports map, which points at dist: `@gnldev/durable`
// inside packages/server/test resolves to packages/durable/dist/index.js, not to its src. And the
// `test` script does not build. So editing durable/src and running the suite exercises the PREVIOUS
// build of durable everywhere except durable's own tests.
//
// Not hypothetical — it cost confusing minutes repeatedly while fixing this repo, each time
// presenting as "my change had no effect".
//
// Two things this deliberately does NOT do. It does not build: that would put a full tsc in front of
// every test run, and the common case is that dist is already current. And it does not alias
// @gnldev/* to src in the vitest config: the published artifact — its exports map, its .d.ts, its
// entry points — is part of what these tests should be exercising, and aliasing would quietly stop
// testing it. It only answers the question the suite cannot ask itself: is any dist older than its src?
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = join(root, 'packages');

/** Newest mtime among files matching `re` beneath `dir`, or 0 if there are none. */
function newest(dir, re) {
  if (!existsSync(dir)) return 0;
  let max = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) max = Math.max(max, newest(p, re));
    else if (re.test(e.name)) max = Math.max(max, statSync(p).mtimeMs);
  }
  return max;
}

const SRC = /\.(ts|tsx|mts|cts)$/;
// The OLDEST artifact would hide a partial build; the newest is what a stale-vs-fresh comparison needs.
const BUILT = /\.(js|mjs|cjs)$|\.d\.ts$/;

const stale = [];
const unbuilt = [];
for (const name of readdirSync(pkgDir)) {
  const src = join(pkgDir, name, 'src');
  if (!existsSync(src)) continue; // not a compiled package
  const srcAt = newest(src, SRC);
  if (srcAt === 0) continue;
  const distAt = newest(join(pkgDir, name, 'dist'), BUILT);
  if (distAt === 0) unbuilt.push(name);
  // A second of slack: a build writing dist in the same second as the last source edit is current,
  // and timestamp granularity should not raise a false alarm.
  else if (srcAt > distAt + 1000) stale.push({ name, behindMs: srcAt - distAt });
}

if (!stale.length && !unbuilt.length) {
  console.log(`✓ every package's dist is at least as new as its src`);
  process.exit(0);
}

console.error('check-dist: the suite would run against a stale build.\n');
if (unbuilt.length) console.error(`  never built: ${unbuilt.join(', ')}`);
for (const { name, behindMs } of stale) {
  const mins = Math.round(behindMs / 60000);
  console.error(`  ${name}: src is newer than dist by ${mins >= 1 ? `${mins} min` : `${Math.round(behindMs / 1000)}s`}`);
}
console.error('\n  Cross-package imports resolve through the exports map to dist, so other packages\'');
console.error('  tests would exercise these as they were at the last build. Run `pnpm -r build`.\n');
process.exit(1);
