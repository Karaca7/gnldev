// End-user token refresh, owned by the application. GNL keeps no session: the browser client asks the
// app's own endpoint (`subjectTokenEndpoint`) for a short-lived token, and the app's session decides
// whether one is minted. These are the scenarios a panel measured, as assertions.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { roleAuth, signSubjectToken, subjectTokenEndpoint, sessionTokenId } from '@gnldev/auth';
import { createRestApi } from '../src/index.js';
import { GnlClient, GnlHttpError, tokenFrom } from '../../client/src/index.js';

const SECRET = 'app-signing-secret-at-least-32-bytes!!';
const realNow = Date.now.bind(Date);
let shift = 0;
vi.spyOn(Date, 'now').mockImplementation(() => realNow() + shift);
afterEach(() => { shift = 0; });

const model = {
  specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
  doGenerate: async () => ({ content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] }),
};

function world(opts: { refreshSkewSec?: number } = {}) {
  const sessions = new Map<string, { sub: string; sid: string }>([['cookie-ayse', { sub: 'u-ayse', sid: 'sess-1' }]]);
  const revoked = new Set<string>();
  const gnl = createRestApi(
    { storage: new InMemoryStorage(), memory: false, agents: { a: { model } } } as never,
    { auth: roleAuth({ endUsers: { secret: SECRET, orgId: 'acme', isRevoked: (c) => revoked.has(c.jti ?? '') } }), org: {}, protectionsBanner: false } as never,
  ) as unknown as (r: Request) => Promise<Response>;
  const endpoint = subjectTokenEndpoint((req) => sessions.get(/sid=([^;]+)/.exec(req.headers.get('cookie') ?? '')?.[1] ?? '') ?? null, SECRET, { ttlSec: 300 });
  const n = { mint: 0, gnl401: 0 };
  const browserFetch = async (input: any, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('http://app/')) {
      n.mint++;
      const h = new Headers(init?.headers); h.set('cookie', 'sid=cookie-ayse'); h.set('sec-fetch-site', 'same-origin');
      return endpoint(new Request(url, { ...init, headers: h }));
    }
    const res = await gnl(new Request(url, init));
    if (res.status === 401) n.gnl401++;
    return res;
  };
  const client = new GnlClient({
    baseUrl: 'http://gnl', fetch: browserFetch as typeof fetch,
    getToken: tokenFrom('http://app/gnl-token', { fetch: browserFetch as typeof fetch }),
    ...(opts.refreshSkewSec !== undefined ? { refreshSkewSec: opts.refreshSkewSec } : {}),
  });
  return { client, sessions, revoked, n, gnl, endpoint };
}
const listed = async (c: GnlClient) => Array.isArray(await c.listRuns());

describe('end-user token refresh', () => {
  it('a token that expires mid-session is replaced before it is used, invisibly', async () => {
    const w = world();
    expect(await listed(w.client)).toBe(true);
    shift = 400_000; // past the 300 s token
    expect(await listed(w.client)).toBe(true);
    expect(w.n).toEqual({ mint: 2, gnl401: 0 });
  });

  it('a browser whose clock runs behind gets one 401, refreshes, and retries once', async () => {
    const w = world({ refreshSkewSec: -60 });
    await listed(w.client);
    shift = 330_000; // expired at GNL; the client still believes 30 s are left
    expect(await listed(w.client)).toBe(true);
    expect(w.n).toEqual({ mint: 2, gnl401: 1 });
  });

  it('twenty requests after expiry share ONE refresh', async () => {
    const w = world();
    await listed(w.client);
    shift = 400_000;
    const all = await Promise.all(Array.from({ length: 20 }, () => listed(w.client)));
    expect(all.every(Boolean)).toBe(true);
    expect(w.n.mint).toBe(2);
  });

  it('twenty requests that ALL hit a 401 first still share one refresh', async () => {
    // The path where single-flight matters: every request learns of the expiry from the server at
    // once, and each would otherwise mint its own token.
    const w = world({ refreshSkewSec: -60 });
    await listed(w.client);
    shift = 330_000;
    const all = await Promise.all(Array.from({ length: 20 }, () => listed(w.client)));
    expect(all.every(Boolean)).toBe(true);
    expect(w.n.gnl401).toBe(20);
    expect(w.n.mint).toBe(2);
  });

  it('logout with revocation is immediate, although the token has not expired', async () => {
    const w = world();
    await listed(w.client);
    w.sessions.clear(); w.revoked.add(sessionTokenId('sess-1')); // the token's jti is derived from the session, never the session id itself
    await expect(w.client.listRuns()).rejects.toMatchObject({ status: 401 });
  });

  it('logout without revocation lasts until the token expires, then 401', async () => {
    const w = world();
    await listed(w.client);
    w.sessions.clear();
    expect(await listed(w.client)).toBe(true); // the held token is still valid — the documented bound
    shift = 400_000;
    await expect(w.client.listRuns()).rejects.toBeInstanceOf(GnlHttpError);
  });

  it('a token minted at the ceiling by a signer whose clock runs ahead is not refused', async () => {
    const w = world();
    const t = signSubjectToken({ sub: 'u' }, SECRET, { ttlSec: 3600, now: realNow() + 30_000 });
    expect((await w.gnl(new Request('http://gnl/runs', { headers: { authorization: `Bearer ${t}` } }))).status).toBe(200);
  });
});

describe('subjectTokenEndpoint — the application\'s half', () => {
  const call = (w: ReturnType<typeof world>, init: { method: string; site?: string; origin?: string }) => {
    const h = new Headers({ cookie: 'sid=cookie-ayse' });
    if (init.site) h.set('sec-fetch-site', init.site);
    if (init.origin) h.set('origin', init.origin);
    return w.endpoint(new Request('http://app/gnl-token', { method: init.method, headers: h }));
  };

  it('same-origin POST mints an uncacheable token and sets no CORS', async () => {
    const res = await call(world(), { method: 'POST', site: 'same-origin' });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(typeof ((await res.json()) as { token: unknown }).token).toBe('string');
  });

  it('refuses a cross-site request and anything but POST', async () => {
    const w = world();
    expect((await call(w, { method: 'POST', site: 'cross-site' })).status).toBe(403);
    expect((await call(w, { method: 'POST', origin: 'http://evil.example' })).status).toBe(403);
    expect((await call(w, { method: 'GET', site: 'same-origin' })).status).toBe(405);
  });

  it('no session is 401, and a short secret or an over-long ttl is a startup error', async () => {
    const w = world(); w.sessions.clear();
    expect((await call(w, { method: 'POST', site: 'same-origin' })).status).toBe(401);
    expect(() => subjectTokenEndpoint(() => null, 'short')).toThrow(/32 bytes/);
    expect(() => subjectTokenEndpoint(() => null, SECRET, { ttlSec: 7200 })).toThrow(/ttlSec/);
  });
});
