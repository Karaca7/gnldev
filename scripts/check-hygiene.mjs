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
// 3) A door package that needs another door package. ADR-0002 point 0: chat-adapter, agui and mcp
//    each work on their own, without any other door and without a composition package (server,
//    studio). @gnldev/agui depended on @gnldev/server for two error codes and one type, so installing
//    agui alone pulled in server (measured with `npm install` of the packed tarballs). Nothing failed:
//    every test runs in the workspace, where server is always there. This check reads the manifests
//    and the sources.
//
// 4) A `"sideEffects"` promise that is not true. Every published package with an exports map says
//    `"sideEffects": false` (or lists the executables that are the exception), and webpack and rollup
//    act on it: they DROP a module whose exports go unused, without running it. Measured on the
//    built dist, one export each, bytes before → after the field was added: `RunBusyError` from
//    @gnldev/durable 5502 → 188 (webpack) and 2025 → 99 (rollup); `buildOpenApi` from @gnldev/server
//    12482 → 5822 and 8747 → 5741; `enqueue` from @gnldev/queue 8892 → 3637. esbuild reads the
//    field too: the showcase bundle of the whole durable core went from 61.5 to 57.4 KiB gzip (and
//    129.2 → 125.1 with the AI SDK). The price is that the promise must stay TRUE: a module that installs
//    a global, a process listener or a timer when imported would be silently skipped in a user's
//    bundle and in no test, because tests do not bundle. So this check imports every dist module the
//    manifest calls side-effect free, in a fresh process, and fails on any observable top-level
//    effect. It needs a build (`pnpm -r build`), which CI runs first.
//
// The shape all four share: the failure is INVISIBLE rather than loud, so the only defence is a
// check that goes looking. That is what this file is.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Child mode for section 4: import each module given on the command line, one after another, and
// print what changed after each. A child, so a module that starts a timer cannot hold this process.
if (process.argv[2] === '--probe-side-effects') {
  await probeSideEffects(process.argv.slice(3));
  process.exit(0);
}
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

// ── 3. door packages that need another door ───────────────────────────────────────────────────────
// Directory name → what it may never need. A door may use durable and auth (the shared contract and
// the shared functions), never a sibling door and never a package that composes the doors.
const DOORS = ['chat-adapter', 'agui', 'mcp'];
const FORBIDDEN = new Set(['@gnldev/server', '@gnldev/studio', ...DOORS.map((d) => `@gnldev/${d}`)]);
// What a consumer installs. devDependencies are not installed by a consumer, so they are not checked.
const INSTALLED = ['dependencies', 'peerDependencies', 'optionalDependencies'];
const IMPORT_OF = /\bfrom\s+['"](@gnldev\/[a-z0-9-]+)(?:\/[^'"]*)?['"]|\bimport\(\s*['"](@gnldev\/[a-z0-9-]+)(?:\/[^'"]*)?['"]\s*\)/g;
const coupled = [];
for (const door of DOORS) {
  const dir = join(pkgDir, door);
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  for (const field of INSTALLED) {
    for (const dep of Object.keys(manifest[field] ?? {})) {
      if (FORBIDDEN.has(dep) && dep !== manifest.name) coupled.push(`${manifest.name} — package.json ${field} lists ${dep}`);
    }
  }
  // A source import with no declared dependency fails to build under pnpm, but a type-only import
  // can still slip through a hoisted install. Read the sources too.
  const src = join(dir, 'src');
  if (!existsSync(src)) continue;
  for (const file of walk(src)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(IMPORT_OF)) {
      const dep = m[1] ?? m[2];
      if (FORBIDDEN.has(dep) && dep !== manifest.name) coupled.push(`${manifest.name} — ${relative(root, file)} imports ${dep}`);
    }
  }
}

