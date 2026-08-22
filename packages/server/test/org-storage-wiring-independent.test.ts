// Increment 3: a storage-backed server builds per-organization instances with `withOrgStorage`.
//
// The failure mode this file exists for is not a missing wrapper — it is a wrapper that is built and
// then BYPASSED. A call site that reaches the root `config.storage` or `baseJournal` on a
// per-organization request path leaves no error and no leak in the response; it leaves an UNPREFIXED
// KEY in the store. So the central assertion is not about any one route: after org-scoped traffic,
// every run key must carry an organization prefix, except the handful that are deliberately global.
//
// The other half of the lens is asserted alongside it, because a wrapper that isolates perfectly and
// hides the owner's own data passes every leak test ever written.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, orgStorageScopeOf } from '@gnldev/durable';
import { createRestApi } from '../src/index.js';
import { call } from './call.js';

const usage = { inputTokens: { total: 1, text: 1 }, outputTokens: { total: 1, text: 1, reasoning: undefined }, totalTokens: 2 };
const model: any = {
  specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
  doGenerate: async () => ({ content: [{ type: 'text', text: 'ok' }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }),
  doStream: async () => { throw new Error('no stream'); },
};

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

function mkApi() {
  const storage = new InMemoryStorage();
  const api = createRestApi(
    { storage, agents: { a: { model } } } as never,
    { org: {}, auth: authProvider } as never,
  );
  return { api, storage };
}

const runAs = (api: any, who: Record<string, string>, runId: string, prompt = 'hi') =>
  call(api, '/agents/a/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...who },
    body: JSON.stringify({ runId, prompt }),
  });

/**
 * Keys the deployment writes at the ROOT on purpose, confirmed against the source rather than assumed:
 *   `__audit__`   — the audit contract is explicitly root-only ("ALWAYS the ROOT journal, NEVER an
 *                   org-scoped view"), so one tamper-evident log covers every organization;
 *   `__agent__`   — the agent-approval registry: "may this agent serve at all" is a platform decision,
 *                   never a per-organization one, and every route that touches it is platform-admin;
 *   `__org__`     — organization registration records, which by definition cannot live inside an org;
 *   `__gnl_`      — the readiness probe and other framework-internal markers.
 * Anything else appearing unprefixed after org-scoped traffic is a call site that reached the root.
 */
const ROOT_BY_DESIGN = /^(__audit__|__agent_registry__|__org__|__gnl_|__pricing__|__budget__|__metrics__)/;

describe('a storage-backed server scopes every port per organization', () => {
  it('writes nothing unprefixed while serving organization-scoped requests', async () => {
    const { api, storage } = mkApi();

    const acme = await runAs(api, AS.acme, 'r-acme');
    const globex = await runAs(api, AS.globex, 'r-globex');
    expect(acme.status, await acme.text()).toBe(200);
    expect(globex.status).toBe(200);

    const keys = await storage.runs.listKeys!('');
    const unprefixed = keys.filter((k) => !k.startsWith('org:') && !ROOT_BY_DESIGN.test(k));

    expect(keys.length, 'nothing was written at all — the probe proves nothing').toBeGreaterThan(0);
    expect(unprefixed,
      'an organization-scoped request wrote an unprefixed key: some call site reached the root storage '
      + 'instead of the scoped one. That is the wiring failure — a wrapper built and then bypassed.')
      .toEqual([]);
  });

  it('and each organization\'s keys carry its own prefix', async () => {
    const { api, storage } = mkApi();
    await runAs(api, AS.acme, 'r-acme');
    await runAs(api, AS.globex, 'r-globex');

    const keys = await storage.runs.listKeys!('');
    expect(keys.some((k) => k.startsWith('org:acme:r-acme:')), 'acme\'s run did not land under acme').toBe(true);
    expect(keys.some((k) => k.startsWith('org:globex:r-globex:')), 'globex\'s run did not land under globex').toBe(true);
    expect(keys.filter((k) => k.startsWith('org:acme:r-globex') || k.startsWith('org:globex:r-acme')),
      'a run landed in the wrong organization').toEqual([]);
  });
});

