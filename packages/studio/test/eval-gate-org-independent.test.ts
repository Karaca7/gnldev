// The eval gate's `datasets.run` — the call site a reader would assume is covered.
//
// `POST /datasets/:id/run` is controlled by recorded call in the cross-org conformance suite, and that
// is exactly what makes this one dangerous: `datasets.run` is ALSO invoked from inside the managed-agent
// promote handler, to run the eval suite before a version goes to production. A route-driven test cannot
// reach it — no request targets `/datasets/:id/run` — so the covered call site vouches for an uncovered
// one that looks like the same thing.
//
// The gate runs while promoting an organization's agent, so it must be told which organization it is
// evaluating for. A host whose dataset store is per-tenant would otherwise score acme's promote against
// globex's suite, and the promote decision is the one that puts a version into production.
import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createStudioApi } from '../src/server.js';

const authProvider = {
  authenticate: (req: Request) => {
    const t = req.headers.get('authorization')?.replace('Bearer ', '');
    if (t === 'acme') return { roles: ['admin'], id: 'u-acme', orgId: 'acme' };
    if (t === 'globex') return { roles: ['admin'], id: 'u-globex', orgId: 'globex' };
    return null;
  },
  authorize: () => ({ allow: true }),
  capabilities: () => ({ sso: false, rbac: false, audit: false, multiOrganization: false, users: false }),
};
const AS = { acme: { authorization: 'Bearer acme' }, globex: { authorization: 'Bearer globex' } };

/** Every `datasets.run` call, with the organization studio told it about. */
let gateCalls: Array<{ datasetId: string; orgId?: string }> = [];
beforeEach(() => { gateCalls = []; });

/**
 * A deployment with the gate on. `scores` decides whether the suite passes, so the same fixture can
 * exercise both the allow and the reject path.
 */
async function mkApi(scores: Record<string, number> = { quality: 0.9 }) {
  const journal = new InMemoryJournal();
  // A managed agent with one draft version, under BOTH organizations, at the same name — so a promote
  // by either caller is a real promote of its own record rather than a 404.
  for (const org of ['acme', 'globex']) {
    await journal.put(`org:${org}:__studio_agent__:bot`, {
      name: 'bot', active: null,
      versions: [{ version: 1, model: 'openai/gpt-4o-mini', system: `${org} prompt`, at: 1 }],
    });
  }
  const api = createStudioApi({
    reader: journal,
    auth: authProvider,
    org: {},
    evalGate: { datasetId: 'suite-1', minAvg: 0.5 },
    datasets: {
      list: () => [{ id: 'suite-1', size: 1 }],
      run: async (datasetId: string, _opts?: unknown, ctx?: { orgId?: string }) => {
        gateCalls.push({ datasetId, orgId: ctx?.orgId });
        return { ok: true, results: [], aggregate: scores };
      },
    },
    gnl: { listAgents: () => [], run: async () => ({ text: 'x' }), listWorkflows: () => [] },
  } as never) as unknown as (r: Request) => Promise<Response>;
  return { api, journal };
}

const promote = (api: (r: Request) => Promise<Response>, who: Record<string, string>) =>
  api(new Request('http://x/managed-agents/bot/promote', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...who },
    body: JSON.stringify({ version: 1 }),
  }));

describe('the eval gate runs for the organization doing the promoting', () => {
  it('the gate is actually reached, or nothing below means anything', async () => {
    const { api } = await mkApi();
    const res = await promote(api, AS.acme);

    expect(res.status, await res.text()).toBe(200);
    expect(gateCalls.length, 'the eval suite never ran — the promote skipped the gate entirely')
      .toBeGreaterThan(0);
    expect(gateCalls[0]!.datasetId, 'the gate ran a different suite than the one configured').toBe('suite-1');
  });

  it.each([['acme'], ['globex']] as const)('%s promoting is evaluated as %s', async (org) => {
    const { api } = await mkApi();
    await promote(api, AS[org]);

    expect(gateCalls.map((c) => c.orgId),
      'the eval gate was not told which organization it is evaluating for. A per-tenant dataset store '
      + "would score this promote against another organization's suite — and this is the decision that "
      + 'puts a version into production.')
      .toEqual([org]);
  });

  it('and the two organizations are never confused for one another', async () => {
    const { api } = await mkApi();
    await promote(api, AS.acme);
    await promote(api, AS.globex);

    expect(gateCalls.map((c) => c.orgId), 'the gate saw the same organization for both promotes')
      .toEqual(['acme', 'globex']);
  });
});

describe('the gate is live, not decorative', () => {
  // Without this, "the gate was called with the right org" could be true of a gate whose verdict is
  // ignored — the call would be an expensive no-op and the control would still pass.
  it('a failing suite rejects the promote with 412 and leaves the version unpromoted', async () => {
    const { api, journal } = await mkApi({ quality: 0.1 });
    const res = await promote(api, AS.acme);

    expect(res.status, 'a failing eval suite did not block the promote').toBe(412);
    expect(await res.text()).toMatch(/eval gate FAILED/);

    const rec = await journal.get('org:acme:__studio_agent__:bot') as { active?: number | null };
    expect(rec?.active, 'the version was promoted anyway, so the gate decides nothing').toBeNull();
  });

  it('a passing suite promotes it', async () => {
    const { api, journal } = await mkApi({ quality: 0.9 });
    await promote(api, AS.acme);

    const rec = await journal.get('org:acme:__studio_agent__:bot') as { active?: number | null };
    expect(rec?.active, 'a passing gate did not let the promote through').toBe(1);
  });

  // The promote must act on the caller's OWN record — the org scoping of the agent store itself.
  it('and promoting in one organization leaves the other untouched', async () => {
    const { api, journal } = await mkApi();
    await promote(api, AS.acme);

    const globex = await journal.get('org:globex:__studio_agent__:bot') as { active?: number | null };
    expect(globex?.active, "acme's promote activated a version in another organization").toBeNull();
  });
});