// ── 4. the sideEffects promise ────────────────────────────────────────────────────────────────────
// Which packages: published ones with an exports map. create-gnl (a bin, nothing to import) and
// studio-ui (browser assets served by studio, which mount the app when loaded) have none, and the
// field would say nothing true about them.
const promise = [];
// A build that is missing or incomplete is not a broken promise, and must not read as one: with one
// package's dist absent, every module importing it throws, and the report blamed a dozen innocent
// files and advised moving an effect that did not exist. So it is its own finding, and the probe
// does not run on a tree it cannot read.
const unbuilt = [];
const probeByPkg = new Map();
const gnlDepsOf = new Map();
for (const name of readdirSync(pkgDir)) {
  const dir = join(pkgDir, name);
  const manifestPath = join(dir, 'package.json');
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.private || !manifest.exports) continue;
  const se = manifest.sideEffects;
  const listed = Array.isArray(se) ? se : [];
  if (se !== false && !(Array.isArray(se) && se.every((e) => typeof e === 'string' && !e.includes('*')))) {
    promise.push(`${manifest.name} — package.json has no "sideEffects": false (or a list of exact paths)`);
    continue;
  }
  const dist = join(dir, 'dist');
  if (!existsSync(dist)) { unbuilt.push(`${manifest.name} — no dist/`); continue; }
  // An exception that names a missing file is stale, and a stale list hides nothing but misleads.
  for (const entry of listed) if (!existsSync(join(dir, entry))) promise.push(`${manifest.name} — "sideEffects" lists ${entry}, which the build does not produce`);
  const exempt = new Set(listed.map((e) => join(dir, e)));
  const js = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? js(join(d, e.name)) : /\.m?js$/.test(e.name) ? [join(d, e.name)] : []);
  probeByPkg.set(manifest.name, js(dist).filter((file) => !exempt.has(file)));
  gnlDepsOf.set(manifest.name, Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }).filter((d) => d.startsWith('@gnldev/')));
}
// Import order decides who is blamed: an effect is charged to the first file whose import made it, so
// every file goes after what it imports — packages after their @gnldev dependencies, files after the
// relative files they import. Then the file charged is the file that does it.
const toProbe = [];
const seenPkg = new Set();
const seenFile = new Set();
const RELATIVE_IMPORT = /(?:\bfrom|\bimport)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g;
const visitFile = (file, own) => {
  if (seenFile.has(file) || !own.has(file)) return;
  seenFile.add(file);
  for (const m of readFileSync(file, 'utf8').matchAll(RELATIVE_IMPORT)) visitFile(join(dirname(file), m[1]), own);
  toProbe.push(file);
};
const visitPkg = (name) => {
  if (seenPkg.has(name) || !probeByPkg.has(name)) return;
  seenPkg.add(name);
  for (const dep of gnlDepsOf.get(name)) visitPkg(dep);
  const own = new Set(probeByPkg.get(name));
  for (const file of own) visitFile(file, own);
};
for (const name of probeByPkg.keys()) visitPkg(name);
if (toProbe.length && !unbuilt.length) {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--probe-side-effects', ...toProbe], { encoding: 'utf8', timeout: 120_000 });
  const report = child.stdout.split('\n').find((l) => l.startsWith('@@effects@@'));
  if (!report) {
    promise.push(`the import probe did not finish (${child.signal ? `killed by ${child.signal} — a module kept the process alive` : `exit ${child.status}`}): ${(child.stderr || '').trim().split('\n').slice(-3).join(' | ')}`);
  } else {
    // A dist file that imports a file the build did not produce: the build is incomplete, not the
    // promise. One line per missing file — every module above it throws the same error.
    const importersOf = new Map();
    for (const { file, found, missing } of JSON.parse(report.slice('@@effects@@'.length))) {
      if (missing) importersOf.set(missing, (importersOf.get(missing) ?? 0) + 1);
      else promise.push(`${relative(root, file)} — ${found.join(', ')}`);
    }
    for (const [missing, n] of importersOf) unbuilt.push(`${missing} — not built (${n} module${n === 1 ? '' : 's'} import it)`);
  }
}

// ── report ────────────────────────────────────────────────────────────────────────────────────────
let failed = false;

if (unbuilt.length) {
  failed = true;
  console.error('\n✗ the build is missing or incomplete — the sideEffects check reads dist/, so it has not run:\n');
  for (const line of unbuilt) console.error(`    ${line}`);
  console.error('\n  Fix: `pnpm -r build`, then run this again. Nothing here says a module has an effect.\n');
}

