// The notices were generated correctly and then reachable by nobody.
//
// Vite inlines ~220 packages into dist/assets/*, and every licence involved — MIT, ISC, BSD, and the
// Geist fonts' OFL-1.1, which is the most explicit of them — carries the same condition: the notice
// travels with the copy. The generator wrote dist/THIRD-PARTY-NOTICES.txt, and mountSpa served only
// '/' and '/assets/*', so the file 404'd. A notice sitting in a tarball the product never exposes has
// not travelled anywhere; the obligation is about the running artefact, not the repository.
//
// This is the assertion that would have caught it, and it is deliberately made against a served
// response rather than against the file on disk — the file existing is exactly what was already true.
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { mountSpa } from '../src/spa.js';

function app() {
  const a = new Hono();
  const mounted = mountSpa(a);
  return { a, mounted };
}

const get = (a: Hono, path: string) => a.fetch(new Request(`http://studio${path}`));

describe('third-party notices, from the running product', () => {
  it('are served, not merely present on disk', async () => {
    const { a, mounted } = app();
    expect(mounted, 'studio-ui dist must be built for this test to mean anything').toBe(true);

    const res = await get(a, '/THIRD-PARTY-NOTICES.txt');
    expect(res.status, 'this route did not exist — the file 404d').toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');

    const body = await res.text();
    expect(body.length, 'a stub would satisfy the route and not the obligation').toBeGreaterThan(10_000);
  });

  it('name the licences whose condition this satisfies', async () => {
    const body = await (await get(app().a, '/THIRD-PARTY-NOTICES.txt')).text();
    // The fonts are the strictest case: OFL-1.1 requires the copyright notice and licence to be
    // distributed with the font, and the font files are in dist/assets.
    expect(body).toContain('OFL-1.1');
    expect(body).toMatch(/geist/i);
    expect(body).toContain('SIL Open Font License');
  });

  it('include the two build tools that emit code into the bundle', async () => {
    const body = await (await get(app().a, '/THIRD-PARTY-NOTICES.txt')).text();
    // Excluded as "build-only tooling" on the assumption they never enter dist. Measured against a
    // real build, both do: tailwind writes preflight into the CSS, vite writes the modulepreload
    // polyfill into the JS.
    expect(body).toMatch(/^tailwindcss@/m);
    expect(body).toMatch(/^vite@/m);
    // Their dependency trees genuinely do NOT ship — listing them would misstate this file the other
    // way, so the collection deliberately does not recurse into them.
    expect(body).not.toMatch(/^rollup@/m);
    expect(body).not.toMatch(/^esbuild@/m);
  });

  it('are not cached as immutable — the filename carries no content hash', async () => {
    const res = await get(app().a, '/THIRD-PARTY-NOTICES.txt');
    const cc = res.headers.get('cache-control') ?? '';
    // /assets/* is immutable because vite hashes those names. This one does not change name when a
    // dependency changes, so a year-long immutable cache would pin a stale legal notice.
    expect(cc).not.toContain('immutable');
    expect(cc).toContain('max-age');
  });

  it('do not require a login — it is a notice about redistributed code', async () => {
    // mountSpa adds no auth of its own; this pins the intent so a later guard does not quietly put a
    // published legal document behind a credential.
    const res = await get(app().a, '/THIRD-PARTY-NOTICES.txt');
    expect(res.status).toBe(200);
  });
});
