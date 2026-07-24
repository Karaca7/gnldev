// Live doc source: TRIES to fetch /llms.txt + /llms-full.txt via GNL_DOCS_URL (default
// https://gnl.dev); if unreachable (no network, timeout, 404, ...) returns null and the caller
// falls back to the embedded static copy in content.ts. Zero new dependencies: uses Node's
// built-in global fetch + AbortController (no SDK/client library).

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
 * deterministic, fast "always embedded content" mode for tests and network-less environments.
 */
export function isOffline(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = (env.GNL_DOCS_OFFLINE ?? '').toLowerCase();
  if (flag === '1' || flag === 'true') return true;
  if (env.GNL_DOCS_URL === '') return true;
  return false;
}

async function fetchText(url: string): Promise<string | null> {
  if (typeof fetch !== 'function') return null; // Node < 18 (no globalThis.fetch) — unexpected but a safe fallback
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) return null;
    return await res.text();
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
