#!/usr/bin/env node
// Two defects that cost this repository real time, both found BY HAND and both able to come back.
// Neither is a bug in shipped behaviour, which is exactly why nothing caught them: every test passed
// while each was live.
//
// 1) A literal control byte in a source file. Both offenders used one as a field separator when
//    joining strings into a key — a sound technique, written the wrong way. The cost is not runtime,
//    it is that `grep` treats the file as binary and SAYS NOTHING: during this audit a search for
//    `'/runs'` in studio's server.ts returned no output, and the reasonable conclusion ("that route
//    does not exist") was wrong — it sits at line 1809. `git diff` shows `Bin` for the same reason, so
//    a reviewer cannot read the change either. Write the escape () and everything downstream
//    behaves; the string is byte-identical, which was verified against the fixture hash both packages
//    stamp into certificates.
//
// 2) A package with tests that never run. `pnpm -r test` dispatches through each package's `test`
//    script, so a package without one is skipped IN SILENCE — no warning, no zero count, nothing in
//    the summary to notice. @gnldev/studio sat like that with 65 test files and 718 tests, including
//    the cross-org isolation conformance suite. They all passed the moment they were wired up, which
//    is the worst version of this: nothing was broken, so nothing would ever have raised a flag.
//
// The shape both share: the failure is INVISIBLE rather than loud, so the only defence is a check
// that goes looking. That is what this file is.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.next', 'coverage', 'build', '.turbo']);
const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|css|html)$/;

/** Control bytes that have no business in a text source. Tab/LF/CR are text; the rest are not. */
const isBadByte = (b) => (b < 0x09 || (b >= 0x0b && b <= 0x1f) || b === 0x7f) && b !== 0x0a && b !== 0x0d;

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(join(dir, entry.name));
    } else if (TEXT_EXT.test(entry.name)) {
      yield join(dir, entry.name);
    }
  }
}

// ── 1. control bytes ──────────────────────────────────────────────────────────────────────────────
const dirty = [];
// The whole repository, not just packages/: the search tools this protects do not stop at a directory
// boundary, and neither does the confusion. scripts/ and examples/ were outside the manual sweep that
// found the first two, which is precisely the gap a check should not inherit.
for (const file of walk(root)) {
  const buf = readFileSync(file);
  const hits = [];
  for (let i = 0; i < buf.length; i++) {
    if (isBadByte(buf[i])) {
      const line = buf.subarray(0, i).toString('utf8').split('\n').length;
      hits.push({ line, byte: buf[i] });
      if (hits.length >= 3) break;
    }
  }
  if (hits.length) dirty.push({ file: relative(root, file), hits });
}

// ── 2. packages whose tests never run ─────────────────────────────────────────────────────────────
const unrun = [];
const pkgDir = join(root, 'packages');
for (const name of readdirSync(pkgDir)) {
  const dir = join(pkgDir, name);
  if (!statSync(dir).isDirectory()) continue;
  const manifestPath = join(dir, 'package.json');
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.scripts?.test) continue;
  // Count test files rather than trusting a `test/` directory to exist: a package may keep them
  // beside the source. Only a package that HAS tests and cannot run them is a finding — a package
  // with no tests at all is a different conversation, and not this file's.
  let count = 0;
  for (const file of walk(dir)) if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(file)) count++;
  if (count > 0) unrun.push({ name: manifest.name ?? name, count });
}

// ── report ────────────────────────────────────────────────────────────────────────────────────────
let failed = false;

if (dirty.length) {
  failed = true;
  console.error('\n✗ control bytes in text sources — grep treats these files as binary and returns');
  console.error('  NOTHING for a term that is really there; git shows the diff as `Bin`:\n');
  for (const { file, hits } of dirty) {
    const where = hits.map((h) => `line ${h.line} (0x${h.byte.toString(16).padStart(2, '0')})`).join(', ');
    console.error(`    ${file} — ${where}`);
  }
  console.error('\n  Fix: write the escape instead of the character (\\u0000, \\u0001). The string is');
  console.error('  unchanged — same bytes at runtime, same hashes — only the source becomes readable.\n');
}

if (unrun.length) {
  failed = true;
  console.error('\n✗ packages with test files but no `test` script — `pnpm -r test` skips them silently:\n');
  for (const { name, count } of unrun) console.error(`    ${name} — ${count} test file(s), never executed`);
  console.error('\n  Fix: add `"test": "vitest run"` to the package manifest. Measured once: a package');
  console.error('  in this state held 718 passing tests, including the cross-org isolation suite.\n');
}

if (failed) process.exit(1);

const scanned = [...walk(root)].length;
console.log(`✓ ${scanned} text files carry no control bytes (grep and git diff can read all of them)`);
console.log('✓ every package with test files has a `test` script (none is silently skipped)');
