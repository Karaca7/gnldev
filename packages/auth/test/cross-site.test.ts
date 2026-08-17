// A page on another site must not be able to drive an open surface.
//
// The default posture of a new gnl project is auth-off on loopback. That is the right default for a
// local tool, but "open to this machine" and "open to every page this machine's browser visits" are
// not the same thing, and the gate treated them as one: with no provider it returned true for every
// request and never looked at where the request came from.
//
// Measured on the publish candidate, not theorised: a cross-origin request to
// `POST /api/retention/sweep` purged a seeded run — RUNS before [r-1] → purged:["r-1"] → RUNS after
// []. `POST /agents/:name/run` passed the same gate and would spend the project's API key. Reachable
// from a plain `<form enctype="text/plain">` navigation, so no CORS preflight and no fetch()
// permission is needed — the webpack-dev-server / Vite dev-server advisory shape.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeGate, isCrossSiteStateChange, roleAuth } from '../src/index.js';

const req = (method: string, headers: Record<string, string> = {}, url = 'http://localhost:4747/api/retention/sweep') =>
  new Request(url, { method, headers, ...(method === 'GET' || method === 'HEAD' ? {} : { body: '{}' }) });

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

describe('cross-site state changes against an open surface', () => {
  it('the gate refuses a cross-site write when no provider is configured', async () => {
    const gate = makeGate(undefined, { allowOpenAccess: true });
    // What the exploit sends: a browser marks it, and no page can forge the marking.
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(await gate.allow(req(m, { 'sec-fetch-site': 'cross-site' }), 'write'), m).toBe(false);
    }
    // ...including via the Origin fallback, for a client that sends no Fetch Metadata.
    expect(await gate.allow(req('POST', { origin: 'https://evil.example' }), 'write')).toBe(false);
  });

  it('reads stay open — the surface is still an open surface', async () => {
    const gate = makeGate(undefined, { allowOpenAccess: true });
    for (const m of ['GET', 'HEAD']) {
      expect(await gate.allow(req(m, { 'sec-fetch-site': 'cross-site' }), 'read'), m).toBe(true);
    }
  });

  it('the app\'s own writes are unaffected, including the documented dev setup', async () => {
    const gate = makeGate(undefined, { allowOpenAccess: true });
    // The Studio serves its SPA and API from one origin.
    expect(await gate.allow(req('POST', { 'sec-fetch-site': 'same-origin' }), 'write')).toBe(true);
    // A sibling port is same-SITE; the documented dev flow proxies /api, but this must not break
    // someone serving the UI from :5173 against an API on :4747.
    expect(await gate.allow(req('POST', { 'sec-fetch-site': 'same-site' }), 'write')).toBe(true);
    // A user typing the URL / a bookmark: 'none' is not an attack.
    expect(await gate.allow(req('POST', { 'sec-fetch-site': 'none' }), 'write')).toBe(true);
    // curl, a CI script, a server-to-server call: no ambient credentials to ride, so not the threat.
    expect(await gate.allow(req('POST'), 'write')).toBe(true);
    // Same host, different port, via the Origin fallback only.
    expect(await gate.allow(req('POST', { origin: 'http://localhost:5173' }), 'write')).toBe(true);
  });

  it('with a provider configured the check does not apply — the token is the defence', async () => {
    // gnl carries no cookies, so a bearer token is not CSRF-reachable: a cross-site page cannot read
    // it. Blocking here would break legitimate cross-origin API clients for no gain.
    const gate = makeGate(roleAuth({ admin: { token: 'adm' } }), {});
    const r = new Request('http://localhost:4747/api/retention/sweep', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site', authorization: 'Bearer adm' },
      body: '{}',
    });
    expect(await gate.allow(r, 'write')).toBe(true);
  });

  it('it says so once, rather than failing silently', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gate = makeGate(undefined, { allowOpenAccess: true });
    await gate.allow(req('POST', { 'sec-fetch-site': 'cross-site' }), 'write');
    await gate.allow(req('POST', { 'sec-fetch-site': 'cross-site' }), 'write');
    const said = warn.mock.calls.flat().filter((s) => String(s).includes('cross-site write'));
    expect(said.length, 'once, not once per request').toBe(1);
  });

  it('a malformed Origin is not trusted', () => {
    expect(isCrossSiteStateChange(req('POST', { origin: 'not a url' }))).toBe(true);
    // 'null' is what a sandboxed iframe / data: document sends; treat it as no Origin, since the
    // Fetch Metadata header is the signal that actually covers those.
    expect(isCrossSiteStateChange(req('POST', { origin: 'null' }))).toBe(false);
  });
});

