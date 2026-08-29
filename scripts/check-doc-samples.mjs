#!/usr/bin/env node
// Typechecks every TypeScript code block in the documentation against the packages as built.
//
// Three consecutive review rounds found quickstarts that did not run: a package documenting a
// parameter its function never had, an import of a package that is not published, an option the
// registry silently dropped. Each was found by a person reading carefully, and each time the next
// round found another one. A person reading carefully does not scale to 26 READMEs; a compiler does.
//
// What this catches: exports that do not exist, wrong argument counts, wrong option names, wrong
// argument types. What it cannot catch: a sample that compiles and does the wrong thing at runtime.
//
// Fragments are the normal case in documentation — a block that says `const s = await scoreRun(...)`
// with no imports is still worth checking, so ambient declarations stand in for the names a doc
// block conventionally assumes. A block that is deliberately not real code (shell, pseudo-code, a
// deliberate counter-example) opts out with `<!-- doccheck: skip -->` on the line before it.
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '.doccheck');
/** Blocks not compiled because a first-party package they import is absent from THIS checkout. */
const skippedForAbsentPackage = [];

/** Names a doc block may use without defining them, declared GLOBALLY so a block that does define
 *  one shadows it rather than colliding. Every entry is a hole in the check, so this holds only what
 *  documentation genuinely elides: the object you already have, and the import line a fragment omits
 *  because the surrounding prose just showed it. */