describe('the keys that are deliberately at the root', () => {
  /**
   * Confirmed rather than assumed, and not by timing: `recordAgent` is kicked off at construction but
   * lands after the first await point, so "written at boot" is not observable. The claim that matters
   * is what the key is keyed BY. The agent-approval registry is per-AGENT — "may this agent serve at
   * all" is a platform decision — so serving more organizations must not grow it, and its key must
   * carry the agent's name rather than any organization's.
   */
  it('the agent registry is keyed by agent, and does not grow with organizations', async () => {
    const oneOrg = mkApi();
    await runAs(oneOrg.api, AS.acme, 'r-1');
    const afterOne = (await oneOrg.storage.runs.listKeys!('')).filter((k) => !k.startsWith('org:'));

    const twoOrgs = mkApi();
    await runAs(twoOrgs.api, AS.acme, 'r-1');
    await runAs(twoOrgs.api, AS.globex, 'r-2');
    const afterTwo = (await twoOrgs.storage.runs.listKeys!('')).filter((k) => !k.startsWith('org:'));

    expect(afterOne, 'the registry key is not what lands at the root — this confirmation is about something else')
      .toEqual(['__agent_registry__:a']);
    expect(afterTwo,
      'the root key set grew when a second organization was served — the registry is per-organization '
      + 'after all, or something else reached past the wrapper')
      .toEqual(afterOne);
  });

  it('and a second organization adds only its own prefixed keys', async () => {
    const { api, storage } = mkApi();
    await runAs(api, AS.acme, 'r-acme');
    const beforeRoot = (await storage.runs.listKeys!('')).filter((k) => !k.startsWith('org:'));

    await runAs(api, AS.globex, 'r-globex');
    const afterRoot = (await storage.runs.listKeys!('')).filter((k) => !k.startsWith('org:'));

    expect(afterRoot, 'serving a second organization grew the root key set').toEqual(beforeRoot);
    expect((await storage.runs.listKeys!('')).some((k) => k.startsWith('org:globex:')),
      'the second organization wrote nothing under its own prefix').toBe(true);
  });
});

describe('the owner can get in', () => {
  // The regression that made `GET /runs` show an organization NONE of its own runs. It was a `Page`
  // contract mismatch two layers down, and no leak test could see it.
  it('acme sees its own run in GET /runs', async () => {
    const { api } = mkApi();
    await runAs(api, AS.acme, 'r-acme');

    const res = await call(api, '/runs', { headers: AS.acme });
    expect(res.status).toBe(200);
    const runs = await res.json();
    const ids = (Array.isArray(runs) ? runs : runs.items).map((r: any) => r.runId);

    expect(ids, 'the owner was shown none of its own runs — cemented, with no error anywhere').toContain('r-acme');
  });

  it('and by its own unprefixed id, not the internal one', async () => {
    const { api } = mkApi();
    await runAs(api, AS.acme, 'r-acme');

    const runs = await (await call(api, '/runs', { headers: AS.acme })).json();
    const ids = (Array.isArray(runs) ? runs : runs.items).map((r: any) => r.runId);
    expect(ids, 'the owner was handed prefixed run ids it cannot pass back in').not.toContain('org:acme:r-acme');
  });

  it('and can read that run back by the id it was given', async () => {
    const { api } = mkApi();
    await runAs(api, AS.acme, 'r-acme');

    const res = await call(api, '/runs/r-acme', { headers: AS.acme });
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json()), 'the run detail is empty for its owner').not.toBe('[]');
  });
});

describe('a stranger stays out', () => {
  it('globex does not see acme\'s run in its list', async () => {
    const { api } = mkApi();
    await runAs(api, AS.acme, 'r-acme');
    await runAs(api, AS.globex, 'r-globex');

    const runs = await (await call(api, '/runs', { headers: AS.globex })).json();
    const ids = (Array.isArray(runs) ? runs : runs.items).map((r: any) => r.runId);

    expect(ids, 'another organization\'s run appeared in the list').not.toContain('r-acme');
    expect(ids, 'globex lost its own run — this control would pass on a store that shows nobody anything').toContain('r-globex');
  });

  it('and cannot read it by id', async () => {
    const { api } = mkApi();
    await runAs(api, AS.acme, 'r-acme', 'ACME-SECRET-PROMPT');

    const res = await call(api, '/runs/r-acme', { headers: AS.globex });
    expect(await res.text(), 'another organization read the run body').not.toContain('ACME-SECRET-PROMPT');
  });

  /**
   * `GET /runs/:id` answers a stranger `200 []` rather than `404`.
   *
   * No leak — the body is empty. But it is inconsistent with `agentGate`, which answers the SAME 404
   * for "no such agent" and "not yours" precisely so a non-owning organization cannot learn a thing
   * EXISTS. Here the two cases are distinguishable in principle: a run id that exists in another
   * organization and one that exists nowhere both return `[]` today, so nothing leaks YET — but the
   * contract is weaker than the one next door, and any future difference between those two answers
   * becomes an existence oracle.
   *
   * Pinned as it stands, with the equivalence that makes it safe asserted explicitly: the day the two
   * diverge, this fails.
   */
  it('answers a stranger the same way for a foreign run and a nonexistent one', async () => {
    const { api } = mkApi();
    await runAs(api, AS.acme, 'r-acme');

    const foreign = await call(api, '/runs/r-acme', { headers: AS.globex });
    const missing = await call(api, '/runs/never-existed', { headers: AS.globex });

    expect(foreign.status, 'a foreign run and a missing one now answer differently — that is an existence oracle')
      .toBe(missing.status);
    expect(await foreign.text(), 'the bodies differ, so a stranger can tell the run exists')
      .toBe(await missing.text());
  });
});

