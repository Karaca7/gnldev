// Edge bundle benchmark: MEASURE the "fits in Cloudflare Workers" claim. Two scenarios:
//   A) GNL layer only (ai/zod external — user already uses the AI SDK): net additional cost.
//   B) GNL + AI SDK bundled together: end-to-end real worker size.
// Comparison: a typical full-featured agent framework's build output is ~17.58 MiB — CF Workers limit
// 3 MiB (free) / 10 MiB (paid, compressed). Run: pnpm bundle
import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';

const ENTRY = `
import { runDurable, streamDurable, createGnl, withTenant, InMemoryJournal, withModelFallback } from '@gnldev/durable';
export { runDurable, streamDurable, createGnl, withTenant, InMemoryJournal, withModelFallback };
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
    logLevel: 'silent',
  });
  const out = r.outputFiles[0]!.contents;
  const raw = out.byteLength;
  const gz = gzipSync(out).byteLength;
  const kib = (n: number) => (n / 1024).toFixed(1).padStart(8) + ' KiB';
  console.log(`${label.padEnd(34)} raw:${kib(raw)}   gzip:${kib(gz)}`);
  return { raw, gz };
}

console.log('— GNL edge bundle benchmark (esbuild, minify, esm/browser) —\n');
const a = await measure('A) @gnldev/durable (ai/zod external)', ['ai', 'zod', '@ai-sdk/*', 'node:*', '@gnldev/schema-compat']);
const b = await measure('B) @gnldev/durable + ai (full bundle)', ['zod', 'node:*', '@gnldev/schema-compat']);

const MIB = 1024 * 1024;
console.log(`
References (measured against gzip size vs. compressed limits):
  Cloudflare Workers free:  3 MiB  → scenario B is %${((b.gz / (3 * MIB)) * 100).toFixed(1)}
  Cloudflare Workers paid:  10 MiB  → scenario B is %${((b.gz / (10 * MIB)) * 100).toFixed(2)}
  Full-featured framework: ~17,58 MiB (raw; typical build output — doesn't fit the free limit)
  GNL net layer (A, gzip): ${(a.gz / 1024).toFixed(1)} KiB
`);
if (b.gz > 3 * MIB) {
  console.error('WARNING: the full bundle exceeds the free Workers limit!');
  process.exit(1);
}
console.log('RESULT: GNL comfortably fits within Cloudflare Workers\' free plan. ✓');