const GLOBALS = `declare global {
  const journal: any; const storage: any; const model: any; const tools: any;
  const config: any; const cfg: any; const embed: any;
  const app: any; const api: any; const studio: any; const payments: any;
  const stripe: any; const db: any; const notify: any; const sendEmail: any;
  const chargeCard: any; const rawTools: any; const req: any; const res: any;
  const express: any; const fastify: any; const koa: any; const nestApp: any;
  const middie: any; const c2k: any; const mw: any; const runWorkflow: any;
  const scorers: any; const dataset: any; const docs: any; const vectors: any;
  const ADMIN_TOKEN: string; const publicKey: string; const secretKey: string;
  const modelId: string; const support: any; const guard: any;
  // Object-shorthand names: docs write them bare after the prose has already named them.
  const runId: string; const threadId: string; const resourceId: string; const toolCallId: string;
  const prompt: string; const messages: any; const input: any; const output: any;
  const anthropic: any; const openai: any; const myTools: any; const log: any;
  const lookupOrder: any; const observerModel: any; const rerank: any; const scorer: any;
  const handler: any; const payload: any; const meta: any; const opts: any;
  const paymentApi: any; const route: any; const hazirla: any; const siparis: any;
  const eskiModelle: any; const yeniModelle: any; const emailer: any; const bus: any;
  // Illustrative helpers a guide names in prose and then uses. Both language versions, so the
  // Turkish translation is checked as strictly as the English original.
  const prepare: any; const order: any; const check: any; const enqueue: any;
  const approve: any; const pass: any; const longText: any; const withOldModel: any;
  const withNewModel: any; const DAY: number; const GUN: number;
  const kontrolEt: any; const kuyrugaAt: any; const onayla: any; const gecir: any;
  const uzunMetin: any; const redis: any;
  const PG_URL: string;
  type Order = any; type Siparis = any;
}
declare global {
  // Framework entry points a fragment may use after the prose has shown the import.
  //
  // TYPED, not \`any\`. Declaring these opaque meant a block that used them without an import was
  // checked for nothing at all — option names, argument counts and return types were all free, which
  // is precisely what this gate exists to verify. Measured: 16 of 76 blocks reached the framework only
  // through these names, and two of them were replaced with invented API (\`runIdent\`, \`journalz\`,
  // \`thisOptionDoesNotExist\`, a third positional argument) without the gate noticing.
  //
  // The illustrative placeholders in the block above stay \`any\` on purpose: \`myTools\`, \`paymentApi\`
  // and friends are stand-ins for the reader's own code and have no type to be right about. These do.
  // Names the docs-mcp examples use after their own prose has shown the import. REAL exports are
  // typed like the entry points above — declaring them \`any\` would repeat the exact hole that made
  // 16 markdown blocks unchecked. Everything below the divider is a stand-in for the reader's own
  // code and has no type to be right about.
  const InMemoryJournal: typeof import('@gnldev/durable').InMemoryJournal;
  const toJournal: typeof import('@gnldev/durable').toJournal;
  const stepCountIs: typeof import('ai').stepCountIs;
  const roleAuth: typeof import('@gnldev/auth').roleAuth;
  const scoreRun: typeof import('@gnldev/evals').scoreRun;
  const exactMatch: typeof import('@gnldev/evals').exactMatch;
  const llmJudge: typeof import('@gnldev/evals').llmJudge;
  const datasets: typeof import('@gnldev/evals').datasets;
  const Hono: typeof import('hono').Hono;
  // ── the reader's own code ────────────────────────────────────────────────
  const buildModel: any; const makeModel: any; const makeTools: any; const makeSwapiTools: any;
  const SYSTEM: any; const bigToolset: any; const someRedisBackedStorage: any; const forkModel: any;
  const counter: any; const licenseKey: any; const fallback: any; const auth: any; const reader: any;
  const aiToolSchema: any;
  const runDurable: typeof import('@gnldev/durable').runDurable;
  const streamDurable: typeof import('@gnldev/durable').streamDurable;
  const createGnl: typeof import('@gnldev/durable').createGnl;
  const createRestApi: typeof import('@gnldev/server').createRestApi;
  const createStudioApp: typeof import('@gnldev/studio').createStudioApp;
  const createStudioRunner: typeof import('@gnldev/studio').createStudioRunner;
  const tool: typeof import('ai').tool;
  const z: typeof import('zod').z;
  const serve: typeof import('@hono/node-server').serve;
  const createServer: any;
  // A TYPE, not an \`any\`, and not the same mistake as the \`indexDocuments\` ambient this file used to
  // carry. That one legitimized a MISSING import; this one keeps a sample from repeating an import
  // the file it edits already has — \`templates/minimal/src/model.ts\` imports \`AgentConfig\` on line
  // 3, so a README block that imported it again would hand the reader a TS2300 on paste. Real type,
  // so a wrong field in the sample still fails.
  type AgentConfig = import('@gnldev/durable').AgentConfig;
  // Typing \`serve\` alone does NOT reject \`serve(createRestApi(config))\`, and it is worth knowing
  // why before someone "restores" that as a check: \`createRestApi\` returns a \`FetchHandler\`, which
  // carries a \`.fetch\`, so it structurally satisfies \`serve\`'s \`Options\` and the one-argument form
  // is genuinely well-typed. It is bad documentation, not a type error. What caught the §1.4 bug is
  // the line below.
  // The REGISTRY, typed — so a sample that calls a method it does not have, or calls one with the
  // wrong arguments, is caught like any other framework entry point above.
  //
  // Worth knowing where the boundary is: typing it here does NOT catch \`createRestApi(gnl)\`, the
  // §1.4 bug where the guide passed the registry to a function that takes the CONFIG, because every
  // field of \`CreateGnlConfig\` is optional and so every object is assignable to it. That is a limit
  // of THIS file, not of the type system — the fix belongs in the callee, and it is now there:
  // \`createRestApi\` declares \`run?: never; agent?: never\`, which rejects the registry and costs a
  // real config nothing (measured). Reach for the same shape before concluding a confusion of this
  // kind is uncatchable.
  const gnl: ReturnType<typeof import('@gnldev/durable').createGnl>;
  // The retention/lifecycle surface and \`composite\`, typed for the same reason as everything above:
  // the GUIDE blocks that use them (§5.2 storage mixing, §7.10 maintenance) carry NO import, so
  // these names were the only route to the framework and \`any\` left them unchecked. Measured escapes
  // while they were \`any\`: \`sweepRuns(journal, { olderThan })\` (the field is \`olderThanMs\` — a
  // wrong name silently means "no threshold"), \`purgeRun(journal, id, { recursive: true })\` (the
  // third parameter is a \`Set\`, on the GDPR delete path), and \`composite\` taking \`runs\` in its
  // overrides, which the function's own comment calls out as breaking replay.
  const composite: typeof import('@gnldev/durable').composite;
  const sweepRuns: typeof import('@gnldev/durable').sweepRuns;
  const purgeRun: typeof import('@gnldev/durable').purgeRun;
  const rolloverRun: typeof import('@gnldev/durable').rolloverRun;
  const PostgresStorage: typeof import('@gnldev/durable/postgres').PostgresStorage;
}
export {};`;

