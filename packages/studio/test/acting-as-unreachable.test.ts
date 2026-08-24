// Why `actingAs` lives in @gnldev/server and NOT here.
//
// The field records an UNBOUND identity operating inside an organization. It was added to studio first
// and removed as a decoration, on the reasoning that studio refuses an explicit org header on every
// non-GET — so on a write its ALS can only ever hold the caller's own binding, and the field could
// never fill.
//
// That reasoning is load-bearing: if it is wrong, an operator can act inside a customer's organization
// through studio and the trail cannot say so. It is asserted here rather than trusted, and asserted
// GENERICALLY — over every non-GET route the router reports, not a spot-check — because the claim is
// about the whole write surface.
//
// TWO configurations, because one is not enough. A custom `org.resolve` that always yields an
// organization is the most permissive shape studio supports and the likeliest to let a write through
// with an org attached — but under it EVERY caller is refused, bound or not, so that sweep alone proves
// "a resolved organization blocks writes" rather than anything about being unbound. The default
// header-based resolver supplies the missing half: there a bound identity genuinely writes, and an
// unbound one either asks for an organization (refused) or does not (shared scope, no organization).
//
// Verified by mutation: removing the v1 read-only rule fails this file.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { PLATFORM_ADMIN_ROLE } from '@gnldev/auth';
import { createStudioApi } from '../src/server.js';

const authProvider = {
  authenticate: (req: Request) => {
    const t = req.headers.get('authorization')?.replace('Bearer ', '');
    if (t === 'acme') return { roles: ['admin'], id: 'u-acme', orgId: 'acme' };
    // The unbound platform operator, now SAYING so (scope.ts: explicit grant, never inferred).
    if (t === 'ops') return { roles: ['admin', PLATFORM_ADMIN_ROLE], id: 'u-ops' };
    return null;
  },
  authorize: () => ({ allow: true }),
  capabilities: () => ({ sso: false, rbac: false, audit: false, multiOrganization: false, users: false }),
};

type Handler = ((r: Request) => Promise<Response>) & { routeTable: readonly { method: string; path: string }[] };

/**
 * Two configurations, because the claim needs both halves.
 *
 * `always`: a custom `resolve` that yields an organization for every request — the most permissive
 * shape studio supports, and the one most likely to let a write through with an org attached.
 * `header`: the DEFAULT resolver, where an organization appears only if the caller asks for one. This
 * is the configuration in which a bound identity can actually write, so it carries the control.
 */
function mkApi(mode: 'always' | 'header' = 'always') {
  const journal = new InMemoryJournal();
  return createStudioApi({
    reader: journal,
    auth: authProvider,
    org: mode === 'always' ? { resolve: () => 'acme' } : {},
    resume: async () => ({}),
    gnl: { listAgents: () => [], run: async () => ({ text: 'x' }), listWorkflows: () => [] },
  } as never) as unknown as Handler;
}

const concrete = (p: string) => p.replace(/:([A-Za-z_]\w*)/g, 'x').replace(/\/\*$/, '/probe');

async function send(api: Handler, method: string, path: string, token: string) {
  const init: RequestInit = { method, headers: { authorization: `Bearer ${token}` } };
  if (!['GET', 'HEAD'].includes(method)) {
    init.headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    init.body = JSON.stringify({ runId: 'x', name: 'x', input: {}, message: 'm', afterIndex: 0 });
  }
  const res = await Promise.race([
    api(new Request(`http://x${concrete(path)}`, init)),
    new Promise<Response>((r) => setTimeout(() => r(new Response('<<timeout>>', { status: 599 })), 3000)),
  ]);
  return { status: res.status, body: (await res.text()).slice(0, 120) };
}

