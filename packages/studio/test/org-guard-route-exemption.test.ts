// The org fail-closed guard's exemption must name a ROUTE, not a path suffix.
//
// `GET /me` and `GET /capabilities` are exempt so a refused caller can still learn its own scope and
// the auth mode. That exemption was written as `path.endsWith('/me')`, because this app carries no
// basePath of its own and a host may mount it anywhere — measured, an inner middleware sees `/me`
// standalone and `/studio/me` under `app.route('/studio', …)`.
//
// Tested against the WHOLE path it matched any route whose last segment the caller chooses, and three
// of ours end in a free parameter: `/runs/:id`, `/workflows/run/:runId`, `/runs/:id/regression/:otherId`.
// Measured with the legacy `{read,write}` pair + `org` — the configuration the guard exists for:
//
//   GET /runs                            x-gnl-org: globex -> 403
//   GET /runs/me                         x-gnl-org: globex -> 200   another org's run
//   GET /runs/r-globex/regression/me     x-gnl-org: globex -> 200   "textA":"GLOBEX-SECRET"
//
// and under the paid strict multi-org net, from an authenticated principal with NO org binding:
//
//   GET /runs/org:acme:r-acme/regression/me  -> 200  "textA":"ACME-SECRET"
//
// The second is the worse one: the physical `org:<id>:` key is addressable, so it reads ANY
// organization rather than only root data.
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { InMemoryJournal } from '@gnldev/durable';
import { createStudioApi } from '../src/server.js';
import { call } from './call.js';

/** The legacy `{read,write}` pair: a provider that binds NO identity — what the guard is for. */
const legacyPair = { read: () => true, write: () => true };

const seeded = async () => {
  const j = new InMemoryJournal();
  await j.put('me:model:0', { content: [{ type: 'text', text: 'ROOT-ME' }] });
  await j.put('r-globex:model:0', { content: [{ type: 'text', text: 'GLOBEX-SECRET' }] });
  return j;
};

const asGlobex = (app: unknown, path: string) =>
  call(app as never, path, { headers: { 'x-gnl-org': 'globex' } });

describe('the org fail-closed guard', () => {
  it.each([
    '/runs/me',
    '/runs/r-globex/regression/me',
    '/workflows/run/me',
  ])('is not bypassed by %s, whose last segment the caller chooses', async (path) => {
    const app = createStudioApi({ reader: await seeded(), auth: legacyPair, org: {} } as never);

    const res = await asGlobex(app, path);
    expect(res.status, `${path} walked around the org boundary`).toBe(403);
    expect((await res.json()).error).toMatch(/fail-closed/);
  });

  it('still refuses the route it was already refusing', async () => {
    const app = createStudioApi({ reader: await seeded(), auth: legacyPair, org: {} } as never);
    expect((await asGlobex(app, '/runs')).status).toBe(403);
  });

  it('still exempts /me and /capabilities, so a refused caller can learn its own scope', async () => {
    // The whole point of the exemption. Losing it would leave a refused caller unable to find out why.
    const app = createStudioApi({ reader: await seeded(), auth: legacyPair, org: {} } as never);

    expect((await asGlobex(app, '/capabilities')).status, '/capabilities was caught by the guard').not.toBe(403);
    expect((await asGlobex(app, '/me')).status, '/me was caught by the guard').not.toBe(403);
  });

  it('exempts them under a MOUNT PREFIX too — the reason the suffix test was chosen', async () => {
    // An exact test that ignored the mount would fail closed on the two endpoints it is supposed to
    // let through, which is why this has to be measured rather than reasoned about.
    // Mounted the way the factory's own docs say to: `app.mount('/studio', createStudioApi(...))`.
    // The factory returns a fetch handler, not a Hono app, and `mount` strips the prefix before calling it.
    const api = createStudioApi({ reader: await seeded(), auth: legacyPair, org: {} } as never);
    const outer = new Hono();
    outer.mount('/studio', api as never);
    const hit = (p: string) => outer.request(new Request(`http://x${p}`, { headers: { 'x-gnl-org': 'globex' } }));

    expect((await hit('/studio/capabilities')).status, '/capabilities was caught once mounted').not.toBe(403);
    expect((await hit('/studio/runs/me')).status, 'the bypass came back once the app was mounted').toBe(403);
  });
});
