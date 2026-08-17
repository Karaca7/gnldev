// Unit tests: call handleMessage directly (in-process, fast, deterministic).
// GNL_DOCS_OFFLINE=1 fully disables the live fetch — only the embedded static content is tested.
import { describe, expect, it } from 'vitest';
import { createDocsProvider, handleMessage, TOOLS } from '../src/server.js';
import { FEATURES } from '../src/content.js';
import { isNotification, makeError, makeResult, parseLine, serializeResponse } from '../src/protocol.js';

const OFFLINE_ENV = { ...process.env, GNL_DOCS_OFFLINE: '1' };

function provider() {
  return createDocsProvider(OFFLINE_ENV);
}

describe('protocol.ts', () => {
  it('parses a valid JSON line', () => {
    const msg = parseLine('{"jsonrpc":"2.0","id":1,"method":"ping"}');
    expect(msg).toEqual({ jsonrpc: '2.0', id: 1, method: 'ping' });
  });

  it('returns null for invalid JSON', () => {
    expect(parseLine('{ broken')).toBeNull();
    expect(parseLine('   ')).toBeNull();
  });

  it('a message without an id is treated as a notification', () => {
    expect(isNotification({ method: 'notifications/initialized' })).toBe(true);
    expect(isNotification({ id: 1, method: 'ping' })).toBe(false);
    expect(isNotification({ id: null, method: 'ping' })).toBe(false);
  });

  it('makeResult/makeError/serializeResponse round-trip', () => {
    expect(JSON.parse(serializeResponse(makeResult(1, { ok: true })))).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { ok: true },
    });
    expect(JSON.parse(serializeResponse(makeError(1, -32601, 'not found')))).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32601, message: 'not found' },
    });
  });
});

describe('handleMessage — initialize', () => {
  it('returns with protocolVersion 2024-11-05', async () => {
    const res = await handleMessage(provider(), { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(res).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { protocolVersion: '2024-11-05', serverInfo: { name: 'gnl-docs-mcp' } },
    });
  });

  it('notifications/initialized is a notification — no response is produced', async () => {
    const res = await handleMessage(provider(), { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res).toBeNull();
  });
});

describe('handleMessage — tools/list', () => {
  it('returns the 3 tools (overview/feature/search)', async () => {
    const res: any = await handleMessage(provider(), { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(res.result.tools).toHaveLength(3);
    const names = res.result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(['gnl_docs_feature', 'gnl_docs_overview', 'gnl_docs_search'].sort());
    expect(TOOLS).toHaveLength(3);
  });
});

describe('handleMessage — tools/call gnl_docs_overview', () => {
  it('includes EVERY feature, whatever the count (embedded content)', async () => {
    const res: any = await handleMessage(provider(), {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'gnl_docs_overview', arguments: {} },
    });
    expect(res.result.isError).toBeUndefined();
    const text = res.result.content[0].text;
    // The count used to be pinned here as a literal, which made adding a feature look like a test
    // failure and taught whoever hit it to bump the number. What matters is that the overview leaves
    // NOTHING out — an absent feature is a feature no assistant can discover. The count itself is
    // asserted once, against the prose that states it, in content-counts.test.ts.
    expect(FEATURES.length).toBeGreaterThan(0);
    for (const f of FEATURES) expect(text, `overview omits ${f.slug}`).toContain(f.title);
  });
});

describe('handleMessage — tools/call gnl_docs_feature', () => {
  it('returns install/API/example for a known slug', async () => {
    const res: any = await handleMessage(provider(), {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'gnl_docs_feature', arguments: { slug: 'exactly-once-tools' } },
    });
    const text = res.result.content[0].text;
    expect(text).toContain('Exactly-once tools');
    expect(text).toContain('durableTool');
  });

  it('returns isError:true + the list of valid slugs for an unknown slug', async () => {
    const res: any = await handleMessage(provider(), {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'gnl_docs_feature', arguments: { slug: 'nonexistent-feature' } },
    });
    expect(res.result.isError).toBeUndefined(); // buildUnknownSlugText is informational text, not a tool-level error
    expect(res.result.content[0].text).toContain('Unknown slug');
  });

  it('missing slug → tool-level error (isError:true)', async () => {
    const res: any = await handleMessage(provider(), {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'gnl_docs_feature', arguments: {} },
    });
    expect(res.result.isError).toBe(true);
  });
});

describe('handleMessage — tools/call gnl_docs_search', () => {
  it("an 'exactly-once' search finds the relevant feature", async () => {
    const res: any = await handleMessage(provider(), {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'gnl_docs_search', arguments: { query: 'exactly-once' } },
    });
    expect(res.result.content[0].text).toContain('exactly-once-tools');
  });

  it('returns informational text (not an error) when there are no results', async () => {
    const res: any = await handleMessage(provider(), {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'gnl_docs_search', arguments: { query: 'zzz-no-match-at-all-zzz' } },
    });
    expect(res.result.isError).toBeUndefined();
    expect(res.result.content[0].text).toContain('No results');
  });
});

describe('handleMessage — error paths', () => {
  it('unknown method → -32601', async () => {
    const res: any = await handleMessage(provider(), { jsonrpc: '2.0', id: 9, method: 'foo/bar' });
    expect(res.error.code).toBe(-32601);
  });

  it('unknown tool name → isError:true (not a JSON-RPC error, tool-level)', async () => {
    const res: any = await handleMessage(provider(), {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'gnl_docs_nonexistent', arguments: {} },
    });
    expect(res.result.isError).toBe(true);
  });

  it('missing params.name → -32602', async () => {
    const res: any = await handleMessage(provider(), { jsonrpc: '2.0', id: 11, method: 'tools/call', params: {} });
    expect(res.error.code).toBe(-32602);
  });

  it('no response is produced even if a notification errors', async () => {
    const res = await handleMessage(provider(), { jsonrpc: '2.0', method: 'foo/bar' });
    expect(res).toBeNull();
  });
});
