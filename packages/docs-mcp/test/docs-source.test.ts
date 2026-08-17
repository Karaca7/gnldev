// A 200 is not evidence that a document is the document.
//
// The remote doc fetcher exists so an AI assistant gets CURRENT documentation, with an embedded
// copy as the fallback when the site is unreachable. But "unreachable" was defined as `!res.ok`,
// and the failure that actually happened does not look like that: with the docs host behind
// Cloudflare Access, GET /llms.txt answers 200 text/html with a sign-in page. Every caller was
// handed that page as the framework's official docs, and the fallback never fired.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { looksLikeDocs, fetchRemoteDocs } from '../src/docs-source.js';

// Trimmed from the real response of https://gnl.dev/llms.txt while the site sat behind Access:
// status 200, content-type text/html, 34840 bytes.
const ACCESS_WALL = `<!DOCTYPE html>
<html>
  <head>
    <title>Sign in ・ Cloudflare Access</title>
    <meta charset="utf-8" />
  </head>
  <body><div id="root"></div></body>
</html>`;

const REAL_LLMS_TXT = `# gnl

> Durability for AI SDK agents.

## Docs
- [Quickstart](https://gnl.dev/docs/quickstart)
`;

afterEach(() => vi.unstubAllGlobals());

describe('docs-mcp remote source', () => {
  it('an access wall answering 200 is not documentation', () => {
    expect(looksLikeDocs(ACCESS_WALL, 'text/html; charset=utf-8')).toBe(false);
    // ...and it is still rejected when the wall omits or lies about the content type.
    expect(looksLikeDocs(ACCESS_WALL, null)).toBe(false);
    expect(looksLikeDocs(ACCESS_WALL, 'text/plain')).toBe(false);
  });

  it('real llms.txt is accepted', () => {
    expect(looksLikeDocs(REAL_LLMS_TXT, 'text/plain; charset=utf-8')).toBe(true);
    expect(looksLikeDocs('---\n# Section\n- URL: https://gnl.dev/docs/x\n', null)).toBe(true);
  });

  it('empty and whitespace-only bodies are not documentation either', () => {
    expect(looksLikeDocs('', 'text/plain')).toBe(false);
    expect(looksLikeDocs('   \n\n ', 'text/plain')).toBe(false);
  });

  it('fetchRemoteDocs returns null on an access wall, so the caller falls back to the embedded copy', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(ACCESS_WALL, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })));
    expect(await fetchRemoteDocs('https://gnl.dev')).toBeNull();
  });

  it('fetchRemoteDocs returns the documents when the host actually serves them', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(REAL_LLMS_TXT, {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })));
    const docs = await fetchRemoteDocs('https://gnl.dev');
    expect(docs?.llmsTxt).toContain('# gnl');
  });
});