/** Where each external module a doc block imports actually lives in this pnpm tree.
 *  `paths` must name the TYPE ENTRY, not the directory — a bare directory does not resolve under
 *  NodeNext, which is why an earlier version of this script reported every external import missing. */
function externalPaths() {
  const wanted = ['ai', 'zod', 'hono', '@hono/node-server', '@ai-sdk/openai', '@ai-sdk/anthropic', '@ai-sdk/provider'];
  const out = [];
  for (const m of wanted) {
    for (const p of readdirSync(join(ROOT, 'packages'))) {
      const dir = join(ROOT, 'packages', p, 'node_modules', m);
      const manifest = join(dir, 'package.json');
      if (!existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
      const t = pkg.types ?? pkg.typings ?? pkg.exports?.['.']?.types ?? pkg.exports?.['.']?.import?.types;
      if (!t) break;
      out.push([m, [relative(OUT, join(dir, String(t))).replace(/\\/g, '/')]]);
      break;
    }
  }
  return out;
}

/** Every workspace package and each of its documented export subpaths, mapped to its BUILT types.
 *  Against dist, not src: what a reader can call is what the published .d.ts says, and pointing at
 *  src would additionally re-typecheck the whole source tree under this config — which reports
 *  differences between two tsconfigs as if they were documentation defects. */
function packagePaths() {
  const out = [];
  for (const p of readdirSync(join(ROOT, 'packages'))) {
    const manifest = join(ROOT, 'packages', p, 'package.json');
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    const base = `../packages/${p}`;
    out.push([pkg.name, [`${base}/dist/index.d.ts`]]);
    for (const [sub, target] of Object.entries(pkg.exports ?? {})) {
      if (sub === '.' || !sub.startsWith('./')) continue;
      // './sqlite' points at dist/sqlite-storage.js in the manifest; the source has the same name.
      const dist = typeof target === 'string' ? target : (target?.types ?? target?.default ?? '');
      const file = String(dist).replace(/^\.\/dist\//, '').replace(/\.d\.ts$|\.js$/, '');
      out.push([`${pkg.name}/${sub.slice(2)}`, [`${base}/dist/${file || sub.slice(2)}.d.ts`]]);
    }
  }
  return out;
}

function docFiles() {
  const out = [];
  for (const f of ['README.md', 'README.tr.md']) if (existsSync(join(ROOT, f))) out.push(join(ROOT, f));
  for (const f of readdirSync(join(ROOT, 'docs'))) if (f.endsWith('.md')) out.push(join(ROOT, 'docs', f));
  for (const p of readdirSync(join(ROOT, 'packages'))) {
    const r = join(ROOT, 'packages', p, 'README.md');
    if (existsSync(r)) out.push(r);
  }
  // Examples and scaffold templates. They were outside this gate while being the most copy-pasted
  // code in the repo — the README points readers straight at them, and a template's README is the
  // first thing a `gnl init` user reads. Nothing checked them: the examples have no build step, and
  // vitest excludes them.
  for (const dir of ['examples', join('packages', 'cli', 'templates')]) {
    const base = join(ROOT, dir);
    if (!existsSync(base)) continue;
    for (const p of readdirSync(base)) {
      const r = join(base, p, 'README.md');
      if (existsSync(r)) out.push(r);
    }
  }
  return out;
}

/** Fenced ```ts / ```typescript / ```tsx blocks, with the 1-based line where each starts. */
function blocks(text) {
  const lines = text.split('\n');
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    // tsx included: the one sample the old regex skipped was the client React quickstart — the most
    // copy-pasted adapter surface, and precisely the class of silent doc-rot this script exists to end.
    const fence = /^```(ts|typescript|tsx)\s*$/.exec(lines[i]);
    if (!fence) continue;
    if (/doccheck:\s*skip/.test(lines[i - 1] ?? '')) continue;
    const start = i + 1;
    let j = i + 1;
    while (j < lines.length && !/^```\s*$/.test(lines[j])) j++;
    found.push({ line: start + 1, code: lines.slice(start, j).join('\n'), lang: fence[1] });
    i = j;
  }
  return found;
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

/**
 * The examples embedded in @gnldev/docs-mcp — what an AI assistant is handed when it asks about a
 * feature — checked with the same compiler as the markdown.
 *
 * Nothing compiled these. The model-fallback example gave `[{ model: 'openai:gpt-4o' }, …]`: no `spec`
 * field and a STRING where a model instance belongs, so it constructed silently and threw
 * `TypeError: m.doGenerate is not a function` on the first call — while the `apis` line directly above
 * it in the same record said `FallbackCandidate — { spec, model }`. The record contradicted itself and
 * both halves shipped.
 *
 * Read from the BUILT module rather than by parsing the source: what ships is the built value, and a
 * regex over a template literal would have its own bugs.
 */
function embeddedExamples() {
  const dist = join(ROOT, 'packages', 'docs-mcp', 'dist', 'content.js');
  if (!existsSync(dist)) return [];
  const out = [];
  try {
    const { FEATURES } = require(dist);
    for (const f of FEATURES ?? []) {
      if (!f?.example?.trim()) continue;
      // Same opt-out the markdown blocks have. A few examples are deliberately NOT TypeScript —
      // agent-versioning shows HTTP request and response bodies — and compiling those would report
      // a syntax error against text that is correct for what it is.
      if (/doccheck:\s*skip/.test(f.example)) continue;
      // `install` is a shell command for most features (`pnpm add …`) and an import line for a few.
      // Only the second kind is code; prepending the first would fail every block on its own text.
      const preamble = /^\s*import\b/.test(f.install ?? '') ? `${f.install}\n` : '';
      out.push({ slug: f.slug, code: `${preamble}${f.example}` });
    }
  } catch { return []; }
  return out;
}

const cases = [];
for (const file of docFiles()) {
  const rel = relative(ROOT, file);
  blocks(readFileSync(file, 'utf8')).forEach((b, n) => {
    const name = `${rel.replace(/[^a-z0-9]/gi, '_')}__${n}.${b.lang === 'tsx' ? 'tsx' : 'ts'}`;
    // `export {}` keeps each block a module, so `const` in two blocks cannot collide.
    //
    // `prompt` is declared HERE rather than in _globals.d.ts because lib.dom also declares it — as a
    // function — and a global ambient cannot outrank another global. A module-scope declaration can.
    // This went unnoticed while the framework entry points were `any`: nothing looked closely enough
    // at what was passed to them to care that `prompt` was a function.
    const prefix = 'export {};\ndeclare const prompt: string;\n';
    writeFileSync(join(OUT, name), `${prefix}${b.code}\n`);
    // Counted, not derived: a wrong offset points the reader at the wrong line, which is worse than
    // pointing at none.
    cases.push({ name, rel, line: b.line, prefixLines: prefix.split('\n').length - 1 });
  });
}
/**
 * Package names this repository actually contains. A sample importing something that is not here
 * cannot be typechecked here, and that is a fact about the checkout rather than a defect in the sample.
 *
 * The case that forced this: @gnldev/docs-mcp ships five examples for the PAID auth tier, which
 * imports `@gnldev/auth-ee`. That package exists in the private monorepo and is deliberately absent
 * from the public snapshot, so the same five blocks typechecked in one tree and failed with TS2307 in
 * the other — and the public tree is the one CI gates a release on. Measured: `pnpm check:docs` exited
 * 1 there, which would have turned the first push red and stopped the v0.1.0 tag from ever reaching npm.
 *
 * Deliberately NOT solved with a `doccheck: skip` marker in the examples: that text is what an AI
 * assistant is handed when it asks how the paid tier works, and it would carry a build-system comment
 * into the answer. Deliberately not solved in the snapshot generator either — a rule that lives in the
 * publishing script only holds for what that script produces, and this one is true of any checkout.
 *
 * Scoped to first-party names on purpose. A missing THIRD-party package is the existing
 * `_modules.d.ts` ambient-declaration path, which keeps the check about our API rather than about
 * which optional packages happen to be installed.
 */
const OWN_PACKAGES = new Set(
  readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      try { return JSON.parse(readFileSync(join(ROOT, 'packages', d.name, 'package.json'), 'utf8')).name; }
      catch { return undefined; }
    })
    .filter(Boolean),
);

