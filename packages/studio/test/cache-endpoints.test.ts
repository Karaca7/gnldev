// Cache view: GET /cache/stats + POST /cache/invalidate. Studio itself has NO dependency on
// @gnl/cache (bridged via the StudioCache interface, same pattern as queue/vectors) — here we
// mock a fake stats()/invalidate() and verify the capability flag, permission (write) + audit +
// 501/no-op behavior.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnl/durable';
import { createStudioApi, type StudioCache, type StudioCacheStats } from '../src/server.js';

/** Simple fake cache: fixed stats + records invalidate calls. */
function fakeCache(stats: StudioCacheStats): StudioCache & { invalidateCalls: (unknown | undefined)[] } {
  const invalidateCalls: (unknown | undefined)[] = [];
  return {
    invalidateCalls,
    stats: () => stats,
    invalidate: async (key?: unknown) => {
      invalidateCalls.push(key);
      return key !== undefined ? 1 : 3;
    },
  };
}

const post = (app: any, path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('GET /cache/stats', () => {
  it('returns the host\'s stats() if cache is given', async () => {
    const cache = fakeCache({ hits: 8, misses: 2, hitRate: 0.8, size: 5 });
    const app = createStudioApi({ reader: new InMemoryJournal(), cache });
    const res = await app.request('/cache/stats');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hits: 8, misses: 2, hitRate: 0.8, size: 5 });
  });

  it('returns zero counters if cache is not given (not 500)', async () => {
    const app = createStudioApi({ reader: new InMemoryJournal() });
    const res = await app.request('/cache/stats');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hits: 0, misses: 0, hitRate: 0, size: 0 });
  });

  it('401 without read permission (read denial — write denial returns 403, see @gnl/auth gate.ts)', async () => {
    const cache = fakeCache({ hits: 1, misses: 1, hitRate: 0.5, size: 1 });
    const app = createStudioApi({ reader: new InMemoryJournal(), cache, auth: { read: () => false } });
    const res = await app.request('/cache/stats');
    expect(res.status).toBe(401);
  });

  it('capabilities.cache is true only if cache is given (cacheManage is true if invalidate is implemented)', async () => {
    const withCache = createStudioApi({ reader: new InMemoryJournal(), cache: fakeCache({ hits: 0, misses: 0, hitRate: 0, size: 0 }) });
    const capsWith = await (await withCache.request('/capabilities')).json();
    expect(capsWith.cache).toBe(true);
    expect(capsWith.cacheManage).toBe(true);

    const noCache = createStudioApi({ reader: new InMemoryJournal() });
    const capsWithout = await (await noCache.request('/capabilities')).json();
    expect(capsWithout.cache).toBe(false);
    expect(capsWithout.cacheManage).toBe(false);

    const statsOnly = createStudioApi({ reader: new InMemoryJournal(), cache: { stats: () => ({ hits: 0, misses: 0, hitRate: 0, size: 0 }) } });
    const capsStatsOnly = await (await statsOnly.request('/capabilities')).json();
    expect(capsStatsOnly.cache).toBe(true);
    expect(capsStatsOnly.cacheManage).toBe(false); // invalidate not implemented → button hidden
  });
});

describe('POST /cache/invalidate', () => {
  it('when called with a key, invalidates only that key, lands in audit', async () => {
    const cache = fakeCache({ hits: 0, misses: 0, hitRate: 0, size: 0 });
    const app = createStudioApi({ reader: new InMemoryJournal(), cache });
    const res = await post(app, '/cache/invalidate', { key: 'embeds:refund' }, { 'x-gnl-actor': 'ops@acme.co' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: 1 });
    expect(cache.invalidateCalls).toEqual(['embeds:refund']);

    const audit = await (await app.request('/audit?action=cache.invalidate')).json();
    expect(audit.items).toHaveLength(1);
    expect(audit.items[0]).toMatchObject({ actor: 'ops@acme.co', target: 'embeds:refund', detail: { deleted: 1 } });
  });

  it('invalidates everything (best-effort) if no key is given, audit target is \'*\'', async () => {
    const cache = fakeCache({ hits: 0, misses: 0, hitRate: 0, size: 0 });
    const app = createStudioApi({ reader: new InMemoryJournal(), cache });
    const res = await post(app, '/cache/invalidate', {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: 3 });
    expect(cache.invalidateCalls).toEqual([undefined]);

    const audit = await (await app.request('/audit?action=cache.invalidate')).json();
    expect(audit.items[0]).toMatchObject({ target: '*', detail: { deleted: 3 } });
  });

  it('403 without write permission (invalidate is never called)', async () => {
    const cache = fakeCache({ hits: 0, misses: 0, hitRate: 0, size: 0 });
    const app = createStudioApi({ reader: new InMemoryJournal(), cache, auth: { write: () => false } });
    const res = await post(app, '/cache/invalidate', {});
    expect(res.status).toBe(403);
    expect(cache.invalidateCalls).toHaveLength(0);
  });

  it('501 if cache.invalidate is not implemented (stats only)', async () => {
    const app = createStudioApi({ reader: new InMemoryJournal(), cache: { stats: () => ({ hits: 0, misses: 0, hitRate: 0, size: 0 }) } });
    const res = await post(app, '/cache/invalidate', {});
    expect(res.status).toBe(501);
  });

  it('501 also if cache is not given at all (feature check comes AFTER the write permission check)', async () => {
    const app = createStudioApi({ reader: new InMemoryJournal() });
    const res = await post(app, '/cache/invalidate', {});
    expect(res.status).toBe(501);
  });
});
