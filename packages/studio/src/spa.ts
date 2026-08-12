// @gnldev/studio/spa — serves the prebuilt @gnldev/studio-ui SPA: index.html (config injection) + assets.
// Mount-path agnostic: <base href> resolves assets, window.__GNL_STUDIO__.apiBase resolves API fetches, correctly.
// If the SPA dist can't be found (not built) mountSpa returns false → the caller falls back to ui.ts's fallback.
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import type { Hono } from 'hono';

let cached: string | null | undefined;
function distDir(): string | null {
  if (cached !== undefined) return cached;
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve('@gnldev/studio-ui/package.json');
    const d = join(dirname(pkg), 'dist');
    cached = existsSync(join(d, 'index.html')) ? d : null;
  } catch {
    cached = null;
  }
  return cached;
}

const MIME: Record<string, string> = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon', '.map': 'application/json',
};

function injectedIndex(dist: string, apiBase: string): string {
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  const prefix = apiBase ? apiBase.replace(/\/$/, '') : '';
  const assetBase = prefix ? prefix + '/' : '/'; // <base href> → correctly resolves vite's './assets/x'
  const apiUrl = prefix + '/api'; // absolute fetch path (includes the mount prefix)
  const head =
    `<base href="${assetBase}">` +
    `<script>window.__GNL_STUDIO__=${JSON.stringify({ apiBase: apiUrl })}</script>`;
  return html.replace('<!--GNL_STUDIO_HEAD-->', head);
}

/** Small info page shown when the SPA hasn't been built (no dist). */
export function notBuiltHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>gnl studio</title></head>
<body style="font-family:system-ui;max-width:560px;margin:80px auto;line-height:1.6;color:#333">
<h1>🛠️ gnl studio UI not built</h1>
<p><code>@gnldev/studio-ui</code> dist not found. Build it before running:</p>
<pre style="background:#111;color:#0f0;padding:12px;border-radius:8px">pnpm -r build</pre>
<p>The API still works: <code>/api/*</code> · <a href="swagger">Swagger</a></p>
</body></html>`;
}

/** Adds the SPA to the Hono app: '/' (injected index) + '/assets/*' (static, immutable). Returns false if no dist. */
export function mountSpa(app: Hono, apiBase = ''): boolean {
  const dist = distDir();
  if (!dist) return false;
  app.get('/', (c) => c.html(injectedIndex(dist, apiBase)));
  app.get('/assets/*', (c) => {
    const rel = c.req.path.split('/assets/')[1] ?? '';
    if (!rel || rel.includes('..')) return c.notFound();
    const p = join(dist, 'assets', rel);
    if (!existsSync(p)) return c.notFound();
    return c.body(readFileSync(p), 200, {
      'content-type': MIME[extname(rel)] ?? 'application/octet-stream',
      'cache-control': 'public,max-age=31536000,immutable',
    });
  });
  return true;
}