/** The first-party package a block imports that this checkout does not have, if any. */
function missingOwnImport(code) {
  for (const m of code.matchAll(/from\s+['"](@gnldev\/[a-z0-9-]+)(?:\/[^'"]*)?['"]/g)) {
    if (!OWN_PACKAGES.has(m[1])) return m[1];
  }
  return undefined;
}

for (const ex of embeddedExamples()) {
  const absent = missingOwnImport(ex.code);
  if (absent) { skippedForAbsentPackage.push(`packages/docs-mcp/src/content.ts (${ex.slug}) — imports ${absent}`); continue; }
  const name = `docsmcp__${ex.slug.replace(/[^a-z0-9]/gi, '_')}.ts`;
  const prefix = 'export {};\ndeclare const prompt: string;\n';
  writeFileSync(join(OUT, name), `${prefix}${ex.code}\n`);
  cases.push({ name, rel: `packages/docs-mcp/src/content.ts (${ex.slug})`, line: 1, prefixLines: 2 });
}

writeFileSync(join(OUT, '_globals.d.ts'), GLOBALS);
// Optional peers a doc block imports to show an integration. In a SCRIPT file (no import/export)
// these are ambient declarations; inside a module they would be augmentations, and a package that is
// not installed cannot be augmented. Keeps the check about OUR API rather than about which optional
// packages happen to be present on this machine.
writeFileSync(join(OUT, '_modules.d.ts'), [
  "declare module '@ai-sdk/anthropic' { export const anthropic: any; }",
  "declare module '@ai-sdk/openai' { export const openai: any; export const createOpenAI: any; }",
  "declare module '@ag-ui/client' { export const HttpAgent: any; export const AbstractAgent: any; }",
].join('\n'));
writeFileSync(join(OUT, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
    // Samples elide error handling and exhaustive types on purpose; the point is the API shape.
    strict: false, noEmit: true, skipLibCheck: true, allowJs: true,
    // react-jsx would demand react's type packages for every sample run; 'preserve' typechecks the
    // TSX shapes without requiring the runtime's types — the point is the API surface, not the JSX transform.
    jsx: 'preserve',
    baseUrl: '.', types: ['node'],
    paths: Object.fromEntries([...externalPaths(), ...packagePaths()]),
  },
  include: ['*.ts', '*.tsx', '_globals.d.ts', '_modules.d.ts'],
}, null, 2));