describe('usage accounting survives the scoping', () => {
  // Written through the SCOPED storage, read from the ROOT with `withOrg` applied by `getOrgUsage`.
  // Those are two different code paths onto the same keys; if they ever disagree, usage reads zero and
  // a budget silently never triggers.
  it('acme\'s usage counts acme\'s runs and not globex\'s', async () => {
    const { api } = mkApi();
    await runAs(api, AS.acme, 'r-a1');
    await runAs(api, AS.acme, 'r-a2');
    await runAs(api, AS.globex, 'r-g1');

    const acme = await (await call(api, '/usage', { headers: AS.acme })).json();
    const globex = await (await call(api, '/usage', { headers: AS.globex })).json();

    expect(acme.usage?.runs, 'usage read zero for an organization that has runs — the write path and the '
      + 'read path disagree about where counters live, and a budget would never trigger').toBe(2);
    expect(globex.usage?.runs, 'usage crossed organizations').toBe(1);
  });
});

/**
 * The five ports OTHER than `runs`, which is what increment 3 is actually for.
 *
 * `runs` alone cannot tell the two build paths apart: the journal-only path
 * (`withOrg(baseJournal, id)`) and the storage path (`withOrgStorage(storage, id).runs`) produce the
 * SAME prefixed keys, so every assertion above passes under either. Measured — forcing the journal-only
 * path leaves all of them green. And `memory`, `vectors`, `work`, `cache` and `meta` are not reachable
 * through any `createRestApi` route, so no HTTP request can distinguish them either.
 *
 * What DOES distinguish the paths is the seam the wiring changed: what the per-organization registry is
 * HANDED. `createGnl` resolves its memory source as `config.storage ?? config.journal`, so a
 * `memoryFactory` sees a scoped `Storage` on one path and a bare journal on the other. That is asserted
 * directly, because it is the only observable difference and it is precisely the claim.
 */
describe('a per-organization registry is handed a scoped Storage, not a bare journal', () => {
  function apiRecordingMemorySource() {
    const storage = new InMemoryStorage();
    const seen: unknown[] = [];
    const api = createRestApi(
      {
        storage,
        agents: { a: { model } },
        memoryFactory: (src: unknown) => { seen.push(src); return { getMessages: async () => [], append: async () => {} }; },
      } as never,
      { org: {}, auth: authProvider } as never,
    );
    return { api, storage, seen };
  }

  it('the source carries all six ports, and is scoped to the organization', async () => {
    const { api, seen } = apiRecordingMemorySource();
    const atBoot = seen.length;
    await runAs(api, AS.acme, 'r-acme');

    const perOrg = seen.slice(atBoot) as Array<Record<string, unknown>>;
    expect(perOrg.length, 'no per-organization registry was built').toBeGreaterThan(0);

    const src = perOrg[0]!;
    for (const port of ['runs', 'memory', 'vectors', 'work', 'cache', 'meta']) {
      expect(src[port],
        `the organization's registry was handed a source with no \`${port}\` — it is a bare journal, so `
        + 'that port is unscoped and every organization shares one set of keys')
        .toBeTruthy();
    }
    expect(orgStorageScopeOf(src), 'the source is not an organization-scoped storage').toBe('acme');
  });

  it('and each organization gets its own scope, not a shared one', async () => {
    const { api, seen } = apiRecordingMemorySource();
    const atBoot = seen.length;
    await runAs(api, AS.acme, 'r-acme');
    await runAs(api, AS.globex, 'r-globex');

    const scopes = (seen.slice(atBoot) as unknown[]).map((s) => orgStorageScopeOf(s));
    expect(scopes, 'two organizations were handed the same scope, or an unscoped source').toEqual(['acme', 'globex']);
  });
});
