// A CODE ON THE WIRE THAT NO MAP HOLDS IS A CODE NO CHECK CAN SEE.
//
// `scripts/check-error-pages.mjs` guarantees that every code it KNOWS ABOUT has a page. Until this
// test existed, what it knew about was three maps plus a list typed into the script by hand, and the
// list's own comment admitted the hole: "a fourth literal added at an edge tomorrow is caught by
// nothing". Measured when the list was finally replaced — the edge was printing nine codes, not
// three, and a fourth family (`upstream_*`) existed only as a TYPE UNION, which disappears at
// compile time and so was invisible to a script that reads built modules. Ten codes were on the wire
// with no page. Nobody had done anything wrong; the check simply could not enumerate them.
//
// So the maps are now the contract, and this is what keeps the contract from being quietly opted out
// of: it reads the SOURCE of every package that writes an HTTP response, finds every `code: '…'`
// literal, and requires each one to be a value in one of the exported maps. Adding a refusal with a
// fresh string fails here — in the same commit, while the author still knows what the code means and
// can write its page.
//
// Deliberately a grep over source rather than a runtime assertion: the failure mode is a line that
// nobody executes in a test. A route that prints a code only when a provider melts down is exactly
// the one that ships undocumented, and it is visible in the text of the file whether or not any test
// ever drives it.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CALLER_CONFLICT_CODES, BLOCKED_ERROR_CODES, UPSTREAM_ERROR_CODES } from '@gnldev/durable';
import { EDGE_ERROR_CODES } from '../src/edge-errors.js';
import { STUDIO_ERROR_CODES } from '../../studio/src/error-codes.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Every package that writes a `code:` into a wire response — the agent surface AND, since the
 * owner took the decision this comment used to park, the operator console. The old exclusion said
 * "four codes; this line and four pages are the whole of it" — enrolling proved it was already
 * wrong by one: `dead_scan_timeout` was on the wire too, the exact drift the exclusion could not
 * see. The map import is a relative SOURCE path on purpose: this test greps sources, so it should
 * fail against the same tree it reads, not against a stale dist.
 *
 * Studio's `server.ts` contains a literal NUL byte, which makes shell grep skip it as binary —
 * this walk uses readFileSync, which does not care. That blindness is HOW five codes stayed
 * invisible to a whole audit sweep; a grep-based reimplementation of this test would regress it.
 *
 * `node.ts`'s copy of the `body_consumed_upstream` guard stays a literal by design: the code is in
 * EDGE_ERROR_CODES and has a page, so the copy costs nothing but the duplication.
 */
const SCANNED = ['server', 'agui', 'chat-adapter', 'durable', 'studio'];

/** `code: 'x'`, `code: "x"` — the shape a response body is written in. */
const CODE_LITERAL = /\bcode:\s*['"]([a-z0-9_]+)['"]/g;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (entry.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('every code written into a response is a value in an exported map', () => {
  it('finds no literal that the docs check could not enumerate', () => {
    const known = new Set<string>([
      ...Object.values(CALLER_CONFLICT_CODES),
      ...Object.values(BLOCKED_ERROR_CODES),
      ...Object.values(UPSTREAM_ERROR_CODES),
      ...Object.values(EDGE_ERROR_CODES),
      ...Object.values(STUDIO_ERROR_CODES),
    ]);
    const strays: string[] = [];
    for (const pkg of SCANNED) {
      for (const file of tsFiles(join(ROOT, 'packages', pkg, 'src'))) {
        const text = readFileSync(file, 'utf8');
        for (const m of text.matchAll(CODE_LITERAL)) {
          if (!known.has(m[1])) strays.push(`${relative(ROOT, file)} → '${m[1]}'`);
        }
      }
    }
    // The message is the instruction: whoever trips this is holding the context needed to fix it.
    expect(strays, 'a response writes a code that belongs to no exported map, so `pnpm check:errors` '
      + 'cannot see it and it will ship without a page under docs/errors/. Add it to EDGE_ERROR_CODES '
      + '(@gnldev/server, for route-level codes) or to the right map in @gnldev/durable, and write the page.')
      .toEqual([]);
  });
});

// A LITERAL IS NOT FORBIDDEN, and that is deliberate. What this requires is narrower and is the part
// that matters: whatever spelling appears, the code must EXIST in a map — so the docs check can see
// it, and so a typo'd variant is a failure rather than a new undocumented code.