console.log(`doc samples: ${cases.length} block(s) from ${docFiles().length} file(s)`);
// Named, never silent. A skipped block reads as a checked block in a green run, and this checker's
// whole value is that a reader can trust "every documented sample typechecks" to mean every one.
for (const skipped of skippedForAbsentPackage) {
  console.log(`  \x1b[33m∼\x1b[0m not checked here: ${skipped} (absent from this checkout)`);
}

let raw = '';
try {
  execFileSync('npx', ['tsc', '-p', join(OUT, 'tsconfig.json')], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
} catch (e) {
  raw = `${e.stdout ?? ''}${e.stderr ?? ''}`;
}

if (!raw.trim()) {
  const qualifier = skippedForAbsentPackage.length
    ? ` (${skippedForAbsentPackage.length} not checked here — see above)` : '';
  console.log(`  \x1b[32m✓\x1b[0m every documented sample typechecks against the packages as built${qualifier}`);
  process.exit(0);
}

// Report against the MARKDOWN location, not the generated file — the generated file is an artifact.
const byCase = new Map(cases.map((c) => [c.name, c]));
const seen = new Set();
for (const line of raw.split('\n')) {
  const m = line.match(/^(.+?)\((\d+),(\d+)\):\s*(error TS\d+:.*)$/);
  if (!m) continue;
  const c = byCase.get(m[1].split('/').pop());
  if (!c) continue;
  const docLine = c.line + Math.max(0, Number(m[2]) - c.prefixLines - 1);
  const key = `${c.rel}:${docLine}:${m[4]}`;
  if (seen.has(key)) continue;
  seen.add(key);
  console.log(`  \x1b[31m✗\x1b[0m ${c.rel}:${docLine}  ${m[4]}`);
}
if (seen.size === 0) {
  // tsc failed but nothing mapped back to a doc block: that is a fault in this script or in the
  // build, and silently reporting "0 problems" would be the worst possible outcome for a gate.
  console.log('  \x1b[31m✗\x1b[0m tsc failed with output this script could not attribute to a sample:');
  console.log(raw.split('\n').slice(0, 12).map((l) => `      ${l}`).join('\n'));
  process.exit(1);
}
console.log(`\n${seen.size} problem(s) in documented samples.`);
console.log('Fix the sample, or mark the block with an HTML comment `doccheck: skip` if it is not real code.');
process.exit(1);
