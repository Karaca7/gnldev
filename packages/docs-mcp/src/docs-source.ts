// Live doc source: TRIES to fetch /llms.txt + /llms-full.txt via GNL_DOCS_URL (default
// Https://gnl.dev); if unreachable (no network, timeout, 404, ...) returns null and the caller
// Falls back to the embedded static copy in content.ts. Zero new dependencies: uses Node's
// Built-in global fetch + AbortController (no SDK/client library).

export const DEFAULT_DOCS_URL = 'https://gnl.dev';
const FETCH_TIMEOUT_MS = 2500;

export interface RemoteDocs {
  llmsTxt: string;
  llmsFullTxt: string;
}

/** Reads the GNL_DOCS_URL env var (falls back to DEFAULT_DOCS_URL); normalizes the trailing slash. */
export function resolveDocsUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.GNL_DOCS_URL ?? DEFAULT_DOCS_URL;
  return raw.replace(/\/+$/, '');
}

/**
 * When GNL_DOCS_OFFLINE=1/true (or GNL_DOCS_URL='') the fetch is skipped entirely — a
 * Deterministic, fast "always embedded content" mode for tests and network-less environments.
 */
export function isOffline(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = (env.GNL_DOCS_OFFLINE ?? '').toLowerCase();
  if (flag === '1' || flag === 'true') return true;
  if (env.GNL_DOCS_URL === '') return true;
  return false;
}

/**
 * Is this actually llms.txt, or is it something that merely answered with 200?
 *
 * `res.ok` is not evidence that a document is the document. An access wall, a captive portal, a
 * CDN error page or an SPA's catch-all route all answer 200 with HTML, and this fetcher fed
 * whatever came back straight to an AI assistant as the framework's official documentation. That
 * is not a hypothetical: with the docs host behind Cloudflare Access, GET /llms.txt returns
 * `200 text/html`, 34 KB, `<title>Sign in ・ Cloudflare Access</title>` -- so every caller was
 * served a login page as the docs, and the embedded fallback that exists for exactly this case
 * never got a chance to run, because from `res.ok`'s point of view nothing had gone wrong.
 *
 * The llms.txt convention is a markdown document, so the check is: not HTML, and shaped like one.
 * Anything ambiguous falls back to the embedded copy, which is the safe direction -- slightly
 * stale but true beats fresh and fabricated.
 */
export function looksLikeDocs(body: string, contentType: string | null): boolean {
  if (contentType && /\b(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType)) return false;
  const head = body.slice(0, 2000).trimStart();
  if (!head) return false;
  if (/^<(?:!doctype|html|\?xml)/i.test(head)) return false;
  // llms.txt opens with a markdown H1; llms-full.txt sections are '---'-separated markdown.
  return /^#\s/.test(head) || head.includes('\n# ') || head.startsWith('---');
}

async function fetchText(url: string): Promise<string | null> {
  if (typeof fetch !== 'function') return null; // Node < 18 (no globalThis.fetch) — unexpected but a safe fallback
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) return null;
    const body = await res.text();
    return looksLikeDocs(body, res.headers.get('content-type')) ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Fetches /llms.txt + /llms-full.txt in parallel; returns them if both succeed, otherwise null (fallback signal). */
export async function fetchRemoteDocs(baseUrl: string): Promise<RemoteDocs | null> {
  const [llmsTxt, llmsFullTxt] = await Promise.all([
    fetchText(`${baseUrl}/llms.txt`),
    fetchText(`${baseUrl}/llms-full.txt`),
  ]);
  if (!llmsTxt || !llmsFullTxt) return null;
  return { llmsTxt, llmsFullTxt };
}

/** Extracts the '---' section from llms-full.txt that carries the `- URL: .../docs/<slug>` line. */
export function extractRemoteSection(llmsFullTxt: string, slug: string): string | null {
  const sections = llmsFullTxt.split(/\n---\n/);
  const needle = `/docs/${slug}`;
  for (const section of sections) {
    const lines = section.split('\n');
    const hasUrl = lines.some((l) => l.trim().startsWith('- URL:') && l.includes(needle));
    if (hasUrl) return section.trim();
  }
  return null;
}
