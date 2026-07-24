// @vitest-environment jsdom
// F6.6: SSE URL auth suffix — a short-lived, single-use ticket is preferred over the persistent token.
// Bug-investigation fix #2: the token fallback is ONLY for 404 (old server) — on TEMPORARY errors like
// 5xx/429/401/403/network exceptions, the persistent token does not leak into the URL (returns empty, left to polling).
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { sseAuthQuery, sseTicketNeedsTokenFallback } from '../src/api';

const KEY = 'gnl-token';

beforeEach(() => { localStorage.clear(); });
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

describe('sseTicketNeedsTokenFallback (bug investigation #2, pure logic)', () => {
  it('404 (old server, no endpoint) → token fallback is needed', () => {
    expect(sseTicketNeedsTokenFallback(404)).toBe(true);
  });
  it('5xx/429/401/403 → considered TEMPORARY, NO token fallback', () => {
    expect(sseTicketNeedsTokenFallback(500)).toBe(false);
    expect(sseTicketNeedsTokenFallback(503)).toBe(false);
    expect(sseTicketNeedsTokenFallback(429)).toBe(false);
    expect(sseTicketNeedsTokenFallback(401)).toBe(false);
    expect(sseTicketNeedsTokenFallback(403)).toBe(false);
  });
  it('network exception → NO token fallback', () => {
    expect(sseTicketNeedsTokenFallback('network-error')).toBe(false);
  });
});

describe('sseAuthQuery (F6.6 token hardening)', () => {
  it('returns empty when there is no token (auth off) and does not call fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await sseAuthQuery()).toBe('');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses ?ticket= when a ticket is obtained (the persistent token does not leak into the URL)', async () => {
    localStorage.setItem(KEY, 'secret-token');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ticket: 'T-123' }) })));
    const q = await sseAuthQuery();
    expect(q).toBe('?ticket=T-123');
    expect(q).not.toContain('secret-token');
  });

  it('ticket endpoint 404 (old server) → falls back to ?token= (backward compat)', async () => {
    localStorage.setItem(KEY, 'secret-token');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
    expect(await sseAuthQuery()).toBe('?token=secret-token');
  });

  it('bug investigation #2: if the ticket endpoint returns 5xx, returns empty — the token does NOT leak into the URL', async () => {
    localStorage.setItem(KEY, 'secret-token');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
    const q = await sseAuthQuery();
    expect(q).toBe('');
    expect(q).not.toContain('secret-token');
  });

  it('bug investigation #2: if the ticket endpoint returns 429 (rate-limit), returns empty — the token does NOT leak into the URL', async () => {
    localStorage.setItem(KEY, 'secret-token');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) })));
    expect(await sseAuthQuery()).toBe('');
  });

  it('bug investigation #2: if the ticket fetch throws (network exception), returns empty — the token does NOT leak into the URL', async () => {
    localStorage.setItem(KEY, 'secret-token');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network'); }));
    const q = await sseAuthQuery();
    expect(q).toBe('');
    expect(q).not.toContain('secret-token');
  });
});
