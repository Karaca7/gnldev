// An end user can hold a credential of its own, in the free tier, and it names only that user.
//
// Before this, the only credential an application could hand toward a browser was `client` — and
// @gnldev/auth's README says not to, because `client` is trusted to say whom it acts for: whoever holds
// it can claim any `resourceId`. So a front end that talked to GNL did it through a proxy that
// forwarded a subject, and GNL could not tell a real one from an invented one. `roleAuth({ endUsers })`
// verifies a short-lived token the APPLICATION signed for its logged-in user; the holder is that user,
// a `subject`, and the binding from `abd3caea` does the rest. The organization comes from config, never
// from the token: an application bound to acme cannot sign its way into globex.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { roleAuth, signSubjectToken } from '@gnldev/auth';
import { createRestApi } from '../src/index.js';

const model = {
  specificationVersion: 'v4' as const, provider: 'm', modelId: 'm', supportedUrls: {},
  doGenerate: async () => ({
    content: [{ type: 'text' as const, text: 'ok' }],
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
    warnings: [],
  }),
};
const SECRET = 'app-signing-secret-at-least-32-bytes!!';

function makeApi() {
  const api = createRestApi(
    { storage: new InMemoryStorage(), memory: false, agents: { a: { model } } } as never,
    {
      auth: roleAuth({
        client: { token: 'C', orgId: 'acme' },
        endUsers: { secret: SECRET, orgId: 'acme' },
      }),
      org: {},
      protectionsBanner: false,
    } as never,
  );
  const call = (token: string, path: string, body?: unknown) => api(new Request(`http://x${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { call };
}
const tokenFor = (sub: string, extra: Record<string, unknown> = {}, secret = SECRET, ttlSec = 300) =>
  signSubjectToken({ sub, ...extra }, secret, { ttlSec });
const runIds = async (res: Response) => {
  const body = await res.json() as { runId: string }[] | { items: { runId: string }[] };
  return (Array.isArray(body) ? body : body.items).map((r) => r.runId);
};

describe('roleAuth({ endUsers }) — a token the application signed for one user', () => {
  it('its holder runs and reads its own work', async () => {
    const { call } = makeApi();
    const ayse = tokenFor('u-ayse');
    expect((await call(ayse, '/agents/a/run', { runId: 'r-ayse', prompt: 'hi' })).status).toBe(200);
    expect(await runIds(await call(ayse, '/runs'))).toEqual(['r-ayse']);
  });

  it('cannot reach another user, even by naming them', async () => {
    const { call } = makeApi();
    await call(tokenFor('u-ayse'), '/agents/a/run', { runId: 'r-ayse', prompt: 'hi' });
    const mallory = tokenFor('u-mallory');
    expect((await call(mallory, '/runs/r-ayse')).status).toBe(404);
    expect((await call(mallory, '/runs/r-ayse?resourceId=u-ayse')).status).toBe(404);
    expect(await runIds(await call(mallory, '/runs'))).toEqual([]);
  });

  it('a token NOT signed by the application is nobody', async () => {
    const { call } = makeApi();
    expect((await call(tokenFor('u-ayse', {}, 'someone-elses-secret-also-32-bytes!!'), '/runs')).status).toBe(401);
  });

  it('an expired token is nobody', async () => {
    const { call } = makeApi();
    expect((await call(tokenFor('u-ayse', {}, SECRET, -10), '/runs')).status).toBe(401);
  });

  it('a claim cannot promote its holder: `kind`, `roles` and `orgId` in the token are not read', async () => {
    const { call } = makeApi();
    await call(tokenFor('u-ayse'), '/agents/a/run', { runId: 'r-ayse', prompt: 'hi' });
    const forged = tokenFor('u-mallory', { kind: 'operator', roles: ['admin', 'platform-admin'], orgId: 'globex' });
    expect((await call(forged, '/runs/r-ayse')).status).toBe(404);
    expect((await call(forged, '/usage')).status).toBe(403);
    // Still acme's user: the run it starts lands in acme, where acme's own user can be refused it.
    expect((await call(forged, '/agents/a/run', { runId: 'r-m', prompt: 'hi' })).status).toBe(200);
    expect(await runIds(await call('C', '/runs?resourceId=u-mallory'))).toEqual(['r-m']);
  });

  it('a token with no subject is refused, not treated as staff', async () => {
    const { call } = makeApi();
    expect((await call(signSubjectToken({ sub: '' }, SECRET, { ttlSec: 300 }), '/runs')).status).toBe(401);
  });

  it('an end user may not do what only staff does', async () => {
    const { call } = makeApi();
    // A write outside the end-user whitelist (the same one `client` has): budgets, registry approval.
    expect((await call(tokenFor('u-ayse'), '/agents/registry/a/approve', {})).status).toBe(403);
  });
});

describe('an end user with no organization, beside staff bound to one', () => {
  // S9, measured on 13f0fde2: `endUsers` configured without `orgId` while admin/client are bound to
  // acme. The org-less user lands in the ROOT scope, which physically holds every organization's
  // `org:<id>:` rows — and read acme's `u-ayse` run by listing it, or by its prefixed id.
  it('reaches no organization\'s rows, by listing or by prefixed id', async () => {
    const api = createRestApi(
      { storage: new InMemoryStorage(), memory: false, agents: { a: { model } } } as never,
      { auth: roleAuth({ client: { token: 'C', orgId: 'acme' }, endUsers: { secret: SECRET } }), protectionsBanner: false } as never,
    );
    const call = (token: string, path: string, body?: unknown) => api(new Request(`http://x${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    expect((await call('C', '/agents/a/run', { runId: 'r-acme', prompt: 'ACME-SECRET', resourceId: 'u-ayse' })).status).toBe(200);
    const orgless = tokenFor('u-ayse'); // same user id, no organization
    const listed = await (await call(orgless, '/runs')).text();
    expect(listed).not.toContain('r-acme');
    const direct = await call(orgless, `/runs/${encodeURIComponent('org:acme:r-acme')}`);
    expect(direct.status).toBe(404);
    expect(await direct.text()).not.toContain('ACME-SECRET');
  });
});
