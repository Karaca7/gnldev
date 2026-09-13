#!/usr/bin/env node
// Every error code this framework puts on the wire has a page a reader can reach.
//
// The codes are the good part of the taxonomy: `run_input_mismatch` is stable, greppable, and the
// same string in the HTTP body, the SSE frame and the client library. What it is not is
// self-explanatory — a caller who receives it knows only that something is mismatched, and the
// sentence beside it is written for the moment of failure, not for the ten minutes afterwards when
// somebody has to decide whether their retry logic is wrong.
//
// So: one page per code, named by the code, holding the three things the error body cannot carry — the
// full story of what happened, why the framework refused instead of continuing, and the ways out.
// This script is what keeps that promise true. A new code added to either map without a page turns
// this red, which is the only reliable moment to write one: the author has the context, and nobody
// afterwards does.
//
// It also reports the reverse — a page whose code no longer exists. A stale page is worse than a
// missing one, because it reads as current: the same reason `client-subject-conformance.test.ts`
// asserts that no exemption outlives its route.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = join(ROOT, 'docs', 'errors');

/**
 * The maps are read from the BUILT module, not parsed out of the source.
 *
 * What ships is the built value, and a regex over a TypeScript object literal would have its own bugs
 * — the same reasoning `check-doc-samples.mjs` gives for reading docs-mcp's examples out of dist.
 */
/**
 * The five families, each read from the module that OWNS it.
 *
 * There used to be a fourth source here: a hand-written `EDGE_CODES` object listing the three codes
 * the HTTP edge spelled inline, with a comment admitting that a fourth literal added tomorrow would
 * be caught by nothing. It was measured, and it had already happened — six more edge codes and four
 * upstream ones were on the wire with no page, invisible to this check because they lived in no
 * enumerable value. The fix was to give them one: `EDGE_ERROR_CODES` in @gnldev/server (route-level
 * codes, statuses attached — see the file's header for why not durable) and `UPSTREAM_ERROR_CODES`
 * in @gnldev/durable, where the classifier that produces them already lives. This script now has no
 * list of its own, which is the only version of it that stays true.
 */
const SOURCES = [
  { dist: ['packages', 'durable', 'dist', 'errors.js'], build: '@gnldev/durable', status: 'WIRE_ERROR_STATUS', maps: {
    CALLER_CONFLICT_CODES: (cls) => `caller-conflict (${cls})`,
    BLOCKED_ERROR_CODES: (cls) => `blocked (${cls})`,
    UPSTREAM_ERROR_CODES: (cls) => `upstream (${cls})`,
  } },
  { dist: ['packages', 'server', 'dist', 'edge-errors.js'], build: '@gnldev/server', status: 'EDGE_ERROR_STATUS', maps: {
    EDGE_ERROR_CODES: (cls) => `HTTP edge (${cls})`,
  } },
  { dist: ['packages', 'studio', 'dist', 'error-codes.js'], build: '@gnldev/studio', status: 'STUDIO_ERROR_STATUS', maps: {
    STUDIO_ERROR_CODES: (cls) => `operator console (${cls})`,
  } },
];

/** Every code on the wire, with the family it belongs to (shown in the failure message). */
const codes = new Map();
/**
 * Every code's HTTP status, read from the `*_STATUS` map next to the codes map that owns it.
 *
 * The status used to live in three unlinked places — the route literal, a JSDoc sentence, the docs
 * page — and this script compared none of them. That was measured before it was fixed:
 * `dead_scan_busy` taught 409 on two doc surfaces while its route answered 429, and CI stayed green.
 * Now the page's `**HTTP nnn` line and the README's status column are both bound to the map, and a
 * code with no status entry fails outright — the author who adds a code knows its status; nobody
 * afterwards does.
 */
const statuses = new Map();
for (const src of SOURCES) {
  const dist = join(ROOT, ...src.dist);
  if (!existsSync(dist)) {
    console.error(`\x1b[31m✗\x1b[0m ${dist} is missing — run \`pnpm --filter ${src.build} build\` first.`);
    process.exit(1);
  }
  const mod = await import(`file://${dist}`);
  for (const [name, family] of Object.entries(src.maps)) {
    const map = mod[name];
    // A map that vanished is not "no codes to check" — it is this script silently covering less than
    // it says. The rename that removes an export must be seen here, not absorbed.
    if (!map || typeof map !== 'object') {
      console.error(`\x1b[31m✗\x1b[0m ${name} is not exported by ${dist} — the map moved or was renamed; point this check at its new home.`);
      process.exit(1);
    }
    for (const [cls, code] of Object.entries(map)) codes.set(code, family(cls));
  }
  const statusMap = mod[src.status];
  if (!statusMap || typeof statusMap !== 'object') {
    console.error(`\x1b[31m✗\x1b[0m ${src.status} is not exported by ${dist} — the status map moved or was renamed; point this check at its new home.`);
    process.exit(1);
  }
  for (const [code, status] of Object.entries(statusMap)) statuses.set(code, status);
}