describe('an unbound identity cannot write inside an organization through studio', () => {
  it('the resolver really does resolve one, or this suite proves nothing', async () => {
    const api = mkApi();
    // A GET is where the resolved organization is allowed to take effect, so it is the control that
    // the fixture's resolver is live rather than inert.
    const read = await send(api, 'GET', '/runs', 'ops');
    expect(read.status, 'the read surface refused too — the fixture is broken, not the claim').toBe(200);
  });

  it('every non-GET route refuses the resolved organization', async () => {
    const api = mkApi();
    const writes = api.routeTable.filter((r) => !['GET', 'HEAD', 'ALL'].includes(r.method));
    expect(writes.length, 'the router reports no write routes — nothing was checked').toBeGreaterThan(10);

    const gotThrough: string[] = [];
    for (const r of writes) {
      const { status, body } = await send(api, r.method, r.path, 'ops');
      // 403 is the v1 read-only refusal. Anything that is NOT a refusal means the request proceeded
      // with an organization resolved for an identity that has none — the case `actingAs` exists for.
      if (status !== 403) gotThrough.push(`${r.method} ${r.path} -> ${status} ${body}`);
    }

    expect(gotThrough,
      'an unbound identity reached a studio WRITE with an organization resolved. `actingAs` is therefore '
      + 'reachable here after all, the reasoning that removed it was wrong, and the field belongs in '
      + 'this package too — the trail currently cannot say the operator acted inside this organization.')
      .toEqual([]);
  }, 120_000);

  // The refusal must be the documented one, not an incidental 403 from some other gate — otherwise the
  // block above could pass for a reason that changes tomorrow.
  it('and the refusal is the v1 read-only rule, by name', async () => {
    const api = mkApi();
    const { status, body } = await send(api, 'POST', '/runs/:id/cancel', 'ops');

    expect(status).toBe(403);
    expect(body, 'the write was refused by something other than the org rule — the unreachability rests '
      + 'on a different gate than the one the reasoning cited').toMatch(/read-only|org context/i);
  });

  /**
   * THE CONTROL, and the first version of it was wrong. Under the always-resolving fixture EVERY caller
   * is refused — bound or not — because `requested` is set for all of them. So that sweep alone proves
   * "a resolved organization blocks writes", not "an unbound identity cannot write inside one".
   *
   * The default resolver is where a bound identity genuinely writes: it sends no header, so `requested`
   * is undefined, the v1 rule does not fire, and the ALS fills from its own binding.
   */
  it('while a bound identity writes normally under the default resolver', async () => {
    const api = mkApi('header');
    const { status } = await send(api, 'POST', '/runs/:id/cancel', 'acme');

    expect(status, 'a bound identity is refused too, so the refusal above says nothing about being unbound')
      .not.toBe(403);
  });

  /**
   * The other half of the claim. An unbound identity has exactly two outcomes on a write, and neither
   * puts an organization in the ALS:
   *
   *   asks for one (header)  -> 403, the v1 read-only rule
   *   asks for none          -> the write proceeds in the SHARED scope, with no organization at all
   *
   * So there is no configuration in which an unbound identity writes inside an organization, which is
   * precisely what `actingAs` would have recorded.
   */
  it('and an unbound identity writing without asking for an organization gets the shared scope', async () => {
    const api = mkApi('header');

    const asked = await send(api, 'POST', '/runs/:id/cancel', 'ops');
    expect(asked.status, 'sending no org header was refused — the shared-scope path is gone').not.toBe(403);

    // Now the same caller asking for one explicitly: refused, so it cannot reach a write with an org.
    const withHeader = await Promise.race([
      (api as (r: Request) => Promise<Response>)(new Request('http://x/runs/x/cancel', {
        method: 'POST',
        headers: { authorization: 'Bearer ops', 'content-type': 'application/json', 'x-gnl-org': 'acme' },
        body: '{}',
      })),
      new Promise<Response>((r) => setTimeout(() => r(new Response('<<timeout>>', { status: 599 })), 3000)),
    ]);
    expect(withHeader.status,
      'an unbound identity reached a write while naming an organization — `actingAs` is reachable here')
      .toBe(403);
  });
});