describe('the ?token= URL fallback', () => {
  // It exists only because EventSource cannot send headers, and EventSource only ever issues a GET.
  // Accepting it on other methods authenticated an admin retention purge from a URL — which lands in
  // proxy access logs, browser history, and the Referer header.
  // roleAuth returns undefined when no credential resolves — assert here rather than asserting
  // non-null at each call site, so a config change that empties it fails loudly instead of skipping.
  const auth = roleAuth({ admin: { token: 'adm' } });
  it('the fixture provider actually resolved', () => { expect(auth).toBeDefined(); });
  const at = (method: string) =>
    auth!.authenticate(new Request(`http://localhost:4747/api/retention/sweep?token=adm`, {
      method, ...(method === 'GET' ? {} : { body: '{}' }),
    }));

  it('authenticates a GET (the EventSource case it exists for)', async () => {
    expect(await at('GET')).not.toBeNull();
  });

  it('does NOT authenticate a state-changing method', async () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(await at(m), `${m} must not be authenticated from the URL`).toBeNull();
    }
  });

  it('a header-borne token still works on every method', async () => {
    for (const m of ['GET', 'POST', 'DELETE']) {
      const r = new Request('http://localhost:4747/api/retention/sweep', {
        method: m, headers: { authorization: 'Bearer adm' }, ...(m === 'GET' ? {} : { body: '{}' }),
      });
      expect(await auth!.authenticate(r), m).not.toBeNull();
    }
  });
});

// ── allowP is the entry point most endpoints actually use ─────────────────────────────────────────
// The first version of the cross-site block was written inline in `allow()`. `allowP()` — the
// fine-grained variant, called by 18 endpoints in @gnldev/studio and 5 in @gnldev/server — kept an
// unconditional `return true` for the providerless case. So the block covered the coarse path and
// left the specific one wide open: a page on another site could still drive every endpoint that asks
// for a named permission. Both now route through one function.
describe('allowP gets the same treatment as allow', () => {
  it('refuses a cross-site write on the permission-based entry point', async () => {
    const gate = makeGate(undefined, { allowOpenAccess: true });
    for (const perm of ['policy:write', 'runs:purge', 'cache:invalidate', 'agents:run']) {
      expect(
        await gate.allowP(req('POST', { 'sec-fetch-site': 'cross-site' }), perm),
        perm,
      ).toBe(false);
    }
    expect(await gate.allowP(req('DELETE', { origin: 'https://evil.example' }), 'runs:delete')).toBe(false);
  });

  it('still opens for the app itself, and for reads', async () => {
    const gate = makeGate(undefined, { allowOpenAccess: true });
    expect(await gate.allowP(req('POST', { 'sec-fetch-site': 'same-origin' }), 'policy:write')).toBe(true);
    expect(await gate.allowP(req('GET', { 'sec-fetch-site': 'cross-site' }), 'runs:read')).toBe(true);
    expect(await gate.allowP(req('POST'), 'policy:write'), 'a non-browser client is not the threat').toBe(true);
  });

  it('allow and allowP agree on every case — one decision, not two copies', async () => {
    const gate = makeGate(undefined, { allowOpenAccess: true });
    const cases: Array<[string, Record<string, string>]> = [
      ['POST', { 'sec-fetch-site': 'cross-site' }],
      ['POST', { 'sec-fetch-site': 'same-site' }],
      ['POST', { 'sec-fetch-site': 'none' }],
      ['POST', { origin: 'https://evil.example' }],
      ['POST', { origin: 'http://localhost:5173' }],
      ['POST', {}],
      ['GET', { 'sec-fetch-site': 'cross-site' }],
      ['DELETE', { 'sec-fetch-site': 'cross-site' }],
    ];
    for (const [m, h] of cases) {
      const coarse = await gate.allow(req(m, h), m === 'GET' ? 'read' : 'write');
      const fine = await gate.allowP(req(m, h), m === 'GET' ? 'runs:read' : 'runs:write');
      expect(fine, `${m} ${JSON.stringify(h)} — allowP must match allow`).toBe(coarse);
    }
  });
});
