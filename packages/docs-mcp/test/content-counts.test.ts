// The embedded copy is the only documentation a user can reach when the docs host is not, so a wrong
// number here is the number they get.
//
// Two were wrong at once. `Runtime footprint ~8KB` against a measured 29.9 KiB gzip core / 94.2 KiB
// with the AI SDK — understating it by ~3.7x, in the one sentence a reader sees first and the one
// claim that decides whether they try it on an edge runtime. And "Full list of the 25 features"
// against 26 entries, which is the kind of count that drifts every time a feature is added and that
// nothing was watching.
//
// These assertions are deliberately about INTERNAL consistency (the prose against the array, the
// prose against the source of the measurement) rather than about a number typed in twice. A test that
// hardcodes 26 in a second place just moves the drift.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEATURES, OVERVIEW_SUMMARY } from '../src/content.js';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'content.ts'), 'utf8');

describe('embedded docs — the numbers in the prose', () => {
  it('the stated feature count matches the array', () => {
    const stated = src.match(/Full list of the (\d+) features/);
    expect(stated, 'the doc comment naming a feature count must still exist').not.toBeNull();
    expect(Number(stated![1]), `prose says ${stated![1]}, the array has ${FEATURES.length}`).toBe(FEATURES.length);
  });

  it('every feature carries the fields the MCP tools read, so none answers with a hole', () => {
    for (const f of FEATURES) {
      expect(f.slug, JSON.stringify(f).slice(0, 60)).toBeTruthy();
      expect(f.oneLiner, f.slug).toBeTruthy();
      expect(f.package, f.slug).toBeTruthy();
    }
    // Slugs are the tools/call argument, so a duplicate silently shadows a feature.
    const slugs = FEATURES.map((f) => f.slug);
    expect(new Set(slugs).size, `duplicate slug: ${slugs.filter((s, i) => slugs.indexOf(s) !== i)}`).toBe(slugs.length);
  });

  it('the runtime-footprint claim agrees with the benchmark the README quotes', () => {
    // Not a hardcoded pair of numbers: read the figure the root README carries, which is itself
    // produced by `pnpm --filter @gnldev/showcase bundle`. If the measurement moves, both move or
    // this fails — which is the whole point, since ~8KB survived several re-measurements elsewhere.
    const readme = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'README.md'),
      'utf8',
    );
    const core = readme.match(/\*\*([\d.]+) KiB gzip\*\* core/);
    expect(core, 'the README must still state a measured core size').not.toBeNull();

    const claimed = OVERVIEW_SUMMARY.match(/Runtime footprint ~(\d+) KiB gzip/);
    expect(claimed, 'the embedded summary must state a footprint in KiB gzip').not.toBeNull();

    const measured = Number(core![1]);
    const stated = Number(claimed![1]);
    // Rounded prose is fine; being off by a factor is not.
    expect(
      Math.abs(stated - measured) <= 2,
      `embedded docs say ~${stated} KiB, the measured core is ${measured} KiB`,
    ).toBe(true);
  });
});
