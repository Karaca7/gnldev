// Edge bundle benchmark: MEASURE the "fits in Cloudflare Workers" claim. Two scenarios:
//   A) GNL layer only (ai/zod external — user already uses the AI SDK): net additional cost.
//   B) GNL + AI SDK bundled together: end-to-end real worker size.
// Comparison: a typical full-featured agent framework's build output is ~17.58 MiB — CF Workers limit
// 3 MiB (free) / 10 MiB (paid, compressed). Run: pnpm --filter @gnldev/showcase bundle
import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';

// The surface being measured. Named by hand, so it goes stale the moment an export is renamed --
// and it did: this list said `withTenant` for the whole life of the org rename. esbuild never
// complained (durable re-exports through `export *`, so a missing name cannot be proven statically)
// and `logLevel: 'silent'` would have hidden it anyway. The benchmark kept printing a number, the
// README quoted that number as a measurement, and it was a tree-shake of a symbol that no longer
// existed. A benchmark that cannot fail is worse than none, because its output reads as verification.
const SURFACE = ['runDurable', 'streamDurable', 'createGnl', 'withOrg', 'InMemoryJournal', 'withModelFallback'];

// So prove the names resolve before measuring them. This is the check that actually catches a
// rename; the esbuild diagnostics below stay on as a second net for everything else.
const mod = await import('@gnldev/durable');
const missing = SURFACE.filter((n) => (mod as Record<string, unknown>)[n] === undefined);
if (missing.length) {
  throw new Error(
    `bundle benchmark measures a stale surface: @gnldev/durable no longer exports ${missing.join(', ')}. ` +
    `Update SURFACE to the current names -- until then any size printed here is meaningless.`,
  );
}

const ENTRY = `
import { ${SURFACE.join(', ')} } from '@gnldev/durable';
export { ${SURFACE.join(', ')} };
`;

async function measure(label: string, external: string[]): Promise<{ raw: number; gz: number }> {
  const r = await build({
    stdin: { contents: ENTRY, resolveDir: process.cwd(), sourcefile: 'entry.ts', loader: 'ts' },
    bundle: true,
    minify: true,
    format: 'esm',
    platform: 'browser', // Workers = browser-like runtime
    conditions: ['worker', 'browser', 'import'],
    external,
    write: false,
    // NOT 'silent': a build that reports a problem must be able to say so. This does not catch a
    // renamed export (see SURFACE above for why), but it does catch everything esbuild CAN prove.
    logLevel: 'warning',
  });
  if (r.warnings.length || r.errors.length) {
    for (const m of [...r.errors, ...r.warnings]) console.error(`  ${m.text}`);
    throw new Error(`${label}: esbuild reported ${r.errors.length} error(s) and ${r.warnings.length} warning(s) — the measurement below would not be measuring what it claims`);
  }
  const out = r.outputFiles[0]!.contents;
  const raw = out.byteLength;
  const gz = gzipSync(out).byteLength;
  const kib = (n: number) => (n / 1024).toFixed(1).padStart(8) + ' KiB';
  console.log(`${label.padEnd(34)} raw:${kib(raw)}   gzip:${kib(gz)}`);
  return { raw, gz };
}

console.log('— GNL edge bundle benchmark (esbuild, minify, esm/browser) —\n');
const a = await measure('A) @gnldev/durable (ai/zod external)', ['ai', 'zod', '@ai-sdk/*', 'node:*', '@gnldev/tool-schema']);
const b = await measure('B) @gnldev/durable + ai (full bundle)', ['zod', 'node:*', '@gnldev/tool-schema']);

const MIB = 1024 * 1024;
console.log(`
References (measured against gzip size vs. compressed limits):
  Cloudflare Workers free:  3 MiB  → scenario B is ${((b.gz / (3 * MIB)) * 100).toFixed(1)}%
  Cloudflare Workers paid:  10 MiB  → scenario B is ${((b.gz / (10 * MIB)) * 100).toFixed(2)}%
  Full-featured framework: ~17.58 MiB (raw; typical build output — doesn't fit the free limit)
  GNL net layer (A, gzip): ${(a.gz / 1024).toFixed(1)} KiB
`);
if (b.gz > 3 * MIB) {
  console.error('WARNING: the full bundle exceeds the free Workers limit!');
  process.exit(1);
}
console.log('RESULT: GNL comfortably fits within Cloudflare Workers\' free plan. ✓');