if (promise.length) {
  failed = true;
  console.error('\n✗ a "sideEffects" promise that does not hold — a bundler skips these modules when their');
  console.error('  exports go unused, so the effect silently disappears from a user\'s bundle:\n');
  for (const line of promise) console.error(`    ${line}`);
  console.error('\n  Fix: move the effect into a function the caller runs. If the file is an executable (a bin),');
  console.error('  name it in the package\'s "sideEffects" list instead: `"sideEffects": ["./dist/cli.js"]`.\n');
}

if (coupled.length) {
  failed = true;
  console.error('\n✗ a door package needs another door or a composition package (ADR-0002 point 0):\n');
  for (const line of coupled) console.error(`    ${line}`);
  console.error('\n  Fix: move what it needs down to @gnldev/durable or @gnldev/auth, which every door already');
  console.error('  depends on, and import it from there. A developer who installs only this door must get a');
  console.error('  working door.\n');
}

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
console.log(`✓ no door package (${DOORS.join(', ')}) needs another door, @gnldev/server or @gnldev/studio`);
console.log(`✓ ${toProbe.length} dist modules the manifests call side-effect free import with no top-level effect`);

/**
 * Imports each file in turn and reports, per file, what changed in state any other code can observe:
 * globalThis, the prototypes and statics of the builtins, process listeners, Error hooks, and
 * resources that keep the event loop alive. A change is charged to the first file whose import made it.
 */
async function probeSideEffects(files) {
  // Set by zod v4 on its first load; it arrives through `ai`, a dependency, not from GNL code.
  // Measured: `import('ai')` alone, in a package that resolves zod@4, adds exactly these two.
  const DEPENDENCY_GLOBALS = new Set(['__zod_globalConfig', '__zod_globalRegistry']);
  const BUILTINS = { Object, Array, Promise, Function, String, Number, Map, Set, Error, RegExp, Date, Symbol, JSON, Math, Reflect };
  const own = (o) => { const m = new Map(); for (const k of Reflect.ownKeys(o)) { const d = Object.getOwnPropertyDescriptor(o, k); m.set(String(k), d && ('value' in d ? d.value : d.get)); } return m; };
  const count = (list) => list.reduce((m, r) => m.set(r, (m.get(r) ?? 0) + 1), new Map());
  const snap = () => {
    const s = new Map([['globalThis', own(globalThis)]]);
    for (const [n, c] of Object.entries(BUILTINS)) { s.set(n, own(c)); if (c.prototype) s.set(`${n}.prototype`, own(c.prototype)); }
    s.set('process listeners', new Map(process.eventNames().map((e) => [String(e), process.listenerCount(e)])));
    s.set('live resources', count(process.getActiveResourcesInfo().filter((r) => r !== 'Immediate')));
    return s;
  };
  const diff = (a, b) => {
    const out = [];
    for (const [where, now] of b) {
      const was = a.get(where);
      for (const [k, v] of now) if (!was.has(k)) out.push(`${where}: ${k} added`); else if (was.get(k) !== v && !(Number.isNaN(v) && Number.isNaN(was.get(k)))) out.push(`${where}: ${k} changed`);
      for (const k of was.keys()) if (!now.has(k)) out.push(`${where}: ${k} removed`);
    }
    return out.filter((l) => ![...DEPENDENCY_GLOBALS].some((g) => l === `globalThis: ${g} added`));
  };
  // Warm-up. Reading the descriptor of a lazy global (FormData) makes node load undici, which adds
  // Symbol(undici.globalDispatcher.1) to globalThis — the probe's own doing, so it happens here first.
  await import('data:text/javascript,');
  snap();
  await new Promise((r) => setImmediate(r));
  const found = [];
  let before = snap();
  for (const file of files) {
    try { await import(pathToFileURL(file).href); } catch (e) {
      const missingDist = e?.code === 'ERR_MODULE_NOT_FOUND' && /\/dist\//.test(String(e?.url ?? e?.message ?? ''));
      if (missingDist) found.push({ file, missing: relative(root, fileURLToPath(e.url ?? pathToFileURL(file))) });
      else found.push({ file, found: [`import threw: ${String(e?.message ?? e).split('\n')[0]}`] });
    }
    await new Promise((r) => setImmediate(r));
    const after = snap();
    const d = diff(before, after);
    if (d.length) found.push({ file, found: d });
    before = after;
  }
  process.stdout.write(`\n@@effects@@${JSON.stringify(found)}\n`);
}