/**
 * What a page has to contain before it counts as one.
 *
 * Deliberately structural rather than a word count. A page is three questions, and a file that
 * answers two of them is the half-written page somebody will trust: the shape is the contract, the
 * prose is the author's.
 */
const REQUIRED_SECTIONS = ['## What happened', '## Why', '## What to do'];

const missing = [];
const incomplete = [];
const statusWrong = [];
for (const [code, family] of codes) {
  const file = join(PAGES, `${code}.md`);
  if (!existsSync(file)) { missing.push({ code, family }); continue; }
  const text = readFileSync(file, 'utf8');
  const absent = REQUIRED_SECTIONS.filter((s) => !text.includes(s));
  // The code itself must appear verbatim: the page is found by searching for the string the caller
  // was handed, and a page that never spells it is a page that search does not reach.
  if (!text.includes(code)) absent.push(`the code \`${code}\` itself`);
  // The page's status line must agree with the map — the page is where a caller learns what number
  // to branch on, and a page teaching a stale status reads as current forever.
  const want = statuses.get(code);
  if (want === undefined) {
    statusWrong.push({ code, where: `no status entry in the owning \`*_STATUS\` map` });
  } else {
    const m = /\*\*HTTP (\d{3})/.exec(text);
    if (!m) absent.push(`an \`**HTTP ${want}\` status line`);
    else if (Number(m[1]) !== want) statusWrong.push({ code, where: `docs/errors/${code}.md says ${m[1]}, the status map says ${want}` });
  }
  if (absent.length) incomplete.push({ code, absent });
}

// The README's status columns are the third doc surface carrying the number; bind them too. Rows
// without a status column (the caller-conflict table states 409 once, in its heading) don't match
// the pattern and are deliberately skipped.
const readmePath = join(PAGES, 'README.md');
if (existsSync(readmePath)) {
  const readme = readFileSync(readmePath, 'utf8');
  for (const row of readme.matchAll(/\|\s*\[`([a-z0-9_]+)`\]\([^)]*\)\s*\|\s*(\d{3})\s*\|/g)) {
    const want = statuses.get(row[1]);
    if (want !== undefined && Number(row[2]) !== want) {
      statusWrong.push({ code: row[1], where: `docs/errors/README.md table says ${row[2]}, the status map says ${want}` });
    }
  }
}

const orphans = existsSync(PAGES)
  ? readdirSync(PAGES).filter((f) => f.endsWith('.md') && f !== 'README.md' && !codes.has(f.slice(0, -3)))
  : [];

console.log(`error pages: ${codes.size} code(s) on the wire`);
if (!missing.length && !incomplete.length && !orphans.length && !statusWrong.length) {
  console.log(`  \x1b[32m✓\x1b[0m every error code has a page, every page has a code, and every documented status matches the map`);
  process.exit(0);
}

for (const { code, family } of missing) {
  console.log(`  \x1b[31m✗\x1b[0m no page for \x1b[1m${code}\x1b[0m — ${family}`);
  console.log(`      write docs/errors/${code}.md: ${REQUIRED_SECTIONS.join(' · ')}`);
}
for (const { code, absent } of incomplete) {
  console.log(`  \x1b[31m✗\x1b[0m docs/errors/${code}.md is missing ${absent.join(', ')}`);
}
for (const f of orphans) {
  console.log(`  \x1b[31m✗\x1b[0m docs/errors/${f} documents a code no map produces — delete it or restore the code`);
}
for (const { code, where } of statusWrong) {
  console.log(`  \x1b[31m✗\x1b[0m status drift on \x1b[1m${code}\x1b[0m — ${where}`);
}
console.log(`\n${missing.length + incomplete.length + orphans.length + statusWrong.length} problem(s).`);
process.exit(1);
